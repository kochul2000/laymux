//! PTY daemon session inventory for the settings panel and automation
//! (ADR-0306). The daemon calls block on local IPC and the layout read on
//! disk, so every entry point runs off the async runtime.

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::pty_daemon::{
    self, KnownTerminals, ListedSession, PtySessionInventory, TerminateDetachedResult,
    TerminateOutcome,
};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminatePtySessionRequest {
    pub session_id: String,
    /// The epoch the session was listed with; a session attached again since
    /// is left running.
    pub attach_epoch: u64,
}

/// This GUI's live panes, adoption history and the saved layout's terminals.
fn known_terminals(state: &AppState) -> Result<KnownTerminals, String> {
    let panes = state.pty_handles.lock_or_err()?.keys().cloned().collect();
    let adoption_seen = state.pty_daemon_adoption_seen.lock_or_err()?.clone();
    KnownTerminals::load(panes, adoption_seen)
}

pub fn list_pty_sessions_inner(state: &AppState) -> Result<PtySessionInventory, String> {
    pty_daemon::inventory(&known_terminals(state)?)
}

pub fn terminate_pty_session_inner(
    state: &AppState,
    request: &TerminatePtySessionRequest,
) -> Result<TerminateOutcome, String> {
    pty_daemon::terminate_listed_session(
        &request.session_id,
        request.attach_epoch,
        &known_terminals(state)?,
    )
}

pub fn terminate_detached_pty_sessions_inner(
    state: &AppState,
    request: &TerminateDetachedPtySessionsRequest,
) -> Result<TerminateDetachedResult, String> {
    pty_daemon::terminate_detached(&request.sessions, &known_terminals(state)?)
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
    state: State<'_, Arc<AppState>>,
    request: TerminatePtySessionRequest,
) -> Result<TerminateOutcome, String> {
    let state = Arc::clone(&state);
    blocking(move || terminate_pty_session_inner(&state, &request)).await
}

#[tauri::command(async)]
pub async fn terminate_detached_pty_sessions(
    state: State<'_, Arc<AppState>>,
    request: TerminateDetachedPtySessionsRequest,
) -> Result<TerminateDetachedResult, String> {
    let state = Arc::clone(&state);
    blocking(move || terminate_detached_pty_sessions_inner(&state, &request)).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateDetachedPtySessionsRequest {
    /// The detached sessions the caller saw, with the epochs it saw.
    pub sessions: Vec<ListedSession>,
}
