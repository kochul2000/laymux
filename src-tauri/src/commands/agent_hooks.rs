use crate::agent_hooks::{self, ManageRequest};
use crate::state::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[tauri::command(async)]
pub fn list_agent_hook_environments() -> Result<Vec<Value>, String> {
    agent_hooks::environments().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn manage_agent_hooks(request: ManageRequest, app: tauri::AppHandle) -> Result<Value, String> {
    agent_hooks::manage(&request, &app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_agent_hook_connections(state: State<Arc<AppState>>) -> Result<Vec<Value>, String> {
    agent_hooks::connections(&state).map_err(|e| e.to_string())
}
