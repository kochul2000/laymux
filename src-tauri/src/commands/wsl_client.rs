//! Legacy WSL client warning (ADR-0337).
//!
//! Without a lifted WSL install, laymux-internal WSL runs fall back to the
//! inbox launcher, which still gives every run a console of its own
//! (ADR-0334). The UI warns once the machine is actually using WSL through
//! laymux; detecting or stopping leaked consoles is out of scope.

use std::sync::Arc;

use tauri::State;

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::InitialExecutionHost;

/// Whether to show the legacy WSL client warning right now.
#[tauri::command(async)]
pub fn get_legacy_wsl_notice(state: State<Arc<AppState>>) -> Result<bool, String> {
    legacy_wsl_notice(&state, crate::process::wsl_client_is_inbox()).map_err(|e| e.to_string())
}

/// The inbox client is only a problem once laymux actually drives WSL: every
/// Windows install ships the inbox launcher, WSL or not. A WSL-backed terminal
/// is what makes the probes run (ADR-0134, ADR-0120).
pub(crate) fn legacy_wsl_notice(state: &AppState, inbox_client: bool) -> Result<bool, AppError> {
    if !inbox_client {
        return Ok(false);
    }
    let terminals = state.terminals.lock_or_err()?;
    Ok(terminals
        .values()
        .any(|session| session.initial_execution_host == InitialExecutionHost::Wsl))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::{TerminalConfig, TerminalSession};

    fn state_with(hosts: &[InitialExecutionHost]) -> AppState {
        let state = AppState::new();
        for (index, host) in hosts.iter().enumerate() {
            let id = format!("terminal-{index}");
            let mut session = TerminalSession::new(id.clone(), TerminalConfig::default());
            session.initial_execution_host = *host;
            state.terminals.lock().unwrap().insert(id, session);
        }
        state
    }

    #[test]
    fn warns_for_the_inbox_client_once_a_wsl_terminal_is_open() {
        let state = state_with(&[
            InitialExecutionHost::NativeWindows,
            InitialExecutionHost::Wsl,
        ]);
        assert!(legacy_wsl_notice(&state, true).unwrap());
    }

    #[test]
    fn a_lifted_client_never_warns() {
        let state = state_with(&[InitialExecutionHost::Wsl]);
        assert!(!legacy_wsl_notice(&state, false).unwrap());
    }

    #[test]
    fn the_inbox_launcher_alone_is_not_wsl_use() {
        // Every Windows install ships the inbox launcher, WSL or not.
        assert!(!legacy_wsl_notice(&state_with(&[]), true).unwrap());
        let state = state_with(&[
            InitialExecutionHost::NativeWindows,
            InitialExecutionHost::DirectSsh,
            InitialExecutionHost::Unknown,
        ]);
        assert!(!legacy_wsl_notice(&state, true).unwrap());
    }
}
