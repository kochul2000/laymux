//! Stable content-id Remote pane/workspace actions: close (ADR-0322) and
//! stack (ADR-0327).

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
struct ItemActionRequest {
    lease_id: Option<String>,
}

fn action_request_from_body(body: &[u8]) -> Result<ItemActionRequest, serde_json::Error> {
    if body.iter().all(u8::is_ascii_whitespace) {
        Ok(ItemActionRequest::default())
    } else {
        serde_json::from_slice(body)
    }
}

/// A lease-gated action on one pane or workspace, run by the desktop through
/// the frontend bridge.
#[derive(Clone, Copy)]
enum ItemAction {
    ClosePane,
    CloseWorkspace,
    StackPane,
}

impl ItemAction {
    fn bridge_category(self) -> &'static str {
        match self {
            Self::CloseWorkspace => "workspaces",
            Self::ClosePane | Self::StackPane => "panes",
        }
    }

    fn bridge_action(self) -> &'static str {
        match self {
            Self::ClosePane => "closeById",
            Self::CloseWorkspace => "remove",
            Self::StackPane => "stackById",
        }
    }

    fn bridge_params(self, id: &str) -> serde_json::Value {
        match self {
            Self::CloseWorkspace => serde_json::json!({ "id": id }),
            Self::ClosePane | Self::StackPane => serde_json::json!({ "paneId": id }),
        }
    }

    fn change_source(self) -> &'static str {
        match self {
            Self::ClosePane => "remote.panes.close",
            Self::CloseWorkspace => "remote.workspaces.close",
            Self::StackPane => "remote.panes.stack",
        }
    }

    fn invalid_body_message(self) -> &'static str {
        match self {
            Self::ClosePane | Self::CloseWorkspace => "invalid close request",
            Self::StackPane => "invalid stack request",
        }
    }
}

pub(super) async fn remote_pane_close(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    run_item_action(&server, id, headers, body, ItemAction::ClosePane).await
}

pub(super) async fn remote_workspace_close(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    run_item_action(&server, id, headers, body, ItemAction::CloseWorkspace).await
}

/// Stack a terminal inheriting pane `id`'s profile and CWD (ADR-0339).
pub(super) async fn remote_pane_stack(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    run_item_action(&server, id, headers, body, ItemAction::StackPane).await
}

async fn run_item_action(
    server: &ServerState,
    id: String,
    headers: HeaderMap,
    body: axum::body::Bytes,
    action: ItemAction,
) -> Response {
    if id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "pane id is required");
    }
    let request = match action_request_from_body(&body) {
        Ok(request) => request,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, action.invalid_body_message()),
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
        action.bridge_category(),
        action.bridge_action(),
        action.bridge_params(&id),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                server,
                action.change_source(),
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
    fn action_body_supports_header_lease_and_rejects_invalid_json() {
        assert!(action_request_from_body(b" ").unwrap().lease_id.is_none());
        assert_eq!(
            action_request_from_body(br#"{"leaseId":"controller"}"#)
                .unwrap()
                .lease_id
                .as_deref(),
            Some("controller")
        );
        assert!(action_request_from_body(b"{").is_err());
    }

    #[test]
    fn stack_runs_the_desktop_stack_by_pane_id() {
        let action = ItemAction::StackPane;
        assert_eq!(action.bridge_category(), "panes");
        assert_eq!(action.bridge_action(), "stackById");
        assert_eq!(
            action.bridge_params("pane-1"),
            serde_json::json!({ "paneId": "pane-1" })
        );
        assert_eq!(action.change_source(), "remote.panes.stack");
    }
}
