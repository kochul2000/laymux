use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::constants::{
    DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS, DEFAULT_REMOTE_SNAPSHOT_MAX_KIB,
    PARSER_ADMISSION_FOCUSED_SHARE_DEFAULT, PARSER_ADMISSION_HIDDEN_SHARE_DEFAULT,
    PARSER_ADMISSION_SHARE_MAX, PARSER_ADMISSION_SHARE_MIN, PARSER_ADMISSION_VISIBLE_SHARE_DEFAULT,
    WIDGET_FONT_SIZE_DEFAULT,
};

/// Color scheme definition (Windows Terminal compatible).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
    /// Whether the terminal cursor blinks for this profile.
    #[serde(default = "default_true")]
    pub cursor_blink: bool,
    /// Stabilize the shell cursor while interactive TUIs repaint it.
    #[serde(default = "default_true")]
    pub stabilize_interactive_cursor: bool,
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
            cursor_blink: true,
            stabilize_interactive_cursor: true,
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct Keybinding {
    pub keys: String,
    pub command: String,
}

/// Font settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDefaults {
    #[serde(default)]
    pub color_scheme: String,
    #[serde(default = "default_cursor_shape")]
    pub cursor_shape: String,
    #[serde(default = "default_true")]
    pub cursor_blink: bool,
    #[serde(default = "default_true")]
    pub stabilize_interactive_cursor: bool,
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
    /// Maximum serialized terminal output cache per terminal, in KiB.
    #[serde(default = "default_max_output_cache_kb", rename = "maxOutputCacheKB")]
    #[schemars(rename = "maxOutputCacheKB")]
    pub max_output_cache_kb: u32,
    /// CWD sync behavior: "default" or { send: bool, receive: bool }. Opaque to backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_cwd: Option<serde_json::Value>,
}

impl Default for ProfileDefaults {
    fn default() -> Self {
        Self {
            color_scheme: String::new(),
            cursor_shape: default_cursor_shape(),
            cursor_blink: true,
            stabilize_interactive_cursor: true,
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
            max_output_cache_kb: default_max_output_cache_kb(),
            sync_cwd: None,
        }
    }
}

fn default_max_output_cache_kb() -> u32 {
    256
}

/// Layout pane definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub panes: Vec<LayoutPane>,
}

/// Workspace pane view config.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct WorkspacePaneView {
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

/// Workspace pane definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct WorkspacePane {
    /// Stable pane identifier, persisted across restarts. Empty string means unassigned (migrated).
    #[serde(default)]
    pub id: String,
    // All four bounds carry a default so a single mistyped coordinate drops that
    // field instead of the whole pane (ADR-0119). `validate_and_repair`
    // normalizes the resulting zeros anyway.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    pub view: WorkspacePaneView,
}

/// Workspace definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSettings {
    #[serde(default)]
    pub sync_cwd: ClaudeSyncCwdMode,
    /// Command that launches Claude Code (default: "claude").
    ///
    /// Flags belong here — `claude --dangerously-skip-permissions` makes session
    /// restore resume with that flag. Unsafe values fall back to the default.
    #[serde(default = "default_claude_command")]
    pub command: String,
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
            command: default_claude_command(),
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

fn default_claude_command() -> String {
    super::agent_command::DEFAULT_CLAUDE_COMMAND.to_string()
}

fn default_codex_command() -> String {
    super::agent_command::DEFAULT_CODEX_COMMAND.to_string()
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodexSettings {
    /// Command that launches the Codex CLI (default: "codex").
    ///
    /// Flags belong here — `codex --yolo` makes session restore resume with that
    /// flag. Unsafe values fall back to the default.
    #[serde(default = "default_codex_command")]
    pub command: String,
    /// Whether to restore Codex CLI sessions on app restart (default: true).
    #[serde(default = "default_restore_session")]
    pub restore_session: bool,
    /// Maximum age (in hours) for Codex rollout files to be considered valid.
    /// Set to 0 to disable the age filter.
    #[serde(default = "default_session_max_age_hours")]
    pub session_max_age_hours: u64,
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
            command: default_codex_command(),
            restore_session: true,
            session_max_age_hours: 24,
            status_message_mode: CodexStatusMessageMode::default(),
            status_message_delimiter: default_codex_status_message_delimiter(),
        }
    }
}

fn default_codex_status_message_delimiter() -> String {
    " · ".to_string()
}

/// Status message display mode for Grok in WorkspaceSelectorView.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum GrokStatusMessageMode {
    Bullet,
    Title,
    TitleBullet,
    #[default]
    BulletTitle,
}

/// Grok Build integration settings (ADR-0156). Same field set as Codex.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrokSettings {
    #[serde(default = "default_grok_command")]
    pub command: String,
    #[serde(default = "default_restore_session")]
    pub restore_session: bool,
    #[serde(default = "default_session_max_age_hours")]
    pub session_max_age_hours: u64,
    #[serde(default)]
    pub status_message_mode: GrokStatusMessageMode,
    #[serde(default = "default_codex_status_message_delimiter")]
    pub status_message_delimiter: String,
}

impl Default for GrokSettings {
    fn default() -> Self {
        Self {
            command: default_grok_command(),
            restore_session: true,
            session_max_age_hours: 24,
            status_message_mode: GrokStatusMessageMode::default(),
            status_message_delimiter: default_codex_status_message_delimiter(),
        }
    }
}

fn default_grok_command() -> String {
    super::agent_command::DEFAULT_GROK_COMMAND.to_string()
}

/// App-exit behavior settings.
///
/// Controls the "interrupt running terminal work on quit" feature (issue #451):
/// when enabled, laymux sends Ctrl+C (ETX, 0x03) to every terminal a few times
/// as the window closes. This (A) tears down long-running/cron work and (B)
/// nudges Claude Code / Codex to print their resume session id into the
/// scrollback (which is cached and restored on the next launch).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExitSettings {
    /// Send Ctrl+C to all terminals on app exit. Default: off (destructive, opt-in).
    #[serde(default)]
    pub interrupt_terminals: bool,
    /// How many Ctrl+C presses to send per terminal. Clamped to 1..=10 at use.
    #[serde(default = "default_interrupt_rounds")]
    pub interrupt_rounds: u32,
    /// Delay (ms) after the last Ctrl+C so agents can print their session id
    /// before the window closes. Clamped to 0..=10000 at use.
    #[serde(default = "default_exit_settle_ms")]
    pub settle_ms: u64,
}

impl Default for ExitSettings {
    fn default() -> Self {
        Self {
            interrupt_terminals: false,
            interrupt_rounds: default_interrupt_rounds(),
            settle_ms: default_exit_settle_ms(),
        }
    }
}

fn default_interrupt_rounds() -> u32 {
    3
}

fn default_exit_settle_ms() -> u64 {
    700
}

/// Activity-aware clear settings for one focused terminal pane (ADR-0158).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaneClearSettings {
    /// Command submitted to an idle shell. Interactive providers own their input.
    #[serde(default = "default_pane_clear_shell_command")]
    pub shell_command: String,
    /// What to do when the target pane is still working.
    #[serde(default)]
    pub busy_policy: PaneClearBusyPolicy,
    /// Ctrl+C presses sent before clear under the interrupt policy.
    #[serde(default = "default_pane_clear_interrupt_rounds")]
    pub interrupt_rounds: u32,
    /// Delay after the last Ctrl+C, in milliseconds.
    #[serde(default = "default_pane_clear_settle_ms")]
    pub settle_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub enum PaneClearBusyPolicy {
    /// Preserve running work. This is the safe default.
    #[default]
    Skip,
    /// Send Ctrl+C, wait for a prompt, then submit the activity-specific clear input.
    Interrupt,
    /// Replace the PTY, discarding its scrollback and process state.
    Restart,
}

impl Default for PaneClearSettings {
    fn default() -> Self {
        Self {
            shell_command: default_pane_clear_shell_command(),
            busy_policy: PaneClearBusyPolicy::default(),
            interrupt_rounds: default_pane_clear_interrupt_rounds(),
            settle_ms: default_pane_clear_settle_ms(),
        }
    }
}

fn default_pane_clear_shell_command() -> String {
    "clear".to_string()
}

fn default_pane_clear_interrupt_rounds() -> u32 {
    2
}

fn default_pane_clear_settle_ms() -> u64 {
    400
}

/// Path ellipsis direction: "start" truncates the beginning, "end" truncates the end.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
fn default_volume_window_ms() -> u64 {
    2000
}
/// 64 KiB per 2 s window (~32 KiB/s sustained). Above this a pane is producing
/// far more than a prompt redraw, a focus redraw or a person typing can account
/// for; see ADR-0147 for how the figure was chosen and when to revisit it.
fn default_volume_threshold_bytes() -> u64 {
    64 * 1024
}
/// Lower bound for `volumeThresholdBytes` — one large TUI frame's worth. Keeps
/// the setting from degenerating into "any output means active".
pub(crate) const MIN_VOLUME_THRESHOLD_BYTES: u64 = 4 * 1024;
/// Upper bound for `volumeWindowMs` (30 s). The volume window tumbles, so once
/// a window is over the threshold it keeps the pane marked busy until the window
/// turns over — an unbounded value would let one burst pin ⏳ indefinitely.
pub(crate) const MAX_VOLUME_WINDOW_MS: u64 = 30_000;

/// Output-activity detection parameters (ADR-0147). Two independent detectors
/// share this block and the one `throttle_ms`: a DEC 2026 frame-count burst for
/// cooperating TUI apps, and a raw-byte volume window that needs no cooperation
/// at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputActivityBurstSettings {
    /// Sliding window size (ms) for counting DEC 2026h events.
    #[serde(default = "default_burst_window_ms")]
    pub window_ms: u64,
    /// Minimum events within window to trigger activity.
    #[serde(default = "default_burst_threshold")]
    pub threshold: u64,
    /// Minimum interval (ms) between emitted activity events per terminal.
    /// Shared by the frame and volume detectors.
    #[serde(default = "default_burst_throttle_ms")]
    pub throttle_ms: u64,
    /// Window size (ms) for summing raw PTY output bytes. The window tumbles
    /// rather than slides, so the ceiling below matters: a very long window
    /// keeps a single burst marking the pane busy until it turns over.
    #[serde(default = "default_volume_window_ms")]
    pub volume_window_ms: u64,
    /// Bytes within `volume_window_ms` that mark the pane as working. Set well
    /// above what a prompt redraw or human typing can produce so the volume
    /// path stays a sustained-output signal rather than an "any output" one.
    #[serde(default = "default_volume_threshold_bytes")]
    pub volume_threshold_bytes: u64,
}

impl Default for OutputActivityBurstSettings {
    fn default() -> Self {
        Self {
            window_ms: default_burst_window_ms(),
            threshold: default_burst_threshold(),
            throttle_ms: default_burst_throttle_ms(),
            volume_window_ms: default_volume_window_ms(),
            volume_threshold_bytes: default_volume_threshold_bytes(),
        }
    }
}

impl OutputActivityBurstSettings {
    /// Clamp values to safe ranges. Called at usage site to guard against
    /// invalid user input (e.g., threshold=0 or window_ms=0).
    ///
    /// The volume floor is 4 KiB, not 1 byte: a lower value would turn the
    /// volume detector into the "any output means active" rule that ADR-0147
    /// keeps forbidden, so the setting cannot express it.
    pub fn sanitized(&self) -> Self {
        Self {
            window_ms: self.window_ms.max(100),
            threshold: self.threshold.max(2),
            throttle_ms: self.throttle_ms.max(100),
            volume_window_ms: self.volume_window_ms.clamp(100, MAX_VOLUME_WINDOW_MS),
            volume_threshold_bytes: self.volume_threshold_bytes.max(MIN_VOLUME_THRESHOLD_BYTES),
        }
    }
}

fn default_focused_admission_share() -> u32 {
    PARSER_ADMISSION_FOCUSED_SHARE_DEFAULT
}
fn default_visible_admission_share() -> u32 {
    PARSER_ADMISSION_VISIBLE_SHARE_DEFAULT
}
fn default_hidden_admission_share() -> u32 {
    PARSER_ADMISSION_HIDDEN_SHARE_DEFAULT
}

/// Share of xterm parser admission turns per pane class (ADR-0101).
///
/// The share belongs to the class, not to a pane, so the active workspace keeps
/// its share no matter how many hidden panes are flooding. The three values are
/// relative; their sum is one admission cycle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ParserAdmissionSettings {
    /// Share for the focused pane of the active workspace.
    #[serde(default = "default_focused_admission_share")]
    pub focused_share: u32,
    /// Share for the active workspace's other visible panes, together.
    #[serde(default = "default_visible_admission_share")]
    pub visible_share: u32,
    /// Share for every hidden pane together (inactive workspaces, 0 px tracks).
    #[serde(default = "default_hidden_admission_share")]
    pub hidden_share: u32,
}

impl Default for ParserAdmissionSettings {
    fn default() -> Self {
        Self {
            focused_share: default_focused_admission_share(),
            visible_share: default_visible_admission_share(),
            hidden_share: default_hidden_admission_share(),
        }
    }
}

impl ParserAdmissionSettings {
    /// Clamp to the range the scheduler honours. The frontend clamps the same
    /// way, so an out-of-range file behaves identically on both sides.
    pub fn sanitized(&self) -> Self {
        let clamp =
            |value: u32| value.clamp(PARSER_ADMISSION_SHARE_MIN, PARSER_ADMISSION_SHARE_MAX);
        Self {
            focused_share: clamp(self.focused_share),
            visible_share: clamp(self.visible_share),
            hidden_share: clamp(self.hidden_share),
        }
    }
}

/// Terminal behavior & rendering settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(default)]
    pub output_activity_burst: OutputActivityBurstSettings,
    /// Class shares for xterm parser admission (ADR-0101). No settings UI: this
    /// is a tuning knob edited in settings.json.
    #[serde(default)]
    pub parser_admission: ParserAdmissionSettings,
    /// Advertise xterm.js 24-bit color support to newly spawned PTY children.
    #[serde(default = "default_true")]
    pub advertise_true_color: bool,
    /// Automatically copy text to clipboard when selected in terminal.
    #[serde(default = "default_true")]
    pub copy_on_select: bool,
    /// Terminal scrollbar style: "overlay" (default) or "separate".
    #[serde(default = "default_scrollbar_style")]
    pub scrollbar_style: String,
    /// Enable selection-based file/directory path links.
    #[serde(default = "default_true")]
    pub path_link_enabled: bool,
    /// Maximum selected text length considered for a path link.
    #[serde(default = "default_path_link_max_length")]
    pub path_link_max_length: u32,
    /// Allow Ctrl / Ctrl+Shift click on a path link to hand the target to the
    /// host OS (open with the file association / show in the file manager).
    #[serde(default = "default_true")]
    pub path_link_os_open_enabled: bool,
    /// Confirm every host OS open, not just the always-confirmed executable
    /// class. Turning this off still confirms directly executable extensions.
    #[serde(default = "default_true")]
    pub path_link_os_open_confirm: bool,
    /// Show the floating jump-to-bottom button while scrolled up.
    #[serde(default = "default_true")]
    pub show_scroll_to_bottom_button: bool,
    /// Mouse wheel scroll multiplier for the desktop terminal (xterm
    /// `scrollSensitivity`). The Remote surface has its own value.
    #[serde(default = "default_scroll_sensitivity")]
    pub scroll_sensitivity: f32,
    /// Wheel multiplier while the fast-scroll modifier (Alt) is held
    /// (xterm `fastScrollSensitivity`).
    #[serde(default = "default_fast_scroll_sensitivity")]
    pub fast_scroll_sensitivity: f32,
    /// Composer: which terminals share one past-input history bucket —
    /// "global" (default), "workspace", or "pane" (ADR-0055). The history text
    /// itself is never persisted; only this scope choice is.
    #[serde(default = "default_composer_history_scope")]
    pub composer_history_scope: String,
    /// Composer: Tab on an empty, focused draft opens a past-input recall popup (issue #504).
    #[serde(default = "default_true")]
    pub composer_history_popup: bool,
    /// Composer: suggest matching past inputs as an autocomplete dropdown while typing (issue #505).
    #[serde(default = "default_true")]
    pub composer_autocomplete: bool,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            output_activity_burst: OutputActivityBurstSettings::default(),
            parser_admission: ParserAdmissionSettings::default(),
            advertise_true_color: true,
            copy_on_select: true,
            scrollbar_style: default_scrollbar_style(),
            path_link_enabled: true,
            path_link_max_length: default_path_link_max_length(),
            path_link_os_open_enabled: true,
            path_link_os_open_confirm: true,
            show_scroll_to_bottom_button: true,
            scroll_sensitivity: default_scroll_sensitivity(),
            fast_scroll_sensitivity: default_fast_scroll_sensitivity(),
            composer_history_scope: default_composer_history_scope(),
            composer_history_popup: true,
            composer_autocomplete: true,
        }
    }
}

fn default_path_link_max_length() -> u32 {
    256
}

fn default_scroll_sensitivity() -> f32 {
    crate::constants::DEFAULT_SCROLL_SENSITIVITY
}

fn default_fast_scroll_sensitivity() -> f32 {
    crate::constants::DEFAULT_FAST_SCROLL_SENSITIVITY
}

/// Normalize a hand-edited wheel multiplier into the range xterm accepts.
///
/// Only a positive, finite value is a scale the user asked for, so those are
/// clamped to the band. A non-positive or non-finite value is not a slower
/// scroll — it is a value xterm refuses — so it falls back to the default
/// instead of being dragged up to the floor. The frontend mirror in
/// `lib/scroll-sensitivity.ts` and the Remote page make the same split.
pub fn clamp_scroll_sensitivity(value: f32, default: f32) -> f32 {
    if !value.is_finite() || value <= 0.0 {
        return default;
    }
    value.clamp(
        crate::constants::MIN_SCROLL_SENSITIVITY,
        crate::constants::MAX_SCROLL_SENSITIVITY,
    )
}

fn default_composer_history_scope() -> String {
    "global".to_string()
}

/// App-wide appearance settings (theme + non-terminal font).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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

/// Usage monitor settings (`UsageView`, ADR-0102).
///
/// Collection is keyed by agent because each one has its own source: Claude is
/// read by a headless PTY probe ([ADR-0102]), Codex by its local app-server
/// account API ([ADR-0104]). Presentation is not keyed by agent — `colors` is
/// shared by every provider's view, so a display rule lives in exactly one place.
///
/// [ADR-0102]: ../../../docs/adr/0102-claude-usage-probe-headless-pty.md
/// [ADR-0104]: ../../../docs/adr/0104-codex-usage-app-server-probe.md
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageSettings {
    #[serde(default)]
    pub claude: UsageAgentSettings,
    #[serde(default = "default_codex_usage_settings")]
    pub codex: UsageAgentSettings,
    #[serde(default = "default_grok_usage_settings")]
    pub grok: UsageAgentSettings,
}

impl Default for UsageSettings {
    fn default() -> Self {
        Self {
            claude: UsageAgentSettings::default(),
            codex: default_codex_usage_settings(),
            grok: default_grok_usage_settings(),
        }
    }
}

/// Meter colors for one provider.
///
/// Owned per agent rather than globally: two providers shown side by side on the
/// same status line are only telling apart by colour, so a shared palette makes
/// the surface unreadable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageColorSettings {
    /// Falls back to Claude's colour when a hand-edited file omits it; the agent
    /// defaults above are what actually seed a fresh install.
    #[serde(default = "default_claude_used_color")]
    pub used: String,
    #[serde(default = "default_usage_pace_color")]
    pub pace: String,
    #[serde(default = "default_usage_track_color")]
    pub track: String,
}

/// Claude's brand orange — the same colour the workspace selector marks a
/// Claude pane with, so one agent reads the same everywhere in the app.
fn default_claude_used_color() -> String {
    "#d97757".into()
}
/// Codex's brand green, for the same reason.
fn default_codex_used_color() -> String {
    "#10a37f".into()
}
/// GrokNight magenta accent — selector and usage bars share this (ADR-0156).
fn default_grok_used_color() -> String {
    "#c084fc".into()
}
/// Elapsed time is provider-neutral, so it keeps one colour across agents —
/// yellow, far enough from both brand colours to never be mistaken for the
/// consumption bar sitting directly above it.
fn default_usage_pace_color() -> String {
    "#f9e2af".into()
}
fn default_usage_track_color() -> String {
    "#585858".into()
}

impl UsageColorSettings {
    fn for_agent(used: String) -> Self {
        Self {
            used,
            pace: default_usage_pace_color(),
            track: default_usage_track_color(),
        }
    }
}

impl Default for UsageColorSettings {
    fn default() -> Self {
        Self::for_agent(default_claude_used_color())
    }
}

/// One monitored agent's probe settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsageAgentSettings {
    /// Terminal profile whose shell can run the agent CLI. Empty = `defaultProfile`.
    #[serde(default)]
    pub profile: String,
    /// Seconds between usage queries. Clamped to the provider's rate-limit floor
    /// on use — a lower value is not honored.
    #[serde(default = "default_usage_refresh_seconds")]
    pub refresh_seconds: u64,
    /// Additional agent config directories offered in the view's picker. The
    /// default config dir is always available and is not listed here.
    #[serde(default)]
    pub config_dirs: Vec<String>,
    /// Limit rows displayed by the agent's UsageView. The frontend keeps at
    /// least one selected and falls back to all rows for malformed input.
    #[serde(default = "default_usage_visible_rows")]
    pub visible_rows: Vec<String>,
    /// Meter colors for this agent's views and widgets.
    #[serde(default)]
    pub colors: UsageColorSettings,
}

fn default_usage_refresh_seconds() -> u64 {
    crate::usage_probe::MIN_REFRESH_SECS
}

fn default_usage_visible_rows() -> Vec<String> {
    vec!["session".into(), "weekAll".into(), "weekModel".into()]
}

fn default_codex_usage_settings() -> UsageAgentSettings {
    UsageAgentSettings {
        profile: String::new(),
        refresh_seconds: default_usage_refresh_seconds(),
        config_dirs: Vec::new(),
        visible_rows: vec!["weekly".into(), "sparkWeekly".into()],
        colors: UsageColorSettings::for_agent(default_codex_used_color()),
    }
}

fn default_grok_usage_settings() -> UsageAgentSettings {
    UsageAgentSettings {
        profile: String::new(),
        refresh_seconds: default_usage_refresh_seconds(),
        config_dirs: Vec::new(),
        visible_rows: vec!["weekly".into()],
        colors: UsageColorSettings::for_agent(default_grok_used_color()),
    }
}

impl Default for UsageAgentSettings {
    fn default() -> Self {
        Self {
            profile: String::new(),
            refresh_seconds: default_usage_refresh_seconds(),
            config_dirs: Vec::new(),
            visible_rows: default_usage_visible_rows(),
            colors: UsageColorSettings::default(),
        }
    }
}

/// Where the user placed status widgets, per [ADR-0105].
///
/// Placement is nothing but the order of these four arrays: a widget is on the
/// left because it sits in a `left` slot, and it comes first because it is first
/// in that array. The top bar's slots always exist; `statusLine.enabled` decides
/// only whether the bottom surface is drawn, never whether its placement is kept.
///
/// [ADR-0105]: ../../../docs/adr/0105-widget-slots-and-status-line.md
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WidgetsSettings {
    /// Empty inherits the app interface font.
    #[serde(default)]
    pub font_family: String,
    /// Text size shared by every widget surface.
    #[serde(default = "default_widget_font_size")]
    pub font_size: u16,
    #[serde(default)]
    pub top_bar: WidgetSlots,
    #[serde(default)]
    pub status_line: StatusLineWidgets,
    /// What a slot does when its width budget runs out. Only `collapse` exists
    /// today; the key is here so a second policy is a value change, not a
    /// schema change.
    #[serde(default = "default_widget_overflow")]
    pub overflow: String,
}

fn default_widget_overflow() -> String {
    "collapse".into()
}

fn default_widget_font_size() -> u16 {
    WIDGET_FONT_SIZE_DEFAULT
}

impl Default for WidgetsSettings {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            font_size: default_widget_font_size(),
            top_bar: WidgetSlots::default(),
            status_line: StatusLineWidgets::default(),
            overflow: default_widget_overflow(),
        }
    }
}

/// One surface's two slots. Empty by default — nothing is placed for the user.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSlots {
    #[serde(default)]
    pub left: Vec<WidgetInstance>,
    #[serde(default)]
    pub right: Vec<WidgetInstance>,
}

/// The bottom surface: the same two slots plus the switch that draws them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusLineWidgets {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub left: Vec<WidgetInstance>,
    #[serde(default)]
    pub right: Vec<WidgetInstance>,
}

/// One placed widget.
///
/// `options` stays untyped here because each widget type owns its own value
/// domain; the backend validates the domains it knows and carries the rest
/// through untouched rather than dropping keys it cannot interpret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WidgetInstance {
    /// Unique across all four slots. Survives moves between slots.
    pub id: String,
    /// Registry name. Unknown values are kept on load and skipped when
    /// rendering, so a settings file from another version loses nothing.
    #[serde(rename = "type")]
    pub widget_type: String,
    #[serde(default = "default_widget_options")]
    pub options: serde_json::Value,
}

fn default_widget_options() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// Pane control bar settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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

/// OS power behavior (ADR-0116). Two independent axes, not one mode: the
/// top-bar button owns `keep_awake`, Settings owns `keep_awake_when_busy`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PowerSettings {
    /// Manual switch: keep the machine awake no matter what the terminals do.
    #[serde(default)]
    pub keep_awake: bool,
    /// Standing policy: keep the machine awake while a terminal is running.
    #[serde(default)]
    pub keep_awake_when_busy: bool,
}

/// Which elements to display in WorkspaceSelectorView pane rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
    /// Seconds a pane/workspace must stay hidden before its terminal (PTY)
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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

/// GitHub issues/pulls view settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GithubSettings {
    /// Tab shown when the view first mounts: "issues" or "pulls".
    #[serde(default = "default_github_tab")]
    pub default_tab: String,
    /// Seconds between snapshot polls. The backend caches `gh` output for its
    /// own refresh window, so values below that just re-read the cache.
    #[serde(default = "default_github_refresh_seconds")]
    pub refresh_seconds: u32,
    /// Hide draft pull requests from the pulls tab.
    #[serde(default)]
    pub hide_draft_pulls: bool,
    /// Row typeface. Empty string means the app UI font.
    #[serde(default)]
    pub font_family: String,
    /// Row font size in px for the number and the title. The secondary columns
    /// (author, age, labels) are derived from it by the frontend so one knob
    /// keeps the row proportional.
    #[serde(default = "default_github_font_size")]
    pub font_size: u32,
    /// Which palette token paints `#123`. A named token, never a raw color:
    /// the row has to stay legible in every app theme.
    #[serde(default = "default_github_number_color")]
    pub number_color: String,
    /// Show the author column.
    #[serde(default = "default_true")]
    pub show_author: bool,
    /// Show the "updated N ago" column.
    #[serde(default = "default_true")]
    pub show_updated: bool,
    /// Show the DRAFT badge on draft pull requests.
    #[serde(default = "default_true")]
    pub show_draft_badge: bool,
    /// How many labels one row may show. `0` hides the labels entirely — the
    /// count is the single switch for that column.
    #[serde(default = "default_github_label_max_count")]
    pub label_max_count: u32,
    /// Widest one label chip may get, in px.
    #[serde(default = "default_github_label_max_width")]
    pub label_max_width: u32,
}

fn default_github_tab() -> String {
    "issues".to_string()
}

fn default_github_refresh_seconds() -> u32 {
    10
}

fn default_github_font_size() -> u32 {
    11
}

fn default_github_number_color() -> String {
    "yellow".to_string()
}

fn default_github_label_max_count() -> u32 {
    2
}

fn default_github_label_max_width() -> u32 {
    80
}

impl Default for GithubSettings {
    fn default() -> Self {
        Self {
            default_tab: default_github_tab(),
            refresh_seconds: default_github_refresh_seconds(),
            hide_draft_pulls: false,
            font_family: String::new(),
            font_size: default_github_font_size(),
            number_color: default_github_number_color(),
            show_author: true,
            show_updated: true,
            show_draft_badge: true,
            label_max_count: default_github_label_max_count(),
            label_max_width: default_github_label_max_width(),
        }
    }
}

/// Paragraph copy feature settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionViewer {
    pub extensions: Vec<String>,
    pub command: String,
    /// Explicit terminal profile used to execute the viewer command.
    #[serde(default)]
    pub profile: String,
}

/// FileExplorerView settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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

/// FileViewer body settings — independent of `FileExplorerSettings` (which
/// styles the directory listing, not the opened file's content).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSettings {
    #[serde(default = "default_view_padding")]
    pub padding_top: u32,
    #[serde(default = "default_view_padding")]
    pub padding_right: u32,
    #[serde(default = "default_view_padding")]
    pub padding_bottom: u32,
    #[serde(default = "default_view_padding")]
    pub padding_left: u32,
    /// Font family. Empty string = inherit the app base font.
    #[serde(default)]
    pub font_family: String,
    #[serde(default = "default_view_font_size")]
    pub font_size: u16,
}

impl Default for ViewerSettings {
    fn default() -> Self {
        Self {
            padding_top: 8,
            padding_right: 8,
            padding_bottom: 8,
            padding_left: 8,
            font_family: String::new(),
            font_size: 13,
        }
    }
}

/// Direct Remote Mode server settings.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CloudAccessMode {
    /// Preserve the existing signed-in Cloud browser path while also allowing
    /// Android's encrypted routes.
    #[default]
    BrowserAndE2e,
    /// Accept only Android's fixed encrypted relay routes on the Cloud tunnel.
    AndroidE2eOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
    /// IP/CIDR allowlist for remote clients. Add Tailscale IPv4/IPv6 CIDRs when needed.
    #[serde(default = "default_remote_allowed_ips")]
    pub allowed_ips: Vec<String>,
    /// Reject direct remote clients whose observed source IP is outside the
    /// Tailscale CGNAT/ULA ranges. Cloud tunnel requests are transport-authenticated
    /// separately and do not pass through this direct-peer gate.
    #[serde(default)]
    pub tailscale_only: bool,
    /// Bearer token for remote browser clients. Required when remote is enabled.
    #[serde(default)]
    pub auth_token: String,
    /// Seconds before an inactive remote controller lease expires.
    #[serde(default = "default_remote_heartbeat_timeout_seconds")]
    pub heartbeat_timeout_seconds: u64,
    /// Seconds an Android E2E controller lease remains reserved after the app
    /// enters the background. 0 releases it immediately; capped at 15 minutes.
    #[serde(default = "default_android_background_lease_seconds")]
    pub android_background_lease_seconds: u64,
    /// App window width at or below which the Remote Access modal opens automatically. 0 disables.
    #[serde(default = "default_remote_auto_mobile_mode_min_width")]
    pub auto_mobile_mode_min_width: u32,
    /// Max KiB of recent output replayed to a remote client on terminal attach.
    #[serde(default = "default_remote_snapshot_max_kib")]
    pub snapshot_max_kib: u32,
    /// Terminal cell font size used only by the Remote surface.
    #[serde(default = "default_remote_terminal_font_size")]
    pub terminal_font_size: u16,
    /// Text size for the Remote input composer and its suggestions.
    #[serde(default = "default_remote_composer_font_size")]
    pub composer_font_size: u16,
    /// Preferred host for copyable remote URLs. Empty = auto-select the first candidate.
    #[serde(default)]
    pub preferred_host: String,
    /// User-managed host names or IPs that are offered alongside detected candidates.
    #[serde(default)]
    pub custom_hosts: Vec<String>,
    /// Cloud relay connection is enabled for the current desktop instance.
    #[serde(default)]
    pub cloud_enabled: bool,
    /// Cloud relay base URL used for desktop pairing.
    #[serde(default = "default_cloud_relay_base_url")]
    pub relay_base_url: String,
    /// Instance ID assigned by the cloud relay after pairing.
    #[serde(default)]
    pub cloud_instance_id: Option<String>,
    /// WSS tunnel URL assigned by the cloud relay after pairing.
    #[serde(default)]
    pub cloud_tunnel_url: Option<String>,
    /// Canonical server base URL returned by the relay after pairing.
    #[serde(default)]
    pub cloud_server_base_url: Option<String>,
    /// Reconnect to the cloud relay automatically on startup when credentials exist.
    #[serde(default = "default_cloud_auto_reconnect")]
    pub cloud_auto_reconnect: bool,
    /// Which data-plane surfaces the Cloud WSS tunnel accepts. Local/Tailscale
    /// Direct Remote is governed separately.
    #[serde(default)]
    pub cloud_access_mode: CloudAccessMode,
    /// Send the desktop terminal font file to remote browsers so they render the
    /// same glyphs and cell metrics (ADR-0077). Off by default: serving a font
    /// binary over the network is redistribution, and OS-bundled fonts such as
    /// Consolas are not redistributable.
    #[serde(default)]
    pub serve_terminal_font: bool,
    /// Mirror the desktop's placed widgets onto the remote client (ADR-0124).
    /// On by default — with no widget placed the remote strip has zero height,
    /// so the cost of the default is nothing. Turning it off drops the surface
    /// on a device where a screen row matters more, and never touches placement.
    #[serde(default = "default_remote_widgets")]
    pub widgets: bool,
    /// Wheel scroll multiplier for the Remote browser terminal (xterm
    /// `scrollSensitivity`). Separate from `terminal.scrollSensitivity`: the
    /// remote client is a different device with its own pointer.
    #[serde(default = "default_scroll_sensitivity")]
    pub scroll_sensitivity: f32,
    /// Remote wheel multiplier while the fast-scroll modifier (Alt) is held
    /// (xterm `fastScrollSensitivity`).
    #[serde(default = "default_fast_scroll_sensitivity")]
    pub fast_scroll_sensitivity: f32,
    /// Multiplier for **one-finger** finger-drag scrollback on the Remote
    /// surface. 1 keeps the 1:1 physical scroll the gesture starts out as;
    /// above 1 the content moves further than the finger. Not an xterm option —
    /// the Remote page owns this gesture and converts pixels to lines itself.
    #[serde(default = "default_scroll_sensitivity")]
    pub touch_scroll_sensitivity: f32,
    /// Multiplier for **two-finger** finger-drag scrollback on the Remote
    /// surface. Separate from the one-finger value so a two-finger swipe can
    /// cover more scrollback per drag; defaults to the fast-scroll factor (5).
    /// Same pixel→line path as `touch_scroll_sensitivity`, not an xterm option.
    #[serde(default = "default_fast_scroll_sensitivity")]
    pub two_finger_scroll_sensitivity: f32,
}

fn default_remote_bind_address() -> String {
    "0.0.0.0".into()
}

fn default_remote_allowed_ips() -> Vec<String> {
    vec!["127.0.0.1/32".into(), "::1/128".into()]
}

fn default_remote_heartbeat_timeout_seconds() -> u64 {
    DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS
}

pub const MAX_ANDROID_BACKGROUND_LEASE_SECONDS: u64 = 15 * 60;

fn default_android_background_lease_seconds() -> u64 {
    MAX_ANDROID_BACKGROUND_LEASE_SECONDS
}

fn default_remote_auto_mobile_mode_min_width() -> u32 {
    720
}

fn default_remote_snapshot_max_kib() -> u32 {
    DEFAULT_REMOTE_SNAPSHOT_MAX_KIB
}

pub const REMOTE_FONT_SIZE_MIN: u16 = 6;
pub const REMOTE_FONT_SIZE_MAX: u16 = 72;
pub const DEFAULT_REMOTE_TERMINAL_FONT_SIZE: u16 = 14;
pub const DEFAULT_REMOTE_COMPOSER_FONT_SIZE: u16 = 16;

fn default_remote_terminal_font_size() -> u16 {
    DEFAULT_REMOTE_TERMINAL_FONT_SIZE
}

fn default_remote_composer_font_size() -> u16 {
    DEFAULT_REMOTE_COMPOSER_FONT_SIZE
}

fn default_cloud_auto_reconnect() -> bool {
    true
}

fn default_remote_widgets() -> bool {
    true
}

/// Prod cloud relay base URL (release-build default). LIVE, TLS via Let's Encrypt.
pub const PROD_CLOUD_RELAY_BASE_URL: &str = "https://app.laymux.com";

/// Local cloud relay base URL (dev/debug-build default) for the local relay server.
pub const DEV_CLOUD_RELAY_BASE_URL: &str = "http://127.0.0.1:8000";

/// Legacy placeholder relay URL persisted by older builds (ADR-0023). Dead host;
/// migrated to the current build default on load so cloud connect stops opening it.
pub const LEGACY_CLOUD_RELAY_PLACEHOLDER: &str = "https://cloud.laymux.example";

pub fn default_cloud_relay_base_url() -> String {
    // dev builds default to the local relay server for testing; release builds
    // default to prod. Mirrors the dev/prod split used for the automation port
    // (19281/19280 via `debug_assertions`). Overridable in settings, and any
    // value already persisted in settings.json is kept (serde default only
    // fills an absent field).
    if cfg!(debug_assertions) {
        DEV_CLOUD_RELAY_BASE_URL.into()
    } else {
        PROD_CLOUD_RELAY_BASE_URL.into()
    }
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            bind_address: default_remote_bind_address(),
            allowed_origins: Vec::new(),
            allowed_ips: default_remote_allowed_ips(),
            tailscale_only: false,
            auth_token: String::new(),
            heartbeat_timeout_seconds: default_remote_heartbeat_timeout_seconds(),
            android_background_lease_seconds: default_android_background_lease_seconds(),
            auto_mobile_mode_min_width: default_remote_auto_mobile_mode_min_width(),
            snapshot_max_kib: default_remote_snapshot_max_kib(),
            terminal_font_size: default_remote_terminal_font_size(),
            composer_font_size: default_remote_composer_font_size(),
            preferred_host: String::new(),
            custom_hosts: Vec::new(),
            cloud_enabled: false,
            relay_base_url: default_cloud_relay_base_url(),
            cloud_instance_id: None,
            cloud_tunnel_url: None,
            cloud_server_base_url: None,
            cloud_auto_reconnect: default_cloud_auto_reconnect(),
            cloud_access_mode: CloudAccessMode::default(),
            serve_terminal_font: false,
            widgets: default_remote_widgets(),
            scroll_sensitivity: default_scroll_sensitivity(),
            fast_scroll_sensitivity: default_fast_scroll_sensitivity(),
            touch_scroll_sensitivity: default_scroll_sensitivity(),
            two_finger_scroll_sensitivity: default_fast_scroll_sensitivity(),
        }
    }
}

/// Dock pane definition (persisted view config with position).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
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
    /// Claude usage monitor settings.
    #[serde(default)]
    pub usage: UsageSettings,
    /// Status widget placement for the top bar and the status line.
    #[serde(default)]
    pub widgets: WidgetsSettings,
    /// Dock behavior settings (distinct from the structural `docks` array).
    #[serde(default)]
    pub dock: DockSettings,
    #[serde(default)]
    pub notifications: NotificationSettings,
    #[serde(default)]
    pub power: PowerSettings,
    #[serde(default)]
    pub workspace_selector: WorkspaceSelectorSettings,
    #[serde(default)]
    pub claude: ClaudeSettings,
    #[serde(default)]
    pub codex: CodexSettings,
    #[serde(default)]
    pub grok: GrokSettings,
    #[serde(default)]
    pub exit: ExitSettings,
    #[serde(default)]
    pub pane_clear: PaneClearSettings,
    #[serde(default)]
    pub memo: MemoSettings,
    #[serde(default)]
    pub issue_reporter: IssueReporterSettings,
    #[serde(default)]
    pub file_explorer: FileExplorerSettings,
    #[serde(default)]
    pub viewer: ViewerSettings,
    #[serde(default)]
    pub github: GithubSettings,
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
            usage: UsageSettings::default(),
            widgets: WidgetsSettings::default(),
            dock: DockSettings::default(),
            notifications: NotificationSettings::default(),
            power: PowerSettings::default(),
            workspace_selector: WorkspaceSelectorSettings::default(),
            claude: ClaudeSettings::default(),
            codex: CodexSettings::default(),
            grok: GrokSettings::default(),
            exit: ExitSettings::default(),
            pane_clear: PaneClearSettings::default(),
            memo: MemoSettings::default(),
            issue_reporter: IssueReporterSettings::default(),
            file_explorer: FileExplorerSettings::default(),
            viewer: ViewerSettings::default(),
            github: GithubSettings::default(),
            remote: RemoteSettings::default(),
            sync_cwd_defaults: None,
            workspace_display_order: Vec::new(),
        }
    }
}
