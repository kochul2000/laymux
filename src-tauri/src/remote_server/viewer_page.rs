use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue};
use axum::response::{Html, IntoResponse, Response};

use crate::automation_server::ServerState;

use super::page::remote_page_gate;

const VIEWER_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'self'; frame-ancestors 'none'";

pub(super) async fn remote_viewer_page(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_page_gate(&server, addr, &req) {
        return response;
    }
    secure_viewer_response(Html(REMOTE_VIEWER_HTML).into_response())
}

pub(super) async fn remote_viewer_javascript(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_page_gate(&server, addr, &req) {
        return response;
    }
    let mut response = REMOTE_VIEWER_JS.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/javascript; charset=utf-8"),
    );
    secure_viewer_response(response)
}

fn secure_viewer_response(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(VIEWER_CSP),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

const REMOTE_VIEWER_HTML: &str = include_str!("viewer_page.html");
const REMOTE_VIEWER_JS: &str = include_str!("viewer_page.js");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_bootstrap_has_no_embedded_credentials_or_inline_script() {
        assert!(REMOTE_VIEWER_HTML.contains("Laymux File Viewer"));
        assert!(REMOTE_VIEWER_HTML.contains("/remote/viewer/viewer.js"));
        assert!(!REMOTE_VIEWER_HTML.contains("<script>"));
        assert!(!REMOTE_VIEWER_HTML.contains("token="));
        assert!(!REMOTE_VIEWER_HTML.contains("leaseId"));
    }

    #[test]
    fn viewer_script_accepts_one_exact_origin_opener_session() {
        assert!(REMOTE_VIEWER_JS.contains("laymux:file-viewer-ready"));
        assert!(REMOTE_VIEWER_JS.contains("laymux:file-viewer-session"));
        assert!(REMOTE_VIEWER_JS.contains("event.origin !== window.location.origin"));
        assert!(REMOTE_VIEWER_JS.contains("event.source !== window.opener"));
        assert!(REMOTE_VIEWER_JS.contains("window.opener = null"));
        assert!(REMOTE_VIEWER_JS.contains("x-laymux-remote-lease"));
        assert!(REMOTE_VIEWER_JS.contains("x-laymux-remote-file-viewer"));
        assert!(REMOTE_VIEWER_JS.contains("sandbox"));
    }

    #[test]
    fn viewer_script_never_copies_a_host_path_into_the_document_title() {
        assert!(!REMOTE_VIEWER_JS.contains("document.title ="));
    }

    #[test]
    fn sandboxed_preview_reports_when_its_source_was_truncated() {
        let branch_start = REMOTE_VIEWER_JS
            .find("if (payload.kind === \"text\" && payload.previewDocument)")
            .expect("preview branch");
        let branch_return = REMOTE_VIEWER_JS[branch_start..]
            .find("return;")
            .map(|offset| branch_start + offset)
            .expect("preview branch return");
        let branch = &REMOTE_VIEWER_JS[branch_start..branch_return];

        assert!(branch.contains("payload.truncated"));
        assert!(branch.contains("Preview truncated at the Remote viewer limit."));
    }

    #[test]
    fn viewer_csp_blocks_inline_and_remote_scripts() {
        assert!(VIEWER_CSP.contains("script-src 'self'"));
        assert!(!VIEWER_CSP.contains("script-src 'unsafe-inline'"));
        assert!(VIEWER_CSP.contains("frame-ancestors 'none'"));
    }
}
