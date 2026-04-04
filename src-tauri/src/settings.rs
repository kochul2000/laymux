use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static MEMO_LOCK: Mutex<()> = Mutex::new(());

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
    /// Font family for issue reporter textarea. Empty string = inherit.
    #[serde(default)]
    pub font_family: String,
    /// Font size for issue reporter textarea.
    #[serde(default = "default_view_font_size")]
    pub font_size: u16,
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
    /// Font family for memo textarea. Empty string = inherit.
    #[serde(default)]
    pub font_family: String,
    /// Font size for memo textarea.
    #[serde(default = "default_view_font_size")]
    pub font_size: u16,
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

/// ExplorerView settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerSettings {
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

impl Default for ExplorerSettings {
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
    pub explorer: ExplorerSettings,
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
            explorer: ExplorerSettings::default(),
            sync_cwd_defaults: None,
            workspace_display_order: Vec::new(),
            workspace_sort_order: None,
            workspace_display: None,
        }
    }
}

/// Get the settings file path.
pub fn settings_path() -> PathBuf {
    // Use app-local data directory, fallback to current dir
    let base = dirs_config_path().unwrap_or_else(|| PathBuf::from("."));
    base.join("settings.json")
}

pub(crate) fn dirs_config_path() -> Option<PathBuf> {
    let dir_name = if cfg!(debug_assertions) {
        "laymux-dev"
    } else {
        "laymux"
    };
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join(dir_name))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(|p| PathBuf::from(p).join(".config").join(dir_name))
    }
}

/// Load settings from disk. Returns default settings if file doesn't exist.
/// Applies migrations for removed features (e.g., CMD profile → PowerShell).
pub fn load_settings() -> Settings {
    let path = settings_path();
    let mut settings = match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    migrate_settings(&mut settings);
    settings
}

/// Apply settings migrations:
/// - Replace CMD profile references with PowerShell in workspace panes
/// - Remove CMD from profile list
/// - Deduplicate workspace names
fn migrate_settings(settings: &mut Settings) {
    // Migrate CMD → PowerShell in workspace pane views
    for ws in &mut settings.workspaces {
        for pane in &mut ws.panes {
            if let Some(profile) = pane.view.extra.get("profile").and_then(|v| v.as_str()) {
                if profile.eq_ignore_ascii_case("cmd") {
                    if let Some(obj) = pane.view.extra.as_object_mut() {
                        obj.insert("profile".into(), serde_json::json!("PowerShell"));
                    }
                }
            }
        }
    }

    // Remove CMD from profiles list
    settings
        .profiles
        .retain(|p| !p.name.eq_ignore_ascii_case("cmd"));

    // Assign stable IDs to workspace panes that don't have one
    for ws in &mut settings.workspaces {
        for pane in &mut ws.panes {
            if pane.id.is_empty() {
                pane.id = format!("pane-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            }
        }
    }

    // Assign stable IDs to dock panes that don't have one
    for dock in &mut settings.docks {
        for pane in &mut dock.panes {
            if pane.id.is_empty() {
                pane.id = format!("pane-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            }
        }
    }

    // Deduplicate workspace names
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for ws in &mut settings.workspaces {
        let base = ws.name.clone();
        if !seen_names.insert(ws.name.clone()) {
            // Name already used — append suffix
            let mut n = 2;
            loop {
                let candidate = format!("{base} ({n})");
                if seen_names.insert(candidate.clone()) {
                    ws.name = candidate;
                    break;
                }
                n += 1;
            }
        }
    }
}

/// Get the cache directory path.
/// Windows: %APPDATA%/laymux/cache/
/// Linux: ~/.config/laymux/cache/
pub fn cache_dir_path() -> Option<PathBuf> {
    dirs_config_path().map(|p| p.join("cache"))
}

/// Get the memo file path (inside cache/ directory).
/// Returns: <config_dir>/cache/memo.json
pub fn memo_path() -> PathBuf {
    cache_dir_path()
        .unwrap_or_else(|| PathBuf::from("cache"))
        .join("memo.json")
}

/// Load memo content for a specific key. Returns empty string if key or file doesn't exist.
pub fn load_memo(key: &str) -> String {
    let _guard = MEMO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_memo_from(&memo_path(), key)
}

/// Save memo content for a specific key.
pub fn save_memo(key: &str, content: &str) -> Result<(), String> {
    let _guard = MEMO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_memo_to(&memo_path(), key, content)
}

fn load_memo_from(path: &PathBuf, key: &str) -> String {
    let map = match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<std::collections::HashMap<String, String>>(&content)
            .unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    };
    map.get(key).cloned().unwrap_or_default()
}

fn save_memo_to(path: &PathBuf, key: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let mut map = match fs::read_to_string(path) {
        Ok(data) => serde_json::from_str::<std::collections::HashMap<String, String>>(&data)
            .unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    };
    if content.is_empty() {
        map.remove(key);
    } else {
        map.insert(key.to_string(), content.to_string());
    }
    let json = serde_json::to_string_pretty(&map).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Write error: {e}"))
}

/// Save settings to disk.
pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_has_profiles() {
        let settings = Settings::default();
        assert_eq!(settings.profiles.len(), 2);
        assert_eq!(settings.profiles[0].name, "PowerShell");
        assert_eq!(settings.profiles[1].name, "WSL");
    }

    #[test]
    fn default_issue_reporter_settings() {
        let settings = Settings::default();
        assert_eq!(settings.issue_reporter.shell, "");
    }

    #[test]
    fn issue_reporter_deserializes_from_json() {
        let json = r#"{"issueReporter": {"shell": "wsl.exe -d Ubuntu --"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.issue_reporter.shell, "wsl.exe -d Ubuntu --");
    }

    #[test]
    fn issue_reporter_defaults_when_absent() {
        let json = r#"{}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.issue_reporter.shell, "");
    }

    #[test]
    fn memo_font_settings_default() {
        let settings = Settings::default();
        assert_eq!(settings.memo.font_family, "");
        assert_eq!(settings.memo.font_size, 13);
    }

    #[test]
    fn memo_font_settings_deserialize() {
        let json = r#"{"memo": {"fontFamily": "Consolas", "fontSize": 16}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.memo.font_family, "Consolas");
        assert_eq!(settings.memo.font_size, 16);
    }

    #[test]
    fn memo_font_settings_default_when_absent() {
        let json = r#"{"memo": {"paddingTop": 4}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.memo.font_family, "");
        assert_eq!(settings.memo.font_size, 13);
    }

    #[test]
    fn issue_reporter_font_settings_default() {
        let settings = Settings::default();
        assert_eq!(settings.issue_reporter.font_family, "");
        assert_eq!(settings.issue_reporter.font_size, 13);
    }

    #[test]
    fn issue_reporter_font_settings_deserialize() {
        let json = r#"{"issueReporter": {"fontFamily": "Monaco", "fontSize": 14}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.issue_reporter.font_family, "Monaco");
        assert_eq!(settings.issue_reporter.font_size, 14);
    }

    #[test]
    fn issue_reporter_font_settings_default_when_absent() {
        let json = r#"{"issueReporter": {"shell": "wsl"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.issue_reporter.font_family, "");
        assert_eq!(settings.issue_reporter.font_size, 13);
    }

    #[test]
    fn default_settings_has_layout_and_workspace() {
        let settings = Settings::default();
        assert_eq!(settings.layouts.len(), 1);
        assert_eq!(settings.workspaces.len(), 1);
        assert_eq!(settings.workspaces[0].layout_id, None);
    }

    #[test]
    fn default_font_settings() {
        // Root-level font is now None; per-profile font is also None by default
        let settings = Settings::default();
        assert!(settings.font.is_none());
        // FontSettings default values are still correct
        let font = FontSettings::default();
        assert_eq!(font.face, "Cascadia Mono");
        assert_eq!(font.size, 14);
    }

    #[test]
    fn serialize_deserialize_round_trip() {
        let settings = Settings::default();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings, parsed);
    }

    #[test]
    fn deserialize_partial_settings() {
        // Root-level font is parsed as legacy (backward compat)
        let json = r#"{"font": {"face": "Fira Code", "size": 16}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        let font = settings.font.as_ref().unwrap();
        assert_eq!(font.face, "Fira Code");
        assert_eq!(font.size, 16);
        // Defaults fill in
        assert_eq!(settings.default_profile, "PowerShell");
    }

    #[test]
    fn deserialize_windows_terminal_compatible() {
        let json = r##"{
            "profiles": [
                {"name": "Ubuntu", "commandLine": "wsl.exe -d Ubuntu", "colorScheme": "One Dark", "startingDirectory": "~", "hidden": false}
            ],
            "colorSchemes": [
                {"name": "One Dark", "foreground": "#ABB2BF", "background": "#282C34", "cursorColor": "#528BFF"}
            ]
        }"##;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.profiles[0].name, "Ubuntu");
        assert_eq!(settings.profiles[0].command_line, "wsl.exe -d Ubuntu");
        assert_eq!(settings.color_schemes[0].name, "One Dark");
        assert_eq!(settings.color_schemes[0].foreground, "#ABB2BF");
    }

    #[test]
    fn save_and_load_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let settings = Settings::default();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        fs::write(&path, &json).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let loaded: Settings = serde_json::from_str(&content).unwrap();
        assert_eq!(settings, loaded);
    }

    #[test]
    fn dock_settings_default() {
        let settings = Settings::default();
        assert_eq!(settings.docks.len(), 1);
        assert_eq!(settings.docks[0].position, "left");
        assert_eq!(
            settings.docks[0].active_view,
            Some("WorkspaceSelectorView".into())
        );
    }

    #[test]
    fn profile_new_fields_default() {
        let profile = Profile::default();
        assert_eq!(profile.cursor_shape, "bar");
        assert_eq!(
            profile.padding,
            PaddingSettings {
                top: 8,
                right: 8,
                bottom: 8,
                left: 8
            }
        );
        assert_eq!(profile.scrollback_lines, 9001);
        assert_eq!(profile.opacity, 100);
        assert_eq!(profile.tab_title, "");
        assert_eq!(profile.bell_style, "audible");
        assert_eq!(profile.close_on_exit, "automatic");
        assert_eq!(profile.antialiasing_mode, "grayscale");
        assert!(!profile.suppress_application_title);
        assert!(profile.snap_on_input);
    }

    #[test]
    fn font_weight_default() {
        let font = FontSettings::default();
        assert_eq!(font.weight, "normal");
    }

    #[test]
    fn deserialize_profile_backwards_compat() {
        // Old-style profile with only 5 fields should still parse; new fields get defaults
        let json = r#"{"name": "Test", "commandLine": "bash", "colorScheme": "", "startingDirectory": "", "hidden": false}"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.name, "Test");
        assert_eq!(profile.cursor_shape, "bar");
        assert_eq!(profile.scrollback_lines, 9001);
        assert_eq!(profile.opacity, 100);
        assert_eq!(profile.bell_style, "audible");
        assert!(profile.snap_on_input);
    }

    #[test]
    fn deserialize_profile_with_new_fields() {
        let json = r#"{
            "name": "Custom",
            "commandLine": "zsh",
            "cursorShape": "filledBox",
            "padding": {"top": 4, "right": 4, "bottom": 4, "left": 4},
            "scrollbackLines": 5000,
            "opacity": 80,
            "tabTitle": "Dev",
            "bellStyle": "none",
            "closeOnExit": "always",
            "antialiasingMode": "cleartype",
            "suppressApplicationTitle": true,
            "snapOnInput": false
        }"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.cursor_shape, "filledBox");
        assert_eq!(profile.padding.top, 4);
        assert_eq!(profile.scrollback_lines, 5000);
        assert_eq!(profile.opacity, 80);
        assert_eq!(profile.tab_title, "Dev");
        assert_eq!(profile.bell_style, "none");
        assert_eq!(profile.close_on_exit, "always");
        assert_eq!(profile.antialiasing_mode, "cleartype");
        assert!(profile.suppress_application_title);
        assert!(!profile.snap_on_input);
    }

    #[test]
    fn convenience_settings_default() {
        let settings = Settings::default();
        assert!(settings.convenience.smart_paste);
        assert_eq!(settings.convenience.paste_image_dir, "");
        assert!(settings.convenience.copy_on_select);
        assert_eq!(settings.convenience.path_ellipsis, PathEllipsisMode::Start);
    }

    #[test]
    fn convenience_settings_deserialize() {
        let json = r#"{"convenience": {"smartPaste": false, "pasteImageDir": "C:\\temp\\images"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(!settings.convenience.smart_paste);
        assert_eq!(settings.convenience.paste_image_dir, "C:\\temp\\images");
    }

    #[test]
    fn path_ellipsis_deserialize() {
        let json = r#"{"convenience": {"pathEllipsis": "end"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.convenience.path_ellipsis, PathEllipsisMode::End);
    }

    #[test]
    fn path_ellipsis_defaults_start_when_missing() {
        let json = r#"{"convenience": {"smartPaste": true}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.convenience.path_ellipsis, PathEllipsisMode::Start);
    }

    #[test]
    fn copy_on_select_deserialize() {
        let json = r#"{"convenience": {"copyOnSelect": true}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.convenience.copy_on_select);
    }

    #[test]
    fn copy_on_select_defaults_true_when_missing() {
        let json = r#"{"convenience": {"smartPaste": true}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.convenience.copy_on_select);
    }

    #[test]
    fn convenience_settings_backwards_compat_missing() {
        // Old settings without convenience section should still parse
        let json = r#"{"font": {"face": "Fira Code", "size": 16}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.convenience.smart_paste);
        assert_eq!(settings.convenience.paste_image_dir, "");
    }

    #[test]
    fn scrollbar_style_default_is_overlay() {
        let settings = Settings::default();
        assert_eq!(settings.convenience.scrollbar_style, "overlay");
    }

    #[test]
    fn scrollbar_style_deserialize_separate() {
        let json = r#"{"convenience": {"scrollbarStyle": "separate"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.convenience.scrollbar_style, "separate");
    }

    #[test]
    fn scrollbar_style_deserialize_overlay() {
        let json = r#"{"convenience": {"scrollbarStyle": "overlay"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.convenience.scrollbar_style, "overlay");
    }

    #[test]
    fn scrollbar_style_defaults_to_overlay_when_missing() {
        let json = r#"{"convenience": {"smartPaste": true}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.convenience.scrollbar_style, "overlay");
    }

    #[test]
    fn scrollbar_style_serialize_roundtrip() {
        let mut settings = Settings::default();
        settings.convenience.scrollbar_style = "separate".to_string();
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.convenience.scrollbar_style, "separate");
    }

    #[test]
    fn claude_settings_default() {
        let settings = Settings::default();
        assert_eq!(settings.claude.sync_cwd, ClaudeSyncCwdMode::Skip);
    }

    #[test]
    fn claude_settings_deserialize_skip() {
        let json = r#"{"claude": {"syncCwd": "skip"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.claude.sync_cwd, ClaudeSyncCwdMode::Skip);
    }

    #[test]
    fn claude_settings_deserialize_command() {
        let json = r#"{"claude": {"syncCwd": "command"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.claude.sync_cwd, ClaudeSyncCwdMode::Command);
    }

    #[test]
    fn claude_settings_missing_defaults_to_skip() {
        let json = r#"{"font": {"face": "Fira Code", "size": 16}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.claude.sync_cwd, ClaudeSyncCwdMode::Skip);
    }

    #[test]
    fn claude_settings_round_trip() {
        let settings = Settings {
            claude: ClaudeSettings {
                sync_cwd: ClaudeSyncCwdMode::Command,
                restore_session: true,
                session_max_age_hours: 24,
            },
            ..Settings::default()
        };
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.claude.sync_cwd, ClaudeSyncCwdMode::Command);
        assert!(parsed.claude.restore_session);
        assert_eq!(parsed.claude.session_max_age_hours, 24);
    }

    #[test]
    fn claude_restore_session_defaults_to_true() {
        // When restoreSession is not specified in JSON, it should default to true
        let json = r#"{"claude":{"syncCwd":"skip"}}"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert!(parsed.claude.restore_session);
    }

    #[test]
    fn claude_restore_session_can_be_false() {
        let json = r#"{"claude":{"syncCwd":"skip","restoreSession":false}}"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert!(!parsed.claude.restore_session);
    }

    #[test]
    fn claude_session_max_age_defaults_to_24() {
        let json = r#"{"claude":{"syncCwd":"skip"}}"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.claude.session_max_age_hours, 24);
    }

    #[test]
    fn claude_session_max_age_can_be_customized() {
        let json = r#"{"claude":{"syncCwd":"skip","sessionMaxAgeHours":48}}"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.claude.session_max_age_hours, 48);
    }

    #[test]
    fn claude_session_max_age_zero_means_no_limit() {
        let json = r#"{"claude":{"syncCwd":"skip","sessionMaxAgeHours":0}}"#;
        let parsed: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.claude.session_max_age_hours, 0);
    }

    #[test]
    fn font_weight_round_trip() {
        let font = FontSettings {
            face: "Fira Code".into(),
            size: 14,
            weight: "bold".into(),
        };
        let json = serde_json::to_string(&font).unwrap();
        let parsed: FontSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.weight, "bold");
    }

    #[test]
    fn dock_panes_round_trip() {
        let dock = DockSetting {
            position: "left".into(),
            active_view: Some("TerminalView".into()),
            views: vec!["TerminalView".into()],
            visible: true,
            size: 240.0,
            panes: vec![DockPaneSetting {
                id: "dp-abc123".into(),
                view: serde_json::json!({"type": "TerminalView", "profile": "WSL"}),
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            }],
        };
        let json = serde_json::to_string_pretty(&dock).unwrap();
        let parsed: DockSetting = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.panes.len(), 1);
        assert_eq!(parsed.panes[0].id, "dp-abc123");
        assert_eq!(parsed.panes[0].view["type"], "TerminalView");
        assert_eq!(parsed.panes[0].view["profile"], "WSL");
        assert_eq!(parsed.panes[0].x, 0.0);
        assert_eq!(parsed.panes[0].y, 0.0);
        assert_eq!(parsed.panes[0].w, 1.0);
        assert_eq!(parsed.panes[0].h, 1.0);
    }

    #[test]
    fn dock_panes_default_empty_when_missing() {
        let json = r#"{"position": "right", "views": []}"#;
        let dock: DockSetting = serde_json::from_str(json).unwrap();
        assert!(dock.panes.is_empty());
    }

    #[test]
    fn dock_pane_defaults_w_h_to_one() {
        let json = r#"{"id": "dp-1", "view": {"type": "EmptyView"}, "x": 0.0, "y": 0.0}"#;
        let pane: DockPaneSetting = serde_json::from_str(json).unwrap();
        assert_eq!(pane.w, 1.0);
        assert_eq!(pane.h, 1.0);
    }

    // --- Migration tests ---

    #[test]
    fn migrate_cmd_profile_to_powershell_in_workspace_panes() {
        let mut settings = Settings::default();
        settings.workspaces = vec![Workspace {
            id: "ws-1".into(),
            name: "Test".into(),
            layout_id: None,
            panes: vec![WorkspacePane {
                id: "pane-test1".into(),
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
                view: serde_json::from_value(serde_json::json!({
                    "type": "TerminalView",
                    "profile": "CMD"
                }))
                .unwrap(),
            }],
        }];
        migrate_settings(&mut settings);
        assert_eq!(
            settings.workspaces[0].panes[0].view.extra["profile"],
            "PowerShell"
        );
    }

    #[test]
    fn migrate_removes_cmd_from_profiles() {
        let mut settings = Settings::default();
        settings.profiles.push(Profile {
            name: "CMD".into(),
            command_line: "cmd.exe".into(),
            ..Profile::default()
        });
        assert_eq!(settings.profiles.len(), 3);
        migrate_settings(&mut settings);
        assert_eq!(settings.profiles.len(), 2);
        assert!(settings.profiles.iter().all(|p| p.name != "CMD"));
    }

    #[test]
    fn migrate_deduplicates_workspace_names() {
        let mut settings = Settings::default();
        settings.workspaces = vec![
            Workspace {
                id: "ws-1".into(),
                name: "Dev".into(),
                layout_id: None,
                panes: vec![],
            },
            Workspace {
                id: "ws-2".into(),
                name: "Dev".into(),
                layout_id: None,
                panes: vec![],
            },
            Workspace {
                id: "ws-3".into(),
                name: "Dev".into(),
                layout_id: None,
                panes: vec![],
            },
        ];
        migrate_settings(&mut settings);
        let names: Vec<&str> = settings
            .workspaces
            .iter()
            .map(|w| w.name.as_str())
            .collect();
        assert_eq!(names, vec!["Dev", "Dev (2)", "Dev (3)"]);
    }

    #[test]
    fn profile_font_override() {
        let json = r#"{"name": "Custom", "commandLine": "zsh", "font": {"face": "Fira Code", "size": 18, "weight": "bold"}}"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        let font = profile.font.unwrap();
        assert_eq!(font.face, "Fira Code");
        assert_eq!(font.size, 18);
        assert_eq!(font.weight, "bold");
    }

    #[test]
    fn profile_font_none_by_default() {
        let profile = Profile::default();
        assert!(profile.font.is_none());
    }

    #[test]
    fn profile_defaults_font_round_trip() {
        let json = r#"{
            "profileDefaults": {
                "font": {"face": "JetBrainsMonoBigHangul", "size": 14, "weight": "normal"}
            }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.profile_defaults.font.face,
            "JetBrainsMonoBigHangul"
        );
        assert_eq!(settings.profile_defaults.font.size, 14);

        // Round-trip: serialize then deserialize
        let serialized = serde_json::to_string_pretty(&settings).unwrap();
        let reparsed: Settings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            reparsed.profile_defaults.font.face,
            "JetBrainsMonoBigHangul"
        );
    }

    #[test]
    fn profile_defaults_missing_uses_defaults() {
        let json = r#"{}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.profile_defaults.font.face, "Cascadia Mono");
        assert_eq!(settings.profile_defaults.font.size, 14);
        assert_eq!(settings.profile_defaults.cursor_shape, "bar");
        assert!(settings.profile_defaults.snap_on_input);
    }

    #[test]
    fn profile_defaults_all_fields_round_trip() {
        let json = r#"{
            "profileDefaults": {
                "colorScheme": "One Half Dark",
                "cursorShape": "filledBox",
                "padding": {"top": 4, "right": 4, "bottom": 4, "left": 4},
                "scrollbackLines": 5000,
                "opacity": 80,
                "bellStyle": "none",
                "closeOnExit": "always",
                "antialiasingMode": "cleartype",
                "suppressApplicationTitle": true,
                "snapOnInput": false,
                "font": {"face": "Fira Code", "size": 16, "weight": "bold"}
            }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.profile_defaults.color_scheme, "One Half Dark");
        assert_eq!(settings.profile_defaults.cursor_shape, "filledBox");
        assert_eq!(settings.profile_defaults.padding.top, 4);
        assert_eq!(settings.profile_defaults.scrollback_lines, 5000);
        assert_eq!(settings.profile_defaults.opacity, 80);
        assert_eq!(settings.profile_defaults.bell_style, "none");
        assert_eq!(settings.profile_defaults.close_on_exit, "always");
        assert!(settings.profile_defaults.suppress_application_title);
        assert!(!settings.profile_defaults.snap_on_input);
        assert_eq!(settings.profile_defaults.font.face, "Fira Code");
        assert_eq!(settings.profile_defaults.font.weight, "bold");

        let serialized = serde_json::to_string_pretty(&settings).unwrap();
        let reparsed: Settings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed.profile_defaults, settings.profile_defaults);
    }

    #[test]
    fn view_order_and_app_theme_round_trip() {
        let json = r#"{
            "viewOrder": ["TerminalView", "MemoView"],
            "appThemeId": "dracula"
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.view_order, vec!["TerminalView", "MemoView"]);
        assert_eq!(settings.app_theme_id, "dracula");

        let serialized = serde_json::to_string_pretty(&settings).unwrap();
        let reparsed: Settings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed.view_order, vec!["TerminalView", "MemoView"]);
        assert_eq!(reparsed.app_theme_id, "dracula");
    }

    #[test]
    fn app_theme_id_defaults_when_missing() {
        let json = r#"{}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.app_theme_id, "catppuccin-mocha");
    }

    #[test]
    fn profile_font_not_serialized_when_none() {
        let profile = Profile::default();
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("\"font\""));
    }

    #[test]
    fn profile_font_serialized_when_some() {
        let mut profile = Profile::default();
        profile.font = Some(FontSettings {
            face: "Mono".into(),
            size: 12,
            weight: "normal".into(),
        });
        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains("\"font\""));
        let parsed: Profile = serde_json::from_str(&json).unwrap();
        let font = parsed.font.unwrap();
        assert_eq!(font.face, "Mono");
        assert_eq!(font.size, 12);
    }

    // --- Phase 0: Workspace Pane ID tests ---

    #[test]
    fn workspace_pane_id_round_trip() {
        let pane = WorkspacePane {
            id: "pane-abc12345".into(),
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            view: serde_json::from_value(serde_json::json!({"type": "TerminalView"})).unwrap(),
        };
        let json = serde_json::to_string(&pane).unwrap();
        let parsed: WorkspacePane = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "pane-abc12345");
    }

    #[test]
    fn workspace_pane_id_defaults_empty_when_missing() {
        let json = r#"{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "view": {"type": "EmptyView"}}"#;
        let pane: WorkspacePane = serde_json::from_str(json).unwrap();
        assert_eq!(pane.id, "");
    }

    #[test]
    fn migrate_assigns_pane_ids_to_empty() {
        let mut settings = Settings::default();
        settings.workspaces = vec![Workspace {
            id: "ws-1".into(),
            name: "Test".into(),
            layout_id: None,
            panes: vec![
                WorkspacePane {
                    id: "".into(),
                    x: 0.0,
                    y: 0.0,
                    w: 0.5,
                    h: 1.0,
                    view: serde_json::from_value(serde_json::json!({"type": "TerminalView"}))
                        .unwrap(),
                },
                WorkspacePane {
                    id: "existing-id".into(),
                    x: 0.5,
                    y: 0.0,
                    w: 0.5,
                    h: 1.0,
                    view: serde_json::from_value(serde_json::json!({"type": "EmptyView"})).unwrap(),
                },
            ],
        }];
        migrate_settings(&mut settings);
        // Empty ID gets assigned a pane-{uuid} format
        assert!(settings.workspaces[0].panes[0].id.starts_with("pane-"));
        assert_eq!(settings.workspaces[0].panes[0].id.len(), 13); // "pane-" + 8 chars
                                                                  // Existing ID is preserved
        assert_eq!(settings.workspaces[0].panes[1].id, "existing-id");
    }

    #[test]
    fn migrate_assigns_pane_ids_to_dock_panes() {
        let mut settings = Settings::default();
        settings.docks = vec![DockSetting {
            position: "left".into(),
            active_view: None,
            views: vec![],
            visible: true,
            size: 240.0,
            panes: vec![
                DockPaneSetting {
                    id: "".into(),
                    view: serde_json::json!({"type": "TerminalView"}),
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                },
                DockPaneSetting {
                    id: "dock-existing".into(),
                    view: serde_json::json!({"type": "EmptyView"}),
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                },
            ],
        }];
        migrate_settings(&mut settings);
        assert!(settings.docks[0].panes[0].id.starts_with("pane-"));
        assert_eq!(settings.docks[0].panes[0].id.len(), 13);
        assert_eq!(settings.docks[0].panes[1].id, "dock-existing");
    }

    // --- Phase 1: restore_cwd / restore_output tests ---

    #[test]
    fn profile_defaults_restore_fields_default_true() {
        let defaults = ProfileDefaults::default();
        assert!(defaults.restore_cwd);
        assert!(defaults.restore_output);
    }

    #[test]
    fn profile_defaults_restore_fields_round_trip() {
        let json = r#"{
            "profileDefaults": {
                "restoreCwd": false,
                "restoreOutput": false
            }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(!settings.profile_defaults.restore_cwd);
        assert!(!settings.profile_defaults.restore_output);

        let serialized = serde_json::to_string_pretty(&settings).unwrap();
        let reparsed: Settings = serde_json::from_str(&serialized).unwrap();
        assert!(!reparsed.profile_defaults.restore_cwd);
        assert!(!reparsed.profile_defaults.restore_output);
    }

    #[test]
    fn profile_defaults_restore_fields_default_when_missing() {
        let json = r#"{}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.profile_defaults.restore_cwd);
        assert!(settings.profile_defaults.restore_output);
    }

    #[test]
    fn profile_restore_fields_optional() {
        let profile = Profile::default();
        assert!(profile.restore_cwd.is_none());
        assert!(profile.restore_output.is_none());
    }

    #[test]
    fn profile_restore_fields_round_trip() {
        let json = r#"{"name": "Test", "commandLine": "bash", "restoreCwd": false, "restoreOutput": true}"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.restore_cwd, Some(false));
        assert_eq!(profile.restore_output, Some(true));

        let serialized = serde_json::to_string(&profile).unwrap();
        let reparsed: Profile = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed.restore_cwd, Some(false));
        assert_eq!(reparsed.restore_output, Some(true));
    }

    #[test]
    fn profile_restore_fields_not_serialized_when_none() {
        let profile = Profile::default();
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("restoreCwd"));
        assert!(!json.contains("restoreOutput"));
    }

    // --- Phase 2: cache_dir_path tests ---

    #[test]
    fn cache_dir_path_is_under_config() {
        if let Some(cache) = cache_dir_path() {
            if let Some(config) = dirs_config_path() {
                assert_eq!(cache.parent(), Some(config.as_path()));
                assert_eq!(cache.file_name().unwrap(), "cache");
            }
        }
    }

    // --- Memo file tests ---

    #[test]
    fn memo_path_is_inside_cache_dir() {
        let mp = memo_path();
        assert_eq!(mp.file_name().unwrap(), "memo.json");
        // memo.json should be inside cache/ directory
        let parent = mp.parent().unwrap();
        assert_eq!(parent.file_name().unwrap(), "cache");
        // cache/ should be inside config directory
        if let Some(config) = dirs_config_path() {
            assert_eq!(parent.parent(), Some(config.as_path()));
        }
    }

    #[test]
    fn memo_round_trip_via_functions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");

        save_memo_to(&path, "pane-1", "Hello").unwrap();
        save_memo_to(&path, "pane-2", "World").unwrap();

        assert_eq!(load_memo_from(&path, "pane-1"), "Hello");
        assert_eq!(load_memo_from(&path, "pane-2"), "World");
    }

    #[test]
    fn memo_missing_key_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");

        // No file at all
        assert_eq!(load_memo_from(&path, "nonexistent"), "");

        // File exists but key doesn't
        save_memo_to(&path, "other", "data").unwrap();
        assert_eq!(load_memo_from(&path, "nonexistent"), "");
    }

    #[test]
    fn memo_empty_content_removes_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");

        save_memo_to(&path, "pane-1", "data").unwrap();
        assert_eq!(load_memo_from(&path, "pane-1"), "data");

        // Save empty string removes the key
        save_memo_to(&path, "pane-1", "").unwrap();
        assert_eq!(load_memo_from(&path, "pane-1"), "");

        // Verify it's actually removed from the file
        let content = fs::read_to_string(&path).unwrap();
        let map: std::collections::HashMap<String, String> =
            serde_json::from_str(&content).unwrap();
        assert!(!map.contains_key("pane-1"));
    }

    #[test]
    fn workspace_display_order_round_trip() {
        let mut settings = Settings::default();
        settings.workspace_display_order = vec!["ws-2".into(), "ws-1".into(), "ws-3".into()];
        settings.workspace_sort_order = Some("manual".into());
        settings.workspace_display =
            Some(serde_json::json!({"minimap": true, "environment": false}));

        let json = serde_json::to_string_pretty(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.workspace_display_order, vec!["ws-2", "ws-1", "ws-3"]);
        assert_eq!(parsed.workspace_sort_order, Some("manual".into()));
        assert_eq!(
            parsed.workspace_display,
            Some(serde_json::json!({"minimap": true, "environment": false}))
        );
    }

    #[test]
    fn workspace_display_order_absent_defaults_empty() {
        let json = r#"{}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.workspace_display_order.is_empty());
        assert!(settings.workspace_sort_order.is_none());
        assert!(settings.workspace_display.is_none());
    }

    #[test]
    fn workspace_display_order_skipped_when_empty() {
        let settings = Settings::default();
        let json = serde_json::to_string(&settings).unwrap();
        // Empty vec should be skipped in serialization
        assert!(!json.contains("workspaceDisplayOrder"));
        assert!(!json.contains("workspaceSortOrder"));
        assert!(!json.contains("workspaceDisplay"));
    }

    #[test]
    fn explorer_settings_default() {
        let settings = Settings::default();
        assert_eq!(settings.explorer.shell_profile, "");
        assert_eq!(settings.explorer.padding_top, 8);
        assert_eq!(settings.explorer.font_family, "");
        assert_eq!(settings.explorer.font_size, 13);
        assert!(!settings.explorer.copy_on_select);
        assert!(settings.explorer.extension_viewers.is_empty());
    }

    #[test]
    fn explorer_settings_deserialize() {
        let json = r#"{"explorer": {
            "shellProfile": "WSL",
            "fontFamily": "Consolas",
            "fontSize": 14,
            "copyOnSelect": true,
            "extensionViewers": [
                {"extensions": [".txt", ".log"], "command": "vi"}
            ]
        }}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.explorer.shell_profile, "WSL");
        assert_eq!(settings.explorer.font_family, "Consolas");
        assert_eq!(settings.explorer.font_size, 14);
        assert!(settings.explorer.copy_on_select);
        assert_eq!(settings.explorer.extension_viewers.len(), 1);
        assert_eq!(settings.explorer.extension_viewers[0].command, "vi");
        assert_eq!(
            settings.explorer.extension_viewers[0].extensions,
            vec![".txt", ".log"]
        );
    }

    #[test]
    fn explorer_settings_default_when_absent() {
        let json = r#"{}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.explorer.font_size, 13);
    }

    #[test]
    fn explorer_settings_ignores_unknown_fields() {
        // Old settings.json with lsCommand should still deserialize fine
        let json = r#"{"explorer": {"lsCommand": "ls -F", "fontSize": 15}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.explorer.font_size, 15);
    }
}
