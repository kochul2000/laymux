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
use crate::lock_ext::MutexExt;
use crate::remote_server::TunnelAuthorized;

use super::access::effective_remote_settings;
use super::lease::{
    effective_heartbeat_timeout_seconds, emit_remote_control_status, status_from_state,
    wait_for_remote_owner_transition_async,
};
use super::{internal_error, json_error};

const INTERNAL_RESPONSE_LIMIT: usize = 1024 * 1024;
const RESOURCE_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

// `rename_all` renames the variant tags only; variant fields need
// `rename_all_fields`. Without it the camelCase wire contract
// (`terminalId`, `sourceSeq`, …) fails `deny_unknown_fields` and every
// terminal-output RPC answers 500, which reads on the phone as a terminal
// that never renders and reconnects forever.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PlainRequest {
    Resource {
        path: String,
    },
    Http {
        method: String,
        path: String,
        body: Option<Value>,
    },
    BackgroundTransition {
        lease_id: String,
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
    // The claim handler binds the granted lease to this session (ADR-0170), so
    // the internally re-injected request carries which session is asking.
    let claim_context = super::lease::AndroidE2eClaimContext {
        instance_id: session.instance_id.clone(),
        session_id: session.session_id.clone(),
    };
    no_store(
        match session
            .process(
                envelope,
                || unix_time_now().map_err(E2eError::Internal),
                move |request| {
                    dispatch_plain_request(dispatch_server, claim_context.clone(), request)
                },
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

async fn dispatch_plain_request(
    server: ServerState,
    claim_context: super::lease::AndroidE2eClaimContext,
    value: Value,
) -> Result<Value, AppError> {
    let request: PlainRequest = serde_json::from_value(value)
        .map_err(|_| AppError::Other("Android E2E plaintext request is invalid".into()))?;
    match request {
        PlainRequest::Resource { path } => dispatch_resource(server, &path).await,
        PlainRequest::Http { method, path, body } => {
            dispatch_http(server, claim_context, &method, &path, body).await
        }
        PlainRequest::BackgroundTransition { lease_id } => {
            if !valid_remote_identifier(&lease_id) {
                return Ok(rpc_error(
                    StatusCode::BAD_REQUEST,
                    "Remote lease identity is invalid",
                ));
            }
            let settings = effective_remote_settings(&server.app_state).map_err(AppError::Other)?;
            let seconds = settings.android_background_lease_seconds;
            let now = std::time::Instant::now();
            let transition = {
                let mut control = server.app_state.remote_control.lock_or_err()?;
                control.observe_lease_expiry(
                    now,
                    Duration::from_secs(effective_heartbeat_timeout_seconds(&settings)),
                );
                if seconds == 0 {
                    if control.lease.as_ref().map(|lease| lease.lease_id.as_str())
                        != Some(lease_id.as_str())
                    {
                        return Ok(rpc_error(
                            StatusCode::CONFLICT,
                            "Remote lease is not active",
                        ));
                    }
                    control.begin_voluntary_release_transition(now)
                } else if control.refresh_remote_lease(&lease_id, now, Duration::from_secs(seconds))
                {
                    None
                } else {
                    return Ok(rpc_error(
                        StatusCode::CONFLICT,
                        "Remote lease is not active",
                    ));
                }
            };
            if let Some(transition) = transition {
                wait_for_remote_owner_transition_async(&server.app_state, transition)
                    .await
                    .map_err(AppError::Other)?;
                let mut control = server.app_state.remote_control.lock_or_err()?;
                control.finalize_owner_transition_if_drained(transition);
                let status =
                    status_from_state(&control, effective_heartbeat_timeout_seconds(&settings));
                emit_remote_control_status(&server.app_handle, &status);
            }
            Ok(json!({
                "kind": "backgroundTransition",
                "action": if seconds == 0 { "released" } else { "retained" },
                "leaseSeconds": seconds,
            }))
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
        // Android inflates gzip natively before handing bytes to the WebView
        // (ADR-0169); compressing before AEAD shrinks the base64 RPC envelope.
        // Static compiled-in assets only — no secret or caller data shares the
        // compressed stream, so CRIME-style attacks do not apply.
        .header(header::ACCEPT_ENCODING, "gzip")
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
        header::CONTENT_ENCODING,
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
    claim_context: super::lease::AndroidE2eClaimContext,
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
    request.extensions_mut().insert(claim_context);
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

fn http_path_allowed(method: &Method, path: &str) -> bool {
    if invalid_inner_path(path) {
        return false;
    }
    match (method, path) {
        (&Method::GET, "/remote/v1/session/status")
        | (&Method::GET, "/remote/v1/display-settings")
        | (&Method::GET, "/remote/v1/navigation")
        | (&Method::GET, "/remote/v1/layouts")
        | (&Method::GET, "/remote/v1/widgets")
        | (&Method::GET, "/remote/v1/update")
        | (&Method::GET, "/remote/v1/terminals")
        | (&Method::GET, "/remote/v1/file-viewer/status")
        | (&Method::POST, "/remote/v1/session/claim")
        | (&Method::POST, "/remote/v1/session/heartbeat")
        | (&Method::POST, "/remote/v1/session/release")
        | (&Method::POST, "/remote/v1/navigation/spatial")
        | (&Method::POST, "/remote/v1/navigation/notification")
        | (&Method::POST, "/remote/v1/workspaces")
        | (&Method::POST, "/remote/v1/workspaces/active")
        | (&Method::POST, "/remote/v1/file-viewer/render")
        | (&Method::POST, "/remote/v1/file-viewer/download")
        | (&Method::POST, "/remote/v1/file-viewer/path-link")
        | (&Method::POST, "/remote/v1/oauth-relay/begin")
        | (&Method::POST, "/remote/v1/oauth-relay/forward")
        | (&Method::POST, "/remote/v1/notifications/mark-all-read")
        | (&Method::POST, "/remote/v1/update/check")
        | (&Method::POST, "/remote/v1/update/install")
        | (&Method::DELETE, "/remote/v1/notifications") => true,
        (&Method::PUT, "/remote/v1/display-settings") => true,
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
    valid_remote_identifier(terminal_id)
        && matches!(
            action,
            "focus" | "write" | "input" | "resize" | "attachments"
        )
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
    ) {
        return true;
    }
    if let Some(file_name) = path.strip_prefix("/remote/pwa/") {
        return valid_resource_file_name(file_name, &["png"]);
    }
    if let Some(file_name) = path.strip_prefix("/remote/font/") {
        return valid_resource_file_name(file_name, &["ttf", "otf"]);
    }
    // Exactly the hashed immutable assets the served page references
    // (ADR-0169) — the registry is the allowlist, so a new asset never needs
    // a second list updated here.
    if let Some(file_name) = path.strip_prefix("/remote/asset/") {
        return super::page_assets::is_hashed_asset_file(file_name);
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

    /// The exact plaintext bodies `MainActivity` sends over the E2E RPC. These
    /// are the wire contract from api-contracts.md §13.0, so they are written
    /// out literally instead of being built from the Rust types.
    #[test]
    fn plain_requests_use_the_camel_case_wire_contract() {
        let resource: PlainRequest =
            serde_json::from_str(r#"{"kind":"resource","path":"/remote/"}"#).expect("resource");
        assert!(matches!(resource, PlainRequest::Resource { .. }));

        let http: PlainRequest = serde_json::from_str(
            r#"{"kind":"http","method":"POST","path":"/remote/v1/session/claim","body":null}"#,
        )
        .expect("http");
        assert!(matches!(http, PlainRequest::Http { .. }));

        assert!(serde_json::from_str::<PlainRequest>(
            r#"{"kind":"terminalOutputOpen","terminalId":"terminal-pane-1","leaseId":"lease-1"}"#,
        )
        .is_err());

        assert!(serde_json::from_str::<PlainRequest>(
            r#"{"kind":"terminalOutputPoll","terminalId":"terminal-pane-1","leaseId":"lease-1",
                "generation":7,"sourceSeq":42,"wireSeqOffset":9}"#,
        )
        .is_err());

        let background: PlainRequest =
            serde_json::from_str(r#"{"kind":"backgroundTransition","leaseId":"lease-1"}"#)
                .expect("backgroundTransition");
        assert!(matches!(
            background,
            PlainRequest::BackgroundTransition { lease_id } if lease_id == "lease-1"
        ));
    }

    /// Rust field spellings are not part of the contract: accepting them would
    /// hide the camelCase regression this test pins down.
    #[test]
    fn terminal_output_is_not_an_rpc_plaintext_operation() {
        assert!(serde_json::from_str::<PlainRequest>(
            r#"{"kind":"terminalOutputOpen","terminal_id":"terminal-pane-1","lease_id":"lease-1"}"#
        )
        .is_err());
    }

    #[test]
    fn inner_http_allowlist_rejects_e2e_recursion_and_path_escaping() {
        assert!(http_path_allowed(&Method::GET, "/remote/v1/terminals"));
        assert!(http_path_allowed(&Method::GET, "/remote/v1/navigation"));
        assert!(http_path_allowed(&Method::GET, "/remote/v1/layouts"));
        assert!(http_path_allowed(&Method::GET, "/remote/v1/update"));
        assert!(http_path_allowed(&Method::POST, "/remote/v1/update/check"));
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/update/install"
        ));
        assert!(http_path_allowed(
            &Method::GET,
            "/remote/v1/display-settings"
        ));
        assert!(http_path_allowed(
            &Method::PUT,
            "/remote/v1/display-settings"
        ));
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
        assert!(http_path_allowed(&Method::POST, "/remote/v1/workspaces"));
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
        assert!(http_path_allowed(
            &Method::POST,
            "/remote/v1/terminals/term-1/attachments"
        ));
        assert!(!http_path_allowed(
            &Method::POST,
            "/remote/v1/e2e/session/challenge"
        ));
        assert!(!http_path_allowed(
            &Method::POST,
            "/remote/v1/display-settings"
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
        // The hashed asset registry (ADR-0169) is the allowlist: exactly the
        // files the served page references, nothing invented by the caller.
        let served =
            super::super::page_assets::hashed_asset_url("remote-app.js").expect("registered asset");
        assert!(resource_path_allowed(&served));
        assert!(!resource_path_allowed(
            "/remote/asset/remote-app-0000000000000000.js"
        ));
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
