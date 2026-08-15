//! Closed row-key parse for a Grok `/usage` screen dump.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsageRow {
    pub key: String,
    pub percent: Option<f64>,
    pub remaining: Option<f64>,
    pub reset: Option<String>,
}

const ROW_KEYS: &[(&str, &str)] = &[
    ("Weekly limit", "weekly"),
    ("Monthly limit", "monthly"),
    ("Credits", "credits"),
    ("Pay-as-you-go", "payg"),
    ("Pay as you go", "payg"),
];

/// Parse a `/usage` screen dump into the closed row-key set.
pub fn parse_grok_usage_screen(screen: &str) -> Vec<GrokUsageRow> {
    let lines: Vec<&str> = screen.lines().collect();
    let mut rows = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let hits = match_rows(line);
        for (key, rest) in &hits {
            if rows.iter().any(|row: &GrokUsageRow| row.key == *key) {
                continue;
            }
            let value = if hits.len() == 1 {
                let mut combined = rest.to_string();
                let following = following_value_text(&lines, i + 1);
                if !following.is_empty() {
                    if !combined.is_empty() {
                        combined.push(' ');
                    }
                    combined.push_str(&following);
                }
                combined
            } else {
                rest.to_string()
            };
            let percent = parse_percent(&value);
            let remaining = parse_remaining(&value);
            if percent.is_none() && remaining.is_none() {
                continue;
            }
            rows.push(GrokUsageRow {
                key: (*key).to_string(),
                percent,
                remaining,
                reset: parse_reset(&value),
            });
        }
    }
    rows
}

fn following_value_text(lines: &[&str], start: usize) -> String {
    let mut parts = Vec::new();
    for line in &lines[start..] {
        if line.trim().is_empty() {
            continue;
        }
        if !match_rows(line).is_empty() {
            break;
        }
        parts.push(line.trim());
    }
    parts.join(" ")
}

fn match_rows(line: &str) -> Vec<(&'static str, &str)> {
    let mut hits: Vec<(usize, usize, &'static str)> = Vec::new();
    for (label, key) in ROW_KEYS {
        if let Some(idx) = line.find(label) {
            hits.push((idx, label.len(), *key));
        }
    }
    hits.sort_by_key(|(idx, _, _)| *idx);
    hits.dedup_by_key(|(_, _, key)| *key);
    hits.iter()
        .enumerate()
        .map(|(i, (idx, label_len, key))| {
            let start = idx + label_len;
            let end = hits
                .get(i + 1)
                .map(|(next, _, _)| *next)
                .unwrap_or(line.len());
            (*key, line.get(start..end).unwrap_or("").trim())
        })
        .collect()
}

fn parse_percent(rest: &str) -> Option<f64> {
    if let Some(percent_at) = rest.find('%') {
        let before = rest[..percent_at].trim();
        let number = before
            .rsplit(|c: char| !(c.is_ascii_digit() || c == '.'))
            .find(|part| !part.is_empty())?;
        return number.parse().ok();
    }
    parse_used_of_limit(rest).or_else(|| parse_slash_amounts(rest))
}

/// `Usage: $3.00 / $20.00 per month` has no `used of` wording.
fn parse_slash_amounts(rest: &str) -> Option<f64> {
    let slash = rest.find('/')?;
    let used = parse_leading_amount(&rest[..slash])?;
    let limit = parse_leading_amount(&rest[slash + 1..])?;
    if limit <= 0.0 {
        return None;
    }
    Some(((used / limit) * 100.0).clamp(0.0, 100.0))
}

/// `$3 used of $20 limit` has no `%`; the used/limit ratio is the fill.
fn parse_used_of_limit(rest: &str) -> Option<f64> {
    let lower = rest.to_ascii_lowercase();
    let used_at = lower.find("used")?;
    let of_at = lower[used_at..].find("of").map(|idx| used_at + idx)?;
    let used = parse_leading_amount(&rest[..used_at])?;
    let limit = parse_leading_amount(&rest[of_at + 2..])?;
    if limit <= 0.0 {
        return None;
    }
    Some(((used / limit) * 100.0).clamp(0.0, 100.0))
}

fn parse_remaining(rest: &str) -> Option<f64> {
    let lower = rest.to_ascii_lowercase();
    if lower.contains("left") || lower.contains("remaining") {
        return parse_leading_amount(rest);
    }
    if lower.contains("used") || parse_slash_amounts(rest).is_some() {
        return None;
    }
    if rest.contains('$') {
        return parse_leading_amount(rest);
    }
    None
}

fn parse_leading_amount(text: &str) -> Option<f64> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let tail = &text[start..];
    let end = tail
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(tail.len());
    tail[..end].parse().ok()
}

fn parse_reset(screen: &str) -> Option<String> {
    for prefix in ["Next reset:", "Resets:"] {
        if let Some(idx) = screen.find(prefix) {
            let rest = screen[idx + prefix.len()..].lines().next()?.trim();
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_weekly_monthly_credits_and_payg_ratio() {
        let screen = "\
Usage
Weekly limit: 42%
Next reset: Mon 9am
Monthly limit: 10%
Credits: 12 left
Pay-as-you-go: $3 used of $20 limit
";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(
            rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            ["weekly", "monthly", "credits", "payg"]
        );
        assert_eq!(rows[0].percent, Some(42.0));
        assert_eq!(rows[1].percent, Some(10.0));
        assert_eq!(rows[2].percent, None);
        assert_eq!(rows[2].remaining, Some(12.0));
        assert_eq!(rows[3].percent, Some(15.0));
        assert_eq!(rows[0].reset.as_deref(), Some("Mon 9am"));
    }

    #[test]
    fn parse_credits_remaining_wording() {
        let rows = parse_grok_usage_screen("Credits remaining: 12\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "credits");
        assert_eq!(rows[0].percent, None);
        assert_eq!(rows[0].remaining, Some(12.0));
    }

    #[test]
    fn parse_credits_dollar_amount() {
        let rows = parse_grok_usage_screen("Credits: $12\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "credits");
        assert_eq!(rows[0].percent, None);
        assert_eq!(rows[0].remaining, Some(12.0));
    }

    #[test]
    fn parse_collects_every_bucket_on_one_wrapped_line() {
        let screen =
            "Weekly limit: 42% Monthly limit: 10% Credits: $12 Pay-as-you-go: $3 used of $20 limit";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(
            rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            ["weekly", "monthly", "credits", "payg"]
        );
        assert_eq!(rows[0].percent, Some(42.0));
        assert_eq!(rows[1].percent, Some(10.0));
        assert_eq!(rows[2].remaining, Some(12.0));
        assert_eq!(rows[3].percent, Some(15.0));
    }

    #[test]
    fn parse_ignores_unknown_and_duplicate_labels() {
        let screen = "Weekly limit: 1%\nWeekly limit: 2%\nMystery: 9%\n";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].percent, Some(1.0));
    }

    #[test]
    fn parse_pairs_adjacent_value_lines_from_usage_modal() {
        // grok-build usage_modal.rs allowance_lines: header, blank, bar+%,
        // Resets, Credits $x.xx, Pay as you go + Usage $used / $cap.
        let screen = "\
Weekly limit (SuperGrok)

███████████████░░░░░░░░░░░░░░░  50%
Resets: May 29, 00:00

Credits: $12.34

Pay as you go: Enabled
Usage: $3.00 / $20.00 per month
";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(
            rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            ["weekly", "credits", "payg"]
        );
        assert_eq!(rows[0].percent, Some(50.0));
        assert_eq!(rows[0].reset.as_deref(), Some("May 29, 00:00"));
        assert_eq!(rows[1].percent, None);
        assert_eq!(rows[1].remaining, Some(12.34));
        assert_eq!(rows[2].percent, Some(15.0));
        assert_eq!(rows[2].remaining, None);
        assert_eq!(rows[1].reset, None);
        assert_eq!(rows[2].reset, None);
    }

    #[test]
    fn parse_drops_label_only_rows() {
        let rows = parse_grok_usage_screen(
            "Weekly limit (SuperGrok)\n\nCredits\nPay as you go: Enabled\n",
        );
        assert!(rows.is_empty());
    }

    #[test]
    fn parse_reset_stays_on_its_own_bucket() {
        let screen = "\
Weekly limit (SuperGrok)

███████████████░░░░░░░░░░░░░░░  50%
Resets: May 29, 00:00

Monthly limit

░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  10%
Resets: Jun 1, 00:00

Credits: $12.34
";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(
            rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
            ["weekly", "monthly", "credits"]
        );
        assert_eq!(rows[0].reset.as_deref(), Some("May 29, 00:00"));
        assert_eq!(rows[1].reset.as_deref(), Some("Jun 1, 00:00"));
        assert_eq!(rows[2].reset, None);
    }

    #[test]
    fn parse_pairs_monthly_header_with_following_percent_bar() {
        let screen = "\
Monthly limit

░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  10%
Resets: Jun 1, 00:00
";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "monthly");
        assert_eq!(rows[0].percent, Some(10.0));
        assert_eq!(rows[0].reset.as_deref(), Some("Jun 1, 00:00"));
    }
}
