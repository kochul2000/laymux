use std::sync::Arc;

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// Hold or release the OS sleep inhibitor (ADR-0113).
///
/// The frontend decides *whether* to inhibit — it folds the user's mode setting
/// and the terminals' busy state into one boolean — and calls this on every
/// change. Returns the state in effect afterwards.
///
/// Runs on a blocking worker: acquiring the Linux inhibitor watches the freshly
/// spawned `systemd-inhibit` for a moment before believing its lock, and that
/// wait must not land on the UI thread.
#[tauri::command]
pub async fn set_sleep_inhibit(
    enabled: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_sleep_inhibit_inner(enabled, &state))
        .await
        .map_err(|error| format!("sleep inhibitor task failed: {error}"))?
        .map_err(|e| e.to_string())
}

pub fn set_sleep_inhibit_inner(enabled: bool, state: &AppState) -> Result<bool, AppError> {
    // Idempotent, and the retry path if the watchdog failed to start at setup:
    // it is the only thing that re-acquires an inhibitor the frontend will not
    // ask for twice.
    state.sleep_inhibitor.ensure_watchdog();
    state.sleep_inhibitor.set(enabled)
}
