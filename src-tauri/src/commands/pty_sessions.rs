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
    /// The daemon generation the session was listed under (ADR-0308).
    pub daemon: String,
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
        &request.daemon,
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

/// End the daemon sessions this GUI's panes will never adopt (ADR-0312):
/// ones left by a GUI that crashed before its layout was saved. A session the
/// saved layout still awaits, or another client holds, is left alone, and
/// each is ended with the epoch it was listed with. A failed listing or an
/// unreadable layout ends nothing.
pub fn sweep_detached_pty_sessions(state: &AppState) {
    let swept = known_terminals(state).and_then(|known| {
        let listed: Vec<ListedSession> = pty_daemon::inventory(&known)?
            .sessions
            .into_iter()
            .filter(|entry| entry.state == pty_daemon::PtySessionState::Detached)
            .map(|entry| ListedSession {
                daemon: entry.daemon,
                session_id: entry.session_id,
                attach_epoch: entry.attach_epoch,
            })
            .collect();
        if listed.is_empty() {
            return Ok(None);
        }
        pty_daemon::terminate_detached(&listed, &known).map(Some)
    });
    match swept {
        Ok(Some(result)) => tracing::info!(
            ended = result.ended,
            failed = result.failed.len(),
            "ended PTY daemon sessions no pane will adopt"
        ),
        Ok(None) => {}
        Err(error) => tracing::debug!(%error, "PTY daemon session sweep skipped"),
    }
}

/// Sweep every `PTY_DAEMON_DETACHED_SWEEP_MS`, the first time one interval
/// after start: the restored layout's panes adopt their sessions first.
pub fn start_detached_pty_session_sweep(state: Arc<AppState>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(
            crate::constants::PTY_DAEMON_DETACHED_SWEEP_MS,
        ));
        if pty_daemon::is_enabled() {
            sweep_detached_pty_sessions(&state);
        }
    });
}
