//! Claude Code white-● message extraction and ANSI stripping utilities.
//!
//! Scans raw PTY output for user-facing status messages emitted by Claude Code,
//! identified by the bright-white `●` (U+25CF) marker with SGR 38;5;231 coloring.
//! Also provides general-purpose ANSI escape stripping.

use crate::constants::BULLET_MESSAGE_SCAN_BYTES;

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
            // We scan up to BULLET_MESSAGE_SCAN_BYTES bytes, strip ANSI, and stop at spinner chars.
            let text_start = bullet_pos + BULLET.len();
            let scan_end = (text_start + BULLET_MESSAGE_SCAN_BYTES).min(data.len());
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

/// Skip a single ANSI escape sequence starting at `bytes[i]`.
/// Returns `(new_index, csi_final_byte)` where `csi_final_byte` is `Some(b'C')` etc.
/// for CSI sequences, `None` for OSC or other sequences.
fn skip_ansi_escape(bytes: &[u8], i: usize) -> (usize, Option<u8>) {
    debug_assert!(bytes[i] == 0x1b && i + 1 < bytes.len());
    match bytes[i + 1] {
        b'[' => {
            // CSI: ESC [ params final_byte
            let mut j = i + 2;
            while j < bytes.len() && !(bytes[j].is_ascii_alphabetic() || bytes[j] == b'~') {
                j += 1;
            }
            if j < bytes.len() {
                let final_byte = bytes[j];
                (j + 1, Some(final_byte))
            } else {
                (j, None)
            }
        }
        b']' => {
            // OSC: skip to BEL or ST
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != 0x07 {
                if bytes[j] == 0x1b {
                    j += 1; // skip ESC of ST (ESC \)
                    if j < bytes.len() && bytes[j] == b'\\' {
                        j += 1; // skip the backslash
                    }
                    break;
                }
                j += 1;
            }
            if j < bytes.len() && bytes[j] == 0x07 {
                j += 1; // skip BEL terminator
            }
            (j, None)
        }
        _ => (i + 2, None),
    }
}

/// Strip ANSI and extract message text for a ● bullet line.
/// Converts cursor-forward (`\x1b[nC`) to spaces, strips all other ANSI,
/// and stops at spinner characters (✶✻✽✢) or another ● bullet.
fn strip_ansi_for_bullet(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            let (next_i, final_byte) = skip_ansi_escape(bytes, i);
            if final_byte == Some(b'C') {
                result.push(' '); // Cursor forward → space
            }
            i = next_i;
        } else {
            // Check for spinner/stop characters
            let remaining = &input[i..];
            // Stop at spinner chars, another ●, or input separator line (─)
            for stop_char in ['✶', '✻', '✽', '✢', '●', '─', '❯'] {
                if remaining.starts_with(stop_char) {
                    return result.trim().to_string();
                }
            }
            // Regular character (safe: remaining is non-empty &str slice)
            if let Some(ch) = remaining.chars().next() {
                result.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
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
            let (next_i, _) = skip_ansi_escape(bytes, i);
            i = next_i;
        } else {
            let remaining = &input[i..];
            if let Some(ch) = remaining.chars().next() {
                result.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn white_bullet_stops_at_separator_line() {
        // ● message followed by ─── separator line (input area divider)
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\n");
        data.extend_from_slice(&BULLET);
        data.extend_from_slice(" \x1b[m메시지 텍스트\n".as_bytes());
        data.extend_from_slice("──────────────────\n".as_bytes());
        data.extend_from_slice("❯ ".as_bytes());
        let msg = extract_white_bullet_message(&data).unwrap();
        assert_eq!(msg, "메시지 텍스트");
        assert!(!msg.contains('─'), "Should not contain separator: {msg}");
    }

    #[test]
    fn white_bullet_allows_normal_hyphen() {
        // Normal hyphen-minus (-) in message should be preserved
        let data = b"\x1b[38;5;231m\n\xe2\x97\x8f \x1b[mtest-result is 42\n";
        assert_eq!(
            extract_white_bullet_message(data),
            Some("test-result is 42".to_string())
        );
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
    fn strip_ansi_multibyte_utf8() {
        // Verify strip_ansi correctly handles multibyte UTF-8 characters
        assert_eq!(
            strip_ansi("\x1b[38;5;231m한글 테스트\x1b[m"),
            "한글 테스트"
        );
    }

    #[test]
    fn strip_ansi_osc_with_st_terminator() {
        // OSC terminated by ST (ESC \) should be fully stripped
        assert_eq!(
            strip_ansi("before\x1b]2;title\x1b\\after"),
            "beforeafter"
        );
    }
}
