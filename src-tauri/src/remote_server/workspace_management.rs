use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::automation_server::ServerState;

use super::json_error;
use super::lease::require_active_lease;
use super::navigation_routes::{emit_workspace_state_changed, frontend_bridge_json};
use super::routes::REMOTE_LEASE_HEADER;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceRenameRequest {
    name: String,
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceTemplateRequest {
    workspace_id: String,
    name: String,
    lease_id: Option<String>,
}

pub(super) async fn remote_workspace_template_save(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceTemplateRequest>,
) -> Response {
    if body.workspace_id.trim().is_empty() || body.name.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "workspace id and template name are required",
        );
    }
    let lease_id = body.lease_id.as_deref().or_else(|| {
        headers
            .get(REMOTE_LEASE_HEADER)
            .and_then(|value| value.to_str().ok())
    });
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }
    match frontend_bridge_json(
        &server,
        "action",
        "layouts",
        "exportNew",
        serde_json::json!({ "workspaceId": body.workspace_id, "name": body.name.trim() }),
    )
    .await
    {
        Ok(data) => (StatusCode::CREATED, Json(data)).into_response(),
        Err(response) => response,
    }
}

pub(super) async fn remote_workspace_rename(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceRenameRequest>,
) -> Response {
    if id.trim().is_empty() || body.name.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "workspace id and name are required",
        );
    }
    let lease_id = body.lease_id.as_deref().or_else(|| {
        headers
            .get(REMOTE_LEASE_HEADER)
            .and_then(|value| value.to_str().ok())
    });
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }
    // The desktop store remains responsible for normalization and uniqueness.
    match frontend_bridge_json(
        &server,
        "action",
        "workspaces",
        "rename",
        serde_json::json!({ "id": id, "name": body.name }),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.workspaces.rename",
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
    fn rename_request_accepts_lease_and_requires_a_string_name() {
        let request: WorkspaceRenameRequest =
            serde_json::from_str(r#"{"name":"개발","leaseId":"lease-1"}"#).unwrap();
        assert_eq!(request.name, "개발");
        assert_eq!(request.lease_id.as_deref(), Some("lease-1"));
        assert!(serde_json::from_str::<WorkspaceRenameRequest>(r#"{"name":42}"#).is_err());
        assert!(
            serde_json::from_str::<WorkspaceRenameRequest>(r#"{"leaseId":"lease-1"}"#).is_err()
        );
        assert!(
            serde_json::from_str::<WorkspaceRenameRequest>(r#"{"name":"A","id":"other"}"#).is_err()
        );
    }
}
