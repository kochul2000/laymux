//! Embedded MCP (Model Context Protocol) server using the official `rmcp` SDK.
//!
//! Uses `#[tool]` derive macros for automatic tool definition and JSON-RPC 2.0
//! handling. Mounted via `nest_service("/mcp", ...)` in the existing axum router.

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_router, ErrorData, ServerHandler};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::constants::{MCP_PROTOCOL_VERSION, MCP_SERVER_NAME};
use crate::lock_ext::MutexExt;

use super::helpers::bridge_request;
use super::ServerState;

// ── Parameter types ───────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct TerminalIdParam {
    /// Terminal ID (e.g. "terminal-pane-abc12345")
    terminal_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct WriteTerminalParam {
    /// Terminal ID
    terminal_id: String,
    /// Text to send. Use \r\n for Enter.
    data: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ReadOutputParam {
    /// Terminal ID
    terminal_id: String,
    /// Number of lines to read (default: 100)
    lines: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct WorkspaceIdParam {
    /// Workspace ID
    workspace_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateWorkspaceParam {
    /// Workspace name
    name: String,
    /// Layout ID to use as template (optional)
    layout_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PaneIndexParam {
    /// Pane index (0-based)
    pane_index: u64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SplitPaneParam {
    /// Pane index to split
    pane_index: u64,
    /// Split direction: "horizontal" or "vertical"
    direction: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SendNotificationParam {
    /// Terminal ID
    terminal_id: String,
    /// Workspace ID
    workspace_id: String,
    /// Notification message
    message: String,
    /// Notification level: info, error, warning, success (default: info)
    level: Option<String>,
}

// ── MCP Handler ───────────────────────────────────────────────────

/// MCP server handler embedded in the Automation API.
///
/// Each tool method delegates to either:
/// - `bridge_request()` for frontend state (workspaces, grid, notifications)
/// - `AppState` direct access for backend state (PTY write, output buffer, activity)
#[derive(Clone)]
pub struct McpHandler {
    state: ServerState,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl McpHandler {
    pub fn new(state: ServerState) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
        }
    }

    /// Bridge request to frontend via Tauri event.
    async fn bridge(
        &self,
        category: &str,
        target: &str,
        method: &str,
        params: Value,
    ) -> Result<CallToolResult, ErrorData> {
        let data = bridge_request(&self.state, category, target, method, params)
            .await
            .map_err(|(_status, axum::Json(body))| {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                ErrorData::internal_error(msg.to_string(), None)
            })?;
        Ok(json_result(&data))
    }
}

/// Create the MCP service for mounting in the axum router.
pub fn create_service(
    state: ServerState,
) -> StreamableHttpService<McpHandler, LocalSessionManager> {
    StreamableHttpService::new(
        move || Ok(McpHandler::new(state.clone())),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default().disable_allowed_hosts(),
    )
}

// ── Tool implementations ──────────────────────────────────────────

#[tool_router]
impl McpHandler {
    // ── Terminal (5) ──

    /// List all terminal instances with id, profile, syncGroup, workspaceId, cwd, branch.
    #[tool(description = "List all terminal instances with id, profile, syncGroup, workspaceId, cwd, branch.")]
    async fn list_terminals(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "terminals", "list", json!({})).await
    }

    /// Send input to a terminal (like typing). Use \r\n for Enter.
    #[tool(description = "Send input to a terminal (like typing). Use \\r\\n for Enter.")]
    async fn write_to_terminal(
        &self,
        Parameters(p): Parameters<WriteTerminalParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let ptys = self
            .state
            .app_state
            .pty_handles
            .lock_or_err()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        match ptys.get(&p.terminal_id) {
            Some(handle) => {
                handle
                    .write(p.data.as_bytes())
                    .map_err(|e| ErrorData::internal_error(e, None))?;
                Ok(CallToolResult::success(vec![Content::text("written")]))
            }
            None => Ok(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                p.terminal_id
            ))])),
        }
    }

    /// Read recent terminal output from ring buffer. Contains raw ANSI escapes.
    #[tool(description = "Read recent terminal output from ring buffer. Contains raw ANSI escapes.")]
    async fn read_terminal_output(
        &self,
        Parameters(p): Parameters<ReadOutputParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let lines = p.lines.unwrap_or(100) as usize;
        let buffers = self
            .state
            .app_state
            .output_buffers
            .lock_or_err()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        match buffers.get(&p.terminal_id) {
            Some(buf) => {
                let output = buf.recent_lines(lines);
                Ok(json_result(&json!({
                    "output": output,
                    "lines": output.lines().count(),
                    "bufferSize": buf.len(),
                })))
            }
            None => Ok(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                p.terminal_id
            ))])),
        }
    }

    /// Set focus to a terminal pane.
    #[tool(description = "Set focus to a terminal pane.")]
    async fn focus_terminal(
        &self,
        Parameters(p): Parameters<TerminalIdParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "terminals",
            "setFocus",
            json!({ "id": p.terminal_id }),
        )
        .await
    }

    /// Get activity state (shell/running/interactiveApp) for all terminals.
    #[tool(description = "Get activity state (shell/running/interactiveApp) for all terminals.")]
    async fn get_terminal_states(&self) -> Result<CallToolResult, ErrorData> {
        let states = crate::activity::detect_all_terminal_states(&self.state.app_state);
        Ok(json_result(&json!({ "states": states })))
    }

    // ── Workspace (4) ──

    /// List all workspaces with pane layouts and active workspace ID.
    #[tool(description = "List all workspaces with pane layouts and active workspace ID.")]
    async fn list_workspaces(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "workspaces", "list", json!({})).await
    }

    /// Get the currently active workspace with full pane details.
    #[tool(description = "Get the currently active workspace with full pane details.")]
    async fn get_active_workspace(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "workspaces", "getActive", json!({}))
            .await
    }

    /// Switch to a different workspace by ID.
    #[tool(description = "Switch to a different workspace by ID.")]
    async fn switch_workspace(
        &self,
        Parameters(p): Parameters<WorkspaceIdParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "workspaces",
            "switchActive",
            json!({ "id": p.workspace_id }),
        )
        .await
    }

    /// Create a new workspace, optionally from a layout template.
    #[tool(description = "Create a new workspace, optionally from a layout template.")]
    async fn create_workspace(
        &self,
        Parameters(p): Parameters<CreateWorkspaceParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut params = json!({ "name": p.name });
        if let Some(layout_id) = p.layout_id {
            params["layoutId"] = json!(layout_id);
        }
        self.bridge("action", "workspaces", "add", params).await
    }

    // ── Grid/Pane (3) ──

    /// Get grid state: editMode, focusedPaneIndex.
    #[tool(description = "Get grid state: editMode, focusedPaneIndex.")]
    async fn get_grid_state(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "grid", "getState", json!({})).await
    }

    /// Focus a specific pane by index.
    #[tool(description = "Focus a specific pane by index.")]
    async fn focus_pane(
        &self,
        Parameters(p): Parameters<PaneIndexParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "grid",
            "focusPane",
            json!({ "index": p.pane_index }),
        )
        .await
    }

    /// Split a pane horizontally or vertically.
    #[tool(description = "Split a pane horizontally or vertically.")]
    async fn split_pane(
        &self,
        Parameters(p): Parameters<SplitPaneParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "panes",
            "split",
            json!({ "paneIndex": p.pane_index, "direction": p.direction }),
        )
        .await
    }

    // ── Utility (3) ──

    /// Capture a screenshot of the current IDE UI. Returns image content.
    #[tool(description = "Capture a screenshot of the current IDE UI. Returns image content.")]
    async fn take_screenshot(&self) -> Result<CallToolResult, ErrorData> {
        let data = bridge_request(
            &self.state,
            "action",
            "screenshot",
            "capture",
            json!({}),
        )
        .await
        .map_err(|(_status, axum::Json(body))| {
            let msg = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Screenshot failed");
            ErrorData::internal_error(msg.to_string(), None)
        })?;

        let data_url = data
            .get("dataUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                ErrorData::internal_error("No dataUrl in screenshot response", None)
            })?;

        let base64_data = data_url
            .strip_prefix("data:image/png;base64,")
            .unwrap_or(data_url);

        Ok(CallToolResult::success(vec![Content::image(
            base64_data,
            "image/png",
        )]))
    }

    /// List all notifications across workspaces.
    #[tool(description = "List all notifications across workspaces.")]
    async fn list_notifications(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "notifications", "list", json!({}))
            .await
    }

    /// Create a notification in the IDE.
    #[tool(description = "Create a notification in the IDE.")]
    async fn send_notification(
        &self,
        Parameters(p): Parameters<SendNotificationParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut params = json!({
            "terminalId": p.terminal_id,
            "workspaceId": p.workspace_id,
            "message": p.message,
        });
        if let Some(level) = p.level {
            params["level"] = json!(level);
        }
        self.bridge("action", "notifications", "add", params).await
    }
}

// ── ServerHandler trait ───────────────────────────────────────────

impl ServerHandler for McpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                MCP_SERVER_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(format!(
                "Laymux IDE automation via MCP (protocol {}). \
                 Control terminals, workspaces, grid layout, and capture screenshots.",
                MCP_PROTOCOL_VERSION,
            ))
    }
}

// ── Helpers ───────────────────────────────────────────────────────

fn json_result(data: &Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(data).unwrap_or_default();
    CallToolResult::success(vec![Content::text(text)])
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_types_deserialize() {
        let json = r#"{"terminal_id":"t1","data":"ls\r\n"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.terminal_id, "t1");
        assert_eq!(p.data, "ls\r\n");
    }

    #[test]
    fn read_output_param_defaults() {
        let json = r#"{"terminal_id":"t1"}"#;
        let p: ReadOutputParam = serde_json::from_str(json).unwrap();
        assert!(p.lines.is_none());
    }

    #[test]
    fn create_workspace_param_optional_layout() {
        let json = r#"{"name":"test"}"#;
        let p: CreateWorkspaceParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.name, "test");
        assert!(p.layout_id.is_none());
    }

    #[test]
    fn send_notification_param_optional_level() {
        let json = r#"{"terminal_id":"t1","workspace_id":"ws1","message":"hello"}"#;
        let p: SendNotificationParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.message, "hello");
        assert!(p.level.is_none());
    }

    #[test]
    fn json_result_wraps_as_text_content() {
        let data = json!({"key": "value"});
        let result = json_result(&data);
        // is_error is None or Some(false) for success
        assert_ne!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 1);
    }
}
