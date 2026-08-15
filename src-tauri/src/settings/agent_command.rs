//! Normalization for the configurable Claude/Codex launch commands.
//!
//! `claude.command` / `codex.command` let a user add flags (for example
//! `claude --dangerously-skip-permissions` or `codex --yolo`) to the command
//! that session restore types into a fresh shell. The value is written into a
//! shell line verbatim, so it is restricted to characters that cannot start a
//! new command, a substitution, or a redirection. Frontend and backend must
//! normalize identically — the backend re-derives the expected restore command
//! from settings on disk and rejects anything else.

/// Default launch command for Claude Code.
pub const DEFAULT_CLAUDE_COMMAND: &str = "claude";
/// Default launch command for the Codex CLI.
pub const DEFAULT_CODEX_COMMAND: &str = "codex";
/// Default launch command for Grok Build.
pub const DEFAULT_GROK_COMMAND: &str = "grok";

/// Characters allowed in a configured agent command.
///
/// Alphanumerics plus the punctuation an executable path and its flags need.
/// Shell metacharacters (`;`, `&`, `|`, `$`, backtick, quotes, redirection,
/// parentheses, newline) are absent by construction.
fn is_safe_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '/' | '\\' | ':' | '=' | ',')
}

/// Collapse surrounding and repeated spaces so both sides of the IPC boundary
/// derive the exact same string from the same setting. Only the space character
/// is collapsed — a newline or tab must survive to be rejected below instead of
/// silently welding two lines into one command.
fn collapse_whitespace(raw: &str) -> String {
    let mut collapsed = String::with_capacity(raw.len());
    let mut previous_was_space = false;
    for character in raw.trim_matches(' ').chars() {
        if character == ' ' && previous_was_space {
            continue;
        }
        previous_was_space = character == ' ';
        collapsed.push(character);
    }
    collapsed
}

/// Whether a configured command may be executed as typed.
///
/// The first token is the executable, so a value starting with `-` is rejected
/// as well: it would turn into a flag for whatever the shell resolves next.
pub fn is_safe_agent_command(raw: &str) -> bool {
    let normalized = collapse_whitespace(raw);
    !normalized.is_empty() && !normalized.starts_with('-') && normalized.chars().all(is_safe_char)
}

/// Normalized command to launch, falling back to `fallback` when the configured
/// value is empty or unsafe. Never returns a string that fails `is_safe_agent_command`.
pub fn resolve_agent_command(raw: &str, fallback: &str) -> String {
    let normalized = collapse_whitespace(raw);
    if is_safe_agent_command(&normalized) {
        normalized
    } else {
        fallback.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_commands_and_flags_are_safe() {
        assert!(is_safe_agent_command("claude"));
        assert!(is_safe_agent_command(
            "claude --dangerously-skip-permissions"
        ));
        assert!(is_safe_agent_command("codex --yolo"));
        assert!(is_safe_agent_command("codex --sandbox=danger-full-access"));
        assert!(is_safe_agent_command("/usr/local/bin/claude"));
        assert!(is_safe_agent_command("C:\\tools\\claude.exe --yolo"));
    }

    #[test]
    fn shell_metacharacters_are_rejected() {
        for unsafe_command in [
            "",
            "   ",
            "claude; rm -rf /",
            "claude && echo pwned",
            "claude | tee /tmp/x",
            "claude $(whoami)",
            "claude `whoami`",
            "claude > /tmp/out",
            "claude 'quoted'",
            "claude\nrm -rf /",
            "--dangerously-skip-permissions",
        ] {
            assert!(
                !is_safe_agent_command(unsafe_command),
                "expected rejection: {unsafe_command:?}"
            );
        }
    }

    #[test]
    fn resolve_normalizes_whitespace_and_falls_back() {
        assert_eq!(
            resolve_agent_command("  claude   --yolo ", DEFAULT_CLAUDE_COMMAND),
            "claude --yolo"
        );
        assert_eq!(
            resolve_agent_command("", DEFAULT_CLAUDE_COMMAND),
            DEFAULT_CLAUDE_COMMAND
        );
        assert_eq!(
            resolve_agent_command("codex; rm -rf /", DEFAULT_CODEX_COMMAND),
            DEFAULT_CODEX_COMMAND
        );
    }

    #[test]
    fn resolved_command_is_always_safe() {
        for raw in ["", "claude $(x)", "  ", "-flag", "codex --yolo"] {
            assert!(is_safe_agent_command(&resolve_agent_command(
                raw,
                DEFAULT_CODEX_COMMAND
            )));
        }
    }
}
