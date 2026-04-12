//! Embedded MCP (Model Context Protocol) server using the official `rmcp` SDK.
//!
//! Uses `#[tool]` derive macros for automatic tool definition and JSON-RPC 2.0
//! handling. Mounted via `nest_service("/mcp", ...)` in the existing axum router.

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::constants::MCP_SERVER_NAME;
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
    /// Text to send.
    data: String,
    /// When true, C-style escape sequences in `data` are converted to real
    /// control characters before writing (e.g. `\r\n` → CR+LF, `\u0003` → Ctrl+C).
    /// Default is false — data is sent as-is, preserving literal backslashes
    /// (important for Windows paths like `C:\new\tmp`).
    #[serde(default)]
    escape: bool,
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
#[serde(rename_all = "lowercase")]
enum SplitDirection {
    Horizontal,
    Vertical,
}

impl std::fmt::Display for SplitDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SplitDirection::Horizontal => write!(f, "horizontal"),
            SplitDirection::Vertical => write!(f, "vertical"),
        }
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SplitPaneParam {
    /// Pane index to split
    pane_index: u64,
    /// Split direction
    direction: SplitDirection,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum NotificationLevel {
    Info,
    Error,
    Warning,
    Success,
}

impl std::fmt::Display for NotificationLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotificationLevel::Info => write!(f, "info"),
            NotificationLevel::Error => write!(f, "error"),
            NotificationLevel::Warning => write!(f, "warning"),
            NotificationLevel::Success => write!(f, "success"),
        }
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SendNotificationParam {
    /// Terminal ID
    terminal_id: String,
    /// Workspace ID
    workspace_id: String,
    /// Notification message
    message: String,
    /// Notification level (default: info)
    level: Option<NotificationLevel>,
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
    /// Returns tool-level errors (CallToolResult::error) instead of JSON-RPC errors
    /// so MCP clients can see the error message in the tool response.
    async fn bridge(
        &self,
        category: &str,
        target: &str,
        method: &str,
        params: Value,
    ) -> Result<CallToolResult, ErrorData> {
        match bridge_request(&self.state, category, target, method, params).await {
            Ok(data) => Ok(json_result(&data)),
            Err((_status, axum::Json(body))) => {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                Ok(CallToolResult::error(vec![Content::text(msg)]))
            }
        }
    }
}

/// Create the MCP service for mounting in the axum router.
///
/// Allowed hosts include loopback addresses plus common WSL2 gateway patterns.
/// The axum server binds to 0.0.0.0 for WSL2 access, so we extend the default
/// loopback-only list rather than disabling host validation entirely.
pub fn create_service(
    state: ServerState,
) -> StreamableHttpService<McpHandler, LocalSessionManager> {
    StreamableHttpService::new(
        move || Ok(McpHandler::new(state.clone())),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default().with_allowed_hosts(mcp_allowed_hosts()),
    )
}

/// Build the allowed hosts list for MCP host header validation.
///
/// Includes loopback addresses plus all local interface IPs.
/// On Windows, this captures the vEthernet (WSL) adapter IP so that
/// WSL2 clients connecting via the gateway IP are not blocked.
fn mcp_allowed_hosts() -> Vec<String> {
    let mut hosts = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    hosts.extend(local_interface_ips());
    hosts
}

/// Enumerate local IPv4 addresses so MCP host validation accepts them.
///
/// On Windows, parses `ipconfig` output (locale-independent: matches any
/// line ending in `: <valid_ipv4>`). This captures the vEthernet (WSL)
/// adapter IP that WSL2 clients use as their gateway.
#[cfg(target_os = "windows")]
fn local_interface_ips() -> Vec<String> {
    let output = match crate::process::headless_command("ipconfig").output() {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut ips = Vec::new();
    for line in stdout.lines() {
        // ipconfig format (any locale): "   Label . . . : 172.25.160.1"
        if let Some(after_colon) = line.rsplit(':').next() {
            let trimmed = after_colon.trim();
            if trimmed.parse::<std::net::Ipv4Addr>().is_ok() && trimmed != "127.0.0.1" {
                ips.push(trimmed.to_string());
            }
        }
    }
    ips
}

/// On Linux, MCP clients connect via loopback (already in the base list).
#[cfg(not(target_os = "windows"))]
fn local_interface_ips() -> Vec<String> {
    vec![]
}

// ── Tool implementations ──────────────────────────────────────────

#[tool_router]
impl McpHandler {
    // ── Terminal (7) ──

    /// List all terminal instances with id, profile, syncGroup, workspaceId, cwd, branch, paneIndex, and panePosition (x,y,w,h).
    #[tool]
    async fn list_terminals(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "terminals", "list", json!({})).await
    }

    /// Identify a terminal's full context: workspace, pane position (x,y,w,h), and neighboring panes.
    /// Pass the value of the LX_TERMINAL_ID environment variable from your shell.
    /// Use this as the first step to understand your position in the IDE grid.
    #[tool]
    async fn identify_caller(
        &self,
        Parameters(p): Parameters<TerminalIdParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "query",
            "terminals",
            "identify",
            json!({ "id": p.terminal_id }),
        )
        .await
    }

    /// Get details for a single terminal by ID, including pane position and workspace info.
    #[tool]
    async fn get_terminal(
        &self,
        Parameters(p): Parameters<TerminalIdParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "query",
            "terminals",
            "get",
            json!({ "id": p.terminal_id }),
        )
        .await
    }

    /// Send input to a terminal (like typing). For control characters set
    /// `escape` to true and use C-style sequences: `\\r\\n` for Enter,
    /// `\\u0003` for Ctrl+C. Leave `escape` false for literal text (preserves
    /// backslashes in Windows paths).
    #[tool]
    async fn write_to_terminal(
        &self,
        Parameters(p): Parameters<WriteTerminalParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let data = if p.escape {
            super::helpers::unescape_terminal_input(&p.data)
        } else {
            p.data.clone()
        };
        let ptys = match self.state.app_state.pty_handles.lock_or_err() {
            Ok(guard) => guard,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(e.to_string())]));
            }
        };
        match ptys.get(&p.terminal_id) {
            Some(handle) => match handle.write(data.as_bytes()) {
                Ok(_) => Ok(CallToolResult::success(vec![Content::text("written")])),
                Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
            },
            None => Ok(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                p.terminal_id
            ))])),
        }
    }

    /// Read recent terminal output from ring buffer. Contains raw ANSI escapes.
    #[tool]
    async fn read_terminal_output(
        &self,
        Parameters(p): Parameters<ReadOutputParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let lines = p.lines.unwrap_or(100) as usize;
        let buffers = match self.state.app_state.output_buffers.lock_or_err() {
            Ok(guard) => guard,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(e.to_string())]));
            }
        };
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
    #[tool]
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
    #[tool]
    async fn get_terminal_states(&self) -> Result<CallToolResult, ErrorData> {
        let states = crate::activity::detect_all_terminal_states(&self.state.app_state);
        Ok(json_result(&json!({ "states": states })))
    }

    // ── Workspace (4) ──

    /// List all workspaces with pane layouts and active workspace ID.
    #[tool]
    async fn list_workspaces(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "workspaces", "list", json!({})).await
    }

    /// Get the currently active workspace with full pane details including paneIndex and terminalId for each pane.
    #[tool]
    async fn get_active_workspace(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "workspaces", "getActive", json!({}))
            .await
    }

    /// Switch to a different workspace by ID.
    #[tool]
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

    /// Create a new workspace, optionally from a layout template. Returns the new workspace's id, name, and pane count.
    #[tool]
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

    // ── Grid/Pane (4) ──

    /// Get grid state: editMode, focusedPaneIndex, and activeWorkspaceId.
    #[tool]
    async fn get_grid_state(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "grid", "getState", json!({})).await
    }

    /// Focus a specific pane by index.
    #[tool]
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

    /// Split a pane horizontally or vertically. Returns info about the new pane created.
    #[tool]
    async fn split_pane(
        &self,
        Parameters(p): Parameters<SplitPaneParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "panes",
            "split",
            json!({ "paneIndex": p.pane_index, "direction": p.direction.to_string() }),
        )
        .await
    }

    /// Remove a pane from the active workspace grid. Remaining panes redistribute space.
    #[tool]
    async fn remove_pane(
        &self,
        Parameters(p): Parameters<PaneIndexParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "panes",
            "remove",
            json!({ "paneIndex": p.pane_index }),
        )
        .await
    }

    // ── Utility (3) ──

    /// Capture a screenshot of the current IDE UI. Returns image content.
    #[tool]
    async fn take_screenshot(&self) -> Result<CallToolResult, ErrorData> {
        let data =
            match bridge_request(&self.state, "action", "screenshot", "capture", json!({})).await {
                Ok(data) => data,
                Err((_status, axum::Json(body))) => {
                    let msg = body
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Screenshot failed");
                    return Ok(CallToolResult::error(vec![Content::text(msg)]));
                }
            };

        let Some(data_url) = data.get("dataUrl").and_then(|v| v.as_str()) else {
            return Ok(CallToolResult::error(vec![Content::text(
                "No dataUrl in screenshot response",
            )]));
        };

        let base64_data = data_url
            .strip_prefix("data:image/png;base64,")
            .unwrap_or(data_url);

        Ok(CallToolResult::success(vec![Content::image(
            base64_data,
            "image/png",
        )]))
    }

    /// List all notifications across workspaces.
    #[tool]
    async fn list_notifications(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "notifications", "list", json!({}))
            .await
    }

    /// Create a notification in the IDE.
    #[tool]
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
            params["level"] = json!(level.to_string());
        }
        self.bridge("action", "notifications", "add", params).await
    }
}

// ── ServerHandler trait ───────────────────────────────────────────

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new(
                MCP_SERVER_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Laymux IDE automation via MCP. \
                 Control terminals, workspaces, grid layout, and capture screenshots.\n\n\
                 ## Self-identification\n\
                 Your terminal has the env var LX_TERMINAL_ID (e.g. \"terminal-pane-a1b2c3d4\"). \
                 Read it with `echo $LX_TERMINAL_ID` then call `identify_caller` with that value to learn:\n\
                 - Which workspace you are in (id, name, whether it is active)\n\
                 - Your pane position in the grid (x, y, w, h as 0-1 normalized coordinates, pane index)\n\
                 - Neighboring panes (left, right, above, below) and their terminal IDs\n\
                 - Your terminal metadata (cwd, branch, activity state)\n\n\
                 ## Other env vars\n\
                 - LX_AUTOMATION_PORT: The port this MCP server runs on\n\
                 - LX_GROUP_ID: Your sync group (terminals in the same group share CWD)\n\n\
                 ## Common workflows\n\
                 - Find yourself: echo $LX_TERMINAL_ID → identify_caller\n\
                 - Send command to adjacent pane: identify_caller → use neighbors.right.terminalId → write_to_terminal\n\
                 - Read another pane's output: list_terminals → read_terminal_output with target terminal_id"
                    .to_string(),
            )
    }
}

// ── Helpers ───────────────────────────────────────────────────────

fn json_result(data: &Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(data)
        .unwrap_or_else(|e| format!("{{\"error\": \"serialize failed: {e}\"}}"));
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
    fn send_notification_param_with_level() {
        let json = r#"{"terminal_id":"t1","workspace_id":"ws1","message":"fail","level":"error"}"#;
        let p: SendNotificationParam = serde_json::from_str(json).unwrap();
        assert!(matches!(p.level, Some(NotificationLevel::Error)));
    }

    #[test]
    fn split_direction_enum_deserialize() {
        let json = r#"{"pane_index":0,"direction":"horizontal"}"#;
        let p: SplitPaneParam = serde_json::from_str(json).unwrap();
        assert!(matches!(p.direction, SplitDirection::Horizontal));
        assert_eq!(p.direction.to_string(), "horizontal");

        let json = r#"{"pane_index":1,"direction":"vertical"}"#;
        let p: SplitPaneParam = serde_json::from_str(json).unwrap();
        assert!(matches!(p.direction, SplitDirection::Vertical));
    }

    #[test]
    fn split_direction_rejects_invalid() {
        let json = r#"{"pane_index":0,"direction":"diagonal"}"#;
        let result: Result<SplitPaneParam, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn notification_level_rejects_invalid() {
        let json = r#"{"terminal_id":"t1","workspace_id":"ws1","message":"x","level":"critical"}"#;
        let result: Result<SendNotificationParam, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn json_result_wraps_as_text_content() {
        let data = json!({"key": "value"});
        let result = json_result(&data);
        // is_error is None or Some(false) for success
        assert_ne!(result.is_error, Some(true));
        assert_eq!(result.content.len(), 1);
    }

    #[test]
    fn mcp_allowed_hosts_includes_loopback() {
        let hosts = mcp_allowed_hosts();
        assert!(hosts.contains(&"localhost".to_string()));
        assert!(hosts.contains(&"127.0.0.1".to_string()));
        assert!(hosts.contains(&"::1".to_string()));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn mcp_allowed_hosts_includes_local_ips() {
        let hosts = mcp_allowed_hosts();
        // On Windows with WSL2, there should be at least one non-loopback IP
        // (e.g. vEthernet adapter, LAN adapter)
        let non_loopback = hosts
            .iter()
            .filter(|h| *h != "localhost" && *h != "127.0.0.1" && *h != "::1")
            .count();
        assert!(
            non_loopback > 0,
            "Expected local interface IPs but got only loopback: {:?}",
            hosts
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn local_interface_ips_returns_valid_ipv4() {
        let ips = local_interface_ips();
        for ip in &ips {
            assert!(
                ip.parse::<std::net::Ipv4Addr>().is_ok(),
                "Not a valid IPv4: {}",
                ip
            );
            assert_ne!(ip, "127.0.0.1", "Should exclude loopback");
        }
    }

    #[test]
    fn write_terminal_escape_true_converts_sequences() {
        // With escape=true, literal \r\n is converted to CR+LF
        let json = r#"{"terminal_id":"t1","data":"ls\\r\\n","escape":true}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(p.escape);
        assert_eq!(p.data, r"ls\r\n");
        let unescaped = super::super::helpers::unescape_terminal_input(&p.data);
        assert_eq!(unescaped, "ls\r\n");
    }

    #[test]
    fn write_terminal_escape_true_ctrl_c() {
        let json = r#"{"terminal_id":"t1","data":"\\u0003","escape":true}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(p.escape);
        let unescaped = super::super::helpers::unescape_terminal_input(&p.data);
        assert_eq!(unescaped, "\u{0003}");
    }

    #[test]
    fn write_terminal_escape_false_preserves_backslashes() {
        // Default (escape=false): backslashes in Windows paths are preserved
        let json = r#"{"terminal_id":"t1","data":"cd C:\\new\\tmp"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(!p.escape);
        // Without unescape, \n and \t remain literal backslash sequences
        assert_eq!(p.data, r"cd C:\new\tmp");
    }

    #[test]
    fn write_terminal_escape_defaults_to_false() {
        let json = r#"{"terminal_id":"t1","data":"hello"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(!p.escape);
    }
}
