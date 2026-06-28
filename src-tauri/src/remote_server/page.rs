use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::response::{Html, IntoResponse, Redirect, Response};

use super::auth::check_remote_base_access;

pub(crate) async fn remote_page_redirect(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    let settings = crate::settings::load_settings().remote;
    if let Some(response) = check_remote_base_access(&settings, addr) {
        return response;
    }

    Redirect::temporary("/remote/").into_response()
}

pub(crate) async fn remote_page(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    let settings = crate::settings::load_settings().remote;
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
        assert!(html.contains("/remote/v1/terminals"));
        assert!(html.contains("new WebSocket"));
        assert!(html.contains("new TerminalCtor"));
    }
}
