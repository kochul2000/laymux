use std::sync::Arc;

use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// Hold or release the OS sleep inhibitor (ADR-0113).
///
/// The frontend decides *whether* to inhibit — it folds the user's mode setting
/// and the terminals' busy state into one boolean — and calls this on every
/// change. Returns the state in effect afterwards.
#[tauri::command]
pub fn set_sleep_inhibit(enabled: bool, state: State<Arc<AppState>>) -> Result<bool, String> {
    set_sleep_inhibit_inner(enabled, &state).map_err(|e| e.to_string())
}

pub fn set_sleep_inhibit_inner(enabled: bool, state: &AppState) -> Result<bool, AppError> {
    state.sleep_inhibitor.set(enabled)
}
