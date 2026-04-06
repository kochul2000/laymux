//! OSC escape sequence parsing for terminal output.
//!
//! Extracts CWD, titles, and shell integration markers from PTY output data.

/// A parsed OSC event extracted from terminal output.
#[derive(Debug, Clone, PartialEq)]
pub struct OscEvent {
    /// OSC code (e.g., 0, 2, 7, 9, 133, 777)
    pub code: u16,
    /// Sub-parameter for OSC 133 (e.g., "C", "D", "E") or OSC 9;9 sub-code
    pub param: Option<String>,
    /// Payload data after code (and optional param)
    pub data: String,
}

/// Iterate over all OSC sequences in a byte slice, yielding `OscEvent`s.
///
/// Parses `ESC ] code ; data BEL` and `ESC ] code ; data ST` formats.
/// For OSC 133, the first character after `;` is extracted as `param`.
/// For OSC 9, a sub-code prefix like `9;` is detected and extracted as `param`.
pub fn iter_osc_events(data: &[u8]) -> OscEventIter<'_> {
    OscEventIter { data, pos: 0 }
}

/// Iterator over OSC sequences in a byte slice.
pub struct OscEventIter<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Iterator for OscEventIter<'a> {
    type Item = OscEvent;

    fn next(&mut self) -> Option<OscEvent> {
        loop {
            // Find next ESC ] (0x1b 0x5d)
            if self.pos + 2 >= self.data.len() {
                return None;
            }
            let remaining = &self.data[self.pos..];
            let esc_pos = remaining
                .windows(2)
                .position(|w| w[0] == 0x1b && w[1] == b']')?;
            let abs_start = self.pos + esc_pos + 2; // after ESC ]

            if abs_start >= self.data.len() {
                return None;
            }

            // Parse numeric code
            let mut code_end = abs_start;
            while code_end < self.data.len() && self.data[code_end].is_ascii_digit() {
                code_end += 1;
            }
            if code_end == abs_start || code_end >= self.data.len() || self.data[code_end] != b';' {
                // Not a valid OSC sequence — skip past this ESC ]
                self.pos = self.pos + esc_pos + 2;
                continue;
            }
            let code_str = &self.data[abs_start..code_end];
            let code: u16 = match std::str::from_utf8(code_str)
                .ok()
                .and_then(|s| s.parse().ok())
            {
                Some(c) => c,
                None => {
                    self.pos = code_end;
                    continue;
                }
            };

            let payload_start = code_end + 1; // after the ';'

            // Find terminator: BEL (0x07) or ST (ESC \)
            let payload_slice = &self.data[payload_start..];
            let term_pos = payload_slice.iter().position(|&b| b == 0x07 || b == 0x1b);

            let (payload_end, next_pos) = match term_pos {
                Some(p) => {
                    let abs_end = payload_start + p;
                    let next = if self.data[abs_end] == 0x1b {
                        // ST = ESC \, skip both bytes
                        abs_end + 2
                    } else {
                        // BEL, skip one byte
                        abs_end + 1
                    };
                    (abs_end, next)
                }
                None => {
                    // No terminator found — incomplete sequence
                    self.pos = self.data.len();
                    return None;
                }
            };

            self.pos = next_pos;

            let raw_payload = String::from_utf8_lossy(&self.data[payload_start..payload_end]);
            if raw_payload.is_empty() && code != 133 {
                // Skip empty payloads (except OSC 133 which can have param-only like "B")
                continue;
            }

            // Extract param for specific OSC codes
            let (param, data) = extract_osc_param(code, &raw_payload);

            return Some(OscEvent { code, param, data });
        }
    }
}

/// Extract sub-parameter from OSC payload based on the code.
fn extract_osc_param(code: u16, raw: &str) -> (Option<String>, String) {
    match code {
        // OSC 133: shell integration — first char(s) before `;` is the param
        // e.g., "D;0" → param="D", data="0"
        // e.g., "C" → param="C", data=""
        // e.g., "E;git switch main" → param="E", data="git switch main"
        133 => {
            if let Some(semi_idx) = raw.find(';') {
                (
                    Some(raw[..semi_idx].to_string()),
                    raw[semi_idx + 1..].to_string(),
                )
            } else {
                (Some(raw.to_string()), String::new())
            }
        }
        // OSC 9: ConEmu/WSL sends "9;<path>" for CWD
        // Regular OSC 9 notifications don't have this prefix
        9 => {
            if let Some(stripped) = raw.strip_prefix("9;") {
                (Some("9".to_string()), stripped.to_string())
            } else {
                (None, raw.to_string())
            }
        }
        _ => (None, raw.to_string()),
    }
}

// ── Claude Code white-● message extraction ──

/// UTF-8 bytes for ● (U+25CF BLACK CIRCLE)
const BULLET: [u8; 3] = [0xe2, 0x97, 0x8f];

/// ANSI SGR prefix for 256-color foreground 231 (bright white).
/// Claude Code uses this color for user-facing status messages.
const SGR_FG_231: &[u8] = b"\x1b[38;5;231m";

/// Extract the last white-● status message from Claude Code terminal output.
///
/// Scans raw PTY bytes for `●` (U+25CF) preceded by the bright-white ANSI color
/// (`\x1b[38;5;231m`). Returns the text content after `●` with ANSI codes stripped.
/// Non-white ● lines (e.g., gray tool-call markers) are skipped.
///
/// Claude Code uses TUI rendering with cursor-addressed output, so the message text
/// may not be adjacent to `●` in the byte stream. We scan forward past cursor
/// control sequences to find the text, stopping at spinner characters or color changes.
pub fn extract_white_bullet_message(data: &[u8]) -> Option<String> {
    let mut last_message: Option<String> = None;
    let mut pos = 0;

    while pos + BULLET.len() <= data.len() {
        // Find next ● in the byte stream
        let bullet_pos = match data[pos..]
            .windows(BULLET.len())
            .position(|w| w == BULLET)
        {
            Some(p) => pos + p,
            None => break,
        };

        // Check if preceded by SGR_FG_231, allowing whitespace/control chars
        // between the SGR and ●. Real output patterns include:
        //   \x1b[38;5;231m●      (direct)
        //   \x1b[38;5;231m\n●    (newline gap)
        //   \x1b[38;5;231m\r●    (carriage return gap)
        let is_white = {
            let mut scan = bullet_pos;
            while scan > 0 && matches!(data[scan - 1], b'\n' | b'\r' | b' ') {
                scan -= 1;
            }
            scan >= SGR_FG_231.len()
                && data[scan - SGR_FG_231.len()..scan] == *SGR_FG_231
        };

        if is_white {
            // Scan forward from ● to collect message text.
            // In TUI mode, text is cursor-addressed; in scrollback, text is inline.
            // We scan up to 500 bytes, strip ANSI, and stop at spinner chars.
            let text_start = bullet_pos + BULLET.len();
            let scan_end = (text_start + 500).min(data.len());
            let raw_text = String::from_utf8_lossy(&data[text_start..scan_end]);
            let stripped = strip_ansi_for_bullet(&raw_text);
            if !stripped.is_empty() {
                last_message = Some(stripped);
            }
        }

        pos = bullet_pos + BULLET.len();
    }

    last_message
}

/// Strip ANSI and extract message text for a ● bullet line.
/// Converts cursor-forward (`\x1b[nC`) to spaces, strips all other ANSI,
/// and stops at spinner characters (✶✻✽✢*) or another ● bullet.
fn strip_ansi_for_bullet(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'[' => {
                    // CSI: ESC [ params final_byte
                    let csi_start = i + 2;
                    let mut j = csi_start;
                    while j < bytes.len()
                        && !(bytes[j].is_ascii_alphabetic() || bytes[j] == b'~')
                    {
                        j += 1;
                    }
                    if j < bytes.len() {
                        let final_byte = bytes[j];
                        if final_byte == b'C' {
                            // Cursor forward → space
                            result.push(' ');
                        }
                        // All other CSI sequences are stripped
                        i = j + 1;
                    } else {
                        i = j;
                    }
                }
                b']' => {
                    // OSC: skip to BEL or ST
                    i += 2;
                    while i < bytes.len() && bytes[i] != 0x07 {
                        if bytes[i] == 0x1b {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1;
                    }
                }
                _ => {
                    i += 2;
                }
            }
        } else {
            // Check for spinner/stop characters
            let remaining = &input[i..];
            // Stop at spinner chars: ✶✻✽✢ or another ●
            for stop_char in ['✶', '✻', '✽', '✢', '●'] {
                if remaining.starts_with(stop_char) {
                    return result.trim().to_string();
                }
            }
            // Regular character
            let ch = remaining.chars().next().unwrap();
            result.push(ch);
            i += ch.len_utf8();
        }
    }

    result.trim().to_string()
}

/// Strip ANSI escape sequences (CSI and OSC) from a string, returning plain text.
pub fn strip_ansi(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                // CSI: ESC [ ... (letter)
                b'[' => {
                    i += 2;
                    while i < bytes.len() && !(bytes[i].is_ascii_alphabetic() || bytes[i] == b'~')
                    {
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1; // skip final letter
                    }
                }
                // OSC: ESC ] ... (BEL or ST)
                b']' => {
                    i += 2;
                    while i < bytes.len() && bytes[i] != 0x07 {
                        if bytes[i] == 0x1b {
                            i += 1; // skip ST's ESC
                            break;
                        }
                        i += 1;
                    }
                    if i < bytes.len() {
                        i += 1; // skip BEL or backslash
                    }
                }
                _ => {
                    i += 2; // skip unknown ESC + next byte
                }
            }
        } else {
            // Regular byte — include in output
            result.push(bytes[i] as char);
            i += 1;
        }
    }

    result
}

/// OSC 7 needle: `ESC ] 7 ;`
pub const OSC7_NEEDLE: &[u8] = &[0x1b, b']', b'7', b';'];

/// OSC 9;9 needle: `ESC ] 9 ; 9 ;`
pub const OSC9_9_NEEDLE: &[u8] = &[0x1b, b']', b'9', b';', b'9', b';'];

/// OSC 0 needle (window title): `ESC ] 0 ;`
pub const OSC0_NEEDLE: &[u8] = &[0x1b, b']', b'0', b';'];

/// OSC 2 needle (window title): `ESC ] 2 ;`
pub const OSC2_NEEDLE: &[u8] = &[0x1b, b']', b'2', b';'];

/// Extract the payload of the last occurrence of an OSC sequence identified by `needle`.
/// Scans for `needle` (e.g., `\x1b]7;`) and returns the text up to the BEL (`\x07`)
/// or ST (`\x1b\\`) terminator. Returns `None` if no complete match is found.
pub fn extract_last_osc_payload(data: &[u8], needle: &[u8]) -> Option<String> {
    let mut last: Option<String> = None;
    let mut start = 0;

    while start + needle.len() <= data.len() {
        if let Some(found) = data[start..]
            .windows(needle.len())
            .position(|w| w == needle)
        {
            let abs_pos = start + found;
            let payload_start = abs_pos + needle.len();
            if payload_start < data.len() {
                let remaining = &data[payload_start..];
                if let Some(end) = remaining.iter().position(|&b| b == 0x07 || b == 0x1b) {
                    let payload = String::from_utf8_lossy(&remaining[..end]);
                    if !payload.is_empty() {
                        last = Some(payload.into_owned());
                    }
                }
            }
            start = abs_pos + 1;
        } else {
            break;
        }
    }
    last
}

/// Extract CWD from the last OSC 7 sequence in PTY output data.
pub fn extract_last_osc7_cwd(data: &[u8]) -> Option<String> {
    extract_last_osc_payload(data, OSC7_NEEDLE)
}

/// Extract CWD from the last OSC 9;9 sequence in PTY output data.
pub fn extract_last_osc9_9_cwd(data: &[u8]) -> Option<String> {
    extract_last_osc_payload(data, OSC9_9_NEEDLE)
}

/// Extract the last terminal title from OSC 0 or OSC 2 sequences in the output.
pub fn extract_last_terminal_title(data: &[u8]) -> Option<String> {
    let mut best_pos = None;
    let mut best_code = 0u8;

    for needle in [OSC0_NEEDLE, OSC2_NEEDLE] {
        let mut start = 0;
        while start + needle.len() <= data.len() {
            if let Some(found) = data[start..]
                .windows(needle.len())
                .position(|w| w == needle)
            {
                let abs_pos = start + found;
                if best_pos.is_none_or(|bp| abs_pos > bp) {
                    best_pos = Some(abs_pos);
                    best_code = needle[2]; // '0' or '2'
                }
                start = abs_pos + 1;
            } else {
                break;
            }
        }
    }

    let pos = best_pos?;
    let title_start = pos + 4; // skip ESC ] N ;
    if title_start >= data.len() {
        return None;
    }

    let remaining = &data[title_start..];
    let end = remaining.iter().position(|&b| b == 0x07 || b == 0x1b)?;
    let title_bytes = &remaining[..end];
    let _ = best_code;

    String::from_utf8_lossy(title_bytes).to_string().into()
}

/// Check if ANY terminal title (OSC 0 or OSC 2) in the buffer data contains the given substring.
pub fn any_terminal_title_contains(data: &[u8], substring: &str) -> bool {
    for needle in [OSC0_NEEDLE, OSC2_NEEDLE] {
        let mut start = 0;
        while start + needle.len() <= data.len() {
            if let Some(found) = data[start..]
                .windows(needle.len())
                .position(|w| w == needle)
            {
                let abs_pos = start + found;
                let title_start = abs_pos + needle.len();
                if title_start < data.len() {
                    let remaining = &data[title_start..];
                    if let Some(end) = remaining.iter().position(|&b| b == 0x07 || b == 0x1b) {
                        let title = String::from_utf8_lossy(&remaining[..end]);
                        if title.contains(substring) {
                            return true;
                        }
                    }
                }
                start = abs_pos + 1;
            } else {
                break;
            }
        }
    }
    false
}

/// Find the last occurrence of an OSC 133 sequence with a given param (e.g., "C" or "D").
pub fn find_last_osc_133(data: &[u8], param: &[u8]) -> Option<usize> {
    let mut needle = vec![0x1b, b']', b'1', b'3', b'3', b';'];
    needle.extend_from_slice(param);

    let mut pos = None;
    let mut start = 0;
    while start + needle.len() <= data.len() {
        if let Some(found) = data[start..]
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
        {
            pos = Some(start + found);
            start = start + found + 1;
        } else {
            break;
        }
    }
    pos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_osc7_cwd() {
        let data = b"\x1b]7;file://localhost/home/user\x07";
        assert_eq!(
            extract_last_osc7_cwd(data),
            Some("file://localhost/home/user".to_string())
        );
    }

    #[test]
    fn extract_osc9_9_cwd() {
        let data = b"\x1b]9;9;C:\\Users\\test\x07";
        assert_eq!(
            extract_last_osc9_9_cwd(data),
            Some("C:\\Users\\test".to_string())
        );
    }

    #[test]
    fn extract_terminal_title() {
        let data = b"\x1b]0;My Terminal\x07some output\x1b]2;Updated Title\x07";
        assert_eq!(
            extract_last_terminal_title(data),
            Some("Updated Title".to_string())
        );
    }

    #[test]
    fn any_title_contains_match() {
        let data = b"\x1b]0;Claude Code\x07";
        assert!(any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_no_match() {
        let data = b"\x1b]0;bash\x07";
        assert!(!any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn find_osc_133_prompt() {
        let data = b"output\x1b]133;D\x07more\x1b]133;B\x07prompt\x1b]133;C\x07";
        assert!(find_last_osc_133(data, b"C").is_some());
        assert!(find_last_osc_133(data, b"D").is_some());
    }

    #[test]
    fn find_osc_133_not_found() {
        let data = b"plain text output";
        assert!(find_last_osc_133(data, b"C").is_none());
    }

    #[test]
    fn osc_constants_have_correct_prefix() {
        assert_eq!(OSC7_NEEDLE[0], 0x1b);
        assert_eq!(OSC9_9_NEEDLE[0], 0x1b);
        assert_eq!(OSC0_NEEDLE[0], 0x1b);
        assert_eq!(OSC2_NEEDLE[0], 0x1b);
    }

    // ── iter_osc_events tests ──

    #[test]
    fn iter_single_osc7() {
        let data = b"\x1b]7;file://localhost/home/user\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 7);
        assert_eq!(events[0].param, None);
        assert_eq!(events[0].data, "file://localhost/home/user");
    }

    #[test]
    fn iter_osc9_with_subcode() {
        let data = b"\x1b]9;9;C:\\Users\\test\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 9);
        assert_eq!(events[0].param, Some("9".to_string()));
        assert_eq!(events[0].data, "C:\\Users\\test");
    }

    #[test]
    fn iter_osc9_notification() {
        let data = b"\x1b]9;Build complete\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 9);
        assert_eq!(events[0].param, None);
        assert_eq!(events[0].data, "Build complete");
    }

    #[test]
    fn iter_osc133_params() {
        let data = b"\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;E;git switch main\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 3);

        assert_eq!(events[0].code, 133);
        assert_eq!(events[0].param, Some("C".to_string()));
        assert_eq!(events[0].data, "");

        assert_eq!(events[1].code, 133);
        assert_eq!(events[1].param, Some("D".to_string()));
        assert_eq!(events[1].data, "0");

        assert_eq!(events[2].code, 133);
        assert_eq!(events[2].param, Some("E".to_string()));
        assert_eq!(events[2].data, "git switch main");
    }

    #[test]
    fn iter_mixed_osc_codes() {
        let data =
            b"some output\x1b]0;My Terminal\x07more text\x1b]7;/home/user\x07\x1b]133;D;0\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].code, 0);
        assert_eq!(events[0].data, "My Terminal");
        assert_eq!(events[1].code, 7);
        assert_eq!(events[1].data, "/home/user");
        assert_eq!(events[2].code, 133);
        assert_eq!(events[2].param, Some("D".to_string()));
        assert_eq!(events[2].data, "0");
    }

    #[test]
    fn iter_osc_st_terminator() {
        // ST = ESC \ (0x1b 0x5c)
        let data = b"\x1b]2;Title with ST\x1b\\rest of output";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 2);
        assert_eq!(events[0].data, "Title with ST");
    }

    #[test]
    fn iter_osc777_notification() {
        let data = b"\x1b]777;notify;Build;Success\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 777);
        assert_eq!(events[0].param, None);
        assert_eq!(events[0].data, "notify;Build;Success");
    }

    #[test]
    fn iter_osc99_notification() {
        let data = b"\x1b]99;Custom notification\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 99);
        assert_eq!(events[0].data, "Custom notification");
    }

    #[test]
    fn iter_no_osc_in_plain_text() {
        let data = b"plain text with no escape sequences";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert!(events.is_empty());
    }

    #[test]
    fn iter_incomplete_osc_skipped() {
        // No terminator — should yield nothing
        let data = b"\x1b]7;/home/user";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert!(events.is_empty());
    }

    #[test]
    fn iter_osc_title_with_claude() {
        let data = b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 0);
        assert!(events[0].data.contains("Claude Code"));
    }

    #[test]
    fn iter_multiple_titles_returns_all() {
        let data = b"\x1b]0;First\x07\x1b]2;Second\x07\x1b]0;Third\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].data, "First");
        assert_eq!(events[1].data, "Second");
        assert_eq!(events[2].data, "Third");
    }

    // ── extract_white_bullet_message tests ──

    #[test]
    fn white_bullet_basic() {
        let data = b"\x1b[38;5;231m\xe2\x97\x8f \x1b[mAll tests passed\n";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("All tests passed".to_string())
        );
    }

    #[test]
    fn white_bullet_ignores_green() {
        // Green ●: \x1b[38;5;2m●
        let data = b"\x1b[38;5;2m\xe2\x97\x8f Bash(cargo test)\n";
        assert_eq!(extract_white_bullet_message(data), None);
    }

    #[test]
    fn white_bullet_picks_last() {
        let mut data = Vec::new();
        // First white ●
        data.extend_from_slice(b"\x1b[38;5;231m\xe2\x97\x8f \x1b[mFirst message\n");
        // Green ● (should be skipped)
        data.extend_from_slice(b"\x1b[38;5;2m\xe2\x97\x8f Bash(ls)\n");
        // Second white ●
        data.extend_from_slice(b"\x1b[38;5;231m\xe2\x97\x8f \x1b[mSecond message\n");
        assert_eq!(
            extract_white_bullet_message(&data),
            Some("Second message".to_string())
        );
    }

    #[test]
    fn white_bullet_no_bullet_returns_none() {
        let data = b"plain text without any bullets";
        assert_eq!(extract_white_bullet_message(data), None);
    }

    #[test]
    fn white_bullet_strips_ansi_in_content() {
        // ● with ANSI codes inside the message text
        let data = b"\x1b[38;5;231m\xe2\x97\x8f \x1b[mAll \x1b[1m1235\x1b[m tests passed\n";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("All 1235 tests passed".to_string())
        );
    }

    #[test]
    fn white_bullet_with_cr_newline() {
        // Real terminal output often uses \r\n or just \r
        let data = b"\x1b[38;5;231m\xe2\x97\x8f \x1b[mMessage here\r\n";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("Message here".to_string())
        );
    }

    #[test]
    fn white_bullet_with_newline_gap() {
        // Real pattern: SGR_FG_231 + \n + ● (newline between SGR and bullet)
        let data = b"\x1b[38;5;231m\n\xe2\x97\x8f \x1b[mHostname is AMD9950\n";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("Hostname is AMD9950".to_string())
        );
    }

    #[test]
    fn white_bullet_with_cr_gap() {
        // Real pattern: SGR_FG_231 + \r + ● (carriage return between SGR and bullet)
        let data = b"\x1b[38;5;231m\r\xe2\x97\x8f \x1b[mStatus update\n";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("Status update".to_string())
        );
    }

    #[test]
    fn white_bullet_tui_mode_cursor_addressed() {
        // Real TUI pattern: ● followed by cursor movements, then text at different position
        // ●\x1b[m\x1b[1C\x1b[11X\x1b[11C\x1b[?2026h\x1b[?2026l\x1b[19;3H10이고,\x1b[1C안녕하세요!\x1b[38;5;174m\x1b[21;1H✶
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\r");
        data.extend_from_slice(&BULLET);
        data.extend_from_slice(b"\x1b[m\x1b[1C\x1b[11X\x1b[11C\x1b[?2026h\x1b[?2026l\x1b[19;3H10");
        data.extend_from_slice("이고,".as_bytes());
        data.extend_from_slice(b"\x1b[1C");
        data.extend_from_slice("안녕하세요!".as_bytes());
        data.extend_from_slice(b"\x1b[38;5;174m\x1b[21;1H");
        data.extend_from_slice("✶ Cont".as_bytes());
        let msg = extract_white_bullet_message(&data);
        assert!(msg.is_some(), "Should extract message from TUI output");
        let text = msg.unwrap();
        assert!(text.contains("10"), "Should contain '10': {text}");
        assert!(
            text.contains("안녕하세요"),
            "Should contain greeting: {text}"
        );
        // Should NOT contain spinner
        assert!(!text.contains("Cont"), "Should not contain spinner text: {text}");
    }

    #[test]
    fn white_bullet_at_end_of_data() {
        // No newline at end
        let data = b"\x1b[38;5;231m\xe2\x97\x8f \x1b[mFinal status";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("Final status".to_string())
        );
    }

    #[test]
    fn white_bullet_empty_after_bullet_skipped() {
        // ● with only whitespace/ANSI reset after it
        let data = b"\x1b[38;5;231m\xe2\x97\x8f \x1b[m  \n";
        assert_eq!(extract_white_bullet_message(data), None);
    }

    // ── strip_ansi tests ──

    #[test]
    fn strip_ansi_basic_sgr() {
        assert_eq!(strip_ansi("\x1b[1mBold\x1b[0m text"), "Bold text");
    }

    #[test]
    fn strip_ansi_256_color() {
        assert_eq!(strip_ansi("\x1b[38;5;231mWhite\x1b[m"), "White");
    }

    #[test]
    fn strip_ansi_erase_line() {
        assert_eq!(strip_ansi("text\x1b[K"), "text");
    }

    #[test]
    fn strip_ansi_no_escapes() {
        assert_eq!(strip_ansi("plain text"), "plain text");
    }

    #[test]
    fn iter_osc133_b_param_only() {
        // OSC 133;B has no data after the param
        let data = b"\x1b]133;B\x07";
        let events: Vec<OscEvent> = iter_osc_events(data).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 133);
        assert_eq!(events[0].param, Some("B".to_string()));
        assert_eq!(events[0].data, "");
    }
}
