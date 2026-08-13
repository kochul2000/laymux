use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderValue, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::android_e2e::{ChallengeRequest, CipherEnvelope, E2eError, EstablishRequest};
use crate::automation_server::ServerState;
use crate::error::AppError;
use crate::remote_server::TunnelAuthorized;
use crate::terminal_output::TerminalOutputFrameHeaderV1;

use super::access::effective_remote_settings;
use super::lease::{active_lease_matches_with_timeout, effective_heartbeat_timeout_seconds};
use super::{internal_error, json_error};

const INTERNAL_RESPONSE_LIMIT: usize = 1024 * 1024;
const RESOURCE_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum PlainRequest {
    Resource {
        path: String,
    },
    Http {
        method: String,
        path: String,
        body: Option<Value>,
    },
    TerminalOutputOpen {
        terminal_id: String,
        lease_id: String,
    },
    TerminalOutputPoll {
        terminal_id: String,
        lease_id: String,
        generation: u64,
        source_seq: u64,
        wire_seq_offset: u64,
    },
}

pub(super) async fn remote_android_e2e_challenge(
    State(server): State<ServerState>,
    Json(request): Json<ChallengeRequest>,
) -> Response {
    let material = match load_material(
        &request.instance_id,
        &request.pairing_id,
        &request.client_nonce,
    )
    .await
    {
        Ok(material) => material,
        Err(error) => return no_store(e2e_error_response(error)),
    };
    let now = match unix_time_now() {
        Ok(now) => now,
        Err(error) => return no_store(internal_error(error)),
    };
    no_store(
        match server
            .app_state
            .android_e2e
            .issue_challenge(request, &material, now)
        {
            Ok(response) => Json(response).into_response(),
            Err(error) => e2e_error_response(error),
        },
    )
}

pub(super) async fn remote_android_e2e_establish(
    State(server): State<ServerState>,
    Json(request): Json<EstablishRequest>,
) -> Response {
    let material = match load_material(
        &request.instance_id,
        &request.pairing_id,
        &request.client_nonce,
    )
    .await
    {
        Ok(material) => material,
        Err(error) => return no_store(e2e_error_response(error)),
    };
    let now = match unix_time_now() {
        Ok(now) => now,
        Err(error) => return no_store(internal_error(error)),
    };
    no_store(
        match server
            .app_state
            .android_e2e
            .establish(request, &material, now)
        {
            Ok(response) => Json(response).into_response(),
            Err(error) => e2e_error_response(error),
        },
    )
}

pub(super) async fn remote_android_e2e_rpc(
    State(server): State<ServerState>,
    Json(envelope): Json<CipherEnvelope>,
) -> Response {
    let session = match server.app_state.android_e2e.session(
        &envelope.instance_id,
        &envelope.session_id,
        match unix_time_now() {
            Ok(now) => now,
            Err(error) => return no_store(internal_error(error)),
        },
    ) {
        Ok(session) => session,
        Err(error) => return no_store(e2e_error_response(error)),
    };
    let dispatch_server = server.clone();
    no_store(
        match session
            .process(
                envelope,
                || unix_time_now().map_err(E2eError::Internal),
                move |request| dispatch_plain_request(dispatch_server, request),
            )
            .await
        {
            Ok(response) => Json(response).into_response(),
            Err(error) => e2e_error_response(error),
        },
    )
}

async fn load_material(
    instance_id: &str,
    pairing_id: &str,
    client_nonce: &str,
) -> Result<crate::android_pairing::ConfirmedPairingMaterial, E2eError> {
    let instance_id = instance_id.to_string();
    let pairing_id = pairing_id.to_string();
    let client_nonce = client_nonce.to_string();
    tokio::task::spawn_blocking(move || {
        crate::android_pairing::load_confirmed_material(&instance_id, &pairing_id, &client_nonce)
            .map_err(|_| E2eError::Invalid)
    })
    .await
    .map_err(|error| {
        E2eError::Internal(AppError::Other(format!(
            "Android E2E pairing lookup failed: {error}"
        )))
    })?
}

async fn dispatch_plain_request(server: ServerState, value: Value) -> Result<Value, AppError> {
    let request: PlainRequest = serde_json::from_value(value)
        .map_err(|_| AppError::Other("Android E2E plaintext request is invalid".into()))?;
    match request {
        PlainRequest::Resource { path } => dispatch_resource(server, &path).await,
        PlainRequest::Http { method, path, body } => {
            dispatch_http(server, &method, &path, body).await
        }
        PlainRequest::TerminalOutputOpen {
            terminal_id,
            lease_id,
        } => {
            if !valid_remote_identifier(&terminal_id) || !valid_remote_identifier(&lease_id) {
                return Ok(rpc_error(
                    StatusCode::BAD_REQUEST,
                    "Terminal output identity is invalid",
                ));
            }
            output_open(server, terminal_id, lease_id).await
        }
        PlainRequest::TerminalOutputPoll {
            terminal_id,
            lease_id,
            generation,
            source_seq,
            wire_seq_offset,
        } => {
            if !valid_remote_identifier(&terminal_id) || !valid_remote_identifier(&lease_id) {
                return Ok(rpc_error(
                    StatusCode::BAD_REQUEST,
                    "Terminal output identity is invalid",
                ));
            }
            output_poll(
                server,
                terminal_id,
                lease_id,
                generation,
                source_seq,
                wire_seq_offset,
            )
            .await
        }
    }
}

async fn dispatch_resource(server: ServerState, path: &str) -> Result<Value, AppError> {
    if !resource_path_allowed(path) {
        return Ok(rpc_error(
            StatusCode::FORBIDDEN,
            "Remote resource is not allowed",
        ));
    }
    let mut request = Request::builder()
        .method(Method::GET)
        .uri(path)
        .body(Body::empty())
        .map_err(|error| AppError::Other(format!("Android E2E resource build failed: {error}")))?;
    request.extensions_mut().insert(TunnelAuthorized);
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
    )));
    let router = super::build_router(server.clone()).with_state(server);
    let response = router.oneshot(request).await.map_err(|error| {
        AppError::Other(format!("Android E2E resource dispatch failed: {error}"))
    })?;
    let status = response.status();
    let response_headers = response.headers().clone();
    let bytes = match to_bytes(response.into_body(), RESOURCE_RESPONSE_LIMIT).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(rpc_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Remote resource is too large",
            ))
        }
    };
    let mut headers = serde_json::Map::new();
    for name in [
        header::CONTENT_TYPE,
        header::CACHE_CONTROL,
        header::CONTENT_SECURITY_POLICY,
        header::X_CONTENT_TYPE_OPTIONS,
        header::REFERRER_POLICY,
    ] {
        if let Some(value) = response_headers
            .get(&name)
            .and_then(|value| value.to_str().ok())
        {
            headers.insert(name.as_str().to_string(), Value::String(value.to_string()));
        }
    }
    Ok(json!({
        "kind": "resource",
        "status": status.as_u16(),
        "headers": headers,
        "data": URL_SAFE_NO_PAD.encode(bytes),
    }))
}

async fn dispatch_http(
    server: ServerState,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let method = method
        .parse::<Method>()
        .map_err(|_| AppError::Other("Android E2E HTTP method is invalid".into()))?;
    if !http_path_allowed(&method, path) {
        return Ok(rpc_error(
            StatusCode::FORBIDDEN,
            "Remote operation is not allowed",
        ));
    }
    let encoded_body = match body {
        Some(body) => serde_json::to_vec(&body)?,
        None => Vec::new(),
    };
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(encoded_body))
        .map_err(|error| AppError::Other(format!("Android E2E request build failed: {error}")))?;
    request.extensions_mut().insert(TunnelAuthorized);
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
    )));
    let router = super::build_router(server.clone()).with_state(server);
    let response = router
        .oneshot(request)
        .await
        .map_err(|error| AppError::Other(format!("Android E2E dispatch failed: {error}")))?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), INTERNAL_RESPONSE_LIMIT)
        .await
        .map_err(|error| AppError::Other(format!("Android E2E response read failed: {error}")))?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    Ok(json!({
        "kind": "http",
        "status": status.as_u16(),
        "body": body,
    }))
}

async fn output_open(
    server: ServerState,
    terminal_id: String,
    lease_id: String,
) -> Result<Value, AppError> {
    let timeout = match active_lease_timeout(&server, &lease_id)? {
        Some(timeout) => timeout,
        None => {
            return Ok(rpc_error(
                StatusCode::CONFLICT,
                "Remote lease is not active",
            ))
        }
    };
    let settings = effective_remote_settings(&server.app_state).map_err(AppError::Other)?;
    let snapshot_max_bytes = super::effective_snapshot_max_bytes(&settings);
    let subscribed = match super::attach_and_subscribe_render_checkpoint(
        &server,
        &terminal_id,
        snapshot_max_bytes,
    )
    .await
    {
        Ok(subscribed) => subscribed,
        Err(error) => return Ok(rpc_error(StatusCode::CONFLICT, &error.to_string())),
    };
    if !active_lease_matches_with_timeout(&server.app_state, &lease_id, timeout)
        .map_err(AppError::Other)?
    {
        return Ok(rpc_error(
            StatusCode::CONFLICT,
            "Remote lease changed during output attach",
        ));
    }
    let header = TerminalOutputFrameHeaderV1::snapshot(&subscribed.attachment);
    let state = &subscribed.attachment.state;
    Ok(json!({
        "kind": "terminalOutput",
        "phase": "snapshot",
        "generation": subscribed.generation,
        "sourceSeq": state.source_seq,
        "wireSeqOffset": subscribed.wire_seq_offset,
        "header": header,
        "geometry": state.geometry,
        "modes": state.modes,
        "data": URL_SAFE_NO_PAD.encode(subscribed.attachment.snapshot),
    }))
}

async fn output_poll(
    server: ServerState,
    terminal_id: String,
    lease_id: String,
    generation: u64,
    source_seq: u64,
    wire_seq_offset: u64,
) -> Result<Value, AppError> {
    if active_lease_timeout(&server, &lease_id)?.is_none() {
        return Ok(rpc_error(
            StatusCode::CONFLICT,
            "Remote lease is not active",
        ));
    }
    let delta = crate::terminal_output::resume_terminal_output(
        &server.app_state.terminal_protocol_states,
        &terminal_id,
        generation,
        source_seq,
    )
    .map_err(AppError::Other)?;
    let Some(delta) = delta else {
        return Ok(json!({
            "kind": "terminalOutput",
            "phase": "reattach",
        }));
    };
    let header = TerminalOutputFrameHeaderV1::delta_with_offset(&delta, wire_seq_offset)
        .map_err(AppError::Other)?;
    Ok(json!({
        "kind": "terminalOutput",
        "phase": if delta.data.is_empty() { "idle" } else { "delta" },
        "generation": delta.generation,
        "sourceSeq": delta.seq_end,
        "wireSeqOffset": wire_seq_offset,
        "header": header,
        "geometry": delta.geometry,
        "data": URL_SAFE_NO_PAD.encode(delta.data),
    }))
}

fn active_lease_timeout(
    server: &ServerState,
    lease_id: &str,
) -> Result<Option<Duration>, AppError> {
    if lease_id.is_empty() {
        return Ok(None);
    }
    let settings = effective_remote_settings(&server.app_state).map_err(AppError::Other)?;
    let timeout = Duration::from_secs(effective_heartbeat_timeout_seconds(&settings));
    active_lease_matches_with_timeout(&server.app_state, lease_id, timeout)
        .map(Some)
        .map(|result| result.filter(|active| *active).map(|_| timeout))
        .map_err(AppError::Other)
}

fn http_path_allowed(method: &Method, path: &str) -> bool {
    if invalid_inner_path(path) {
        return false;
    }
    match (method, path) {
        (&Method::GET, "/remote/v1/session/status")
        | (&Method::GET, "/remote/v1/navigation")
        | (&Method::GET, "/remote/v1/widgets")
        | (&Method::GET, "/remote/v1/terminals")
        | (&Method::GET, "/remote/v1/file-viewer/status")
        | (&Method::POST, "/remote/v1/session/claim")
        | (&Method::POST, "/remote/v1/session/heartbeat")
        | (&Method::POST, "/remote/v1/session/release")
        | (&Method::POST, "/remote/v1/navigation/spatial")
        | (&Method::POST, "/remote/v1/navigation/notification")
        | (&Method::POST, "/remote/v1/workspaces/active")
        | (&Method::POST, "/remote/v1/file-viewer/render")
        | (&Method::POST, "/remote/v1/file-viewer/path-link")
        | (&Method::POST, "/remote/v1/notifications/mark-all-read")
        | (&Method::DELETE, "/remote/v1/notifications") => true,
        (&Method::GET, _) => terminal_read_path(path),
        (&Method::POST, _) => {
            terminal_control_path(path)
                || notification_read_path(path)
                || visibility_path(path, "/remote/v1/workspaces/")
                || visibility_path(path, "/remote/v1/panes/")
        }
        _ => false,
    }
}

fn terminal_read_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/remote/v1/terminals/") else {
        return false;
    };
    let Some((terminal_id, action)) = rest.rsplit_once('/') else {
        return false;
    };
    valid_remote_identifier(terminal_id) && action == "github-repo"
}

fn terminal_control_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/remote/v1/terminals/") else {
        return false;
    };
    let Some((terminal_id, action)) = rest.rsplit_once('/') else {
        return false;
    };
    valid_remote_identifier(terminal_id) && matches!(action, "focus" | "write" | "input" | "resize")
}

fn notification_read_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/remote/v1/notifications/") else {
        return false;
    };
    let Some((notification_id, action)) = rest.rsplit_once('/') else {
        return false;
    };
    valid_remote_identifier(notification_id) && action == "read"
}

fn visibility_path(path: &str, prefix: &str) -> bool {
    let Some(rest) = path.strip_prefix(prefix) else {
        return false;
    };
    let Some((id, action)) = rest.rsplit_once('/') else {
        return false;
    };
    valid_remote_identifier(id) && action == "visibility"
}

fn resource_path_allowed(path: &str) -> bool {
    if invalid_inner_path(path) {
        return false;
    }
    if matches!(
        path,
        "/remote/"
            | "/remote/vendor/xterm.js"
            | "/remote/vendor/xterm.css"
            | "/remote/vendor/unicode-provider.js"
            | "/remote/vendor/addon-fit.js"
            | "/remote/vendor/addon-web-links.js"
            | "/remote/manifest.webmanifest"
            | "/remote/viewer/"
            | "/remote/viewer/viewer.js"
    ) {
        return true;
    }
    if let Some(file_name) = path.strip_prefix("/remote/pwa/") {
        return valid_resource_file_name(file_name, &["png"]);
    }
    if let Some(file_name) = path.strip_prefix("/remote/font/") {
        return valid_resource_file_name(file_name, &["ttf", "otf"]);
    }
    false
}

fn valid_resource_file_name(value: &str, extensions: &[&str]) -> bool {
    let Some((stem, extension)) = value.rsplit_once('.') else {
        return false;
    };
    valid_remote_identifier(stem) && extensions.contains(&extension)
}

fn invalid_inner_path(path: &str) -> bool {
    !path.starts_with("/remote/")
        || path.len() > 512
        || path.contains(['?', '#', '\\', '%'])
        || path.split('/').any(|part| part == "." || part == "..")
}

fn valid_remote_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn rpc_error(status: StatusCode, message: &str) -> Value {
    json!({
        "kind": "error",
        "status": status.as_u16(),
        "error": message,
    })
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn e2e_error_response(error: E2eError) -> Response {
    match error {
        E2eError::Invalid => json_error(StatusCode::UNAUTHORIZED, "Android E2E request is invalid"),
        E2eError::Expired => json_error(StatusCode::GONE, "Android E2E session expired"),
        E2eError::Sequence => json_error(StatusCode::CONFLICT, "Android E2E sequence is invalid"),
        E2eError::Internal(error) => {
            tracing::warn!(%error, "Android E2E request failed");
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Android E2E request failed",
            )
        }
    }
}

fn unix_time_now() -> Result<u64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AppError::Other("System clock is before Unix epoch".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inner_http_allowlist_rejects_e2e_recursion_and_path_escaping() {
        assert!(http_path_allowed(&Method::GET, "/remote/v1/terminals"));
        assert!(http_path_allowed(&Method::GET, "/remote/v1/navigation"));
        assert!(http_path_allowed(
            &Method::GET,
            "/remote/v1/terminals/term-1/github-repo"
        ));
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/navigation/spatial"
        ));
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/file-viewer/path-link"
        ));
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/workspaces/ws-1/visibility"
        ));
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/panes/pane-1/visibility"
        ));
        assert!(http_path_allowed(
            &Method::DELETE,
            "/remote/v1/notifications"
        ));
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/terminals/term-1/input"
        ));
        assert!(!http_path_allowed(
            &Method::POST,
            "/remote/v1/e2e/session/challenge"
        ));
        assert!(!http_path_allowed(
            &Method::POST,
            "/remote/v1/terminals/a%2fb/input"
        ));
        assert!(!http_path_allowed(
            &Method::GET,
            "/remote/v1/terminals?token=secret"
        ));
        assert!(!http_path_allowed(
            &Method::GET,
            "/remote/v1/terminals/term-1/output"
        ));
        assert!(!http_path_allowed(
            &Method::GET,
            "/remote/v1/e2e/session/challenge"
        ));
        assert!(!valid_remote_identifier("terminal/escape"));
        assert!(!valid_remote_identifier(&"x".repeat(129)));
    }

    #[test]
    fn resource_allowlist_is_owned_by_the_desktop_remote_client() {
        assert!(resource_path_allowed("/remote/"));
        assert!(resource_path_allowed("/remote/vendor/xterm.js"));
        assert!(resource_path_allowed("/remote/vendor/addon-web-links.js"));
        assert!(resource_path_allowed("/remote/manifest.webmanifest"));
        assert!(resource_path_allowed("/remote/pwa/icon-192.png"));
        assert!(resource_path_allowed("/remote/font/0123456789abcdef.ttf"));
        assert!(!resource_path_allowed("/remote/v1/navigation"));
        assert!(!resource_path_allowed("/remote/v1/e2e/rpc"));
        assert!(!resource_path_allowed("/remote/%2e%2e/admin"));
        assert!(!resource_path_allowed("https://relay.example/remote/"));
    }

    #[test]
    fn every_e2e_response_is_marked_no_store() {
        let response = no_store(Json(json!({"ok": true})).into_response());
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
    }
}
