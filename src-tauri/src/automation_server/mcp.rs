//! Embedded MCP (Model Context Protocol) server using the official `rmcp` SDK.
//!
//! Uses `#[tool]` derive macros for automatic tool definition and JSON-RPC 2.0
//! handling. Mounted via `nest_service("/mcp", ...)` in the existing axum router.

use rmcp::handler::server::{router::tool::ToolRouter, tool::ToolCallContext, wrapper::Parameters};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, ListResourceTemplatesResult,
    ListResourcesResult, ListToolsResult, PaginatedRequestParams, ReadResourceRequestParams,
    ReadResourceResult, ServerCapabilities, ServerInfo, SubscribeRequestParams, Tool,
    UnsubscribeRequestParams,
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
use crate::error::AppError;
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

/// Target a terminal by stable ID or by spatial pane number (issue #256).
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct TerminalTargetParam {
    /// Stable terminal ID. Provide either this or `pane_number` (terminal_id wins).
    terminal_id: Option<String>,
    /// Pane locator copied from a pane badge, e.g. `lx:pane:Default:1`.
    pane_ref: Option<String>,
    /// Spatial pane number (1-based reading order, same as the control bar badge).
    /// Resolved within `workspace_id` at call time. Prefer `terminal_id` for durable refs.
    pane_number: Option<u64>,
    /// Workspace to resolve `pane_number` in. Defaults to the active workspace.
    workspace_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct WriteTerminalParam {
    /// Stable terminal ID (e.g. "terminal-pane-abc12345"). Preferred — survives
    /// layout changes. Provide either this or `pane_number`; `terminal_id` wins
    /// if both are given.
    terminal_id: Option<String>,
    /// Pane locator copied from a pane badge, e.g. `lx:pane:Default:1`.
    pane_ref: Option<String>,
    /// Spatial pane number (1-based, screen reading order — same as the control
    /// bar badge). Convenient for "write to pane 3", but the number changes when
    /// the layout changes, so it is resolved at call time. Use `terminal_id` for
    /// durable references. Resolved within `workspace_id` (default: active workspace).
    pane_number: Option<u64>,
    /// Workspace to resolve `pane_number` in. Defaults to the active workspace.
    workspace_id: Option<String>,
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
    /// Reply address for agent-to-agent messaging. Pass your own terminal ID
    /// (from $LX_TERMINAL_ID) and a standardized reply-to footer is appended
    /// to `data`, instructing the receiving LLM agent to send its result back
    /// to you via `write_to_terminal`. Only use when the target pane runs an
    /// LLM agent — the footer would garble input to shells or editors.
    reply_to: Option<String>,
    /// When set, wait this many milliseconds after writing, then include the
    /// target's new output (produced since the write) as `response` in the
    /// return — ANSI-stripped and tail-truncated. Useful to immediately catch a
    /// pane you assumed was an agent but was a bare shell: the shell echoes your
    /// text and errors (e.g. `command not found`), and that shows up in
    /// `response`. Clamped to 10000ms. Omit (default) for a non-blocking write.
    capture_ms: Option<u64>,
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
    /// Reply address for agent-to-agent messaging — typically your own
    /// `terminal_id`. When set, a standardized reply-to footer is appended to
    /// `data` so the receiving LLM agent knows where to send its result.
    /// See `write_to_terminal` for details.
    reply_to: Option<String>,
    /// Wait this many ms after writing, then include the neighbor's new output
    /// as `response` (ANSI-stripped, tail-truncated). See `write_to_terminal`.
    /// Clamped to 10000ms. Omit for a non-blocking write.
    capture_ms: Option<u64>,
}

fn default_true() -> bool {
    true
}

/// Result of [`McpHandler::write_input`]: bytes sent plus the pre-write state
/// sampled atomically under the per-terminal exec lock (`activity` always;
/// `before_seq` only when capture was requested).
struct WriteOutcome {
    bytes: usize,
    activity: serde_json::Value,
    before_seq: Option<u64>,
}

/// Get or create the per-terminal serialization lock from a shared table.
/// Same `terminal_id` → the same `Arc` (so all callers serialize); distinct
/// ids → distinct locks. The outer table mutex is `std` and held only for this
/// get/insert (never across `.await`). Free fn so it can be unit-tested without
/// an `McpHandler` (which needs a Tauri `AppHandle`).
fn get_or_create_terminal_lock(
    locks: &crate::state::SharedExecLocks,
    terminal_id: &str,
) -> Arc<TokioMutex<()>> {
    let mut map = locks.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(terminal_id.to_string())
        .or_insert_with(|| Arc::new(TokioMutex::new(())))
        .clone()
}

#[derive(Debug, PartialEq, Eq)]
struct PaneLocator {
    workspace_name: String,
    pane_number: u64,
}

fn parse_pane_locator(value: &str) -> Result<Option<PaneLocator>, String> {
    let Some(rest) = value.strip_prefix("lx:pane:") else {
        return Ok(None);
    };
    // The pane number is the final `:`-delimited segment, so split from the right.
    // Workspace names only have whitespace normalized out (not colons), so a name like
    // `API:v2` is valid storage; splitting on the last `:` keeps such names round-trippable.
    let Some((workspace_name, pane_number)) = rest.rsplit_once(':') else {
        return Err("Pane locator format is lx:pane:<workspaceName>:<paneNumber>".to_string());
    };
    if workspace_name.is_empty() {
        return Err("Pane locator must include a workspace name".to_string());
    }
    if pane_number.is_empty() {
        return Err("Pane locator must include a pane number".to_string());
    }
    if workspace_name.chars().any(char::is_whitespace) {
        return Err("Pane locator workspace name must not contain whitespace".to_string());
    }
    let pane_number = pane_number
        .parse::<u64>()
        .map_err(|_| "Pane locator pane number must be an integer".to_string())?;
    if pane_number == 0 {
        return Err("Pane locator pane number must be greater than 0".to_string());
    }
    Ok(Some(PaneLocator {
        workspace_name: workspace_name.to_string(),
        pane_number,
    }))
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
    /// Stable terminal ID. Provide either this or `pane_number` (terminal_id wins).
    terminal_id: Option<String>,
    /// Pane locator copied from a pane badge, e.g. `lx:pane:Default:1`.
    pane_ref: Option<String>,
    /// Spatial pane number (1-based reading order, same as the control bar badge).
    /// Resolved within `workspace_id` at call time. Prefer `terminal_id` for durable refs.
    pane_number: Option<u64>,
    /// Workspace to resolve `pane_number` in. Defaults to the active workspace.
    workspace_id: Option<String>,
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
    /// When true (default), append CR after data to submit (simulate Enter) —
    /// same submit semantics as `write_to_terminal`, including the #314
    /// paste-burst-safe delay between body and CR. Set false to type without
    /// submitting.
    #[serde(default = "default_true")]
    enter: bool,
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
struct SetEditModeParam {
    /// Enable or disable grid edit mode.
    enabled: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SimulateHoverParam {
    /// Pane index to mark as hovered. Omit or pass null to clear automation hover.
    pane_index: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetPaneViewParam {
    /// Pane index (0-based)
    pane_index: u64,
    /// View config object, e.g. {"type":"TerminalView","profile":"PowerShell"}.
    view: Value,
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
struct OpenFileViewerParam {
    /// Absolute path of the file to open in the viewer. Text, images, and
    /// binaries are recognized automatically; files whose extension matches a
    /// configured external viewer open in a terminal running that command.
    path: String,
    /// When true, the viewer fills the whole app window (the "new window" feel).
    /// When false (default) it opens as a large centered floating overlay.
    #[serde(default)]
    new_window: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ShowImageParam {
    /// Base64-encoded image bytes. A `data:` URI prefix
    /// (e.g. `data:image/png;base64,...`) is accepted and stripped automatically.
    /// Use this to show an image the MCP client holds in memory that does not
    /// exist as a file on the laymux host filesystem.
    data: String,
    /// MIME type of the image (e.g. "image/png", "image/jpeg", "image/gif",
    /// "image/webp", "image/bmp", "image/svg+xml"). Optional — defaults to
    /// "image/png". Determines the temp file extension so the viewer renders it.
    /// Ignored when `data` is a `data:` URI carrying its own MIME type.
    #[serde(default)]
    mime_type: Option<String>,
    /// When true, the viewer fills the whole app window (the "new window" feel).
    /// When false (default) it opens as a large centered floating overlay.
    #[serde(default)]
    new_window: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct MemoKeyParam {
    /// Memo key — typically a workspace pane ID (e.g. "pane-abc12345").
    /// Use `list_memos` to discover available keys.
    key: String,
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

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetAppThemeParam {
    /// App theme ID, e.g. "catppuccin-mocha" or "dracula".
    theme_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdateProfileParam {
    /// Profile index in settings.profiles.
    index: u64,
    /// Partial profile object to merge into the selected profile.
    data: Value,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetProfileDefaultsParam {
    /// Partial profileDefaults object to merge into settings.profileDefaults.
    data: Value,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct NavigateSettingsParam {
    /// Settings section key. Defaults to "startup" when omitted.
    section: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ToggleWorkspaceHiddenParam {
    /// Workspace ID to toggle in hide mode.
    workspace_id: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct TogglePaneHiddenParam {
    /// Pane ID to toggle in hide mode.
    pane_id: String,
}

const DEV_ONLY_TOOLS: &[&str] = &[
    "set_app_theme",
    "update_profile",
    "set_profile_defaults",
    "open_settings",
    "close_settings",
    "toggle_settings",
    "navigate_settings",
    "toggle_remote_access",
    "open_remote_access",
    "close_remote_access",
    "toggle_notification_panel",
    "toggle_hide_mode",
    "toggle_pane_hidden",
    "toggle_workspace_hidden",
    "simulate_hover",
    "set_edit_mode",
    "set_pane_view",
];

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
    is_dev: bool,
    /// Shared subscription registry: tracks `resources/subscribe` requests so
    /// the Tauri→MCP event bridge can push `notifications/resources/updated`
    /// to the correct peers.
    subscriptions: SharedSubscriptionRegistry,
    /// Process-unique id of the MCP peer this handler instance serves. Used
    /// as the key inside [`subscriptions`].
    peer_id: PeerId,
}

impl McpHandler {
    pub fn new(
        state: ServerState,
        subscriptions: SharedSubscriptionRegistry,
        is_dev: bool,
    ) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
            is_dev,
            subscriptions,
            peer_id: new_peer_id(),
        }
    }

    /// Get or create a per-terminal lock serializing execute_command and
    /// write_input (so a split body+CR sequence is not interleaved by another
    /// concurrent write/exec to the same terminal — #314). The table lives on
    /// the shared `Arc<AppState>` (see [`crate::state::SharedExecLocks`]) so this
    /// holds across MCP sessions, not just within one handler (#427).
    async fn terminal_exec_lock(&self, terminal_id: &str) -> Arc<TokioMutex<()>> {
        get_or_create_terminal_lock(&self.state.app_state.exec_locks, terminal_id)
    }

    /// 제출(`enter=true`) 시 텍스트와 종료 CR 사이의 지연(ms).
    ///
    /// Issue #314: Codex TUI는 paste-burst 감지를 한다 — 짧은 시간 창 안에 여러
    /// 바이트(텍스트+CR)가 한꺼번에 도착하면 붙여넣기로 간주해 CR을 컴포저 내
    /// 줄바꿈으로 처리하고 제출하지 않는다. CR을 그 시간 창보다 큰 간격을 두고
    /// 별도 write로 보내면 독립된 Enter 키 입력으로 인식된다.
    ///
    /// 검증(실측): WSL PTY는 ~40ms 분리로도 제출됐으나, Windows ConPTY는 입력
    /// 전달을 더 크게 묶어 ~200ms 미만에서는 두 write가 codex의 burst 창 안에
    /// 합쳐졌다(제출 실패). 양 환경 모두 안전하도록 여유 마진을 둔다. 셸/
    /// PowerShell/Claude Code 에는 무해하다(추가 지연만 발생).
    const ENTER_CR_DELAY_MS: u64 = 300;

    /// Upper bound for `capture_ms` — the caller blocks for at most this long
    /// waiting to snapshot the target's post-write output.
    const CAPTURE_MS_MAX: u64 = 10_000;

    /// Max characters returned in a `capture_ms` `response`; the tail is kept so
    /// shell errors near the prompt survive truncation.
    const CAPTURE_RESPONSE_MAX_CHARS: usize = 2000;

    /// 입력 본문(타이핑될 텍스트)을 준비한다 — 제출용 CR은 포함하지 않는다.
    /// CR은 `write_input`이 별도 write로 보낸다([`Self::ENTER_CR_DELAY_MS`] 참조).
    ///
    /// Issue #314: 제출(`enter=true`) 시에는 후행 개행을 제거해 정규화한다.
    /// 클라이언트가 보낸 `data`가 이미 `\n`/`\r\n`/`\r`로 끝나는 경우(예:
    /// `escape=true` + `"ls\\n"`, 또는 멀티라인 텍스트의 마지막 줄), 후행 개행이
    /// 남으면 별도 CR과 합쳐져 `...\n\r` 가 되어 Windows ConPTY/PSReadLine에서
    /// 줄바꿈만 삽입하고 제출되지 않는다. 따라서 후행 개행을 제거한다. 내부(중간)
    /// 개행은 멀티라인 입력 의도를 위해 보존한다. `enter=false`면 사용자가 보낸
    /// 개행을 손대지 않는다.
    ///
    /// `reply_to`가 주어지면(에이전트 간 메시징) 표준 회신 푸터를 본문 끝에
    /// 부착한다 — 후행 개행 정리보다 먼저 적용되므로 푸터는 본문과 함께
    /// 한 메시지로 제출된다.
    fn prepare_input_body(data: &str, escape: bool, enter: bool, reply_to: Option<&str>) -> String {
        let mut result = if escape {
            super::helpers::unescape_terminal_input(data)
        } else {
            data.to_string()
        };
        if let Some(reply_to) = reply_to.filter(|s| !s.is_empty()) {
            result.push_str(&format!(
                "\n\n[reply-to: when done, send your result back by calling the \
                 mcp__laymux__write_to_terminal tool with terminal_id=\"{reply_to}\"]"
            ));
        }
        if enter {
            while result.ends_with('\n') || result.ends_with('\r') {
                result.pop();
            }
        }
        result
    }

    /// 입력을 보낼 때 PTY로 순서대로 write 할 바이트 청크 목록을 계획한다.
    /// 본문(비어 있지 않으면)과 제출용 CR(`enter=true`)을 **분리된 청크**로 나눠
    /// 반환한다 — `write_input`이 청크 사이에 지연을 넣어 Codex paste 오인을
    /// 막는다(#314). 순수 함수라 호출 패턴(본문+CR / CR만 / 본문만 / 둘 다 없음)을
    /// 단위 테스트로 고정한다.
    fn plan_input_writes(
        data: &str,
        escape: bool,
        enter: bool,
        reply_to: Option<&str>,
    ) -> Vec<Vec<u8>> {
        let body = Self::prepare_input_body(data, escape, enter, reply_to);
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        if !body.is_empty() {
            chunks.push(body.into_bytes());
        }
        if enter {
            chunks.push(b"\r".to_vec());
        }
        chunks
    }

    fn require_object_param(value: Value, field: &str) -> Result<Value, CallToolResult> {
        if value.is_object() {
            Ok(value)
        } else {
            Err(CallToolResult::error(vec![Content::text(format!(
                "'{field}' must be a JSON object"
            ))]))
        }
    }

    fn is_dev_only_tool(name: &str) -> bool {
        DEV_ONLY_TOOLS.contains(&name)
    }

    fn is_tool_visible(&self, name: &str) -> bool {
        self.is_dev || !Self::is_dev_only_tool(name)
    }

    fn visible_tools_from_router(router: &ToolRouter<Self>, is_dev: bool) -> Vec<Tool> {
        let mut tools = router.list_all();
        if !is_dev {
            tools.retain(|tool| !Self::is_dev_only_tool(tool.name.as_ref()));
        }
        tools
    }

    fn visible_tools(&self) -> Vec<Tool> {
        Self::visible_tools_from_router(&self.tool_router, self.is_dev)
    }

    fn tool_not_found() -> ErrorData {
        ErrorData::invalid_params("tool not found", None)
    }

    /// 터미널에 입력을 보낸다. 본문 텍스트와 제출용 CR을 **분리된 write**로 보내며,
    /// 청크 사이에 [`Self::ENTER_CR_DELAY_MS`] 지연을 둔다(#314 — Codex paste 오인
    /// 방지). 같은 터미널에 대한 write/execute 는 per-terminal 락으로 직렬화하여,
    /// 분리된 body+CR 시퀀스 사이에 다른 호출이 끼어들어 `bodyA bodyB \r \r` 처럼
    /// 인터리브되는 것을 막는다.
    ///
    /// 쓰기 직전 pane activity 와 (capture 시) 출력 버퍼 seq 를 **락 안에서** 샘플링해
    /// [`WriteOutcome`]에 담아 돌려준다. 락 밖에서 샘플링하면 다른 write 가 락을
    /// 먼저 잡아 그 사이에 끼어들 수 있어, activity/seq 가 실제 "이 write 직전"이
    /// 아니게 된다. 락 안 샘플링으로 그 경합을 막는다. 락 테이블이 프로세스 전역
    /// (`AppState::exec_locks`)이라 직렬화는 MCP 세션과 무관하게 성립한다(#427).
    async fn write_input(
        &self,
        terminal_id: &str,
        data: &str,
        escape: bool,
        enter: bool,
        reply_to: Option<&str>,
        capture: bool,
    ) -> Result<WriteOutcome, CallToolResult> {
        let chunks = Self::plan_input_writes(data, escape, enter, reply_to);
        // 존재하지 않는 터미널이면 락 엔트리를 만들기 전에 거른다 — 전역 exec_locks
        // 테이블이 무효/닫힌 id 호출만으로 커지지 않도록(#427). write_pty 도 동일한
        // not-found 를 내지만, 그 전에 이미 락이 삽입된 뒤다.
        if !self.terminal_exists(terminal_id) {
            return Err(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                terminal_id
            ))]));
        }
        // body+CR 시퀀스를 원자적으로 보내기 위해 execute_command 와 동일한
        // per-terminal 락으로 직렬화한다.
        let lock = self.terminal_exec_lock(terminal_id).await;
        let _guard = lock.lock().await;
        // 락을 잡은 뒤, 쓰기 직전 상태를 원자적으로 샘플링한다.
        let (activity, before_seq) = self.sample_activity_and_seq(terminal_id, capture);
        let mut total = 0usize;
        for (i, chunk) in chunks.iter().enumerate() {
            // 청크(=본문 다음의 CR) 앞에만 지연을 둔다. lone CR/본문만일 때는
            // 청크가 하나뿐이라 지연이 발생하지 않는다.
            if i > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(Self::ENTER_CR_DELAY_MS)).await;
            }
            match self.write_pty(terminal_id, chunk) {
                Ok(n) => total += n,
                Err(e) => {
                    // 쓰기 도중 터미널이 사라졌다면(close 와 경합) 방금 재생성됐을
                    // 수 있는 락 엔트리를 정리한다(#427).
                    if !self.terminal_exists(terminal_id) {
                        self.remove_terminal_lock(terminal_id);
                    }
                    return Err(e);
                }
            }
        }
        Ok(WriteOutcome {
            bytes: total,
            activity,
            before_seq,
        })
    }

    /// True if the terminal has a live PTY handle. Used to reject writes to
    /// unknown/closed ids before an `exec_locks` entry is created (#427). A
    /// poisoned lock is treated as "not present" (writes are fatal anyway).
    fn terminal_exists(&self, terminal_id: &str) -> bool {
        self.state
            .app_state
            .pty_handles
            .lock_or_err()
            .map(|ptys| ptys.contains_key(terminal_id))
            .unwrap_or(false)
    }

    /// Drop a terminal's entry from the shared `exec_locks` table. Called when a
    /// write discovers the terminal vanished mid-flight — the pre-write
    /// `terminal_exists` check can race a concurrent `close_terminal_session`
    /// (close removes the entry, then this call recreated it), so self-heal here
    /// rather than leak the recreated entry (#427). Safe while holding the
    /// per-terminal guard: the guard keeps its own `Arc`; the map only drops a ref.
    fn remove_terminal_lock(&self, terminal_id: &str) {
        let mut map = self
            .state
            .app_state
            .exec_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(terminal_id);
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

    /// Resolve a terminal target (stable ID or spatial pane number) to a terminal ID.
    /// `terminal_id` wins when both are given; otherwise `pane_number` is resolved via
    /// the frontend bridge within `workspace_id` (default: active workspace). Issue #256.
    async fn resolve_terminal_id(
        &self,
        terminal_id: Option<&str>,
        pane_ref: Option<&str>,
        pane_number: Option<u64>,
        workspace_id: Option<&str>,
    ) -> Result<String, CallToolResult> {
        if let Some(id) = terminal_id {
            if !id.is_empty() {
                match parse_pane_locator(id) {
                    Ok(Some(locator)) => {
                        let workspace_id = self
                            .resolve_workspace_id_by_name(&locator.workspace_name)
                            .await?;
                        return self
                            .resolve_pane_number_to_terminal_id(
                                locator.pane_number,
                                Some(&workspace_id),
                            )
                            .await;
                    }
                    Ok(None) => {}
                    Err(msg) => {
                        return Err(CallToolResult::error(vec![Content::text(msg)]));
                    }
                }
                return Ok(id.to_string());
            }
        }
        if let Some(locator_text) = pane_ref {
            match parse_pane_locator(locator_text) {
                Ok(Some(locator)) => {
                    let workspace_id = self
                        .resolve_workspace_id_by_name(&locator.workspace_name)
                        .await?;
                    return self
                        .resolve_pane_number_to_terminal_id(
                            locator.pane_number,
                            Some(&workspace_id),
                        )
                        .await;
                }
                Ok(None) => {
                    return Err(CallToolResult::error(vec![Content::text(
                        "pane_ref must use lx:pane:<workspaceName>:<paneNumber>".to_string(),
                    )]));
                }
                Err(msg) => {
                    return Err(CallToolResult::error(vec![Content::text(msg)]));
                }
            }
        }
        let Some(number) = pane_number else {
            return Err(CallToolResult::error(vec![Content::text(
                "Provide terminal_id, pane_ref, or pane_number".to_string(),
            )]));
        };
        self.resolve_pane_number_to_terminal_id(number, workspace_id)
            .await
    }

    async fn resolve_pane_number_to_terminal_id(
        &self,
        number: u64,
        workspace_id: Option<&str>,
    ) -> Result<String, CallToolResult> {
        let mut params = json!({ "number": number });
        if let Some(ws) = workspace_id {
            params["workspaceId"] = json!(ws);
        }
        let data = self
            .bridge_raw("query", "terminals", "resolveByNumber", params)
            .await?;
        data.get("terminalId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                CallToolResult::error(vec![Content::text(
                    "resolveByNumber returned no terminalId".to_string(),
                )])
            })
    }

    async fn resolve_workspace_id_by_name(
        &self,
        workspace_name: &str,
    ) -> Result<String, CallToolResult> {
        let data = self
            .bridge_raw("query", "workspaces", "list", json!({}))
            .await?;
        let matches: Vec<&Value> = data
            .get("workspaces")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|ws| ws.get("name").and_then(|v| v.as_str()) == Some(workspace_name))
                    .collect()
            })
            .unwrap_or_default();
        match matches.len() {
            0 => Err(CallToolResult::error(vec![Content::text(format!(
                "Workspace '{}' not found",
                workspace_name
            ))])),
            1 => matches[0]
                .get("id")
                .and_then(|v| v.as_str())
                .map(|id| id.to_string())
                .ok_or_else(|| {
                    CallToolResult::error(vec![Content::text(format!(
                        "Workspace '{}' has no id",
                        workspace_name
                    ))])
                }),
            _ => Err(CallToolResult::error(vec![Content::text(format!(
                "Workspace name '{}' is not unique",
                workspace_name
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

    /// Sample a terminal's pre-write state in a single `output_buffers` lock:
    /// its activity (shell / running / interactiveApp) as JSON, and — when
    /// `want_seq` — the current output-buffer write sequence to bracket a
    /// `capture_ms` window. Call this while holding the per-terminal exec lock so
    /// the sample is atomic w.r.t. this terminal's write ordering. Best-effort: a
    /// poisoned lock yields `(null, None)`.
    fn sample_activity_and_seq(
        &self,
        terminal_id: &str,
        want_seq: bool,
    ) -> (serde_json::Value, Option<u64>) {
        let app_state = &self.state.app_state;
        let Ok(buffers) = app_state.output_buffers.lock_or_err() else {
            return (json!(null), None);
        };
        let buf = buffers.get(terminal_id);
        let info = crate::activity::detect_terminal_state(app_state, terminal_id, buf);
        let activity = serde_json::to_value(&info.activity).unwrap_or(json!(null));
        let seq = if want_seq {
            buf.map(|b| b.write_seq())
        } else {
            None
        };
        (activity, seq)
    }

    /// Copy the raw bytes produced since `before_seq` under the buffer lock, then
    /// release it before the (potentially large) ANSI strip + tail truncation so
    /// a noisy TUI's snapshot doesn't stall PTY callbacks pushing into the buffer.
    /// Returns `(response, truncated)`; empty string when nothing new / unknown.
    fn capture_response_since(&self, terminal_id: &str, before_seq: u64) -> (String, bool) {
        let raw = {
            let Ok(buffers) = self.state.app_state.output_buffers.lock_or_err() else {
                return (String::new(), false);
            };
            match buffers.get(terminal_id) {
                Some(buf) => buf.bytes_since(before_seq),
                None => return (String::new(), false),
            }
        }; // buffer lock released here
        let text = super::helpers::strip_ansi(&String::from_utf8_lossy(&raw));
        Self::truncate_tail(text.trim(), Self::CAPTURE_RESPONSE_MAX_CHARS)
    }

    /// Keep at most `max` trailing chars of `s`. Returns `(text, truncated)`.
    /// The tail is kept so shell errors near the prompt survive truncation.
    fn truncate_tail(s: &str, max: usize) -> (String, bool) {
        let total = s.chars().count();
        if total > max {
            (s.chars().skip(total - max).collect(), true)
        } else {
            (s.to_string(), false)
        }
    }

    /// If `capture_ms` was requested, block up to `CAPTURE_MS_MAX`, then inject
    /// `captureMs` plus `response` / `responseTruncated` into a write tool's
    /// result. `response` is always present when `capture_ms` is set (empty
    /// string if the pre-write sequence was unavailable) so the return contract
    /// is stable. No-op when `capture_ms` is unset.
    async fn apply_capture(
        &self,
        result: &mut serde_json::Value,
        terminal_id: &str,
        capture_ms: Option<u64>,
        before_seq: Option<u64>,
    ) {
        let Some(ms) = capture_ms else { return };
        let ms = ms.min(Self::CAPTURE_MS_MAX);
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        let Some(obj) = result.as_object_mut() else {
            return;
        };
        obj.insert("captureMs".to_string(), json!(ms));
        let (response, truncated) = match before_seq {
            Some(seq) => self.capture_response_since(terminal_id, seq),
            None => (String::new(), false),
        };
        obj.insert("response".to_string(), json!(response));
        obj.insert("responseTruncated".to_string(), json!(truncated));
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
    /// The inserted value is the flat `TerminalActivity` shape, not `TerminalStateInfo`.
    fn enrich_with_activity(
        app_state: &crate::state::AppState,
        items: &mut [Value],
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
                            serde_json::to_value(&state_info.activity).unwrap_or(json!(null)),
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
    is_dev: bool,
) -> StreamableHttpService<McpHandler, LocalSessionManager> {
    StreamableHttpService::new(
        move || {
            Ok(McpHandler::new(
                state.clone(),
                subscriptions.clone(),
                is_dev,
            ))
        },
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

    /// Send input to a terminal. Target it with `terminal_id` (stable, preferred)
    /// or `pane_number` (1-based screen reading order, same as the control bar
    /// badge — convenient but changes with layout). By default the input is
    /// submitted (Enter key) after sending — suitable for running commands or
    /// replying to TUI prompts (Claude Code, Codex, REPLs). Pass `enter: false`
    /// to type without submitting (e.g. inserting text mid-line in vim, composing
    /// a multi-line prompt before a manual submit).
    /// Set `escape` to true for C-style sequences: `\\r` for Enter, `\\n` for
    /// newline, `\\u0003` for Ctrl+C. Leave `escape` false for literal text
    /// (preserves backslashes in Windows paths like `C:\\Users`).
    /// When messaging another LLM agent pane, pass `reply_to` with your own
    /// terminal ID ($LX_TERMINAL_ID) — a standardized footer is appended
    /// telling the agent where to send its result back.
    /// The return includes `activity` — the target pane's state sampled just
    /// BEFORE the write: `{"type":"shell"}` (bare prompt), `{"type":"running"}`
    /// (non-interactive command), or `{"type":"interactiveApp","name":"Codex"}`
    /// (a TUI). Check it right after sending to catch the case where a pane you
    /// assumed was an agent (Codex/Claude) had actually dropped to a shell.
    /// Pass `capture_ms` to additionally block that long and return the target's
    /// new output as `response` — e.g. the shell's `command not found` when your
    /// prompt landed on a bare shell instead of an agent.
    #[tool]
    async fn write_to_terminal(
        &self,
        Parameters(p): Parameters<WriteTerminalParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let terminal_id = match self
            .resolve_terminal_id(
                p.terminal_id.as_deref(),
                p.pane_ref.as_deref(),
                p.pane_number,
                p.workspace_id.as_deref(),
            )
            .await
        {
            Ok(id) => id,
            Err(e) => return Ok(e),
        };
        // Activity + capture start-seq are sampled inside write_input under the
        // per-terminal exec lock, atomic with the write itself.
        match self
            .write_input(
                &terminal_id,
                &p.data,
                p.escape,
                p.enter,
                p.reply_to.as_deref(),
                p.capture_ms.is_some(),
            )
            .await
        {
            Ok(outcome) => {
                let mut result = json!({
                    "written": true,
                    "bytes": outcome.bytes,
                    "bytesWritten": outcome.bytes,
                    "enter": p.enter,
                    "terminalId": terminal_id,
                    "activity": outcome.activity,
                });
                self.apply_capture(&mut result, &terminal_id, p.capture_ms, outcome.before_seq)
                    .await;
                Ok(json_result(&result))
            }
            Err(e) => Ok(e),
        }
    }

    /// Write to a neighboring pane by direction. Combines identify_caller + write_to_terminal
    /// in a single call. Pass your own terminal_id (from $LX_TERMINAL_ID) and the direction
    /// of the neighbor you want to send to. Like `write_to_terminal`, input is
    /// submitted by default; pass `enter: false` to type without submitting.
    /// The return includes the neighbor's pre-write `activity` (shell / running /
    /// interactiveApp) and, when `capture_ms` is set, its post-write `response` —
    /// see `write_to_terminal` for how to use them.
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

        // 2. Write to the neighbor. Activity + capture start-seq are sampled
        // inside write_input under the per-terminal exec lock (see write_to_terminal).
        match self
            .write_input(
                &target_id,
                &p.data,
                p.escape,
                p.enter,
                p.reply_to.as_deref(),
                p.capture_ms.is_some(),
            )
            .await
        {
            Ok(outcome) => {
                let mut result = json!({
                    "written": true,
                    "bytes": outcome.bytes,
                    "enter": p.enter,
                    "targetTerminalId": target_id,
                    "direction": p.direction.to_string(),
                    "activity": outcome.activity,
                });
                self.apply_capture(&mut result, &target_id, p.capture_ms, outcome.before_seq)
                    .await;
                Ok(json_result(&result))
            }
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
        let terminal_id = match self
            .resolve_terminal_id(
                p.terminal_id.as_deref(),
                p.pane_ref.as_deref(),
                p.pane_number,
                p.workspace_id.as_deref(),
            )
            .await
        {
            Ok(id) => id,
            Err(e) => return Ok(e),
        };
        let lines = p.lines.unwrap_or(100) as usize;
        let (raw, buffer_size) = match self.recent_output_lines(&terminal_id, lines) {
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

    /// Set focus to a terminal pane, by stable terminal_id or spatial pane_number.
    #[tool]
    async fn focus_terminal(
        &self,
        Parameters(p): Parameters<TerminalTargetParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let terminal_id = match self
            .resolve_terminal_id(
                p.terminal_id.as_deref(),
                p.pane_ref.as_deref(),
                p.pane_number,
                p.workspace_id.as_deref(),
            )
            .await
        {
            Ok(id) => id,
            Err(e) => return Ok(e),
        };
        self.bridge(
            "action",
            "terminals",
            "setFocus",
            json!({ "id": terminal_id }),
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

        // Reject unknown/closed terminals before creating a lock entry so the
        // process-global exec_locks table can't grow from invalid ids (#427).
        if !self.terminal_exists(&p.terminal_id) {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "Terminal '{}' not found",
                p.terminal_id
            ))]));
        }

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
                    // Vanished after the pre-lock existence check (raced close):
                    // purge the possibly-recreated lock entry (#427).
                    self.remove_terminal_lock(&p.terminal_id);
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

    /// Dev-only: enable or disable grid edit mode for automated layout tests.
    #[tool]
    async fn set_edit_mode(
        &self,
        Parameters(p): Parameters<SetEditModeParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "grid",
            "setEditMode",
            json!({ "enabled": p.enabled }),
        )
        .await
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

    /// Dev-only: simulate pane hover state for screenshot/UI verification.
    /// Pass no pane_index (or null) to clear automation hover.
    #[tool]
    async fn simulate_hover(
        &self,
        Parameters(p): Parameters<SimulateHoverParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "grid",
            "simulateHover",
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

    /// Dev-only: set a pane's view config directly through the frontend bridge.
    #[tool]
    async fn set_pane_view(
        &self,
        Parameters(p): Parameters<SetPaneViewParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let view = match Self::require_object_param(p.view, "view") {
            Ok(view) => view,
            Err(err) => return Ok(err),
        };
        if view
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            return Ok(CallToolResult::error(vec![Content::text(
                "'view.type' is required and must be a non-empty string",
            )]));
        }
        self.bridge(
            "action",
            "panes",
            "setView",
            json!({ "paneIndex": p.pane_index, "view": view }),
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

    /// Send the same input to multiple terminals at once. Each terminal is
    /// written via the same path as `write_to_terminal`, so `enter` submits with
    /// the #314 paste-burst-safe body→CR delay and per-terminal serialization.
    #[tool]
    async fn broadcast_write(
        &self,
        Parameters(p): Parameters<BroadcastWriteParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut written = Vec::new();
        let mut failed = Vec::new();

        for id in &p.terminal_ids {
            match self
                .write_input(id, &p.data, p.escape, p.enter, None, false)
                .await
            {
                Ok(_) => written.push(id.clone()),
                Err(_) => failed.push(json!({ "id": id, "error": "not found or write failed" })),
            }
        }

        Ok(json_result(&json!({
            "written": written,
            "failed": failed,
        })))
    }

    /// List all memos stored in `cache/memo.json` as `{ key, content }` entries.
    /// Returns an empty list when the memo file is missing or unreadable.
    /// Memo keys are typically workspace pane IDs (e.g. `pane-abc12345`) so
    /// pair this with `list_terminals` to map memos back to specific panes.
    #[tool]
    async fn list_memos(&self) -> Result<CallToolResult, ErrorData> {
        let all = crate::settings::load_all_memos();
        let payload = super::handlers_backend::build_memos_list_payload(all);
        Ok(json_result(&payload))
    }

    /// Read the memo content stored under a specific key. Returns an error
    /// when the key is not present (use `list_memos` to discover keys).
    #[tool]
    async fn read_memo(
        &self,
        Parameters(p): Parameters<MemoKeyParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let all = crate::settings::load_all_memos();
        Ok(read_memo_result_from_map(&all, &p.key))
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

    // ── Dev-only frontend controls ──

    /// Dev-only: set the app theme by theme ID.
    #[tool]
    async fn set_app_theme(
        &self,
        Parameters(p): Parameters<SetAppThemeParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if p.theme_id.trim().is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "'theme_id' is required and must be non-empty",
            )]));
        }
        self.bridge(
            "action",
            "settings",
            "setAppTheme",
            json!({ "themeId": p.theme_id }),
        )
        .await
    }

    /// Dev-only: merge profile defaults into settings.profileDefaults.
    #[tool]
    async fn set_profile_defaults(
        &self,
        Parameters(p): Parameters<SetProfileDefaultsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let data = match Self::require_object_param(p.data, "data") {
            Ok(data) => data,
            Err(err) => return Ok(err),
        };
        self.bridge("action", "settings", "setProfileDefaults", data)
            .await
    }

    /// Dev-only: merge a partial profile object into settings.profiles[index].
    #[tool]
    async fn update_profile(
        &self,
        Parameters(p): Parameters<UpdateProfileParam>,
    ) -> Result<CallToolResult, ErrorData> {
        let data = match Self::require_object_param(p.data, "data") {
            Ok(data) => data,
            Err(err) => return Ok(err),
        };
        self.bridge(
            "action",
            "settings",
            "updateProfile",
            json!({ "index": p.index, "data": data }),
        )
        .await
    }

    /// Dev-only: open the settings modal.
    #[tool]
    async fn open_settings(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "openSettings", json!({})).await
    }

    /// Dev-only: close the settings modal.
    #[tool]
    async fn close_settings(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "closeSettings", json!({}))
            .await
    }

    /// Dev-only: toggle the settings modal.
    #[tool]
    async fn toggle_settings(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "toggleSettings", json!({}))
            .await
    }

    /// Dev-only: navigate the settings modal to a specific section.
    #[tool]
    async fn navigate_settings(
        &self,
        Parameters(p): Parameters<NavigateSettingsParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.bridge(
            "action",
            "ui",
            "navigateSettings",
            json!({ "section": p.section.unwrap_or_else(|| "startup".to_string()) }),
        )
        .await
    }

    /// Dev-only: toggle the Remote Access modal.
    #[tool]
    async fn toggle_remote_access(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "toggleRemoteAccess", json!({}))
            .await
    }

    /// Dev-only: open the Remote Access modal.
    #[tool]
    async fn open_remote_access(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "openRemoteAccess", json!({}))
            .await
    }

    /// Dev-only: close the Remote Access modal.
    #[tool]
    async fn close_remote_access(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "closeRemoteAccess", json!({}))
            .await
    }

    /// Dev-only: toggle the notification panel.
    #[tool]
    async fn toggle_notification_panel(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "toggleNotificationPanel", json!({}))
            .await
    }

    /// Dev-only: toggle workspace/pane hide mode.
    #[tool]
    async fn toggle_hide_mode(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "toggleHideMode", json!({}))
            .await
    }

    /// Dev-only: toggle whether a workspace is hidden in hide mode.
    #[tool]
    async fn toggle_workspace_hidden(
        &self,
        Parameters(p): Parameters<ToggleWorkspaceHiddenParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if p.workspace_id.trim().is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "'workspace_id' is required and must be non-empty",
            )]));
        }
        self.bridge(
            "action",
            "ui",
            "toggleWorkspaceHidden",
            json!({ "id": p.workspace_id }),
        )
        .await
    }

    /// Dev-only: toggle whether a pane is hidden in hide mode.
    #[tool]
    async fn toggle_pane_hidden(
        &self,
        Parameters(p): Parameters<TogglePaneHiddenParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if p.pane_id.trim().is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "'pane_id' is required and must be non-empty",
            )]));
        }
        self.bridge(
            "action",
            "ui",
            "togglePaneHidden",
            json!({ "id": p.pane_id }),
        )
        .await
    }

    // ── File viewer ──

    /// Open a file in laymux's unified file viewer overlay. This is the same
    /// viewer used by the File Explorer and the Ctrl+Shift+O shortcut, so text,
    /// images, and binaries render the same way everywhere. Pass `new_window:
    /// true` to fill the whole window; otherwise it opens as a large floating
    /// overlay. The path should be absolute and is resolved on the host
    /// filesystem (use a WSL/Unix path for files inside WSL).
    #[tool]
    async fn open_file_viewer(
        &self,
        Parameters(p): Parameters<OpenFileViewerParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if p.path.trim().is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "'path' is required and must be non-empty",
            )]));
        }
        self.bridge(
            "action",
            "ui",
            "openFileViewer",
            json!({ "path": p.path, "newWindow": p.new_window }),
        )
        .await
    }

    /// Show an image the MCP client holds in memory (e.g. a generated chart or a
    /// pasted screenshot) without it existing as a file on the laymux host.
    /// Pass base64-encoded image bytes in `data` (a `data:` URI prefix is
    /// accepted and stripped). The bytes are written to a temp file under
    /// laymux's cache dir and opened in the same unified viewer used by
    /// `open_file_viewer` / the File Explorer. To show an image that already
    /// exists as a file, use `open_file_viewer` with its path instead. Pass
    /// `new_window: true` to fill the whole window; otherwise it opens as a
    /// large floating overlay.
    #[tool]
    async fn show_image(
        &self,
        Parameters(p): Parameters<ShowImageParam>,
    ) -> Result<CallToolResult, ErrorData> {
        if p.data.trim().is_empty() {
            return Ok(CallToolResult::error(vec![Content::text(
                "'data' is required and must be non-empty base64 image data",
            )]));
        }
        let path = match save_image_to_dir(&p.data, p.mime_type.as_deref(), &mcp_image_dir()) {
            Ok(path) => path,
            Err(e) => {
                tracing::warn!(error = %e, "show_image failed to save image");
                return Ok(CallToolResult::error(vec![Content::text(e.to_string())]));
            }
        };
        let path_str = path.to_string_lossy().to_string();
        self.bridge(
            "action",
            "ui",
            "openFileViewer",
            json!({ "path": path_str, "newWindow": p.new_window }),
        )
        .await
    }

    /// Close the file viewer overlay opened by `open_file_viewer` / `show_image`.
    /// No-op if the viewer is not open.
    #[tool]
    async fn close_file_viewer(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("action", "ui", "closeFileViewer", json!({}))
            .await
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
                 - Read another pane's output: list_terminals → read_terminal_output with target terminal_id\n\
                 - Message another LLM agent pane and get its result back: write_to_terminal with \
                 reply_to=$LX_TERMINAL_ID — a standardized footer tells the agent where to reply"
                    .to_string(),
            )
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        if !self.is_tool_visible(request.name.as_ref()) {
            return Err(Self::tool_not_found());
        }
        let tcc = ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.visible_tools(),
            meta: None,
            next_cursor: None,
        })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        if !self.is_tool_visible(name) {
            return None;
        }
        self.tool_router.get(name).cloned()
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

/// Map a MIME type to a sensible image file extension (no leading dot).
///
/// Only emits extensions the shared FileViewer classifier
/// (`commands::file_ops::IMAGE_EXTENSIONS`) can actually render in the webview;
/// otherwise `read_file_for_viewer` would classify the saved file as text/binary
/// and the image would never display (see PR #289 review). Unknown/blank types
/// and non-webview-renderable formats (e.g. TIFF) fall back to "png" so the
/// viewer still attempts an image render rather than treating it as binary.
fn image_extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/avif" => "avif",
        _ => "png",
    }
}

/// Split a possible `data:` URI into `(mime_type, base64_payload)`.
/// For a bare base64 string (no `data:` prefix) returns `(None, input)`.
/// Only base64-encoded data URIs are supported; a non-base64 data URI yields an
/// error string.
fn parse_image_data_uri(raw: &str) -> Result<(Option<String>, &str), String> {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("data:") else {
        return Ok((None, trimmed));
    };
    // rest looks like: image/png;base64,AAAA  (mime portion may be empty)
    let Some((meta, payload)) = rest.split_once(',') else {
        return Err("Malformed data URI: missing ',' separator".to_string());
    };
    if !meta.split(';').any(|p| p.eq_ignore_ascii_case("base64")) {
        return Err("Only base64-encoded data URIs are supported".to_string());
    }
    let mime = meta
        .split(';')
        .next()
        .map(str::to_string)
        .filter(|m| !m.is_empty());
    Ok((mime, payload))
}

/// Decode a base64 image payload (bare or `data:` URI) and write it to a freshly
/// named file under `dir`. Returns the written file path. The MIME type from a
/// `data:` URI takes precedence over the caller-supplied `mime_type`.
///
/// Pure I/O helper shared by the `show_image` MCP tool and its tests; takes the
/// target directory explicitly so tests can write into a tempdir.
fn save_image_to_dir(
    data: &str,
    mime_type: Option<&str>,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf, AppError> {
    use base64::Engine as _;

    let (uri_mime, payload) = parse_image_data_uri(data).map_err(AppError::Other)?;
    // Strip ALL ASCII whitespace, not just the ends: some data URIs wrap the
    // base64 payload across lines, which the STANDARD engine rejects (PR #289).
    let cleaned: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if cleaned.is_empty() {
        return Err(AppError::Other("'data' is empty".to_string()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| AppError::Other(format!("Invalid base64 image data: {e}")))?;
    if bytes.is_empty() {
        return Err(AppError::Other("Decoded image is empty".to_string()));
    }

    let effective_mime = uri_mime.as_deref().or(mime_type).unwrap_or("image/png");
    let ext = image_extension_for_mime(effective_mime);

    std::fs::create_dir_all(dir)?;
    let file_path = dir.join(format!("{MCP_IMAGE_PREFIX}{}.{ext}", uuid::Uuid::new_v4()));
    std::fs::write(&file_path, &bytes)?;
    Ok(file_path)
}

/// Resolve the directory where `show_image` writes temporary image files.
/// Uses laymux's cache dir (`<config>/cache/mcp-images`) when available, else the
/// OS temp dir, so the file is always on the host filesystem the viewer reads.
fn mcp_image_dir() -> std::path::PathBuf {
    crate::settings::cache_dir_path()
        .map(|c| c.join("mcp-images"))
        .unwrap_or_else(|| std::env::temp_dir().join("laymux-mcp-images"))
}

/// Filename prefix for files written by `show_image`. Used both for naming and
/// for the cleanup routine so only our own temp files are ever deleted.
const MCP_IMAGE_PREFIX: &str = "mcp-image-";

/// Delete `mcp-image-*` files older than `max_age_days` from `dir`.
///
/// `show_image` writes a fresh file per call with no overwrite, so without this
/// the directory grows unbounded (PR #289 review). The existing
/// `clipboard::cleanup_old_paste_images` only matches `.png`, but show_image
/// emits jpg/gif/webp/svg/etc., so we match on the `mcp-image-` filename prefix
/// instead of the extension. Returns the number of files removed.
///
/// Pure helper (takes the directory explicitly) so tests can use a tempdir.
fn cleanup_old_mcp_images(dir: &std::path::Path, max_age_days: u64) -> u32 {
    if !dir.exists() {
        return 0;
    }
    let max_age = std::time::Duration::from_secs(max_age_days * 24 * 60 * 60);
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            // A persistent failure (e.g. permissions) would otherwise be silent;
            // log once so it's diagnosable, but don't treat cleanup as fatal.
            tracing::debug!(dir = %dir.display(), error = %e, "MCP image cleanup: read_dir failed");
            return 0;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ours = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(MCP_IMAGE_PREFIX));
        if !is_ours {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        let is_old = now
            .duration_since(modified)
            .map(|age| age > max_age)
            .unwrap_or(false);
        if is_old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Startup hook: prune stale `show_image` temp files from the cache dir.
/// Thin wrapper over [`cleanup_old_mcp_images`] resolving the real directory.
pub(crate) fn cleanup_mcp_image_cache(max_age_days: u64) -> u32 {
    cleanup_old_mcp_images(&mcp_image_dir(), max_age_days)
}

fn read_memo_result_from_map(
    map: &std::collections::HashMap<String, String>,
    key: &str,
) -> CallToolResult {
    match super::handlers_backend::build_memo_get_response(map, key) {
        Some(json) => json_result(&json),
        None => CallToolResult::error(vec![Content::text(format!("Memo '{key}' not found"))]),
    }
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
        assert_eq!(p.terminal_id.as_deref(), Some("t1"));
        assert_eq!(p.data, "ls\r\n");
    }

    #[test]
    fn read_output_param_defaults() {
        let json = r#"{"terminal_id":"t1"}"#;
        let p: ReadOutputParam = serde_json::from_str(json).unwrap();
        assert!(p.lines.is_none());
    }

    #[test]
    fn write_terminal_accepts_pane_number_without_terminal_id() {
        // issue #256: address a pane by spatial number instead of terminal_id.
        let json = r#"{"pane_number":3,"data":"ls"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(p.terminal_id.is_none());
        assert!(p.pane_ref.is_none());
        assert_eq!(p.pane_number, Some(3));
        assert!(p.workspace_id.is_none());
    }

    #[test]
    fn write_terminal_accepts_pane_ref_locator() {
        let json = r#"{"pane_ref":"lx:pane:Default:3","data":"ls"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.pane_ref.as_deref(), Some("lx:pane:Default:3"));
        assert!(p.terminal_id.is_none());
        assert!(p.pane_number.is_none());
    }

    #[test]
    fn terminal_id_accepts_pane_locator_string() {
        let json = r#"{"terminal_id":"lx:pane:Default:2","data":"ls"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.terminal_id.as_deref(), Some("lx:pane:Default:2"));
    }

    #[test]
    fn write_terminal_accepts_both_terminal_id_and_pane_number() {
        let json = r#"{"terminal_id":"t1","pane_number":2,"workspace_id":"ws-1","data":"x"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.terminal_id.as_deref(), Some("t1"));
        assert_eq!(p.pane_number, Some(2));
        assert_eq!(p.workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn write_terminal_accepts_neither_id_nor_number_at_deserialize() {
        // Deserialization must succeed; the missing-target case is handled at call time.
        let json = r#"{"data":"x"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert!(p.terminal_id.is_none());
        assert!(p.pane_number.is_none());
    }

    #[test]
    fn read_output_accepts_pane_number() {
        let json = r#"{"pane_number":1}"#;
        let p: ReadOutputParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.pane_number, Some(1));
        assert!(p.terminal_id.is_none());
    }

    #[test]
    fn read_output_accepts_pane_ref_locator() {
        let json = r#"{"pane_ref":"lx:pane:Default:1"}"#;
        let p: ReadOutputParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.pane_ref.as_deref(), Some("lx:pane:Default:1"));
        assert!(p.terminal_id.is_none());
    }

    #[test]
    fn terminal_target_param_accepts_pane_number() {
        let json = r#"{"pane_number":2,"workspace_id":"ws-1"}"#;
        let p: TerminalTargetParam = serde_json::from_str(json).unwrap();
        assert!(p.terminal_id.is_none());
        assert_eq!(p.pane_number, Some(2));
        assert_eq!(p.workspace_id.as_deref(), Some("ws-1"));
    }

    #[test]
    fn parse_pane_locator_accepts_canonical_form() {
        let parsed = parse_pane_locator("lx:pane:Default:1").unwrap().unwrap();
        assert_eq!(
            parsed,
            PaneLocator {
                workspace_name: "Default".to_string(),
                pane_number: 1
            }
        );
    }

    #[test]
    fn parse_pane_locator_ignores_non_locator_values() {
        assert!(parse_pane_locator("terminal-pane-abc").unwrap().is_none());
    }

    #[test]
    fn parse_pane_locator_allows_colon_in_workspace_name() {
        // Workspace name normalization only strips whitespace, not colons, so a name like
        // `API:v2` reaches the locator verbatim. The pane number is the last segment.
        let parsed = parse_pane_locator("lx:pane:API:v2:3").unwrap().unwrap();
        assert_eq!(
            parsed,
            PaneLocator {
                workspace_name: "API:v2".to_string(),
                pane_number: 3
            }
        );
    }

    #[test]
    fn parse_pane_locator_rejects_whitespace_workspace_names() {
        let err = parse_pane_locator("lx:pane:My Workspace:1").unwrap_err();
        assert!(err.contains("must not contain whitespace"));
    }

    #[test]
    fn parse_pane_locator_rejects_zero_pane_number() {
        let err = parse_pane_locator("lx:pane:Default:0").unwrap_err();
        assert!(err.contains("greater than 0"));
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
    fn open_file_viewer_param_defaults_new_window_false() {
        let json = r#"{"path":"/tmp/a.txt"}"#;
        let p: OpenFileViewerParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.path, "/tmp/a.txt");
        assert!(!p.new_window);
    }

    #[test]
    fn open_file_viewer_param_accepts_new_window() {
        let json = r#"{"path":"/tmp/a.txt","new_window":true}"#;
        let p: OpenFileViewerParam = serde_json::from_str(json).unwrap();
        assert!(p.new_window);
    }

    #[test]
    fn open_file_viewer_param_requires_path() {
        let json = r#"{"new_window":true}"#;
        let result: Result<OpenFileViewerParam, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // ── show_image ──

    #[test]
    fn show_image_param_defaults() {
        let json = r#"{"data":"AAAA"}"#;
        let p: ShowImageParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.data, "AAAA");
        assert!(p.mime_type.is_none());
        assert!(!p.new_window);
    }

    #[test]
    fn show_image_param_accepts_mime_and_new_window() {
        let json = r#"{"data":"AAAA","mime_type":"image/jpeg","new_window":true}"#;
        let p: ShowImageParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.mime_type.as_deref(), Some("image/jpeg"));
        assert!(p.new_window);
    }

    #[test]
    fn show_image_param_requires_data() {
        let json = r#"{"mime_type":"image/png"}"#;
        let result: Result<ShowImageParam, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn image_extension_maps_known_mimes() {
        assert_eq!(image_extension_for_mime("image/png"), "png");
        assert_eq!(image_extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(image_extension_for_mime("IMAGE/JPG"), "jpg");
        assert_eq!(image_extension_for_mime("image/gif"), "gif");
        assert_eq!(image_extension_for_mime("image/webp"), "webp");
        assert_eq!(image_extension_for_mime("image/svg+xml"), "svg");
        // AVIF is webview-renderable and recognized by the FileViewer classifier.
        assert_eq!(image_extension_for_mime("image/avif"), "avif");
        // TIFF is not renderable in the webview <img>, so it falls back to png
        // rather than emitting a `.tiff` the viewer would treat as binary (PR #289).
        assert_eq!(image_extension_for_mime("image/tiff"), "png");
        // Unknown falls back to png.
        assert_eq!(image_extension_for_mime("application/octet-stream"), "png");
        assert_eq!(image_extension_for_mime(""), "png");
    }

    #[test]
    fn image_extensions_are_all_viewer_renderable() {
        // Every extension `image_extension_for_mime` can emit must be in the
        // shared FileViewer image classifier, otherwise the saved file would be
        // classified as text/binary and never displayed (PR #289 review).
        for mime in [
            "image/png",
            "image/jpeg",
            "image/jpg",
            "image/gif",
            "image/webp",
            "image/bmp",
            "image/svg+xml",
            "image/x-icon",
            "image/avif",
            "image/tiff",
            "application/octet-stream",
            "",
        ] {
            let ext = format!(".{}", image_extension_for_mime(mime));
            assert!(
                crate::commands::IMAGE_EXTENSIONS.contains(&ext.as_str()),
                "emitted extension {ext} for mime {mime:?} is not viewer-renderable",
            );
        }
    }

    #[test]
    fn parse_data_uri_bare_base64() {
        let (mime, payload) = parse_image_data_uri("  AAAA  ").unwrap();
        assert!(mime.is_none());
        assert_eq!(payload, "AAAA");
    }

    #[test]
    fn parse_data_uri_with_mime() {
        let (mime, payload) = parse_image_data_uri("data:image/gif;base64,Zm9v").unwrap();
        assert_eq!(mime.as_deref(), Some("image/gif"));
        assert_eq!(payload, "Zm9v");
    }

    #[test]
    fn parse_data_uri_rejects_non_base64() {
        // URL-encoded (not base64) data URIs are unsupported.
        assert!(parse_image_data_uri("data:image/svg+xml,<svg/>").is_err());
    }

    #[test]
    fn save_image_writes_decoded_bytes_with_extension() {
        // base64 of the 3 bytes 0x01 0x02 0x03.
        let dir = tempfile::tempdir().unwrap();
        let path = save_image_to_dir("AQID", Some("image/jpeg"), dir.path()).unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jpg"));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes, vec![1u8, 2, 3]);
    }

    #[test]
    fn save_image_data_uri_mime_overrides_param() {
        let dir = tempfile::tempdir().unwrap();
        // data URI says gif; explicit param says png → URI wins.
        let path =
            save_image_to_dir("data:image/gif;base64,AQID", Some("image/png"), dir.path()).unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("gif"));
    }

    #[test]
    fn save_image_defaults_to_png_without_mime() {
        let dir = tempfile::tempdir().unwrap();
        let path = save_image_to_dir("AQID", None, dir.path()).unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
    }

    #[test]
    fn save_image_rejects_invalid_base64() {
        let dir = tempfile::tempdir().unwrap();
        let err = save_image_to_dir("not valid base64!!!", None, dir.path()).unwrap_err();
        assert!(err.to_string().contains("base64"), "got: {err}");
    }

    #[test]
    fn save_image_rejects_empty_payload() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_image_to_dir("   ", None, dir.path()).is_err());
        assert!(save_image_to_dir("data:image/png;base64,", None, dir.path()).is_err());
    }

    #[test]
    fn save_image_creates_missing_dir_and_unique_names() {
        let base = tempfile::tempdir().unwrap();
        let nested = base.path().join("does/not/exist/yet");
        let p1 = save_image_to_dir("AQID", None, &nested).unwrap();
        let p2 = save_image_to_dir("AQID", None, &nested).unwrap();
        assert!(p1.exists() && p2.exists());
        assert_ne!(p1, p2, "each call must produce a uniquely named file");
    }

    #[test]
    fn save_image_strips_internal_whitespace() {
        // base64 "AQID" split across lines (as some data URIs wrap it).
        let dir = tempfile::tempdir().unwrap();
        let path = save_image_to_dir("AQ\nID", None, dir.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![1u8, 2, 3]);
    }

    #[test]
    fn cleanup_removes_only_old_mcp_files() {
        let dir = tempfile::tempdir().unwrap();
        // Old + recent show_image files, plus an unrelated old file.
        let old_mcp = save_image_to_dir("AQID", None, dir.path()).unwrap();
        let recent_mcp = save_image_to_dir("AQID", None, dir.path()).unwrap();
        let unrelated = dir.path().join("keep-me.png");
        std::fs::write(&unrelated, [9u8]).unwrap();

        // Backdate the old files to 8 days ago.
        let eight_days_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60);
        for p in [&old_mcp, &unrelated] {
            std::fs::OpenOptions::new()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(eight_days_ago)
                .unwrap();
        }

        let removed = cleanup_old_mcp_images(dir.path(), 7);
        assert_eq!(removed, 1, "only the old mcp-image file should be removed");
        assert!(!old_mcp.exists(), "old mcp-image must be deleted");
        assert!(recent_mcp.exists(), "recent mcp-image must be kept");
        assert!(unrelated.exists(), "non-mcp file must never be touched");
    }

    #[test]
    fn cleanup_missing_dir_is_noop() {
        let base = tempfile::tempdir().unwrap();
        let missing = base.path().join("nope");
        assert_eq!(cleanup_old_mcp_images(&missing, 7), 0);
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
    fn read_memo_result_uses_shared_http_shape() {
        let mut map = std::collections::HashMap::new();
        map.insert("pane-1".to_string(), "hello".to_string());

        let result = read_memo_result_from_map(&map, "pane-1");
        assert_ne!(result.is_error, Some(true));
        let value = serde_json::to_value(&result.content).unwrap();
        let text = value[0]["text"].as_str().expect("content must be text");
        let payload: Value = serde_json::from_str(text).unwrap();

        assert_eq!(payload["key"], "pane-1");
        assert_eq!(payload["content"], "hello");
        assert_eq!(
            payload,
            super::super::handlers_backend::build_memo_get_response(&map, "pane-1").unwrap()
        );
    }

    #[test]
    fn read_memo_result_reports_missing_key_as_error() {
        let map = std::collections::HashMap::new();
        let result = read_memo_result_from_map(&map, "missing");
        assert_eq!(result.is_error, Some(true));
        let value = serde_json::to_value(&result.content).unwrap();
        assert!(value[0]["text"].as_str().unwrap().contains("missing"));
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
    fn write_terminal_capture_ms_defaults_to_none() {
        // capture_ms 생략 시 응답 캡처 없이 논블로킹 write (기존 동작 유지).
        let json = r#"{"terminal_id":"t1","data":"hello"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.capture_ms, None);
    }

    #[test]
    fn write_terminal_capture_ms_parsed() {
        let json = r#"{"terminal_id":"t1","data":"hello","capture_ms":1500}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.capture_ms, Some(1500));
    }

    #[test]
    fn write_to_neighbor_capture_ms_parsed() {
        let json = r#"{"terminal_id":"t1","direction":"below","data":"hello","capture_ms":800}"#;
        let p: WriteToNeighborParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.capture_ms, Some(800));
    }

    #[test]
    fn exec_locks_are_shared_across_appstate_clones() {
        // Two MCP handlers in different sessions hold clones of the same
        // Arc<AppState>; the exec-lock table lives there, so the same terminal
        // must resolve to the SAME lock Arc across them (cross-session
        // serialization — #427). Different terminals get different locks.
        let a = Arc::new(crate::state::AppState::new());
        let b = a.clone(); // second session's ServerState.app_state
        let la = get_or_create_terminal_lock(&a.exec_locks, "t1");
        let lb = get_or_create_terminal_lock(&b.exec_locks, "t1");
        assert!(
            Arc::ptr_eq(&la, &lb),
            "same terminal across shared AppState must yield one lock"
        );
        let lc = get_or_create_terminal_lock(&a.exec_locks, "t2");
        assert!(
            !Arc::ptr_eq(&la, &lc),
            "different terminals must get distinct locks"
        );
    }

    #[test]
    fn exec_locks_entry_is_dropped_after_removal() {
        // Mirrors close_terminal_session cleanup (#427): once an entry is
        // removed from the table, the next get_or_create makes a fresh lock, so
        // the table does not retain entries for closed terminals forever.
        let state = Arc::new(crate::state::AppState::new());
        let first = get_or_create_terminal_lock(&state.exec_locks, "t1");
        state.exec_locks.lock().unwrap().remove("t1");
        assert_eq!(
            state.exec_locks.lock().unwrap().len(),
            0,
            "removal must empty the table"
        );
        let second = get_or_create_terminal_lock(&state.exec_locks, "t1");
        assert!(
            !Arc::ptr_eq(&first, &second),
            "a re-created lock after removal must be a distinct Arc"
        );
    }

    #[test]
    fn truncate_tail_keeps_short_text_verbatim() {
        let (out, trunc) = McpHandler::truncate_tail("short output", 2000);
        assert_eq!(out, "short output");
        assert!(!trunc);
    }

    #[test]
    fn truncate_tail_keeps_the_tail_when_over_max() {
        let s: String = (0..50).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let (out, trunc) = McpHandler::truncate_tail(&s, 10);
        assert!(trunc);
        assert_eq!(out.chars().count(), 10);
        // Tail kept, not head: the last 10 chars of the source.
        let expected: String = s.chars().skip(50 - 10).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn truncate_tail_is_char_boundary_safe_for_multibyte() {
        // 5 multi-byte chars, cap at 2 → must not panic and must yield 2 chars.
        let (out, trunc) = McpHandler::truncate_tail("가나다라마", 2);
        assert!(trunc);
        assert_eq!(out, "라마");
    }

    #[test]
    fn capture_response_pipeline_strips_ansi_then_truncates() {
        // strip_ansi + truncate_tail is the response pipeline; verify ANSI removal
        // composes with tail truncation without splitting escape sequences.
        let raw = "\x1b[31mERROR\x1b[0m: command not found";
        let stripped = super::super::helpers::strip_ansi(raw);
        let (out, trunc) = McpHandler::truncate_tail(stripped.trim(), 2000);
        assert_eq!(out, "ERROR: command not found");
        assert!(!trunc);
    }

    #[test]
    fn prepare_input_body_default_flags_keeps_plain_text() {
        // 본문에는 CR이 붙지 않는다 — 제출 CR은 write_input이 별도로 보낸다.
        let out = McpHandler::prepare_input_body("ls", false, true, None);
        assert_eq!(out, "ls");
    }

    #[test]
    fn prepare_input_body_enter_false_keeps_plain_text() {
        let out = McpHandler::prepare_input_body("ls", false, false, None);
        assert_eq!(out, "ls");
    }

    // ── Issue #314: TUI 줄바꿈-제출 버그 ───────────────────────────────
    // (1) Windows ConPTY/PSReadLine: enter=true 시 data 끝에 개행이 남아
    //     별도 CR과 합쳐져 `...\n\r` 가 되면 줄바꿈만 삽입되고 제출되지 않는다.
    //     → 본문에서 후행 개행을 제거한다.
    // (2) Codex TUI: 텍스트+CR을 한 번의 write로 보내면 붙여넣기로 간주해 CR을
    //     줄바꿈 처리한다. → write_input이 본문과 CR을 분리해 보낸다(ENTER_CR_DELAY_MS).
    // 아래 테스트는 (1)의 본문 정규화를 검증한다.

    #[test]
    fn prepare_input_body_strips_trailing_lf_before_enter() {
        let out = McpHandler::prepare_input_body("ls\n", false, true, None);
        assert_eq!(out, "ls");
    }

    #[test]
    fn prepare_input_body_strips_trailing_crlf_before_enter() {
        let out = McpHandler::prepare_input_body("ls\r\n", false, true, None);
        assert_eq!(out, "ls");
    }

    #[test]
    fn prepare_input_body_strips_trailing_cr_before_enter() {
        let out = McpHandler::prepare_input_body("ls\r", false, true, None);
        assert_eq!(out, "ls");
    }

    #[test]
    fn prepare_input_body_strips_trailing_lf_from_escaped_data() {
        // escape=true + data="ls\\n" → unescape 후 "ls\n" → 후행 개행 제거.
        let out = McpHandler::prepare_input_body(r"ls\n", true, true, None);
        assert_eq!(out, "ls");
    }

    #[test]
    fn prepare_input_body_preserves_internal_newlines_with_enter() {
        // 멀티라인 내용의 내부 개행은 보존하고 후행 개행만 제거한다.
        let out = McpHandler::prepare_input_body("line1\nline2\n", false, true, None);
        assert_eq!(out, "line1\nline2");
    }

    #[test]
    fn prepare_input_body_keeps_trailing_newline_when_enter_false() {
        // enter=false면 사용자가 보낸 후행 개행을 그대로 둔다(제출 의도 없음).
        let out = McpHandler::prepare_input_body("ls\n", false, false, None);
        assert_eq!(out, "ls\n");
    }

    #[test]
    fn prepare_input_body_empty_data_with_enter_is_empty() {
        // 빈 본문 — 제출 CR만 별도로 전송된다(lone CR).
        let out = McpHandler::prepare_input_body("", false, true, None);
        assert_eq!(out, "");
    }

    // ── 에이전트 간 메시징: reply_to 회신 푸터 ────────────────────────

    #[test]
    fn prepare_input_body_reply_to_appends_footer() {
        let out =
            McpHandler::prepare_input_body("do the task", false, true, Some("terminal-pane-aa"));
        assert!(out.starts_with("do the task\n\n[reply-to:"));
        assert!(
            out.ends_with("terminal_id=\"terminal-pane-aa\"]"),
            "footer must close the body without trailing newline: {out:?}"
        );
    }

    #[test]
    fn prepare_input_body_empty_reply_to_is_ignored() {
        let out = McpHandler::prepare_input_body("ls", false, true, Some(""));
        assert_eq!(out, "ls");
    }

    #[test]
    fn prepare_input_body_reply_to_survives_trailing_newline_strip() {
        // 후행 개행 정리 전에 푸터가 붙으므로, data의 후행 개행은 내부 개행이
        // 되어 보존되고 푸터는 잘리지 않는다.
        let out = McpHandler::prepare_input_body("task\n", false, true, Some("t1"));
        assert!(out.ends_with("terminal_id=\"t1\"]"));
    }

    #[test]
    fn write_terminal_param_accepts_reply_to() {
        let json = r#"{"terminal_id":"t1","data":"hi","reply_to":"terminal-pane-bb"}"#;
        let p: WriteTerminalParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.reply_to.as_deref(), Some("terminal-pane-bb"));
    }

    #[test]
    fn write_to_neighbor_param_accepts_reply_to() {
        let json = r#"{"terminal_id":"t1","direction":"right","data":"hi","reply_to":"t1"}"#;
        let p: WriteToNeighborParam = serde_json::from_str(json).unwrap();
        assert_eq!(p.reply_to.as_deref(), Some("t1"));
    }

    // ── Issue #314: write_input 의 PTY write 시퀀스 계획 ──────────────
    // 본문과 제출 CR을 분리된 청크로 보내 Codex paste 오인을 막는다. 아래는
    // write_input 이 실제로 보낼 청크 순서/개수를 순수 함수로 고정한 것이다.

    #[test]
    fn plan_input_writes_submit_splits_body_then_cr() {
        // 평문 제출: 본문 1청크 + CR 1청크 (분리 전송).
        let chunks = McpHandler::plan_input_writes("echo hi", false, true, None);
        assert_eq!(chunks, vec![b"echo hi".to_vec(), b"\r".to_vec()]);
    }

    #[test]
    fn plan_input_writes_lone_cr_is_single_chunk() {
        // 빈 본문 + enter: CR 청크 하나뿐 → write_input 에서 지연 없이 전송.
        let chunks = McpHandler::plan_input_writes("", false, true, None);
        assert_eq!(chunks, vec![b"\r".to_vec()]);
    }

    #[test]
    fn plan_input_writes_no_enter_has_no_cr_chunk() {
        // enter=false: 본문만, CR 청크 없음.
        let chunks = McpHandler::plan_input_writes("ls", false, false, None);
        assert_eq!(chunks, vec![b"ls".to_vec()]);
    }

    #[test]
    fn plan_input_writes_empty_no_enter_is_empty() {
        // 본문도 없고 enter도 없으면 write 가 0회.
        let chunks = McpHandler::plan_input_writes("", false, false, None);
        assert!(chunks.is_empty());
    }

    #[test]
    fn plan_input_writes_strips_trailing_newline_keeps_internal() {
        // 후행 개행 제거 + 내부 개행 보존, 그리고 CR은 분리된 청크.
        let chunks = McpHandler::plan_input_writes("a\nb\n", false, true, None);
        assert_eq!(chunks, vec![b"a\nb".to_vec(), b"\r".to_vec()]);
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

    #[test]
    fn dev_only_tool_names_are_registered() {
        let router = McpHandler::tool_router();
        for name in DEV_ONLY_TOOLS {
            assert!(
                router.has_route(name),
                "dev-only tool not registered: {name}"
            );
        }
    }

    #[test]
    fn release_tool_list_hides_dev_only_tools() {
        let router = McpHandler::tool_router();
        let release_tools = McpHandler::visible_tools_from_router(&router, false);
        let release_names: Vec<&str> = release_tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect();

        for name in DEV_ONLY_TOOLS {
            assert!(
                !release_names.contains(name),
                "release MCP list_tools must hide dev-only tool: {name}",
            );
        }
    }

    #[test]
    fn dev_tool_list_includes_dev_only_tools() {
        let router = McpHandler::tool_router();
        let dev_tools = McpHandler::visible_tools_from_router(&router, true);
        let dev_names: Vec<&str> = dev_tools.iter().map(|tool| tool.name.as_ref()).collect();

        for name in DEV_ONLY_TOOLS {
            assert!(
                dev_names.contains(name),
                "dev MCP list_tools must include dev-only tool: {name}",
            );
        }
    }

    #[test]
    fn dev_only_param_types_deserialize() {
        let theme: SetAppThemeParam = serde_json::from_str(r#"{"theme_id":"dracula"}"#).unwrap();
        assert_eq!(theme.theme_id, "dracula");

        let profile: UpdateProfileParam =
            serde_json::from_str(r#"{"index":1,"data":{"cursorBlink":false}}"#).unwrap();
        assert_eq!(profile.index, 1);
        assert_eq!(profile.data["cursorBlink"], false);

        let defaults: SetProfileDefaultsParam =
            serde_json::from_str(r#"{"data":{"font":{"size":15}}}"#).unwrap();
        assert_eq!(defaults.data["font"]["size"], 15);

        let view: SetPaneViewParam =
            serde_json::from_str(r#"{"pane_index":0,"view":{"type":"MemoView"}}"#).unwrap();
        assert_eq!(view.pane_index, 0);
        assert_eq!(view.view["type"], "MemoView");
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

    #[test]
    fn enrich_with_activity_injects_flat_activity_shape() {
        let state = crate::state::AppState::new();
        let terminal_id = "terminal-pane-codex";
        let mut buffer = crate::output_buffer::TerminalOutputBuffer::default();
        buffer.push(b"\x1b]0;OpenAI Codex\x07");
        state
            .output_buffers
            .lock()
            .unwrap()
            .insert(terminal_id.to_string(), buffer);
        state.terminals.lock().unwrap().insert(
            terminal_id.to_string(),
            crate::terminal::TerminalSession::new(
                terminal_id.to_string(),
                crate::terminal::TerminalConfig::default(),
            ),
        );

        let mut items = vec![json!({ "id": terminal_id })];
        McpHandler::enrich_with_activity(&state, &mut items, "id", "activity");

        assert_eq!(
            items[0]["activity"],
            json!({ "type": "interactiveApp", "name": "Codex" }),
            "MCP list_terminals must expose activity directly, not activity.activity"
        );
        assert!(
            items[0]["activity"].get("activity").is_none(),
            "nested activity.activity breaks clients that read the documented shape"
        );
    }
}
