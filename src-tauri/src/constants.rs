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

// ── Environment variable names ─────────────────────────────────────

pub const ENV_LX_SOCKET: &str = "LX_SOCKET";
pub const ENV_LX_TERMINAL_ID: &str = "LX_TERMINAL_ID";
pub const ENV_LX_GROUP_ID: &str = "LX_GROUP_ID";
pub const ENV_LX_AUTOMATION_PORT: &str = "LX_AUTOMATION_PORT";
pub const ENV_LX_AUTOMATION_KEY: &str = "LX_AUTOMATION_KEY";
pub const ENV_LX_PROPAGATED: &str = "LX_PROPAGATED";

// ── Timeouts & limits ──────────────────────────────────────────────

/// How long a propagation flag remains valid before expiring.
pub const PROPAGATION_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum number of notifications to keep. When exceeded, oldest read
/// notifications are evicted first. Unread notifications are never evicted.
pub const MAX_NOTIFICATIONS: usize = 500;

/// Number of bytes to scan from the end of a terminal output buffer when
/// detecting activity state or Claude Code presence. 16KB covers terminal
/// title sequences even when OSC 133 markers have scrolled out.
pub const ACTIVITY_SCAN_BYTES: usize = 16384;

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
    fn env_names_are_screaming_snake_case() {
        let envs = [
            ENV_LX_SOCKET,
            ENV_LX_TERMINAL_ID,
            ENV_LX_GROUP_ID,
            ENV_LX_AUTOMATION_PORT,
            ENV_LX_AUTOMATION_KEY,
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
