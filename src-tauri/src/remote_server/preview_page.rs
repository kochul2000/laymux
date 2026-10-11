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
    (
        [
            (
                header::CONTENT_SECURITY_POLICY,
                include_str!("preview-csp.txt").trim(),
            ),
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Html(html),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    #[test]
    fn preview_execution_never_receives_the_shell_origin_or_network_authority() {
        let policy = include_str!("preview-csp.txt");
        assert!(policy.contains("sandbox allow-scripts allow-pointer-lock"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(policy.contains("connect-src blob:"));
        assert!(policy.contains("'wasm-unsafe-eval'"));
        assert!(!include_str!("page-csp.txt").contains("'wasm-unsafe-eval'"));
    }
}
