//! OSC escape sequence parsing for terminal output.
//!
//! Extracts CWD, titles, and shell integration markers from PTY output data.

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
}
