//! Remote step-navigation endpoints (issue #474, ADR-0039).
//!
//! Thin controller handlers: validate direction + lease, relay to the
//! frontend bridge `navigation.spatialStep`/`navigation.notificationStep`
//! actions (which own the traversal semantics), and mirror the existing
//! remote focus contract (best-effort mark-read + workspace-state-changed).

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::automation_server::ServerState;

use super::json_error;
use super::lease::require_active_lease;
use super::navigation_routes::{
    emit_workspace_state_changed, frontend_bridge_json, lease_id_from_headers,
};

/// Whitelisted direction values — anything else is a 400. The names match the
/// frontend bridge params and (for notifications) the desktop action ids
/// `notifications.recent`/`notifications.oldest`.
const SPATIAL_DIRECTIONS: [&str; 2] = ["prev", "next"];
const NOTIFICATION_DIRECTIONS: [&str; 2] = ["recent", "oldest"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NavigationStepRequest {
    direction: String,
    lease_id: Option<String>,
}

pub(super) async fn remote_navigation_spatial_step(
    State(server): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let body = match navigation_step_request_from_body(&body) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };
    if !SPATIAL_DIRECTIONS.contains(&body.direction.as_str()) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "direction must be \"prev\" or \"next\"",
        );
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
        "navigation",
        "spatialStep",
        serde_json::json!({ "direction": body.direction.clone() }),
    )
    .await
    {
        Ok(data) => {
            // Landing on a terminal consumes its unread alerts, mirroring the
            // remote terminal-focus contract (ADR-0018). Best-effort.
            if let Some(terminal_id) = landed_terminal_id(&data) {
                let terminal_id = terminal_id.to_string();
                if let Err(response) = frontend_bridge_json(
                    &server,
                    "action",
                    "notifications",
                    "markTerminalRead",
                    serde_json::json!({ "terminalId": terminal_id.clone() }),
                )
                .await
                {
                    tracing::debug!(
                        terminal_id,
                        "failed to mark landed terminal notifications read: {:?}",
                        response.status()
                    );
                }
            }
            emit_workspace_state_changed(
                &server,
                "remote.navigation.spatialStep",
                serde_json::json!({ "direction": body.direction }),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

pub(super) async fn remote_navigation_notification_step(
    State(server): State<ServerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let body = match navigation_step_request_from_body(&body) {
        Ok(body) => body,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid JSON body"),
    };
    if !NOTIFICATION_DIRECTIONS.contains(&body.direction.as_str()) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "direction must be \"recent\" or \"oldest\"",
        );
    }
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    // Notification consumption happens inside the bridge action itself
    // (markNotificationsAsRead on the matched group) — no extra mark-read here.
    match frontend_bridge_json(
        &server,
        "action",
        "navigation",
        "notificationStep",
        serde_json::json!({ "direction": body.direction.clone() }),
    )
    .await
    {
        Ok(data) => {
            emit_workspace_state_changed(
                &server,
                "remote.navigation.notificationStep",
                serde_json::json!({ "direction": body.direction }),
            );
            Json(data).into_response()
        }
        Err(response) => response,
    }
}

/// Extract the landing terminal id from a successful `{moved:true, target:{…}}`
/// bridge result. Returns None for `moved:false` no-ops.
fn landed_terminal_id(data: &Value) -> Option<&str> {
    if data.get("moved").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    data.get("target")
        .and_then(|target| target.get("terminalId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn navigation_step_request_from_body(
    body: &[u8],
) -> Result<NavigationStepRequest, serde_json::Error> {
    serde_json::from_slice(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_requires_direction() {
        assert!(navigation_step_request_from_body(b"").is_err());
        assert!(navigation_step_request_from_body(b"{}").is_err());
        assert!(navigation_step_request_from_body(br#"{"leaseId":"l1"}"#).is_err());
    }

    #[test]
    fn request_reads_direction_and_body_lease() {
        let body =
            navigation_step_request_from_body(br#"{"direction":"next","leaseId":"lease-body"}"#)
                .unwrap();
        assert_eq!(body.direction, "next");
        assert_eq!(body.lease_id.as_deref(), Some("lease-body"));
    }

    #[test]
    fn request_allows_header_lease_with_direction_only() {
        let body = navigation_step_request_from_body(br#"{"direction":"recent"}"#).unwrap();
        assert_eq!(body.direction, "recent");
        assert!(body.lease_id.is_none());
    }

    #[test]
    fn direction_whitelists_are_disjoint_and_exact() {
        assert!(SPATIAL_DIRECTIONS.contains(&"prev"));
        assert!(SPATIAL_DIRECTIONS.contains(&"next"));
        assert!(!SPATIAL_DIRECTIONS.contains(&"recent"));
        assert!(NOTIFICATION_DIRECTIONS.contains(&"recent"));
        assert!(NOTIFICATION_DIRECTIONS.contains(&"oldest"));
        assert!(!NOTIFICATION_DIRECTIONS.contains(&"next"));
    }

    #[test]
    fn landed_terminal_id_reads_moved_target_only() {
        let moved = serde_json::json!({
            "moved": true,
            "target": { "terminalId": "terminal-abc" }
        });
        assert_eq!(landed_terminal_id(&moved), Some("terminal-abc"));

        let noop = serde_json::json!({ "moved": false, "reason": "no_other_target" });
        assert_eq!(landed_terminal_id(&noop), None);

        let empty = serde_json::json!({ "moved": true, "target": { "terminalId": "" } });
        assert_eq!(landed_terminal_id(&empty), None);
    }
}
