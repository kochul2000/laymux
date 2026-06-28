use serde::{Deserialize, Serialize};

/// Color scheme definition (Windows Terminal compatible).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorScheme {
    pub name: String,
    #[serde(default)]
    pub foreground: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub cursor_color: String,
    #[serde(default)]
    pub selection_background: String,
    #[serde(default)]
    pub black: String,
    #[serde(default)]
    pub red: String,
    #[serde(default)]
    pub green: String,
    #[serde(default)]
    pub yellow: String,
    #[serde(default)]
    pub blue: String,
    #[serde(default)]
    pub purple: String,
    #[serde(default)]
    pub cyan: String,
    #[serde(default)]
    pub white: String,
    #[serde(default)]
    pub bright_black: String,
    #[serde(default)]
    pub bright_red: String,
    #[serde(default)]
    pub bright_green: String,
    #[serde(default)]
    pub bright_yellow: String,
    #[serde(default)]
    pub bright_blue: String,
    #[serde(default)]
    pub bright_purple: String,
    #[serde(default)]
    pub bright_cyan: String,
    #[serde(default)]
    pub bright_white: String,
}

/// Padding settings for terminal profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaddingSettings {
    #[serde(default = "default_padding_val")]
    pub top: u16,
    #[serde(default = "default_padding_val")]
    pub right: u16,
    #[serde(default = "default_padding_val")]
    pub bottom: u16,
    #[serde(default = "default_padding_val")]
    pub left: u16,
}

fn default_padding_val() -> u16 {
    8
}

impl Default for PaddingSettings {
    fn default() -> Self {
        Self {
            top: 8,
            right: 8,
            bottom: 8,
            left: 8,
        }
    }
}

/// Terminal profile (Windows Terminal compatible).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    #[serde(default)]
    pub command_line: String,
    /// Command to run after shell initialization (e.g. "cd ~/project && conda activate myenv").
    #[serde(default)]
    pub startup_command: String,
    #[serde(default)]
    pub color_scheme: String,
    #[serde(default)]
    pub starting_directory: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default = "default_cursor_shape")]
    pub cursor_shape: String,
    #[serde(default)]
    pub padding: PaddingSettings,
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: u32,
    #[serde(default = "default_opacity")]
    pub opacity: u8,
    #[serde(default)]
    pub tab_title: String,
    #[serde(default = "default_bell_style")]
    pub bell_style: String,
    #[serde(default = "default_close_on_exit")]
    pub close_on_exit: String,
    #[serde(default = "default_antialiasing_mode")]
    pub antialiasing_mode: String,
    #[serde(default)]
    pub suppress_application_title: bool,
    #[serde(default = "default_true")]
    pub snap_on_input: bool,
    /// Per-profile font override. When None, inherits from profileDefaults / global default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<FontSettings>,
    /// Whether to restore the last CWD on restart. When None, inherits from profileDefaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_cwd: Option<bool>,
    /// Whether to restore terminal output on restart. When None, inherits from profileDefaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_output: Option<bool>,
    /// CWD sync behavior: "default" or { send: bool, receive: bool }. Opaque to backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_cwd: Option<serde_json::Value>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            name: String::new(),
            command_line: String::new(),
            startup_command: String::new(),
            color_scheme: String::new(),
            starting_directory: String::new(),
            hidden: false,
            cursor_shape: default_cursor_shape(),
            padding: PaddingSettings::default(),
            scrollback_lines: default_scrollback_lines(),
            opacity: default_opacity(),
            tab_title: String::new(),
            bell_style: default_bell_style(),
            close_on_exit: default_close_on_exit(),
            antialiasing_mode: default_antialiasing_mode(),
            suppress_application_title: false,
            snap_on_input: true,
            font: None,
            restore_cwd: None,
            restore_output: None,
            sync_cwd: None,
        }
    }
}

fn default_cursor_shape() -> String {
    "bar".into()
}
fn default_scrollback_lines() -> u32 {
    9001
}
fn default_opacity() -> u8 {
    100
}
fn default_bell_style() -> String {
    "audible".into()
}
fn default_close_on_exit() -> String {
    "automatic".into()
}
fn default_antialiasing_mode() -> String {
    "grayscale".into()
}

/// Keybinding entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Keybinding {
    pub keys: String,
    pub command: String,
}

/// Font settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FontSettings {
    #[serde(default = "default_font_face")]
    pub face: String,
    #[serde(default = "default_font_size")]
    pub size: u16,
    #[serde(default = "default_font_weight")]
    pub weight: String,
}

fn default_font_weight() -> String {
    "normal".into()
}

fn default_font_face() -> String {
    "Cascadia Mono".into()
}

fn default_font_size() -> u16 {
    14
}

impl Default for FontSettings {
    fn default() -> Self {
        Self {
            face: default_font_face(),
            size: default_font_size(),
            weight: default_font_weight(),
        }
    }
}

/// Profile defaults — inheritable settings for all profiles.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDefaults {
    #[serde(default)]
    pub color_scheme: String,
    #[serde(default = "default_cursor_shape")]
    pub cursor_shape: String,
    #[serde(default)]
    pub padding: PaddingSettings,
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: u32,
    #[serde(default = "default_opacity")]
    pub opacity: u8,
    #[serde(default = "default_bell_style")]
    pub bell_style: String,
    #[serde(default = "default_close_on_exit")]
    pub close_on_exit: String,
    #[serde(default = "default_antialiasing_mode")]
    pub antialiasing_mode: String,
    #[serde(default)]
    pub suppress_application_title: bool,
    #[serde(default = "default_true")]
    pub snap_on_input: bool,
    #[serde(default)]
    pub font: FontSettings,
    /// Whether to restore the last CWD on restart.
    #[serde(default = "default_true")]
    pub restore_cwd: bool,
    /// Whether to restore terminal output on restart.
    #[serde(default = "default_true")]
    pub restore_output: bool,
    /// CWD sync behavior: "default" or { send: bool, receive: bool }. Opaque to backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_cwd: Option<serde_json::Value>,
}

impl Default for ProfileDefaults {
    fn default() -> Self {
        Self {
            color_scheme: String::new(),
            cursor_shape: default_cursor_shape(),
            padding: PaddingSettings::default(),
            scrollback_lines: default_scrollback_lines(),
            opacity: default_opacity(),
            bell_style: default_bell_style(),
            close_on_exit: default_close_on_exit(),
            antialiasing_mode: default_antialiasing_mode(),
            suppress_application_title: false,
            snap_on_input: true,
            font: FontSettings::default(),
            restore_cwd: true,
            restore_output: true,
            sync_cwd: None,
        }
    }
}

/// Layout pane definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPane {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub view_type: String,
    /// Full view config (type + profile etc). When present, used instead of bare viewType.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_config: Option<serde_json::Value>,
}

/// Layout definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub panes: Vec<LayoutPane>,
}

/// Workspace pane view config.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspacePaneView {
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

/// Workspace pane definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkspacePane {
    /// Stable pane identifier, persisted across restarts. Empty string means unassigned (migrated).
    #[serde(default)]
    pub id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    pub view: WorkspacePaneView,
}

/// Workspace definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Deprecated — kept for backward compat with old settings.json files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_id: Option<String>,
    pub panes: Vec<WorkspacePane>,
}

/// Claude Code sync-cwd propagation mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum ClaudeSyncCwdMode {
    /// Don't propagate cd when Claude Code is detected (default).
    #[default]
    Skip,
    /// When Claude Code is idle, send `! cd /path` format.
    Command,
}

/// Status message display mode for Claude Code in WorkspaceSelectorView.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum ClaudeStatusMessageMode {
    /// Show only bullet (white-●) message.
    Bullet,
    /// Show only title (spinner text) message.
    Title,
    /// Show title first, then bullet: "title · bullet".
    TitleBullet,
    /// Show bullet first, then title: "bullet · title" (default).
    #[default]
    BulletTitle,
}

/// Claude Code integration settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    #[serde(default)]
    pub sync_cwd: ClaudeSyncCwdMode,
    /// Whether to restore Claude Code sessions on app restart (default: true).
    #[serde(default = "default_restore_session")]
    pub restore_session: bool,
    /// Maximum age (in hours) for Claude session files to be considered valid.
    /// Sessions older than this are ignored during restore. Default: 24 hours.
    /// Set to 0 to disable the age filter (accept all sessions).
    #[serde(default = "default_session_max_age_hours")]
    pub session_max_age_hours: u64,
    /// Status message display mode (default: "bullet-title").
    #[serde(default)]
    pub status_message_mode: ClaudeStatusMessageMode,
    /// Delimiter between bullet and title when both are shown (default: " · ").
    #[serde(default = "default_status_message_delimiter")]
    pub status_message_delimiter: String,
    /// Auto-send a resume message after a session-limit reset (default: true).
    /// See issue #312 — the frontend detects "You've hit your session limit ·
    /// resets <time>" in the terminal output and schedules the resume write.
    #[serde(default = "default_session_limit_auto_resume")]
    pub session_limit_auto_resume: bool,
    /// Seconds to wait after the reset time before resuming (default: 60).
    #[serde(default = "default_session_limit_resume_delay_seconds")]
    pub session_limit_resume_delay_seconds: u64,
    /// Message sent to resume work after the limit resets (default: "go on").
    #[serde(default = "default_session_limit_resume_message")]
    pub session_limit_resume_message: String,
}

impl Default for ClaudeSettings {
    fn default() -> Self {
        Self {
            sync_cwd: ClaudeSyncCwdMode::default(),
            restore_session: true,
            session_max_age_hours: 24,
            status_message_mode: ClaudeStatusMessageMode::default(),
            status_message_delimiter: default_status_message_delimiter(),
            session_limit_auto_resume: true,
            session_limit_resume_delay_seconds: 60,
            session_limit_resume_message: default_session_limit_resume_message(),
        }
    }
}

fn default_session_limit_auto_resume() -> bool {
    true
}

fn default_session_limit_resume_delay_seconds() -> u64 {
    60
}

fn default_session_limit_resume_message() -> String {
    "go on".to_string()
}

fn default_status_message_delimiter() -> String {
    " · ".to_string()
}

fn default_restore_session() -> bool {
    true
}

fn default_session_max_age_hours() -> u64 {
    24
}

/// Status message display mode for Codex in WorkspaceSelectorView.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum CodexStatusMessageMode {
    /// Show only bullet/assistant message.
    Bullet,
    /// Show only title/spinner text.
    Title,
    /// Show title first, then bullet.
    TitleBullet,
    /// Show bullet first, then title (default).
    #[default]
    BulletTitle,
}

/// Codex integration settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexSettings {
    /// Status message display mode (default: "bullet-title").
    #[serde(default)]
    pub status_message_mode: CodexStatusMessageMode,
    /// Delimiter between bullet and title when both are shown (default: " · ").
    #[serde(default = "default_codex_status_message_delimiter")]
    pub status_message_delimiter: String,
}

impl Default for CodexSettings {
    fn default() -> Self {
        Self {
            status_message_mode: CodexStatusMessageMode::default(),
            status_message_delimiter: default_codex_status_message_delimiter(),
        }
    }
}

fn default_codex_status_message_delimiter() -> String {
    " · ".to_string()
}

/// Path ellipsis direction: "start" truncates the beginning, "end" truncates the end.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub enum PathEllipsisMode {
    #[default]
    Start,
    End,
}

fn default_scrollbar_style() -> String {
    "overlay".to_string()
}

// ── Terminal settings ──

fn default_burst_window_ms() -> u64 {
    2000
}
fn default_burst_threshold() -> u64 {
    6
}
fn default_burst_throttle_ms() -> u64 {
    1000
}

/// DEC 2026 burst detection parameters for TUI output activity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputActivityBurstSettings {
    /// Sliding window size (ms) for counting DEC 2026h events.
    #[serde(default = "default_burst_window_ms")]
    pub window_ms: u64,
    /// Minimum events within window to trigger activity.
    #[serde(default = "default_burst_threshold")]
    pub threshold: u64,
    /// Minimum interval (ms) between emitted activity events per terminal.
    #[serde(default = "default_burst_throttle_ms")]
    pub throttle_ms: u64,
}

impl Default for OutputActivityBurstSettings {
    fn default() -> Self {
        Self {
            window_ms: default_burst_window_ms(),
            threshold: default_burst_threshold(),
            throttle_ms: default_burst_throttle_ms(),
        }
    }
}

impl OutputActivityBurstSettings {
    /// Clamp values to safe ranges. Called at usage site to guard against
    /// invalid user input (e.g., threshold=0 or window_ms=0).
    pub fn sanitized(&self) -> Self {
        Self {
            window_ms: self.window_ms.max(100),
            threshold: self.threshold.max(2),
            throttle_ms: self.throttle_ms.max(100),
        }
    }
}

/// Terminal behavior & rendering settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default)]
    pub output_activity_burst: OutputActivityBurstSettings,
    /// Automatically copy text to clipboard when selected in terminal.
    #[serde(default = "default_true")]
    pub copy_on_select: bool,
    /// Terminal scrollbar style: "overlay" (default) or "separate".
    #[serde(default = "default_scrollbar_style")]
    pub scrollbar_style: String,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            output_activity_burst: OutputActivityBurstSettings::default(),
            copy_on_select: true,
            scrollbar_style: default_scrollbar_style(),
        }
    }
}

/// App-wide appearance settings (theme + non-terminal font).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    /// App UI theme id (e.g. "catppuccin-mocha"). Separate from terminal color schemes.
    #[serde(default = "default_app_theme_id")]
    pub theme_id: String,
    /// App-wide default font for non-terminal views (Memo, Issue Reporter, etc.).
    #[serde(default)]
    pub font: FontSettings,
    /// Font family for the app UI chrome (view titles, buttons, lists, workspace
    /// selector, dock). Empty = built-in default stack. Family only — chrome sizes
    /// are token-driven, so size/weight are intentionally not configurable here.
    #[serde(default)]
    pub ui_font_family: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme_id: default_app_theme_id(),
            font: FontSettings::default(),
            ui_font_family: String::new(),
        }
    }
}

/// Paste / clipboard behavior settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteSettings {
    /// Smart paste master toggle.
    #[serde(default = "default_true")]
    pub smart: bool,
    /// Directory for clipboard image pastes. Empty = default temp dir.
    #[serde(default)]
    pub image_dir: String,
    /// Strip common leading whitespace when pasting.
    #[serde(default = "default_true")]
    pub remove_indent: bool,
    /// Rejoin URLs split across lines when pasting.
    #[serde(default = "default_true")]
    pub remove_line_break: bool,
    /// Detect indented multi-line URLs and make them clickable as a single link.
    #[serde(default = "default_true")]
    pub link_join: bool,
    /// Show a confirmation dialog when pasting large text (like Windows Terminal).
    #[serde(default = "default_true")]
    pub large_warning: bool,
    /// Separator token between paths when pasting multiple clipboard files:
    /// "space" (default) | "newline" | "comma" | "semicolon". See issue #325.
    #[serde(default = "default_paste_path_separator")]
    pub path_separator: String,
    /// Wrap each pasted file path in double quotes (useful for paths with spaces). See issue #325.
    #[serde(default)]
    pub path_quote: bool,
}

fn default_paste_path_separator() -> String {
    "space".to_string()
}

impl Default for PasteSettings {
    fn default() -> Self {
        Self {
            smart: true,
            image_dir: String::new(),
            remove_indent: true,
            remove_line_break: true,
            link_join: true,
            large_warning: true,
            path_separator: default_paste_path_separator(),
            path_quote: false,
        }
    }
}

/// Pane control bar settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlBarSettings {
    /// Seconds of mouse inactivity before hiding the pane control bar. 0 = never hide.
    #[serde(default = "default_hover_idle_seconds")]
    pub hover_idle_seconds: u64,
    /// Default control bar mode for new panes: "hover" | "pinned" | "minimized".
    #[serde(default = "default_control_bar_mode")]
    pub default_mode: String,
}

fn default_hover_idle_seconds() -> u64 {
    2
}

fn default_control_bar_mode() -> String {
    "minimized".to_string()
}

impl Default for ControlBarSettings {
    fn default() -> Self {
        Self {
            hover_idle_seconds: default_hover_idle_seconds(),
            default_mode: default_control_bar_mode(),
        }
    }
}

/// Dock behavior settings (distinct from the structural `docks` array).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockSettings {
    /// Keep dock state in background when hidden.
    #[serde(default = "default_true")]
    pub persist_state: bool,
    /// Allow Alt+Arrow to navigate into/out of dock areas.
    #[serde(default = "default_true")]
    pub arrow_nav: bool,
    /// When switching workspaces by keyboard arrow while a dock is focused,
    /// automatically hand focus to a workspace pane. See #311.
    #[serde(default = "default_true")]
    pub arrow_focus_pane: bool,
}

impl Default for DockSettings {
    fn default() -> Self {
        Self {
            persist_state: true,
            arrow_nav: true,
            arrow_focus_pane: true,
        }
    }
}

/// Notification behavior settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// When to auto-dismiss notifications as read:
    /// "workspace" (default) | "paneFocus" | "manual".
    #[serde(default = "default_notification_dismiss")]
    pub dismiss: String,
}

fn default_notification_dismiss() -> String {
    "workspace".to_string()
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            dismiss: default_notification_dismiss(),
        }
    }
}

/// Which elements to display in WorkspaceSelectorView pane rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDisplaySettings {
    #[serde(default = "default_true")]
    pub minimap: bool,
    #[serde(default = "default_true")]
    pub environment: bool,
    #[serde(default = "default_true")]
    pub activity: bool,
    #[serde(default = "default_true")]
    pub path: bool,
    #[serde(default = "default_true")]
    pub result: bool,
}

impl Default for WorkspaceDisplaySettings {
    fn default() -> Self {
        Self {
            minimap: true,
            environment: true,
            activity: true,
            path: true,
            result: true,
        }
    }
}

/// WorkspaceSelectorView settings (display toggles, sort order, lifecycle).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSelectorSettings {
    /// Display toggles for pane rows.
    #[serde(default)]
    pub display: WorkspaceDisplaySettings,
    /// Workspace sort mode: "manual" (default) | "notification".
    #[serde(default = "default_workspace_sort_order")]
    pub sort_order: String,
    /// Path ellipsis direction. "start" (default) shows the end of the path.
    #[serde(default)]
    pub path_ellipsis: PathEllipsisMode,
    /// Seconds a pane/workspace must stay hidden (in hide mode) before its terminal (PTY)
    /// is automatically closed to save resources. 0 = disabled. See issue #269.
    #[serde(default)]
    pub hidden_auto_close_seconds: u64,
}

fn default_workspace_sort_order() -> String {
    "manual".to_string()
}

impl Default for WorkspaceSelectorSettings {
    fn default() -> Self {
        Self {
            display: WorkspaceDisplaySettings::default(),
            sort_order: default_workspace_sort_order(),
            path_ellipsis: PathEllipsisMode::default(),
            hidden_auto_close_seconds: 0,
        }
    }
}

fn default_view_padding() -> u32 {
    8
}

fn default_view_font_size() -> u16 {
    13
}

/// Issue reporter settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueReporterSettings {
    /// Shell prefix for running gh commands.
    /// When set, gh is invoked as: `{shell_parts...} gh {args...}`
    /// Example: "wsl.exe -d Ubuntu --"
    /// When empty (default), gh is invoked directly.
    #[serde(default)]
    pub shell: String,
    #[serde(default = "default_view_padding")]
    pub padding_top: u32,
    #[serde(default = "default_view_padding")]
    pub padding_right: u32,
    #[serde(default = "default_view_padding")]
    pub padding_bottom: u32,
    #[serde(default = "default_view_padding")]
    pub padding_left: u32,
    /// Font family override. Empty string = inherit from app_font.
    #[serde(default)]
    pub font_family: String,
    /// Font size override. 0 = inherit from app_font.
    #[serde(default = "default_view_font_size")]
    pub font_size: u16,
    /// Font weight override. Empty string = inherit from app_font.
    #[serde(default)]
    pub font_weight: String,
    /// Repository list for the issue reporter. Each entry is an "owner/repo" string.
    /// The first entry is the default selection in the Report Issue view.
    /// When empty, the repo is auto-detected from the current working directory.
    #[serde(default)]
    pub repositories: Vec<String>,
}

impl Default for IssueReporterSettings {
    fn default() -> Self {
        Self {
            shell: String::new(),
            padding_top: 8,
            padding_right: 8,
            padding_bottom: 8,
            padding_left: 8,
            font_family: String::new(),
            font_size: 13,
            font_weight: String::new(),
            // Default to the laymux repo so issues land in the right place out of the box.
            repositories: vec!["kochul2000/laymux".to_string()],
        }
    }
}

/// Paragraph copy feature settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoParagraphCopySettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_min_blank_lines")]
    pub min_blank_lines: u32,
}

fn default_min_blank_lines() -> u32 {
    2
}

impl Default for MemoParagraphCopySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            min_blank_lines: 2,
        }
    }
}

/// MemoView settings (padding, copy features, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoSettings {
    #[serde(default = "default_view_padding")]
    pub padding_top: u32,
    #[serde(default = "default_view_padding")]
    pub padding_right: u32,
    #[serde(default = "default_view_padding")]
    pub padding_bottom: u32,
    #[serde(default = "default_view_padding")]
    pub padding_left: u32,
    /// Paragraph copy: show copy button on hover for paragraphs separated by N+ blank lines.
    #[serde(default)]
    pub paragraph_copy: MemoParagraphCopySettings,
    /// Automatically copy selected text to clipboard (like terminal copyOnSelect).
    #[serde(default = "default_true")]
    pub copy_on_select: bool,
    /// Triple-click to select entire paragraph (requires paragraph_copy enabled).
    #[serde(default = "default_true", alias = "dblClickParagraphSelect")]
    pub triple_click_paragraph_select: bool,
    /// Tab indent size (number of spaces). Default: 2.
    #[serde(default = "default_indent_size")]
    pub indent_size: u32,
    /// Font family override. Empty string = inherit from app_font.
    #[serde(default)]
    pub font_family: String,
    /// Font size override. 0 = inherit from app_font.
    #[serde(default = "default_view_font_size")]
    pub font_size: u16,
    /// Font weight override. Empty string = inherit from app_font.
    #[serde(default)]
    pub font_weight: String,
}

fn default_indent_size() -> u32 {
    2
}

impl Default for MemoSettings {
    fn default() -> Self {
        Self {
            padding_top: 8,
            padding_right: 8,
            padding_bottom: 8,
            padding_left: 8,
            paragraph_copy: MemoParagraphCopySettings::default(),
            copy_on_select: true,
            triple_click_paragraph_select: true,
            indent_size: 2,
            font_family: String::new(),
            font_size: 13,
            font_weight: String::new(),
        }
    }
}

/// File extension → shell command viewer mapping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionViewer {
    pub extensions: Vec<String>,
    pub command: String,
}

/// FileExplorerView settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileExplorerSettings {
    /// Shell profile name for background shell. Empty = use defaultProfile.
    #[serde(default)]
    pub shell_profile: String,
    #[serde(default = "default_view_padding")]
    pub padding_top: u32,
    #[serde(default = "default_view_padding")]
    pub padding_right: u32,
    #[serde(default = "default_view_padding")]
    pub padding_bottom: u32,
    #[serde(default = "default_view_padding")]
    pub padding_left: u32,
    /// Font family. Empty string = inherit.
    #[serde(default)]
    pub font_family: String,
    /// Font size.
    #[serde(default = "default_view_font_size")]
    pub font_size: u16,
    /// Automatically copy selected file paths to clipboard.
    #[serde(default)]
    pub copy_on_select: bool,
    /// Per-extension shell program viewers.
    #[serde(default)]
    pub extension_viewers: Vec<ExtensionViewer>,
}

impl Default for FileExplorerSettings {
    fn default() -> Self {
        Self {
            shell_profile: String::new(),
            padding_top: 8,
            padding_right: 8,
            padding_bottom: 8,
            padding_left: 8,
            font_family: String::new(),
            font_size: 13,
            copy_on_select: false,
            extension_viewers: Vec::new(),
        }
    }
}

/// Direct Remote Mode server settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    /// User-facing browser remote API/UI switch. Defaults off.
    #[serde(default)]
    pub enabled: bool,
    /// Reserved for the standalone remote listener; the current server shares
    /// the Automation API listener.
    #[serde(default = "default_remote_bind_address")]
    pub bind_address: String,
    /// Exact Origin values allowed for browser requests. Empty = no Origin filter.
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// IP/CIDR allowlist for remote clients. Add 100.64.0.0/10 for Tailscale.
    #[serde(default = "default_remote_allowed_ips")]
    pub allowed_ips: Vec<String>,
    /// Bearer token for remote browser clients. Required when remote is enabled.
    #[serde(default)]
    pub auth_token: String,
    /// Seconds before an inactive remote controller lease expires.
    #[serde(default = "default_remote_heartbeat_timeout_seconds")]
    pub heartbeat_timeout_seconds: u64,
}

fn default_remote_bind_address() -> String {
    "0.0.0.0".into()
}

fn default_remote_allowed_ips() -> Vec<String> {
    vec!["127.0.0.1/32".into(), "::1/128".into()]
}

fn default_remote_heartbeat_timeout_seconds() -> u64 {
    15
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            bind_address: default_remote_bind_address(),
            allowed_origins: Vec::new(),
            allowed_ips: default_remote_allowed_ips(),
            auth_token: String::new(),
            heartbeat_timeout_seconds: default_remote_heartbeat_timeout_seconds(),
        }
    }
}

/// Dock pane definition (persisted view config with position).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockPaneSetting {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub view: serde_json::Value,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "default_one")]
    pub w: f64,
    #[serde(default = "default_one")]
    pub h: f64,
}

fn default_one() -> f64 {
    1.0
}

/// Dock configuration in settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockSetting {
    pub position: String,
    #[serde(default)]
    pub active_view: Option<String>,
    #[serde(default)]
    pub views: Vec<String>,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default = "default_dock_size")]
    pub size: f64,
    #[serde(default)]
    pub panes: Vec<DockPaneSetting>,
}

fn default_dock_size() -> f64 {
    240.0
}

fn default_true() -> bool {
    true
}

/// Root settings structure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// App UI language: "system" (OS locale), "ko", or "en". Opaque to the
    /// backend — resolved on the frontend. `#[serde(default)]` keeps existing
    /// settings.json (without this key) parsing cleanly.
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub color_schemes: Vec<ColorScheme>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub keybindings: Vec<Keybinding>,
    #[serde(default = "default_profile")]
    pub default_profile: String,
    #[serde(default)]
    pub profile_defaults: ProfileDefaults,
    #[serde(default)]
    pub view_order: Vec<String>,
    /// App-wide appearance (theme + non-terminal font).
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub layouts: Vec<Layout>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub docks: Vec<DockSetting>,
    #[serde(default)]
    pub terminal: TerminalSettings,
    #[serde(default)]
    pub paste: PasteSettings,
    #[serde(default)]
    pub control_bar: ControlBarSettings,
    /// Dock behavior settings (distinct from the structural `docks` array).
    #[serde(default)]
    pub dock: DockSettings,
    #[serde(default)]
    pub notifications: NotificationSettings,
    #[serde(default)]
    pub workspace_selector: WorkspaceSelectorSettings,
    #[serde(default)]
    pub claude: ClaudeSettings,
    #[serde(default)]
    pub codex: CodexSettings,
    #[serde(default)]
    pub memo: MemoSettings,
    #[serde(default)]
    pub issue_reporter: IssueReporterSettings,
    #[serde(default)]
    pub file_explorer: FileExplorerSettings,
    #[serde(default)]
    pub remote: RemoteSettings,
    /// Location-based CWD sync defaults. Opaque to backend — passed through to frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_cwd_defaults: Option<serde_json::Value>,
    /// User-defined workspace display order (drag-and-drop). Opaque to backend.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_display_order: Vec<String>,
}

fn default_app_theme_id() -> String {
    "catppuccin-mocha".into()
}

fn default_profile() -> String {
    "PowerShell".into()
}

fn default_language() -> String {
    "system".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: default_language(),
            color_schemes: Vec::new(),
            profiles: vec![
                Profile {
                    name: "PowerShell".into(),
                    command_line: "powershell.exe -NoLogo".into(),
                    ..Profile::default()
                },
                Profile {
                    name: "WSL".into(),
                    command_line: "wsl.exe".into(),
                    ..Profile::default()
                },
            ],
            keybindings: Vec::new(),
            default_profile: default_profile(),
            profile_defaults: ProfileDefaults::default(),
            view_order: Vec::new(),
            appearance: AppearanceSettings::default(),
            layouts: vec![Layout {
                id: "default-layout".into(),
                name: "Default".into(),
                panes: vec![LayoutPane {
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                    view_type: "TerminalView".into(),
                    view_config: None,
                }],
            }],
            workspaces: vec![Workspace {
                id: "ws-default".into(),
                name: "Default".into(),
                layout_id: None,
                panes: vec![WorkspacePane {
                    id: format!("pane-{}", &uuid::Uuid::new_v4().to_string()[..8]),
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                    view: WorkspacePaneView {
                        view_type: "TerminalView".into(),
                        extra: serde_json::json!({"profile": "PowerShell", "syncGroup": "Default"}),
                    },
                }],
            }],
            docks: vec![DockSetting {
                position: "left".into(),
                active_view: Some("WorkspaceSelectorView".into()),
                views: vec!["WorkspaceSelectorView".into()],
                visible: true,
                size: default_dock_size(),
                panes: Vec::new(),
            }],
            terminal: TerminalSettings::default(),
            paste: PasteSettings::default(),
            control_bar: ControlBarSettings::default(),
            dock: DockSettings::default(),
            notifications: NotificationSettings::default(),
            workspace_selector: WorkspaceSelectorSettings::default(),
            claude: ClaudeSettings::default(),
            codex: CodexSettings::default(),
            memo: MemoSettings::default(),
            issue_reporter: IssueReporterSettings::default(),
            file_explorer: FileExplorerSettings::default(),
            remote: RemoteSettings::default(),
            sync_cwd_defaults: None,
            workspace_display_order: Vec::new(),
        }
    }
}
