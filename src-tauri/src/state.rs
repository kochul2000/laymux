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
/// 4. `notifications`
/// 5. `sync_groups`
/// 6. `propagated_terminals`
/// 7. `pty_handles` / `automation_channels` / `automation_port` / `ipc_socket_path`
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
    /// Bearer token for Automation API authentication.
    /// Generated on startup, written to discovery file.
    pub automation_key: Mutex<Option<String>>,
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
    /// Single source of truth for terminal notifications.
    /// Stored in backend so `get_terminal_summaries` can return unread counts.
    pub notifications: Arc<Mutex<Vec<TerminalNotification>>>,
    /// Auto-incrementing counter for notification IDs.
    pub notification_counter: AtomicU64,
}

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
            automation_key: Mutex::new(None),
            propagated_terminals: Mutex::new(HashMap::new()),
            known_claude_terminals: Arc::new(Mutex::new(HashSet::new())),
            notifications: Arc::new(Mutex::new(Vec::new())),
            notification_counter: AtomicU64::new(1),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
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
    fn notifications_starts_empty() {
        let state = AppState::new();
        let notifs = state.notifications.lock().unwrap();
        assert!(notifs.is_empty());
    }
}
