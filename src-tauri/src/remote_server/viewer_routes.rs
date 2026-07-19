use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::automation_server::helpers::bridge_request;
use crate::automation_server::ServerState;
use crate::constants::MAX_REMOTE_FILE_VIEWER_BYTES;

use super::json_error;
use super::lease::require_active_lease;
use super::navigation_routes::lease_id_from_headers;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileViewerRenderRequest {
    source: String,
    path: Option<String>,
    lease_id: Option<String>,
}

pub(super) async fn remote_file_viewer_status(
    State(server): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, lease_id_from_headers(&headers))
    {
        return response;
    }

    file_viewer_bridge_response(&server, "status", json!({})).await
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
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    let params = match render_params(body) {
        Ok(params) => params,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    file_viewer_bridge_response(&server, "render", params).await
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
    method: &str,
    params: Value,
) -> Response {
    match bridge_request(server, "query", "fileViewer", method, params).await {
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
    }
}

#[cfg(test)]
mod tests {
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
}
