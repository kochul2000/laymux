use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::response::{Html, IntoResponse, Redirect, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::{check_remote_base_access, check_remote_enabled, request_is_tunnel_authorized};
use super::internal_error;

/// Gate the page/asset routes, which sit outside the `remote_guard` middleware.
/// Cloud tunnel requests (WSS-authorized) only need the enable gate; direct
/// requests go through the full token/IP/Origin base-access check.
fn remote_page_gate(server: &ServerState, addr: SocketAddr, req: &Request) -> Option<Response> {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return Some(internal_error(err)),
    };
    remote_page_gate_for_settings(&settings, addr, request_is_tunnel_authorized(req))
}

fn remote_page_gate_for_settings(
    settings: &crate::settings::models::RemoteSettings,
    addr: SocketAddr,
    tunnel_authorized: bool,
) -> Option<Response> {
    if tunnel_authorized {
        check_remote_enabled(settings)
    } else {
        check_remote_base_access(settings, addr)
    }
}

pub(crate) async fn remote_page_redirect(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_page_gate(&server, addr, &req) {
        return response;
    }

    Redirect::temporary("/remote/").into_response()
}

pub(crate) async fn remote_page(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_page_gate(&server, addr, &req) {
        return response;
    }

    Html(remote_page_html()).into_response()
}

fn remote_page_html() -> &'static str {
    REMOTE_PAGE_HTML
}

const REMOTE_PAGE_HTML: &str = include_str!("page.html");

#[cfg(test)]
mod tests {
    use super::*;

    use crate::settings::Settings;

    fn remote_settings(enabled: bool, token: &str) -> crate::settings::models::RemoteSettings {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = token.into();
        settings.remote
    }

    #[test]
    fn remote_page_html_contains_remote_bootstrap() {
        let html = remote_page_html();
        assert!(html.contains("Laymux Remote"));
        assert!(html.contains("/remote/vendor/xterm.js"));
        assert!(html.contains("/remote/v1/session/claim"));
        assert!(html.contains("/remote/v1/navigation"));
        assert!(html.contains("/remote/v1/workspaces/active"));
        assert!(html.contains("/remote/v1/terminals/${encodeURIComponent(terminalId)}/focus"));
        assert!(html.contains("/remote/v1/terminals"));
        assert!(html.contains("new WebSocket"));
        assert!(html.contains("new TerminalCtor"));
        assert!(html.contains("terminalOptionsForAppearance"));
        assert!(html.contains("terminalInfo.appearance"));
        assert!(html.contains("inputWriteChain"));
        assert!(html.contains("writeToTerminal(inputTerminalId, inputLeaseId"));
        assert!(html.contains("resizeTerminal(resizeTerminalId, resizeLeaseId"));
        assert!(html.contains("touch-action: none"));
        assert!(html.contains("UX contract: long press"));
        assert!(html.contains("const INTERNAL_TOUCH_LONG_PRESS_DELAY_MS"));
        assert!(html.contains("const INTERNAL_TOUCH_SCROLL_SLOP_PX"));
        assert!(html.contains("function installTouchSelectionBridge(term)"));
        assert!(html.contains("function installSelectionHandles(term)"));
        assert!(html.contains("function isNormalScrollbackMode(term)"));
        assert!(html.contains("function routeOneFingerScroll(term, deltaY, point)"));
        assert!(html.contains("function routeTwoFingerScroll(term, deltaY, point)"));
        assert!(html.contains("function sendTerminalAppScroll(term, deltaY, point)"));
        assert!(html.contains("function handleTouchTap(term, element, point)"));
        assert!(html.contains("function startTouchSelection(term, element, pointerId)"));
        assert!(html.contains("if (!isTouchPointer(event)) return;"));
        assert!(!html.contains("event.isPrimary === false"));
        assert!(html.contains("touchGesture.mode = \"scrolling\""));
        assert!(html.contains("touchGesture.mode = \"selecting\""));
        assert!(html.contains("mode: \"twoFingerScrolling\""));
        assert!(html.contains("triggerTouchTapSelection(term, element, point, 2)"));
        assert!(html.contains("triggerTouchTapSelection(term, element, point, 3)"));
        assert!(html.contains("className = \"touch-selection-handle\""));
        assert!(html.contains("new MouseEvent(type"));
        assert!(html.contains("mouseTrackingMode !== \"none\""));
        assert!(!html.contains("id=\"copySelection\""));
        assert!(html.contains("copySelectionToClipboard"));
        assert!(html.contains("terminal.onSelectionChange(() => {"));
        assert!(html.contains(
            "terminalHost.addEventListener(\"mouseup\", copySelectionAfterInteraction);"
        ));
        assert!(html.contains("if (fallbackCopyText(text)) return;"));
        assert!(html.contains("const terminalShell = document.querySelector(\".terminal-shell\")"));
        assert!(html.contains("resizeObserver.observe(terminalShell)"));
        assert!(html.contains("rect.width < 20 || rect.height < 20"));
        assert!(html.contains("function scheduleTerminalFit(sendResize = true)"));
        assert!(html.contains("function scheduleTerminalRefresh()"));
        assert!(html.contains("function loseRemoteControl(message)"));
        assert!(html.contains("const OUTPUT_RECONNECT_INITIAL_DELAY_MS"));
        assert!(html.contains("const OUTPUT_RECONNECT_MAX_DELAY_MS"));
        assert!(html.contains("function scheduleOutputReconnect(terminalId, outputLeaseId)"));
        assert!(html.contains("function handleHeartbeatError(err)"));
        assert!(html.contains("let heartbeatAbortController = null;"));
        assert!(html.contains("const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 45;"));
        assert!(html.contains("const HEARTBEAT_REQUEST_TIMEOUT_MAX_MS = 4000;"));
        assert!(html.contains("const HEARTBEAT_RETRY_DELAY_MS = 1000;"));
        assert!(html.contains("const TRANSIENT_CONNECTION_NOTICE_DELAY_MS = 2000;"));
        assert!(html.contains("id=\"desktopModeHeader\""));
        assert!(html.contains("id=\"desktopModeDrawer\""));
        assert!(html.contains("const localAppMode ="));
        assert!(html.contains("const autoConnectMode ="));
        assert!(html.contains("clientNameInput.value = clientNameFromParams"));
        assert!(html.contains("function requestDesktopMode()"));
        assert!(
            html.contains("window.parent.postMessage({ type: \"laymux:desktop-mode\" }, \"*\")")
        );
        assert!(html.contains("location.hash.replace"));
        assert!(html.contains("const lostLeaseId = leaseId"));
        assert!(html.contains("releaseLease(lostLeaseId).catch(() => {})"));
        assert!(html.contains("Control returned to the host"));
        assert!(html.contains("connection-panel.attention"));
        assert!(html.contains("Host has control. Connect again to request control."));
        assert!(html.contains("term.write(payload, scheduleTerminalRefresh)"));
        assert!(html.contains("cols < 1 || rows < 1"));
        assert!(html.contains("id=\"navToggle\""));
        assert!(!html.contains("<h1>Laymux Remote</h1>"));
        assert!(html.contains("class=\"drawer-header\""));
        assert!(html.contains("class=\"connection-panel\""));
        assert!(html.contains("Connect first to load workspaces"));
        assert!(html.contains("id=\"workspaceSection\""));
        assert!(html.contains("workspace-item-content"));
        assert!(html.contains("workspace-pane-row"));
        assert!(html.contains("id=\"notificationSection\""));
        assert!(html.contains("id=\"notificationToggle\""));
        assert!(html.contains("id=\"notificationPanel\""));
        assert!(html.contains("id=\"notificationBadge\""));
        assert!(html.contains("renderNotificationPanel(data.notifications || []"));
        assert!(html.contains("/remote/v1/notifications/mark-all-read"));
        assert!(
            html.contains("/remote/v1/notifications/${encodeURIComponent(notification.id)}/read")
        );
        assert!(html.contains("/remote/v1/notifications\","));
        assert!(html.contains("function openNotification(notification)"));
        assert!(!html.contains("id=\"terminals\""));
        assert!(html.contains("id=\"dockSection\""));
        assert!(html.contains("id=\"dockToggle\""));
        assert!(html.contains("id=\"dockPanel\""));
        assert!(html.contains("id=\"dockList\""));
        assert!(html.contains("renderDockList(data.docks || [])"));
        assert!(html.contains("function renderDockTerminalRow(dock, pane)"));
        assert!(html.contains("focusDockHost: true"));
        assert!(html.contains("function isDockTerminalId(terminalId)"));
        assert!(html.contains("options.focusDockHost === true || !isDockTerminalId(terminalId)"));
        assert!(html.contains("function isMainOutputTerminal(data, terminalId)"));
    }

    #[test]
    fn remote_page_html_contains_soft_key_toolbar() {
        let html = remote_page_html();
        // Markup: toolbar row, footer toggle, and the settings popover.
        assert!(html.contains("id=\"keyBar\""));
        assert!(html.contains("id=\"keyBarToggle\""));
        assert!(html.contains("id=\"keyBarSettings\""));
        assert!(html.contains("id=\"keyPopover\""));
        assert!(html.contains("id=\"keyRow\""));
        assert!(html.contains("id=\"keyRow\" class=\"key-row\" role=\"group\" aria-label=\"Special key buttons\">\n          <button id=\"keyBarSettings\""));
        // Config is client-only UI state persisted to localStorage (ADR-0028).
        assert!(html.contains("laymux.remote.keybar"));
        assert!(html
            .contains("const DEFAULT_KEYBAR = { visible: false, sets: [\"nav\"], custom: [] };"));
        // Predefined sets are selectable and a custom palette exists.
        assert!(html.contains("id: \"nav\", name: \"Navigation\""));
        assert!(html.contains("id: \"ctrl\", name: \"Ctrl keys\""));
        assert!(html.contains("id: \"fn\", name: \"Function\""));
        assert!(html.contains("function resolveKeyIds()"));
        assert!(html.contains("function renderKeyPopover()"));
        // Keys reuse the existing write path via enqueueInput, no new API.
        assert!(html.contains("function sendKey(id)"));
        assert!(html.contains("if (seq) enqueueInput(seq);"));
        // Cursor keys (arrows/Home/End) are DECCKM-aware: SS3 in app mode, else CSI.
        assert!(html.contains("up: { label: \"↑\", cursor: \"A\" }"));
        assert!(html.contains("home: { label: \"Home\", cursor: \"H\" }"));
        assert!(html.contains("return (appMode ? \"\\x1bO\" : \"\\x1b[\") + def.cursor;"));
        assert!(html.contains("terminal.modes.applicationCursorKeysMode"));
        // The compact direction pad maps a four-way pointer flick back through the
        // same DECCKM-aware arrow definitions and exposes a pressed-state hint.
        assert!(html.contains("dpad: { label: \"↕↔\", flick: true }"));
        assert!(html.contains("const KEY_FLICK_THRESHOLD_PX = 18;"));
        assert!(html.contains("function directionFromFlick(deltaX, deltaY)"));
        assert!(html.contains("sendKey(direction);"));
        assert!(html.contains("id=\"keyFlickHint\""));
        assert!(html.contains("data-flick-direction=\"up\""));
        assert!(html.contains("data-flick-direction=\"right\""));
        assert!(html.contains("data-flick-direction=\"down\""));
        assert!(html.contains("data-flick-direction=\"left\""));
        // A representative fixed sequence: Tab, Delete, and F1 (SS3).
        assert!(html.contains("tab: { label: \"Tab\", seq: \"\\t\" }"));
        assert!(html.contains("del: { label: \"Del\", seq: \"\\x1b[3~\" }"));
        assert!(html.contains("f1: { label: \"F1\", seq: \"\\x1bOP\" }"));
        // Toggle visibility drives the hidden attribute + persistence.
        assert!(html.contains("function setKeyBarVisible(visible, persist = true)"));
        assert!(html.contains("keyBar.hidden = !visible;"));
    }

    #[test]
    fn remote_page_mobile_layout_tracks_viewport_without_outer_scroll() {
        let html = remote_page_html();

        // Ask supporting mobile browsers to resize layout content for the native keyboard,
        // then use VisualViewport as the cross-browser source for the actual visible height.
        assert!(html.contains("interactive-widget=resizes-content"));
        assert!(html.contains("height: var(--remote-viewport-height, 100%);"));
        assert!(html.contains("function syncRemoteViewportHeight()"));
        assert!(html.contains("const height = remoteVisualViewport ? remoteVisualViewport.height : window.innerHeight;"));
        assert!(html.contains(
            "remoteVisualViewport?.addEventListener(\"resize\", syncRemoteViewportHeight);"
        ));

        // Horizontal scrolling is confined to the toolbar; its intrinsic width must not
        // enlarge the document.
        assert!(html.contains(".key-bar {\n        position: relative;\n        display: flex;\n        width: 100%;\n        min-width: 0;\n        max-width: 100%;"));
        assert!(html.contains("flex-wrap: nowrap;"));
        assert!(html.contains("overflow-x: auto;"));
        assert!(html.contains("scrollbar-width: none;"));
        assert!(html.contains(".key-row::-webkit-scrollbar {\n        display: none;"));
        assert!(html.contains("--key-bar-control-height: 26px;"));

        // Showing or hiding a grid row changes terminal geometry and must trigger a fit
        // even on WebViews whose ResizeObserver delivery is delayed.
        assert!(html.contains("if (persist) saveKeyBarConfig();\n          scheduleTerminalFit();"));
    }

    #[test]
    fn remote_page_activity_badge_colors_match_desktop() {
        let html = remote_page_html();
        // Palette vars ported from ui/src/index.css so badges match the desktop.
        assert!(html.contains("--claude: #d97757;"));
        assert!(html.contains("--codex: #10a37f;"));
        assert!(html.contains("--orange-15: rgba(217, 119, 87, 0.15);"));
        // Per-app badge classes with desktop-matching color + background.
        assert!(html.contains(".pane-activity.claude {\n        color: var(--claude);\n        background: var(--orange-15);\n      }"));
        assert!(html.contains(".pane-activity.codex {\n        color: var(--codex);\n        background: var(--accent-12);\n      }"));
        // running badge background matches desktop (--active-bg, not --accent-12).
        assert!(html.contains(".pane-activity.running {\n        color: var(--yellow);\n        background: var(--active-bg);\n      }"));
        // Class selection mirrors formatActivity: Claude/Codex keep brand hue.
        assert!(html.contains("function activityClass(activity)"));
        assert!(html.contains("if (activity.name === \"Claude\") return \"claude\";"));
        assert!(html.contains("if (activity.name === \"Codex\") return \"codex\";"));
        assert!(html.contains("`pane-activity ${activityClass(pane.activity)}`"));
    }

    #[test]
    fn remote_page_gate_requires_enabled_for_tunnel_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let disabled_settings = remote_settings(false, "");
        let disabled = remote_page_gate_for_settings(&disabled_settings, addr, true).unwrap();
        assert_eq!(disabled.status(), axum::http::StatusCode::FORBIDDEN);

        let enabled_settings = remote_settings(true, "");
        assert!(remote_page_gate_for_settings(&enabled_settings, addr, true).is_none());
    }

    #[test]
    fn remote_page_gate_uses_full_base_access_for_direct_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let settings = remote_settings(true, "");
        let response = remote_page_gate_for_settings(&settings, addr, false).unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn remote_page_terminal_notification_focuses_without_prior_workspace_switch() {
        let html = remote_page_html();
        let start = html.find("async function openNotification").unwrap();
        let end = start
            + html[start..]
                .find("async function focusTerminalOnHost")
                .unwrap();
        let open_notification = &html[start..end];

        let terminal_branch = open_notification
            .find("if (notification.terminalId)")
            .unwrap();
        let workspace_branch = open_notification
            .find("if (notification.workspaceId)")
            .unwrap();

        assert!(terminal_branch < workspace_branch);
        assert!(open_notification.contains("await focusTerminalOnHost(notification.terminalId);"));
        assert!(open_notification.contains("await activateWorkspace(notification.workspaceId);"));
    }

    #[test]
    fn remote_page_reconnects_output_socket_without_releasing_lease() {
        let html = remote_page_html();
        let start = html.find("function scheduleOutputReconnect").unwrap();
        let end = start + html[start..].find("async function connect").unwrap();
        let output_stream = &html[start..end];

        assert!(output_stream.contains("const outputLeaseId = leaseId;"));
        assert!(output_stream.contains("stopSocket(!reconnecting);"));
        assert!(output_stream.contains("scheduleOutputReconnect(terminalId, outputLeaseId);"));
        assert!(output_stream.contains("openOutput(terminalId, { reconnect: true });"));
        assert!(output_stream.contains("scheduleTransientConnectionNotice"));
        assert!(output_stream.contains("let resetOnNextPayload = reconnecting;"));
        assert!(output_stream.contains("if (!reconnecting) term.reset();"));
        assert!(output_stream.contains("if (resetOnNextPayload)"));
        assert!(output_stream.contains("term.reset();"));
        assert!(output_stream.contains("let outputTerminalMissing = false;"));
        assert!(output_stream.contains("payload === \"terminal session not found\""));
        assert!(output_stream.contains("loadNavigation(null).catch"));
        assert!(
            !output_stream.contains("loseRemoteControl("),
            "output WebSocket close is recoverable while heartbeat keeps the lease alive"
        );
        let reconnect_scheduler =
            &output_stream[..output_stream.find("function openOutput").unwrap()];
        assert!(
            !reconnect_scheduler.contains("setStatus("),
            "short output interruptions must stay invisible while reconnecting"
        );
    }

    #[test]
    fn remote_page_heartbeat_tolerates_transient_failures_until_timeout() {
        let html = remote_page_html();
        let start = html.find("function handleHeartbeatError").unwrap();
        let end = start + html[start..].find("function startHeartbeat").unwrap();
        let heartbeat_error = &html[start..end];
        let heartbeat_start = html.find("async function heartbeat").unwrap();
        let heartbeat_end = heartbeat_start
            + html[heartbeat_start..]
                .find("function isFatalRemoteControlError")
                .unwrap();
        let heartbeat_request = &html[heartbeat_start..heartbeat_end];
        let start_heartbeat = &html[html.find("function startHeartbeat").unwrap()..];

        assert!(html.contains("error.status = response.status;"));
        assert!(heartbeat_error.contains("isFatalRemoteControlError(err) || heartbeatTimedOut()"));
        assert!(heartbeat_error.contains("loseRemoteControl(`Control returned to the host."));
        assert!(heartbeat_error.contains("scheduleTransientConnectionNotice(\"heartbeat\")"));
        assert!(heartbeat_error.contains("scheduleHeartbeatRetry()"));
        assert!(heartbeat_request.contains("signal: controller.signal"));
        assert!(heartbeat_request.contains("heartbeatRequestTimeoutMs()"));
        assert!(
            heartbeat_request.contains("setTimeout(() => controller.abort(), requestTimeoutMs)")
        );
        assert!(start_heartbeat.contains("HEARTBEAT_INTERVAL_MAX_MS"));
        assert!(start_heartbeat.contains("Math.min("));
        assert!(!start_heartbeat.contains(
            "loseRemoteControl(\"Control returned to the host. Heartbeat timed out.\");"
        ));
        assert!(start_heartbeat.contains("lastHeartbeatOkAt = Date.now();"));
        assert!(start_heartbeat.contains("handleHeartbeatError(err);"));
    }

    #[test]
    fn remote_page_keeps_dock_navigation_separate_from_workspace_list() {
        let html = remote_page_html();
        let workspace_start = html.find("id=\"workspaceSection\"").unwrap();
        let dock_start = html.find("id=\"dockSection\"").unwrap();
        let script_start = html.find("function renderWorkspaceList").unwrap();
        let script_end = html.find("function renderWorkspaceItem").unwrap();
        let render_workspace_list = &html[script_start..script_end];

        assert!(workspace_start < dock_start);
        assert!(html.contains("function renderDockList(docks)"));
        assert!(html.contains("dockToggleButton.addEventListener"));
        assert!(!render_workspace_list.contains("dockListEl"));
        assert!(!render_workspace_list.contains("renderDockTerminalRow"));
    }

    #[test]
    fn remote_page_prefers_only_visible_dock_terminal_fallbacks() {
        let html = remote_page_html();
        let start = html.find("function preferredTerminal").unwrap();
        let end = start + html[start..].find("async function loadNavigation").unwrap();
        let preferred_terminal = &html[start..end];

        assert!(html.contains(
            "function visibleDockItems(data) {\n          return (data.docks || []).filter((dock) => dock.visible !== false);"
        ));
        assert!(preferred_terminal.contains("for (const dock of visibleDockItems(data))"));
        assert!(!preferred_terminal.contains("for (const dock of data.docks || [])"));
        assert!(!preferred_terminal.contains("return terminals[0] || null"));
    }

    #[test]
    fn remote_page_rejects_hidden_dock_preferred_terminal_ids() {
        let html = remote_page_html();
        let start = html.find("function isMainOutputTerminal").unwrap();
        let end = start + html[start..].find("async function loadNavigation").unwrap();
        let main_output_selection = &html[start..end];
        let preferred_start = html.find("function preferredTerminal").unwrap();
        let preferred_end = preferred_start
            + html[preferred_start..]
                .find("async function loadNavigation")
                .unwrap();
        let preferred_terminal = &html[preferred_start..preferred_end];

        assert!(
            main_output_selection.contains("return visibleDockItems(data).some((dock) =>"),
            "main output gate must inspect only visible dock items"
        );
        assert!(
            main_output_selection
                .contains("(dock.panes || []).some((pane) => pane.terminalId === terminalId && pane.terminalLive)"),
            "hidden dock preferred ids must not bypass pane visibility checks"
        );
        assert!(preferred_terminal.contains(
            "if (preferredTerminalId && isMainOutputTerminal(data, preferredTerminalId))"
        ));
        assert!(
            !preferred_terminal.contains("if (preferredTerminalId) {\n            const existing")
        );
    }

    #[test]
    fn remote_page_auto_claims_on_autoconnect_without_local_app_gate() {
        // The cloud dashboard flow serves the page in an external browser (not
        // localApp), so auto-claim must fire on autoConnect=1 alone — otherwise
        // the user has to click Connect a second time to take control.
        let html = remote_page_html();
        assert!(html.contains("if (autoConnectMode && token()) {"));
        assert!(!html.contains("if (localAppMode && autoConnectMode && token())"));
    }
}
