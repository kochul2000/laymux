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
        assert!(!html.contains("id=\"dockList\""));
        assert!(html.contains("function isDockTerminalId(terminalId)"));
        assert!(html.contains("options.focusHost !== false && !isDockTerminalId(terminalId)"));
    }
}
