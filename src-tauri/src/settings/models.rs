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
}

impl Default for ClaudeSettings {
    fn default() -> Self {
        Self {
            sync_cwd: ClaudeSyncCwdMode::default(),
            restore_session: true,
            session_max_age_hours: 24,
        }
    }
}

fn default_restore_session() -> bool {
    true
}

fn default_session_max_age_hours() -> u64 {
    24
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

/// Convenience feature settings (smart paste, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConvenienceSettings {
    #[serde(default = "default_true")]
    pub smart_paste: bool,
    #[serde(default)]
    pub paste_image_dir: String,
    /// Automatically copy text to clipboard when selected in terminal.
    #[serde(default = "default_true")]
    pub copy_on_select: bool,
    /// Path ellipsis direction in workspace selector. "start" (default) shows the end of the path.
    #[serde(default)]
    pub path_ellipsis: PathEllipsisMode,
    /// Terminal scrollbar style: "overlay" (default) or "separate".
    #[serde(default = "default_scrollbar_style")]
    pub scrollbar_style: String,
    /// Keep dock state in background when hidden.
    #[serde(default = "default_true")]
    pub dock_persist_state: bool,
    /// Allow Alt+Arrow to navigate into/out of dock areas.
    #[serde(default = "default_true")]
    pub dock_arrow_nav: bool,
    /// Smart remove indent: strip common leading whitespace when pasting.
    #[serde(default = "default_true")]
    pub smart_remove_indent: bool,
    /// Smart remove line break: rejoin URLs split across lines when pasting.
    #[serde(default = "default_true")]
    pub smart_remove_line_break: bool,
    /// Show a confirmation dialog when pasting large text (like Windows Terminal).
    #[serde(default = "default_true")]
    pub large_paste_warning: bool,
}

impl Default for ConvenienceSettings {
    fn default() -> Self {
        Self {
            smart_paste: true,
            paste_image_dir: String::new(),
            copy_on_select: true,
            path_ellipsis: PathEllipsisMode::default(),
            scrollbar_style: "overlay".to_string(),
            dock_persist_state: true,
            dock_arrow_nav: true,
            smart_remove_indent: true,
            smart_remove_line_break: true,
            large_paste_warning: true,
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
    #[serde(default)]
    pub copy_on_select: bool,
    /// Double-click to select entire paragraph (requires paragraph_copy enabled).
    #[serde(default = "default_true")]
    pub dbl_click_paragraph_select: bool,
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

impl Default for MemoSettings {
    fn default() -> Self {
        Self {
            padding_top: 8,
            padding_right: 8,
            padding_bottom: 8,
            padding_left: 8,
            paragraph_copy: MemoParagraphCopySettings::default(),
            copy_on_select: false,
            dbl_click_paragraph_select: true,
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
    #[serde(default)]
    pub color_schemes: Vec<ColorScheme>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub keybindings: Vec<Keybinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<FontSettings>,
    /// App-wide default font for non-terminal views (Memo, Issue Reporter, etc.).
    #[serde(default)]
    pub app_font: FontSettings,
    #[serde(default = "default_profile")]
    pub default_profile: String,
    #[serde(default)]
    pub profile_defaults: ProfileDefaults,
    #[serde(default)]
    pub view_order: Vec<String>,
    #[serde(default = "default_app_theme_id")]
    pub app_theme_id: String,
    #[serde(default)]
    pub layouts: Vec<Layout>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub docks: Vec<DockSetting>,
    #[serde(default)]
    pub convenience: ConvenienceSettings,
    #[serde(default)]
    pub claude: ClaudeSettings,
    #[serde(default)]
    pub memo: MemoSettings,
    #[serde(default)]
    pub issue_reporter: IssueReporterSettings,
    #[serde(default)]
    pub file_explorer: FileExplorerSettings,
    /// Location-based CWD sync defaults. Opaque to backend — passed through to frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_cwd_defaults: Option<serde_json::Value>,
    /// User-defined workspace display order (drag-and-drop). Opaque to backend.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_display_order: Vec<String>,
    /// Workspace sort mode ("manual" | "notification"). Opaque to backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_sort_order: Option<String>,
    /// Workspace display toggles (minimap, environment, etc.). Opaque to backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_display: Option<serde_json::Value>,
}

fn default_app_theme_id() -> String {
    "catppuccin-mocha".into()
}

fn default_profile() -> String {
    "PowerShell".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
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
            font: None,
            app_font: FontSettings::default(),
            default_profile: default_profile(),
            profile_defaults: ProfileDefaults::default(),
            view_order: Vec::new(),
            app_theme_id: default_app_theme_id(),
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
            convenience: ConvenienceSettings::default(),
            claude: ClaudeSettings::default(),
            memo: MemoSettings::default(),
            issue_reporter: IssueReporterSettings::default(),
            file_explorer: FileExplorerSettings::default(),
            sync_cwd_defaults: None,
            workspace_display_order: Vec::new(),
            workspace_sort_order: None,
            workspace_display: None,
        }
    }
}
