use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::response::{Html, IntoResponse, Redirect, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::check_remote_base_access;
use super::internal_error;

pub(crate) async fn remote_page_redirect(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    if let Some(response) = check_remote_base_access(&settings, addr) {
        return response;
    }

    Redirect::temporary("/remote/").into_response()
}

pub(crate) async fn remote_page(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    if let Some(response) = check_remote_base_access(&settings, addr) {
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
        assert!(html.contains("function installTouchSelectionBridge(term)"));
        assert!(html.contains("new MouseEvent(type"));
        assert!(html.contains("mouseTrackingMode !== \"none\""));
        assert!(html.contains("id=\"copySelection\""));
        assert!(html.contains("copySelectionToClipboard"));
        assert!(html.contains("const terminalShell = document.querySelector(\".terminal-shell\")"));
        assert!(html.contains("resizeObserver.observe(terminalShell)"));
        assert!(html.contains("rect.width < 20 || rect.height < 20"));
        assert!(html.contains("function scheduleTerminalFit(sendResize = true)"));
        assert!(html.contains("function scheduleTerminalRefresh()"));
        assert!(html.contains("function loseRemoteControl(message)"));
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
}
