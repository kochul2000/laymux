use std::time::Duration;

// ── OS credential-store names ────────────────────────────────────

pub const KEYRING_SERVICE: &str = "laymux";
pub const KEYRING_SERVICE_DEV: &str = "laymux-dev";
pub const ANDROID_PAIRING_KEYRING_ACCOUNT: &str = "android-pairing-v1";

// ── Tauri event names ──────────────────────────────────────────────
// These must match the frontend `listen()` / `useAutomationBridge` strings.

pub const EVENT_SYNC_CWD: &str = "sync-cwd";
pub const EVENT_SYNC_BRANCH: &str = "sync-branch";
pub const EVENT_LX_NOTIFY: &str = "lx-notify";
pub const EVENT_SET_TAB_TITLE: &str = "set-tab-title";
pub const EVENT_COMMAND_STATUS: &str = "command-status";
pub const EVENT_OPEN_FILE: &str = "open-file";
pub const EVENT_CLAUDE_TERMINAL_DETECTED: &str = "claude-terminal-detected";
pub const EVENT_AUTOMATION_REQUEST: &str = "automation-request";
pub const EVENT_TERMINAL_CWD_CHANGED: &str = "terminal-cwd-changed";
pub const EVENT_TERMINAL_TITLE_CHANGED: &str = "terminal-title-changed";
pub const EVENT_CLAUDE_MESSAGE_CHANGED: &str = "claude-message-changed";
pub const EVENT_TERMINAL_OUTPUT_ACTIVITY: &str = "terminal-output-activity";
pub const EVENT_REMOTE_CONTROL_CHANGED: &str = "remote-control-changed";
/// A Claude usage probe published a new snapshot (ADR-0102).
pub const EVENT_USAGE_SNAPSHOT_CHANGED: &str = "usage-snapshot-changed";
/// A Grok usage probe published a new snapshot (ADR-0156).
pub const EVENT_GROK_USAGE_SNAPSHOT_CHANGED: &str = "grok-usage-snapshot-changed";
/// Emitted when the OS sleep inhibitor state changes without a request having
/// asked for it — the watchdog re-acquiring or losing one (ADR-0114).
pub const EVENT_SLEEP_INHIBIT_CHANGED: &str = "sleep-inhibit-changed";
pub const EVENT_APP_UPDATE_STATUS_CHANGED: &str = "app-update-status-changed";
pub const GITHUB_UPDATE_HOST: &str = "github.com";
pub const GITHUB_UPDATE_OWNER: &str = "kochul2000";
pub const GITHUB_UPDATE_REPOSITORY: &str = "laymux";
/// Channel manifests live on a workflow-owned orphan branch; the raw host serves
/// them as the single source of truth for "what is newest on this channel"
/// (ADR-0190). GitHub has no stable alias for the latest prerelease.
pub const UPDATE_CHANNEL_MANIFEST_BRANCH: &str = "release-channels";
pub const UPDATE_CHANNEL_MANIFEST_HOST: &str = "raw.githubusercontent.com";
/// Fired when the OS remote-desktop (RDP / Terminal Services) session state of
/// the laymux process flips. Payload is a bool: `true` while the window is being
/// viewed over a remote session. The UI uses it to auto-open the Remote Access
/// panel when the window is entered from a phone RDP client (see
/// `useAutoRemoteAccessPrompt`).
pub const EVENT_REMOTE_SESSION_CHANGED: &str = "remote-session-changed";
pub const EVENT_TERMINAL_OUTPUT_V2_PREFIX: &str = "terminal-output-v2-";
/// Generation-scoped bounded desktop envelope stream (ADR-0095).
pub const EVENT_TERMINAL_OUTPUT_V3_PREFIX: &str = "terminal-output-v3-";
/// Production exact geometry entry remains fail-closed until #636 supplies an
/// OS-proven producer-freeze/drain or kernel byte-epoch adapter (ADR-0085).
pub const EXACT_GEOMETRY_CUTOVER_UNAVAILABLE: &str =
    "exact terminal geometry cutover is unavailable on this PTY backend (follow-up issue #636)";

/// Poll interval for the OS remote-session watcher. RDP connect/disconnect is a
/// rare, human-scale event, so a slow poll keeps the cost negligible.
pub const REMOTE_SESSION_POLL: Duration = Duration::from_secs(2);

// ── Environment variable names ─────────────────────────────────────

pub const ENV_LX_SOCKET: &str = "LX_SOCKET";
pub const ENV_LX_TERMINAL_ID: &str = "LX_TERMINAL_ID";
pub const ENV_LX_GROUP_ID: &str = "LX_GROUP_ID";
pub const ENV_LX_AUTOMATION_PORT: &str = "LX_AUTOMATION_PORT";
pub const ENV_LX_PROPAGATED: &str = "LX_PROPAGATED";
pub const ENV_TERM_PROGRAM: &str = "TERM_PROGRAM";
pub const ENV_TERM_PROGRAM_VERSION: &str = "TERM_PROGRAM_VERSION";
pub const ENV_COLORTERM: &str = "COLORTERM";
pub const ENV_TERM: &str = "TERM";
pub const ENV_NO_COLOR: &str = "NO_COLOR";
pub const ENV_FORCE_COLOR: &str = "FORCE_COLOR";
pub const ENV_WT_SESSION: &str = "WT_SESSION";
pub const ENV_WT_PROFILE_ID: &str = "WT_PROFILE_ID";
pub const ENV_WSLENV: &str = "WSLENV";
/// Claude Code's config directory override. Set on a usage probe PTY so one
/// probe can monitor a non-default profile.
pub const ENV_CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";
/// Grok Build state directory override. Set on a usage probe PTY so one
/// probe can monitor a non-default `$GROK_HOME`.
pub const ENV_GROK_HOME: &str = "GROK_HOME";
/// Codex CLI's state directory override. Session rollout discovery follows it.
pub const ENV_CODEX_HOME: &str = "CODEX_HOME";
/// Codex CLI's SQLite state directory override. Defaults to `CODEX_HOME`.
pub const ENV_CODEX_SQLITE_HOME: &str = "CODEX_SQLITE_HOME";

/// Maximum bytes read from one Codex rollout `session_meta` JSONL header.
pub const CODEX_SESSION_META_MAX_BYTES: usize = 256 * 1024;
/// Codex stores rollout files below `sessions/YYYY/MM/DD`.
pub const CODEX_SESSION_DIRECTORY_DEPTH: u8 = 3;
/// Codex diagnostic DB filename prefixes. Versions are independent.
pub const CODEX_SQLITE_LOG_PREFIX: &str = "logs_";
pub const CODEX_SQLITE_STATE_PREFIX: &str = "state_";
/// Do not wait through shutdown when Codex has an SQLite writer lock.
pub const CODEX_SQLITE_BUSY_TIMEOUT: u64 = 100;
/// Upper bound for each Windows→WSL metadata probe used during session save.
pub const WSL_AGENT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub const TERM_PROGRAM_LAYMUX: &str = "laymux";
pub const COLORTERM_TRUECOLOR: &str = "truecolor";

/// Enable verbose PTY byte-stream tracing (pty↔ui directions, detected
/// escape-sequence signals, printable preview). Off by default — the
/// trace logs are only useful when diagnosing cursor/flicker issues.
pub const ENV_LAYMUX_PTY_TRACE: &str = "LAYMUX_PTY_TRACE";

/// Enables a diagnostic path where the UI tracer ships batched
/// shadow-cursor events to the Rust side via a single `invoke` per
/// `requestAnimationFrame` — the server-side stream is the same
/// `tracing` sink as the PTY trace, so both layers interleave naturally
/// in the log. Only meaningful together with the matching UI gate
/// (`VITE_LAYMUX_CURSOR_TRACE` build flag or
/// `localStorage["laymux:cursor-trace"]="1"` at runtime). Setting
/// `LAYMUX_PTY_TRACE` alone implicitly enables cursor trace collection
/// so the two streams stay correlated.
pub const ENV_LAYMUX_CURSOR_TRACE: &str = "LAYMUX_CURSOR_TRACE";

// ── Timeouts & limits ──────────────────────────────────────────────

/// How long a propagation flag remains valid before expiring.
pub const PROPAGATION_TIMEOUT: Duration = Duration::from_secs(5);

/// Default inactivity window for a browser remote controller lease.
/// This spans several cloud-tunnel reconnect attempts while the host keeps an
/// explicit, immediate reclaim path.
pub const DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS: u64 = 45;

/// Lowest effective remote lease timeout, including for older settings that
/// persisted the former 5-15 second values.
pub const MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS: u64 = 30;

// ── Settings enum values ──────────────────────────────────────────

pub const SETTINGS_LANGUAGES: &[&str] = &["system", "ko", "en"];
pub const APP_THEME_IDS: &[&str] = &["catppuccin-mocha", "dracula", "wsl-dark", "github-light"];
pub const TERMINAL_SCROLLBAR_STYLES: &[&str] = &["overlay", "separate"];
/// xterm parser admission class shares (ADR-0101). Defaults are 5 (focused) /
/// 3 (other visible) / 2 (hidden together); the sum is one admission cycle.
pub const PARSER_ADMISSION_FOCUSED_SHARE_DEFAULT: u32 = 5;
pub const PARSER_ADMISSION_VISIBLE_SHARE_DEFAULT: u32 = 3;
pub const PARSER_ADMISSION_HIDDEN_SHARE_DEFAULT: u32 = 2;
/// A class at zero would pause its parsers, which the lossless contract forbids.
pub const PARSER_ADMISSION_SHARE_MIN: u32 = 1;
/// Bounds the admission cycle a settings file can ask the scheduler to honour.
pub const PARSER_ADMISSION_SHARE_MAX: u32 = 1000;
/// Wheel scroll multipliers handed to xterm (`scrollSensitivity` /
/// `fastScrollSensitivity`). Both surfaces — the desktop terminal and the
/// Remote browser page — share these bounds and defaults, which are xterm's
/// own defaults. xterm rejects a non-positive sensitivity, so the floor is a
/// small positive value rather than 0.
pub const DEFAULT_SCROLL_SENSITIVITY: f32 = 1.0;
pub const DEFAULT_FAST_SCROLL_SENSITIVITY: f32 = 5.0;
pub const MIN_SCROLL_SENSITIVITY: f32 = 0.1;
pub const MAX_SCROLL_SENSITIVITY: f32 = 20.0;
/// Composer past-input history sharing scope (ADR-0055).
pub const COMPOSER_HISTORY_SCOPES: &[&str] = &["global", "workspace", "pane"];
pub const PASTE_PATH_SEPARATORS: &[&str] = &["space", "newline", "comma", "semicolon"];
pub const CONTROL_BAR_MODES: &[&str] = &["hover", "pinned", "minimized"];
pub const NOTIFICATION_DISMISS_MODES: &[&str] = &["workspace", "paneFocus", "manual"];
pub const WORKSPACE_SORT_ORDERS: &[&str] = &["manual", "notification"];
pub const WORKSPACE_LAST_INPUT_MODES: &[&str] = &["perPane", "workspaceLatest"];
/// Update channels a build can follow (ADR-0190). Order is display order.
pub const UPDATE_CHANNELS: &[&str] = &[UPDATE_CHANNEL_STABLE, UPDATE_CHANNEL_BETA];
pub const UPDATE_CHANNEL_STABLE: &str = "stable";
pub const UPDATE_CHANNEL_BETA: &str = "beta";
pub const PROFILE_CURSOR_SHAPES: &[&str] = &[
    "bar",
    "underscore",
    "filledBox",
    "emptyBox",
    "doubleUnderscore",
    "vintage",
];
pub const PROFILE_BELL_STYLES: &[&str] = &["audible", "none", "window", "taskbar", "all"];
pub const PROFILE_CLOSE_ON_EXIT_VALUES: &[&str] = &["automatic", "graceful", "always", "never"];
pub const PROFILE_ANTIALIASING_MODES: &[&str] = &["grayscale", "cleartype", "aliased"];

/// Widget `type` names that may appear in `widgets.*` slots (ADR-0105).
///
/// This is the canonical list the write path validates against; the frontend
/// registry must offer exactly these. A name here is an external contract —
/// renaming one orphans the placements users already saved.
pub const WIDGET_TYPES: &[&str] = &[
    "claudeUsage",
    "codexUsage",
    "grokUsage",
    "terminalActivity",
    "notifications",
    "cwd",
];
/// How a slot sheds widgets when its width budget runs out (ADR-0105).
pub const WIDGET_OVERFLOW_MODES: &[&str] = &["collapse"];
/// Shared widget text size. The upper bound keeps one-line chrome inside the
/// fixed 28 px top/status bars while still allowing a clearly larger label.
pub const WIDGET_FONT_SIZE_MIN: u64 = 6;
pub const WIDGET_FONT_SIZE_MAX: u64 = 20;
pub const WIDGET_FONT_SIZE_DEFAULT: u16 = 9;
/// Rendering styles a usage widget may pick. The rows themselves stay owned by
/// `usage.*.visibleRows` (ADR-0103), so this only decides how each row is drawn.
pub const USAGE_WIDGET_DISPLAY_MODES: &[&str] = &["bar", "number", "both"];
/// Which terminals a `terminalActivity` widget counts.
pub const TERMINAL_ACTIVITY_WIDGET_SCOPES: &[&str] = &["workspace", "all"];
/// Bar thickness a usage widget may ask for, in px. The floor is 1 because a
/// zero-height bar is an invisible one; the ceiling keeps a widget inside the
/// single row every surface gives it.
pub const USAGE_WIDGET_BAR_HEIGHT_MIN: u64 = 1;
pub const USAGE_WIDGET_BAR_HEIGHT_MAX: u64 = 10;
/// Width of each consumed/elapsed track in a usage widget, in px.
pub const USAGE_WIDGET_BAR_WIDTH_MIN: u64 = 8;
pub const USAGE_WIDGET_BAR_WIDTH_MAX: u64 = 200;

/// Maximum number of notifications to keep. When exceeded, oldest read
/// notifications are evicted first. Unread notifications are never evicted.
pub const MAX_NOTIFICATIONS: usize = 500;

/// Maximum number of bytes to write to a PTY in a single `write_all()` call.
/// ConPTY on Windows can silently truncate large writes; chunking prevents this.
pub const PTY_WRITE_CHUNK_SIZE: usize = 1024;

/// Maximum queued PTY input/resize jobs per terminal.
pub const PTY_CONTROL_QUEUE_CAPACITY: usize = 64;
/// Maximum age of the generation-local ConPTY bootstrap Primary DA exchange.
/// A later replay reply could land in the shell's input editor after ConPTY has
/// already abandoned its startup query, so the backend drops it fail-closed.
pub const TERMINAL_BOOTSTRAP_DA_REPLY_MAX_AGE_MS: u64 = 2_500;
/// End-to-end deadline for a human PTY input or resize job.
pub const PTY_CONTROL_JOB_TIMEOUT_MS: u64 = 15_000;
/// Poll cadence used while waiting for owner cancellation or worker completion.
pub const PTY_CONTROL_WAIT_POLL_MS: u64 = 10;
/// Delay inserted between the input body and the submit carriage return so a
/// TUI (Codex/Claude Code) or shell (PowerShell/PSReadLine, WSL) registers the
/// CR as a distinct Enter keypress instead of folding it into a bracketed paste
/// of the body. Sending them fused makes the line get typed but never submitted
/// until a second lone CR arrives (#490; the MCP write path already splits this
/// way per #314). Harmless where unneeded — only adds latency.
pub const ENTER_SUBMIT_CR_DELAY_MS: u64 = 300;
/// Grace after cancellation before the PTY is faulted and terminated.
pub const PTY_CONTROL_CANCEL_GRACE_MS: u64 = 250;
/// Final bounded wait for the platform worker to acknowledge PTY termination.
pub const PTY_CONTROL_TERMINATE_GRACE_MS: u64 = 250;
/// Bound for an interruptible PTY reader to acknowledge a generation wake.
pub const PTY_READER_WAKE_TIMEOUT_MS: u64 = 500;
/// Bound for the generation-scoped reader lifecycle to reach terminal state
/// after the PTY master/child teardown has been requested.
pub const PTY_READER_EXIT_TIMEOUT_MS: u64 = 1_000;
/// Shared upper bound for one owner transition, including worker polling,
/// cancellation grace, terminal teardown, and scheduler slack.
pub const REMOTE_OWNER_TRANSITION_TIMEOUT_MS: u64 = 750;

/// Maximum complete physical payload accepted by the human structured-input
/// API, including bracketed-paste markers and an optional submit CR.
pub const TERMINAL_STRUCTURED_INPUT_MAX_BYTES: usize = 1024 * 1024;

/// Maximum decoded image/text payload accepted by one Remote terminal attachment.
/// One MiB remains below the Android E2E RPC envelope after both base64 layers.
pub const REMOTE_TERMINAL_ATTACHMENT_MAX_BYTES: usize = 1024 * 1024;
/// Maximum regular-file bytes retained in the app-owned Remote attachment cache.
pub const REMOTE_TERMINAL_ATTACHMENT_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Maximum regular-file count retained in the Remote attachment cache. This
/// also bounds zero-byte attachments and the cost of cache scans.
pub const REMOTE_TERMINAL_ATTACHMENT_CACHE_MAX_FILES: usize = 1024;
/// JSON envelope bound for one base64-encoded Remote terminal attachment.
pub const REMOTE_TERMINAL_ATTACHMENT_REQUEST_MAX_BYTES: usize = 1536 * 1024;
/// Startup cleanup age for Remote attachment cache files.
pub const REMOTE_TERMINAL_ATTACHMENT_MAX_AGE_DAYS: u64 = 7;

/// Delay suggested to a Remote client when a Local human-input operation is
/// already draining ahead of its claim reservation.
pub const REMOTE_CLAIM_RETRY_AFTER_MS: u64 = 25;

/// Short lease for a one-shot claim reservation returned with `input_busy`.
/// Each authenticated retry with the matching token renews this lifetime while
/// older Local input is still draining; an abandoned browser therefore blocks
/// new Local input for at most this bounded interval.
pub const REMOTE_CLAIM_RESERVATION_TTL_MS: u64 = 2_000;

/// Base live source bytes accepted ahead of the desktop's contiguous parsed ACK.
pub const TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES: usize = 512 * 1024;
/// Maximum materialized payload carried by one desktop v3 envelope.
pub const TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES: usize = 64 * 1024;
/// Maximum number of physical PTY deltas represented by one v3 envelope.
pub const TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS: usize = 8 * 1024;
/// Strict compact-JSON ceiling for one serialized v3 envelope.
pub const TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES: usize = 1024 * 1024;
/// Quiet batching interval before a non-full envelope is emitted.
pub const TERMINAL_OUTPUT_ENVELOPE_QUIET_MS: u64 = 4;
/// Maximum batching delay before a non-full envelope is emitted.
pub const TERMINAL_OUTPUT_ENVELOPE_MAX_DELAY_MS: u64 = 16;
/// Server-side bound for a lost envelope receipt or continuation control.
///
/// This is deliberately longer than the frontend's 5 s control watchdog. It
/// covers one bounded 5 s WebView stall, the pull watchdog's 3 s recovery
/// interval, one 15 s repair invoke, the worst-case hold -> close -> receipt
/// FIFO (3 * 5 s), and 2 s of scheduling margin (ADR-0126).
pub const TERMINAL_OUTPUT_SERVER_DELIVERY_EXPIRY_MS: u64 = 40_000;
/// Bound for one synchronous desktop event-emitter call.
pub const TERMINAL_OUTPUT_ENVELOPE_EMITTER_CALL_TIMEOUT_MS: u64 = 5_000;
/// Bound for joining the desktop delivery workers after close/retirement.
pub const TERMINAL_OUTPUT_DELIVERY_WORKER_SHUTDOWN_TIMEOUT_MS: u64 = 5_000;
/// Maximum direct-event head start before an exact pull may return its envelope.
pub const TERMINAL_OUTPUT_ENVELOPE_DIRECT_EVENT_GRACE_MAX_MS: u64 = 1_000;
/// Total attempts for one immutable envelope before emit fail-stop.
pub const TERMINAL_OUTPUT_ENVELOPE_EMIT_MAX_ATTEMPTS: usize = 3;
pub const TERMINAL_OUTPUT_ENVELOPE_REPAIR_MAX_ATTEMPTS: u8 = 3;
pub const EVENT_TERMINAL_OUTPUT_FAIL_STOPPED: &str = "terminal-output-fail-stopped";
/// Interruptible delay between exact retries of the same envelope.
pub const TERMINAL_OUTPUT_ENVELOPE_EMIT_RETRY_MS: u64 = 5;
/// Maximum bytes in one normal DECSET 2026 frame continuation, opener through terminator.
pub const TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES: usize = 1024 * 1024;
/// One platform PTY callback can already own this many bytes when a credit edge is observed.
pub const TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES: usize = crate::pty::PTY_READ_BUFFER_BYTES;
/// Lossless desktop retention bound from ADR-0095: B + F + two read-boundary overshoots.
pub const TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES: usize =
    TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES
        + TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES
        + 2 * TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES;
/// Bytes retained in each generation-scoped terminal output ring.
pub const TERMINAL_OUTPUT_RING_MAX_BYTES: usize = TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES;
/// Backwards-compatible name for the base desktop parsed-credit window.
pub const TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES: usize =
    TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES;
/// A desktop attach can carry the complete retained, unparsed prefix without truncation.
pub const TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES: usize = TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES;

/// Default scrollback budget (KiB) for the reconstructable screen checkpoint
/// sent to a Remote client on terminal attach.
pub const DEFAULT_REMOTE_SNAPSHOT_MAX_KIB: u32 = 4;

/// Effective bounds for `remote.snapshotMaxKib`. The upper bound matches the
/// serialized checkpoint hard cap. The current viewport, alternate buffer and
/// restore modes remain mandatory even when their minimum serialization is
/// larger than the configured soft budget.
pub const MIN_REMOTE_SNAPSHOT_MAX_KIB: u32 = 1;
pub const MAX_REMOTE_SNAPSHOT_MAX_KIB: u32 = 1024;
/// Absolute serialized xterm checkpoint limit, independent of its soft
/// scrollback budget.
pub const REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES: usize = 1024 * 1024;

/// Maximum source bytes returned by one Remote FileViewer render request.
/// The frontend may expand images through base64 and preview documents, so the
/// source cap stays deliberately small and is enforced before image reads.
pub const MAX_REMOTE_FILE_VIEWER_BYTES: usize = 8 * 1024 * 1024;

/// Maximum Unicode scalar count accepted from one Remote terminal selection
/// before the desktop path-link parser runs. This matches the maximum valid
/// `terminal.pathLinkMaxLength` setting.
pub const MAX_REMOTE_PATH_LINK_SELECTION_CHARS: usize = 4096;

/// Maximum lines accepted from one Remote terminal selection, matching the
/// desktop selection parser's line cap (ADR-0148).
pub const MAX_REMOTE_PATH_LINK_SELECTION_LINES: usize = 8;

/// Maximum paths accepted by one `stat_paths` batch. A selection contributes at
/// most 16 candidates (ADR-0148), while a Remote idle screen scan can carry a
/// whole viewport worth of paths (ADR-0188); this is the ceiling on filesystem
/// lookups one batch may perform, not the selection candidate cap.
pub const MAX_PATH_LINK_CANDIDATES: usize = 64;

/// Maximum terminal rows the Remote idle scan may send as one screen, and the
/// candidate cap applied to it. Beyond these the scan drops the tail rather
/// than abandoning the screen (ADR-0188).
pub const MAX_REMOTE_PATH_LINK_SCREEN_LINES: usize = 64;

/// Maximum Unicode scalar count accepted across all lines of one Remote idle
/// screen scan request.
pub const MAX_REMOTE_PATH_LINK_SCREEN_CHARS: usize = 8192;

/// Maximum Unicode scalar count accepted for the terminal id attached to a
/// Remote path-link validation request. Runtime terminal ids are much shorter;
/// this only prevents an authenticated client from forwarding an unbounded id
/// through the async frontend bridge.
pub const MAX_REMOTE_PATH_LINK_TERMINAL_ID_CHARS: usize = 256;

/// Secret-capability header required by Remote FileViewer endpoints.
pub const REMOTE_FILE_VIEWER_CAPABILITY_HEADER: &str = "x-laymux-remote-file-viewer";

/// Source bytes the desktop FileViewer reads when the caller names no limit.
/// Remote always passes `MAX_REMOTE_FILE_VIEWER_BYTES` instead; this is the
/// in-process default, so it only has to stay under "instant to render".
pub const DEFAULT_FILE_VIEWER_BYTES: usize = 1024 * 1024;

/// Largest PDF the desktop viewer inlines as a base64 data URL. Past this the
/// viewer reports the file as binary and offers to open it in the host app —
/// base64 inflates by a third and the whole string crosses the IPC boundary,
/// so a large PDF costs far more than it looks.
pub const MAX_INLINE_PDF_BYTES: u64 = 32 * 1024 * 1024;

/// Archive entries listed in one viewer response. Past this the listing reports
/// itself truncated together with the real total, so a jar with 50k class files
/// stays readable instead of freezing the pane.
pub const MAX_ARCHIVE_ENTRIES: usize = 5_000;

/// Inflated bytes a `.tar.gz` listing may consume while walking headers. Only
/// the gzip layer is decompressed and only far enough to read 512-byte headers,
/// but a crafted archive can inflate without ever ending — this bounds it.
pub const MAX_ARCHIVE_INFLATE_BYTES: u64 = 256 * 1024 * 1024;

/// Number of bytes to scan from the end of a terminal output buffer when
/// detecting activity state or Claude Code presence. 16KB covers terminal
/// title sequences even when OSC 133 markers have scrolled out.
pub const ACTIVITY_SCAN_BYTES: usize = 16384;

/// Maximum bytes to scan forward from a Claude Code status marker (● or ·)
/// to extract message text. TUI cursor-addressing can spread text across many bytes.
pub const STATUS_MESSAGE_SCAN_BYTES: usize = 500;

/// DEC 2026 Synchronized Output set sequence: ESC [ ? 2 0 2 6 h
/// TUI apps (Claude Code, neovim) send this before each frame redraw.
/// Shell commands never use it, making it a high-confidence activity signal.
pub const DEC_SYNC_OUTPUT_SET: &[u8] = b"\x1b[?2026h";

// ── MCP (Model Context Protocol) ──────────────────────────────────

pub const MCP_SERVER_NAME: &str = "laymux";

/// MCP Resource URIs.
///
/// Resources provide read-only, subscribable views of IDE state for MCP clients.
/// The full URI for a parameterized resource follows the pattern
/// `terminal://{terminal_id}` / `terminal://{terminal_id}/output`.
pub const MCP_URI_WORKSPACE_ACTIVE: &str = "workspace://active";
pub const MCP_URI_WORKSPACE_LIST: &str = "workspace://list";
pub const MCP_URI_PROFILE_LIST: &str = "profile://list";

/// Scheme prefixes used when parsing resource URIs.
pub const MCP_SCHEME_TERMINAL: &str = "terminal://";
pub const MCP_SCHEME_WORKSPACE: &str = "workspace://";
pub const MCP_SCHEME_PROFILE: &str = "profile://";

/// Tauri event broadcast whenever any workspace state (list, active, panes)
/// changes. The MCP resource bridge listens for this to emit
/// `notifications/resources/updated` on subscribed workspace:// URIs.
pub const EVENT_WORKSPACE_STATE_CHANGED: &str = "workspace-state-changed";

/// Tauri event broadcast whenever the set of live terminals changes (a terminal
/// is created or closed). The MCP resource bridge listens for this to emit
/// `notifications/resources/list_changed` to every connected peer so clients
/// re-query `resources/list` and discover new / removed `terminal://{id}` URIs.
pub const EVENT_TERMINALS_LIST_CHANGED: &str = "terminals-list-changed";

/// Fallback delay (ms) to arm the notify gate for shells without preexec
/// (e.g., PowerShell which doesn't emit OSC 133;C/E). After this delay,
/// notifications are enabled even without observing a user command.
pub const NOTIFY_GATE_FALLBACK_MS: u64 = 3000;

/// Grace window for preserving a previously detected interactive app when the
/// current title evaluation returns `None` (issue #237).
///
/// TUI apps (Claude Code, Codex, etc.) periodically emit OSC 0/2 title updates
/// that do not carry the app name:
///   - Path-like titles (`~/project`, `C:\Users\...`, `//wsl.localhost/...`)
///     are rejected outright by `detect_interactive_app_from_title`.
///   - Braille / star spinner titles appear before the output buffer has
///     accumulated the "Claude Code" / "OpenAI Codex" banner string that
///     `known_*_terminals` relies on.
///   - PowerShell's `prompt` function rewrites the window title on every
///     keystroke while Claude is running.
///
/// Within this window after the last successful detection, the live-title
/// detector keeps returning the previously detected app instead of `None`,
/// so the frontend never briefly sees `interactiveApp: null` and flips the
/// workspace icon back to "shell". New detections (including transitions
/// to a different app) refresh the timestamp immediately.
///
/// 5 seconds is long enough to absorb the Claude splash / Codex banner
/// initialization gap observed in practice while staying short enough that
/// a process that actually exited becomes visible quickly. Process-exit
/// integration (child exit signals / OSC 133;D fallback) is tracked as a
/// follow-up to issue #237.
pub const INTERACTIVE_APP_GRACE_WINDOW: Duration = Duration::from_secs(5);

// ── Activity reconcile (ADR-0135) ──────────────────────────────────

/// Event carrying the panes whose authoritative activity no longer matches what
/// the backend last published. Payload:
/// `[{ terminalId, activity, activitySequence }]`.
pub const EVENT_TERMINAL_ACTIVITY_RECONCILED: &str = "terminal-activity-reconciled";

/// How often the worker starts a pass. Fixed, not adaptive: this worker also
/// refreshes the WSL guest snapshot, and a guest **negative** stays
/// authoritative only for `WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`. Backing the
/// cadence off past that would let an exited agent's stale banner re-pin the
/// pane through the heuristics between passes, so the ceiling the cadence could
/// back off to is barely above this value anyway (ADR-0135).
///
/// Measured pass-start to pass-start, not as a sleep between passes: the pass
/// itself costs up to `WSL_LIVENESS_PASS_BUDGET`, and counting that on top of a
/// fixed sleep would push the snapshot past the window the invariant below
/// protects.
///
/// Invariant, asserted in `activity_reconcile`:
/// `ACTIVITY_RECONCILE_INTERVAL + WSL_LIVENESS_PASS_BUDGET <= WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`.
pub const ACTIVITY_RECONCILE_INTERVAL: Duration = Duration::from_secs(3);

/// How often the worker forgets what it published and re-publishes everything.
/// The diff only sees backend-side changes, so frontend drift with no backend
/// change behind it would otherwise never be corrected.
pub const ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL: Duration = Duration::from_secs(60);

// ── WSL interactive-app liveness (ADR-0134) ────────────────────────

/// Upper bound for one `wsl.exe --exec` liveness probe.
pub const WSL_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Upper bound for a whole `wsl_liveness::refresh` pass — default-distribution
/// resolution plus every distribution's probe, together.
///
/// A per-probe timeout alone does not bound the pass: resolution can burn one
/// timeout before the first probe starts, and each distribution costs another,
/// so the pass grows with the number of distributions. Since the pass is what
/// separates two published snapshots, an unbounded pass is an unbounded verdict
/// age, and a negative that outlives `WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`
/// degrades to `Unknown` — handing an exited agent's still-resident banner back
/// to the heuristics. Work that does not fit the budget is skipped, which costs
/// those panes a verdict for one pass instead of the freshness of every pane.
pub const WSL_LIVENESS_PASS_BUDGET: Duration = Duration::from_secs(4);

/// How long a published snapshot may assert that **nothing** is running in a
/// pane.
pub const WSL_LIVENESS_AUTHORITATIVE_MAX_AGE: Duration = Duration::from_secs(8);

/// How long a published snapshot may keep asserting that an app **is** running.
/// Longer than the negative window on purpose: a stale positive only delays
/// noticing an exit, while a stale negative would suppress live detection.
pub const WSL_LIVENESS_POSITIVE_MAX_AGE: Duration = Duration::from_secs(20);

/// How long the resolved default WSL distribution is reused. Resolving it is a
/// second `wsl.exe` spawn, and it only changes on `wsl --set-default`.
pub const WSL_DEFAULT_DISTRO_CACHE_TTL: Duration = Duration::from_secs(60);

// ── Sleep prevention (ADR-0114) ────────────────────────────────────

/// How often a held inhibitor is checked for having died behind our back.
///
/// The frontend only calls in on a *change*, so without this a `systemd-inhibit`
/// child killed from outside would stay unnoticed for as long as the user's
/// mode and terminals hold still — which in `always` mode is forever.
pub const SLEEP_INHIBIT_WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);

/// How long a freshly spawned `systemd-inhibit` is watched before its lock
/// is believed.
///
/// `systemd-inhibit` execs fine and *then* exits non-zero when the inhibit
/// call itself fails — no D-Bus session, no seat, a container, a polkit
/// denial. Without this window that failure is indistinguishable from
/// success, and the UI would claim the machine is being kept awake while it
/// sleeps through the user's build.
pub const SLEEP_INHIBIT_SPAWN_GRACE: Duration = Duration::from_millis(300);

/// Step between `try_wait()` checks while watching the child spawn or exit.
pub const SLEEP_INHIBIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// How long the child is given to notice EOF on its stdin before it is killed.
pub const SLEEP_INHIBIT_RELEASE_GRACE: Duration = Duration::from_millis(300);

/// Cap on captured `systemd-inhibit` stderr. Enough for a diagnostic, bounded
/// so a chatty child cannot grow it without limit.
pub const SLEEP_INHIBIT_STDERR_CAPTURE_LIMIT: usize = 4096;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn propagation_timeout_is_positive() {
        assert!(PROPAGATION_TIMEOUT.as_secs() > 0);
    }

    #[test]
    fn event_names_are_kebab_case() {
        let events = [
            EVENT_SYNC_CWD,
            EVENT_SYNC_BRANCH,
            EVENT_LX_NOTIFY,
            EVENT_SET_TAB_TITLE,
            EVENT_COMMAND_STATUS,
            EVENT_OPEN_FILE,
            EVENT_CLAUDE_TERMINAL_DETECTED,
            EVENT_AUTOMATION_REQUEST,
            EVENT_TERMINAL_CWD_CHANGED,
            EVENT_TERMINAL_TITLE_CHANGED,
            EVENT_CLAUDE_MESSAGE_CHANGED,
            EVENT_TERMINAL_OUTPUT_ACTIVITY,
            EVENT_REMOTE_CONTROL_CHANGED,
            EVENT_REMOTE_SESSION_CHANGED,
            EVENT_WORKSPACE_STATE_CHANGED,
            EVENT_TERMINALS_LIST_CHANGED,
        ];
        for name in events {
            assert!(!name.is_empty(), "Event name should not be empty");
            assert!(
                !name.contains(' '),
                "Event '{name}' should not contain spaces"
            );
        }
    }

    #[test]
    fn mcp_resource_uris_have_expected_schemes() {
        assert!(MCP_URI_WORKSPACE_ACTIVE.starts_with(MCP_SCHEME_WORKSPACE));
        assert!(MCP_URI_WORKSPACE_LIST.starts_with(MCP_SCHEME_WORKSPACE));
        assert!(MCP_URI_PROFILE_LIST.starts_with(MCP_SCHEME_PROFILE));
        assert!(MCP_SCHEME_TERMINAL.ends_with("://"));
        assert!(MCP_SCHEME_WORKSPACE.ends_with("://"));
        assert!(MCP_SCHEME_PROFILE.ends_with("://"));
    }

    #[test]
    fn detect_dec_2026_in_pty_chunk() {
        let chunk = b"some text\x1b[?2026h\x1b[1;1Hcontent\x1b[?2026l";
        assert!(chunk
            .windows(DEC_SYNC_OUTPUT_SET.len())
            .any(|w| w == DEC_SYNC_OUTPUT_SET));
    }

    #[test]
    fn no_dec_2026_in_shell_output() {
        let chunk = b"total 42\ndrwxr-xr-x 2 user user 4096\n";
        assert!(!chunk
            .windows(DEC_SYNC_OUTPUT_SET.len())
            .any(|w| w == DEC_SYNC_OUTPUT_SET));
    }

    #[test]
    fn env_names_are_screaming_snake_case() {
        let envs = [
            ENV_LX_SOCKET,
            ENV_LX_TERMINAL_ID,
            ENV_LX_GROUP_ID,
            ENV_LX_AUTOMATION_PORT,
            ENV_LX_PROPAGATED,
            ENV_CODEX_HOME,
            ENV_CODEX_SQLITE_HOME,
        ];
        for name in envs {
            assert!(
                name.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "Env var '{name}' should be SCREAMING_SNAKE_CASE"
            );
        }
    }
}
