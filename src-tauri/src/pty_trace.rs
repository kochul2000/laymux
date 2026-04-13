//! PTY byte-stream tracing utilities.
//!
//! Diagnostic-only helpers that summarise raw PTY bytes and detect the
//! escape sequences most relevant to cursor/flicker investigations
//! (OSC 133/633 prompt boundaries, DECSET 2026 synchronized output,
//! ESC 7/8 / CSI s/u cursor save-restore, alt-buffer switches).
//!
//! # Scope
//!
//! This module only covers the **Rust-side** PTY byte trace. The matching
//! shadow-cursor trace on the UI lives in `ui/src/lib/cursor-trace.ts` and
//! is gated independently — there is no `LAYMUX_CURSOR_TRACE` env var on
//! the Rust side. To see both streams together, enable Rust PTY tracing
//! with `LAYMUX_PTY_TRACE=1` and the UI tracer with either the
//! `VITE_LAYMUX_CURSOR_TRACE=1` build flag or
//! `localStorage["laymux:cursor-trace"]="1"` at runtime.
//!
//! # Cost profile
//!
//! When tracing is off (the default), `is_pty_trace_enabled()` returns a
//! cached `false` and the callers skip this module entirely. When tracing
//! is on, each chunk is scanned twice: once by `summarize_terminal_bytes`
//! (UTF-8 lossy + escape_default) and once by `detect_terminal_signals`
//! (needle scan). On very large chunks (e.g. a full vim redraw) the
//! double pass is a known tradeoff — the diagnostic user is expected to
//! accept some observer effect. If this ever blocks a real investigation,
//! combine both into a single streaming scanner.
//!
//! Related reference docs:
//! - `docs/terminal/fix-flicker.md`
//! - `docs/terminal/xterm-shadow-cursor-architecture.md`
//! - `docs/terminal/xterm-cursor-repaint-analysis.md`

use std::sync::OnceLock;

use crate::constants::ENV_LAYMUX_PTY_TRACE;

/// Maximum byte length of a `summarize_terminal_bytes` preview before a
/// trailing ellipsis is appended. Chosen to fit a single log line.
const PREVIEW_BYTE_LIMIT: usize = 240;

/// Escape-sequence signals detected in a PTY chunk. The detector scans for
/// each needle exactly once, so adding entries here is O(N·M) in the chunk
/// but M is tiny and the detector only runs when tracing is enabled.
///
/// Matching is **literal-prefix-only**. This is intentional for OSC 133/633
/// (which carry optional `;param` tails — we only care that the category
/// fired) and for `DEC2026`/`ALT1049` (`h`/`l` suffixes share a prefix).
///
/// One minor caveat: `\x1b[s` / `\x1b[u` are the 3-byte SCOSC/SCORC cursor
/// save/restore sequences. A longer CSI that happens to end in `s`/`u` such
/// as `\x1b[1;2s` (set scroll region) has a *different* byte sequence and
/// does NOT match — no false positive. The only way these entries misfire
/// is if a chunk literally contains the 3 bytes `ESC [ s` as a substring
/// of some malformed stream, which is diagnostic noise we can live with.
const SIGNAL_CHECKS: &[(&[u8], &str)] = &[
    (b"\x1b]133;A", "OSC133:A"),
    (b"\x1b]133;B", "OSC133:B"),
    (b"\x1b]133;C", "OSC133:C"),
    (b"\x1b]133;D", "OSC133:D"),
    (b"\x1b]633;A", "OSC633:A"),
    (b"\x1b]633;B", "OSC633:B"),
    (b"\x1b]633;C", "OSC633:C"),
    (b"\x1b]633;D", "OSC633:D"),
    (b"\x1b[?2026h", "DEC2026:set"),
    (b"\x1b[?2026l", "DEC2026:reset"),
    (b"\x1b7", "ESC7"),
    (b"\x1b8", "ESC8"),
    (b"\x1b[?1049", "ALT1049"),
    (b"\x1b[s", "CSI:s"),
    (b"\x1b[u", "CSI:u"),
];

fn env_flag_enabled(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

/// Returns `true` when `LAYMUX_PTY_TRACE` was set to a truthy value at
/// process start. The result is cached — tracing cannot be toggled at
/// runtime (the diagnostic is expected to run for the lifetime of a
/// debugging session).
pub fn is_pty_trace_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| env_flag_enabled(ENV_LAYMUX_PTY_TRACE))
}

/// Render a PTY byte slice as an escaped, length-capped preview suitable
/// for a single log line. Control characters and non-UTF-8 bytes are
/// escaped; the result is truncated on a char boundary so the function
/// never panics regardless of input.
pub fn summarize_terminal_bytes(data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data);
    let escaped = text.escape_default().to_string();
    if escaped.len() <= PREVIEW_BYTE_LIMIT {
        return escaped;
    }

    // `escape_default` produces ASCII-only output today, but truncate on a
    // char boundary defensively in case that ever changes.
    let mut end = PREVIEW_BYTE_LIMIT;
    while end > 0 && !escaped.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &escaped[..end])
}

/// Scan a PTY chunk for cursor-relevant escape sequences and return a
/// labelled list of everything detected. Order matches `SIGNAL_CHECKS`.
pub fn detect_terminal_signals(data: &[u8]) -> Vec<&'static str> {
    let mut signals = Vec::new();
    for (needle, label) in SIGNAL_CHECKS {
        if data.len() >= needle.len() && data.windows(needle.len()).any(|w| w == *needle) {
            signals.push(*label);
        }
    }
    signals
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_short_preserves_input() {
        let out = summarize_terminal_bytes(b"hello\nworld");
        assert_eq!(out, "hello\\nworld");
    }

    #[test]
    fn summarize_truncates_long_input_with_ellipsis() {
        let blob = vec![b'a'; PREVIEW_BYTE_LIMIT * 2];
        let out = summarize_terminal_bytes(&blob);
        assert!(out.ends_with("..."));
        assert!(out.len() <= PREVIEW_BYTE_LIMIT + 3);
    }

    #[test]
    fn summarize_handles_invalid_utf8_without_panic() {
        let out = summarize_terminal_bytes(&[0xFF, 0xFE, 0xFD]);
        assert!(!out.is_empty());
    }

    #[test]
    fn detect_osc133_prompt_markers() {
        let data = b"prefix\x1b]133;A\x07body\x1b]133;B\x07tail";
        let signals = detect_terminal_signals(data);
        assert!(signals.contains(&"OSC133:A"));
        assert!(signals.contains(&"OSC133:B"));
        assert!(!signals.contains(&"OSC133:C"));
    }

    #[test]
    fn detect_dec_2026_synchronized_output() {
        let data = b"\x1b[?2026hframe\x1b[?2026l";
        let signals = detect_terminal_signals(data);
        assert!(signals.contains(&"DEC2026:set"));
        assert!(signals.contains(&"DEC2026:reset"));
    }

    #[test]
    fn detect_cursor_save_restore_variants() {
        let esc_78 = detect_terminal_signals(b"\x1b7move\x1b8");
        assert!(esc_78.contains(&"ESC7"));
        assert!(esc_78.contains(&"ESC8"));

        let csi_su = detect_terminal_signals(b"\x1b[smove\x1b[u");
        assert!(csi_su.contains(&"CSI:s"));
        assert!(csi_su.contains(&"CSI:u"));
    }

    #[test]
    fn detect_alt_screen_transitions() {
        let enter = detect_terminal_signals(b"\x1b[?1049h");
        assert!(enter.contains(&"ALT1049"));
    }

    #[test]
    fn detect_returns_empty_for_plain_text() {
        assert!(detect_terminal_signals(b"hello world").is_empty());
    }

    #[test]
    fn detect_handles_short_input_below_needle_length() {
        // Shorter than every needle — must not panic or false-positive.
        assert!(detect_terminal_signals(b"").is_empty());
        assert!(detect_terminal_signals(b"\x1b").is_empty());
    }
}
