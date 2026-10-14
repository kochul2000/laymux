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
pub fn manage_agent_hooks(
    request: ManageRequest,
    state: State<Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    agent_hooks::manage(&request, &state, &app).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn manage_agent_mcp(
    request: agent_hooks::mcp::McpRequest,
    state: State<Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    agent_hooks::mcp::manage(&request, &state, &app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_agent_hook_connections(state: State<Arc<AppState>>) -> Result<Vec<Value>, String> {
    agent_hooks::connections(&state).map_err(|e| e.to_string())
}
mod states;
pub use states::*;

#[tauri::command(async)]
pub fn get_agent_hook_updates(
    state: State<Arc<AppState>>,
    app: tauri::AppHandle,
    automatic: Option<bool>,
) -> Result<Value, String> {
    if automatic == Some(true) {
        // MCP registration shares the startup lifecycle (ADR-0325) but must not
        // delay the hook notice, so it runs once in the background.
        let (state, app) = (Arc::clone(&state), app.clone());
        std::thread::spawn(move || {
            if let Err(error) = agent_hooks::mcp::warm_up(&state, &app) {
                tracing::warn!(%error, "MCP registration startup check failed");
            }
        });
    }
    agent_hooks::updates::audit_with_mode(&state, &app, automatic.unwrap_or(false))
        .map_err(|e| e.to_string())
}
