use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::{check_remote_base_access, check_remote_enabled, request_is_tunnel_authorized};
use super::internal_error;

const XTERM_JS: &str = include_str!("assets/xterm.js");
const XTERM_CSS: &str = include_str!("assets/xterm.css");
const ADDON_FIT_JS: &str = include_str!("assets/addon-fit.js");
const WEB_LINKS_ADDON_JS: &str = include_str!("assets/addon-web-links.js");

pub(crate) async fn remote_xterm_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        XTERM_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn remote_xterm_css(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        XTERM_CSS,
        "text/css; charset=utf-8",
    )
}

pub(crate) async fn remote_addon_fit_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        ADDON_FIT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn remote_web_links_addon_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        WEB_LINKS_ADDON_JS,
        "application/javascript; charset=utf-8",
    )
}

fn remote_asset(
    server: &ServerState,
    addr: SocketAddr,
    tunnel_authorized: bool,
    body: &'static str,
    content_type: &'static str,
) -> Response {
    // Asset routes are outside the `remote_guard` middleware, so gate here.
    // Cloud tunnel requests only need the enable gate (WSS-authorized); direct
    // requests go through the full token/IP/Origin base-access check.
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    if let Some(response) = remote_asset_gate_for_settings(&settings, addr, tunnel_authorized) {
        return response;
    }

    ([(header::CONTENT_TYPE, content_type)], body).into_response()
}

fn remote_asset_gate_for_settings(
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    use crate::settings::Settings;

    fn remote_settings(enabled: bool, token: &str) -> crate::settings::models::RemoteSettings {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = token.into();
        settings.remote
    }

    #[test]
    fn bundled_remote_assets_are_present() {
        assert!(XTERM_JS.contains("Terminal"));
        assert!(XTERM_CSS.contains(".xterm"));
        assert!(ADDON_FIT_JS.contains("FitAddon"));
        assert!(WEB_LINKS_ADDON_JS.contains("WebLinksAddon"));
    }

    #[test]
    fn remote_asset_requires_enabled_for_tunnel_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let disabled_settings = remote_settings(false, "");
        let disabled = remote_asset_gate_for_settings(&disabled_settings, addr, true).unwrap();
        assert_eq!(disabled.status(), StatusCode::FORBIDDEN);

        let enabled_settings = remote_settings(true, "");
        assert!(remote_asset_gate_for_settings(&enabled_settings, addr, true).is_none());
    }

    #[test]
    fn remote_asset_uses_full_base_access_for_direct_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let settings = remote_settings(true, "");
        let response = remote_asset_gate_for_settings(&settings, addr, false).unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
