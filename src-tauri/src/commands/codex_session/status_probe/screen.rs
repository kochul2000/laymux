use crate::terminal_output::{TerminalRenderCheckpoint, TerminalRenderCheckpointTarget};

const MAX_SCREEN_BYTES: usize = 256 * 1024;
const MAX_SCREEN_CELLS: usize = 256 * 1024;

pub(super) fn is_current_screen(
    screen: &TerminalRenderCheckpoint,
    current: &TerminalRenderCheckpointTarget,
    generation: u64,
    submitted_at: u64,
) -> Result<bool, String> {
    if screen.generation != generation || current.generation != generation {
        return Err("Codex status screen generation changed".into());
    }
    if screen.geometry != current.geometry {
        return Err("Codex status screen geometry changed".into());
    }
    if screen.seq > current.seq {
        return Err("Codex status screen is ahead of terminal output".into());
    }
    if screen.data.len() > MAX_SCREEN_BYTES
        || usize::from(screen.geometry.cols) * usize::from(screen.geometry.rows) > MAX_SCREEN_CELLS
        || screen.geometry.cols == 0
        || screen.geometry.rows == 0
    {
        return Err("Codex status screen exceeds supported bounds".into());
    }
    // Do not accept the selected-command screen or a renderer still catching up.
    Ok(screen.seq > submitted_at && screen.seq == current.seq)
}

pub(super) fn parse_status_screen(checkpoint: &TerminalRenderCheckpoint) -> Option<String> {
    let mut parser = vt100::Parser::new(checkpoint.geometry.rows, checkpoint.geometry.cols, 0);
    parser.process(checkpoint.data.as_bytes());
    let screen = parser.screen();
    // Codex runs in the alternate buffer. Read whichever buffer is active in
    // the xterm checkpoint, never the underlying shell/normal-buffer history.
    let contents = screen.contents();
    let raw_lines: Vec<_> = contents.lines().collect();
    let lines: Vec<_> = raw_lines.iter().map(|line| line.trim()).collect();
    let prompt = lines.iter().rposition(|line| line.starts_with('›'))?;
    let composer = lines[prompt].strip_prefix('›')?.trim();
    if composer.starts_with('/')
        || lines[prompt..].iter().any(|line| {
            let lower = line.to_ascii_lowercase();
            lower.contains("esc to interrupt")
                || lower.contains("reconnecting")
                || lower.contains("task is still running")
                || lower.contains("esc cancel")
                || lower.contains("esc back")
                || lower.contains("vim:")
        })
    {
        return None;
    }
    // Only the last command/card immediately above the current composer is a
    // candidate. An incomplete new card must never fall back to a previous ID.
    let echo = lines[..prompt]
        .iter()
        .rposition(|line| *line == "/status")?;
    let card: Vec<_> = lines[echo + 1..prompt]
        .iter()
        .copied()
        .filter(|line| !line.is_empty())
        .collect();
    if card.first()?.starts_with(">_ OpenAI Codex (v") {
        let raw_card: Vec<_> = raw_lines[echo + 1..prompt]
            .iter()
            .copied()
            .filter(|line| !line.trim().is_empty())
            .collect();
        return parse_borderless_card(&raw_card);
    }
    if !card.first()?.starts_with('╭') {
        return None;
    }
    let end = card.iter().position(|line| line.starts_with('╰'))?;
    if !card
        .get(1)?
        .strip_prefix('│')?
        .trim()
        .starts_with(">_ OpenAI Codex")
    {
        return None;
    }
    // Codex may show a one-line tip between the card and composer; other
    // messages/modals mean this is not the completed response being awaited.
    if card[end + 1..].iter().any(|line| !line.starts_with("Tip:")) {
        return None;
    }
    let mut id = None;
    for line in &card[1..end] {
        let inner = line.strip_prefix('│')?.strip_suffix('│')?.trim();
        if let Some(value) = inner.strip_prefix("Session:") {
            let candidate = value.trim();
            let parsed = uuid::Uuid::parse_str(candidate).ok()?;
            if id.is_some() || parsed.hyphenated().to_string() != candidate.to_ascii_lowercase() {
                return None;
            }
            id = Some(candidate.to_owned());
        }
    }
    id
}

/// Only the session field identifies a conversation. Optional status fields
/// may be added, removed, reordered or wrapped without invalidating that ID.
fn parse_borderless_card(card: &[&str]) -> Option<String> {
    if !card.first()?.trim().ends_with(')') {
        return None;
    }
    let indent = card.first()?.len() - card.first()?.trim_start().len();
    let mut session: Option<(String, usize)> = None;
    let mut has_field = false;
    let mut last_was_session = false;
    for raw in &card[1..] {
        let line = raw.trim();
        if line.starts_with("Visit https://chatgpt.com/codex/settings/usage ")
            || line == "information on rate limits and credits"
            || line.starts_with("Tip:")
        {
            has_field = false;
            last_was_session = false;
            continue;
        }
        if line.starts_with(['•', '›', '╭', '╰']) || line.starts_with(">_ OpenAI Codex") {
            return None;
        }
        let leading = raw.len() - raw.trim_start().len();
        if leading == indent {
            let (key, value) = line.split_once(':')?;
            if key.trim().is_empty() {
                return None;
            }
            last_was_session =
                key.eq_ignore_ascii_case("Session") || key.eq_ignore_ascii_case("Session ID");
            if last_was_session {
                if session.is_some() || value.trim().is_empty() {
                    return None;
                }
                let column = raw.len() - raw.split_once(':')?.1.trim_start().len();
                session = Some((value.trim().to_owned(), column));
            }
            has_field = true;
        } else {
            if !has_field || leading < indent {
                return None;
            }
            if last_was_session {
                // A wrapped identity is still exact. Metadata continuation
                // spacing, by contrast, has no bearing on conversation proof.
                let (value, column) = session.as_mut()?;
                if leading != *column {
                    return None;
                }
                value.push_str(line);
            }
        }
    }
    let (id, _) = session?;
    let parsed = uuid::Uuid::parse_str(&id).ok()?;
    (parsed.hyphenated().to_string() == id.to_ascii_lowercase()).then_some(id)
}

#[cfg(test)]
#[path = "screen_tests.rs"]
mod tests;
