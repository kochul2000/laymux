use std::time::Duration;

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
/// Fired when the OS remote-desktop (RDP / Terminal Services) session state of
/// the laymux process flips. Payload is a bool: `true` while the window is being
/// viewed over a remote session. The UI uses it to auto-open the Remote Access
/// panel when the window is entered from a phone RDP client (see
/// `useAutoRemoteAccessPrompt`).
pub const EVENT_REMOTE_SESSION_CHANGED: &str = "remote-session-changed";
pub const EVENT_TERMINAL_OUTPUT_V2_PREFIX: &str = "terminal-output-v2-";

/// Poll interval for the OS remote-session watcher. RDP connect/disconnect is a
/// rare, human-scale event, so a slow poll keeps the cost negligible.
pub const REMOTE_SESSION_POLL: Duration = Duration::from_secs(2);

// ── Environment variable names ─────────────────────────────────────

pub const ENV_LX_SOCKET: &str = "LX_SOCKET";
pub const ENV_LX_TERMINAL_ID: &str = "LX_TERMINAL_ID";
pub const ENV_LX_GROUP_ID: &str = "LX_GROUP_ID";
pub const ENV_LX_AUTOMATION_PORT: &str = "LX_AUTOMATION_PORT";
pub const ENV_LX_PROPAGATED: &str = "LX_PROPAGATED";

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
pub const PASTE_PATH_SEPARATORS: &[&str] = &["space", "newline", "comma", "semicolon"];
pub const CONTROL_BAR_MODES: &[&str] = &["hover", "pinned", "minimized"];
pub const NOTIFICATION_DISMISS_MODES: &[&str] = &["workspace", "paneFocus", "manual"];
pub const WORKSPACE_SORT_ORDERS: &[&str] = &["manual", "notification"];
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

/// Maximum number of notifications to keep. When exceeded, oldest read
/// notifications are evicted first. Unread notifications are never evicted.
pub const MAX_NOTIFICATIONS: usize = 500;

/// Maximum number of bytes to write to a PTY in a single `write_all()` call.
/// ConPTY on Windows can silently truncate large writes; chunking prevents this.
pub const PTY_WRITE_CHUNK_SIZE: usize = 1024;

/// Maximum queued PTY input/resize jobs per terminal.
pub const PTY_CONTROL_QUEUE_CAPACITY: usize = 64;
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
/// Shared upper bound for one owner transition, including worker polling,
/// cancellation grace, terminal teardown, and scheduler slack.
pub const REMOTE_OWNER_TRANSITION_TIMEOUT_MS: u64 = 750;

/// Maximum complete physical payload accepted by the human structured-input
/// API, including bracketed-paste markers and an optional submit CR.
pub const TERMINAL_STRUCTURED_INPUT_MAX_BYTES: usize = 1024 * 1024;

/// Delay suggested to a Remote client when a Local human-input operation is
/// already draining ahead of its claim reservation.
pub const REMOTE_CLAIM_RETRY_AFTER_MS: u64 = 25;

/// Short lease for a one-shot claim reservation returned with `input_busy`.
/// Each authenticated retry with the matching token renews this lifetime while
/// older Local input is still draining; an abandoned browser therefore blocks
/// new Local input for at most this bounded interval.
pub const REMOTE_CLAIM_RESERVATION_TTL_MS: u64 = 2_000;

/// Desktop attach returns the retained output ring (currently capped at 1 MiB).
pub const TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES: usize = 1024 * 1024;

/// Default cap (KiB) for the recent-output snapshot replayed to a remote
/// client on terminal attach. Small on purpose: a remote connect or workspace
/// switch should open at the live tail instead of replaying long history.
pub const DEFAULT_REMOTE_SNAPSHOT_MAX_KIB: u32 = 4;

/// Effective bounds for `remote.snapshotMaxKib`. The upper bound matches the
/// retained output ring (1 MiB); the lower bound keeps at least one screen of
/// context so a TUI attach is not visibly empty.
pub const MIN_REMOTE_SNAPSHOT_MAX_KIB: u32 = 1;
pub const MAX_REMOTE_SNAPSHOT_MAX_KIB: u32 = 1024;

/// Maximum source bytes returned by one Remote FileViewer render request.
/// The frontend may expand images through base64 and preview documents, so the
/// source cap stays deliberately small and is enforced before image reads.
pub const MAX_REMOTE_FILE_VIEWER_BYTES: usize = 8 * 1024 * 1024;

/// Maximum Unicode scalar count accepted from one Remote terminal selection
/// before the desktop path-link parser runs. This matches the maximum valid
/// `terminal.pathLinkMaxLength` setting.
pub const MAX_REMOTE_PATH_LINK_SELECTION_CHARS: usize = 4096;

/// Maximum Unicode scalar count accepted for the terminal id attached to a
/// Remote path-link validation request. Runtime terminal ids are much shorter;
/// this only prevents an authenticated client from forwarding an unbounded id
/// through the async frontend bridge.
pub const MAX_REMOTE_PATH_LINK_TERMINAL_ID_CHARS: usize = 256;

/// Secret-capability header required by Remote FileViewer endpoints.
pub const REMOTE_FILE_VIEWER_CAPABILITY_HEADER: &str = "x-laymux-remote-file-viewer";

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
        ];
        for name in envs {
            assert!(
                name.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "Env var '{name}' should be SCREAMING_SNAKE_CASE"
            );
        }
    }
}
