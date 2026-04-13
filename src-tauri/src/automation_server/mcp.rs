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
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::constants::MCP_SERVER_NAME;
use crate::lock_ext::MutexExt;

use super::helpers::bridge_request;
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
    /// When true, append CR (\\r) after data to simulate pressing Enter.
    /// Works regardless of `escape` setting. Use this instead of manually
    /// adding `\\r` to data — it reliably submits in all environments
    /// (PowerShell, bash, Claude Code, Codex, etc.).
    #[serde(default)]
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
    /// When true, append CR after data to simulate Enter.
    #[serde(default)]
    enter: bool,
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
}

impl McpHandler {
    pub fn new(state: ServerState) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
            exec_locks: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }

    /// Get or create a per-terminal lock for execute_command serialization.
    async fn terminal_exec_lock(&self, terminal_id: &str) -> Arc<TokioMutex<()>> {
        let mut map = self.exec_locks.lock().await;
        map.entry(terminal_id.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone()
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

    /// List terminal instances with id, profile, syncGroup, workspaceId, cwd, paneIndex, and panePosition.
    /// Pass workspace_id to filter terminals by workspace (omit for all terminals).
    /// The activity field reflects real-time backend detection (shell or interactiveApp).
    #[tool]
    async fn list_terminals(
        &self,
        Parameters(p): Parameters<ListTerminalsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let bridge_result =
            bridge_request(&self.state, "query", "terminals", "list", json!({})).await;
        match bridge_result {
            Ok(mut data) => {
                // Enrich with backend activity states to resolve frontend/backend inconsistency
                let backend_states =
                    crate::activity::detect_all_terminal_states(&self.state.app_state);
                if let Some(instances) = data.get_mut("instances").and_then(|v| v.as_array_mut()) {
                    for inst in instances.iter_mut() {
                        if let Some(id) = inst.get("id").and_then(|v| v.as_str()) {
                            if let Some(state_info) = backend_states.get(id) {
                                inst.as_object_mut().map(|obj| {
                                    obj.insert(
                                        "activity".to_string(),
                                        serde_json::to_value(state_info).unwrap_or(json!(null)),
                                    )
                                });
                            }
                        }
                    }
                    // Filter by workspace_id if provided
                    if let Some(ref ws_id) = p.workspace_id {
                        instances.retain(|inst| {
                            inst.get("workspaceId")
                                .and_then(|v| v.as_str())
                                .map(|id| id == ws_id)
                                .unwrap_or(false)
                        });
                    }
                }
                Ok(json_result(&data))
            }
            Err((_status, axum::Json(body))) => {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                Ok(CallToolResult::error(vec![Content::text(msg)]))
            }
        }
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

    /// Send input to a terminal (like typing). Use `\\r` to submit (Enter).
    /// For interactive TUI apps (Claude Code, vim), `\\r` submits the prompt.
    /// Set `escape` to true for C-style sequences: `\\r` for Enter, `\\n` for
    /// newline, `\\u0003` for Ctrl+C. Leave `escape` false for literal text
    /// (preserves backslashes in Windows paths like `C:\\Users`).
    #[tool]
    async fn write_to_terminal(
        &self,
        Parameters(p): Parameters<WriteTerminalParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut data = if p.escape {
            super::helpers::unescape_terminal_input(&p.data)
        } else {
            p.data.clone()
        };
        if p.enter {
            data.push('\r');
        }
        let bytes = data.as_bytes();
        let byte_count = bytes.len();
        let ptys = match self.state.app_state.pty_handles.lock_or_err() {
            Ok(guard) => guard,
            Err(e) => {
                return Ok(CallToolResult::error(vec![Content::text(e.to_string())]));
            }
        };
        match ptys.get(&p.terminal_id) {
            Some(handle) => match handle.write(bytes) {
                Ok(_) => Ok(json_result(&json!({
                    "written": true,
                    "bytes": byte_count,
                    "enter": p.enter,
                }))),
                Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
            },
            None => Ok(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                p.terminal_id
            ))])),
        }
    }

    /// Write to a neighboring pane by direction. Combines identify_caller + write_to_terminal
    /// in a single call. Pass your own terminal_id (from $LX_TERMINAL_ID) and the direction
    /// of the neighbor you want to send to.
    #[tool]
    async fn write_to_neighbor(
        &self,
        Parameters(p): Parameters<WriteToNeighborParam>,
    ) -> Result<CallToolResult, ErrorData> {
        // 1. Identify caller to find neighbor
        let identify_result =
            bridge_request(&self.state, "query", "terminals", "identify", json!({ "id": p.terminal_id })).await;
        let neighbor_id = match identify_result {
            Ok(data) => {
                let dir_str = p.direction.to_string();
                data.get("neighbors")
                    .and_then(|n| n.get(&dir_str))
                    .and_then(|n| n.get("terminalId"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            }
            Err((_status, axum::Json(body))) => {
                let msg = body.get("error").and_then(|v| v.as_str()).unwrap_or("identify failed");
                return Ok(CallToolResult::error(vec![Content::text(msg)]));
            }
        };

        let Some(target_id) = neighbor_id else {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "No neighbor {} of terminal '{}'",
                p.direction, p.terminal_id
            ))]));
        };

        // 2. Write to the neighbor
        let mut data = if p.escape {
            super::helpers::unescape_terminal_input(&p.data)
        } else {
            p.data.clone()
        };
        if p.enter {
            data.push('\r');
        }
        let bytes = data.as_bytes();
        let byte_count = bytes.len();

        let ptys = match self.state.app_state.pty_handles.lock_or_err() {
            Ok(guard) => guard,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        };
        match ptys.get(&target_id) {
            Some(handle) => match handle.write(bytes) {
                Ok(_) => Ok(json_result(&json!({
                    "written": true,
                    "bytes": byte_count,
                    "enter": p.enter,
                    "targetTerminalId": target_id,
                    "direction": p.direction.to_string(),
                }))),
                Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
            },
            None => Ok(CallToolResult::error(vec![Content::text(format!(
                "Neighbor terminal '{}' not found",
                target_id
            ))])),
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
        // Copy raw data under lock, then release before expensive strip_ansi
        let (raw, buffer_size) = {
            let buffers = match self.state.app_state.output_buffers.lock_or_err() {
                Ok(guard) => guard,
                Err(e) => {
                    return Ok(CallToolResult::error(vec![Content::text(e.to_string())]));
                }
            };
            match buffers.get(&p.terminal_id) {
                Some(buf) => (buf.recent_lines(lines), buf.len()),
                None => {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "Terminal '{}' not found",
                        p.terminal_id
                    ))]));
                }
            }
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
            let buffers = match self.state.app_state.output_buffers.lock_or_err() {
                Ok(g) => g,
                Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
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
        {
            let ptys = match self.state.app_state.pty_handles.lock_or_err() {
                Ok(g) => g,
                Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
            };
            match ptys.get(&p.terminal_id) {
                Some(handle) => {
                    let cmd = format!("{}\r", p.command);
                    if let Err(e) = handle.write(cmd.as_bytes()) {
                        return Ok(CallToolResult::error(vec![Content::text(e)]));
                    }
                }
                None => {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "Terminal '{}' not found",
                        p.terminal_id
                    ))]));
                }
            }
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
                let buffers = match self.state.app_state.output_buffers.lock_or_err() {
                    Ok(g) => g,
                    Err(e) => {
                        return Ok(CallToolResult::error(vec![Content::text(e.to_string())]));
                    }
                };
                crate::activity::is_terminal_at_prompt_from_buffer(
                    buffers.get(&p.terminal_id),
                )
            };

            if at_prompt {
                break;
            }

            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        // 4. Read output using sequence number (immune to ring buffer wrap)
        let output = {
            let buffers = match self.state.app_state.output_buffers.lock_or_err() {
                Ok(g) => g,
                Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
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
            terminals.and_then(|t| {
                t.get(&p.terminal_id)
                    .and_then(|s| s.last_exit_code)
            })
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
        let bridge_result =
            bridge_request(&self.state, "query", "workspaces", "list", json!({})).await;
        match bridge_result {
            Ok(data) => {
                if p.summary.unwrap_or(false) {
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
                        return Ok(json_result(&json!({
                            "workspaces": summary,
                            "activeWorkspaceId": data.get("activeWorkspaceId"),
                        })));
                    }
                }
                Ok(json_result(&data))
            }
            Err((_status, axum::Json(body))) => {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                Ok(CallToolResult::error(vec![Content::text(msg)]))
            }
        }
    }

    /// Get the currently active workspace with full pane details, terminal activity states,
    /// and focusedPaneIndex — a single call for complete workspace context.
    #[tool]
    async fn get_active_workspace(&self) -> Result<CallToolResult, ErrorData> {
        let bridge_result =
            bridge_request(&self.state, "query", "workspaces", "getActive", json!({})).await;
        match bridge_result {
            Ok(mut data) => {
                // Enrich panes with backend activity states
                let backend_states =
                    crate::activity::detect_all_terminal_states(&self.state.app_state);
                if let Some(ws) = data.get_mut("workspace") {
                    if let Some(panes) = ws.get_mut("panes").and_then(|v| v.as_array_mut()) {
                        for pane in panes.iter_mut() {
                            if let Some(tid) = pane.get("terminalId").and_then(|v| v.as_str()) {
                                if let Some(state_info) = backend_states.get(tid) {
                                    pane.as_object_mut().map(|obj| {
                                        obj.insert(
                                            "terminalActivity".to_string(),
                                            serde_json::to_value(state_info)
                                                .unwrap_or(json!(null)),
                                        )
                                    });
                                }
                            }
                        }
                    }
                    // focusedPaneIndex is now included directly in the bridge response
                    // from workspaces.getActive — no second bridge call needed.
                }
                Ok(json_result(&data))
            }
            Err((_status, axum::Json(body))) => {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                Ok(CallToolResult::error(vec![Content::text(msg)]))
            }
        }
    }

    /// Switch to a different workspace by ID or name.
    #[tool]
    async fn switch_workspace(
        &self,
        Parameters(p): Parameters<SwitchWorkspaceParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let ws_id = if let Some(id) = p.workspace_id {
            id
        } else if let Some(name) = p.name {
            // Resolve name to ID via list
            let list = bridge_request(&self.state, "query", "workspaces", "list", json!({})).await;
            match list {
                Ok(data) => {
                    let name_lower = name.to_lowercase();
                    let all_matches: Vec<&Value> = data.get("workspaces")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter(|ws| {
                            ws.get("name")
                                .and_then(|n| n.as_str())
                                .map(|n| n.to_lowercase() == name_lower)
                                .unwrap_or(false)
                        }).collect())
                        .unwrap_or_default();
                    match all_matches.len() {
                        0 => return Ok(CallToolResult::error(vec![Content::text(
                            format!("Workspace '{}' not found", name)
                        )])),
                        1 => all_matches[0].get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        n => {
                            // Multiple matches — prefer exact case match, else take first
                            let exact = all_matches.iter().find(|ws| {
                                ws.get("name").and_then(|v| v.as_str()) == Some(&name)
                            });
                            let chosen = exact.unwrap_or(&all_matches[0]);
                            let id = chosen.get("id")
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
                }
                Err((_status, axum::Json(body))) => {
                    let msg = body.get("error").and_then(|v| v.as_str()).unwrap_or("Failed to list workspaces");
                    return Ok(CallToolResult::error(vec![Content::text(msg)]));
                }
            }
        } else {
            return Ok(CallToolResult::error(vec![Content::text(
                "Either workspace_id or name is required"
            )]));
        };

        self.bridge("action", "workspaces", "switchActive", json!({ "id": ws_id })).await
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
        let data =
            match bridge_request(&self.state, "action", "screenshot", "capture", params).await {
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

    /// List notifications. Supports filtering by workspace, terminal, read status, and limit.
    #[tool]
    async fn list_notifications(
        &self,
        Parameters(p): Parameters<ListNotificationsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let bridge_result =
            bridge_request(&self.state, "query", "notifications", "list", json!({})).await;
        match bridge_result {
            Ok(mut data) => {
                if let Some(notifications) =
                    data.get_mut("notifications").and_then(|v| v.as_array_mut())
                {
                    if let Some(ref ws_id) = p.workspace_id {
                        notifications.retain(|n| {
                            n.get("workspaceId").and_then(|v| v.as_str()) == Some(ws_id)
                        });
                    }
                    if let Some(ref t_id) = p.terminal_id {
                        notifications.retain(|n| {
                            n.get("terminalId").and_then(|v| v.as_str()) == Some(t_id)
                        });
                    }
                    if p.unread_only.unwrap_or(false) {
                        notifications.retain(|n| n.get("readAt").and_then(|v| v.as_u64()).is_none());
                    }
                    // Sort newest-first so limit returns the most recent N
                    notifications.sort_by(|a, b| {
                        let ts_a = a.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        let ts_b = b.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        ts_b.partial_cmp(&ts_a).unwrap_or(std::cmp::Ordering::Equal)
                    });
                    if let Some(limit) = p.limit {
                        notifications.truncate(limit as usize);
                    }
                }
                Ok(json_result(&data))
            }
            Err((_status, axum::Json(body))) => {
                let msg = body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Bridge request failed");
                Ok(CallToolResult::error(vec![Content::text(msg)]))
            }
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
        let workspace_id = match p.workspace_id {
            Some(id) => id,
            None if !terminal_id.is_empty() => {
                // Look up terminal's workspace from terminal list
                match bridge_request(
                    &self.state,
                    "query",
                    "terminals",
                    "list",
                    json!({}),
                )
                .await
                {
                    Ok(data) => {
                        let ws_id = data
                            .get("instances")
                            .and_then(|v| v.as_array())
                            .and_then(|arr| {
                                arr.iter().find(|t| {
                                    t.get("id").and_then(|v| v.as_str()) == Some(&terminal_id)
                                })
                            })
                            .and_then(|t| t.get("workspaceId").and_then(|v| v.as_str()))
                            .map(|s| s.to_string());
                        match ws_id {
                            Some(id) => id,
                            None => {
                                return Ok(CallToolResult::error(vec![Content::text(format!(
                                    "Terminal '{}' not found or has no workspace",
                                    terminal_id
                                ))]));
                            }
                        }
                    }
                    Err(_) => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "Failed to look up terminal workspace",
                        )]));
                    }
                }
            }
            None => {
                // No terminal, no workspace — use active workspace
                match bridge_request(&self.state, "query", "grid", "getState", json!({})).await {
                    Ok(data) => match data.get("activeWorkspaceId").and_then(|v| v.as_str()) {
                        Some(id) => id.to_string(),
                        None => {
                            return Ok(CallToolResult::error(vec![Content::text(
                                "Failed to resolve active workspace",
                            )]));
                        }
                    },
                    Err(_) => {
                        return Ok(CallToolResult::error(vec![Content::text(
                            "Failed to resolve active workspace",
                        )]));
                    }
                }
            }
        };

        let mut params = json!({
            "terminalId": terminal_id,
            "workspaceId": workspace_id,
            "message": p.message,
        });
        if let Some(level) = p.level {
            params["level"] = json!(level.to_string());
        }
        self.bridge("action", "notifications", "add", params).await
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
        let raw = {
            let buffers = match self.state.app_state.output_buffers.lock_or_err() {
                Ok(g) => g,
                Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
            };
            match buffers.get(&p.terminal_id) {
                Some(b) => b.recent_lines(max_lines),
                None => {
                    return Ok(CallToolResult::error(vec![Content::text(format!(
                        "Terminal '{}' not found",
                        p.terminal_id
                    ))]));
                }
            }
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
        // Get configured profiles from frontend settings
        let bridge_profiles = bridge_request(
            &self.state,
            "query",
            "profiles",
            "list",
            json!({}),
        )
        .await;

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

        match bridge_profiles {
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
                 Read it with `echo $LX_TERMINAL_ID` (bash/zsh) or `echo $env:LX_TERMINAL_ID` (PowerShell), \
                 then call `identify_caller` with that value to learn:\n\
                 - Which workspace you are in (id, name, whether it is active)\n\
                 - Your pane position in the grid (x, y, w, h as 0-1 normalized coordinates, pane index)\n\
                 - Neighboring panes (left, right, above, below) and their terminal IDs\n\
                 - Your terminal metadata (cwd, branch, activity state)\n\n\
                 ## Other env vars\n\
                 - LX_AUTOMATION_PORT: The port this MCP server runs on\n\
                 - LX_GROUP_ID: Your sync group (terminals in the same group share CWD)\n\n\
                 ## Common workflows\n\
                 - Find yourself: echo $LX_TERMINAL_ID (or $env:LX_TERMINAL_ID in PowerShell) → identify_caller\n\
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
}
