//! Remote clear endpoints (ADR-0269, ADR-0271).
//!
//! Thin controller handlers: validate the lease, then relay to the frontend
//! bridge clear actions, which own the activity-aware input and busy policy
//! (ADR-0158) and the workspace Ctrl+L broadcast (ADR-0137). The bridge params
//! carry the lease so the desktop executor writes as the lease holder — a held
//! lease rejects Local writes (ADR-0271).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::automation_server::ServerState;
use crate::constants::TERMINAL_ID_PREFIX;

use super::json_error;
use super::lease::require_active_lease;
use super::navigation_routes::{frontend_bridge_json, lease_id_from_headers};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteClearRequest {
    lease_id: Option<String>,
}

/// `POST /remote/v1/terminals/{id}/clear` — the Remote `pane.clearTerminal`.
pub(super) async fn remote_terminal_clear(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(pane_id) = pane_id_from_terminal_id(&id) else {
        return json_error(StatusCode::BAD_REQUEST, "terminal id is required");
    };
    let lease_id = match active_lease_for(&server, &headers, &body) {
        Ok(lease_id) => lease_id,
        Err(response) => return response,
    };

    relay(
        &server,
        "panes",
        serde_json::json!({ "paneId": pane_id, "remoteLeaseId": lease_id }),
    )
    .await
}

/// `POST /remote/v1/workspaces/{id}/clear` — the Remote `workspace.clearTerminals`.
pub(super) async fn remote_workspace_clear(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "workspace id is required");
    }
    let lease_id = match active_lease_for(&server, &headers, &body) {
        Ok(lease_id) => lease_id,
        Err(response) => return response,
    };

    relay(
        &server,
        "workspaces",
        serde_json::json!({ "id": id, "remoteLeaseId": lease_id }),
    )
    .await
}

async fn relay(server: &ServerState, target: &str, params: serde_json::Value) -> Response {
    match frontend_bridge_json(server, "action", target, "clear", params).await {
        Ok(data) => Json(data).into_response(),
        Err(response) => response,
    }
}

/// The request's lease (body first, then header), verified as the active one.
#[allow(clippy::result_large_err)] // Axum handlers return this Response directly.
fn active_lease_for(
    server: &ServerState,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<String, Response> {
    let request = clear_request_from_body(body)
        .map_err(|_| json_error(StatusCode::BAD_REQUEST, "invalid JSON body"))?;
    let lease_id = request
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(headers));
    require_active_lease(&server.app_state, lease_id)?;
    // require_active_lease rejects a missing or empty lease.
    Ok(lease_id.unwrap_or_default().to_string())
}

fn clear_request_from_body(body: &[u8]) -> Result<RemoteClearRequest, serde_json::Error> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(RemoteClearRequest::default());
    }
    serde_json::from_slice(body)
}

/// `terminal-{paneId}` → `paneId`; grid and dock terminals share the form.
fn pane_id_from_terminal_id(id: &str) -> Option<&str> {
    id.strip_prefix(TERMINAL_ID_PREFIX)
        .filter(|pane_id| !pane_id.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_id_maps_to_its_pane_id() {
        assert_eq!(pane_id_from_terminal_id("terminal-pane-a"), Some("pane-a"));
        assert_eq!(pane_id_from_terminal_id("terminal-"), None);
        assert_eq!(pane_id_from_terminal_id("pane-a"), None);
    }

    #[test]
    fn request_body_is_optional_and_reads_the_lease() {
        assert!(clear_request_from_body(b"").unwrap().lease_id.is_none());
        assert!(clear_request_from_body(b"  ").unwrap().lease_id.is_none());
        assert_eq!(
            clear_request_from_body(br#"{"leaseId":"lease-1"}"#)
                .unwrap()
                .lease_id
                .as_deref(),
            Some("lease-1")
        );
        assert!(clear_request_from_body(b"{").is_err());
    }
}
