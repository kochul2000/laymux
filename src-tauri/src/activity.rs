//! Terminal activity state detection.
//!
//! Detects whether a terminal is at a shell prompt, running a command,
//! or running an interactive application (Claude Code, vim, etc.).
//! Also contains `BurstDetector` for DEC 2026 sustained TUI activity detection.

use std::sync::atomic::AtomicBool;
use std::time::Instant;

use crate::constants::ACTIVITY_SCAN_BYTES;
use crate::lock_ext::MutexExt;
use crate::osc;
use crate::output_buffer::TerminalOutputBuffer;
use crate::state::AppState;
use crate::terminal::{TerminalActivity, TerminalStateInfo};

/// Known interactive apps detected from terminal title (OSC 0 / OSC 2).
/// Pattern matching uses word boundaries to avoid false positives
/// (e.g., "vim" should not match "environment").
pub const INTERACTIVE_APP_PATTERNS: &[(&str, &str)] = &[
    ("Claude Code", "Claude"),
    ("OpenAI Codex", "Codex"),
    ("nvim", "neovim"),
    ("vim", "vim"),
    ("vi", "vim"),
    ("nano", "nano"),
    ("htop", "htop"),
    ("btop", "btop"),
    ("top", "top"),
    ("less", "less"),
    ("man ", "man"),
    ("python3", "python"),
    ("python", "python"),
    ("node", "node"),
    ("ipython", "ipython"),
];

/// Check if a terminal is running Claude Code.
/// Uses two-pronged detection:
/// 1. Persistent tracking (`known_claude_terminals`) — instant O(1) check
/// 2. Full buffer title scan — checks ALL OSC 0/2 titles, not just the last one
pub fn is_claude_terminal_from_buffer(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> bool {
    // Prong 1: Check persistent tracking
    if let Ok(known) = state.known_claude_terminals.lock_or_err() {
        if known.contains(terminal_id) {
            return true;
        }
    }

    // Prong 2: Scan ALL titles in buffer for "Claude Code"
    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }

    if osc::any_terminal_title_contains(&recent, "Claude Code") {
        // Mark persistently for future calls
        if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
            known.insert(terminal_id.to_string());
        }
        return true;
    }

    false
}

/// Check if Claude Code is idle (at its prompt) by looking for ✳ (U+2733) prefix in terminal title.
pub fn is_claude_idle_from_buffer(buffer: Option<&TerminalOutputBuffer>) -> bool {
    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }
    if let Some(title) = osc::extract_last_terminal_title(&recent) {
        title.starts_with('\u{2733}')
    } else {
        false
    }
}

/// Check if a terminal is at a shell prompt by examining its output buffer.
pub fn is_terminal_at_prompt_from_buffer(buffer: Option<&TerminalOutputBuffer>) -> bool {
    let Some(buf) = buffer else {
        return true; // Unknown terminal → assume at prompt
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return true; // No output yet → assume at prompt
    }

    let last_c = osc::find_last_osc_133(&recent, b"C");
    let last_d = osc::find_last_osc_133(&recent, b"D");

    match (last_c, last_d) {
        (Some(c_pos), Some(d_pos)) => d_pos > c_pos,
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => true,
    }
}

/// Detect if a known interactive app is running based on the terminal title.
pub fn detect_interactive_app(data: &[u8]) -> Option<String> {
    let title = osc::extract_last_terminal_title(data)?;
    detect_interactive_app_from_title(&title)
}

/// Detect interactive app from an already-extracted title string.
/// Used by the PTY callback when the title is already available from OSC parsing.
///
/// Applies word-boundary matching to avoid false positives (e.g., "vim" should
/// not match "environment", "vi" should not match "Review"). Skips path-like
/// titles (containing `/` or `\`) that could false-positive on app names
/// embedded in directory names.
pub fn detect_interactive_app_from_title(title: &str) -> Option<String> {
    // Skip path-like titles (e.g. "//wsl.localhost/.../python_projects")
    if title.contains('/') || title.contains('\\') {
        return None;
    }

    for &(pattern, name) in INTERACTIVE_APP_PATTERNS {
        if is_word_match(title, pattern) {
            return Some(name.to_string());
        }
    }
    None
}

/// Check if `pattern` appears in `text` at a word boundary.
/// A word boundary is defined as: start/end of string, whitespace, `-`, or `:`.
fn is_word_match(text: &str, pattern: &str) -> bool {
    // Exact match
    if text == pattern {
        return true;
    }

    // Patterns ending with space (like "man ") use contains for prefix matching
    if pattern.ends_with(' ') {
        return text.contains(pattern);
    }

    let mut start = 0;
    while let Some(pos) = text[start..].find(pattern) {
        let abs_pos = start + pos;
        let end_pos = abs_pos + pattern.len();

        // Check left boundary: start of string or boundary char
        let left_ok = abs_pos == 0
            || text.as_bytes()[abs_pos - 1].is_ascii_whitespace()
            || matches!(text.as_bytes()[abs_pos - 1], b'-' | b':');

        // Check right boundary: end of string or boundary char
        let right_ok = end_pos == text.len()
            || text.as_bytes()[end_pos].is_ascii_whitespace()
            || matches!(text.as_bytes()[end_pos], b'-' | b':');

        if left_ok && right_ok {
            return true;
        }

        start = abs_pos + 1;
    }
    false
}

pub(crate) fn is_codex_spinner_title(title: &str) -> bool {
    let first = title.chars().next().unwrap_or_default() as u32;
    (0x2800..=0x28ff).contains(&first)
}

/// Detect the activity state of a terminal from its output buffer.
pub fn detect_terminal_activity(buffer: Option<&TerminalOutputBuffer>) -> TerminalActivity {
    let Some(buf) = buffer else {
        return TerminalActivity::Shell;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return TerminalActivity::Shell;
    }

    if let Some(name) = detect_interactive_app(&recent) {
        return TerminalActivity::InteractiveApp { name };
    }

    let at_prompt = is_terminal_at_prompt_from_buffer(Some(buf));
    if at_prompt {
        return TerminalActivity::Shell;
    }

    TerminalActivity::Running
}

/// Detect full terminal state (activity) for a single terminal.
pub fn detect_terminal_state(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> TerminalStateInfo {
    let activity = detect_terminal_activity(buffer);

    let Some(buf) = buffer else {
        return TerminalStateInfo { activity };
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return TerminalStateInfo { activity };
    }

    if osc::any_terminal_title_contains(&recent, "OpenAI Codex") {
        if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
            known.insert(terminal_id.to_string());
        }
    }

    if let Some(title) = osc::extract_last_terminal_title(&recent) {
        if detect_interactive_app_from_title(&title).is_some_and(|name| name == "Codex") {
            if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
                known.insert(terminal_id.to_string());
            }
            return TerminalStateInfo {
                activity: TerminalActivity::InteractiveApp {
                    name: "Codex".to_string(),
                },
            };
        }
        if is_codex_spinner_title(&title) {
            if let Ok(known) = state.known_codex_terminals.lock_or_err() {
                if known.contains(terminal_id) {
                    return TerminalStateInfo {
                        activity: TerminalActivity::InteractiveApp {
                            name: "Codex".to_string(),
                        },
                    };
                }
            }
        }
    }

    TerminalStateInfo { activity }
}

/// Detect terminal states for all terminals.
pub fn detect_all_terminal_states(
    state: &AppState,
) -> std::collections::HashMap<String, TerminalStateInfo> {
    let mut result = std::collections::HashMap::new();
    if let Ok(buffers) = state.output_buffers.lock_or_err() {
        if let Ok(terminals) = state.terminals.lock_or_err() {
            for id in terminals.keys() {
                let info = detect_terminal_state(state, id, buffers.get(id));
                result.insert(id.clone(), info);
            }
        }
    }
    result
}

// ── DEC 2026 Burst Detection ──

/// Bundled state for DEC 2026 burst detection in the PTY callback.
///
/// TUI apps (Claude Code, neovim) emit `\x1b[?2026h` (DEC Synchronized Output)
/// before each frame. Single events (focus redraw, keystroke echo) are filtered
/// by requiring `threshold` hits within `window`. Only then is an event emitted,
/// throttled to at most one per `throttle` interval.
///
/// Uses `Instant` (monotonic clock) instead of `SystemTime` to avoid NTP jumps
/// breaking the sliding window.
pub struct BurstDetector {
    window: std::time::Duration,
    threshold: u64,
    throttle: std::time::Duration,
    /// Sliding window state: (burst_start, burst_count, last_emit)
    /// Protected by Mutex because Instant is not Atomic-storable.
    inner: std::sync::Mutex<BurstDetectorInner>,
}

struct BurstDetectorInner {
    burst_start: Instant,
    burst_count: u64,
    last_emit: Instant,
}

impl BurstDetector {
    pub fn new(window_ms: u64, threshold: u64, throttle_ms: u64) -> Self {
        let now = Instant::now();
        Self {
            window: std::time::Duration::from_millis(window_ms),
            threshold,
            throttle: std::time::Duration::from_millis(throttle_ms),
            inner: std::sync::Mutex::new(BurstDetectorInner {
                burst_start: now,
                burst_count: 0,
                last_emit: now - std::time::Duration::from_millis(throttle_ms + 1),
            }),
        }
    }

    /// Record a DEC 2026h hit. Returns `true` if an event should be emitted
    /// (burst threshold reached + throttle interval elapsed).
    pub fn record_hit(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let now = Instant::now();

        // Sliding window: reset if window expired
        if now.duration_since(inner.burst_start) > self.window {
            inner.burst_start = now;
            inner.burst_count = 1;
        } else {
            inner.burst_count += 1;
        }

        if inner.burst_count >= self.threshold
            && now.duration_since(inner.last_emit) >= self.throttle
        {
            inner.last_emit = now;
            true
        } else {
            false
        }
    }
}

/// Bundled per-terminal state captured by the PTY callback closure.
/// Groups individual `Arc<Atomic*>` fields into a single `Arc<PtyCallbackState>`.
pub struct PtyCallbackState {
    pub claude_detected: AtomicBool,
    pub burst_detector: BurstDetector,
}

impl PtyCallbackState {
    pub fn new(burst_window_ms: u64, burst_threshold: u64, throttle_ms: u64) -> Self {
        Self {
            claude_detected: AtomicBool::new(false),
            burst_detector: BurstDetector::new(burst_window_ms, burst_threshold, throttle_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_activity_empty_buffer() {
        assert!(matches!(
            detect_terminal_activity(None),
            TerminalActivity::Shell
        ));
    }

    #[test]
    fn interactive_app_patterns_not_empty() {
        assert!(!INTERACTIVE_APP_PATTERNS.is_empty());
    }

    #[test]
    fn detect_interactive_app_claude() {
        let data = b"\x1b]0;Claude Code\x07";
        assert_eq!(detect_interactive_app(data), Some("Claude".to_string()));
    }

    #[test]
    fn detect_interactive_app_codex() {
        let data = b"\x1b]0;OpenAI Codex\x07";
        assert_eq!(detect_interactive_app(data), Some("Codex".to_string()));
    }

    #[test]
    fn detect_interactive_app_vim() {
        let data = b"\x1b]2;vim - main.rs\x07";
        assert_eq!(detect_interactive_app(data), Some("vim".to_string()));
    }

    #[test]
    fn detect_interactive_app_none() {
        let data = b"\x1b]0;bash\x07";
        assert_eq!(detect_interactive_app(data), None);
    }

    #[test]
    fn prompt_detection_no_markers() {
        assert!(is_terminal_at_prompt_from_buffer(None));
    }

    // ── detect_interactive_app_from_title word boundary tests ──

    #[test]
    fn title_word_boundary_vim_not_environment() {
        // "vim" should not match "environment"
        assert_eq!(detect_interactive_app_from_title("environment"), None);
    }

    #[test]
    fn title_word_boundary_vi_not_review() {
        // "vi" should not match "Review"
        assert_eq!(detect_interactive_app_from_title("Review"), None);
    }

    #[test]
    fn title_word_boundary_vim_at_start() {
        assert_eq!(
            detect_interactive_app_from_title("vim main.rs"),
            Some("vim".to_string())
        );
    }

    #[test]
    fn title_word_boundary_vim_after_dash() {
        assert_eq!(
            detect_interactive_app_from_title("term-vim"),
            Some("vim".to_string())
        );
    }

    #[test]
    fn title_exact_match() {
        assert_eq!(
            detect_interactive_app_from_title("htop"),
            Some("htop".to_string())
        );
    }

    #[test]
    fn title_path_like_skipped() {
        // Path-like titles should not match
        assert_eq!(
            detect_interactive_app_from_title("//wsl.localhost/home/user/python_projects"),
            None
        );
        assert_eq!(
            detect_interactive_app_from_title("C:\\Users\\test\\vim"),
            None
        );
    }

    #[test]
    fn title_nvim_detected() {
        assert_eq!(
            detect_interactive_app_from_title("nvim"),
            Some("neovim".to_string())
        );
    }

    #[test]
    fn title_claude_code_detected() {
        assert_eq!(
            detect_interactive_app_from_title("Claude Code"),
            Some("Claude".to_string())
        );
    }

    #[test]
    fn title_codex_detected() {
        assert_eq!(
            detect_interactive_app_from_title("OpenAI Codex"),
            Some("Codex".to_string())
        );
        assert_eq!(detect_interactive_app_from_title("codex"), None);
    }

    #[test]
    fn codex_spinner_title_preserved_after_explicit_detection() {
        let state = AppState::new();
        let mut explicit = TerminalOutputBuffer::default();
        explicit.push(b"\x1b]0;OpenAI Codex\x07");
        assert_eq!(
            detect_terminal_state(&state, "t1", Some(&explicit)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );

        let mut spinner = TerminalOutputBuffer::default();
        spinner.push("\x1b]0;\u{280b} laymux\x07".as_bytes());
        assert_eq!(
            detect_terminal_state(&state, "t1", Some(&spinner)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );
    }

    #[test]
    fn title_claude_with_prefix() {
        // ✳ Claude Code (idle indicator)
        assert_eq!(
            detect_interactive_app_from_title("\u{2733} Claude Code"),
            Some("Claude".to_string())
        );
    }

    #[test]
    fn title_man_page() {
        assert_eq!(
            detect_interactive_app_from_title("man git"),
            Some("man".to_string())
        );
    }

    #[test]
    fn title_vi_exact() {
        assert_eq!(
            detect_interactive_app_from_title("vi"),
            Some("vim".to_string())
        );
    }

    #[test]
    fn claude_removed_from_known_returns_false() {
        let state = AppState::new();
        let tid = "terminal-test";

        // Insert into known_claude_terminals
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert(tid.to_string());
        assert!(is_claude_terminal_from_buffer(&state, tid, None));

        // Remove (simulates Claude exit detection)
        state.known_claude_terminals.lock().unwrap().remove(tid);
        assert!(!is_claude_terminal_from_buffer(&state, tid, None));
    }

    // ── BurstDetector tests ──

    #[test]
    fn burst_below_threshold_does_not_emit() {
        let detector = BurstDetector::new(2000, 3, 1000);
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
        // 2 hits < threshold 3 → no emit
    }

    #[test]
    fn burst_at_threshold_emits() {
        let detector = BurstDetector::new(2000, 3, 1000);
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
        assert!(detector.record_hit()); // 3rd hit → emit
    }

    #[test]
    fn burst_throttle_prevents_rapid_emit() {
        let detector = BurstDetector::new(2000, 3, 1000);
        // First burst → emit
        for _ in 0..3 {
            detector.record_hit();
        }
        // Immediately after — still within throttle window
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
    }

    #[test]
    fn burst_window_expired_resets_count() {
        let detector = BurstDetector::new(0, 3, 0); // 0ms window → always expired
                                                    // Each hit resets the window, so count never accumulates past 1
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
    }

    #[test]
    fn burst_sustained_activity_emits_after_throttle() {
        // Short throttle for test
        let detector = BurstDetector::new(5000, 2, 0); // 0ms throttle
        assert!(!detector.record_hit());
        assert!(detector.record_hit()); // 2nd → emit
        assert!(detector.record_hit()); // still above threshold, 0ms throttle → emit again
    }
}
