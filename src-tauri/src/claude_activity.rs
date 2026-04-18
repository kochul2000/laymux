//! Claude Code terminal activity detection.
//!
//! Isolated module for Claude Code-specific title state tracking.
//! Handles entry/exit detection, working→idle task completion,
//! and spinner prefix recognition for Claude Code's terminal titles.
//!
//! This module has no side effects — it only analyzes title strings and
//! returns structured results. The caller (PTY callback) is responsible
//! for updating persistent state and dispatching events.

/// Idle indicator prefix (✳ U+2733). Separated from working spinners
/// so the two sets can be composed without duplication.
const IDLE_PREFIX: char = '✳';

/// Star-based working spinner prefixes (excludes IDLE_PREFIX).
const WORKING_STAR_SPINNERS: &[char] = &['✶', '✻', '✽', '✢'];

/// All star-based spinner prefixes (working + idle).
/// Used by `is_claude_title` and `strip_claude_spinner_prefix`.
const CLAUDE_SPINNER_PREFIXES: &[char] = &[
    WORKING_STAR_SPINNERS[0],
    WORKING_STAR_SPINNERS[1],
    WORKING_STAR_SPINNERS[2],
    WORKING_STAR_SPINNERS[3],
    IDLE_PREFIX,
];

/// Check if a terminal title looks like a Claude Code title.
/// Returns true if the title contains "Claude Code" or starts with a known
/// Claude spinner prefix (star-based or Braille pattern U+2800..U+28FF).
pub fn is_claude_title(title: &str) -> bool {
    title.contains("Claude Code")
        || title.starts_with(|c: char| {
            CLAUDE_SPINNER_PREFIXES.contains(&c) || ('\u{2800}'..='\u{28FF}').contains(&c)
        })
}

/// Check if a Claude Code title indicates idle state (✳ U+2733 prefix).
/// Claude Code sets this prefix when waiting for user input.
pub fn is_claude_idle_title(title: &str) -> bool {
    title.starts_with(IDLE_PREFIX)
}

/// Strip the spinner prefix character (star-based or Braille) from a Claude Code title.
/// Returns the text after the spinner character, trimmed.
/// If no spinner prefix is found, returns the full title trimmed.
pub fn strip_claude_spinner_prefix(title: &str) -> &str {
    let mut chars = title.chars();
    if let Some(first) = chars.next() {
        if CLAUDE_SPINNER_PREFIXES.contains(&first) || ('\u{2800}'..='\u{28FF}').contains(&first) {
            return chars.as_str().trim();
        }
    }
    title.trim()
}

/// Check if a Claude Code title indicates active/working state.
/// Working spinners: star-based (✶✻✽✢) or Braille patterns (U+2800..U+28FF).
/// Excludes ✳ (IDLE_PREFIX) — that's the idle indicator, not a working spinner.
pub fn is_claude_working_title(title: &str) -> bool {
    title.starts_with(|c: char| {
        WORKING_STAR_SPINNERS.contains(&c) || ('\u{2800}'..='\u{28FF}').contains(&c)
    })
}

/// Result of processing a Claude Code title change in the PTY callback.
/// Consolidates all Claude-specific title handling into a single pass.
#[derive(Debug, Default, PartialEq)]
pub struct ClaudeTitleResult {
    /// Claude Code was just detected (first "Claude Code" title).
    pub entered: bool,
    /// Claude Code just exited (title no longer matches Claude patterns).
    pub exited: bool,
    /// A task just completed (working spinner → idle ✳ transition).
    /// Contains the task description extracted from the idle title.
    pub task_completed: Option<String>,
    /// Whether the terminal is now in working state (for tracking).
    pub now_working: bool,
    /// Whether the terminal is now in idle state (for tracking).
    pub now_idle: bool,
}

/// Process an OSC 0/2 title change for Claude Code state tracking.
///
/// Given the current state (`was_detected`, `was_working`, and the last
/// observed working spinner title `prev_working_title`) plus the new title,
/// determines what transitions occurred. The caller is responsible for
/// updating persistent state (`claude_detected`, `known_claude_terminals`,
/// `session.claude_was_working`, `session.claude_last_working_title`) based
/// on the returned result.
///
/// `prev_working_title` is used as a fallback task description when the new
/// idle title is generic (e.g. `✳ Claude Code` with no task text). Claude
/// frequently returns to the generic idle title on completion, so without
/// the fallback most working→idle notifications would show a placeholder
/// instead of the actual task name.
pub fn process_claude_title(
    title: &str,
    was_detected: bool,
    was_working: bool,
    prev_working_title: Option<&str>,
) -> ClaudeTitleResult {
    let mut result = ClaudeTitleResult::default();
    let is_claude = is_claude_title(title);

    // Entry detection: first time seeing "Claude Code" in title
    if !was_detected && title.contains("Claude Code") {
        result.entered = true;
    }

    // Exit detection: was detected but title no longer matches any Claude pattern
    if was_detected && !is_claude {
        result.exited = true;
        return result; // No further processing on exit
    }

    // Working/idle state tracking (only when Claude is active)
    let detected = was_detected || result.entered;
    if detected {
        result.now_idle = is_claude_idle_title(title);
        result.now_working = is_claude_working_title(title);

        // Task completion: working → idle transition
        if was_working && result.now_idle {
            let idle_description = title.trim_start_matches(IDLE_PREFIX).trim();
            let text = if !idle_description.is_empty() && idle_description != "Claude Code" {
                idle_description.to_string()
            } else {
                // Fallback to the preceding working title's task text.
                let prev_description = prev_working_title
                    .map(strip_claude_spinner_prefix)
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != "Claude Code");
                match prev_description {
                    Some(desc) => desc.to_string(),
                    None => "Claude Code task completed".to_string(),
                }
            };
            result.task_completed = Some(text);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_claude_title ──

    #[test]
    fn claude_title_with_text() {
        assert!(is_claude_title("Claude Code"));
        assert!(is_claude_title("✳ Claude Code"));
        assert!(is_claude_title("✢ Claude Code"));
    }

    #[test]
    fn claude_title_star_spinners() {
        assert!(is_claude_title("✶ Working on task"));
        assert!(is_claude_title("✻ Analyzing code"));
        assert!(is_claude_title("✽ Building"));
        assert!(is_claude_title("✢ Running tests"));
        assert!(is_claude_title("✳ General coding session"));
    }

    #[test]
    fn claude_title_braille_spinners() {
        assert!(is_claude_title("\u{2802} Claude Code"));
        assert!(is_claude_title(
            "\u{2810} General coding assistance session"
        ));
        assert!(is_claude_title("\u{280B} Working on task"));
        assert!(is_claude_title("\u{2819} Analyzing"));
        assert!(is_claude_title("\u{2839} Building"));
    }

    #[test]
    fn claude_title_rejects_non_claude() {
        assert!(!is_claude_title("bash"));
        assert!(!is_claude_title("vim main.rs"));
        assert!(!is_claude_title("/home/user/project"));
        assert!(!is_claude_title("C:\\Users\\test"));
    }

    // ── is_claude_idle_title / is_claude_working_title ──

    #[test]
    fn idle_title_detected() {
        assert!(is_claude_idle_title("\u{2733} Claude Code"));
        assert!(is_claude_idle_title("\u{2733} General coding session"));
    }

    #[test]
    fn idle_title_rejects_working() {
        assert!(!is_claude_idle_title("\u{2722} Working..."));
        assert!(!is_claude_idle_title("\u{2810} Task..."));
        assert!(!is_claude_idle_title("Claude Code"));
        assert!(!is_claude_idle_title("bash"));
    }

    #[test]
    fn working_title_star_spinners() {
        assert!(is_claude_working_title("\u{2736} Working"));
        assert!(is_claude_working_title("\u{273B} Analyzing"));
        assert!(is_claude_working_title("\u{273D} Building"));
        assert!(is_claude_working_title("\u{2722} Running"));
    }

    #[test]
    fn working_title_braille_spinners() {
        assert!(is_claude_working_title("\u{2802} Processing"));
        assert!(is_claude_working_title("\u{2810} Task"));
        assert!(is_claude_working_title("\u{280B} Working"));
    }

    #[test]
    fn working_title_rejects_idle_and_other() {
        assert!(!is_claude_working_title("\u{2733} Claude Code"));
        assert!(!is_claude_working_title("Claude Code"));
        assert!(!is_claude_working_title("bash"));
    }

    // ── process_claude_title ──

    #[test]
    fn process_entry_on_first_claude_title() {
        let r = process_claude_title("Claude Code", false, false, None);
        assert!(r.entered);
        assert!(!r.exited);
        assert!(r.task_completed.is_none());
    }

    #[test]
    fn process_no_entry_when_already_detected() {
        let r = process_claude_title("Claude Code", true, false, None);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_exit_on_non_claude_title() {
        let r = process_claude_title("bash", true, false, None);
        assert!(!r.entered);
        assert!(r.exited);
    }

    #[test]
    fn process_no_exit_on_spinner_title() {
        let r = process_claude_title("\u{2810} Working...", true, false, None);
        assert!(!r.exited);
        assert!(r.now_working);
        assert!(!r.now_idle);
    }

    #[test]
    fn process_task_completed_on_working_to_idle() {
        let r = process_claude_title("\u{2733} Fix the bug", true, true, None);
        assert!(!r.exited);
        assert!(r.now_idle);
        assert!(!r.now_working);
        assert_eq!(r.task_completed, Some("Fix the bug".to_string()));
    }

    #[test]
    fn process_no_completion_on_idle_without_prior_working() {
        // First idle after entry (no working phase) — not a task completion
        let r = process_claude_title("\u{2733} Claude Code", true, false, None);
        assert!(r.now_idle);
        assert!(r.task_completed.is_none());
    }

    #[test]
    fn process_completion_with_default_message() {
        let r = process_claude_title("\u{2733} Claude Code", true, true, None);
        assert_eq!(
            r.task_completed,
            Some("Claude Code task completed".to_string())
        );
    }

    #[test]
    fn process_working_to_working_no_completion() {
        let r = process_claude_title("\u{2810} New task", true, true, None);
        assert!(r.now_working);
        assert!(!r.now_idle);
        assert!(r.task_completed.is_none());
    }

    #[test]
    fn process_entry_then_idle_no_completion() {
        // Claude just started and immediately shows idle — no working phase
        let r = process_claude_title("\u{2733} Claude Code", false, false, None);
        assert!(r.entered);
        assert!(r.now_idle);
        assert!(r.task_completed.is_none());
    }

    #[test]
    fn process_completion_falls_back_to_prev_working_title() {
        // Common real-world case: Claude returns to the generic idle title after
        // finishing a task. Without the fallback the notification would read
        // "Claude Code task completed" even though the preceding working title
        // carried the actual task description.
        let r = process_claude_title(
            "\u{2733} Claude Code",
            true,
            true,
            Some("\u{2736} Refactor auth middleware"),
        );
        assert_eq!(
            r.task_completed,
            Some("Refactor auth middleware".to_string())
        );
    }

    #[test]
    fn process_completion_prefers_new_idle_title_when_specific() {
        // If the new idle title already has task text, do not substitute.
        let r = process_claude_title(
            "\u{2733} Apply review feedback",
            true,
            true,
            Some("\u{2736} Old task"),
        );
        assert_eq!(r.task_completed, Some("Apply review feedback".to_string()));
    }

    #[test]
    fn process_completion_default_when_both_titles_generic() {
        // Fallback to the hard-coded default if neither the new idle title nor
        // the previous working title has a usable description.
        let r = process_claude_title(
            "\u{2733} Claude Code",
            true,
            true,
            Some("\u{2736} Claude Code"),
        );
        assert_eq!(
            r.task_completed,
            Some("Claude Code task completed".to_string())
        );
    }

    // ── strip_claude_spinner_prefix ──

    #[test]
    fn strip_star_spinner() {
        assert_eq!(
            strip_claude_spinner_prefix("\u{2736} Working on task"),
            "Working on task"
        );
    }

    #[test]
    fn strip_braille_spinner() {
        assert_eq!(
            strip_claude_spinner_prefix("\u{2810} General coding assistance session"),
            "General coding assistance session"
        );
    }

    #[test]
    fn strip_idle_prefix() {
        assert_eq!(
            strip_claude_spinner_prefix("\u{2733} Claude Code"),
            "Claude Code"
        );
    }

    #[test]
    fn strip_no_prefix() {
        assert_eq!(strip_claude_spinner_prefix("Claude Code"), "Claude Code");
    }

    #[test]
    fn strip_empty_after_spinner() {
        assert_eq!(strip_claude_spinner_prefix("\u{2736}"), "");
    }
}
