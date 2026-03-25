use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::output_buffer::TerminalOutputBuffer;
use crate::pty::PtyHandle;
use crate::terminal::{SyncGroup, TerminalSession};

pub struct AppState {
    pub terminals: Mutex<HashMap<String, TerminalSession>>,
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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            sync_groups: Mutex::new(HashMap::new()),
            pty_handles: Mutex::new(HashMap::new()),
            ipc_socket_path: Mutex::new(None),
            output_buffers: Arc::new(Mutex::new(HashMap::new())),
            automation_channels: Mutex::new(HashMap::new()),
            automation_port: Mutex::new(None),
            propagated_terminals: Mutex::new(HashMap::new()),
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
}
