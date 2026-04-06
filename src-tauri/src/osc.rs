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
            if raw.starts_with("9;") {
                (Some("9".to_string()), raw[2..].to_string())
            } else {
                (None, raw.to_string())
            }
        }
        _ => (None, raw.to_string()),
    }
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
