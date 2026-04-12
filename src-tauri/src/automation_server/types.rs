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

#[derive(Deserialize)]
pub struct FocusTerminalBody {
    pub id: String,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub port: u16,
}

/// All registered routes as (method, path) pairs.
/// Used by both the router and the docs completeness test.
pub const REGISTERED_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/docs"),
    ("GET", "/api/v1/health"),
    ("GET", "/api/v1/workspaces"),
    ("POST", "/api/v1/workspaces"),
    ("GET", "/api/v1/workspaces/active"),
    ("POST", "/api/v1/workspaces/active"),
    ("PUT", "/api/v1/workspaces/{id}"),
    ("POST", "/api/v1/workspaces/reorder"),
    ("DELETE", "/api/v1/workspaces/{id}"),
    ("POST", "/api/v1/layouts/export"),
    ("GET", "/api/v1/grid"),
    ("POST", "/api/v1/grid/edit-mode"),
    ("POST", "/api/v1/grid/focus"),
    ("POST", "/api/v1/grid/hover"),
    ("POST", "/api/v1/panes/split"),
    ("DELETE", "/api/v1/panes/{index}"),
    ("PUT", "/api/v1/panes/{index}/view"),
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
    ("GET", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications"),
    ("POST", "/api/v1/notifications/mark-read"),
    ("GET", "/api/v1/workspaces/{id}/summary"),
    ("POST", "/api/v1/terminals/{id}/focus"),
    ("GET", "/api/v1/terminals/states"),
    ("GET", "/api/v1/layouts"),
    ("POST", "/api/v1/screenshot"),
    ("POST", "/api/v1/ui/settings"),
    ("POST", "/api/v1/ui/settings/navigate"),
    ("PUT", "/api/v1/settings/app-theme"),
    ("PUT", "/api/v1/settings/profile-defaults"),
    ("PUT", "/api/v1/settings/profiles/{index}"),
    ("POST", "/api/v1/ui/notifications"),
    ("*", "/mcp"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_request_serializes() {
        let req = AutomationRequest {
            request_id: "abc-123".into(),
            category: "query".into(),
            target: "workspaces".into(),
            method: "list".into(),
            params: serde_json::json!({}),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("requestId"));
        assert!(json.contains("workspaces"));
    }

    #[test]
    fn automation_request_round_trip() {
        let req = AutomationRequest {
            request_id: "test-id".into(),
            category: "action".into(),
            target: "grid".into(),
            method: "setEditMode".into(),
            params: serde_json::json!({ "enabled": true }),
        };
        let json = serde_json::to_string(&req).unwrap();
        let deserialized: AutomationRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.request_id, "test-id");
        assert_eq!(deserialized.target, "grid");
        assert_eq!(deserialized.params["enabled"], true);
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
}
