pub(super) fn parse_status_session(bytes: &[u8]) -> Option<String> {
    let text = crate::claude_bullet::strip_ansi(&String::from_utf8_lossy(bytes));
    let mut command_seen = false;
    let mut card_seen = false;
    let mut closed = false;
    let mut ids = Vec::new();
    for line in text.lines().map(str::trim) {
        if line == "/status" {
            command_seen = true;
        }
        if command_seen && line.starts_with('│') && line.contains("OpenAI Codex") {
            card_seen = true;
        }
        if !card_seen {
            continue;
        }
        if let Some(value) = line
            .strip_prefix('│')
            .and_then(|s| s.trim().strip_prefix("Session:"))
        {
            let candidate = value.trim().strip_suffix('│')?.trim();
            let parsed = uuid::Uuid::parse_str(candidate).ok()?;
            if parsed.hyphenated().to_string() != candidate.to_ascii_lowercase() {
                return None;
            }
            ids.push(candidate.to_owned());
        }
        if line.starts_with('╰') {
            closed = true;
        }
    }
    (closed && ids.len() == 1).then(|| ids.remove(0))
}

#[cfg(test)]
mod tests {
    use super::parse_status_session;

    const ID: &str = "01a0e103-7bcb-7a20-89c0-2dc0472f2957";

    #[test]
    fn reads_only_a_new_status_card_with_a_complete_id() {
        let output = format!("/status\r\n╭────╮\r\n│ >_ OpenAI Codex (v0.157.1) │\r\n│ Session: \x1b[1m{ID}\x1b[0m │\r\n╰────╯");
        assert_eq!(parse_status_session(output.as_bytes()), Some(ID.to_owned()));
    }

    #[test]
    fn rejects_echo_partial_cards_truncated_ids_and_ambiguous_repaints() {
        for output in [
            format!("│ Session: {ID} │"),
            format!("› /status\r\nSession: {ID}"),
            format!("/status\r\nOpenAI Codex\r\nSession: {ID}"),
            "/status\r\n│ >_ OpenAI Codex │\r\n│ Session: 01a0e103-7bcb-7a20-89c0-2dc0472f │\r\n╰────╯".into(),
            format!("/status\r\n│ >_ OpenAI Codex │\r\n│ Session: {ID} │\r\n│ Session: 01a0e103-7bcb-7a20-89c0-2dc0472f2958 │\r\n╰────╯"),
        ] {
            assert_eq!(parse_status_session(output.as_bytes()), None);
        }
    }
}
