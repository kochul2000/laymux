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
    /// True when the terminal is in an active Claude session (detected before
    /// this call, or just entered) AND the incoming title still belongs to
    /// Claude. The caller must refresh persistent state (`claude_was_working`,
    /// `claude_last_working_title`) whenever this is true, even if neither
    /// `now_working` nor `now_idle` is set — e.g. plain "Claude Code" titles
    /// that appear between spinner and idle transitions. Without that refresh
    /// a stale `claude_was_working = true` leaks into the next ✳ title and
    /// fires a spurious "task completed" notification.
    pub in_claude_session: bool,
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
///
/// ## `was_detected` contract
///
/// `entered` fires only when the title literally contains `"Claude Code"`
/// (intentionally strict — a bare `✶` or Braille spinner also matches
/// unrelated TUI apps). For command-text detection (e.g. the frontend
/// observing `claude` via OSC 133;E and calling `mark_claude_terminal`),
/// the caller MUST resolve `was_detected=true` before the first title
/// arrives — see `resolve_claude_detected` in `commands/terminal.rs`.
/// Once `was_detected=true` the spinner-only path works correctly:
/// `detected = was_detected || entered = true`, the working/idle block
/// runs, and the subsequent ✳ idle emits the expected completion. The
/// regression guards `process_spinner_only_with_was_detected_enters_session`
/// and `process_working_plain_idle_sequence_no_spurious_completion` lock
/// this behavior in.
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
        result.in_claude_session = true;
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

    // ── in_claude_session (regression guard) ──
    // Without in_claude_session, the PTY callback skips state updates for
    // plain "Claude Code" titles (neither spinner nor ✳ prefix) because the
    // original guard was `exited || now_working || now_idle`. The result was
    // a stuck `claude_was_working = true`, which then made the next ✳ idle
    // title emit a spurious "task completed" notification.

    #[test]
    fn process_plain_claude_title_marks_in_claude_session() {
        let r = process_claude_title("Claude Code", true, true, Some("\u{2736} Old task"));
        assert!(!r.exited);
        assert!(!r.now_working);
        assert!(!r.now_idle);
        assert!(
            r.in_claude_session,
            "plain Claude Code title must signal caller to refresh state"
        );
        assert!(r.task_completed.is_none());
    }

    #[test]
    fn process_working_title_sets_in_claude_session() {
        let r = process_claude_title("\u{2736} Fix bug", true, false, None);
        assert!(r.in_claude_session);
        assert!(r.now_working);
    }

    #[test]
    fn process_idle_title_sets_in_claude_session() {
        let r = process_claude_title("\u{2733} Claude Code", true, false, None);
        assert!(r.in_claude_session);
        assert!(r.now_idle);
    }

    #[test]
    fn process_entry_sets_in_claude_session() {
        let r = process_claude_title("Claude Code", false, false, None);
        assert!(r.entered);
        assert!(r.in_claude_session);
    }

    #[test]
    fn process_exit_clears_in_claude_session() {
        let r = process_claude_title("bash", true, true, None);
        assert!(r.exited);
        assert!(
            !r.in_claude_session,
            "exit must clear in_claude_session so caller runs exit branch"
        );
    }

    #[test]
    fn process_non_claude_without_prior_detection_is_not_in_session() {
        let r = process_claude_title("vim main.rs", false, false, None);
        assert!(!r.in_claude_session);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_spinner_only_title_without_prior_detection_is_not_in_session() {
        // Spinner-only titles (e.g. "✶ Task") without prior detection do not
        // enter the state machine. Command-text detection via
        // `mark_claude_terminal` is the path that surfaces this case in
        // production; see the PTY-callback-side `resolve_claude_detected`
        // helper for the fallback that rescues it.
        let r = process_claude_title("\u{2736} Task", false, false, None);
        assert!(!r.in_claude_session);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_spinner_only_with_was_detected_enters_session() {
        // Simulates the post-`resolve_claude_detected` path for a command-
        // detected session whose very first title is a spinner-only title
        // (e.g. "✶ Task" / Braille "⠋ Working"). `was_detected=true` was
        // already synced from `known_claude_terminals`, so this call must
        // register working state even though the title does not contain
        // "Claude Code" literally. Without this path, a command-detected
        // session would silently skip working tracking and miss the later
        // working→idle completion notification.
        let r = process_claude_title("\u{2736} Task", true, false, None);
        assert!(
            r.in_claude_session,
            "command-detected session's first spinner title must enter session tracking"
        );
        assert!(r.now_working);
        assert!(!r.now_idle);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_braille_spinner_with_was_detected_enters_session() {
        // Braille variant of the previous test — Claude Code uses Braille
        // patterns for its spinner animation.
        let r = process_claude_title("\u{280B} Working", true, false, None);
        assert!(r.in_claude_session);
        assert!(r.now_working);
    }

    #[test]
    fn process_working_plain_idle_sequence_no_spurious_completion() {
        // End-to-end regression guard for the "working → plain → idle"
        // sequence. Simulates what the PTY callback does: after each call,
        // it writes `claude_was_working = cr.now_working` and clears
        // `claude_last_working_title` when the current title is not
        // working. If Bug #1's fix regressed, step 2 would leave
        // was_working stuck at true, and step 3 would emit a false
        // "task completed" notification.

        // Step 1: working spinner
        let r1 = process_claude_title("\u{2736} Fix bug", true, false, None);
        assert!(r1.now_working);
        assert!(r1.in_claude_session);
        // Simulated caller state after step 1:
        let was_working_after_1 = r1.now_working; // true
        let prev_title_after_1 = if r1.now_working {
            Some("\u{2736} Fix bug".to_string())
        } else {
            None
        };

        // Step 2: plain "Claude Code" (no spinner, no ✳)
        let r2 = process_claude_title(
            "Claude Code",
            true,
            was_working_after_1,
            prev_title_after_1.as_deref(),
        );
        assert!(
            r2.in_claude_session,
            "plain title must signal state refresh so was_working resets"
        );
        assert!(!r2.now_working);
        assert!(!r2.now_idle);
        assert!(r2.task_completed.is_none());
        // Simulated caller state after step 2:
        let was_working_after_2 = r2.now_working; // false — reset!
        let prev_title_after_2: Option<String> = if r2.now_working {
            Some("Claude Code".to_string())
        } else {
            None // cleared because plain isn't a working title
        };

        // Step 3: idle ✳
        let r3 = process_claude_title(
            "\u{2733} Claude Code",
            true,
            was_working_after_2,
            prev_title_after_2.as_deref(),
        );
        assert!(r3.now_idle);
        assert!(
            r3.task_completed.is_none(),
            "step 2 reset was_working, so the idle transition must NOT emit a completion"
        );
    }

    #[test]
    fn process_working_to_idle_direct_still_fires_completion() {
        // Sanity counter-test: without a plain title in the middle, the
        // normal working→idle path still produces a completion. This
        // guards against over-aggressive fixes that would suppress valid
        // completions alongside spurious ones.
        let r1 = process_claude_title("\u{2736} Fix bug", true, false, None);
        assert!(r1.now_working);

        let r2 = process_claude_title(
            "\u{2733} Claude Code",
            true,
            r1.now_working,
            Some("\u{2736} Fix bug"),
        );
        assert!(r2.now_idle);
        assert_eq!(
            r2.task_completed,
            Some("Fix bug".to_string()),
            "direct working→idle must still emit the completion"
        );
    }
}
