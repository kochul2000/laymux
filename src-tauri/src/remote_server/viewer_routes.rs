use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::automation_server::helpers::bridge_request;
use crate::automation_server::ServerState;
use crate::constants::{
    MAX_REMOTE_FILE_VIEWER_BYTES, MAX_REMOTE_FILE_VIEWER_LIST_ENTRIES,
    MAX_REMOTE_PATH_LINK_SCREEN_CHARS, MAX_REMOTE_PATH_LINK_SCREEN_LINES,
    MAX_REMOTE_PATH_LINK_SELECTION_CHARS, MAX_REMOTE_PATH_LINK_SELECTION_LINES,
    MAX_REMOTE_PATH_LINK_TERMINAL_ID_CHARS, REMOTE_FILE_VIEWER_CAPABILITY_HEADER,
};
use crate::state::AppState;

use super::json_error;
use super::lease::require_file_viewer_capability;
use super::navigation_routes::lease_id_from_headers;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileViewerRenderRequest {
    source: String,
    path: Option<String>,
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileViewerDownloadRequest {
    path: String,
    lease_id: Option<String>,
}

/// One Remote path-link discovery request (ADR-0188). `mode` selects the
/// trigger contract: `selection` (drag), `point` (tap/click — `caret` names the
/// token) or `screen` (idle viewport scan). `lines` is the text scope; the
/// desktop parser owns token cleanup so the text is never trimmed here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileViewerPathLinkRequest {
    terminal_id: String,
    mode: String,
    lines: Vec<String>,
    caret: Option<FileViewerPathLinkCaret>,
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileViewerPathLinkCaret {
    line_index: usize,
    index: usize,
}

/// One Remote directory listing request (ADR-0197). Either an explicit host
/// `path` or `source:"terminalCwd"` + `terminalId` (the header folder button's
/// entry point — the bridge resolves the terminal's cwd, home as fallback).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileViewerListRequest {
    source: Option<String>,
    path: Option<String>,
    terminal_id: Option<String>,
    lease_id: Option<String>,
}

struct FileViewerAuthorization {
    lease_id: String,
    capability: String,
}

pub(super) async fn remote_file_viewer_status(
    State(server): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    let authorization = match file_viewer_authorization(
        &server.app_state,
        lease_id_from_headers(&headers),
        file_viewer_capability_from_headers(&headers),
    ) {
        Ok(authorization) => authorization,
        Err(response) => return response,
    };

    file_viewer_bridge_response(&server, &authorization, "status", json!({})).await
}

pub(super) async fn remote_file_viewer_render(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FileViewerRenderRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    let authorization = match file_viewer_authorization(
        &server.app_state,
        lease_id,
        file_viewer_capability_from_headers(&headers),
    ) {
        Ok(authorization) => authorization,
        Err(response) => return response,
    };

    let params = match render_params(body) {
        Ok(params) => params,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    file_viewer_bridge_response(&server, &authorization, "render", params).await
}

pub(super) async fn remote_file_viewer_download(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FileViewerDownloadRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    let authorization = match file_viewer_authorization(
        &server.app_state,
        lease_id,
        file_viewer_capability_from_headers(&headers),
    ) {
        Ok(authorization) => authorization,
        Err(response) => return response,
    };

    let path = body.path.trim();
    if path.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "path is required");
    }
    file_viewer_bridge_response(
        &server,
        &authorization,
        "download",
        json!({
            "path": path,
            "maxBytes": MAX_REMOTE_FILE_VIEWER_BYTES,
        }),
    )
    .await
}

pub(super) async fn remote_file_viewer_path_link(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FileViewerPathLinkRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    let authorization = match file_viewer_authorization(
        &server.app_state,
        lease_id,
        file_viewer_capability_from_headers(&headers),
    ) {
        Ok(authorization) => authorization,
        Err(response) => return response,
    };

    let params = match path_link_params(body) {
        Ok(params) => params,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    file_viewer_bridge_response(&server, &authorization, "pathLink", params).await
}

pub(super) async fn remote_file_viewer_list(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FileViewerListRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    let authorization = match file_viewer_authorization(
        &server.app_state,
        lease_id,
        file_viewer_capability_from_headers(&headers),
    ) {
        Ok(authorization) => authorization,
        Err(response) => return response,
    };

    let params = match list_params(body) {
        Ok(params) => params,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    file_viewer_bridge_response(&server, &authorization, "list", params).await
}

#[allow(clippy::result_large_err)] // Axum handlers return this Response directly.
fn file_viewer_authorization(
    app_state: &AppState,
    lease_id: Option<&str>,
    capability: Option<&str>,
) -> Result<FileViewerAuthorization, Response> {
    require_file_viewer_capability(app_state, lease_id, capability)?;
    Ok(FileViewerAuthorization {
        lease_id: lease_id.unwrap_or_default().to_owned(),
        capability: capability.unwrap_or_default().to_owned(),
    })
}

fn file_viewer_capability_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REMOTE_FILE_VIEWER_CAPABILITY_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn render_params(body: FileViewerRenderRequest) -> Result<Value, &'static str> {
    match body.source.as_str() {
        "current" => Ok(json!({
            "source": "current",
            "maxBytes": MAX_REMOTE_FILE_VIEWER_BYTES,
        })),
        "path" => {
            let path = body.path.unwrap_or_default().trim().to_owned();
            if path.is_empty() {
                return Err("path is required when source is 'path'");
            }
            Ok(json!({
                "source": "path",
                "path": path,
                "maxBytes": MAX_REMOTE_FILE_VIEWER_BYTES,
            }))
        }
        _ => Err("source must be 'current' or 'path'"),
    }
}

fn list_params(body: FileViewerListRequest) -> Result<Value, &'static str> {
    match body.source.as_deref() {
        None | Some("path") => {
            let path = body.path.unwrap_or_default().trim().to_owned();
            if path.is_empty() {
                return Err("path is required");
            }
            Ok(json!({
                "source": "path",
                "path": path,
                "maxEntries": MAX_REMOTE_FILE_VIEWER_LIST_ENTRIES,
            }))
        }
        Some("terminalCwd") => {
            // terminalId is optional: without one (no terminal attached yet) the
            // bridge falls back to the host home directory.
            let terminal_id = body.terminal_id.unwrap_or_default().trim().to_owned();
            if terminal_id.chars().count() > MAX_REMOTE_PATH_LINK_TERMINAL_ID_CHARS {
                return Err("terminalId exceeds the 256 character limit");
            }
            let mut params = json!({
                "source": "terminalCwd",
                "maxEntries": MAX_REMOTE_FILE_VIEWER_LIST_ENTRIES,
            });
            if !terminal_id.is_empty() {
                params["terminalId"] = json!(terminal_id);
            }
            Ok(params)
        }
        Some(_) => Err("source must be 'path' or 'terminalCwd'"),
    }
}

fn path_link_params(body: FileViewerPathLinkRequest) -> Result<Value, &'static str> {
    let terminal_id = body.terminal_id.trim();
    if terminal_id.is_empty() {
        return Err("terminalId is required");
    }
    if terminal_id.chars().count() > MAX_REMOTE_PATH_LINK_TERMINAL_ID_CHARS {
        return Err("terminalId exceeds the 256 character limit");
    }
    if !matches!(body.mode.as_str(), "selection" | "point" | "screen") {
        return Err("mode must be 'selection', 'point' or 'screen'");
    }
    if body.lines.is_empty() || body.lines.iter().all(String::is_empty) {
        return Err("lines is required");
    }

    // Per-trigger bounds (ADR-0188). The screen scan is the only mode allowed a
    // whole viewport, and a caret only means something for a single line.
    let (max_lines, max_chars) = match body.mode.as_str() {
        "screen" => (
            MAX_REMOTE_PATH_LINK_SCREEN_LINES,
            MAX_REMOTE_PATH_LINK_SCREEN_CHARS,
        ),
        "point" => (1, MAX_REMOTE_PATH_LINK_SELECTION_CHARS),
        _ => (
            MAX_REMOTE_PATH_LINK_SELECTION_LINES,
            MAX_REMOTE_PATH_LINK_SELECTION_CHARS,
        ),
    };
    if body.lines.len() > max_lines {
        return Err("lines exceeds the line limit for this mode");
    }
    let chars: usize = body.lines.iter().map(|line| line.chars().count()).sum();
    if chars > max_chars {
        return Err("lines exceeds the character limit for this mode");
    }

    let caret = match (body.mode.as_str(), body.caret) {
        ("point", Some(caret)) => {
            let line = body
                .lines
                .get(caret.line_index)
                .ok_or("caret.lineIndex is out of range")?;
            // The caret is a UTF-16 offset produced by the page's own cell map;
            // it must land inside the line it names or the parser would resolve
            // a token the user never pointed at.
            if caret.index >= line.encode_utf16().count() {
                return Err("caret.index is out of range");
            }
            Some(json!({ "lineIndex": caret.line_index, "index": caret.index }))
        }
        ("point", None) => return Err("caret is required when mode is 'point'"),
        (_, Some(_)) => return Err("caret is only valid when mode is 'point'"),
        (_, None) => None,
    };

    let mut params = json!({
        "terminalId": terminal_id,
        "mode": body.mode,
        // Do not trim these values: the shared desktop parser owns token cleanup
        // and needs the exact rendered text for parity with TerminalView.
        "lines": body.lines,
    });
    if let Some(caret) = caret {
        params["caret"] = caret;
    }
    Ok(params)
}

async fn file_viewer_bridge_response(
    server: &ServerState,
    authorization: &FileViewerAuthorization,
    method: &str,
    params: Value,
) -> Response {
    let result = bridge_request(server, "query", "fileViewer", method, params).await;
    file_viewer_bridge_result(&server.app_state, authorization, result)
}

fn file_viewer_bridge_result(
    app_state: &AppState,
    authorization: &FileViewerAuthorization,
    result: Result<Value, (StatusCode, Json<Value>)>,
) -> Response {
    if let Err(response) = require_file_viewer_capability(
        app_state,
        Some(&authorization.lease_id),
        Some(&authorization.capability),
    ) {
        return no_store(response);
    }

    let response = match result {
        Ok(data) if data.get("success").and_then(Value::as_bool) == Some(false) => {
            let message = data
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("file viewer bridge request failed");
            let status = if message.contains("viewer limit") {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_error(status, message)
        }
        Ok(data) => Json(data).into_response(),
        Err(error) => error.into_response(),
    };
    no_store(response)
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use crate::remote_server::lease::RemoteControlLease;

    use super::*;

    fn request(source: &str, path: Option<&str>) -> FileViewerRenderRequest {
        FileViewerRenderRequest {
            source: source.into(),
            path: path.map(str::to_owned),
            lease_id: None,
        }
    }

    fn path_link_request(terminal_id: &str, selection: &str) -> FileViewerPathLinkRequest {
        path_link_mode_request(terminal_id, "selection", vec![selection.to_owned()], None)
    }

    fn path_link_mode_request(
        terminal_id: &str,
        mode: &str,
        lines: Vec<String>,
        caret: Option<(usize, usize)>,
    ) -> FileViewerPathLinkRequest {
        FileViewerPathLinkRequest {
            terminal_id: terminal_id.into(),
            mode: mode.into(),
            lines,
            caret: caret.map(|(line_index, index)| FileViewerPathLinkCaret { line_index, index }),
            lease_id: None,
        }
    }

    #[test]
    fn current_source_never_accepts_a_client_path() {
        let params = render_params(request("current", Some("C:\\secret.txt"))).unwrap();
        assert_eq!(params["source"], "current");
        assert!(params.get("path").is_none());
        assert_eq!(params["maxBytes"], MAX_REMOTE_FILE_VIEWER_BYTES);
    }

    #[test]
    fn explicit_path_is_trimmed_and_bounded() {
        let params = render_params(request("path", Some("  /tmp/report.md  "))).unwrap();
        assert_eq!(params["path"], "/tmp/report.md");
        assert_eq!(params["maxBytes"], MAX_REMOTE_FILE_VIEWER_BYTES);
    }

    #[test]
    fn invalid_source_or_blank_path_is_rejected() {
        assert_eq!(
            render_params(request("other", None)).unwrap_err(),
            "source must be 'current' or 'path'"
        );
        assert_eq!(
            render_params(request("path", Some("  "))).unwrap_err(),
            "path is required when source is 'path'"
        );
    }

    fn list_request(
        source: Option<&str>,
        path: Option<&str>,
        terminal_id: Option<&str>,
    ) -> FileViewerListRequest {
        FileViewerListRequest {
            source: source.map(str::to_owned),
            path: path.map(str::to_owned),
            terminal_id: terminal_id.map(str::to_owned),
            lease_id: None,
        }
    }

    #[test]
    fn list_path_is_trimmed_and_entry_bounded() {
        let params = list_params(list_request(None, Some("  /home/user/src  "), None)).unwrap();
        assert_eq!(params["source"], "path");
        assert_eq!(params["path"], "/home/user/src");
        assert_eq!(params["maxEntries"], MAX_REMOTE_FILE_VIEWER_LIST_ENTRIES);

        let explicit =
            list_params(list_request(Some("path"), Some("/home/user/src"), None)).unwrap();
        assert_eq!(explicit["path"], "/home/user/src");
    }

    #[test]
    fn list_terminal_cwd_carries_the_terminal_id_only() {
        let params = list_params(list_request(
            Some("terminalCwd"),
            Some("/ignored"),
            Some("  terminal-1  "),
        ))
        .unwrap();
        assert_eq!(params["source"], "terminalCwd");
        assert_eq!(params["terminalId"], "terminal-1");
        assert_eq!(params["maxEntries"], MAX_REMOTE_FILE_VIEWER_LIST_ENTRIES);
        assert!(params.get("path").is_none());

        // No terminal attached yet: the bridge falls back to the host home.
        let unattached = list_params(list_request(Some("terminalCwd"), None, None)).unwrap();
        assert_eq!(unattached["source"], "terminalCwd");
        assert!(unattached.get("terminalId").is_none());
    }

    #[test]
    fn list_rejects_blank_or_oversized_input() {
        assert_eq!(
            list_params(list_request(None, Some("  "), None)).unwrap_err(),
            "path is required"
        );
        assert_eq!(
            list_params(list_request(None, None, None)).unwrap_err(),
            "path is required"
        );
        assert!(list_params(list_request(
            Some("terminalCwd"),
            None,
            Some(&"t".repeat(256))
        ))
        .is_ok());
        assert_eq!(
            list_params(list_request(
                Some("terminalCwd"),
                None,
                Some(&"t".repeat(257))
            ))
            .unwrap_err(),
            "terminalId exceeds the 256 character limit"
        );
        assert_eq!(
            list_params(list_request(Some("current"), None, None)).unwrap_err(),
            "source must be 'path' or 'terminalCwd'"
        );
    }

    #[test]
    fn path_link_preserves_raw_selection_for_the_desktop_parser() {
        let params = path_link_params(path_link_request(
            "  terminal-1  ",
            "  (\"ui/src/main.ts:42:5\")  ",
        ))
        .unwrap();

        assert_eq!(params["terminalId"], "terminal-1");
        assert_eq!(params["mode"], "selection");
        assert_eq!(params["lines"][0], "  (\"ui/src/main.ts:42:5\")  ");
        assert!(params.get("caret").is_none());
        assert!(params.get("cwd").is_none());
        assert!(params.get("path").is_none());
    }

    #[test]
    fn path_link_rejects_missing_fields_and_oversized_values() {
        assert_eq!(
            path_link_params(path_link_request("  ", "src/main.rs")).unwrap_err(),
            "terminalId is required"
        );
        assert_eq!(
            path_link_params(path_link_request("terminal-1", "")).unwrap_err(),
            "lines is required"
        );
        assert!(path_link_params(path_link_request(&"t".repeat(256), "src/main.rs")).is_ok());
        assert_eq!(
            path_link_params(path_link_request(&"t".repeat(257), "src/main.rs")).unwrap_err(),
            "terminalId exceeds the 256 character limit"
        );
        assert!(path_link_params(path_link_request("terminal-1", &"가".repeat(4096))).is_ok());
        assert_eq!(
            path_link_params(path_link_request("terminal-1", &"가".repeat(4097))).unwrap_err(),
            "lines exceeds the character limit for this mode"
        );
    }

    #[test]
    fn path_link_rejects_an_unknown_trigger_mode() {
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "hover",
                vec!["src/main.rs".into()],
                None,
            ))
            .unwrap_err(),
            "mode must be 'selection', 'point' or 'screen'"
        );
    }

    #[test]
    fn path_link_point_requires_a_caret_inside_a_single_line() {
        let params = path_link_params(path_link_mode_request(
            "terminal-1",
            "point",
            vec!["cat ui/src/main.ts".into()],
            Some((0, 6)),
        ))
        .unwrap();
        assert_eq!(params["mode"], "point");
        assert_eq!(params["caret"]["lineIndex"], 0);
        assert_eq!(params["caret"]["index"], 6);

        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "point",
                vec!["cat ui/src/main.ts".into()],
                None,
            ))
            .unwrap_err(),
            "caret is required when mode is 'point'"
        );
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "point",
                vec!["cat".into()],
                Some((0, 3)),
            ))
            .unwrap_err(),
            "caret.index is out of range"
        );
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "point",
                vec!["cat".into()],
                Some((1, 0)),
            ))
            .unwrap_err(),
            "caret.lineIndex is out of range"
        );
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "point",
                vec!["a".into(), "b".into()],
                Some((0, 0)),
            ))
            .unwrap_err(),
            "lines exceeds the line limit for this mode"
        );
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "selection",
                vec!["src/main.rs".into()],
                Some((0, 0)),
            ))
            .unwrap_err(),
            "caret is only valid when mode is 'point'"
        );
    }

    #[test]
    fn path_link_screen_accepts_a_viewport_and_bounds_it() {
        let rows = vec![String::from("cat src/a.ts"); MAX_REMOTE_PATH_LINK_SCREEN_LINES];
        let params =
            path_link_params(path_link_mode_request("terminal-1", "screen", rows, None)).unwrap();
        assert_eq!(params["mode"], "screen");
        assert_eq!(
            params["lines"].as_array().map(Vec::len),
            Some(MAX_REMOTE_PATH_LINK_SCREEN_LINES)
        );

        let too_many = vec![String::from("a"); MAX_REMOTE_PATH_LINK_SCREEN_LINES + 1];
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "screen",
                too_many,
                None
            ))
            .unwrap_err(),
            "lines exceeds the line limit for this mode"
        );

        let too_wide = vec![
            "가".repeat(MAX_REMOTE_PATH_LINK_SCREEN_CHARS / 2 + 1),
            "가".repeat(MAX_REMOTE_PATH_LINK_SCREEN_CHARS / 2),
        ];
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "screen",
                too_wide,
                None
            ))
            .unwrap_err(),
            "lines exceeds the character limit for this mode"
        );
    }

    #[test]
    fn path_link_selection_keeps_the_eight_line_cap() {
        let rows = vec![String::from("src/a.ts"); MAX_REMOTE_PATH_LINK_SELECTION_LINES];
        assert!(path_link_params(path_link_mode_request(
            "terminal-1",
            "selection",
            rows,
            None
        ))
        .is_ok());
        let too_many = vec![String::from("src/a.ts"); MAX_REMOTE_PATH_LINK_SELECTION_LINES + 1];
        assert_eq!(
            path_link_params(path_link_mode_request(
                "terminal-1",
                "selection",
                too_many,
                None
            ))
            .unwrap_err(),
            "lines exceeds the line limit for this mode"
        );
    }

    fn install_file_viewer_authorization(app_state: &AppState) -> FileViewerAuthorization {
        let mut control = app_state
            .remote_control
            .lock()
            .expect("remote control lock");
        control.install_remote_lease(
            RemoteControlLease {
                lease_id: "lease-1".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: Instant::now(),
            },
            Duration::from_secs(45),
        );
        let capability = control.issue_file_viewer_capability("lease-1");
        FileViewerAuthorization {
            lease_id: "lease-1".into(),
            capability,
        }
    }

    #[test]
    fn bridge_result_is_rejected_after_file_viewer_capability_revocation() {
        let app_state = AppState::default();
        let authorization = install_file_viewer_authorization(&app_state);
        require_file_viewer_capability(
            &app_state,
            Some(&authorization.lease_id),
            Some(&authorization.capability),
        )
        .expect("capability starts valid");

        app_state
            .remote_control
            .lock()
            .expect("remote control lock")
            .begin_remote_owner_transition(Instant::now())
            .expect("active lease transition");

        let response = file_viewer_bridge_result(
            &app_state,
            &authorization,
            Ok(json!({ "open": true, "path": "/secret/report.md" })),
        );
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn successful_file_viewer_response_is_never_cached() {
        let app_state = AppState::default();
        let authorization = install_file_viewer_authorization(&app_state);
        let response = file_viewer_bridge_result(
            &app_state,
            &authorization,
            Ok(json!({ "open": true, "path": "/secret/report.md" })),
        );

        assert_eq!(
            response.headers().get(axum::http::header::CACHE_CONTROL),
            Some(&axum::http::HeaderValue::from_static("no-store"))
        );
    }
}
