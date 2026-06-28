use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::http::header;
use axum::response::{IntoResponse, Response};

use super::auth::check_remote_base_access;

const XTERM_JS: &str = include_str!("assets/xterm.js");
const XTERM_CSS: &str = include_str!("assets/xterm.css");
const ADDON_FIT_JS: &str = include_str!("assets/addon-fit.js");

pub(crate) async fn remote_xterm_js(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    remote_asset(addr, XTERM_JS, "application/javascript; charset=utf-8")
}

pub(crate) async fn remote_xterm_css(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    remote_asset(addr, XTERM_CSS, "text/css; charset=utf-8")
}

pub(crate) async fn remote_addon_fit_js(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    remote_asset(addr, ADDON_FIT_JS, "application/javascript; charset=utf-8")
}

fn remote_asset(addr: SocketAddr, body: &'static str, content_type: &'static str) -> Response {
    let settings = crate::settings::load_settings().remote;
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
