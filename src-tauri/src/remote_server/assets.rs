use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::check_remote_base_access;
use super::internal_error;

const XTERM_JS: &str = include_str!("assets/xterm.js");
const XTERM_CSS: &str = include_str!("assets/xterm.css");
const ADDON_FIT_JS: &str = include_str!("assets/addon-fit.js");

pub(crate) async fn remote_xterm_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    remote_asset(
        &server,
        addr,
        XTERM_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn remote_xterm_css(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    remote_asset(&server, addr, XTERM_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn remote_addon_fit_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    remote_asset(
        &server,
        addr,
        ADDON_FIT_JS,
        "application/javascript; charset=utf-8",
    )
}

fn remote_asset(
    server: &ServerState,
    addr: SocketAddr,
    body: &'static str,
    content_type: &'static str,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    if let Some(response) = check_remote_base_access(&settings, addr) {
        return response;
    }

    ([(header::CONTENT_TYPE, content_type)], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_remote_assets_are_present() {
        assert!(XTERM_JS.contains("Terminal"));
        assert!(XTERM_CSS.contains(".xterm"));
        assert!(ADDON_FIT_JS.contains("FitAddon"));
    }
}
