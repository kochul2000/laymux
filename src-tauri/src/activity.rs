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

/// Known interactive apps detected from terminal title (OSC 0 / OSC 2).
pub const INTERACTIVE_APP_PATTERNS: &[(&str, &str)] = &[
    ("Claude Code", "Claude Code"),
    ("vim", "vim"),
    ("nvim", "neovim"),
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
    for &(pattern, name) in INTERACTIVE_APP_PATTERNS {
        if title.contains(pattern) {
            return Some(name.to_string());
        }
    }
    None
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

/// Detect full terminal state (activity + output freshness) for a single terminal.
pub fn detect_terminal_state(buffer: Option<&TerminalOutputBuffer>) -> TerminalStateInfo {
    let activity = detect_terminal_activity(buffer);
    let (output_active, last_output_ms_ago) = if let Some(buf) = buffer {
        if let Some(ts) = buf.last_output_at {
            let elapsed = ts.elapsed().as_millis() as u64;
            (elapsed < 2000, elapsed)
        } else {
            (false, u64::MAX)
        }
    } else {
        (false, u64::MAX)
    };

    TerminalStateInfo {
        activity,
        output_active,
        last_output_ms_ago,
    }
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
        assert_eq!(
            detect_interactive_app(data),
            Some("Claude Code".to_string())
        );
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
}
