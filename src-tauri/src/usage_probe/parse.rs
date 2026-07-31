//! Parse the rendered `/usage` screen.
//!
//! Input is a plain-text screen snapshot (the vt100 model already resolved
//! cursor motion and dropped SGR), so this module only does line scanning. It
//! deliberately avoids a regex dependency — the shapes are fixed enough that
//! hand-rolled scanning stays shorter than the patterns would be.
//!
//! Per [ADR-0102] reset text is captured verbatim and never interpreted.

use super::snapshot::{ProbeStatus, UsageLimit};

/// What one screen capture yielded.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedUsage {
    pub session: UsageLimit,
    pub week_all: UsageLimit,
    /// The per-model weekly row. Claude Code names it after whichever model the
    /// account is on (`Current week (Fable)`, `Current week (Sonnet only)`), so
    /// it is parsed generically rather than pinned to one model.
    pub week_model: UsageLimit,
    /// Model label from that row's header, e.g. `Fable`, `Sonnet only`.
    pub week_model_label: Option<String>,
    /// An error the `/usage` screen itself reported.
    pub upstream_error: Option<String>,
}

impl ParsedUsage {
    /// A parse counts as successful once any limit row yielded a percentage.
    /// A screen with only reset lines and no numbers is not usable data.
    pub fn is_success(&self) -> bool {
        self.session.percent.is_some()
            || self.week_all.percent.is_some()
            || self.week_model.percent.is_some()
    }

    /// Status implied by this parse. `Ready` only when numbers were found and
    /// the screen reported no error of its own.
    pub fn status(&self) -> ProbeStatus {
        if let Some(message) = &self.upstream_error {
            return ProbeStatus::UpstreamError {
                message: message.clone(),
            };
        }
        if self.is_success() {
            ProbeStatus::Ready
        } else {
            ProbeStatus::ParseFailed
        }
    }
}

/// Which limit row a header line introduces.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Section {
    Session,
    WeekAll,
    /// Per-model weekly row; carries the label inside the parentheses.
    WeekModel(String),
}

/// Classify a line as a limit-row header, if it is one.
///
/// The weekly rows are `Current week (all models)` and `Current week (<model>)`.
/// The second is matched by shape, not by model name: the observed label has been
/// both `Sonnet only` and `Fable`, and a name list goes stale.
fn classify(line: &str) -> Option<Section> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }
    let mentions_week = lower.contains("week");
    if lower.contains("current session") && !mentions_week {
        return Some(Section::Session);
    }
    if !lower.contains("current week") {
        return None;
    }
    let label = parenthesized(trimmed)?;
    if is_all_models(&label.to_ascii_lowercase()) {
        return Some(Section::WeekAll);
    }
    Some(Section::WeekModel(label.to_string()))
}

/// Text inside the first `(...)` pair, if any.
fn parenthesized(line: &str) -> Option<&str> {
    let open = line.find('(')?;
    let rest = &line[open + 1..];
    let close = rest.find(')')?;
    let inner = rest[..close].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner)
    }
}

/// `all models`, allowing any run of whitespace between the two words.
fn is_all_models(lower: &str) -> bool {
    let mut parts = lower.split_whitespace();
    parts.next() == Some("all") && parts.next() == Some("models") && parts.next().is_none()
}

/// First `N% used` in the line, as `N`. Values above 100 are rejected.
///
/// The `used` requirement matters: the panel prints unrelated percentages next to
/// the rows (`+50% weekly limits promo through Aug 19`), and one of those landing
/// in a usage row would be a silently wrong number.
fn extract_percent(line: &str) -> Option<u8> {
    if !line.to_ascii_lowercase().contains("used") {
        return None;
    }
    let bytes = line.as_bytes();
    for (idx, &b) in bytes.iter().enumerate() {
        if b != b'%' {
            continue;
        }
        let mut start = idx;
        while start > 0 && bytes[start - 1].is_ascii_digit() {
            start -= 1;
        }
        if start == idx {
            continue;
        }
        let digits = &line[start..idx];
        if let Ok(value) = digits.parse::<u32>() {
            if value <= 100 {
                return Some(value as u8);
            }
        }
    }
    None
}

/// Text following `Resets`, verbatim and trimmed at both ends.
fn extract_reset(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let at = lower.find("resets")?;
    let rest = line[at + "resets".len()..].trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

/// Scan a section's own lines: from its header up to (not including) the next
/// header, capped at a few lines. The cap keeps a missing next header from
/// letting one section swallow the whole screen.
const SECTION_SCAN_LINES: usize = 5;

fn scan_section(lines: &[&str], header_idx: usize) -> UsageLimit {
    let mut limit = UsageLimit::default();
    let end = (header_idx + SECTION_SCAN_LINES).min(lines.len());
    for (offset, line) in lines[header_idx..end].iter().enumerate() {
        if offset > 0 && classify(line).is_some() {
            break;
        }
        if limit.percent.is_none() {
            limit.percent = extract_percent(line);
        }
        if limit.reset.is_none() {
            limit.reset = extract_reset(line);
        }
    }
    limit
}

/// Detect an error the `/usage` screen reported.
fn find_upstream_error(lines: &[&str]) -> Option<String> {
    for line in lines {
        let trimmed = line.trim();
        if trimmed.contains("Error:") || trimmed.contains("Failed to load") {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Parse a rendered `/usage` screen.
pub fn parse_usage(screen: &str) -> ParsedUsage {
    let lines: Vec<&str> = screen.lines().collect();
    let mut parsed = ParsedUsage::default();

    let mut model_header_seen = false;
    for (idx, line) in lines.iter().enumerate() {
        let Some(section) = classify(line) else {
            continue;
        };
        let limit = scan_section(&lines, idx);
        let slot = match &section {
            Section::Session => &mut parsed.session,
            Section::WeekAll => &mut parsed.week_all,
            Section::WeekModel(label) => {
                model_header_seen = true;
                if parsed.week_model_label.is_none() {
                    parsed.week_model_label = Some(label.clone());
                }
                &mut parsed.week_model
            }
        };
        // First occurrence wins: the TUI can leave a stale duplicate header
        // above the live one, and the live block is rendered first.
        if slot.is_empty() {
            *slot = limit;
        }
    }

    // A 0% row draws no bar, so the number can be missing from the screen
    // entirely. Treat a present-but-numberless per-model header as 0 only when
    // the rest of the screen parsed — otherwise we would manufacture data out of
    // a failed capture.
    if parsed.week_model.percent.is_none()
        && model_header_seen
        && (parsed.session.percent.is_some() || parsed.week_all.percent.is_some())
    {
        parsed.week_model.percent = Some(0);
    }

    parsed.upstream_error = find_upstream_error(&lines);
    parsed
}

/// Model and plan from the welcome banner, e.g. `Opus 4.6 · Claude Max`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AccountInfo {
    pub model: Option<String>,
    pub plan: Option<String>,
}

/// Prefix every plan name shares.
const PLAN_PREFIX: &str = "Claude ";

/// Parse the `<Model> · Claude <Plan>` banner line.
///
/// The model half is taken verbatim rather than matched against a list of known
/// families: the lineup changes, and a whitelist silently drops the account
/// banner for anything new. The `Claude <plan>` half is the anchor that makes
/// the line identifiable.
///
/// Trailing qualifiers on the model (`Fable 5 with xhigh effort`) are stripped
/// so the display stays a model name.
pub fn parse_account_info(screen: &str) -> AccountInfo {
    for line in screen.lines() {
        let Some((left, right)) = line.split_once('·') else {
            continue;
        };
        // The plan half may be followed by more separators or trailing chrome;
        // keep only up to the next separator.
        let plan = right.split('·').next().unwrap_or(right).trim();
        if !plan.starts_with(PLAN_PREFIX) || plan.len() <= PLAN_PREFIX.len() {
            continue;
        }
        let model = strip_model_qualifier(strip_logo_prefix(left.trim()));
        if model.is_empty() {
            continue;
        }
        return AccountInfo {
            model: Some(model.to_string()),
            plan: Some(plan.to_string()),
        };
    }
    AccountInfo::default()
}

/// Drop the ASCII-art logo the banner draws on the same line as the model,
/// e.g. `▝▜█████▛▘  Fable 5` -> `Fable 5`. A model name starts alphanumeric, so
/// everything before the first such character is decoration.
fn strip_logo_prefix(model: &str) -> &str {
    model.trim_start_matches(|c: char| !c.is_alphanumeric())
}

/// Drop a ` with ...` qualifier, e.g. `Fable 5 with xhigh effort` -> `Fable 5`.
fn strip_model_qualifier(model: &str) -> &str {
    match model.find(" with ") {
        Some(at) => model[..at].trim_end(),
        None => model,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape of the `/usage` tab as Claude Code renders it.
    const USAGE_SCREEN: &str = "\
 Settings   Status   Config   Usage

 Current session
 ████████████████                                 30% used
 Resets 10pm (Asia/Seoul)

 Current week (all models)
 █████▌                                            11% used
 Resets Mar 6, 11:59am (Asia/Seoul)

 Current week (Sonnet only)
                                                    0% used

 Esc to exit
";

    #[test]
    fn parses_all_three_rows() {
        let parsed = parse_usage(USAGE_SCREEN);
        assert_eq!(parsed.session.percent, Some(30));
        assert_eq!(parsed.session.reset.as_deref(), Some("10pm (Asia/Seoul)"));
        assert_eq!(parsed.week_all.percent, Some(11));
        assert_eq!(
            parsed.week_all.reset.as_deref(),
            Some("Mar 6, 11:59am (Asia/Seoul)")
        );
        assert_eq!(parsed.week_model.percent, Some(0));
        assert_eq!(parsed.week_model.reset, None);
        assert_eq!(parsed.week_model_label.as_deref(), Some("Sonnet only"));
        assert!(parsed.is_success());
        assert_eq!(parsed.status(), ProbeStatus::Ready);
    }

    /// Real capture from Claude Code v2.1.220 — the per-model row is named after
    /// the account's model, and an unrelated `+50%` promo line sits inside the
    /// weekly block.
    #[test]
    fn parses_the_real_usage_panel() {
        let screen = "\
  Settings  Status   Config   Usage   Stats

  Session

  Total cost:            $0.0000
  Usage:                 0 input, 0 output, 0 cache read, 0 cache write

  Current session
  ████████████                                       24% used
  Resets 6:30pm (Asia/Seoul)

  Current week (all models)
  ███                                                6% used
  Resets Aug 7, 11:59am (Asia/Seoul)
  +50% weekly limits promo through Aug 19 · clau.de/cc-50-promo

  Current week (Fable)
  ███▌                                               7% used
  Resets Aug 7, 12pm (Asia/Seoul)

  Esc to cancel
";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.session.percent, Some(24));
        assert_eq!(parsed.session.reset.as_deref(), Some("6:30pm (Asia/Seoul)"));
        assert_eq!(parsed.week_all.percent, Some(6));
        assert_eq!(
            parsed.week_all.reset.as_deref(),
            Some("Aug 7, 11:59am (Asia/Seoul)")
        );
        assert_eq!(parsed.week_model.percent, Some(7));
        assert_eq!(
            parsed.week_model.reset.as_deref(),
            Some("Aug 7, 12pm (Asia/Seoul)")
        );
        assert_eq!(parsed.week_model_label.as_deref(), Some("Fable"));
    }

    #[test]
    fn promo_percentage_is_not_mistaken_for_usage() {
        // The promo line has no "used", which is what keeps it out of the row.
        let screen = "\
 Current week (all models)
 Resets Aug 7, 11:59am (Asia/Seoul)
 +50% weekly limits promo through Aug 19
";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.week_all.percent, None);
        assert!(!parsed.is_success());
    }

    #[test]
    fn session_row_does_not_absorb_next_sections_number() {
        // Without a header boundary the 5-line window would reach the weekly row.
        let screen = "\
 Current session
 30% used
 Current week (all models)
 77% used
";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.session.percent, Some(30));
        assert_eq!(parsed.week_all.percent, Some(77));
    }

    #[test]
    fn banner_line_is_not_read_as_a_limit_row() {
        let screen = "\
 Sonnet 4 · Claude Pro
 Current session
 5% used
";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.session.percent, Some(5));
        // The banner names a model but is not a weekly row, and the 0% fallback
        // must not fire off it either.
        assert_eq!(parsed.week_model.percent, None);
        assert_eq!(parsed.week_model_label, None);
    }

    #[test]
    fn zero_percent_per_model_row_needs_a_real_header() {
        let screen = " Current session\n 5% used\n";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.week_model.percent, None);
    }

    #[test]
    fn zero_percent_fallback_does_not_fire_on_a_failed_capture() {
        // Header present but nothing else parsed — reporting 0% here would
        // dress up a broken capture as real data.
        let screen = " Current week (Sonnet only)\n\n";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.week_model.percent, None);
        assert!(!parsed.is_success());
        assert_eq!(parsed.status(), ProbeStatus::ParseFailed);
    }

    #[test]
    fn weekly_header_without_parentheses_is_not_a_row() {
        // `Current week` alone gives no way to tell all-models from per-model.
        assert_eq!(classify(" Current week"), None);
        assert_eq!(classify(" Current week ()"), None);
    }

    #[test]
    fn all_models_label_is_matched_exactly() {
        assert_eq!(
            classify(" Current week (all models)"),
            Some(Section::WeekAll)
        );
        assert_eq!(
            classify(" Current week (all models plus)"),
            Some(Section::WeekModel("all models plus".into()))
        );
    }

    #[test]
    fn empty_screen_fails_to_parse() {
        let parsed = parse_usage("");
        assert!(!parsed.is_success());
        assert_eq!(parsed.status(), ProbeStatus::ParseFailed);
    }

    #[test]
    fn upstream_error_wins_over_parsed_numbers() {
        let screen = "\
 Current session
 30% used
 Error: failed to fetch usage
";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.session.percent, Some(30));
        assert_eq!(
            parsed.status(),
            ProbeStatus::UpstreamError {
                message: "Error: failed to fetch usage".into()
            }
        );
    }

    #[test]
    fn percent_above_hundred_is_rejected() {
        assert_eq!(extract_percent(" 250% used"), None);
        assert_eq!(extract_percent(" 100% used"), Some(100));
        assert_eq!(extract_percent(" no number here"), None);
    }

    #[test]
    fn reset_text_is_verbatim() {
        assert_eq!(
            extract_reset("  Resets   Mar 6, 11:59am (Asia/Seoul)  "),
            Some("Mar 6, 11:59am (Asia/Seoul)".to_string())
        );
        assert_eq!(extract_reset("  Resets  "), None);
        assert_eq!(extract_reset("nothing"), None);
    }

    #[test]
    fn all_models_tolerates_extra_whitespace() {
        assert_eq!(
            classify(" Current week (all   models)"),
            Some(Section::WeekAll)
        );
        // Not the all-models row, so it falls through to the per-model row
        // rather than being dropped — an unrecognized label is still a row.
        assert_eq!(
            classify(" Current week (allmodels)"),
            Some(Section::WeekModel("allmodels".into()))
        );
    }

    #[test]
    fn duplicate_stale_header_does_not_overwrite_live_block() {
        let screen = "\
 Current session
 30% used
 Resets 10pm (Asia/Seoul)
 Current session
 99% used
";
        let parsed = parse_usage(screen);
        assert_eq!(parsed.session.percent, Some(30));
    }

    #[test]
    fn parses_account_banner() {
        let info = parse_account_info(" ✻ Welcome\n Opus 4.6 · Claude Max\n");
        assert_eq!(info.model.as_deref(), Some("Opus 4.6"));
        assert_eq!(info.plan.as_deref(), Some("Claude Max"));
    }

    /// Real capture from Claude Code v2.1.220. The startup box has no "Welcome"
    /// line and the model is none of Opus/Sonnet/Haiku — both assumptions that a
    /// model-name whitelist broke on in practice.
    #[test]
    fn parses_the_real_startup_banner() {
        let screen = "\
 ▐▛███▜▌   Claude Code v2.1.220
▝▜█████▛▘  Fable 5 with xhigh effort · Claude Team
  ▘▘ ▝▝    ~/python_projects
";
        let info = parse_account_info(screen);
        assert_eq!(info.model.as_deref(), Some("Fable 5"));
        assert_eq!(info.plan.as_deref(), Some("Claude Team"));
    }

    #[test]
    fn account_banner_needs_a_plan_half() {
        assert_eq!(
            parse_account_info(" Opus 4.6 · /home/me/.claude\n"),
            AccountInfo::default()
        );
        assert_eq!(
            parse_account_info(" Opus 4.6 · Claude \n"),
            AccountInfo::default()
        );
        assert_eq!(
            parse_account_info(" no separator here\n"),
            AccountInfo::default()
        );
    }

    #[test]
    fn account_banner_accepts_an_unknown_model_name() {
        // The reason the whitelist is gone: a model laymux has never heard of
        // must still surface.
        let info = parse_account_info(" Newthing 9 · Claude Max\n");
        assert_eq!(info.model.as_deref(), Some("Newthing 9"));
    }

    #[test]
    fn account_banner_stops_at_trailing_separator() {
        let info = parse_account_info(" Sonnet 4 · Claude Pro · /home/me/.claude\n");
        assert_eq!(info.plan.as_deref(), Some("Claude Pro"));
    }
}
