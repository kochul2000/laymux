use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;
use tauri::Emitter;

use crate::automation_server::helpers::bridge_request;
use crate::automation_server::ServerState;
use crate::constants::EVENT_WORKSPACE_STATE_CHANGED;

use super::lease::require_active_lease;
use super::navigation::build_remote_navigation_payload;
use super::routes::REMOTE_LEASE_HEADER;
use super::terminal_info::remote_terminal_infos;
use super::{internal_error, json_error};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceSwitchRequest {
    id: String,
    lease_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalFocusRequest {
    lease_id: Option<String>,
}

pub(super) async fn remote_navigation(State(server): State<ServerState>) -> Response {
    let workspaces_data = match frontend_bridge_json(
        &server,
        "query",
        "workspaces",
        "list",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => data,
        Err(response) => return response,
    };
    let active_workspace_data = match frontend_bridge_json(
        &server,
        "query",
        "workspaces",
        "getActive",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => data,
        Err(response) => return response,
    };
    let docks_data = match frontend_bridge_json(
        &server,
        "query",
        "docks",
        "list",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => data,
        Err(response) => return response,
    };
    let terminal_instances_data =
        match frontend_bridge_json(&server, "query", "terminals", "list", serde_json::json!({}))
            .await
        {
            Ok(data) => data,
            Err(response) => return response,
        };

    let settings = crate::settings::load_settings();
    let terminals = match remote_terminal_infos(&server.app_state, &settings) {
        Ok(terminals) => terminals,
        Err(err) => return internal_error(err),
    };

    Json(build_remote_navigation_payload(
        &workspaces_data,
        &active_workspace_data,
        &docks_data,
        &terminal_instances_data,
        &terminals,
    ))
    .into_response()
}

pub(super) async fn remote_workspace_switch_active(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceSwitchRequest>,
) -> Response {
    let workspace_id = body.id;
    if workspace_id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "workspace id is required");
    }

    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    match frontend_bridge_json(
        &server,
        "action",
        "workspaces",
        "switchActive",
        serde_json::json!({ "id": workspace_id.clone() }),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.workspaces.switchActive",
                serde_json::json!({ "id": workspace_id }),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

pub(super) async fn remote_terminal_focus(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalFocusRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    match frontend_bridge_json(
        &server,
        "action",
        "terminals",
        "setFocus",
        serde_json::json!({ "id": id.clone() }),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.terminals.setFocus",
                serde_json::json!({ "id": id }),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

async fn frontend_bridge_json(
    server: &ServerState,
    category: &str,
    target: &str,
    method: &str,
    params: Value,
) -> Result<Value, Response> {
    match bridge_request(server, category, target, method, params).await {
        Ok(data) => {
            if data.get("success").and_then(Value::as_bool) == Some(false) {
                let message = data
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("frontend bridge request failed");
                return Err(json_error(StatusCode::BAD_GATEWAY, message));
            }
            Ok(data)
        }
        Err(error) => Err(error.into_response()),
    }
}

fn emit_workspace_state_changed(server: &ServerState, source: &str, detail: Value) {
    let payload = serde_json::json!({ "source": source, "detail": detail });
    if let Err(error) = server
        .app_handle
        .emit(EVENT_WORKSPACE_STATE_CHANGED, payload)
    {
        tracing::warn!(
            error = %error,
            source,
            "failed to emit workspace-state-changed after remote action"
        );
    }
}

fn lease_id_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REMOTE_LEASE_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}
