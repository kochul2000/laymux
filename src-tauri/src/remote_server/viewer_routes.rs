use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::automation_server::helpers::bridge_request;
use crate::automation_server::ServerState;
use crate::constants::{MAX_REMOTE_FILE_VIEWER_BYTES, REMOTE_FILE_VIEWER_CAPABILITY_HEADER};
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
