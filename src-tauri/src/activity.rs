//! Terminal activity state detection.
//!
//! Detects whether a terminal is at a shell prompt, running a command,
//! or running an interactive application (Claude Code, vim, etc.).

use crate::constants::ACTIVITY_SCAN_BYTES;
use crate::lock_ext::MutexExt;
use crate::osc;
use crate::output_buffer::TerminalOutputBuffer;
use crate::state::AppState;
use crate::terminal::{TerminalActivity, TerminalStateInfo};

/// Star-based spinner prefixes used by Claude Code in terminal titles.
const CLAUDE_SPINNER_PREFIXES: &[char] = &['✶', '✻', '✽', '✢', '✳'];

/// Check if a terminal title looks like a Claude Code title.
/// Returns true if the title contains "Claude Code" or starts with a known
/// Claude spinner prefix (star-based or Braille pattern U+2800..U+28FF).
pub fn is_claude_title(title: &str) -> bool {
    title.contains("Claude Code")
        || title.starts_with(|c: char| {
            CLAUDE_SPINNER_PREFIXES.contains(&c) || ('\u{2800}'..='\u{28FF}').contains(&c)
        })
}

/// Known interactive apps detected from terminal title (OSC 0 / OSC 2).
/// Pattern matching uses word boundaries to avoid false positives
/// (e.g., "vim" should not match "environment").
pub const INTERACTIVE_APP_PATTERNS: &[(&str, &str)] = &[
    ("Claude Code", "Claude"),
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
pub fn detect_terminal_state(buffer: Option<&TerminalOutputBuffer>) -> TerminalStateInfo {
    let activity = detect_terminal_activity(buffer);
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
                let info = detect_terminal_state(buffers.get(id));
                result.insert(id.clone(), info);
            }
        }
    }
    result
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

    // ── is_claude_title tests ──

    #[test]
    fn claude_title_with_claude_code_text() {
        assert!(is_claude_title("Claude Code"));
        assert!(is_claude_title("✳ Claude Code"));
        assert!(is_claude_title("✢ Claude Code"));
    }

    #[test]
    fn claude_title_star_spinner_without_claude_code() {
        // Star spinner prefixes should still be recognized
        assert!(is_claude_title("✶ Working on task"));
        assert!(is_claude_title("✻ Analyzing code"));
        assert!(is_claude_title("✽ Building"));
        assert!(is_claude_title("✢ Running tests"));
        assert!(is_claude_title("✳ General coding session"));
    }

    #[test]
    fn claude_title_braille_spinner() {
        // Claude Code v2.1+ uses Braille pattern spinners
        assert!(is_claude_title("\u{2802} Claude Code")); // ⠂
        assert!(is_claude_title("\u{2810} General coding assistance session")); // ⠐
        assert!(is_claude_title("\u{280B} Working on task")); // ⠋
        assert!(is_claude_title("\u{2819} Analyzing")); // ⠙
        assert!(is_claude_title("\u{2839} Building")); // ⠹
    }

    #[test]
    fn claude_title_not_claude() {
        assert!(!is_claude_title("bash"));
        assert!(!is_claude_title("vim main.rs"));
        assert!(!is_claude_title("/home/user/project"));
        assert!(!is_claude_title("C:\\Users\\test"));
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
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .remove(tid);
        assert!(!is_claude_terminal_from_buffer(&state, tid, None));
    }
}
