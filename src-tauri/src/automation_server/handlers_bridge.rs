use axum::extract::{Path, State as AxumState};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::helpers::{bridge_request, err_json};
use super::types::*;
use super::ServerState;

// -- Workspace endpoints --

pub async fn workspaces_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "workspaces", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

pub async fn workspaces_get_active(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
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

pub async fn workspaces_switch_active(
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

pub async fn workspaces_create(
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

pub async fn workspaces_rename(
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

pub async fn workspaces_delete(
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

pub async fn workspaces_reorder(
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

pub async fn layouts_export(
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

pub async fn grid_get_state(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "grid", "getState", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

pub async fn grid_set_edit_mode(
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

pub async fn grid_focus_pane(
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

pub async fn grid_simulate_hover(
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

pub async fn panes_split(
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

pub async fn panes_remove(
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

pub async fn panes_set_view(
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

pub async fn docks_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "docks", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

pub async fn docks_set_active_view(
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

pub async fn docks_toggle_layout_mode(
    AxumState(state): AxumState<ServerState>,
) -> impl IntoResponse {
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

pub async fn docks_toggle_visible(
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

pub async fn docks_set_size(
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

pub async fn docks_set_views(
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

pub async fn docks_split_pane(
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

pub async fn docks_remove_pane(
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

pub async fn docks_set_pane_view(
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

// -- Notifications --

pub async fn notifications_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
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

pub async fn notifications_add(
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

pub async fn notifications_mark_read(
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

pub async fn workspaces_get_summary(
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

pub async fn terminals_set_focus(
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

pub async fn layouts_list(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    match bridge_request(&state, "query", "layouts", "list", serde_json::json!({})).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

// -- UI actions --

pub async fn ui_toggle_settings(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
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

pub async fn ui_navigate_settings(
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

pub async fn settings_set_app_theme(
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

pub async fn settings_set_profile_defaults(
    AxumState(state): AxumState<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    match bridge_request(&state, "action", "settings", "setProfileDefaults", body).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => e,
    }
}

pub async fn settings_update_profile(
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

pub async fn ui_toggle_notification_panel(
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

pub async fn screenshot_capture(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
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
    let bytes = match super::helpers::base64_decode(base64_data) {
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
