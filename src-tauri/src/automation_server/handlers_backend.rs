use axum::extract::{Path, Query, State as AxumState};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::lock_ext::MutexExt;

use super::helpers::{err_json, ok_json};
use super::types::{HealthResponse, OutputQuery, WriteBody};
use super::ServerState;

// ---- API self-description ----

pub async fn api_docs() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "Laymux IDE Automation API",
        "version": "v1",
        "description": "Programmatic control of Laymux IDE. Binds to 0.0.0.0 (WSL2 access). Requires Bearer token from discovery file.",
        "base_url": format!("http://127.0.0.1:{}/api/v1", super::automation_port()),
        "auth": "Bearer token required. Read 'key' from discovery file and send as: Authorization: Bearer <key>. GET /api/v1/health is exempt.",
        "discovery": format!("Fixed port: release={}, dev={}. Discovery file: %APPDATA%/laymux/automation.json (release) or %APPDATA%/laymux-dev/automation.json (dev) on Windows, ~/.config/laymux/ or ~/.config/laymux-dev/ on Linux. Contains port, key, pid. Also LX_AUTOMATION_PORT env var in spawned terminals.", super::RELEASE_PORT, super::DEV_PORT),
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
                "description": "Get activity state for all terminals. Returns { states: { terminalId: { activity: {type, name?} } } }."
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
            },
            {
                "method": "*", "path": "/mcp",
                "description": "MCP (Model Context Protocol) Streamable HTTP endpoint (stateful, session-based). POST: send JSON-RPC 2.0 requests (initialize, tools/list, tools/call, ping). After initialize, include the Mcp-Session-Id header from the response in all subsequent requests. GET: open SSE stream for server-initiated notifications. DELETE: terminate session. 15 tools available for terminal, workspace, grid, and utility operations."
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

pub async fn health(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    let port = state
        .app_state
        .automation_port
        .lock_or_err()
        .ok()
        .and_then(|p| *p)
        .unwrap_or(0);
    Json(HealthResponse {
        status: "ok".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        port,
    })
}

pub async fn terminal_write(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<WriteBody>,
) -> impl IntoResponse {
    let ptys = match state.app_state.pty_handles.lock_or_err() {
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

pub async fn terminal_output(
    AxumState(state): AxumState<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<OutputQuery>,
) -> impl IntoResponse {
    let lines = query.lines.unwrap_or(100);
    let buffers = match state.app_state.output_buffers.lock_or_err() {
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

pub async fn terminals_states(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    let states = crate::activity::detect_all_terminal_states(&state.app_state);
    (
        StatusCode::OK,
        Json(serde_json::json!({ "states": states })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation_server::types::REGISTERED_ROUTES;

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

    /// Extract documented (method, path) pairs from the api_docs JSON.
    fn get_documented_routes() -> std::collections::HashSet<(String, String)> {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let response = rt.block_on(async {
            let resp = api_docs().await;
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
