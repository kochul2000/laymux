use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::output_buffer::TerminalOutputBuffer;
use crate::pty::PtyHandle;
use crate::terminal::{SyncGroup, TerminalNotification, TerminalSession};

/// Global application state shared across all commands and PTY callbacks.
///
/// ## Lock ordering
///
/// When acquiring multiple locks, always follow this order to prevent deadlocks:
///
/// 1. `terminals`
/// 2. `output_buffers`
/// 3. `known_claude_terminals`
/// 4. `known_codex_terminals`
/// 5. `last_detected_interactive_app`
/// 6. `recently_exited_interactive_app`
/// 7. `notifications`
/// 8. `sync_groups`
/// 9. `propagated_terminals`
/// 10. `pty_handles` / `automation_channels` / `automation_port` / `ipc_socket_path`
/// 11. `remote_access`
/// 12. `remote_control`
/// 13. `cloud_tunnel`
/// 14. `cloud`
///
/// Never acquire a higher-numbered lock while holding a lower-numbered one.
pub struct AppState {
    pub terminals: Arc<Mutex<HashMap<String, TerminalSession>>>,
    pub sync_groups: Mutex<HashMap<String, SyncGroup>>,
    pub pty_handles: Mutex<HashMap<String, PtyHandle>>,
    pub ipc_socket_path: Mutex<Option<String>>,
    pub output_buffers: Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    pub automation_channels:
        Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
    pub automation_port: Mutex<Option<u16>>,
    /// Terminals that recently received a propagated command (e.g., cd from sync-cwd).
    /// Used to suppress OSC echo loops. Entries expire after PROPAGATION_TIMEOUT.
    pub propagated_terminals: Mutex<HashMap<String, Instant>>,
    /// Single source of truth for Claude Code terminal detection.
    /// Populated proactively by the PTY output callback (real-time) and
    /// by frontend via `mark_claude_terminal` command (from command text detection).
    /// Removed when the terminal title no longer contains "Claude Code" (exit detection)
    /// or when the terminal session closes.
    /// Both backend (CWD skip) and frontend (activity display) consume this state.
    pub known_claude_terminals: Arc<Mutex<HashSet<String>>>,
    /// Single source of truth for Codex terminal detection.
    /// Populated proactively by the PTY output callback and frontend command detection.
    /// Removed when the terminal session closes.
    pub known_codex_terminals: Arc<Mutex<HashSet<String>>>,
    /// Per-terminal grace-window cache of the last successfully detected
    /// interactive app name and the `Instant` of that detection.
    ///
    /// Used by `activity::detect_interactive_app_from_live_title` to preserve
    /// the previous detection across title events that evaluate to `None`
    /// (path-like titles, early-splash spinner frames, PowerShell `prompt`
    /// rewrites). Entries older than `INTERACTIVE_APP_GRACE_WINDOW` are
    /// ignored. See issue #237.
    pub last_detected_interactive_app: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    /// Per-terminal negative cache: records the moment an interactive app
    /// (Claude / Codex) was explicitly seen to exit via the PTY title
    /// state machine. Used by `activity::is_claude_terminal_from_buffer`
    /// and its Codex mirror to suppress the buffer-scan strong-signal
    /// branch for the duration of `INTERACTIVE_APP_GRACE_WINDOW`,
    /// preventing the still-resident `Claude Code` / `OpenAI Codex`
    /// banners in the recent 16KB window from re-pinning the cache the
    /// moment the user returns to the shell prompt.
    pub recently_exited_interactive_app: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    /// Single source of truth for terminal notifications.
    /// Stored in backend so `get_terminal_summaries` can return unread counts.
    pub notifications: Arc<Mutex<Vec<TerminalNotification>>>,
    /// Auto-incrementing counter for notification IDs.
    pub notification_counter: AtomicU64,
    /// Runtime-only Direct Remote Mode access gate, separate from persisted settings.
    pub remote_access: Mutex<crate::remote_server::RemoteAccessRuntimeState>,
    /// Current Direct Remote Mode controller lease plus local reclaim lockout state.
    pub remote_control: Mutex<crate::remote_server::RemoteControlState>,
    /// Runtime cloud tunnel worker control. Stored separately from status so
    /// disconnect can cancel the long-running WSS task without holding cloud.
    pub cloud_tunnel: Mutex<Option<crate::cloud::tunnel::TunnelControl>>,
    /// Runtime cloud relay connection status. Pairing/tunnel workers update this state.
    pub cloud: Mutex<crate::cloud::CloudStatus>,
    /// Process-global per-terminal lock table serializing `write_input` /
    /// `execute_command` on the same terminal (#314). Living on the shared
    /// `Arc<AppState>` — not on the per-MCP-session handler — is what makes the
    /// serialization hold **across MCP sessions** (#427). A `tokio::sync::Mutex`
    /// because it is held across the write's `.await` points.
    pub exec_locks: SharedExecLocks,
}

/// Process-global per-terminal write/exec serialization table. See
/// [`AppState::exec_locks`].
pub type SharedExecLocks = Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;

impl AppState {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
            sync_groups: Mutex::new(HashMap::new()),
            pty_handles: Mutex::new(HashMap::new()),
            ipc_socket_path: Mutex::new(None),
            output_buffers: Arc::new(Mutex::new(HashMap::new())),
            automation_channels: Mutex::new(HashMap::new()),
            automation_port: Mutex::new(None),
            propagated_terminals: Mutex::new(HashMap::new()),
            known_claude_terminals: Arc::new(Mutex::new(HashSet::new())),
            known_codex_terminals: Arc::new(Mutex::new(HashSet::new())),
            last_detected_interactive_app: Arc::new(Mutex::new(HashMap::new())),
            recently_exited_interactive_app: Arc::new(Mutex::new(HashMap::new())),
            notifications: Arc::new(Mutex::new(Vec::new())),
            notification_counter: AtomicU64::new(1),
            remote_access: Mutex::new(crate::remote_server::RemoteAccessRuntimeState::default()),
            remote_control: Mutex::new(crate::remote_server::RemoteControlState::default()),
            cloud_tunnel: Mutex::new(None),
            cloud: Mutex::new(crate::cloud::CloudStatus::default()),
            exec_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(handles) = self.pty_handles.get_mut() {
            for (terminal_id, handle) in handles.drain() {
                if let Err(err) = handle.terminate() {
                    tracing::warn!(terminal_id, error = %err, "PTY cleanup during app shutdown failed");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_empty_state() {
        let state = AppState::new();
        let terminals = state.terminals.lock().unwrap();
        assert!(terminals.is_empty());
        let groups = state.sync_groups.lock().unwrap();
        assert!(groups.is_empty());
        let ptys = state.pty_handles.lock().unwrap();
        assert!(ptys.is_empty());
    }

    #[test]
    fn default_matches_new() {
        let state = AppState::default();
        let terminals = state.terminals.lock().unwrap();
        assert!(terminals.is_empty());
    }

    #[test]
    fn propagated_terminals_starts_empty() {
        let state = AppState::new();
        let propagated = state.propagated_terminals.lock().unwrap();
        assert!(propagated.is_empty());
    }

    #[test]
    fn known_claude_terminals_starts_empty() {
        let state = AppState::new();
        let known = state.known_claude_terminals.lock().unwrap();
        assert!(known.is_empty());
    }

    #[test]
    fn known_codex_terminals_starts_empty() {
        let state = AppState::new();
        let known = state.known_codex_terminals.lock().unwrap();
        assert!(known.is_empty());
    }

    #[test]
    fn notifications_starts_empty() {
        let state = AppState::new();
        let notifs = state.notifications.lock().unwrap();
        assert!(notifs.is_empty());
    }

    #[test]
    fn remote_control_starts_empty() {
        let state = AppState::new();
        let access = state.remote_access.lock().unwrap();
        assert!(!access.enabled);
        assert!(access.auth_token.is_none());
        drop(access);
        let remote = state.remote_control.lock().unwrap();
        assert!(remote.lease.is_none());
        assert!(remote.reclaim_lockout_until.is_none());
    }

    #[test]
    fn cloud_status_starts_disconnected() {
        let state = AppState::new();
        let cloud = state.cloud.lock().unwrap();
        assert!(!cloud.connected);
        assert!(cloud.instance_id.is_none());
        assert!(cloud.last_error.is_none());
    }

    #[test]
    fn cloud_tunnel_control_starts_empty() {
        let state = AppState::new();
        let tunnel = state.cloud_tunnel.lock().unwrap();
        assert!(tunnel.is_none());
    }
}
