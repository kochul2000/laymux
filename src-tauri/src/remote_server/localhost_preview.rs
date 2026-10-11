use super::{json_error, lease::require_active_lease};
use crate::{automation_server::ServerState, state::AppState};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use url::{Host, Url};

pub(super) const CHUNK_BYTES: usize = 512 * 1024;
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSION_BYTES: usize = 128 * 1024 * 1024;
const MAX_FILES: usize = 128;
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub struct PreviewState {
    // Precedes Remote state: never hold an AppState mutex while waiting for this slot.
    slot: tokio::sync::Mutex<Option<PreviewSession>>,
}

struct PreviewSession {
    id: String,
    lease_id: String,
    target: Url,
    deadline: Instant,
    files: HashMap<String, PreviewFile>,
    bytes: usize,
}
struct PreviewFile {
    status: u16,
    content_type: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewBegin {
    pub session_id: String,
    url: String,
    chunk_bytes: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewChunk {
    status: u16,
    content_type: String,
    pub body: String,
    offset: usize,
    pub next_offset: usize,
    total_bytes: usize,
}

pub(super) fn preview_target(value: &str) -> Result<Url, String> {
    if value.len() > 8192 {
        return Err("preview URL is too long".into());
    }
    let mut url = Url::parse(value).map_err(|_| "invalid preview URL")?;
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return Err("preview requires an HTTP loopback URL without credentials".into());
    }
    let host = match url.host() {
        Some(Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") => {
            "127.0.0.1".to_string()
        }
        Some(Host::Ipv4(ip)) if ip.is_loopback() => ip.to_string(),
        Some(Host::Ipv6(ip)) if ip.is_loopback() => format!("[{ip}]"),
        _ => return Err("preview URL must point to localhost".into()),
    };
    let port = url
        .port()
        .filter(|port| *port >= 1024 && !matches!(port, 19280 | 19281))
        .ok_or("preview port is missing or reserved")?;
    url.set_host(Some(&host))
        .map_err(|_| "invalid loopback host")?;
    url.set_port(Some(port))
        .map_err(|_| "invalid loopback port")?;
    url.set_fragment(None);
    Ok(url)
}

pub(super) fn resource_url(target: &Url, path: &str) -> Result<Url, String> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.len() > 8192
        || path.contains(['\\', '#', '\r', '\n', '\0'])
    {
        return Err("invalid preview resource path".into());
    }
    let url = target.join(path).map_err(|_| "invalid resource URL")?;
    if url.origin() != target.origin() {
        return Err("preview resource changed origin".into());
    }
    Ok(url)
}

fn check_lease(app: &AppState, lease: &str) -> Result<(), String> {
    require_active_lease(app, Some(lease))
        .map_err(|_| "preview controller lease is not active".into())
}

impl PreviewState {
    pub(super) async fn begin(
        &self,
        app: &AppState,
        lease: &str,
        value: &str,
    ) -> Result<PreviewBegin, String> {
        check_lease(app, lease)?;
        let target = preview_target(value)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut slot = self.slot.lock().await;
        // A controller may have changed while another download held the slot.
        check_lease(app, lease)?;
        *slot = Some(PreviewSession {
            id: id.clone(),
            lease_id: lease.into(),
            target,
            deadline: Instant::now() + SESSION_TTL,
            files: HashMap::new(),
            bytes: 0,
        });
        Ok(PreviewBegin {
            session_id: id,
            url: value.into(),
            chunk_bytes: CHUNK_BYTES,
        })
    }

    pub(super) async fn read(
        &self,
        app: &AppState,
        lease: &str,
        id: &str,
        path: &str,
        offset: usize,
    ) -> Result<PreviewChunk, String> {
        check_lease(app, lease)?;
        let mut slot = self.slot.lock().await;
        check_lease(app, lease)?;
        let session = slot
            .as_mut()
            .filter(|s| s.id == id && s.lease_id == lease && Instant::now() < s.deadline)
            .ok_or("preview session expired or changed")?;
        let url = resource_url(&session.target, path)?;
        let key = url.as_str().to_string();
        if !session.files.contains_key(&key) {
            if offset != 0 {
                return Err("first resource read must start at zero".into());
            }
            if session.files.len() >= MAX_FILES {
                return Err("preview has too many resources".into());
            }
            let file = fetch_file(url, MAX_SESSION_BYTES - session.bytes).await?;
            session.bytes += file.bytes.len();
            session.files.insert(key.clone(), file);
        }
        let file = session
            .files
            .get(&key)
            .ok_or("preview resource is unavailable")?;
        if offset > file.bytes.len() {
            return Err("preview offset exceeds resource size".into());
        }
        let end = offset.saturating_add(CHUNK_BYTES).min(file.bytes.len());
        let result = PreviewChunk {
            status: file.status,
            content_type: file.content_type.clone(),
            body: STANDARD.encode(&file.bytes[offset..end]),
            offset,
            next_offset: end,
            total_bytes: file.bytes.len(),
        };
        // Release the slot before checking the completed request's controller state.
        let expired = Instant::now() >= session.deadline;
        drop(slot);
        check_lease(app, lease)?;
        if expired {
            return Err("preview session expired".into());
        }
        Ok(result)
    }

    pub(super) async fn close(&self, app: &AppState, lease: &str, id: &str) -> Result<(), String> {
        check_lease(app, lease)?;
        let mut slot = self.slot.lock().await;
        if slot
            .as_ref()
            .is_some_and(|s| s.id == id && s.lease_id == lease)
        {
            *slot = None;
        }
        Ok(())
    }
}

async fn fetch_file(url: Url, remaining: usize) -> Result<PreviewFile, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("localhost server: {e}"))?;
    if response.status().is_redirection() {
        return Err("preview redirects are not supported".into());
    }
    let limit = MAX_FILE_BYTES.min(remaining);
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("preview resource exceeds the size limit".into());
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("preview resource exceeds the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(PreviewFile {
        status,
        content_type,
        bytes,
    })
}

#[cfg(test)]
mod stream_limit_tests {
    use super::*;
    use axum::{body::Body, routing::get, Router};

    #[tokio::test]
    async fn an_unannounced_stream_is_rejected_before_it_can_fill_the_session_cache() {
        let router = Router::new().route(
            "/",
            get(|| async {
                let chunks = futures_util::stream::iter([
                    Ok::<_, std::io::Error>(vec![1_u8; 16]),
                    Ok(vec![2_u8; 16]),
                ]);
                Body::from_stream(chunks)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let error = fetch_file(url, 24)
            .await
            .err()
            .expect("oversized stream must fail");
        assert!(error.contains("size limit"));
        task.abort();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BeginRequest {
    url: String,
    lease_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResourceRequest {
    session_id: String,
    lease_id: String,
    path_and_query: String,
    offset: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CloseRequest {
    session_id: String,
    lease_id: String,
}

pub(super) async fn remote_preview_begin(
    State(server): State<ServerState>,
    Json(body): Json<BeginRequest>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, Some(&body.lease_id)) {
        return response;
    }
    match server
        .app_state
        .localhost_preview
        .begin(&server.app_state, &body.lease_id, &body.url)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, &e),
    }
}
pub(super) async fn remote_preview_resource(
    State(server): State<ServerState>,
    Json(body): Json<ResourceRequest>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, Some(&body.lease_id)) {
        return response;
    }
    match server
        .app_state
        .localhost_preview
        .read(
            &server.app_state,
            &body.lease_id,
            &body.session_id,
            &body.path_and_query,
            body.offset,
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, &e),
    }
}
pub(super) async fn remote_preview_close(
    State(server): State<ServerState>,
    Json(body): Json<CloseRequest>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, Some(&body.lease_id)) {
        return response;
    }
    match server
        .app_state
        .localhost_preview
        .close(&server.app_state, &body.lease_id, &body.session_id)
        .await
    {
        Ok(()) => Json(serde_json::json!({"closed": true})).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, &e),
    }
}
