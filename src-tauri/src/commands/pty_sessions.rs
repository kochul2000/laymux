//! PTY daemon session inventory for the settings panel and automation
//! (ADR-0306). The daemon calls block on local IPC, so every entry point runs
//! off the async runtime.

use std::collections::HashSet;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::pty_daemon::{self, PtySessionInventory, TerminateOutcome};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminatePtySessionRequest {
    pub session_id: String,
    /// The epoch the session was listed with; a session attached again since
    /// is left running.
    pub attach_epoch: u64,
}

/// Terminals this GUI's panes own.
fn pane_terminal_ids(state: &AppState) -> Result<HashSet<String>, String> {
    Ok(state.pty_handles.lock_or_err()?.keys().cloned().collect())
}

pub fn list_pty_sessions_inner(state: &AppState) -> Result<PtySessionInventory, String> {
    pty_daemon::inventory(&pane_terminal_ids(state)?)
}

pub fn terminate_detached_pty_sessions_inner(state: &AppState) -> Result<usize, String> {
    pty_daemon::terminate_detached(&pane_terminal_ids(state)?)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn list_pty_sessions(
    state: State<'_, Arc<AppState>>,
) -> Result<PtySessionInventory, String> {
    let state = Arc::clone(&state);
    blocking(move || list_pty_sessions_inner(&state)).await
}

#[tauri::command(async)]
pub async fn terminate_pty_session(
    request: TerminatePtySessionRequest,
) -> Result<TerminateOutcome, String> {
    blocking(move || {
        pty_daemon::terminate_listed_session(&request.session_id, request.attach_epoch)
    })
    .await
}

#[tauri::command(async)]
pub async fn terminate_detached_pty_sessions(
    state: State<'_, Arc<AppState>>,
) -> Result<usize, String> {
    let state = Arc::clone(&state);
    blocking(move || terminate_detached_pty_sessions_inner(&state)).await
}
