use axum::body::Bytes;
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NotificationActionRequest {
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
    let notifications_data = match frontend_bridge_json(
        &server,
        "query",
        "notifications",
        "list",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => data,
        Err(response) => return response,
    };
    let ui_state_data =
        match frontend_bridge_json(&server, "query", "ui", "state", serde_json::json!({})).await {
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
        &notifications_data,
        &ui_state_data,
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
            if let Err(response) = frontend_bridge_json(
                &server,
                "action",
                "notifications",
                "markRead",
                serde_json::json!({ "workspaceId": workspace_id.clone() }),
            )
            .await
            {
                tracing::debug!(
                    workspace_id,
                    "failed to mark remote workspace notifications read: {:?}",
                    response.status()
                );
            }
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
    body: Bytes,
) -> Response {
    let body = match terminal_focus_request_from_body(&body) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };
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
            if let Err(response) = frontend_bridge_json(
                &server,
                "action",
                "notifications",
                "markTerminalRead",
                serde_json::json!({ "terminalId": id.clone() }),
            )
            .await
            {
                tracing::debug!(
                    terminal_id = %id,
                    "failed to mark remote terminal notifications read: {:?}",
                    response.status()
                );
            }
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

pub(super) async fn remote_notification_mark_read(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "notification id is required");
    }
    let body = match notification_action_request_from_body(&body) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };
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
        "notifications",
        "markIdsRead",
        serde_json::json!({ "ids": [id.clone()] }),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.notifications.markRead",
                serde_json::json!({ "id": id }),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

pub(super) async fn remote_notifications_mark_all_read(
    State(server): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match notification_action_request_from_body(&body) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };
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
        "notifications",
        "markAllRead",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.notifications.markAllRead",
                serde_json::json!({}),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

pub(super) async fn remote_notifications_clear(
    State(server): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match notification_action_request_from_body(&body) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    let notifications_data = match frontend_bridge_json(
        &server,
        "query",
        "notifications",
        "list",
        serde_json::json!({}),
    )
    .await
    {
        Ok(data) => data,
        Err(response) => return response,
    };
    let ids = notification_ids(&notifications_data);
    if ids.is_empty() {
        return Json(serde_json::json!({ "cleared": 0 })).into_response();
    }

    match frontend_bridge_json(
        &server,
        "action",
        "notifications",
        "clear",
        serde_json::json!({ "ids": ids }),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.notifications.clear",
                serde_json::json!({}),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

pub(super) async fn frontend_bridge_json(
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

pub(super) fn emit_workspace_state_changed(server: &ServerState, source: &str, detail: Value) {
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

pub(super) fn lease_id_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REMOTE_LEASE_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn terminal_focus_request_from_body(
    body: &[u8],
) -> Result<TerminalFocusRequest, serde_json::Error> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(TerminalFocusRequest::default());
    }
    serde_json::from_slice(body)
}

fn notification_action_request_from_body(
    body: &[u8],
) -> Result<NotificationActionRequest, serde_json::Error> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(NotificationActionRequest::default());
    }
    serde_json::from_slice(body)
}

fn notification_ids(notifications_data: &Value) -> Vec<String> {
    notifications_data
        .get("notifications")
        .and_then(Value::as_array)
        .map(|notifications| {
            notifications
                .iter()
                .filter_map(|notification| {
                    notification
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::*;

    #[test]
    fn terminal_focus_request_accepts_empty_body_for_header_lease() {
        let body = terminal_focus_request_from_body(b"").unwrap();
        assert!(body.lease_id.is_none());

        let body = terminal_focus_request_from_body(b" \n\t").unwrap();
        assert!(body.lease_id.is_none());
    }

    #[test]
    fn terminal_focus_request_reads_body_lease() {
        let body = terminal_focus_request_from_body(br#"{"leaseId":"lease-body"}"#).unwrap();
        assert_eq!(body.lease_id.as_deref(), Some("lease-body"));
    }

    #[test]
    fn terminal_focus_header_lease_is_available_without_body_lease() {
        let mut headers = HeaderMap::new();
        headers.insert(
            REMOTE_LEASE_HEADER,
            HeaderValue::from_static("lease-header"),
        );

        assert_eq!(lease_id_from_headers(&headers), Some("lease-header"));
    }

    #[test]
    fn notification_action_request_accepts_empty_body_for_header_lease() {
        let body = notification_action_request_from_body(b"").unwrap();
        assert!(body.lease_id.is_none());

        let body = notification_action_request_from_body(b" \n\t").unwrap();
        assert!(body.lease_id.is_none());
    }

    #[test]
    fn notification_ids_ignores_missing_and_empty_ids() {
        let ids = notification_ids(&serde_json::json!({
            "notifications": [
                { "id": "n1" },
                { "id": "" },
                { "message": "missing" },
                { "id": "n2" }
            ]
        }));

        assert_eq!(ids, vec!["n1", "n2"]);
    }
}
