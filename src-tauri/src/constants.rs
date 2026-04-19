use std::time::Duration;

// ── Tauri event names ──────────────────────────────────────────────
// These must match the frontend `listen()` / `useAutomationBridge` strings.

pub const EVENT_SYNC_CWD: &str = "sync-cwd";
pub const EVENT_SYNC_BRANCH: &str = "sync-branch";
pub const EVENT_LX_NOTIFY: &str = "lx-notify";
pub const EVENT_SET_TAB_TITLE: &str = "set-tab-title";
pub const EVENT_COMMAND_STATUS: &str = "command-status";
pub const EVENT_OPEN_FILE: &str = "open-file";
pub const EVENT_CLAUDE_TERMINAL_DETECTED: &str = "claude-terminal-detected";
pub const EVENT_AUTOMATION_REQUEST: &str = "automation-request";
pub const EVENT_TERMINAL_CWD_CHANGED: &str = "terminal-cwd-changed";
pub const EVENT_TERMINAL_TITLE_CHANGED: &str = "terminal-title-changed";
pub const EVENT_CLAUDE_MESSAGE_CHANGED: &str = "claude-message-changed";
pub const EVENT_TERMINAL_OUTPUT_ACTIVITY: &str = "terminal-output-activity";

// ── Environment variable names ─────────────────────────────────────

pub const ENV_LX_SOCKET: &str = "LX_SOCKET";
pub const ENV_LX_TERMINAL_ID: &str = "LX_TERMINAL_ID";
pub const ENV_LX_GROUP_ID: &str = "LX_GROUP_ID";
pub const ENV_LX_AUTOMATION_PORT: &str = "LX_AUTOMATION_PORT";
pub const ENV_LX_PROPAGATED: &str = "LX_PROPAGATED";

// ── Timeouts & limits ──────────────────────────────────────────────

/// How long a propagation flag remains valid before expiring.
pub const PROPAGATION_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum number of notifications to keep. When exceeded, oldest read
/// notifications are evicted first. Unread notifications are never evicted.
pub const MAX_NOTIFICATIONS: usize = 500;

/// Maximum number of bytes to write to a PTY in a single `write_all()` call.
/// ConPTY on Windows can silently truncate large writes; chunking prevents this.
pub const PTY_WRITE_CHUNK_SIZE: usize = 1024;

/// Number of bytes to scan from the end of a terminal output buffer when
/// detecting activity state or Claude Code presence. 16KB covers terminal
/// title sequences even when OSC 133 markers have scrolled out.
pub const ACTIVITY_SCAN_BYTES: usize = 16384;

/// Maximum bytes to scan forward from a Claude Code status marker (● or ·)
/// to extract message text. TUI cursor-addressing can spread text across many bytes.
pub const STATUS_MESSAGE_SCAN_BYTES: usize = 500;

/// DEC 2026 Synchronized Output set sequence: ESC [ ? 2 0 2 6 h
/// TUI apps (Claude Code, neovim) send this before each frame redraw.
/// Shell commands never use it, making it a high-confidence activity signal.
pub const DEC_SYNC_OUTPUT_SET: &[u8] = b"\x1b[?2026h";

// ── MCP (Model Context Protocol) ──────────────────────────────────

pub const MCP_SERVER_NAME: &str = "laymux";

/// MCP Resource URIs.
///
/// Resources provide read-only, subscribable views of IDE state for MCP clients.
/// The full URI for a parameterized resource follows the pattern
/// `terminal://{terminal_id}` / `terminal://{terminal_id}/output`.
pub const MCP_URI_WORKSPACE_ACTIVE: &str = "workspace://active";
pub const MCP_URI_WORKSPACE_LIST: &str = "workspace://list";
pub const MCP_URI_PROFILE_LIST: &str = "profile://list";

/// Scheme prefixes used when parsing resource URIs.
pub const MCP_SCHEME_TERMINAL: &str = "terminal://";
pub const MCP_SCHEME_WORKSPACE: &str = "workspace://";
pub const MCP_SCHEME_PROFILE: &str = "profile://";

/// Tauri event broadcast whenever any workspace state (list, active, panes)
/// changes. The MCP resource bridge listens for this to emit
/// `notifications/resources/updated` on subscribed workspace:// URIs.
pub const EVENT_WORKSPACE_STATE_CHANGED: &str = "workspace-state-changed";

/// Fallback delay (ms) to arm the notify gate for shells without preexec
/// (e.g., PowerShell which doesn't emit OSC 133;C/E). After this delay,
/// notifications are enabled even without observing a user command.
pub const NOTIFY_GATE_FALLBACK_MS: u64 = 3000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn propagation_timeout_is_positive() {
        assert!(PROPAGATION_TIMEOUT.as_secs() > 0);
    }

    #[test]
    fn event_names_are_kebab_case() {
        let events = [
            EVENT_SYNC_CWD,
            EVENT_SYNC_BRANCH,
            EVENT_LX_NOTIFY,
            EVENT_SET_TAB_TITLE,
            EVENT_COMMAND_STATUS,
            EVENT_OPEN_FILE,
            EVENT_CLAUDE_TERMINAL_DETECTED,
            EVENT_AUTOMATION_REQUEST,
            EVENT_TERMINAL_CWD_CHANGED,
            EVENT_TERMINAL_TITLE_CHANGED,
            EVENT_CLAUDE_MESSAGE_CHANGED,
            EVENT_TERMINAL_OUTPUT_ACTIVITY,
            EVENT_WORKSPACE_STATE_CHANGED,
        ];
        for name in events {
            assert!(!name.is_empty(), "Event name should not be empty");
            assert!(
                !name.contains(' '),
                "Event '{name}' should not contain spaces"
            );
        }
    }

    #[test]
    fn mcp_resource_uris_have_expected_schemes() {
        assert!(MCP_URI_WORKSPACE_ACTIVE.starts_with(MCP_SCHEME_WORKSPACE));
        assert!(MCP_URI_WORKSPACE_LIST.starts_with(MCP_SCHEME_WORKSPACE));
        assert!(MCP_URI_PROFILE_LIST.starts_with(MCP_SCHEME_PROFILE));
        assert!(MCP_SCHEME_TERMINAL.ends_with("://"));
        assert!(MCP_SCHEME_WORKSPACE.ends_with("://"));
        assert!(MCP_SCHEME_PROFILE.ends_with("://"));
    }

    #[test]
    fn detect_dec_2026_in_pty_chunk() {
        let chunk = b"some text\x1b[?2026h\x1b[1;1Hcontent\x1b[?2026l";
        assert!(chunk
            .windows(DEC_SYNC_OUTPUT_SET.len())
            .any(|w| w == DEC_SYNC_OUTPUT_SET));
    }

    #[test]
    fn no_dec_2026_in_shell_output() {
        let chunk = b"total 42\ndrwxr-xr-x 2 user user 4096\n";
        assert!(!chunk
            .windows(DEC_SYNC_OUTPUT_SET.len())
            .any(|w| w == DEC_SYNC_OUTPUT_SET));
    }

    #[test]
    fn env_names_are_screaming_snake_case() {
        let envs = [
            ENV_LX_SOCKET,
            ENV_LX_TERMINAL_ID,
            ENV_LX_GROUP_ID,
            ENV_LX_AUTOMATION_PORT,
            ENV_LX_PROPAGATED,
        ];
        for name in envs {
            assert!(
                name.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "Env var '{name}' should be SCREAMING_SNAKE_CASE"
            );
        }
    }
}
