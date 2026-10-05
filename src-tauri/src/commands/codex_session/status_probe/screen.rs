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
    let lines: Vec<_> = contents.lines().map(str::trim).collect();
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
        return parse_borderless_card(&card);
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

/// Codex 0.160 removed status borders. Require the complete ordered identity
/// fields and known status rows, rather than accepting any `Session:` text.
fn parse_borderless_card(card: &[&str]) -> Option<String> {
    if !card.first()?.ends_with(')') {
        return None;
    }
    let fields = [
        "Model:",
        "Directory:",
        "Permissions:",
        "Collaboration mode:",
        "Session:",
    ];
    let mut previous = 0;
    let mut id = None;
    for field in fields {
        let mut matches = card.iter().enumerate().filter_map(|(index, line)| {
            line.strip_prefix(field).map(|value| (index, value.trim()))
        });
        let (index, value) = matches.next()?;
        if matches.next().is_some() || index <= previous || value.is_empty() {
            return None;
        }
        previous = index;
        if field == "Session:" {
            let parsed = uuid::Uuid::parse_str(value).ok()?;
            if parsed.hyphenated().to_string() != value.to_ascii_lowercase() {
                return None;
            }
            id = Some(value.to_owned());
        }
    }
    for line in &card[1..] {
        if line.starts_with("Visit https://chatgpt.com/codex/settings/usage ")
            || *line == "information on rate limits and credits"
            || line.starts_with("Tip:")
        {
            continue;
        }
        let (key, value) = line.split_once(':')?;
        if value.trim().is_empty()
            || !(matches!(
                key,
                "Model"
                    | "Model provider"
                    | "Directory"
                    | "Permissions"
                    | "Agents.md"
                    | "Account"
                    | "Thread name"
                    | "Context window"
                    | "Collaboration mode"
                    | "Session"
                    | "Credits"
            ) || key.ends_with(" limit"))
        {
            return None;
        }
    }
    id
}

#[cfg(test)]
#[path = "screen_tests.rs"]
mod tests;
