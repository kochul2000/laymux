//! Stable content-id Remote close action (ADR-0322).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::automation_server::ServerState;

use super::json_error;
use super::lease::require_active_lease;
use super::navigation_routes::{
    emit_workspace_state_changed, frontend_bridge_json, lease_id_from_headers,
};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaneCloseRequest {
    lease_id: Option<String>,
}

fn close_request_from_body(body: &[u8]) -> Result<PaneCloseRequest, serde_json::Error> {
    if body.iter().all(u8::is_ascii_whitespace) {
        Ok(PaneCloseRequest::default())
    } else {
        serde_json::from_slice(body)
    }
}

pub(super) async fn remote_pane_close(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    close_item(&server, id, headers, body, false).await
}

pub(super) async fn remote_workspace_close(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    close_item(&server, id, headers, body, true).await
}

async fn close_item(
    server: &ServerState,
    id: String,
    headers: HeaderMap,
    body: axum::body::Bytes,
    workspace: bool,
) -> Response {
    if id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "pane id is required");
    }
    let request = match close_request_from_body(&body) {
        Ok(request) => request,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid close request"),
    };
    let lease_id = request
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }
    match frontend_bridge_json(
        server,
        "action",
        if workspace { "workspaces" } else { "panes" },
        if workspace { "remove" } else { "closeById" },
        if workspace {
            serde_json::json!({ "id": id })
        } else {
            serde_json::json!({ "paneId": id })
        },
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                server,
                if workspace {
                    "remote.workspaces.close"
                } else {
                    "remote.panes.close"
                },
                serde_json::json!({ "id": id }),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_body_supports_header_lease_and_rejects_invalid_json() {
        assert!(close_request_from_body(b" ").unwrap().lease_id.is_none());
        assert_eq!(
            close_request_from_body(br#"{"leaseId":"controller"}"#)
                .unwrap()
                .lease_id
                .as_deref(),
            Some("controller")
        );
        assert!(close_request_from_body(b"{").is_err());
    }
}
