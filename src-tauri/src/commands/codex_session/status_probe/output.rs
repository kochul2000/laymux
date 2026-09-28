pub(super) fn parse_status_session(bytes: &[u8]) -> Option<String> {
    // Codex can paint a complete card using cursor-addressed rows with no LF.
    // Preserve those boundaries before stripping styling; joining every row
    // makes even the command echo and Session field impossible to recognize.
    let mut rows = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset] == 0x1b && offset + 1 < bytes.len() {
            let (end, final_byte) = crate::claude_bullet::skip_ansi_escape(bytes, offset);
            if matches!(
                final_byte,
                Some(b'H' | b'f' | b'A' | b'B' | b'E' | b'F' | b'd')
            ) {
                rows.push(b'\n');
            }
            offset = end;
        } else {
            rows.push(bytes[offset]);
            offset += 1;
        }
    }
    let text = String::from_utf8_lossy(&rows);
    let mut command_seen = false;
    let mut top_seen = false;
    let mut card_seen = false;
    let mut closed = false;
    let mut ids = Vec::new();
    for line in text.lines().map(str::trim) {
        if line == "/status" {
            command_seen = true;
        }
        if command_seen && line.starts_with('╭') {
            top_seen = true;
        }
        // A differential repaint may retain the left border cell and emit only
        // the header text at column 4. Still require a newly emitted card top.
        if top_seen
            && line
                .trim_start_matches('│')
                .trim_start()
                .starts_with(">_ OpenAI Codex")
        {
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
    fn reads_cursor_addressed_status_rows_without_literal_newlines() {
        // Codex 0.157.1 paints these rows with CUP instead of CRLF in a real WSL PTY.
        let output = format!("\x1b[20;1H/status\x1b[21;1H╭────╮\x1b[22;1H│ >_ OpenAI Codex (v0.157.1) │\x1b[23;1H│ Session: \x1b[1m{ID}\x1b[0m │\x1b[24;1H╰────╯");
        assert_eq!(parse_status_session(output.as_bytes()), Some(ID.to_owned()));
        // Repeated or partial repaint evidence must still fail closed.
        assert_eq!(
            parse_status_session(format!("{output}{output}").as_bytes()),
            None
        );
    }

    #[test]
    fn reads_a_new_card_with_a_differentially_painted_header() {
        let output = format!("\x1b[20;1H/status\x1b[21;1H╭────╮\x1b[22;4H>_ OpenAI Codex\x1b[22;20H(v0.157.1)\x1b[23;1H│ Session: {ID} │\x1b[24;1H╰────╯");
        assert_eq!(parse_status_session(output.as_bytes()), Some(ID.to_owned()));
        assert_eq!(
            parse_status_session(output.replace("╭────╮", "").as_bytes()),
            None
        );
    }

    #[test]
    fn reads_captured_native_and_wsl_repeated_status_responses() {
        for bytes in [
            include_bytes!("fixtures/native-status-repaint.ansi").as_slice(),
            include_bytes!("fixtures/wsl-status-repaint.ansi").as_slice(),
        ] {
            assert_eq!(parse_status_session(bytes), Some(ID.to_owned()));
        }
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
