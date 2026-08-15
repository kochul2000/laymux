//! Grok Build terminal activity detection.
//!
//! Title shapes observed on grok 1.0.3 (Windows grok.exe, ADR-0156):
//! - welcome / idle pager: exact `grok`
//! - session: `<status> - <title>… - grok`
//! - working: `<braille> - Running: <tool> - <title>… - grok`
//!
//! `"Grok Build"` is a buffer/banner literal, not a live OSC title.
//! The welcome title `grok` cannot seed detection and is not an exit
//! signal for an already-detected session. Process-tree liveness still
//! owns whether the pane stays classified as Grok (ADR-0009).

const GROK_SUFFIX: &str = " - grok";
const GROK_BANNER: &str = "Grok Build";
const RUNNING_MARKER: &str = "- Running:";
const BRAILLE_SPINNERS: std::ops::RangeInclusive<char> = '\u{2800}'..='\u{28FF}';

fn is_braille_prefix(title: &str) -> bool {
    title
        .chars()
        .next()
        .is_some_and(|c| BRAILLE_SPINNERS.contains(&c))
}

fn title_eq_ignore_ascii_case(title: &str, expected: &str) -> bool {
    title.trim().eq_ignore_ascii_case(expected)
}

/// Whether `title` ends with ` - grok`, ignoring ASCII case on the suffix.
pub fn title_has_grok_suffix(title: &str) -> bool {
    title.trim_end().to_ascii_lowercase().ends_with(GROK_SUFFIX)
}

/// A live OSC title that still belongs to Grok (exit disambiguator).
///
/// Exact `grok` is *not* included: it is the welcome screen and is
/// indistinguishable from a user-set title. Callers must not treat it
/// as exit either — see `process_grok_title`.
pub fn is_grok_title(title: &str) -> bool {
    title.contains(GROK_BANNER) || title_has_grok_suffix(title)
}

/// Titles that cannot seed detection but must not evict an existing cache.
///
/// Exact `grok` is the welcome/idle pager. A Braille prefix without
/// ` - grok` is a working frame whose suffix has been clipped. Neither
/// is an exit once the pane is already known as Grok (ADR-0156).
pub fn is_grok_preserve_title(title: &str) -> bool {
    title_eq_ignore_ascii_case(title, "grok") || is_braille_prefix(title)
}

/// Working frame: confirmed Grok title with a Braille prefix or `- Running:`.
pub fn is_grok_working_title(title: &str) -> bool {
    is_grok_title(title) && (is_braille_prefix(title) || title.contains(RUNNING_MARKER))
}

/// Strip spinner, `- Running:`, and ` - grok` suffix. Empty remainder is `None`.
pub fn extract_grok_status_text(title: &str) -> Option<String> {
    let mut rest = title.trim_end();
    if let Some(first) = rest.chars().next() {
        if BRAILLE_SPINNERS.contains(&first) {
            rest = rest[first.len_utf8()..].trim_start();
        }
    }
    if let Some(stripped) = rest.strip_prefix(RUNNING_MARKER) {
        rest = stripped.trim_start();
    }
    if title_has_grok_suffix(rest) {
        rest = rest[..rest.len() - GROK_SUFFIX.len()].trim_end();
    }
    rest = rest.trim();
    if rest.is_empty() || title_eq_ignore_ascii_case(rest, "grok") {
        None
    } else {
        Some(rest.to_string())
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct GrokTitleResult {
    pub entered: bool,
    pub exited: bool,
    pub now_working: bool,
}

/// Process an OSC 0/2 title change against Grok state.
///
/// Entry requires ` - grok` or `"Grok Build"`. Exact `grok` never enters
/// and never exits. Braille-only titles (no suffix) never enter.
pub fn process_grok_title(title: &str, was_detected: bool) -> GrokTitleResult {
    let mut result = GrokTitleResult::default();

    if !was_detected && is_grok_title(title) {
        result.entered = true;
        result.now_working = is_grok_working_title(title);
        return result;
    }

    if was_detected {
        if is_grok_title(title) {
            result.now_working = is_grok_working_title(title);
        } else if is_braille_prefix(title) {
            // Working spinner without the suffix is not an exit (ADR-0156).
            result.now_working = true;
        } else if !title_eq_ignore_ascii_case(title, "grok") {
            result.exited = true;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_matches_session_and_working_titles() {
        assert!(title_has_grok_suffix(
            "Add Grok Support Like Claude Codex Featu… - grok"
        ));
        assert!(title_has_grok_suffix(
            "\u{280B} - Running: laymux__list_terminals - Add Grok Support… - grok"
        ));
        assert!(title_has_grok_suffix("idle title - GROK"));
        assert!(!title_has_grok_suffix("grok"));
        assert!(!title_has_grok_suffix("grok-build"));
        assert!(!title_has_grok_suffix("laymux"));
        assert!(title_has_grok_suffix("한글 제목 - grok"));
    }

    #[test]
    fn process_stays_on_braille_only_after_detection() {
        let r = process_grok_title("\u{280B} working", true);
        assert!(!r.exited);
        assert!(r.now_working);
    }

    #[test]
    fn is_grok_title_accepts_suffix_and_banner() {
        assert!(is_grok_title("session - grok"));
        assert!(is_grok_title("Grok Build"));
        assert!(is_grok_title("Welcome to Grok Build v1"));
        assert!(!is_grok_title("grok"));
        assert!(!is_grok_title("\u{280B} laymux"));
        assert!(!is_grok_title(""));
    }

    #[test]
    fn working_requires_grok_title_and_running_or_braille() {
        assert!(is_grok_working_title(
            "\u{280B} - Running: tool - title - grok"
        ));
        assert!(is_grok_working_title("- Running: tool - title - grok"));
        assert!(!is_grok_working_title("title - grok"));
        assert!(!is_grok_working_title("\u{280B} laymux"));
    }

    #[test]
    fn extract_keeps_tool_and_session_title() {
        assert_eq!(
            extract_grok_status_text(
                "\u{280B} - Running: laymux__list_terminals - Add Grok Support - grok"
            )
            .as_deref(),
            Some("laymux__list_terminals - Add Grok Support")
        );
        assert_eq!(
            extract_grok_status_text("Add Grok Support - grok").as_deref(),
            Some("Add Grok Support")
        );
        assert_eq!(extract_grok_status_text("grok"), None);
        assert_eq!(extract_grok_status_text(" - grok"), None);
    }

    #[test]
    fn process_enters_on_suffix_or_banner() {
        let r = process_grok_title("session - grok", false);
        assert!(r.entered);
        assert!(!r.exited);
        assert!(!r.now_working);

        let r = process_grok_title("Grok Build", false);
        assert!(r.entered);

        let r = process_grok_title("\u{280B} - Running: tool - title - grok", false);
        assert!(r.entered);
        assert!(r.now_working);
    }

    #[test]
    fn process_no_entry_on_welcome_or_braille_only() {
        let r = process_grok_title("grok", false);
        assert!(!r.entered);
        assert!(!r.exited);

        let r = process_grok_title("\u{280B} working", false);
        assert!(!r.entered);
    }

    #[test]
    fn process_welcome_title_is_not_exit() {
        let r = process_grok_title("grok", true);
        assert!(!r.entered);
        assert!(!r.exited);
        assert!(!r.now_working);
    }

    #[test]
    fn process_exits_on_shell_prompt() {
        let r = process_grok_title("PS C:\\Users\\me", true);
        assert!(r.exited);
        let r = process_grok_title("laymux", true);
        assert!(r.exited);
        let r = process_grok_title("", true);
        assert!(r.exited);
    }

    #[test]
    fn process_stays_on_session_and_working_titles() {
        let r = process_grok_title("title - grok", true);
        assert!(!r.exited);
        assert!(!r.now_working);
        let r = process_grok_title("\u{280B} - Running: t - title - grok", true);
        assert!(!r.exited);
        assert!(r.now_working);
    }

    #[test]
    fn preserve_title_is_welcome_or_braille_prefix() {
        assert!(is_grok_preserve_title("grok"));
        assert!(is_grok_preserve_title("GROK"));
        assert!(is_grok_preserve_title("  grok  "));
        assert!(is_grok_preserve_title("\u{280B} working"));
        assert!(!is_grok_preserve_title("session - grok"));
        assert!(!is_grok_preserve_title("PS C:\\Users\\me"));
        assert!(!is_grok_preserve_title(""));
    }
}
