//! Embedded MCP (Model Context Protocol) server using the official `rmcp` SDK.
//!
//! Uses `#[tool]` derive macros for automatic tool definition and JSON-RPC 2.0
//! handling. Mounted via `nest_service("/mcp", ...)` in the existing axum router.

use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{
    CallToolResult, Content, ListResourceTemplatesResult, ListResourcesResult,
    PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResult, ServerCapabilities,
    ServerInfo, SubscribeRequestParams, UnsubscribeRequestParams,
};
use rmcp::service::{NotificationContext, RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::constants::MCP_SERVER_NAME;
use crate::lock_ext::MutexExt;

use super::helpers::bridge_request;
use super::mcp_resources::{
    self, bridge_read_failed, new_peer_id, read_result_json, read_result_text, resource_not_found,
    resource_templates, static_resources, PeerId, ResourceUri, SharedSubscriptionRegistry,
};
use super::ServerState;

// ── Parameter types ───────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListTerminalsParam {
    /// Filter by workspace ID (optional — omit to list all terminals)
    workspace_id: Option<String>,
}

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
    /// When true (default), append CR (\\r) after data to simulate pressing
    /// Enter — reliably submits in PowerShell, bash, Claude Code, Codex, etc.
    /// Set to `false` to type without submitting (e.g. inserting text mid-line
    /// in vim, composing a multi-line prompt). Works regardless of `escape`.
    #[serde(default = "default_true")]
    enter: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct WriteToNeighborParam {
    /// Your terminal ID (the caller). Use $LX_TERMINAL_ID.
    terminal_id: String,
    /// Direction of the neighbor to write to.
    direction: NeighborDirection,
    /// Text to send.
    data: String,
    /// When true, C-style escape sequences are converted (same as write_to_terminal).
    #[serde(default)]
    escape: bool,
    /// When true (default), append CR after data to simulate Enter. Set to
    /// `false` to type without submitting. See `write_to_terminal` for details.
    #[serde(default = "default_true")]
    enter: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum NeighborDirection {
    Left,
    Right,
    Above,
    Below,
}

impl std::fmt::Display for NeighborDirection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NeighborDirection::Left => write!(f, "left"),
            NeighborDirection::Right => write!(f, "right"),
            NeighborDirection::Above => write!(f, "above"),
            NeighborDirection::Below => write!(f, "below"),
        }
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ReadOutputParam {
    /// Terminal ID
    terminal_id: String,
    /// Number of lines to read (default: 100)
    lines: Option<u64>,
    /// Output format: "raw" (default, with ANSI escapes) or "text" (plain text, ANSI stripped).
    format: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct WorkspaceIdParam {
    /// Workspace ID
    workspace_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SwitchWorkspaceParam {
    /// Workspace ID (e.g. "ws-abc12345")
    workspace_id: Option<String>,
    /// Workspace name (alternative to workspace_id)
    name: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListWorkspacesParam {
    /// When true, returns only id, name, pane_count, and active status (no pane details)
    #[serde(default)]
    summary: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RenameWorkspaceParam {
    /// Workspace ID
    workspace_id: String,
    /// New name for the workspace
    name: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ListNotificationsParam {
    /// Filter by workspace ID (optional)
    workspace_id: Option<String>,
    /// Filter by terminal ID (optional)
    terminal_id: Option<String>,
    /// Only return unread notifications
    #[serde(default)]
    unread_only: Option<bool>,
    /// Maximum number of notifications to return
    limit: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ClearNotificationsParam {
    /// Specific notification IDs to clear. Mutually exclusive with `before`.
    #[serde(default)]
    ids: Option<Vec<String>>,
    /// Clear notifications created strictly before this epoch ms.
    /// Mutually exclusive with `ids`.
    #[serde(default)]
    before: Option<u64>,
    /// Combined with `before`: when true, only already-read notifications
    /// (readAt != null) older than the timestamp are cleared. Unread older
    /// notifications are preserved. Ignored when `ids` is used. Default false.
    #[serde(default)]
    read_only: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SearchOutputParam {
    /// Terminal ID
    terminal_id: String,
    /// Search pattern (plain text substring match)
    pattern: String,
    /// Number of context lines before and after each match (default: 2)
    context_lines: Option<usize>,
    /// Maximum number of matches to return (default: 10)
    max_results: Option<usize>,
    /// Maximum number of recent lines to search (default: 1000)
    max_lines: Option<usize>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct BroadcastWriteParam {
    /// Terminal IDs to send to
    terminal_ids: Vec<String>,
    /// Text to send
    data: String,
    /// When true, process C-style escape sequences
    #[serde(default)]
    escape: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateWorkspaceParam {
    /// Workspace name
    name: String,
    /// Layout ID to use as template (optional)
    layout_id: Option<String>,
    /// Initial working directory for terminals in the new workspace (optional)
    cwd: Option<String>,
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
    /// Terminal profile name for the new pane (e.g. "PowerShell", "WSL"). Use list_profiles to see available profiles.
    profile: Option<String>,
    /// Initial working directory for the new terminal (optional)
    cwd: Option<String>,
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

/// Resize a pane by adjusting its dimensions.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ResizePaneParam {
    /// Pane index to resize (0-based)
    pane_index: u64,
    /// Width delta (-1.0 to 1.0, e.g. 0.1 to grow 10%)
    #[serde(default)]
    dw: Option<f64>,
    /// Height delta (-1.0 to 1.0, e.g. -0.1 to shrink 10%)
    #[serde(default)]
    dh: Option<f64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SwapPanesParam {
    /// First pane index (0-based)
    source_index: u64,
    /// Second pane index (0-based)
    target_index: u64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ScreenshotParam {
    /// Capture a specific pane by index (optional — omit to capture the full IDE)
    pane_index: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SendNotificationParam {
    /// Terminal ID (optional — omit for workspace-level notification)
    terminal_id: Option<String>,
    /// Workspace ID (optional — defaults to active workspace)
    workspace_id: Option<String>,
    /// Notification message
    message: String,
    /// Notification level (default: info)
    level: Option<NotificationLevel>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ExecuteCommandParam {
    /// Terminal ID
    terminal_id: String,
    /// Command to execute (Enter is appended automatically)
    command: String,
    /// Timeout in milliseconds (default: 10000, max: 60000)
    timeout_ms: Option<u64>,
    /// Output format: "raw" (default) or "text" (ANSI stripped)
    format: Option<String>,
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
    /// Per-terminal mutex to serialize execute_command calls on the same terminal.
    exec_locks: Arc<TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>>,
    /// Shared subscription registry: tracks `resources/subscribe` requests so
    /// the Tauri→MCP event bridge can push `notifications/resources/updated`
    /// to the correct peers.
    subscriptions: SharedSubscriptionRegistry,
    /// Process-unique id of the MCP peer this handler instance serves. Used
    /// as the key inside [`subscriptions`].
    peer_id: PeerId,
}

impl McpHandler {
    pub fn new(state: ServerState, subscriptions: SharedSubscriptionRegistry) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
            exec_locks: Arc::new(TokioMutex::new(HashMap::new())),
            subscriptions,
            peer_id: new_peer_id(),
        }
    }

    /// Get or create a per-terminal lock for execute_command serialization.
    async fn terminal_exec_lock(&self, terminal_id: &str) -> Arc<TokioMutex<()>> {
        let mut map = self.exec_locks.lock().await;
        map.entry(terminal_id.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone()
    }

    /// Prepare terminal input: apply escape sequences and optional Enter (CR).
    fn prepare_input(data: &str, escape: bool, enter: bool) -> String {
        let mut result = if escape {
            super::helpers::unescape_terminal_input(data)
        } else {
            data.to_string()
        };
        if enter {
            result.push('\r');
        }
        result
    }

    /// Write bytes to a terminal PTY. Returns (bytes_written) or error.
    fn write_pty(&self, terminal_id: &str, data: &[u8]) -> Result<usize, CallToolResult> {
        let ptys = self
            .state
            .app_state
            .pty_handles
            .lock_or_err()
            .map_err(|e| CallToolResult::error(vec![Content::text(e.to_string())]))?;
        match ptys.get(terminal_id) {
            Some(handle) => handle
                .write(data)
                .map(|_| data.len())
                .map_err(|e| CallToolResult::error(vec![Content::text(e)])),
            None => Err(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                terminal_id
            ))])),
        }
    }

    /// Bridge request returning raw Value on success, or CallToolResult error.
    /// Use this when you need to transform the result before returning.
    async fn bridge_raw(
        &self,
        category: &str,
        target: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, CallToolResult> {
        bridge_request(&self.state, category, target, method, params)
            .await
            .map_err(|(_status, axum::Json(body))| {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                CallToolResult::error(vec![Content::text(msg)])
            })
    }

    /// Bridge request, transform the JSON payload in-place, then return a normal JSON tool result.
    async fn bridge_transform<F>(
        &self,
        category: &str,
        target: &str,
        method: &str,
        params: Value,
        transform: F,
    ) -> Result<CallToolResult, ErrorData>
    where
        F: FnOnce(&mut Value),
    {
        let mut data = match self.bridge_raw(category, target, method, params).await {
            Ok(data) => data,
            Err(e) => return Ok(e),
        };
        transform(&mut data);
        Ok(json_result(&data))
    }

    /// Bridge request to frontend via Tauri event.
    /// Returns json_result on success, CallToolResult::error on failure.
    async fn bridge(
        &self,
        category: &str,
        target: &str,
        method: &str,
        params: Value,
    ) -> Result<CallToolResult, ErrorData> {
        match self.bridge_raw(category, target, method, params).await {
            Ok(data) => Ok(json_result(&data)),
            Err(e) => Ok(e),
        }
    }

    /// Lock output_buffers mutex, returning a tool error on poisoned lock.
    fn lock_output_buffers(
        &self,
    ) -> Result<
        std::sync::MutexGuard<'_, HashMap<String, crate::output_buffer::TerminalOutputBuffer>>,
        CallToolResult,
    > {
        self.state
            .app_state
            .output_buffers
            .lock_or_err()
            .map_err(|e| CallToolResult::error(vec![Content::text(e.to_string())]))
    }

    /// Read recent lines for a terminal, standardizing lock and not-found handling.
    fn recent_output_lines(
        &self,
        terminal_id: &str,
        lines: usize,
    ) -> Result<(String, usize), CallToolResult> {
        let buffers = self.lock_output_buffers()?;
        match buffers.get(terminal_id) {
            Some(buf) => Ok((buf.recent_lines(lines), buf.len())),
            None => Err(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                terminal_id
            ))])),
        }
    }

    /// Resolve the workspace containing the given terminal from the bridge terminal list.
    async fn terminal_workspace_id(&self, terminal_id: &str) -> Result<String, CallToolResult> {
        let data = self
            .bridge_raw("query", "terminals", "list", json!({}))
            .await?;
        data.get("instances")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(terminal_id))
            })
            .and_then(|t| t.get("workspaceId").and_then(|v| v.as_str()))
            .map(|id| id.to_string())
            .ok_or_else(|| {
                CallToolResult::error(vec![Content::text(format!(
                    "Terminal '{}' not found or has no workspace",
                    terminal_id
                ))])
            })
    }

    /// Resolve a resource URI into its read result. Shared between
    /// `ServerHandler::read_resource` and unit tests.
    ///
    /// Returns a structured `McpError` on unknown URIs so clients can
    /// differentiate missing resources from transport errors.
    pub(crate) async fn read_resource_inner(
        &self,
        uri: &str,
    ) -> Result<ReadResourceResult, ErrorData> {
        let Some(parsed) = ResourceUri::parse(uri) else {
            return Err(resource_not_found(uri));
        };
        match parsed {
            ResourceUri::WorkspaceActive => {
                let mut data = self
                    .bridge_raw("query", "workspaces", "getActive", json!({}))
                    .await
                    .map_err(|_| bridge_read_failed(uri, "workspaces.getActive"))?;
                if let Some(panes) = data
                    .get_mut("workspace")
                    .and_then(|ws| ws.get_mut("panes"))
                    .and_then(|v| v.as_array_mut())
                {
                    Self::enrich_with_activity(
                        &self.state.app_state,
                        panes,
                        "terminalId",
                        "terminalActivity",
                    );
                }
                Ok(read_result_json(uri, &data))
            }
            ResourceUri::WorkspaceList => {
                let data = self
                    .bridge_raw("query", "workspaces", "list", json!({}))
                    .await
                    .map_err(|_| bridge_read_failed(uri, "workspaces.list"))?;
                let summary = workspace_list_summary(&data);
                Ok(read_result_json(uri, &summary))
            }
            ResourceUri::ProfileList => {
                let data = self
                    .bridge_raw("query", "profiles", "list", json!({}))
                    .await
                    .map_err(|_| bridge_read_failed(uri, "profiles.list"))?;
                Ok(read_result_json(uri, &data))
            }
            ResourceUri::Terminal(terminal_id) => {
                // Fetch the full terminal list once and filter down to this id.
                // Individual `query terminals get` may not exist on all bridges,
                // so list+filter keeps behavior aligned with `list_terminals`.
                let mut data = self
                    .bridge_raw("query", "terminals", "list", json!({}))
                    .await
                    .map_err(|_| bridge_read_failed(uri, "terminals.list"))?;
                let instance = data
                    .get_mut("instances")
                    .and_then(|v| v.as_array_mut())
                    .and_then(|arr| {
                        Self::enrich_with_activity(&self.state.app_state, arr, "id", "activity");
                        arr.iter().find(|inst| {
                            inst.get("id").and_then(|v| v.as_str()) == Some(terminal_id.as_str())
                        })
                    })
                    .cloned();
                match instance {
                    Some(inst) => Ok(read_result_json(uri, &inst)),
                    None => Err(resource_not_found(uri)),
                }
            }
            ResourceUri::TerminalOutput(terminal_id) => {
                let buffers = match self.lock_output_buffers() {
                    Ok(b) => b,
                    Err(_) => return Err(bridge_read_failed(uri, "output_buffers lock")),
                };
                let buf = buffers
                    .get(&terminal_id)
                    .ok_or_else(|| resource_not_found(uri))?;
                let raw = buf.recent_lines(500);
                drop(buffers);
                let text = super::helpers::strip_ansi(&raw);
                Ok(read_result_text(uri, text))
            }
        }
    }

    /// Enrich a JSON array of objects by injecting activity state from backend detection.
    /// `id_field` is the JSON key containing the terminal ID (e.g. "id" or "terminalId").
    /// `activity_field` is the key to insert (e.g. "activity" or "terminalActivity").
    fn enrich_with_activity(
        app_state: &crate::state::AppState,
        items: &mut Vec<Value>,
        id_field: &str,
        activity_field: &str,
    ) {
        let states = crate::activity::detect_all_terminal_states(app_state);
        for item in items.iter_mut() {
            if let Some(id) = item.get(id_field).and_then(|v| v.as_str()) {
                if let Some(state_info) = states.get(id) {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert(
                            activity_field.to_string(),
                            serde_json::to_value(state_info).unwrap_or(json!(null)),
                        );
                    }
                }
            }
        }
    }
}

/// Release this session's entry in the shared subscription registry.
///
/// `StreamableHttpService` creates a fresh [`McpHandler`] per MCP session
/// (see `get_service` in rmcp's stateful HTTP transport). When the session
/// ends — client DELETE, transport close, or timeout — rmcp drops the
/// handler. Without this cleanup the peer handle captured in
/// [`ServerHandler::on_initialized`] and every URI subscription attached
/// to it would accumulate for the lifetime of the process, growing both
/// the `peers` map and the per-notification iteration cost.
impl Drop for McpHandler {
    fn drop(&mut self) {
        if let Ok(mut reg) = self.subscriptions.lock_or_err() {
            reg.unregister_peer(&self.peer_id);
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
    subscriptions: SharedSubscriptionRegistry,
) -> StreamableHttpService<McpHandler, LocalSessionManager> {
    StreamableHttpService::new(
        move || Ok(McpHandler::new(state.clone(), subscriptions.clone())),
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

    /// List terminal instances with id, profile, syncGroup, workspaceId, cwd, paneIndex, and panePosition.
    /// Pass workspace_id to filter terminals by workspace (omit for all terminals).
    /// The activity field reflects real-time backend detection (shell or interactiveApp).
    #[tool]
    async fn list_terminals(
        &self,
        Parameters(p): Parameters<ListTerminalsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge_transform("query", "terminals", "list", json!({}), |data| {
            if let Some(instances) = data.get_mut("instances").and_then(|v| v.as_array_mut()) {
                Self::enrich_with_activity(&self.state.app_state, instances, "id", "activity");
                if let Some(ref ws_id) = p.workspace_id {
                    instances.retain(|inst| {
                        inst.get("workspaceId")
                            .and_then(|v| v.as_str())
                            .map(|id| id == ws_id)
                            .unwrap_or(false)
                    });
                }
            }
        })
        .await
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
        self.bridge("query", "terminals", "get", json!({ "id": p.terminal_id }))
            .await
    }

    /// Send input to a terminal. By default the input is submitted (Enter key)
    /// after sending — suitable for running commands or replying to TUI prompts
    /// (Claude Code, Codex, REPLs). Pass `enter: false` to type without
    /// submitting (e.g. inserting text mid-line in vim, composing a multi-line
    /// prompt before a manual submit).
    /// Set `escape` to true for C-style sequences: `\\r` for Enter, `\\n` for
    /// newline, `\\u0003` for Ctrl+C. Leave `escape` false for literal text
    /// (preserves backslashes in Windows paths like `C:\\Users`).
    #[tool]
    async fn write_to_terminal(
        &self,
        Parameters(p): Parameters<WriteTerminalParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let data = Self::prepare_input(&p.data, p.escape, p.enter);
        match self.write_pty(&p.terminal_id, data.as_bytes()) {
            Ok(bytes) => Ok(json_result(&json!({
                "written": true,
                "bytes": bytes,
                "bytesWritten": bytes,
                "enter": p.enter,
            }))),
            Err(e) => Ok(e),
        }
    }

    /// Write to a neighboring pane by direction. Combines identify_caller + write_to_terminal
    /// in a single call. Pass your own terminal_id (from $LX_TERMINAL_ID) and the direction
    /// of the neighbor you want to send to. Like `write_to_terminal`, input is
    /// submitted by default; pass `enter: false` to type without submitting.
    #[tool]
    async fn write_to_neighbor(
        &self,
        Parameters(p): Parameters<WriteToNeighborParam>,
    ) -> Result<CallToolResult, ErrorData> {
        // 1. Identify caller to find neighbor
        let data = match self
            .bridge_raw(
                "query",
                "terminals",
                "identify",
                json!({ "id": p.terminal_id }),
            )
            .await
        {
            Ok(d) => d,
            Err(e) => return Ok(e),
        };
        let dir_str = p.direction.to_string();
        let neighbor_id = data
            .get("neighbors")
            .and_then(|n| n.get(&dir_str))
            .and_then(|n| n.get("terminalId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let Some(target_id) = neighbor_id else {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "No neighbor {} of terminal '{}'",
                p.direction, p.terminal_id
            ))]));
        };

        // 2. Write to the neighbor
        let data = Self::prepare_input(&p.data, p.escape, p.enter);
        match self.write_pty(&target_id, data.as_bytes()) {
            Ok(bytes) => Ok(json_result(&json!({
                "written": true,
                "bytes": bytes,
                "enter": p.enter,
                "targetTerminalId": target_id,
                "direction": p.direction.to_string(),
            }))),
            Err(e) => Ok(e),
        }
    }

    /// Read recent terminal output from ring buffer. Contains raw ANSI escapes.
    /// WARNING: TUI apps (Claude Code, vim) may return very large output (>100KB)
    /// even for few lines due to escape sequences. Use `take_screenshot` for TUI apps.
    #[tool]
    async fn read_terminal_output(
        &self,
        Parameters(p): Parameters<ReadOutputParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let lines = p.lines.unwrap_or(100) as usize;
        let (raw, buffer_size) = match self.recent_output_lines(&p.terminal_id, lines) {
            Ok(output) => output,
            Err(e) => return Ok(e),
        };
        let output = match p.format.as_deref() {
            Some("text") => super::helpers::strip_ansi(&raw),
            _ => raw,
        };
        Ok(json_result(&json!({
            "output": output,
            "lines": output.lines().count(),
            "bufferSize": buffer_size,
        })))
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

    /// Get activity state for all terminals. Returns "shell" or "interactiveApp" (with app name).
    #[tool]
    async fn get_terminal_states(&self) -> Result<CallToolResult, ErrorData> {
        let states = crate::activity::detect_all_terminal_states(&self.state.app_state);
        Ok(json_result(&json!({ "states": states })))
    }

    /// Execute a command in a terminal and return the output. Atomic operation:
    /// verifies the terminal is at a shell prompt, sends the command, waits for
    /// completion (prompt returns), and returns only the command's output.
    /// Only works on terminals at a shell prompt (not TUI apps).
    /// Note: `exit_code` relies on OSC 133;D shell integration and may be `null`
    /// if the shell doesn't support it, or briefly stale during rapid successive calls.
    #[tool]
    async fn execute_command(
        &self,
        Parameters(p): Parameters<ExecuteCommandParam>,
    ) -> Result<CallToolResult, ErrorData> {
        // Reject commands containing CR/LF to prevent multi-command injection
        if p.command.contains('\r') || p.command.contains('\n') {
            return Ok(CallToolResult::error(vec![Content::text(
                "Command must not contain CR or LF characters (use separate execute_command calls for multiple commands)",
            )]));
        }

        let timeout_ms = p.timeout_ms.unwrap_or(10_000).min(60_000);
        let strip = matches!(p.format.as_deref(), Some("text"));

        // Acquire per-terminal lock to serialize concurrent execute_command calls
        let lock = self.terminal_exec_lock(&p.terminal_id).await;
        let _guard = lock.lock().await;

        // 1. Check terminal is at shell prompt and record sequence number atomically
        let before_seq = {
            let buffers = match self.lock_output_buffers() {
                Ok(g) => g,
                Err(e) => return Ok(e),
            };
            match buffers.get(&p.terminal_id) {
                Some(buf) => {
                    if !crate::activity::is_terminal_at_prompt_from_buffer(Some(buf)) {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "Terminal is not at a shell prompt (command running or TUI app active)",
                        )]));
                    }
                    buf.write_seq()
                }
                None => {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "Terminal '{}' not found",
                        p.terminal_id
                    ))]));
                }
            }
        };

        // 2. Write command + CR
        let cmd = format!("{}\r", p.command);
        if let Err(e) = self.write_pty(&p.terminal_id, cmd.as_bytes()) {
            return Ok(e);
        }

        // 3. Poll until prompt returns or timeout
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_millis(timeout_ms);
        // Small initial delay to let the shell process the command
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        loop {
            if start.elapsed() > timeout {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Command timed out after {}ms",
                    timeout_ms
                ))]));
            }

            let at_prompt = {
                let buffers = match self.lock_output_buffers() {
                    Ok(g) => g,
                    Err(e) => return Ok(e),
                };
                crate::activity::is_terminal_at_prompt_from_buffer(buffers.get(&p.terminal_id))
            };

            if at_prompt {
                break;
            }

            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        // 4. Read output using sequence number (immune to ring buffer wrap)
        let output = {
            let buffers = match self.lock_output_buffers() {
                Ok(g) => g,
                Err(e) => return Ok(e),
            };
            match buffers.get(&p.terminal_id) {
                Some(buf) => buf.bytes_since(before_seq),
                None => Vec::new(),
            }
        };

        let raw_output = String::from_utf8_lossy(&output).to_string();
        let final_output = if strip {
            super::helpers::strip_ansi(&raw_output)
        } else {
            raw_output
        };

        // 5. Try to get exit code from terminal session
        let exit_code = {
            let terminals = self.state.app_state.terminals.lock_or_err().ok();
            terminals.and_then(|t| t.get(&p.terminal_id).and_then(|s| s.last_exit_code))
        };

        Ok(json_result(&json!({
            "output": final_output,
            "exit_code": exit_code,
            "duration_ms": duration_ms,
        })))
    }

    // ── Workspace (4) ──

    /// List workspaces. Pass summary=true for compact output (id, name, pane_count, isActive).
    #[tool]
    async fn list_workspaces(
        &self,
        Parameters(p): Parameters<ListWorkspacesParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge_transform("query", "workspaces", "list", json!({}), |data| {
            if !p.summary.unwrap_or(false) {
                return;
            }
            if let Some(workspaces) = data.get("workspaces").and_then(|v| v.as_array()) {
                let active_id = data.get("activeWorkspaceId").and_then(|v| v.as_str());
                let summary: Vec<Value> = workspaces
                    .iter()
                    .map(|ws| {
                        let ws_id = ws.get("id").and_then(|v| v.as_str());
                        json!({
                            "id": ws.get("id"),
                            "name": ws.get("name"),
                            "paneCount": ws.get("panes").and_then(|p| p.as_array()).map(|a| a.len()),
                            "isActive": active_id.is_some() && ws_id == active_id,
                        })
                    })
                    .collect();
                let active_workspace_id = data.get("activeWorkspaceId").cloned();
                *data = json!({
                    "workspaces": summary,
                    "workspaceSummaries": summary,
                    "activeWorkspaceId": active_workspace_id,
                });
            }
        })
        .await
    }

    /// Get the currently active workspace with full pane details, terminal activity states,
    /// and focusedPaneIndex — a single call for complete workspace context.
    #[tool]
    async fn get_active_workspace(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge_transform("query", "workspaces", "getActive", json!({}), |data| {
            if let Some(panes) = data
                .get_mut("workspace")
                .and_then(|ws| ws.get_mut("panes"))
                .and_then(|v| v.as_array_mut())
            {
                Self::enrich_with_activity(
                    &self.state.app_state,
                    panes,
                    "terminalId",
                    "terminalActivity",
                );
            }
        })
        .await
    }

    /// Switch to a different workspace by ID or name.
    #[tool]
    async fn switch_workspace(
        &self,
        Parameters(p): Parameters<SwitchWorkspaceParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let ws_id =
            if let Some(id) = p.workspace_id {
                id
            } else if let Some(name) = p.name {
                // Resolve name to ID via list
                let data = match self
                    .bridge_raw("query", "workspaces", "list", json!({}))
                    .await
                {
                    Ok(d) => d,
                    Err(e) => return Ok(e),
                };
                let name_lower = name.to_lowercase();
                let all_matches: Vec<&Value> = data
                    .get("workspaces")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter(|ws| {
                                ws.get("name")
                                    .and_then(|n| n.as_str())
                                    .map(|n| n.to_lowercase() == name_lower)
                                    .unwrap_or(false)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                match all_matches.len() {
                    0 => {
                        return Ok(CallToolResult::error(vec![Content::text(format!(
                            "Workspace '{}' not found",
                            name
                        ))]))
                    }
                    1 => all_matches[0]
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    n => {
                        let exact = all_matches
                            .iter()
                            .find(|ws| ws.get("name").and_then(|v| v.as_str()) == Some(&name));
                        let chosen = exact.unwrap_or(&all_matches[0]);
                        let id = chosen
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        tracing::warn!(
                        "switch_workspace: {} workspaces match '{}' (case-insensitive), using '{}'",
                        n, name, id
                    );
                        id
                    }
                }
            } else {
                return Ok(CallToolResult::error(vec![Content::text(
                    "Either workspace_id or name is required",
                )]));
            };

        self.bridge(
            "action",
            "workspaces",
            "switchActive",
            json!({ "id": ws_id }),
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
        if let Some(cwd) = p.cwd {
            params["cwd"] = json!(cwd);
        }
        self.bridge("action", "workspaces", "add", params).await
    }

    /// Delete a workspace by ID. Cannot delete the last workspace.
    #[tool]
    async fn delete_workspace(
        &self,
        Parameters(p): Parameters<WorkspaceIdParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "workspaces",
            "remove",
            json!({ "id": p.workspace_id }),
        )
        .await
    }

    /// Rename a workspace.
    #[tool]
    async fn rename_workspace(
        &self,
        Parameters(p): Parameters<RenameWorkspaceParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "workspaces",
            "rename",
            json!({ "id": p.workspace_id, "name": p.name }),
        )
        .await
    }

    /// List available layout templates for create_workspace.
    #[tool]
    async fn list_layouts(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "layouts", "list", json!({})).await
    }

    // ── Grid/Pane ──

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
    /// The response includes a `ready` field: when false, the terminal is allocated but
    /// not yet registered (React render pending). Poll `list_terminals` or wait ~500ms
    /// before calling `write_to_terminal` or `execute_command` on the new terminal.
    #[tool]
    async fn split_pane(
        &self,
        Parameters(p): Parameters<SplitPaneParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut params = json!({ "paneIndex": p.pane_index, "direction": p.direction.to_string() });
        if let Some(profile) = p.profile {
            params["profile"] = json!(profile);
        }
        if let Some(cwd) = p.cwd {
            params["cwd"] = json!(cwd);
        }
        self.bridge("action", "panes", "split", params).await
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

    /// Resize a pane by adjusting its width and/or height by a delta value.
    /// Use dw for width change and dh for height change (e.g. dw=0.1 grows width by 10%).
    /// At least one of dw or dh must be provided. Values are clamped to -1.0..1.0.
    #[tool]
    async fn resize_pane(
        &self,
        Parameters(p): Parameters<ResizePaneParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if p.dw.is_none() && p.dh.is_none() {
            return Ok(CallToolResult::error(vec![Content::text(
                "At least one of dw or dh must be provided",
            )]));
        }
        let mut delta = json!({});
        if let Some(dw) = p.dw {
            let dw = dw.clamp(-1.0, 1.0);
            delta["w"] = json!(dw);
        }
        if let Some(dh) = p.dh {
            let dh = dh.clamp(-1.0, 1.0);
            delta["h"] = json!(dh);
        }
        self.bridge(
            "action",
            "panes",
            "resize",
            json!({ "paneIndex": p.pane_index, "delta": delta }),
        )
        .await
    }

    /// Swap two panes' positions in the grid.
    #[tool]
    async fn swap_panes(
        &self,
        Parameters(p): Parameters<SwapPanesParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "panes",
            "swap",
            json!({ "sourceIndex": p.source_index, "targetIndex": p.target_index }),
        )
        .await
    }

    // ── Utility (3) ──

    /// Capture a screenshot. Pass pane_index to capture a single pane, or omit for the full IDE.
    #[tool]
    async fn take_screenshot(
        &self,
        Parameters(p): Parameters<ScreenshotParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = match p.pane_index {
            Some(idx) => json!({ "paneIndex": idx }),
            None => json!({}),
        };
        let data = match self
            .bridge_raw("action", "screenshot", "capture", params)
            .await
        {
            Ok(d) => d,
            Err(e) => return Ok(e),
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

    /// List notifications. Supports filtering by workspace, terminal, read status, and limit.
    #[tool]
    async fn list_notifications(
        &self,
        Parameters(p): Parameters<ListNotificationsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge_transform("query", "notifications", "list", json!({}), |data| {
            if let Some(notifications) =
                data.get_mut("notifications").and_then(|v| v.as_array_mut())
            {
                if let Some(ref ws_id) = p.workspace_id {
                    notifications
                        .retain(|n| n.get("workspaceId").and_then(|v| v.as_str()) == Some(ws_id));
                }
                if let Some(ref t_id) = p.terminal_id {
                    notifications
                        .retain(|n| n.get("terminalId").and_then(|v| v.as_str()) == Some(t_id));
                }
                if p.unread_only.unwrap_or(false) {
                    notifications.retain(|n| n.get("readAt").and_then(|v| v.as_u64()).is_none());
                }
                notifications.sort_by(|a, b| {
                    let ts_a = a.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let ts_b = b.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    ts_b.partial_cmp(&ts_a).unwrap_or(std::cmp::Ordering::Equal)
                });
                if let Some(limit) = p.limit {
                    notifications.truncate(limit as usize);
                }
            }
        })
        .await
    }

    /// Clear notifications by ID list or before a timestamp.
    /// Provide exactly one of `ids` or `before`. When using `before`, set
    /// `read_only=true` to preserve older unread notifications. Returns the
    /// number of notifications actually cleared.
    #[tool]
    async fn clear_notifications(
        &self,
        Parameters(p): Parameters<ClearNotificationsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let has_ids = p.ids.is_some();
        let has_before = p.before.is_some();
        if has_ids == has_before {
            return Ok(CallToolResult::error(vec![Content::text(
                "Provide exactly one of 'ids' or 'before'",
            )]));
        }
        let ids_count = p.ids.as_ref().map(|v| v.len());
        let before = p.before;
        let read_only = p.read_only.unwrap_or(false);

        let mut params = json!({});
        if let Some(ids) = p.ids {
            params["ids"] = json!(ids);
        }
        if let Some(before) = p.before {
            params["before"] = json!(before);
        }
        if let Some(read_only) = p.read_only {
            params["readOnly"] = json!(read_only);
        }
        match self
            .bridge_raw("action", "notifications", "clear", params)
            .await
        {
            Ok(data) => {
                let cleared = data.get("cleared").and_then(|v| v.as_u64()).unwrap_or(0);
                tracing::info!(
                    cleared,
                    ids_count = ?ids_count,
                    before = ?before,
                    read_only,
                    "notifications.clear (MCP)"
                );
                Ok(json_result(&data))
            }
            Err(e) => Ok(e),
        }
    }

    /// Create a notification in the IDE. terminal_id and workspace_id are optional —
    /// omit both for a global notification on the active workspace.
    #[tool]
    async fn send_notification(
        &self,
        Parameters(p): Parameters<SendNotificationParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let terminal_id = p.terminal_id.unwrap_or_default();

        // Resolve workspace_id: if terminal_id is given but workspace_id is not,
        // look up the terminal's actual workspace instead of defaulting to active.
        let workspace_id = if let Some(id) = p.workspace_id {
            id
        } else if !terminal_id.is_empty() {
            match self.terminal_workspace_id(&terminal_id).await {
                Ok(id) => id,
                Err(e) => return Ok(e),
            }
        } else {
            // No terminal, no workspace — use active workspace
            let data = match self
                .bridge_raw("query", "grid", "getState", json!({}))
                .await
            {
                Ok(d) => d,
                Err(_) => {
                    return Ok(CallToolResult::error(vec![Content::text(
                        "Failed to resolve active workspace",
                    )]));
                }
            };
            match data.get("activeWorkspaceId").and_then(|v| v.as_str()) {
                Some(id) => id.to_string(),
                None => {
                    return Ok(CallToolResult::error(vec![Content::text(
                        "Failed to resolve active workspace",
                    )]));
                }
            }
        };

        let level = p
            .level
            .map(|level| level.to_string())
            .unwrap_or_else(|| "info".to_string());
        let message = p.message;
        let mut params = json!({
            "terminalId": terminal_id,
            "workspaceId": workspace_id,
            "message": message,
            "level": level,
        });
        if terminal_id.is_empty() {
            params["terminalId"] = json!("");
        }
        self.bridge_transform("action", "notifications", "add", params, |data| {
            if data.get("notification").is_none()
                && data.get("added").and_then(|v| v.as_bool()) == Some(true)
            {
                *data = json!({
                    "added": true,
                    "notification": {
                        "id": Value::Null,
                        "terminalId": terminal_id,
                        "workspaceId": workspace_id,
                        "message": message,
                        "level": level,
                        "createdAt": Value::Null,
                        "readAt": Value::Null,
                    }
                });
            }
        })
        .await
    }

    /// Search terminal output for a pattern. Returns matching lines with context.
    #[tool]
    async fn search_terminal_output(
        &self,
        Parameters(p): Parameters<SearchOutputParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let context_lines = p.context_lines.unwrap_or(2);
        let max_results = p.max_results.unwrap_or(10);
        let max_lines = p.max_lines.unwrap_or(1000);

        // Copy raw data under lock, then release before expensive processing
        let (raw, _) = match self.recent_output_lines(&p.terminal_id, max_lines) {
            Ok(output) => output,
            Err(e) => return Ok(e),
        };

        let text = super::helpers::strip_ansi(&raw);
        let lines: Vec<&str> = text.lines().collect();

        let mut matches: Vec<Value> = Vec::new();
        let mut total_matches: usize = 0;
        for (i, line) in lines.iter().enumerate() {
            if line.contains(&p.pattern) {
                total_matches += 1;
                if matches.len() < max_results {
                    let start = i.saturating_sub(context_lines);
                    let end = (i + context_lines + 1).min(lines.len());
                    let context: Vec<&str> = lines[start..end].to_vec();
                    matches.push(json!({
                        "line": i + 1,
                        "match": line,
                        "context": context,
                    }));
                }
            }
        }

        Ok(json_result(&json!({
            "matches": matches,
            "totalMatches": total_matches,
            "returnedMatches": matches.len(),
            "pattern": p.pattern,
        })))
    }

    /// Send the same input to multiple terminals at once.
    #[tool]
    async fn broadcast_write(
        &self,
        Parameters(p): Parameters<BroadcastWriteParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let data = if p.escape {
            super::helpers::unescape_terminal_input(&p.data)
        } else {
            p.data.clone()
        };

        let ptys = match self.state.app_state.pty_handles.lock_or_err() {
            Ok(g) => g,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        };

        let mut written = Vec::new();
        let mut failed = Vec::new();

        for id in &p.terminal_ids {
            match ptys.get(id) {
                Some(handle) => match handle.write(data.as_bytes()) {
                    Ok(_) => written.push(id.clone()),
                    Err(e) => failed.push(json!({ "id": id, "error": e })),
                },
                None => failed.push(json!({ "id": id, "error": "not found" })),
            }
        }

        Ok(json_result(&json!({
            "written": written,
            "failed": failed,
        })))
    }

    /// List available terminal profiles (e.g. PowerShell, WSL, custom profiles).
    /// Returns all configured profiles from settings, enriched with runtime info from active terminals.
    #[tool]
    async fn list_profiles(&self) -> Result<CallToolResult, ErrorData> {
        // Get runtime info from active terminal sessions
        let mut runtime_info: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        if let Ok(terms) = self.state.app_state.terminals.lock_or_err() {
            for (_, session) in terms.iter() {
                let profile = &session.config.profile;
                if !runtime_info.contains_key(profile) {
                    let shell_type = session
                        .wsl_distro
                        .as_ref()
                        .map(|_| "bash")
                        .unwrap_or("unknown");
                    runtime_info.insert(profile.clone(), shell_type.to_string());
                }
            }
        }

        match self
            .bridge_raw("query", "profiles", "list", json!({}))
            .await
        {
            Ok(data) => {
                // Enrich configured profiles with runtime shell_type
                if let Some(profiles) = data.get("profiles").and_then(|v| v.as_array()) {
                    let enriched: Vec<Value> = profiles
                        .iter()
                        .map(|p| {
                            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let mut profile = p.clone();
                            if let Some(shell_type) = runtime_info.get(name) {
                                profile["shellType"] = json!(shell_type);
                                profile["isRunning"] = json!(true);
                            } else {
                                profile["isRunning"] = json!(false);
                            }
                            profile
                        })
                        .collect();
                    Ok(json_result(&json!({
                        "profiles": enriched,
                        "defaultProfile": data.get("defaultProfile"),
                    })))
                } else {
                    Ok(json_result(&data))
                }
            }
            Err(_) => {
                // Fallback to runtime-only profiles if bridge unavailable
                let profiles: Vec<Value> = runtime_info
                    .iter()
                    .map(|(name, shell_type)| {
                        json!({
                            "name": name,
                            "shellType": shell_type,
                            "isRunning": true,
                        })
                    })
                    .collect();
                Ok(json_result(&json!({ "profiles": profiles })))
            }
        }
    }
}

// ── ServerHandler trait ───────────────────────────────────────────

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpHandler {
    fn get_info(&self) -> ServerInfo {
        // Enable both Tools (existing) and Resources (issue #202).
        // `enable_resources_subscribe` advertises server-side subscription
        // support so clients know they can call `resources/subscribe`.
        let caps = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .enable_resources_subscribe()
            .enable_resources_list_changed()
            .build();

        ServerInfo::new(caps)
            .with_server_info(rmcp::model::Implementation::new(
                MCP_SERVER_NAME,
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(
                "Laymux IDE automation via MCP. \
                 Control terminals, workspaces, grid layout, and capture screenshots.\n\n\
                 ## Self-identification\n\
                 Your terminal has the env var LX_TERMINAL_ID (e.g. \"terminal-pane-a1b2c3d4\"). \
                 Read it with `echo $LX_TERMINAL_ID` (bash/zsh) or `echo $env:LX_TERMINAL_ID` (PowerShell), \
                 then call `identify_caller` with that value to learn:\n\
                 - Which workspace you are in (id, name, whether it is active)\n\
                 - Your pane position in the grid (x, y, w, h as 0-1 normalized coordinates, pane index)\n\
                 - Neighboring panes (left, right, above, below) and their terminal IDs\n\
                 - Your terminal metadata (cwd, activity state)\n\n\
                 ## Other env vars\n\
                 - LX_AUTOMATION_PORT: The port this MCP server runs on\n\
                 - LX_GROUP_ID: Your sync group (terminals in the same group share CWD)\n\n\
                 ## Resources (issue #202)\n\
                 Subscribable read-only state is exposed as MCP Resources.\n\
                 Prefer these over the corresponding list_* tools to avoid polling:\n\
                 - workspace://active — currently active workspace with panes & activity\n\
                 - workspace://list   — workspace summaries\n\
                 - profile://list     — available terminal profiles\n\
                 - terminal://{id}    — single terminal state\n\
                 - terminal://{id}/output — recent terminal output (ANSI stripped, text)\n\
                 Call `resources/subscribe` on any URI to receive `notifications/resources/updated` \
                 when the backing state changes. Tools remain available for backward compatibility.\n\n\
                 ## Common workflows\n\
                 - Find yourself: echo $LX_TERMINAL_ID (or $env:LX_TERMINAL_ID in PowerShell) → identify_caller\n\
                 - Send command to adjacent pane: identify_caller → use neighbors.right.terminalId → write_to_terminal\n\
                 - Read another pane's output: list_terminals → read_terminal_output with target terminal_id"
                    .to_string(),
            )
    }

    // ── Resources (MCP issue #202) ──────────────────────────────

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let mut resources = static_resources();
        resources.extend(mcp_resources::dynamic_terminal_resources(
            &self.state.app_state,
        ));
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult::with_all_items(
            resource_templates(),
        ))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, ErrorData> {
        self.read_resource_inner(&request.uri).await
    }

    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        // Validate the URI parses as a known scheme before accepting.
        if ResourceUri::parse(&request.uri).is_none() {
            return Err(resource_not_found(&request.uri));
        }
        if let Ok(mut reg) = self.subscriptions.lock_or_err() {
            reg.subscribe(&self.peer_id, &request.uri);
        }
        Ok(())
    }

    async fn unsubscribe(
        &self,
        request: UnsubscribeRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<(), ErrorData> {
        if let Ok(mut reg) = self.subscriptions.lock_or_err() {
            reg.unsubscribe(&self.peer_id, &request.uri);
        }
        Ok(())
    }

    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        // Capture the peer handle so the Tauri→MCP bridge can push
        // `notifications/resources/updated` back to this client.
        if let Ok(mut reg) = self.subscriptions.lock_or_err() {
            reg.register_peer(self.peer_id.clone(), context.peer.clone());
        }
        tracing::info!(peer_id = %self.peer_id, "MCP client initialized; peer registered");
    }
}

// ── Helpers ───────────────────────────────────────────────────────

fn json_result(data: &Value) -> CallToolResult {
    let text = serde_json::to_string_pretty(data)
        .unwrap_or_else(|e| format!("{{\"error\": \"serialize failed: {e}\"}}"));
    CallToolResult::success(vec![Content::text(text)])
}

/// Collapse a full workspaces/list response into a summary suitable for
/// `workspace://list`. Mirrors the behavior of `list_workspaces(summary=true)`
/// so MCP clients get a compact, cache-friendly payload.
pub(crate) fn workspace_list_summary(data: &Value) -> Value {
    let active_id = data.get("activeWorkspaceId").and_then(|v| v.as_str());
    let summary: Vec<Value> = data
        .get("workspaces")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|ws| {
                    let ws_id = ws.get("id").and_then(|v| v.as_str());
                    json!({
                        "id": ws.get("id"),
                        "name": ws.get("name"),
                        "paneCount": ws
                            .get("panes")
                            .and_then(|p| p.as_array())
                            .map(|a| a.len()),
                        "isActive": active_id.is_some() && ws_id == active_id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "workspaces": summary,
        "activeWorkspaceId": data.get("activeWorkspaceId").cloned().unwrap_or(Value::Null),
    })
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

    #[test]
    fn write_terminal_enter_defaults_to_true() {
        // enter 필드를 생략하면 자동으로 Enter 제출이 기본 — 대부분의 MCP 호출
        // 의도(= 프롬프트 제출)와 일치시키기 위함.
        let json = r#"{"terminal_id":"t1","data":"hello"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(p.enter, "enter must default to true");
    }

    #[test]
    fn write_terminal_enter_can_be_disabled() {
        let json = r#"{"terminal_id":"t1","data":"hello","enter":false}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(!p.enter);
    }

    #[test]
    fn write_to_neighbor_enter_defaults_to_true() {
        let json = r#"{"terminal_id":"t1","direction":"right","data":"hello"}"#;
        let p: WriteToNeighborParam = serde_json::from_str(json).unwrap();
        assert!(
            p.enter,
            "enter must default to true for neighbor writes too"
        );
    }

    #[test]
    fn write_to_neighbor_enter_can_be_disabled() {
        let json = r#"{"terminal_id":"t1","direction":"right","data":"hello","enter":false}"#;
        let p: WriteToNeighborParam = serde_json::from_str(json).unwrap();
        assert!(!p.enter);
    }

    #[test]
    fn prepare_input_default_flags_submit_plain_text() {
        // 기본 플래그 조합(escape=false, enter=true)에서 평문 뒤에 CR이 붙는지 확인.
        let out = McpHandler::prepare_input("ls", false, true);
        assert_eq!(out, "ls\r");
    }

    #[test]
    fn prepare_input_enter_false_does_not_append_cr() {
        let out = McpHandler::prepare_input("ls", false, false);
        assert_eq!(out, "ls");
    }

    #[test]
    fn execute_command_param_deserialize() {
        let json = r#"{"terminal_id":"t1","command":"ls -la"}"#;
        let p: ExecuteCommandParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.command, "ls -la");
        assert!(p.timeout_ms.is_none());
    }

    #[test]
    fn resize_pane_param_optional_fields() {
        let json = r#"{"pane_index":0,"dw":0.1}"#;
        let p: ResizePaneParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.dw, Some(0.1));
        assert!(p.dh.is_none());
    }

    // ── Resource capability tests (issue #202) ─────────────────────

    /// Raw JSON shape returned by `build_capabilities_json` should advertise
    /// both tools and resources after issue #202.
    #[test]
    fn server_capabilities_enable_resources_and_subscribe() {
        let caps = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .enable_resources_subscribe()
            .enable_resources_list_changed()
            .build();
        let value = serde_json::to_value(&caps).unwrap();
        assert!(value.get("tools").is_some(), "tools must be advertised");
        let res = value
            .get("resources")
            .expect("resources capability must be present");
        assert_eq!(res.get("subscribe").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(res.get("listChanged").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn workspace_list_summary_compacts_full_response() {
        let data = json!({
            "workspaces": [
                {
                    "id": "ws-a",
                    "name": "alpha",
                    "panes": [{}, {}, {}],
                },
                {
                    "id": "ws-b",
                    "name": "beta",
                    "panes": [{}],
                },
            ],
            "activeWorkspaceId": "ws-a",
        });
        let summary = workspace_list_summary(&data);
        let ws = summary["workspaces"].as_array().unwrap();
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0]["paneCount"], 3);
        assert_eq!(ws[0]["isActive"], true);
        assert_eq!(ws[1]["isActive"], false);
        assert_eq!(summary["activeWorkspaceId"], "ws-a");
    }

    #[test]
    fn workspace_list_summary_handles_missing_active_id() {
        let data = json!({
            "workspaces": [{ "id": "ws-x", "name": "x", "panes": [] }],
        });
        let summary = workspace_list_summary(&data);
        assert_eq!(summary["workspaces"][0]["isActive"], false);
        assert_eq!(summary["workspaces"][0]["paneCount"], 0);
        assert_eq!(summary["activeWorkspaceId"], Value::Null);
    }

    #[test]
    fn workspace_list_summary_handles_empty_list() {
        let data = json!({ "workspaces": [], "activeWorkspaceId": null });
        let summary = workspace_list_summary(&data);
        assert_eq!(summary["workspaces"].as_array().map(|a| a.len()), Some(0));
    }
}
