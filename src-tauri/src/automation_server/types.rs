use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Request sent to frontend via Tauri event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRequest {
    pub request_id: String,
    pub category: String, // "query" or "action"
    pub target: String,
    pub method: String,
    pub params: serde_json::Value,
    /// Wall-clock ms when the request was emitted. The frontend subtracts it from
    /// `Date.now()` to measure how deep the event delivery queue actually is.
    pub emitted_at_ms: u64,
    /// Wall-clock ms after which `bridge_request` has stopped waiting. A query
    /// past this point is dropped by the frontend instead of being computed for a
    /// caller that already received `504 Frontend response timeout` (issue #606).
    pub deadline_ms: u64,
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
pub struct BufferDumpQuery {
    /// Max lines to return (trailing slice). 0 = whole buffer. Omitted = frontend default.
    pub limit: Option<usize>,
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
    /// 새 pane 의 터미널 프로파일. 생략하면 기본 프로파일.
    pub profile: Option<String>,
    /// 새 pane 의 시작 디렉터리. 생략하면 직전 포커스/분할 대상 pane 의 CWD 를
    /// 상속한다(ADR-0140). MCP `split_pane` 과 같은 계약.
    pub cwd: Option<String>,
}

/// `POST /api/v1/panes/stack` (ADR-0297): stack a new layer on a slot.
#[derive(Deserialize)]
pub struct StackPaneBody {
    #[serde(rename = "paneIndex")]
    pub pane_index: usize,
    /// View type of the new layer. Default `TerminalView`, like `split_pane`.
    #[serde(rename = "viewType")]
    pub view_type: Option<String>,
    /// Terminal profile of the new layer. Default profile when omitted.
    pub profile: Option<String>,
    /// Start directory of the new layer's terminal. When omitted it inherits
    /// the slot's active layer CWD (ADR-0140 as extended by ADR-0297).
    pub cwd: Option<String>,
}

/// `POST /api/v1/panes/layers/activate` (ADR-0297): show one stacked layer.
/// Exactly one of `layerId` / `terminalId` identifies the layer.
#[derive(Deserialize)]
pub struct ActivateLayerBody {
    #[serde(rename = "layerId")]
    pub layer_id: Option<String>,
    #[serde(rename = "terminalId")]
    pub terminal_id: Option<String>,
    /// Also move keyboard focus to the slot (default true).
    pub focus: Option<bool>,
}

/// `POST /api/v1/panes/layers/move` (ADR-0298): move a layer onto slot
/// `targetPaneIndex` of the active workspace. Inside one slot it reorders.
/// Exactly one of `layerId` / `terminalId` identifies the layer.
#[derive(Deserialize)]
pub struct MoveLayerBody {
    #[serde(rename = "layerId")]
    pub layer_id: Option<String>,
    #[serde(rename = "terminalId")]
    pub terminal_id: Option<String>,
    #[serde(rename = "targetPaneIndex")]
    pub target_pane_index: usize,
    /// Position among the target's other layers (default: after its active layer).
    pub index: Option<usize>,
}

/// `POST /api/v1/panes/layers/extract` (ADR-0298): pull a stacked layer out
/// into its own slot, splitting its current slot like `panes/split`.
#[derive(Deserialize)]
pub struct ExtractLayerBody {
    #[serde(rename = "layerId")]
    pub layer_id: Option<String>,
    #[serde(rename = "terminalId")]
    pub terminal_id: Option<String>,
    /// `horizontal` | `vertical`, the same axis vocabulary as `panes/split`.
    pub direction: String,
}

/// `POST /api/v1/panes/merge` (ADR-0298): stack every layer of slot
/// `sourceIndex` onto slot `targetIndex` and remove the source slot.
#[derive(Deserialize)]
pub struct MergePanesBody {
    #[serde(rename = "sourceIndex")]
    pub source_index: usize,
    #[serde(rename = "targetIndex")]
    pub target_index: usize,
}

/// `POST /api/v1/panes/{index}/move-to-workspace` (ADR-0298): carry a whole
/// slot (every layer) to another workspace.
#[derive(Deserialize)]
pub struct MovePaneToWorkspaceBody {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
}

/// `DELETE /api/v1/panes/{index}?layerId=` (ADR-0297): close one layer.
#[derive(Deserialize)]
pub struct RemovePaneQuery {
    #[serde(rename = "layerId")]
    pub layer_id: Option<String>,
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

/// Body for `DELETE /api/v1/notifications`.
///
/// Provide exactly one of `ids` or `before`. When `before` is set, `read_only`
/// controls whether only already-read notifications are cleared.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearNotificationsBody {
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    #[serde(default)]
    pub before: Option<u64>,
    #[serde(default)]
    pub read_only: Option<bool>,
}

#[derive(Deserialize)]
pub struct FocusTerminalBody {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HiddenItemsOpenBody {
    pub open: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub port: u16,
    pub instance: HealthInstanceIdentity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthBuildKind {
    Dev,
    Release,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInstanceIdentity {
    pub pid: u32,
    pub build_kind: HealthBuildKind,
    pub executable_path: Option<String>,
    pub worktree_root: Option<String>,
    pub git_commit: Option<String>,
    pub git_branch: Option<String>,
}

/// All registered routes as (method, path) pairs.
/// Used by both the router and the docs completeness test.
pub const REGISTERED_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/docs"),
    ("GET", "/api/v1/health"),
    ("GET", "/api/v1/agent-hooks/environments"),
    ("POST", "/api/v1/agent-hooks/manage"),
    ("GET", "/api/v1/pty-sessions"),
    ("POST", "/api/v1/pty-sessions/terminate"),
    ("POST", "/api/v1/pty-sessions/terminate-detached"),
    ("GET", "/api/v1/agent-hooks/updates"),
    ("POST", "/api/v1/agent-hooks/events"),
    ("GET", "/api/v1/agent-hooks/connections"),
    ("GET", "/api/v1/agent-hooks/states"),
    ("GET", "/api/v1/diagnostics/frontend"),
    ("GET", "/api/v1/update"),
    ("POST", "/api/v1/update/check"),
    ("POST", "/api/v1/update/install"),
    ("GET", "/api/v1/workspaces"),
    ("POST", "/api/v1/workspaces"),
    ("GET", "/api/v1/workspaces/active"),
    ("POST", "/api/v1/workspaces/active"),
    ("PUT", "/api/v1/workspaces/{id}"),
    ("POST", "/api/v1/workspaces/reorder"),
    ("DELETE", "/api/v1/workspaces/{id}"),
    ("POST", "/api/v1/workspaces/{id}/clear"),
    ("POST", "/api/v1/layouts/export"),
    ("GET", "/api/v1/grid"),
    ("POST", "/api/v1/grid/edit-mode"),
    ("POST", "/api/v1/grid/focus"),
    ("POST", "/api/v1/grid/hover"),
    ("POST", "/api/v1/panes/split"),
    ("POST", "/api/v1/panes/stack"),
    ("POST", "/api/v1/panes/layers/activate"),
    ("POST", "/api/v1/panes/layers/move"),
    ("POST", "/api/v1/panes/layers/extract"),
    ("POST", "/api/v1/panes/merge"),
    ("POST", "/api/v1/panes/{index}/move-to-workspace"),
    ("DELETE", "/api/v1/panes/{index}"),
    ("POST", "/api/v1/panes/{index}/resize"),
    ("PUT", "/api/v1/panes/{index}/view"),
    ("POST", "/api/v1/panes/{paneId}/clear"),
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
    ("GET", "/api/v1/terminals/{id}/buffer"),
    ("GET", "/api/v1/usage"),
    ("GET", "/api/v1/usage/grok"),
    ("GET", "/api/v1/memos"),
    ("GET", "/api/v1/memos/{key}"),
    ("GET", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications"),
    ("DELETE", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications/mark-read"),
    ("GET", "/api/v1/workspaces/{id}/summary"),
    ("POST", "/api/v1/terminals/{id}/focus"),
    ("GET", "/api/v1/terminals/states"),
    ("GET", "/api/v1/layouts"),
    ("POST", "/api/v1/screenshot"),
    ("POST", "/api/v1/ui/settings"),
    ("POST", "/api/v1/ui/remote-access"),
    ("POST", "/api/v1/ui/settings/navigate"),
    ("POST", "/api/v1/ui/lifecycle"),
    ("POST", "/api/v1/ui/key"),
    ("POST", "/api/v1/ui/file-viewer"),
    ("PUT", "/api/v1/settings/app-theme"),
    ("GET", "/api/v1/settings/export"),
    ("PUT", "/api/v1/settings/profile-defaults"),
    ("PUT", "/api/v1/settings/profiles/{index}"),
    ("POST", "/api/v1/ui/notifications"),
    ("POST", "/api/v1/ui/hidden-items"),
    ("POST", "/api/v1/ui/hidden/workspace/{id}/toggle"),
    ("POST", "/api/v1/ui/hidden/pane/{id}/toggle"),
    ("*", "/mcp"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use tower::ServiceExt;

    #[test]
    fn automation_request_serializes() {
        let req = AutomationRequest {
            request_id: "abc-123".into(),
            category: "query".into(),
            target: "workspaces".into(),
            method: "list".into(),
            params: serde_json::json!({}),
            emitted_at_ms: 1_000,
            deadline_ms: 6_000,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("requestId"));
        assert!(json.contains("workspaces"));
        // The frontend drops an expired query off these two fields (issue #606),
        // so they have to be on the wire in camelCase like everything else.
        assert!(json.contains("emittedAtMs"));
        assert!(json.contains("deadlineMs"));
    }

    #[test]
    fn automation_request_round_trip() {
        let req = AutomationRequest {
            request_id: "test-id".into(),
            category: "action".into(),
            target: "grid".into(),
            method: "setEditMode".into(),
            params: serde_json::json!({ "enabled": true }),
            emitted_at_ms: 42,
            deadline_ms: 5_042,
        };
        let json = serde_json::to_string(&req).unwrap();
        let deserialized: AutomationRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.request_id, "test-id");
        assert_eq!(deserialized.target, "grid");
        assert_eq!(deserialized.params["enabled"], true);
        assert_eq!(deserialized.emitted_at_ms, 42);
        assert_eq!(deserialized.deadline_ms, 5_042);
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
        // 생략하면 프론트가 CWD 를 상속한다(ADR-0140).
        assert_eq!(body.profile, None);
        assert_eq!(body.cwd, None);
    }

    #[test]
    fn split_pane_body_carries_profile_and_cwd() {
        let json = r#"{"paneIndex":1,"direction":"horizontal","profile":"WSL","cwd":"/home/user"}"#;
        let body: SplitPaneBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.profile.as_deref(), Some("WSL"));
        assert_eq!(body.cwd.as_deref(), Some("/home/user"));
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
    fn clear_notifications_body_ids() {
        let json = r#"{"ids":["notif-1","notif-2"]}"#;
        let body: ClearNotificationsBody = serde_json::from_str(json).unwrap();
        assert_eq!(body.ids.as_deref().unwrap().len(), 2);
        assert!(body.before.is_none());
        assert!(body.read_only.is_none());
    }

    #[test]
    fn clear_notifications_body_before_camel_case_read_only() {
        let json = r#"{"before":1776000000000,"readOnly":true}"#;
        let body: ClearNotificationsBody = serde_json::from_str(json).unwrap();
        assert!(body.ids.is_none());
        assert_eq!(body.before, Some(1776000000000));
        assert_eq!(body.read_only, Some(true));
    }

    #[test]
    fn clear_notifications_body_empty() {
        let json = "{}";
        let body: ClearNotificationsBody = serde_json::from_str(json).unwrap();
        assert!(body.ids.is_none());
        assert!(body.before.is_none());
        assert!(body.read_only.is_none());
    }

    #[test]
    fn rearrange_bodies_deserialize_and_register() {
        let body: MoveLayerBody =
            serde_json::from_str(r#"{"layerId":"a","targetPaneIndex":1}"#).unwrap();
        assert_eq!(body.target_pane_index, 1);
        assert!(body.index.is_none());
        assert!(serde_json::from_str::<MoveLayerBody>(r#"{"layerId":"a"}"#).is_err());
        let body: ExtractLayerBody =
            serde_json::from_str(r#"{"terminalId":"terminal-a","direction":"vertical"}"#).unwrap();
        assert_eq!(body.direction, "vertical");
        let body: MergePanesBody =
            serde_json::from_str(r#"{"sourceIndex":0,"targetIndex":1}"#).unwrap();
        assert_eq!((body.source_index, body.target_index), (0, 1));
        let body: MovePaneToWorkspaceBody =
            serde_json::from_str(r#"{"workspaceId":"ws-2"}"#).unwrap();
        assert_eq!(body.workspace_id, "ws-2");
        for path in [
            "/api/v1/panes/layers/move",
            "/api/v1/panes/layers/extract",
            "/api/v1/panes/merge",
            "/api/v1/panes/{index}/move-to-workspace",
        ] {
            assert!(REGISTERED_ROUTES.contains(&("POST", path)), "{path}");
        }
    }

    #[test]
    fn hidden_items_open_body_requires_a_boolean() {
        let body: HiddenItemsOpenBody = serde_json::from_str(r#"{"open":true}"#).unwrap();
        assert!(body.open);
        assert!(serde_json::from_str::<HiddenItemsOpenBody>(r#"{"open":"true"}"#).is_err());
        assert!(serde_json::from_str::<HiddenItemsOpenBody>("{}").is_err());
        assert!(serde_json::from_str::<HiddenItemsOpenBody>(r#"{"open":true,"extra":1}"#).is_err());
    }

    #[tokio::test]
    async fn hidden_items_route_rejects_non_boolean_or_incomplete_json() {
        async fn extract_hidden_items(Json(body): Json<HiddenItemsOpenBody>) -> StatusCode {
            if body.open {
                StatusCode::OK
            } else {
                StatusCode::NO_CONTENT
            }
        }

        let app = Router::new().route("/api/v1/ui/hidden-items", post(extract_hidden_items));
        for (body, expected) in [
            (r#"{"open":true}"#, StatusCode::OK),
            (r#"{"open":false}"#, StatusCode::NO_CONTENT),
            (r#"{"open":"true"}"#, StatusCode::UNPROCESSABLE_ENTITY),
            (r#"{}"#, StatusCode::UNPROCESSABLE_ENTITY),
            (
                r#"{"open":true,"extra":1}"#,
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/api/v1/ui/hidden-items")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected, "body: {body}");
        }
    }

    #[test]
    fn hidden_items_route_replaces_hide_mode_toggle() {
        assert!(REGISTERED_ROUTES.contains(&("POST", "/api/v1/ui/hidden-items")));
        assert!(!REGISTERED_ROUTES.contains(&("POST", "/api/v1/ui/hide-mode/toggle")));
    }

    #[test]
    fn single_pane_clear_route_is_registered_by_pane_id() {
        assert!(REGISTERED_ROUTES.contains(&("POST", "/api/v1/panes/{paneId}/clear")));
    }
}
