//! Codex (OpenAI Codex CLI) terminal activity detection.
//!
//! Mirror of `claude_activity` for Codex sessions, intentionally simpler:
//! Codex does not expose a working/idle distinction in its title (it cycles
//! a Braille spinner during work and reverts to "OpenAI Codex" at idle), so
//! the state machine only tracks entry and exit.
//!
//! Like `claude_activity`, this module has no side effects — it analyzes
//! title strings and returns structured results. The PTY callback owns
//! `known_codex_terminals` mutation, grace-window cleanup, and event
//! emission based on what `process_codex_title` reports.

/// Returns `true` when `title` looks like a Codex session title:
/// either the literal "OpenAI Codex" banner or a Braille spinner frame
/// (U+2800..U+28FF) which Codex emits during work.
///
/// Notes
/// - Braille spinners are *not* exclusive to Codex (Claude Code uses the
///   same range). Entry detection therefore requires the literal
///   "OpenAI Codex" — see `process_codex_title`. The spinner-tolerant
///   `is_codex_title` is only used to decide *exit*: a Braille frame
///   right after a confirmed Codex session means we're still inside
///   Codex, not in a shell.
/// - We do not strip the spinner first: Codex prefixes the spinner with
///   a Braille char and the rest is short status text, never the
///   "OpenAI Codex" literal — so a substring check on the raw title is
///   sufficient and avoids surprising matches against unrelated apps
///   that happen to start with a Braille char.
pub fn is_codex_title(title: &str) -> bool {
    if title.contains("OpenAI Codex") {
        return true;
    }
    title
        .chars()
        .next()
        .is_some_and(|c| ('\u{2800}'..='\u{28FF}').contains(&c))
}

/// Result of processing an OSC 0/2 title change against Codex state.
#[derive(Debug, Default, PartialEq)]
pub struct CodexTitleResult {
    /// Codex was just detected (first "OpenAI Codex" title since the
    /// session was last unknown). Used to populate
    /// `known_codex_terminals` and emit the detection event.
    pub entered: bool,
    /// Codex just exited (was previously detected, current title is
    /// neither "OpenAI Codex" nor a Braille spinner frame). Used to
    /// remove the ID from `known_codex_terminals` and clear the grace
    /// window so the shell fallback engages immediately.
    pub exited: bool,
}

/// Process an OSC 0/2 title change for Codex state tracking.
///
/// `was_detected` is the persistent flag the caller maintains
/// (`PtyCallbackState::codex_detected` || `known_codex_terminals` lookup).
/// The contract mirrors `process_claude_title`:
///
/// - `entered` fires only when the title literally contains
///   "OpenAI Codex" — Braille spinners alone are too ambiguous (the same
///   range is used by Claude Code, fzf, etc.) to seed a fresh detection.
/// - `exited` fires when the previous state was detected but the new
///   title belongs to neither "OpenAI Codex" nor any Braille frame, i.e.
///   we have observably returned to a shell (or other) prompt.
pub fn process_codex_title(title: &str, was_detected: bool) -> CodexTitleResult {
    let mut result = CodexTitleResult::default();

    if !was_detected && title.contains("OpenAI Codex") {
        result.entered = true;
        return result;
    }

    if was_detected && !is_codex_title(title) {
        result.exited = true;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_codex_title ──

    #[test]
    fn codex_title_literal_banner() {
        assert!(is_codex_title("OpenAI Codex"));
        assert!(is_codex_title("OpenAI Codex - some-project"));
    }

    #[test]
    fn codex_title_braille_spinner_frames() {
        assert!(is_codex_title("\u{2800} working"));
        assert!(is_codex_title("\u{2802} thinking"));
        assert!(is_codex_title("\u{280B}"));
        assert!(is_codex_title("\u{28FF}"));
    }

    #[test]
    fn codex_title_rejects_shell_prompts_and_paths() {
        assert!(!is_codex_title("bash"));
        assert!(!is_codex_title("PS C:\\Users\\me"));
        assert!(!is_codex_title("~/projects/laymux"));
        assert!(!is_codex_title(""));
    }

    // ── process_codex_title — entry ──

    #[test]
    fn process_entry_on_first_codex_title() {
        let r = process_codex_title("OpenAI Codex", false);
        assert!(r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_no_entry_when_already_detected() {
        let r = process_codex_title("OpenAI Codex", true);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_no_entry_on_braille_only_title() {
        // Braille frames are too ambiguous to seed detection — Claude
        // Code uses the same range. Caller must observe a literal
        // "OpenAI Codex" first.
        let r = process_codex_title("\u{2802} working", false);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    // ── process_codex_title — exit (regression for P1 #1) ──

    #[test]
    fn process_exit_on_shell_prompt_after_codex() {
        // Without this transition there is no path that removes a Codex
        // ID from `known_codex_terminals`. The cache then pins the pane
        // as InteractiveApp{Codex} indefinitely, blocking sync-cwd —
        // mirror of the `cr.exited` regression noted on PR 242.
        let r = process_codex_title("PS C:\\Users\\me", true);
        assert!(!r.entered);
        assert!(r.exited);
    }

    #[test]
    fn process_exit_on_path_like_title_after_codex() {
        let r = process_codex_title("~/projects/laymux", true);
        assert!(r.exited);
    }

    #[test]
    fn process_exit_on_empty_title_after_codex() {
        let r = process_codex_title("", true);
        assert!(r.exited);
    }

    #[test]
    fn process_no_exit_on_braille_frame_during_codex() {
        // Codex's spinner replaces the literal banner mid-session. That
        // is not an exit — the session is still alive.
        let r = process_codex_title("\u{2802} working", true);
        assert!(!r.entered);
        assert!(!r.exited);
    }

    #[test]
    fn process_no_exit_when_banner_persists() {
        let r = process_codex_title("OpenAI Codex", true);
        assert!(!r.exited);
    }
}
