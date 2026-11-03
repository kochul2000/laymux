use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::automation_server::{self, lifecycle::ServerStatus};
use crate::state::AppState;

#[tauri::command]
pub fn get_automation_server_status(
    state: State<'_, Arc<AppState>>,
) -> Result<ServerStatus, String> {
    state.automation_server.snapshot().map_err(Into::into)
}

#[tauri::command]
pub async fn retry_automation_server(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<ServerStatus, String> {
    automation_server::retry(state.inner().clone(), app)
        .await
        .map_err(Into::into)
}
