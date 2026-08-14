//! Closed row-key parse for a Grok `/usage` screen dump.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsageRow {
    pub key: String,
    pub percent: Option<f64>,
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
    let mut rows = Vec::new();
    for line in screen.lines() {
        let Some((key, rest)) = match_row(line) else {
            continue;
        };
        if rows.iter().any(|row: &GrokUsageRow| row.key == key) {
            continue;
        }
        rows.push(GrokUsageRow {
            key: key.to_string(),
            percent: parse_percent(rest),
            reset: parse_reset(screen),
        });
    }
    rows
}

fn match_row(line: &str) -> Option<(&'static str, &str)> {
    for (label, key) in ROW_KEYS {
        if let Some(idx) = line.find(label) {
            return Some((*key, line[idx + label.len()..].trim()));
        }
    }
    None
}

fn parse_percent(rest: &str) -> Option<f64> {
    if let Some(percent_at) = rest.find('%') {
        let before = rest[..percent_at].trim();
        let number = before
            .rsplit(|c: char| !(c.is_ascii_digit() || c == '.'))
            .find(|part| !part.is_empty())?;
        return number.parse().ok();
    }
    parse_used_of_limit(rest)
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
Monthly limit: 10%
Next reset: Mon 9am
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
        assert_eq!(rows[3].percent, Some(15.0));
        assert_eq!(rows[0].reset.as_deref(), Some("Mon 9am"));
    }

    #[test]
    fn parse_ignores_unknown_and_duplicate_labels() {
        let screen = "Weekly limit: 1%\nWeekly limit: 2%\nMystery: 9%\n";
        let rows = parse_grok_usage_screen(screen);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].percent, Some(1.0));
    }
}
