use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header;
use axum::response::{Html, IntoResponse, Redirect, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::{check_remote_base_access, check_remote_enabled, request_is_tunnel_authorized};
use super::internal_error;

/// Gate the page/asset routes, which sit outside the `remote_guard` middleware.
/// Cloud tunnel requests (WSS-authorized) only need the enable gate; direct
/// requests go through the full token/IP/Origin base-access check.
pub(super) fn remote_page_gate(
    server: &ServerState,
    addr: SocketAddr,
    req: &Request,
) -> Option<Response> {
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

    // The page is compiled in via include_str!, so there is no mtime/ETag for
    // revalidation — without this, browsers heuristically cache it and users
    // need a hard refresh after every update.
    (
        [(header::CACHE_CONTROL, "no-store")],
        Html(remote_page_html()),
    )
        .into_response()
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
        assert!(!html.contains("activePointerId !== null || event.isPrimary === false"));
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
        assert!(
            html.contains("document.addEventListener(\"mouseup\", copySelectionAfterInteraction);")
        );
        assert!(!html.contains(
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
        assert!(html.contains("queueTerminalWrite(payload)"));
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
    fn remote_page_html_contains_file_viewer_new_tab_handshake() {
        let html = remote_page_html();
        assert!(html.contains("id=\"fileViewerSection\""));
        assert!(html.contains(
            "id=\"fileViewerPath\" type=\"text\" autocomplete=\"off\" autocapitalize=\"off\""
        ));
        assert!(html.contains("id=\"openFileViewer\" type=\"button\" disabled>Open viewer"));
        assert!(html.contains("id=\"pullHostFileViewerPath\""));
        assert!(html.contains(">From host</button>"));
        assert!(!html.contains("id=\"openCurrentFileViewer\""));
        assert!(!html.contains("id=\"refreshFileViewer\""));
        assert!(!html.contains("id=\"openFileViewerPath\""));
        assert!(!html.contains("let fileViewerPathDirty = false;"));
        assert!(html.contains("let fileViewerStatusRequestRevision = 0;"));
        assert!(html.contains("let fileViewerPathRevision = 0;"));
        assert!(!html.contains("refreshFileViewerStatus().catch(() => {});"));
        assert!(html.contains("/remote/viewer/"));
        assert!(html.contains("laymux:file-viewer-ready"));
        assert!(html.contains("laymux:file-viewer-session"));
        assert!(html.contains("event.origin !== window.location.origin"));
        assert!(html.contains("fileViewerToken: session.fileViewerToken"));
        assert!(html.contains("event.isComposing ||"));
        assert!(html.contains("event.keyCode === 229 ||"));
        assert!(!html.contains("/remote/viewer/?token="));
    }

    #[test]
    fn remote_page_html_contains_selected_file_path_links() {
        let html = remote_page_html();
        assert!(html.contains("/remote/v1/file-viewer/path-link"));
        assert!(html.contains("function evaluatePathLinkSelection()"));
        assert!(html.contains("function schedulePathLinkSelectionEvaluation("));
        assert!(html.contains("const PATH_LINK_SELECTION_DEBOUNCE_MS = 100;"));
        assert!(html.contains("pathLinkAbortController.abort();"));
        assert!(html.contains("const currentPosition = term.getSelectionPosition?.();"));
        assert!(html.contains("mapRemotePathLinkRange(currentPosition, rawFirstLine, data.token)"));
        assert!(html.contains("remote-path-link-decoration"));
        assert!(html.contains("openFileViewerTab(press.path)"));
        assert!(html.contains("clearPathLinkSelection()"));
    }

    #[test]
    fn remote_page_html_contains_jump_to_bottom_button() {
        let html = remote_page_html();

        assert!(html.contains(
            "id=\"scrollToBottom\" class=\"terminal-scroll-to-bottom\" type=\"button\" hidden"
        ));
        assert!(html.contains("aria-label=\"Scroll to bottom\""));
        assert!(html.contains("function isTerminalScrolledUp(term)"));
        assert!(html.contains("function updateScrollToBottomButton(term = terminal)"));
        assert!(html.contains("scrollToBottomButton.addEventListener(\"click\", () => {"));
        assert!(html.contains("terminal.scrollToBottom();"));
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
        assert!(html.contains("const DEFAULT_KEYBAR = {"));
        assert!(html.contains("sets: [\"step\", \"nav\"],"));
        assert!(html.contains("order: KEY_ORDER,"));
        // Predefined sets are selectable and a custom palette exists.
        assert!(html.contains("id: \"nav\", name: \"Navigation\""));
        assert!(html.contains("id: \"ctrl\", name: \"Ctrl keys\""));
        assert!(html.contains("id: \"fn\", name: \"Function\""));
        assert!(html.contains("function resolveKeyIds()"));
        assert!(html.contains("function renderKeyPopover()"));
        // Every enabled key appears in a compact sortable grid. Long-press drag
        // is the primary path; selection exposes keyboard/accessibility moves.
        assert!(html.contains("function moveKey(id, offset)"));
        assert!(html.contains("return keyBarConfig.order.filter((id) => enabled.has(id));"));
        assert!(html.contains("const KEY_ORDER_HOLD_MS = 180;"));
        assert!(html.contains("function installKeyOrderDrag(chip, id)"));
        assert!(html.contains("chip.classList.add(\"dragging\");"));
        assert!(html.contains(
            "target.classList.add(gesture.afterTarget ? \"drop-after\" : \"drop-before\");"
        ));
        assert!(html.contains("title.textContent = \"Key order\";"));
        assert!(html.contains("reset.setAttribute(\"aria-label\", \"Reset key order\");"));
        assert!(html.contains("`Move ${accessibleName} to start`"));
        assert!(html.contains("function appendKeyToVisibleEnd(id, visibleIds)"));
        assert!(html.contains("section.className = \"key-order-section\";"));
        assert!(html.contains("chip.className = \"key-chip key-order-chip\";"));
        // Keys reuse the existing write path via enqueueInput, no new API.
        assert!(html.contains("function sendKey(id, button = null)"));
        assert!(html.contains("if (seq) enqueueInput(seq);"));
        // Pointer/mouse activation must not blur the focused input surface and
        // dismiss an already-open native keyboard (#482). WebKit/iOS only honors
        // mousedown.preventDefault() for this, so both events are guarded via the
        // shared helper. Click remains the accessible send path.
        assert!(html.contains("function preventFocusSteal(event)"));
        assert!(html.contains("function keepInputSurfaceFocus(button)"));
        assert!(html.contains("button.addEventListener(\"mousedown\", preventFocusSteal);"));
        assert!(html.contains("button.addEventListener(\"pointerdown\", preventFocusSteal);"));
        assert!(html.contains("function installSoftKey(button, id)"));
        assert!(html.contains("keepInputSurfaceFocus(button);"));
        assert!(html.contains("button.addEventListener(\"click\", () => sendKey(id, button));"));
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
        assert!(html.contains(
            "installDirectionalFlick(button, onDirection = (direction) => sendKey(direction))"
        ));
        assert!(html.contains("onDirection(direction);"));
        assert!(html.contains("id=\"keyFlickHint\""));
        assert!(html.contains("data-flick-direction=\"up\""));
        assert!(html.contains("data-flick-direction=\"right\""));
        assert!(html.contains("data-flick-direction=\"down\""));
        assert!(html.contains("data-flick-direction=\"left\""));
        // A representative fixed sequence: Tab, Delete, and F1 (SS3).
        assert!(html.contains("tab: { label: \"Tab\", seq: \"\\t\" }"));
        assert!(html.contains("stab: { label: \"⇧Tab\", seq: \"\\x1b[Z\" }"));
        assert!(html.contains("end: { label: \"End\", cursor: \"F\" }"));
        assert!(html.contains("del: { label: \"Del\", seq: \"\\x1b[3~\" }"));
        assert!(html.contains("f1: { label: \"F1\", seq: \"\\x1bOP\" }"));
        // Toggle visibility drives the hidden attribute + persistence.
        assert!(html.contains("function setKeyBarVisible(visible, persist = true)"));
        assert!(html.contains("keyBar.hidden = !visible;"));
    }

    #[test]
    fn remote_page_html_contains_step_navigation_keys() {
        let html = remote_page_html();
        // Step navigation lives INSIDE the soft-key toolbar as a configurable
        // key set (issue #474): no dedicated bar row exists.
        assert!(!html.contains("id=\"navStepBar\""));
        // Nav action keys carry `nav: [kind, direction]` instead of a byte seq.
        assert!(html.contains("navPad: { label: \"P↕N↔\", navFlick: true, navBadge: true }"));
        assert!(html.contains("navPrev: { label: \"P↑\", nav: [\"spatial\", \"prev\"]"));
        assert!(html.contains("navNext: { label: \"P↓\", nav: [\"spatial\", \"next\"]"));
        assert!(html.contains("notifRecent: { label: \"N←\", nav: [\"notification\", \"recent\"]"));
        assert!(html.contains("notifOldest: { label: \"N→\", nav: [\"notification\", \"oldest\"]"));
        // Selectable via the key-set popover and enabled by default.
        assert!(html.contains("id: \"step\", name: \"Pane/Alert nav\""));
        assert!(html.contains("sets: [\"step\", \"nav\"],"));
        // 4-way nav flick: vertical = spatial pane step, horizontal = alerts.
        assert!(html.contains("const NAV_FLICK_TARGETS = {"));
        assert!(html.contains("up: [\"spatial\", \"prev\"]"));
        assert!(html.contains("down: [\"spatial\", \"next\"]"));
        assert!(html.contains("left: [\"notification\", \"recent\"]"));
        assert!(html.contains("right: [\"notification\", \"oldest\"]"));
        // Controller actions hit the lease-gated endpoints, taps serialize on
        // a promise chain, and the viewport follows the landing target.
        assert!(html.contains("spatial: \"/remote/v1/navigation/spatial\""));
        assert!(html.contains("notification: \"/remote/v1/navigation/notification\""));
        assert!(html.contains("excludedPaneIds: [...spatialExcludedPaneIds]"));
        assert!(html.contains("let navStepChain = Promise.resolve();"));
        assert!(html.contains("if (!leaseId || navStepPending >= 2) return;"));
        assert!(html.contains("await loadNavigation(data.target.terminalId || null);"));
        assert!(
            html.contains("no_included_panes: \"Every pane is excluded from pane navigation.\"")
        );
        assert!(html.contains("no_unread_notifications: \"No unread notifications.\""));
        // Nav keys gate on the lease only (escape-seq keys need a terminal
        // too); alert keys idle at zero unread and carry one count badge.
        assert!(html.contains("const isAlertKey = def.nav && def.nav[0] === \"notification\";"));
        assert!(html.contains("btn.disabled = !connected || (isAlertKey && unread <= 0);"));
        assert!(html.contains("function updateNavKeyBadge(unread)"));
    }

    #[test]
    fn remote_page_html_contains_spatial_pane_exclusion_toggle() {
        let html = remote_page_html();

        assert!(html.contains("id=\"spatialExclusion\""));
        assert!(html.contains("data-icon=\"circle-minus\""));
        // Every compact Remote header action shares one explicit border-box
        // height, including the adjacent text-bearing Composer toggle.
        assert!(html.contains("--header-control-height: 26px;"));
        assert!(html.contains("height: var(--header-control-height);"));
        assert!(html.contains("laymux.remote.spatialExcludedPaneIds"));
        assert!(html.contains("let spatialExcludedPaneIds = loadSpatialExcludedPaneIds();"));
        assert!(html.contains("function activeWorkspacePane()"));
        assert!(html.contains("spatialExclusionButton.hidden = !pane;"));
        assert!(html
            .contains("spatialExclusionButton.setAttribute(\"aria-pressed\", String(excluded));"));
        assert!(html.contains("spatialExclusionButton.addEventListener(\"click\", () => {"));
        assert!(html.contains("saveSpatialExcludedPaneIds();"));
    }

    #[test]
    fn remote_page_html_contains_header_pane_identity() {
        let html = remote_page_html();
        // The header shows a friendly "Workspace · Pane N" context title
        // instead of the raw terminal id, and doubles as the landing indicator
        // after a navigation step (issue #474).
        assert!(html.contains("function activeTerminalTitle()"));
        assert!(html.contains("`${ctx.workspace.name} · Pane ${ctx.paneNumber}`"));
        assert!(html.contains("(terminalId === activeTerminalId && activeTerminalTitle())"));
        // Header copy button yields the same lx:pane locator as the desktop
        // pane badge; hidden when no workspace pane is attached.
        assert!(html.contains("id=\"copyPaneId\""));
        assert!(html.contains("function activePaneIdentifier()"));
        assert!(html.contains("`lx:pane:${name}:${ctx.paneNumber}`"));
        assert!(html.contains("copyPaneIdButton.hidden = !activePaneIdentifier();"));
        // Copy reuses the secure-context clipboard helper with its fallback.
        assert!(html.contains("writeClipboardText(identifier)"));
    }

    #[test]
    fn remote_page_html_contains_detached_input_composer() {
        let html = remote_page_html();

        // The focused Remote surface exposes the same Direct/Composer choice on
        // fine-pointer desktops and coarse-pointer mobile clients.
        assert!(html.contains("id=\"inputModeToggle\""));
        assert!(html.contains("id=\"terminalComposer\""));
        assert!(html.contains("id=\"composerInput\""));
        assert!(!html.contains("id=\"composerInsert\""));
        // A dedicated Send button is the touch-device send affordance.
        assert!(html.contains("id=\"composerSend\""));
        assert!(html.contains("class=\"composer-send\""));
        assert!(html.contains(
            "data-icon=\"paper-plane\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"currentColor\""
        ));
        assert!(html.contains(
            "M13.47 20.21 19.91 4.09 3.8 10.53l3.75 3.77 9.14-6.99-6.99 9.14 3.77 3.76Z"
        ));
        assert!(!html.contains("M12 5l6.5 6.5-1.42 1.42L13 8.83V19h-2V8.83l-4.08 4.09L5.5 11.5z"));
        assert!(html.contains("laymux.remote.inputMode"));
        assert!(html.contains("matchMedia(\"(pointer: coarse)\")"));

        // Mode and unsent drafts are terminal-local runtime state. Only the
        // preferred default mode is persisted.
        assert!(html.contains("const inputModeByTerminalId = new Map()"));
        assert!(html.contains("const composerDraftByTerminalId = new Map()"));
        assert!(html.contains("revision: 0, inFlight: null"));
        assert!(html.contains("function renderInputSurface"));
        assert!(!html.contains("laymux.remote.composerDraft"));

        // A commit is a single structured Remote request. Its captured token,
        // revision and text guard conditional clearing after an async response.
        assert!(html.contains("/input`, {"));
        assert!(html.contains("body: JSON.stringify({ leaseId: activeLeaseId, text, submit })"));
        assert!(html.contains("function commitComposer()"));
        assert!(html.contains("draft.inFlight !== submission"));
        assert!(html.contains("draft.revision === submission.revision"));
        assert!(html.contains("draft.text === submission.text"));

        // Enter follows the layout (ADR-0036): the mobile layout (coarse
        // pointer OR the PC app's embedded mobile view, localApp=1) inserts a
        // newline and sends via the button only, keeping the fragile
        // soft-keyboard Enter off the send path; the desktop layout sends on
        // Enter with Shift+Enter as newline. IME confirmation (isComposing /
        // keyCode 229) never sends, and no keyboard shortcut is hardcoded
        // outside the keybinding system (api-contracts §15.5).
        assert!(html.contains("composerInput.addEventListener(\"compositionstart\""));
        assert!(html.contains("composerInput.addEventListener(\"compositionend\""));
        assert!(html.contains("const mobileLayout = coarsePointer || localAppMode"));
        assert!(html.contains("if (event.key !== \"Enter\" || event.shiftKey) return;"));
        assert!(!html.contains("event.ctrlKey || event.metaKey"));
        assert!(html.contains("if (mobileLayout) return;"));
        assert!(html.contains(
            "if (event.isComposing || composerIsComposing || event.keyCode === 229) return;"
        ));
        assert!(html.contains("composerSendButton.addEventListener(\"click\""));
        assert!(html.contains("composerSendButton.hidden = !(mobileLayout && composerMode)"));
        assert!(html.contains("matchMedia(\"(pointer: coarse)\").matches"));

        // Composer actions stay closed until a valid V1 snapshot header/state +
        // binary frame pair has established the active output attachment.
        assert!(html.contains("header.type !== \"terminal.output\""));
        assert!(html.contains("header.version !== 1"));
        assert!(html.contains("header.phase === \"snapshot\""));
        assert!(html.contains("let outputProtocolFailed = false"));
        assert!(html.contains("outputProtocolFailed = true"));
        assert!(html.contains("outputProtocolFailed ||"));
        assert!(html.contains("composerReady = true"));

        // Direct mode keeps xterm input, while Composer moves focus/caret to the
        // native textarea and hides the inactive xterm application cursor.
        assert!(html.contains("cursorInactiveStyle = \"none\""));
        assert!(html.contains("scheduleTerminalFit();"));
        assert!(html.contains("if (currentInputMode() === \"direct\")"));
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
        assert!(output_stream.contains("if (!reconnecting) queueTerminalReset();"));
        assert!(output_stream.contains("if (resetOnNextPayload)"));
        assert!(output_stream.contains("queueTerminalReset();"));
        assert!(output_stream.contains("terminalOutputGeneration"));
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
    fn remote_page_keeps_last_selection_only_in_document_memory() {
        let html = remote_page_html();

        assert!(html.contains("let lastSelectedTerminalId = null;"));
        assert!(html.contains("if (nextId) lastSelectedTerminalId = nextId;"));
        assert!(html.contains("preferredTerminalId = activeTerminalId || lastSelectedTerminalId"));
        assert!(!html.contains("laymux.remote.lastSelectedTerminalId"));
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
