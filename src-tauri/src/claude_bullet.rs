//! Claude Code status-marker message extraction and ANSI stripping utilities.
//!
//! Scans raw PTY output for user-facing status messages emitted by Claude Code.
//! Two marker variants are supported:
//!   - Legacy: bright-white `●` (U+25CF) with SGR 38;5;231
//!   - Current: salmon `·` (U+00B7) with SGR 38;5;174 (Claude brand color)
//! Also provides general-purpose ANSI escape stripping.

use crate::constants::STATUS_MESSAGE_SCAN_BYTES;

/// Max bytes to search backward from a marker for its SGR color prefix.
/// Covers the SGR sequence itself plus a few CSI cursor-position sequences
/// that the TUI may insert between color and marker.
const SGR_LOOKBACK_BYTES: usize = 50;

/// Marker variants emitted by Claude Code for status messages.
/// Each entry: (UTF-8 bytes of the marker char, SGR color prefix).
const MARKERS: &[(&[u8], &[u8])] = &[
    // Current (2025+): · (U+00B7 MIDDLE DOT) with salmon/terracotta color
    (&[0xc2, 0xb7], b"\x1b[38;5;174m"),
    // Legacy: ● (U+25CF BLACK CIRCLE) with bright-white color
    (&[0xe2, 0x97, 0x8f], b"\x1b[38;5;231m"),
];

/// Characters that terminate status message text scanning.
/// Spinner chars (✶✻✽✢), both marker variants (● ·), separator (─), prompt (❯).
const STOP_CHARS: &[char] = &['✶', '✻', '✽', '✢', '●', '·', '─', '❯'];

/// Extract the last Claude Code status message from terminal output.
///
/// Scans raw PTY bytes for known marker characters (`·` or `●`) preceded by their
/// respective ANSI color codes. Returns the text content after the marker with
/// ANSI codes stripped. Markers with non-matching colors are skipped.
///
/// Claude Code uses TUI rendering with cursor-addressed output, so the message text
/// may not be adjacent to the marker in the byte stream. We scan forward past cursor
/// control sequences to find the text, stopping at spinner characters or color changes.
pub fn extract_claude_status_message(data: &[u8]) -> Option<String> {
    let mut best: Option<(usize, String)> = None; // (position, message)

    for &(marker_bytes, sgr_prefix) in MARKERS {
        let mut pos = 0;
        while pos + marker_bytes.len() <= data.len() {
            let marker_pos = match data[pos..]
                .windows(marker_bytes.len())
                .position(|w| w == marker_bytes)
            {
                Some(p) => pos + p,
                None => break,
            };

            // Check if preceded by the expected SGR color. Between the SGR and the
            // marker, allow whitespace (\r, \n, space) and CSI sequences (e.g.,
            // cursor positioning \x1b[13;1H).
            let has_color = 'color: {
                let search_start = marker_pos.saturating_sub(SGR_LOOKBACK_BYTES);
                let window = &data[search_start..marker_pos];
                let sgr_pos = window
                    .windows(sgr_prefix.len())
                    .rposition(|w| w == sgr_prefix);
                if let Some(rel_pos) = sgr_pos {
                    let abs_sgr_end = search_start + rel_pos + sgr_prefix.len();
                    // Verify gap between SGR end and marker contains only whitespace
                    // and non-color CSI sequences (cursor movement, erase, etc.).
                    // If another SGR (final byte 'm') appears in the gap, it overrides
                    // the color — the marker's actual render color is NOT the one we found.
                    let gap = &data[abs_sgr_end..marker_pos];
                    let mut gi = 0;
                    while gi < gap.len() {
                        match gap[gi] {
                            b'\n' | b'\r' | b' ' => gi += 1,
                            0x1b if gi + 1 < gap.len() && gap[gi + 1] == b'[' => {
                                let end = skip_csi_params(gap, gi + 2);
                                // Check final byte: 'm' = SGR (color change) → invalidates
                                if end > gi + 2 && gap[end - 1] == b'm' {
                                    break 'color false;
                                }
                                gi = end;
                            }
                            _ => break 'color false,
                        }
                    }
                    break 'color gi == gap.len();
                }
                false
            };

            if has_color {
                let text_start = marker_pos + marker_bytes.len();
                let scan_end = (text_start + STATUS_MESSAGE_SCAN_BYTES).min(data.len());
                let raw_text = String::from_utf8_lossy(&data[text_start..scan_end]);
                let stripped = strip_ansi_inner(&raw_text, STOP_CHARS, true);
                if !stripped.is_empty() {
                    // Keep the last occurrence by position in the byte stream
                    if best.as_ref().map_or(true, |(prev_pos, _)| marker_pos > *prev_pos) {
                        best = Some((marker_pos, stripped));
                    }
                }
            }

            pos = marker_pos + marker_bytes.len();
        }
    }

    best.map(|(_, msg)| msg)
}

/// Skip CSI parameter bytes starting at `start` (after ESC [), returning the
/// index past the final byte. Shared by `has_color` validation and `skip_ansi_escape`.
fn skip_csi_params(bytes: &[u8], start: usize) -> usize {
    let mut j = start;
    while j < bytes.len() && !(bytes[j].is_ascii_alphabetic() || bytes[j] == b'~') {
        j += 1;
    }
    if j < bytes.len() { j + 1 } else { j }
}

/// Skip a single ANSI escape sequence starting at `bytes[i]`.
/// Returns `(new_index, csi_final_byte)` where `csi_final_byte` is `Some(b'C')` etc.
/// for CSI sequences, `None` for OSC or other sequences.
fn skip_ansi_escape(bytes: &[u8], i: usize) -> (usize, Option<u8>) {
    debug_assert!(bytes[i] == 0x1b && i + 1 < bytes.len());
    match bytes[i + 1] {
        b'[' => {
            // CSI: ESC [ params final_byte
            let end = skip_csi_params(bytes, i + 2);
            let final_byte = if end > i + 2 && end - 1 < bytes.len() {
                Some(bytes[end - 1])
            } else {
                None
            };
            (end, final_byte)
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

/// Core ANSI stripping loop shared by `strip_ansi` and status message extraction.
///
/// - `stop_chars`: if non-empty, stops scanning when any of these chars is encountered.
/// - `cursor_to_space`: if true, CSI cursor-forward (`ESC[nC`) is converted to a space.
///
/// The result is trimmed when `stop_chars` is non-empty (status message mode).
fn strip_ansi_inner(input: &str, stop_chars: &[char], cursor_to_space: bool) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            let (next_i, final_byte) = skip_ansi_escape(bytes, i);
            if cursor_to_space && final_byte == Some(b'C') {
                result.push(' ');
            }
            i = next_i;
        } else {
            let remaining = &input[i..];
            if !stop_chars.is_empty() {
                for &ch in stop_chars {
                    if remaining.starts_with(ch) {
                        return result.trim().to_string();
                    }
                }
            }
            if let Some(ch) = remaining.chars().next() {
                result.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
        }
    }

    if stop_chars.is_empty() {
        result
    } else {
        result.trim().to_string()
    }
}

/// Strip ANSI escape sequences (CSI and OSC) from a string, returning plain text.
pub fn strip_ansi(input: &str) -> String {
    strip_ansi_inner(input, &[], false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Legacy marker: ● (U+25CF BLACK CIRCLE)
    const LEGACY_BULLET: &[u8] = &[0xe2, 0x97, 0x8f];
    /// Current marker: · (U+00B7 MIDDLE DOT)
    const MIDDOT: &[u8] = &[0xc2, 0xb7];

    // ── Legacy marker (● U+25CF with SGR 231) tests ──

    #[test]
    fn legacy_bullet_basic() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mAll tests passed\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("All tests passed".to_string())
        );
    }

    #[test]
    fn legacy_bullet_ignores_green() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;2m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" Bash(cargo test)\n");
        assert_eq!(extract_claude_status_message(&data), None);
    }

    #[test]
    fn legacy_bullet_picks_last() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mFirst message\n");
        data.extend_from_slice(b"\x1b[38;5;2m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" Bash(ls)\n");
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mSecond message\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Second message".to_string())
        );
    }

    #[test]
    fn no_marker_returns_none() {
        let data = b"plain text without any markers";
        assert_eq!(extract_claude_status_message(data), None);
    }

    #[test]
    fn legacy_bullet_strips_ansi_in_content() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mAll \x1b[1m1235\x1b[m tests passed\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("All 1235 tests passed".to_string())
        );
    }

    #[test]
    fn legacy_bullet_with_cr_newline() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mMessage here\r\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Message here".to_string())
        );
    }

    #[test]
    fn legacy_bullet_with_newline_gap() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\n");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mHostname is AMD9950\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Hostname is AMD9950".to_string())
        );
    }

    #[test]
    fn legacy_bullet_with_cr_gap() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\r");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mStatus update\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Status update".to_string())
        );
    }

    #[test]
    fn legacy_bullet_tui_mode_cursor_addressed() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\r");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b"\x1b[m\x1b[1C\x1b[11X\x1b[11C\x1b[?2026h\x1b[?2026l\x1b[19;3H10");
        data.extend_from_slice("이고,".as_bytes());
        data.extend_from_slice(b"\x1b[1C");
        data.extend_from_slice("안녕하세요!".as_bytes());
        data.extend_from_slice(b"\x1b[38;5;174m\x1b[21;1H");
        data.extend_from_slice("✶ Cont".as_bytes());
        let msg = extract_claude_status_message(&data);
        assert!(msg.is_some(), "Should extract message from TUI output");
        let text = msg.unwrap();
        assert!(text.contains("10"), "Should contain '10': {text}");
        assert!(
            text.contains("안녕하세요"),
            "Should contain greeting: {text}"
        );
        assert!(!text.contains("Cont"), "Should not contain spinner text: {text}");
    }

    #[test]
    fn legacy_bullet_at_end_of_data() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mFinal status");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Final status".to_string())
        );
    }

    #[test]
    fn legacy_bullet_empty_after_marker_skipped() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[m  \n");
        assert_eq!(extract_claude_status_message(&data), None);
    }

    #[test]
    fn legacy_bullet_stops_at_separator_line() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\n");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(" \x1b[m메시지 텍스트\n".as_bytes());
        data.extend_from_slice("──────────────────\n".as_bytes());
        data.extend_from_slice("❯ ".as_bytes());
        let msg = extract_claude_status_message(&data).unwrap();
        assert_eq!(msg, "메시지 텍스트");
        assert!(!msg.contains('─'), "Should not contain separator: {msg}");
    }

    #[test]
    fn legacy_bullet_allows_normal_hyphen() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m\n");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mtest-result is 42\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("test-result is 42".to_string())
        );
    }

    // ── Current marker (· U+00B7 with SGR 174) tests ──

    #[test]
    fn middot_basic() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" Creating plan\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Creating plan".to_string())
        );
    }

    #[test]
    fn middot_with_cursor_forward() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m\r\n");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CRead 3 files\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Read 3 files".to_string())
        );
    }

    #[test]
    fn middot_ignores_wrong_color() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;244m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" gray status\n");
        assert_eq!(extract_claude_status_message(&data), None);
    }

    #[test]
    fn middot_real_tui_pattern() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m\r\n");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CCreating\xe2\x80\xa6\x1b[38;5;244m\x1b[16;1H");
        let msg = extract_claude_status_message(&data);
        assert!(msg.is_some(), "Should extract · message from real TUI output");
        let text = msg.unwrap();
        assert!(
            text.starts_with("Creating"),
            "Should start with 'Creating': {text}"
        );
    }

    #[test]
    fn middot_stops_at_spinner() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CUpdated auth.ts\x1b[38;5;174m\x1b[20;1H\xe2\x9c\xb6 Working");
        let msg = extract_claude_status_message(&data).unwrap();
        assert_eq!(msg, "Updated auth.ts");
    }

    #[test]
    fn middot_with_cursor_position_between_sgr_and_marker() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m\x1b[13;1H");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CCreating plan");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Creating plan".to_string())
        );
    }

    #[test]
    fn mixed_legacy_and_current_picks_last() {
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;231m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mLegacy message\n");
        data.extend_from_slice(b"\x1b[38;5;174m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CCurrent message\n");
        let msg = extract_claude_status_message(&data).unwrap();
        assert_eq!(msg, "Current message");
    }

    #[test]
    fn middot_with_intervening_sgr_rejected() {
        // SGR 174 followed by another SGR (246) before the · marker.
        // The · is rendered in color 246 (gray), not 174 (salmon).
        // This pattern appears in Claude Code's "1 MCP server failed · /mcp" line.
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m banner text \x1b[38;5;246m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" /mcp\x1b[m\n");
        assert_eq!(extract_claude_status_message(&data), None);
    }

    #[test]
    fn middot_with_cursor_csi_in_gap_accepted() {
        // Cursor-movement CSI (not SGR) between SGR 174 and · should be allowed.
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;5;174m\x1b[13;1H");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CCreating plan\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Creating plan".to_string())
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
        assert_eq!(
            strip_ansi("\x1b[38;5;231m한글 테스트\x1b[m"),
            "한글 테스트"
        );
    }

    #[test]
    fn strip_ansi_osc_with_st_terminator() {
        assert_eq!(
            strip_ansi("before\x1b]2;title\x1b\\after"),
            "beforeafter"
        );
    }
}
