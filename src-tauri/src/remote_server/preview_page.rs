use crate::automation_server::ServerState;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::header,
    response::{Html, IntoResponse, Response},
};
use std::net::SocketAddr;

pub(super) async fn remote_preview_page(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = super::page::remote_page_gate(&server, addr, &req) {
        return response;
    }
    let html =
        include_str!("preview.html").replace("{{BOOTSTRAP}}", include_str!("preview-bootstrap.js"));
    let policy = preview_policy();
    (
        [
            (header::CONTENT_SECURITY_POLICY, policy.as_str()),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Html(html),
    )
        .into_response()
}

fn preview_policy() -> String {
    include_str!("preview-csp.txt")
        .trim()
        .replace("__APP_FRAME_ANCESTORS__", super::page::APP_FRAME_ANCESTORS)
}

#[cfg(test)]
mod tests {
    #[test]
    fn preview_execution_never_receives_the_shell_origin_or_network_authority() {
        let policy = super::preview_policy();
        assert!(policy.contains("sandbox allow-scripts allow-pointer-lock"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(policy.contains("connect-src blob:"));
        assert!(policy.contains("'wasm-unsafe-eval'"));
        assert!(!include_str!("page-csp.txt").contains("'wasm-unsafe-eval'"));
        assert!(!policy.contains("__APP_FRAME_ANCESTORS__"));
        let ancestors = policy.split("frame-ancestors ").nth(1).unwrap();
        assert_eq!(
            ancestors,
            format!("'self' {}", super::super::page::APP_FRAME_ANCESTORS)
        );
        assert!(!ancestors.contains('*'));
        assert!(!ancestors.contains("https://"));
        assert_eq!(
            ancestors.contains("http://localhost:1420"),
            cfg!(debug_assertions)
        );
    }
}
