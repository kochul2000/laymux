use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::app_update::{self, UpdateStatus};
use crate::state::AppState;

#[tauri::command]
pub fn get_app_update_status(state: State<'_, Arc<AppState>>) -> Result<UpdateStatus, String> {
    state.app_update.snapshot()
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
