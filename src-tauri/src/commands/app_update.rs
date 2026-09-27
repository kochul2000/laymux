use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::app_update::{self, UpdateStatus};
use crate::lock_ext::MutexExt;
use crate::state::AppState;

#[tauri::command]
pub fn get_app_update_status(state: State<'_, Arc<AppState>>) -> Result<UpdateStatus, String> {
    state.app_update.status_with_settings()
}

#[tauri::command]
pub fn begin_app_close(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.app_update.claim_close()
}

#[tauri::command]
pub fn cancel_app_close(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if state
        .session_checkpoint
        .codex_status
        .lock_or_err()?
        .is_some()
    {
        return Err("Wait for Codex status preparation to settle before cancelling close".into());
    }
    if state.app_update.cancel_close() {
        state.session_checkpoint.cancel_finalization();
    }
    Ok(())
}

#[tauri::command]
pub fn report_app_update_preparation(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request_id: u64,
    progress: app_update::progress::ExitProgress,
) -> Result<(), String> {
    app_update::progress::report(&app, &state, request_id, progress)
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<UpdateStatus, String> {
    app_update::check_now(&app, &state.app_update).await
}

#[tauri::command]
pub fn install_app_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<UpdateStatus, String> {
    app_update::schedule_install(app, Arc::clone(&state.app_update))
}
