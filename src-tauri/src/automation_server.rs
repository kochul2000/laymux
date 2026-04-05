use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State as AxumState};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::state::AppState;

/// Shared state for the axum server.
#[derive(Clone)]
pub struct ServerState {
    pub app_state: Arc<AppState>,
    pub app_handle: AppHandle,
}

/// Request sent to frontend via Tauri event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRequest {
    pub request_id: String,
    pub category: String, // "query" or "action"
    pub target: String,
    pub method: String,
    pub params: serde_json::Value,
}

/// Response from frontend via Tauri invoke.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResponse {
    pub request_id: String,
    pub success: bool,
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
}

// -- Request/response bodies --

#[derive(Deserialize)]
pub struct WriteBody {
    pub data: String,
}

#[derive(Deserialize)]
pub struct OutputQuery {
    pub lines: Option<usize>,
}

#[derive(Deserialize)]
pub struct SwitchWorkspaceBody {
    pub id: String,
}

#[derive(Deserialize)]
pub struct CreateWorkspaceBody {
    pub name: String,
    #[serde(default, rename = "layoutId")]
    pub layout_id: Option<String>,
}

#[derive(Deserialize)]
pub struct RenameWorkspaceBody {
    pub name: String,
}

#[derive(Deserialize)]
pub struct ExportLayoutBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "layoutId")]
    pub layout_id: Option<String>,
}

#[derive(Deserialize)]
pub struct EditModeBody {
    pub enabled: bool,
}

#[derive(Deserialize)]
pub struct FocusPaneBody {
    #[serde(rename = "paneIndex")]
    pub pane_index: usize,
}

#[derive(Deserialize)]
pub struct SimulateHoverBody {
    pub index: Option<usize>,
}

#[derive(Deserialize)]
pub struct SplitPaneBody {
    #[serde(rename = "paneIndex")]
    pub pane_index: usize,
    pub direction: String,
}

#[derive(Deserialize)]
pub struct SetViewBody {
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
pub struct SetDockViewBody {
    pub view: String,
}

#[derive(Deserialize)]
pub struct AddNotificationBody {
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    pub message: String,
    pub level: Option<String>,
}

#[derive(Deserialize)]
pub struct MarkReadBody {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
}

#[derive(Deserialize)]
pub struct FocusTerminalBody {
    pub id: String,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub port: u16,
}

/// Fixed automation port: release = 19280, dev = 19281.
/// Only one instance of each build type can run at a time.
pub const RELEASE_PORT: u16 = 19280;
pub const DEV_PORT: u16 = 19281;

/// Return the fixed automation port for this build type.
pub fn automation_port() -> u16 {
    if cfg!(debug_assertions) {
        DEV_PORT
    } else {
        RELEASE_PORT
    }
}

/// Write discovery file so external tools can find the automation port.
pub fn write_discovery_file(port: u16) {
    let path = discovery_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&content).unwrap_or_default(),
    );
}

/// Remove discovery file on shutdown.
pub fn remove_discovery_file() {
    let _ = std::fs::remove_file(discovery_file_path());
}

fn discovery_file_path() -> std::path::PathBuf {
    crate::settings::settings_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("automation.json")
}

/// Start the automation HTTP server on a fixed port.
/// Release = 19280, Dev = 19281. No fallback — fails if port is occupied.
pub async fn start(app_state: Arc<AppState>, app_handle: AppHandle) -> Result<u16, String> {
    let server_state = ServerState {
        app_state: app_state.clone(),
        app_handle,
    };

    let app = build_router(server_state);

    let port = automation_port();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind automation server on port {port}: {e}. Is another instance already running?"))?;

    let bound_port = port;

    // Store port in AppState
    if let Ok(mut port) = app_state.automation_port.lock() {
        *port = Some(bound_port);
    }

    // Write discovery file
    write_discovery_file(bound_port);

    eprintln!("Automation server listening on 0.0.0.0:{bound_port}");

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("Automation server error: {e}");
        }
    });

    Ok(bound_port)
}

/// All registered routes as (method, path) pairs.
/// Used by both the router and the docs completeness test.
pub const REGISTERED_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/docs"),
    ("GET", "/api/v1/health"),
    ("GET", "/api/v1/workspaces"),
    ("POST", "/api/v1/workspaces"),
    ("GET", "/api/v1/workspaces/active"),
    ("POST", "/api/v1/workspaces/active"),
    ("PUT", "/api/v1/workspaces/{id}"),
    ("POST", "/api/v1/workspaces/reorder"),
    ("DELETE", "/api/v1/workspaces/{id}"),
    ("POST", "/api/v1/layouts/export"),
    ("GET", "/api/v1/grid"),
    ("POST", "/api/v1/grid/edit-mode"),
    ("POST", "/api/v1/grid/focus"),
    ("POST", "/api/v1/grid/hover"),
    ("POST", "/api/v1/panes/split"),
    ("DELETE", "/api/v1/panes/{index}"),
    ("PUT", "/api/v1/panes/{index}/view"),
    ("GET", "/api/v1/docks"),
    ("POST", "/api/v1/docks/layout-mode/toggle"),
    ("PUT", "/api/v1/docks/{position}/active-view"),
    ("POST", "/api/v1/docks/{position}/toggle"),
    ("PUT", "/api/v1/docks/{position}/size"),
    ("PUT", "/api/v1/docks/{position}/views"),
    ("POST", "/api/v1/docks/{position}/split"),
    ("DELETE", "/api/v1/docks/{position}/panes/{paneId}"),
    ("PUT", "/api/v1/docks/{position}/panes/{paneId}/view"),
    ("GET", "/api/v1/terminals"),
    ("POST", "/api/v1/terminals/{id}/write"),
    ("GET", "/api/v1/terminals/{id}/output"),
    ("GET", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications/mark-read"),
    ("GET", "/api/v1/workspaces/{id}/summary"),
    ("POST", "/api/v1/terminals/{id}/focus"),
    ("GET", "/api/v1/terminals/states"),
    ("GET", "/api/v1/layouts"),
    ("POST", "/api/v1/screenshot"),
    ("POST", "/api/v1/ui/settings"),
    ("POST", "/api/v1/ui/settings/navigate"),
    ("PUT", "/api/v1/settings/app-theme"),
    ("PUT", "/api/v1/settings/profile-defaults"),
    ("PUT", "/api/v1/settings/profiles/{index}"),
    ("POST", "/api/v1/ui/notifications"),
];

pub fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/api/v1/docs", get(api_docs))
        .route("/api/v1/health", get(health))
        .route("/api/v1/workspaces", get(workspaces_list))
        .route("/api/v1/workspaces", post(workspaces_create))
        .route("/api/v1/workspaces/active", get(workspaces_get_active))
        .route("/api/v1/workspaces/active", post(workspaces_switch_active))
        .route("/api/v1/workspaces/reorder", post(workspaces_reorder))
        .route("/api/v1/workspaces/{id}", put(workspaces_rename))
        .route("/api/v1/workspaces/{id}", delete(workspaces_delete))
        .route("/api/v1/layouts/export", post(layouts_export))
        .route("/api/v1/grid", get(grid_get_state))
        .route("/api/v1/grid/edit-mode", post(grid_set_edit_mode))
        .route("/api/v1/grid/focus", post(grid_focus_pane))
        .route("/api/v1/grid/hover", post(grid_simulate_hover))
        .route("/api/v1/panes/split", post(panes_split))
        .route("/api/v1/panes/{index}", delete(panes_remove))
        .route("/api/v1/panes/{index}/view", put(panes_set_view))
        .route("/api/v1/docks", get(docks_list))
        .route(
            "/api/v1/docks/layout-mode/toggle",
            post(docks_toggle_layout_mode),
        )
        .route(
            "/api/v1/docks/{position}/active-view",
            put(docks_set_active_view),
        )
        .route(
            "/api/v1/docks/{position}/toggle",
            post(docks_toggle_visible),
        )
        .route("/api/v1/docks/{position}/size", put(docks_set_size))
        .route("/api/v1/docks/{position}/views", put(docks_set_views))
        .route("/api/v1/docks/{position}/split", post(docks_split_pane))
        .route(
            "/api/v1/docks/{position}/panes/{paneId}",
            delete(docks_remove_pane),
        )
        .route(
            "/api/v1/docks/{position}/panes/{paneId}/view",
            put(docks_set_pane_view),
        )
        .route("/api/v1/terminals", get(terminals_list))
        .route("/api/v1/terminals/{id}/write", post(terminal_write))
        .route("/api/v1/terminals/{id}/output", get(terminal_output))
        .route("/api/v1/notifications", get(notifications_list))
        .route("/api/v1/notifications", post(notifications_add))
        .route(
            "/api/v1/notifications/mark-read",
            post(notifications_mark_read),
        )
        .route(
            "/api/v1/workspaces/{id}/summary",
            get(workspaces_get_summary),
        )
        .route("/api/v1/terminals/{id}/focus", post(terminals_set_focus))
        .route("/api/v1/terminals/states", get(terminals_states))
        .route("/api/v1/layouts", get(layouts_list))
        .route("/api/v1/screenshot", post(screenshot_capture))
        .route("/api/v1/ui/settings", post(ui_toggle_settings))
        .route("/api/v1/ui/settings/navigate", post(ui_navigate_settings))
        .route("/api/v1/settings/app-theme", put(settings_set_app_theme))
        .route(
            "/api/v1/settings/profile-defaults",
            put(settings_set_profile_defaults),
        )
        .route(
            "/api/v1/settings/profiles/{index}",
            put(settings_update_profile),
        )
        .route(
            "/api/v1/ui/notifications",
            post(ui_toggle_notification_panel),
        )
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ---- API self-description ----

async fn api_docs() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "Laymux IDE Automation API",
        "version": "v1",
        "description": "Programmatic control of Laymux IDE. All endpoints are localhost-only (127.0.0.1). No authentication required.",
        "base_url": "http://127.0.0.1:{port}/api/v1",
        "discovery": format!("Fixed port: release={RELEASE_PORT}, dev={DEV_PORT}. Discovery file: %APPDATA%/laymux/automation.json (release) or %APPDATA%/laymux-dev/automation.json (dev) on Windows, ~/.config/laymux/ or ~/.config/laymux-dev/ on Linux. Also available via LX_AUTOMATION_PORT env var in spawned terminals."),
        "endpoints": [
            {
                "method": "GET", "path": "/api/v1/health",
                "description": "Health check. Returns status, version, port."
            },
            {
                "method": "GET", "path": "/api/v1/docs",
                "description": "This endpoint. Returns full API documentation as JSON."
            },
            {
                "method": "GET", "path": "/api/v1/workspaces",
                "description": "List all workspaces with their pane layouts.",
                "response": "{ workspaces: [...], activeWorkspaceId: string }"
            },
            {
                "method": "GET", "path": "/api/v1/workspaces/active",
                "description": "Get the currently active workspace with full pane details.",
                "response": "{ workspace: { id, name, panes: [...] } }"
            },
            {
                "method": "POST", "path": "/api/v1/workspaces/active",
                "description": "Switch to a different workspace.",
                "body": { "id": "string — workspace ID" }
            },
            {
                "method": "POST", "path": "/api/v1/workspaces",
                "description": "Create a new workspace from a layout.",
                "body": { "name": "string", "layoutId": "string (optional) — layout to use as template" }
            },
            {
                "method": "PUT", "path": "/api/v1/workspaces/{id}",
                "description": "Rename a workspace.",
                "body": { "name": "string — new name" }
            },
            {
                "method": "POST", "path": "/api/v1/workspaces/reorder",
                "description": "Reorder workspaces by moving one before/after another.",
                "body": { "fromId": "string — workspace ID to move", "toId": "string — target workspace ID", "position": "string (optional) — 'top' (default) or 'bottom'" }
            },
            {
                "method": "DELETE", "path": "/api/v1/workspaces/{id}",
                "description": "Delete a workspace. Cannot delete the last one."
            },
            {
                "method": "POST", "path": "/api/v1/layouts/export",
                "description": "Export active workspace pane structure as a layout.",
                "body": { "name": "string (optional) — create new layout with this name", "layoutId": "string (optional) — overwrite existing layout" }
            },
            {
                "method": "GET", "path": "/api/v1/grid",
                "description": "Get grid state: editMode (bool), focusedPaneIndex (number|null)."
            },
            {
                "method": "POST", "path": "/api/v1/grid/edit-mode",
                "description": "Enable or disable grid edit mode.",
                "body": { "enabled": "boolean" }
            },
            {
                "method": "POST", "path": "/api/v1/grid/focus",
                "description": "Focus a specific pane by index.",
                "body": { "paneIndex": "number" }
            },
            {
                "method": "POST", "path": "/api/v1/grid/hover",
                "description": "Simulate hover on a workspace pane (for automation/screenshot). Pass null index to clear.",
                "body": { "index": "number|null" }
            },
            {
                "method": "POST", "path": "/api/v1/panes/split",
                "description": "Split a pane horizontally or vertically.",
                "body": { "paneIndex": "number", "direction": "\"horizontal\" | \"vertical\"" }
            },
            {
                "method": "DELETE", "path": "/api/v1/panes/{index}",
                "description": "Remove a pane. Adjacent pane absorbs the space."
            },
            {
                "method": "PUT", "path": "/api/v1/panes/{index}/view",
                "description": "Change the view type of a pane.",
                "body": { "type": "\"TerminalView\" | \"EmptyView\"", "profile": "(optional) string" }
            },
            {
                "method": "GET", "path": "/api/v1/docks",
                "description": "List all 4 dock areas (top/bottom/left/right) with their active views."
            },
            {
                "method": "PUT", "path": "/api/v1/docks/{position}/active-view",
                "description": "Set the active view of a dock. position: top|bottom|left|right.",
                "body": { "view": "\"WorkspaceSelectorView\" | \"SettingsView\"" }
            },
            {
                "method": "POST", "path": "/api/v1/docks/layout-mode/toggle",
                "description": "Toggle dock layout mode between horizontal and vertical."
            },
            {
                "method": "POST", "path": "/api/v1/docks/{position}/toggle",
                "description": "Toggle dock visibility. position: top|bottom|left|right."
            },
            {
                "method": "PUT", "path": "/api/v1/docks/{position}/size",
                "description": "Set dock size in pixels.",
                "body": { "size": "number — size in pixels (e.g. 240)" }
            },
            {
                "method": "PUT", "path": "/api/v1/docks/{position}/views",
                "description": "Set the views available in a dock.",
                "body": { "views": "[\"WorkspaceSelectorView\", \"SettingsView\"]" }
            },
            {
                "method": "GET", "path": "/api/v1/terminals",
                "description": "List all terminal instances with id, profile, syncGroup, workspaceId, label, cwd, branch, lastActivityAt, isFocused."
            },
            {
                "method": "POST", "path": "/api/v1/terminals/{id}/write",
                "description": "Send input to a terminal (like typing). Use \\r\\n for Enter.",
                "body": { "data": "string — text to send" }
            },
            {
                "method": "GET", "path": "/api/v1/terminals/{id}/output",
                "description": "Read recent terminal output from the ring buffer. Query param: ?lines=N (default 100).",
                "response": "{ output: string (raw with ANSI escapes), lines: number, bufferSize: number }"
            },
            {
                "method": "GET", "path": "/api/v1/notifications",
                "description": "List all notifications across workspaces. Each has: id, terminalId, workspaceId, message, level (info|error|warning|success), createdAt (ms), readAt (ms|null)."
            },
            {
                "method": "POST", "path": "/api/v1/notifications",
                "description": "Create a notification programmatically.",
                "body": { "terminalId": "string", "workspaceId": "string", "message": "string", "level": "(optional) info|error|warning|success" }
            },
            {
                "method": "POST", "path": "/api/v1/notifications/mark-read",
                "description": "Mark all unread notifications for a workspace as read.",
                "body": { "workspaceId": "string" }
            },
            {
                "method": "GET", "path": "/api/v1/workspaces/{id}/summary",
                "description": "Get aggregated workspace summary: branch, cwd, ports, unreadCount, latestNotification, hasUnread.",
                "response": "{ summary: { workspaceId, branch, cwd, ports, unreadCount, latestNotification, hasUnread } }"
            },
            {
                "method": "POST", "path": "/api/v1/terminals/{id}/focus",
                "description": "Set focus to a terminal. Clears focus from other terminals in the same workspace."
            },
            {
                "method": "GET", "path": "/api/v1/terminals/states",
                "description": "Get activity state for all terminals. Returns { states: { terminalId: { activity: {type, name?}, outputActive, lastOutputMsAgo } } }."
            },
            {
                "method": "GET", "path": "/api/v1/layouts",
                "description": "List available layouts."
            },
            {
                "method": "POST", "path": "/api/v1/screenshot",
                "description": "Capture a screenshot of the current UI. Saved to .screenshots/ dir.",
                "response": "{ path: string, filename: string, size: number }"
            },
            {
                "method": "POST", "path": "/api/v1/ui/settings",
                "description": "Toggle the settings modal open/closed."
            },
            {
                "method": "POST", "path": "/api/v1/ui/settings/navigate",
                "description": "Navigate within SettingsView to a section.",
                "body": { "section": "\"startup\" | \"profile-0\" | \"profile-1\" | \"colorSchemes\" | \"keybindings\"" }
            },
            {
                "method": "POST", "path": "/api/v1/ui/notifications",
                "description": "Toggle the notification panel overlay open/closed."
            },
            {
                "method": "POST", "path": "/api/v1/docks/{position}/split",
                "description": "Split a dock pane. position: top|bottom|left|right.",
                "body": { "paneId": "(optional) string — ID of the pane to split" }
            },
            {
                "method": "DELETE", "path": "/api/v1/docks/{position}/panes/{paneId}",
                "description": "Remove a pane from a dock. position: top|bottom|left|right."
            },
            {
                "method": "PUT", "path": "/api/v1/docks/{position}/panes/{paneId}/view",
                "description": "Set the view of a specific dock pane. position: top|bottom|left|right.",
                "body": { "view": "object — { type: ViewType, cwdSend?: bool, cwdReceive?: bool, ... }" }
            },
            {
                "method": "PUT", "path": "/api/v1/settings/app-theme",
                "description": "Set the application color theme.",
                "body": { "themeId": "string — theme ID (e.g. \"catppuccin-mocha\")" }
            },
            {
                "method": "PUT", "path": "/api/v1/settings/profile-defaults",
                "description": "Set default values for terminal profiles.",
                "body": "object — profile default settings"
            },
            {
                "method": "PUT", "path": "/api/v1/settings/profiles/{index}",
                "description": "Update a specific terminal profile by index.",
                "body": "object — profile fields to update"
            }
        ],
        "tips": [
            "Start by calling GET /api/v1/workspaces to understand the current state.",
            "Use POST /api/v1/screenshot to visually verify UI changes.",
            "Terminal IDs follow the pattern 'terminal-{paneId}'. Get pane IDs from the active workspace.",
            "Terminal output contains raw ANSI escape sequences. Parse or strip them as needed.",
            "All state-changing operations return immediately. Use screenshot to verify visual results."
        ]
    }))
}

// ---- Backend-only handlers ----

async fn health(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    let port = state
        .app_state
        .automation_port
        .lock()
        .ok()
        .and_then(|p| *p)
        .unwrap_or(0);
    Json(HealthResponse {
        status: "ok".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        port,
    })
}

async fn terminal_write(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<WriteBody>,
) -> impl IntoResponse {
    let ptys = match state.app_state.pty_handles.lock() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json("Lock error")),
            )
        }
    };

    match ptys.get(&id) {
        Some(handle) => match handle.write(body.data.as_bytes()) {
            Ok(()) => (StatusCode::OK, Json(ok_json("written"))),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err_json(&e))),
        },
        None => (
            StatusCode::NOT_FOUND,
            Json(err_json(&format!("Terminal '{id}' not found"))),
        ),
    }
}

async fn terminal_output(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> impl IntoResponse {
    let lines = query.lines.unwrap_or(100);
    let buffers = match state.app_state.output_buffers.lock() {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json("Lock error")),
            )
        }
    };

    match buffers.get(&id) {
        Some(buf) => {
            let output = buf.recent_lines(lines);
            let line_count = output.lines().count();
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "success": true,
                    "output": output,
                    "lines": line_count,
                    "bufferSize": buf.len(),
                })),
            )
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(err_json(&format!("Terminal '{id}' not found"))),
        ),
    }
}

// ---- Frontend-bridged handlers ----

/// Send a request to the frontend via Tauri event and wait for the response.
async fn bridge_request(
    state: &ServerState,
    category: &str,
    target: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, (StatusCode, Json<serde_json::Value>)> {
    let request_id = uuid::Uuid::new_v4().to_string();

    let (tx, rx) = tokio::sync::oneshot::channel();

    // Store the channel
    {
        let mut channels = state.app_state.automation_channels.lock().map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json("Lock error")),
            )
        })?;
        channels.insert(request_id.clone(), tx);
    }

    // Emit event to frontend
    let request = AutomationRequest {
        request_id: request_id.clone(),
        category: category.into(),
        target: target.into(),
        method: method.into(),
        params,
    };

    state
        .app_handle
        .emit("automation-request", &request)
        .map_err(|e| {
            // Clean up channel on emit failure
            if let Ok(mut channels) = state.app_state.automation_channels.lock() {
                channels.remove(&request_id);
            }
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json(&format!("Event emit error: {e}"))),
            )
        })?;

    // Wait for response with timeout
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(data)) => Ok(data),
        Ok(Err(_)) => {
            // Channel dropped without response — clean up orphaned entry
            if let Ok(mut channels) = state.app_state.automation_channels.lock() {
                channels.remove(&request_id);
            }
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(err_json("Frontend bridge not connected")),
            ))
        }
        Err(_) => {
            // Timeout
            if let Ok(mut channels) = state.app_state.automation_channels.lock() {
                channels.remove(&request_id);
            }
            Err((
                StatusCode::GATEWAY_TIMEOUT,
                Json(err_json("Frontend response timeout")),
            ))
        }
    }
}

// -- Workspace endpoints --

async fn workspaces_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "workspaces", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_get_active(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(
        &state,
        "query",
        "workspaces",
        "getActive",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_switch_active(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<SwitchWorkspaceBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "workspaces",
        "switchActive",
        serde_json::json!({ "id": body.id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_create(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<CreateWorkspaceBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "workspaces",
        "add",
        serde_json::json!({ "name": body.name, "layoutId": body.layout_id }),
    )
    .await
    {
        Ok(data) => (StatusCode::CREATED, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_rename(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<RenameWorkspaceBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "workspaces",
        "rename",
        serde_json::json!({ "id": id, "name": body.name }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_delete(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "workspaces",
        "remove",
        serde_json::json!({ "id": id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_reorder(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let from_id = body.get("fromId").and_then(|v| v.as_str()).unwrap_or("");
    let to_id = body.get("toId").and_then(|v| v.as_str()).unwrap_or("");
    let position = body
        .get("position")
        .and_then(|v| v.as_str())
        .unwrap_or("top");
    match bridge_request(
        &state,
        "action",
        "workspaces",
        "reorder",
        serde_json::json!({ "fromId": from_id, "toId": to_id, "position": position }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn layouts_export(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<ExportLayoutBody>,
) -> impl IntoResponse {
    let name = body.name.as_deref().unwrap_or("");
    let layout_id = body.layout_id.as_deref().unwrap_or("");
    if layout_id.is_empty() && name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({"error": "either 'name' (to create new) or 'layoutId' (to overwrite) is required"}),
            ),
        );
    }
    let (action, params) = if !layout_id.is_empty() {
        ("exportTo", serde_json::json!({ "layoutId": layout_id }))
    } else {
        ("exportNew", serde_json::json!({ "name": name }))
    };
    match bridge_request(&state, "action", "layouts", action, params).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Grid endpoints --

async fn grid_get_state(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "grid", "getState", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn grid_set_edit_mode(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<EditModeBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "grid",
        "setEditMode",
        serde_json::json!({ "enabled": body.enabled }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn grid_focus_pane(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<FocusPaneBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "grid",
        "focusPane",
        serde_json::json!({ "index": body.pane_index }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn grid_simulate_hover(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<SimulateHoverBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "grid",
        "simulateHover",
        serde_json::json!({ "index": body.index }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Pane endpoints --

async fn panes_split(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<SplitPaneBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "panes",
        "split",
        serde_json::json!({ "paneIndex": body.pane_index, "direction": body.direction }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn panes_remove(
    AxumState(state): AxumState<ServerState>,
    Path(index): Path<usize>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "panes",
        "remove",
        serde_json::json!({ "paneIndex": index }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn panes_set_view(
    AxumState(state): AxumState<ServerState>,
    Path(index): Path<usize>,
    Json(body): Json<SetViewBody>,
) -> impl IntoResponse {
    let mut view_config = body.extra;
    view_config.insert("type".into(), serde_json::Value::String(body.view_type));

    match bridge_request(
        &state,
        "action",
        "panes",
        "setView",
        serde_json::json!({ "paneIndex": index, "view": view_config }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Dock endpoints --

async fn docks_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "docks", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_set_active_view(
    AxumState(state): AxumState<ServerState>,
    Path(position): Path<String>,
    Json(body): Json<SetDockViewBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "docks",
        "setActiveView",
        serde_json::json!({ "position": position, "view": body.view }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_toggle_layout_mode(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "docks",
        "toggleLayoutMode",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_toggle_visible(
    AxumState(state): AxumState<ServerState>,
    Path(position): Path<String>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "docks",
        "toggleVisible",
        serde_json::json!({ "position": position }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_set_size(
    AxumState(state): AxumState<ServerState>,
    Path(position): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let size = body.get("size").and_then(|v| v.as_f64()).unwrap_or(240.0);
    match bridge_request(
        &state,
        "action",
        "docks",
        "setSize",
        serde_json::json!({ "position": position, "size": size }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_set_views(
    AxumState(state): AxumState<ServerState>,
    Path(position): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let views = body.get("views").cloned().unwrap_or(serde_json::json!([]));
    match bridge_request(
        &state,
        "action",
        "docks",
        "setViews",
        serde_json::json!({ "position": position, "views": views }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_split_pane(
    AxumState(state): AxumState<ServerState>,
    Path(position): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let pane_id = body
        .get("paneId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    match bridge_request(
        &state,
        "action",
        "docks",
        "splitPane",
        serde_json::json!({ "position": position, "paneId": pane_id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_remove_pane(
    AxumState(state): AxumState<ServerState>,
    Path((position, pane_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "docks",
        "removeDockPane",
        serde_json::json!({ "position": position, "paneId": pane_id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn docks_set_pane_view(
    AxumState(state): AxumState<ServerState>,
    Path((position, pane_id)): Path<(String, String)>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let view = body
        .get("view")
        .cloned()
        .unwrap_or(serde_json::json!({"type": "EmptyView"}));
    match bridge_request(
        &state,
        "action",
        "docks",
        "setDockPaneView",
        serde_json::json!({ "position": position, "paneId": pane_id, "view": view }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Terminal list (frontend-bridged for instance metadata) --

async fn terminals_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "terminals", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Terminal states (backend-direct, no frontend bridge needed) --

async fn terminals_states(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    let states = crate::commands::detect_all_terminal_states(&state.app_state);
    (
        StatusCode::OK,
        Json(serde_json::json!({ "states": states })),
    )
}

// -- Notifications --

async fn notifications_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(
        &state,
        "query",
        "notifications",
        "list",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn notifications_add(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<AddNotificationBody>,
) -> impl IntoResponse {
    let mut params = serde_json::json!({
        "terminalId": body.terminal_id,
        "workspaceId": body.workspace_id,
        "message": body.message,
    });
    if let Some(level) = body.level {
        params["level"] = serde_json::Value::String(level);
    }
    match bridge_request(&state, "action", "notifications", "add", params).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn notifications_mark_read(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<MarkReadBody>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "notifications",
        "markRead",
        serde_json::json!({ "workspaceId": body.workspace_id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn workspaces_get_summary(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "query",
        "workspaces",
        "getSummary",
        serde_json::json!({ "id": id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn terminals_set_focus(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "terminals",
        "setFocus",
        serde_json::json!({ "id": id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Layouts --

async fn layouts_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "layouts", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- UI actions --

async fn ui_toggle_settings(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "ui",
        "toggleSettings",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn ui_navigate_settings(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let section = body
        .get("section")
        .and_then(|v| v.as_str())
        .unwrap_or("startup");
    match bridge_request(
        &state,
        "action",
        "ui",
        "navigateSettings",
        serde_json::json!({ "section": section }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn settings_set_app_theme(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let theme_id = body
        .get("themeId")
        .and_then(|v| v.as_str())
        .unwrap_or("catppuccin-mocha");
    match bridge_request(
        &state,
        "action",
        "settings",
        "setAppTheme",
        serde_json::json!({ "themeId": theme_id }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn settings_set_profile_defaults(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    match bridge_request(&state, "action", "settings", "setProfileDefaults", body).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn settings_update_profile(
    AxumState(state): AxumState<ServerState>,
    Path(index): Path<usize>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "settings",
        "updateProfile",
        serde_json::json!({ "index": index, "data": body }),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

async fn ui_toggle_notification_panel(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
    match bridge_request(
        &state,
        "action",
        "ui",
        "toggleNotificationPanel",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- Screenshot --

async fn screenshot_capture(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    // Request screenshot from frontend
    let data = match bridge_request(
        &state,
        "action",
        "screenshot",
        "capture",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => data,
        Err(e) => return e,
    };

    // Extract base64 data URL from frontend response
    let data_url = match data.get("dataUrl").and_then(|v| v.as_str()) {
        Some(url) => url.to_string(),
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json("No dataUrl in screenshot response")),
            )
        }
    };

    // Strip "data:image/png;base64," prefix
    let base64_data = data_url
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&data_url);

    // Decode base64 to bytes
    use std::io::Write;
    let bytes = match base64_decode(base64_data) {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json(&format!("Base64 decode error: {e}"))),
            )
        }
    };

    // Save to .screenshots/ in the project root (parent of src-tauri/)
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let screenshots_dir = project_root.join(".screenshots");
    let _ = std::fs::create_dir_all(&screenshots_dir);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("screenshot_{timestamp}.png");
    let filepath = screenshots_dir.join(&filename);

    match std::fs::File::create(&filepath).and_then(|mut f| f.write_all(&bytes)) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "success": true,
                "path": filepath.to_string_lossy(),
                "filename": filename,
                "size": bytes.len(),
                "dataUrl": data_url,
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&format!("File write error: {e}"))),
        ),
    }
}

/// Simple base64 decoder (no external crate needed).
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("Invalid base64 char: {c}")),
        }
    }

    let input: Vec<u8> = input
        .bytes()
        .filter(|&b| b != b'\n' && b != b'\r' && b != b' ')
        .collect();
    let mut out = Vec::with_capacity(input.len() * 3 / 4);

    let chunks = input.chunks(4);
    for chunk in chunks {
        let len = chunk.iter().filter(|&&b| b != b'=').count();
        if len < 2 {
            break;
        }

        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        out.push((a << 2) | (b >> 4));

        if len > 2 {
            let c = val(chunk[2])?;
            out.push((b << 4) | (c >> 2));
            if len > 3 {
                let d = val(chunk[3])?;
                out.push((c << 6) | d);
            }
        }
    }

    let _ = TABLE; // suppress unused warning
    Ok(out)
}

// ---- Helpers ----

fn ok_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "success": true, "message": msg })
}

fn err_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "success": false, "error": msg })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_response_format() {
        let resp = HealthResponse {
            status: "ok".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            port: 19280,
        };
        assert_eq!(resp.status, "ok");
        assert_eq!(resp.port, 19280);
    }

    #[test]
    fn automation_request_serializes() {
        let req = AutomationRequest {
            request_id: "abc-123".into(),
            category: "query".into(),
            target: "workspaces".into(),
            method: "list".into(),
            params: serde_json::json!({}),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("requestId"));
        assert!(json.contains("workspaces"));
    }

    #[test]
    fn automation_request_round_trip() {
        let req = AutomationRequest {
            request_id: "test-id".into(),
            category: "action".into(),
            target: "grid".into(),
            method: "setEditMode".into(),
            params: serde_json::json!({ "enabled": true }),
        };
        let json = serde_json::to_string(&req).unwrap();
        let deserialized: AutomationRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.request_id, "test-id");
        assert_eq!(deserialized.target, "grid");
        assert_eq!(deserialized.params["enabled"], true);
    }

    #[test]
    fn automation_response_deserializes() {
        let json = r#"{"requestId":"abc-123","success":true,"data":{"test":1},"error":null}"#;
        let resp: AutomationResponse = serde_json::from_str(json).unwrap();
        assert!(resp.success);
        assert_eq!(resp.request_id, "abc-123");
        assert!(resp.data.is_some());
    }

    #[test]
    fn automation_response_error() {
        let json = r#"{"requestId":"err-1","success":false,"data":null,"error":"not found"}"#;
        let resp: AutomationResponse = serde_json::from_str(json).unwrap();
        assert!(!resp.success);
        assert_eq!(resp.error.unwrap(), "not found");
    }

    #[test]
    fn ok_json_format() {
        let j = ok_json("done");
        assert_eq!(j["success"], true);
        assert_eq!(j["message"], "done");
    }

    #[test]
    fn err_json_format() {
        let j = err_json("fail");
        assert_eq!(j["success"], false);
        assert_eq!(j["error"], "fail");
    }

    #[test]
    fn write_body_deserializes() {
        let json = r#"{"data":"ls -la\n"}"#;
        let body: WriteBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.data, "ls -la\n");
    }

    #[test]
    fn output_query_defaults() {
        let query: OutputQuery = serde_json::from_str("{}").unwrap();
        assert_eq!(query.lines, None);
    }

    #[test]
    fn split_pane_body_deserializes() {
        let json = r#"{"paneIndex":0,"direction":"vertical"}"#;
        let body: SplitPaneBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.pane_index, 0);
        assert_eq!(body.direction, "vertical");
    }

    #[test]
    fn automation_port_returns_dev_in_debug() {
        // In test builds (debug_assertions=true), should return DEV_PORT
        assert_eq!(automation_port(), DEV_PORT);
        assert_eq!(automation_port(), 19281);
    }

    #[test]
    fn port_constants_are_adjacent() {
        assert_eq!(DEV_PORT, RELEASE_PORT + 1);
    }

    #[test]
    fn discovery_file_path_ends_with_automation_json() {
        let path = discovery_file_path();
        assert!(path.to_string_lossy().ends_with("automation.json"));
    }

    #[test]
    fn base64_decode_simple() {
        let encoded = "SGVsbG8="; // "Hello"
        let decoded = base64_decode(encoded).unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn base64_decode_no_padding() {
        let encoded = "SGk"; // "Hi"
        let decoded = base64_decode(encoded).unwrap();
        assert_eq!(decoded, b"Hi");
    }

    #[test]
    fn write_and_remove_discovery_file() {
        write_discovery_file(19280);
        let path = discovery_file_path();
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["port"], 19280);
        assert!(parsed["pid"].as_u64().unwrap() > 0);
        remove_discovery_file();
        assert!(!path.exists());
    }

    /// Extract documented (method, path) pairs from the api_docs JSON.
    fn get_documented_routes() -> std::collections::HashSet<(String, String)> {
        // Build the docs JSON the same way the handler does
        let rt = tokio::runtime::Runtime::new().unwrap();
        let response = rt.block_on(async {
            let resp = api_docs().await;
            // Extract Json body
            use axum::response::IntoResponse;
            let response = resp.into_response();
            let body = axum::body::to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap();
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()
        });

        let endpoints = response["endpoints"].as_array().unwrap();
        endpoints
            .iter()
            .map(|ep| {
                (
                    ep["method"].as_str().unwrap().to_string(),
                    ep["path"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[test]
    fn docs_covers_all_registered_routes() {
        let documented = get_documented_routes();

        let mut missing = Vec::new();
        for (method, path) in REGISTERED_ROUTES {
            let key = (method.to_string(), path.to_string());
            if !documented.contains(&key) {
                missing.push(format!("{} {}", method, path));
            }
        }

        assert!(
            missing.is_empty(),
            "Routes registered but NOT documented in api_docs:\n  {}",
            missing.join("\n  ")
        );
    }

    #[test]
    fn add_notification_body_deserializes() {
        let json =
            r#"{"terminalId":"t1","workspaceId":"ws-1","message":"Build done","level":"success"}"#;
        let body: AddNotificationBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.terminal_id, "t1");
        assert_eq!(body.workspace_id, "ws-1");
        assert_eq!(body.message, "Build done");
        assert_eq!(body.level.unwrap(), "success");
    }

    #[test]
    fn add_notification_body_without_level() {
        let json = r#"{"terminalId":"t1","workspaceId":"ws-1","message":"info msg"}"#;
        let body: AddNotificationBody = serde_json::from_str(json).unwrap();
        assert!(body.level.is_none());
    }

    #[test]
    fn mark_read_body_deserializes() {
        let json = r#"{"workspaceId":"ws-1"}"#;
        let body: MarkReadBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.workspace_id, "ws-1");
    }

    #[test]
    fn focus_terminal_body_deserializes() {
        let json = r#"{"id":"terminal-1"}"#;
        let body: FocusTerminalBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.id, "terminal-1");
    }

    #[test]
    fn docs_has_no_phantom_routes() {
        let documented = get_documented_routes();
        let registered: std::collections::HashSet<(String, String)> = REGISTERED_ROUTES
            .iter()
            .map(|(m, p)| (m.to_string(), p.to_string()))
            .collect();

        let mut phantom = Vec::new();
        for (method, path) in &documented {
            if !registered.contains(&(method.clone(), path.clone())) {
                phantom.push(format!("{} {}", method, path));
            }
        }

        assert!(
            phantom.is_empty(),
            "Routes documented but NOT registered in router:\n  {}",
            phantom.join("\n  ")
        );
    }
}
