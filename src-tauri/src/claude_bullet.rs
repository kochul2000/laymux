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
/// Each entry: (UTF-8 bytes of the marker char, expected color as RGB).
///
/// Color matching supports both 256-color (`38;5;N`) and true-color (`38;2;R;G;B`)
/// SGR sequences. ConPTY on Windows converts 256-color to RGB, so we parse the
/// SGR and compare colors with a tolerance (±40 per channel) instead of exact
/// byte matching.
const MARKERS: &[(&[u8], (u8, u8, u8))] = &[
    // Current (2025+): · (U+00B7 MIDDLE DOT) with salmon/terracotta color (256-color 174 = #d78787)
    (&[0xc2, 0xb7], (215, 135, 135)),
    // Legacy: ● (U+25CF BLACK CIRCLE) with bright-white color (256-color 231 = #ffffff)
    (&[0xe2, 0x97, 0x8f], (255, 255, 255)),
];

/// Per-channel tolerance for RGB color matching.
/// ConPTY color conversion can produce up to ~50 per channel variation
/// from the standard xterm 256-color palette values. 50 covers observed
/// ConPTY outputs like (215,119,87) for color 174 while still rejecting
/// clearly wrong colors (gray, blue, etc.).
const COLOR_TOLERANCE: i16 = 50;

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

    for &(marker_bytes, expected_rgb) in MARKERS {
        let mut pos = 0;
        while pos + marker_bytes.len() <= data.len() {
            let marker_pos = match data[pos..]
                .windows(marker_bytes.len())
                .position(|w| w == marker_bytes)
            {
                Some(p) => pos + p,
                None => break,
            };

            // Check if preceded by a matching SGR foreground color. Between the SGR
            // and the marker, allow whitespace (\r, \n, space) and CSI sequences
            // (e.g., cursor positioning \x1b[13;1H).
            //
            // Supports both 256-color (`38;5;N`) and true-color (`38;2;R;G;B`)
            // formats because ConPTY on Windows converts 256-color to RGB.
            let has_color = 'color: {
                let search_start = marker_pos.saturating_sub(SGR_LOOKBACK_BYTES);
                let window = &data[search_start..marker_pos];
                // Find the last `\x1b[38;` in the lookback window
                if let Some(sgr_rel) = find_last_sgr_38(window) {
                    let sgr_start = search_start + sgr_rel;
                    // Parse the SGR to extract RGB and find where it ends
                    if let Some((rgb, sgr_end_rel)) = parse_sgr_38_color(&data[sgr_start..]) {
                        let abs_sgr_end = sgr_start + sgr_end_rel;
                        // Verify gap between SGR end and marker is only whitespace/CSI
                        let gap = &data[abs_sgr_end..marker_pos];
                        let mut gi = 0;
                        while gi < gap.len() {
                            match gap[gi] {
                                b'\n' | b'\r' | b' ' => gi += 1,
                                0x1b if gi + 1 < gap.len() && gap[gi + 1] == b'[' => {
                                    gi = skip_csi_params(gap, gi + 2);
                                }
                                _ => break 'color false,
                            }
                        }
                        break 'color gi == gap.len() && rgb_matches(rgb, expected_rgb);
                    }
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
                    if best
                        .as_ref()
                        .map_or(true, |(prev_pos, _)| marker_pos > *prev_pos)
                    {
                        best = Some((marker_pos, stripped));
                    }
                }
            }

            pos = marker_pos + marker_bytes.len();
        }
    }

    best.map(|(_, msg)| msg)
}

/// Find the last occurrence of `\x1b[38;` in a byte slice, returning its offset.
fn find_last_sgr_38(window: &[u8]) -> Option<usize> {
    const NEEDLE: &[u8] = b"\x1b[38;";
    let mut last = None;
    let mut start = 0;
    while start + NEEDLE.len() <= window.len() {
        if let Some(found) = window[start..]
            .windows(NEEDLE.len())
            .position(|w| w == NEEDLE)
        {
            last = Some(start + found);
            start = start + found + 1;
        } else {
            break;
        }
    }
    last
}

/// Parse an SGR `\x1b[38;5;Nm` or `\x1b[38;2;R;G;Bm` sequence starting at `data`.
/// Returns `(rgb_tuple, byte_length_of_sequence)` on success.
fn parse_sgr_38_color(data: &[u8]) -> Option<((u8, u8, u8), usize)> {
    // Must start with ESC[38;
    if data.len() < 7 || &data[..5] != b"\x1b[38;" {
        return None;
    }
    let rest = &data[5..]; // after "ESC[38;"

    // Find 'm' terminator
    let m_pos = rest.iter().position(|&b| b == b'm')?;
    let params_str = std::str::from_utf8(&rest[..m_pos]).ok()?;
    let seq_len = 5 + m_pos + 1; // total bytes including ESC[38; ... m

    if let Some(idx_str) = params_str.strip_prefix("5;") {
        // 256-color: 38;5;N
        let idx: u8 = idx_str.parse().ok()?;
        Some((color256_to_rgb(idx), seq_len))
    } else if let Some(rgb_str) = params_str.strip_prefix("2;") {
        // True-color: 38;2;R;G;B
        let parts: Vec<&str> = rgb_str.split(';').collect();
        if parts.len() == 3 {
            let r: u8 = parts[0].parse().ok()?;
            let g: u8 = parts[1].parse().ok()?;
            let b: u8 = parts[2].parse().ok()?;
            Some(((r, g, b), seq_len))
        } else {
            None
        }
    } else {
        None
    }
}

/// Convert a 256-color index to RGB using the standard xterm color cube.
/// Falls back to black for standard colors 0-15 (not used by Claude markers).
fn color256_to_rgb(idx: u8) -> (u8, u8, u8) {
    /// xterm 6x6x6 color cube values (0→0, 1→95, 2→135, 3→175, 4→215, 5→255)
    const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];
    match idx {
        16..=231 => {
            let n = (idx - 16) as usize;
            let r = CUBE[n / 36];
            let g = CUBE[(n / 6) % 6];
            let b = CUBE[n % 6];
            (r, g, b)
        }
        232..=255 => {
            let v = 8 + 10 * (idx - 232);
            (v, v, v)
        }
        _ => (0, 0, 0),
    }
}

/// Check if two RGB colors match within [`COLOR_TOLERANCE`] per channel.
fn rgb_matches(actual: (u8, u8, u8), expected: (u8, u8, u8)) -> bool {
    let dr = (actual.0 as i16 - expected.0 as i16).abs();
    let dg = (actual.1 as i16 - expected.1 as i16).abs();
    let db = (actual.2 as i16 - expected.2 as i16).abs();
    dr <= COLOR_TOLERANCE && dg <= COLOR_TOLERANCE && db <= COLOR_TOLERANCE
}

/// Skip CSI parameter bytes starting at `start` (after ESC [), returning the
/// index past the final byte. Shared by `has_color` validation and `skip_ansi_escape`.
fn skip_csi_params(bytes: &[u8], start: usize) -> usize {
    let mut j = start;
    while j < bytes.len() && !(bytes[j].is_ascii_alphabetic() || bytes[j] == b'~') {
        j += 1;
    }
    if j < bytes.len() {
        j + 1
    } else {
        j
    }
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
        assert!(
            !text.contains("Cont"),
            "Should not contain spinner text: {text}"
        );
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
        assert!(
            msg.is_some(),
            "Should extract · message from real TUI output"
        );
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
        data.extend_from_slice(
            b"\x1b[1CUpdated auth.ts\x1b[38;5;174m\x1b[20;1H\xe2\x9c\xb6 Working",
        );
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
        assert_eq!(strip_ansi("\x1b[38;5;231m한글 테스트\x1b[m"), "한글 테스트");
    }

    #[test]
    fn strip_ansi_osc_with_st_terminator() {
        assert_eq!(strip_ansi("before\x1b]2;title\x1b\\after"), "beforeafter");
    }

    // ── ConPTY RGB color conversion tests ──
    // Windows ConPTY converts 256-color (38;5;N) to true-color (38;2;R;G;B).
    // These tests verify that the fuzzy RGB matching handles the conversion.

    #[test]
    fn middot_rgb_exact_conversion() {
        // 256-color 174 = #d78787 = RGB(215,135,135) — exact conversion
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;2;215;135;135m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" Creating plan\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Creating plan".to_string())
        );
    }

    #[test]
    fn middot_rgb_conpty_variation() {
        // ConPTY observed output: 38;2;215;119;87 (close to 174's RGB)
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;2;215;119;87m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" Task completed\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Task completed".to_string())
        );
    }

    #[test]
    fn middot_rgb_conpty_variation_2() {
        // Another observed ConPTY output: 38;2;225;140;108
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;2;225;140;108m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b"\x1b[1CRead 5 files\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("Read 5 files".to_string())
        );
    }

    #[test]
    fn legacy_bullet_rgb_white() {
        // 256-color 231 = #ffffff = RGB(255,255,255)
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;2;255;255;255m");
        data.extend_from_slice(LEGACY_BULLET);
        data.extend_from_slice(b" \x1b[mAll tests passed\n");
        assert_eq!(
            extract_claude_status_message(&data),
            Some("All tests passed".to_string())
        );
    }

    #[test]
    fn middot_rgb_wrong_color_rejected() {
        // Blue color — should not match salmon marker
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;2;0;0;255m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" Not a status\n");
        assert_eq!(extract_claude_status_message(&data), None);
    }

    #[test]
    fn middot_rgb_gray_rejected() {
        // Gray (136,136,136) — should not match salmon
        let mut data = Vec::new();
        data.extend_from_slice(b"\x1b[38;2;136;136;136m");
        data.extend_from_slice(MIDDOT);
        data.extend_from_slice(b" Gray text\n");
        assert_eq!(extract_claude_status_message(&data), None);
    }

    // ── Helper function tests ──

    #[test]
    fn color256_to_rgb_known_values() {
        assert_eq!(color256_to_rgb(174), (215, 135, 135)); // #d78787
        assert_eq!(color256_to_rgb(231), (255, 255, 255)); // #ffffff
    }

    #[test]
    fn rgb_matches_exact() {
        assert!(rgb_matches((215, 135, 135), (215, 135, 135)));
    }

    #[test]
    fn rgb_matches_within_tolerance() {
        // ConPTY observed variations for color 174
        assert!(rgb_matches((215, 119, 87), (215, 135, 135)));
        assert!(rgb_matches((225, 140, 108), (215, 135, 135)));
    }

    #[test]
    fn rgb_matches_rejects_distant() {
        assert!(!rgb_matches((0, 0, 255), (215, 135, 135)));
        assert!(!rgb_matches((136, 136, 136), (215, 135, 135)));
    }

    #[test]
    fn parse_sgr_38_256color() {
        let data = b"\x1b[38;5;174mrest";
        let result = parse_sgr_38_color(data);
        assert!(result.is_some());
        let (rgb, len) = result.unwrap();
        assert_eq!(len, 11); // \x1b[38;5;174m = 11 bytes
        assert_eq!(rgb, color256_to_rgb(174));
    }

    #[test]
    fn parse_sgr_38_truecolor() {
        let data = b"\x1b[38;2;215;119;87mrest";
        let result = parse_sgr_38_color(data);
        assert!(result.is_some());
        let (rgb, len) = result.unwrap();
        assert_eq!(rgb, (215, 119, 87));
        assert_eq!(len, 18); // \x1b[38;2;215;119;87m = 18 bytes
    }
}
