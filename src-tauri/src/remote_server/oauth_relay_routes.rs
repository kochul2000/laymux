//! OAuth loopback relay (ADR-0175).
//!
//! CLI tools on the desktop run the OAuth "installed app" flow: they bind an
//! ephemeral `http://localhost:{port}` listener and print an authorization
//! URL. When the Remote client opens that URL on a phone, the provider
//! redirects to the *phone's* localhost, where nothing listens — the
//! authorization code never reaches the desktop tool. These routes let the
//! Remote client hand that one redirect back to the desktop listener.
//!
//! Security model: the desktop never exposes a generic "request any local
//! port" primitive. `begin` whitelists exactly one port and callback path —
//! both parsed from the `redirect_uri` of the auth URL the controller is
//! about to open — for one forward within a short TTL. `forward` consumes the
//! session before dispatching, only ever issues a GET, and both routes sit
//! behind the remote guard plus the controller lease.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use url::{Host, Url};
use uuid::Uuid;

use crate::automation_server::ServerState;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

use super::lease::require_active_lease;
use super::routes::REMOTE_LEASE_HEADER;
use super::{internal_error, json_error};

/// One pending relay session. A `begin` replaces any previous session: the
/// desktop user runs one interactive OAuth flow at a time, and a single slot
/// means abandoned sessions can never accumulate into a pool of open forward
/// targets.
struct OauthRelaySession {
    id: String,
    /// Loopback host literal preserved from the redirect_uri ("127.0.0.1"
    /// or "[::1]") — an IPv6-only CLI listener is unreachable via 127.0.0.1.
    host: String,
    port: u16,
    callback_path: String,
    expires_at: Instant,
}

/// Authorization codes expire provider-side within minutes; a stale session
/// is useless to the user and pure attack surface, so keep the window short.
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);
/// A callback (path + query carrying an authorization code) fits well under
/// this; anything larger is not an OAuth redirect.
const MAX_PATH_AND_QUERY_LEN: usize = 4096;
const MAX_AUTH_URL_LEN: usize = 8 * 1024;
/// Loopback listeners answer immediately or not at all.
const FORWARD_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
/// The tool's "you may close this window" page is tiny; cap what travels
/// back through the relay.
const MAX_FORWARD_RESPONSE_BYTES: usize = 64 * 1024;

fn session_store() -> &'static Mutex<Option<OauthRelaySession>> {
    static STORE: OnceLock<Mutex<Option<OauthRelaySession>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OauthRelayBeginRequest {
    auth_url: String,
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OauthRelayForwardRequest {
    session_id: String,
    path_and_query: String,
    lease_id: Option<String>,
}

fn lease_id_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REMOTE_LEASE_HEADER)
        .and_then(|value| value.to_str().ok())
}

/// Extract the loopback listener a valid installed-app auth URL redirects
/// to. Returns `(host, port, callback_path)` or a user-facing rejection
/// reason. The host keeps the redirect's address family: "localhost" and
/// IPv4 loopback forward to 127.0.0.1, IPv6 loopback to [::1].
fn parse_loopback_redirect(auth_url: &str) -> Result<(String, u16, String), String> {
    if auth_url.len() > MAX_AUTH_URL_LEN {
        return Err("auth URL is too long".into());
    }
    let url = Url::parse(auth_url).map_err(|_| "auth URL is not a valid URL")?;
    if url.scheme() != "https" {
        return Err("auth URL must be https".into());
    }
    let redirect = url
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .map(|(_, value)| value.into_owned())
        .ok_or("auth URL has no redirect_uri parameter")?;
    let redirect = Url::parse(&redirect).map_err(|_| "redirect_uri is not a valid URL")?;
    if redirect.scheme() != "http" {
        return Err("redirect_uri is not a loopback http URL".into());
    }
    let host = match redirect.host() {
        Some(Host::Domain(domain)) if domain.eq_ignore_ascii_case("localhost") => {
            "127.0.0.1".to_string()
        }
        Some(Host::Ipv4(ip)) if ip.is_loopback() => "127.0.0.1".to_string(),
        Some(Host::Ipv6(ip)) if ip.is_loopback() => "[::1]".to_string(),
        _ => return Err("redirect_uri does not point at localhost".into()),
    };
    let port = redirect.port().ok_or("redirect_uri has no explicit port")?;
    // Never let a crafted URL steer the relay at a privileged service; real
    // OAuth CLI listeners always bind ephemeral high ports.
    if port < 1024 {
        return Err("redirect_uri port is below 1024".into());
    }
    Ok((host, port, redirect.path().to_string()))
}

/// Lease-gated core of `begin`, separated from the axum handler so tests can
/// drive it with a bare `AppState` (`ServerState` needs a Tauri `AppHandle`).
// The Err is the handler's HTTP Response, forwarded as-is like
// `require_active_lease` (see the note there).
#[allow(clippy::result_large_err)]
fn begin_session(
    app_state: &AppState,
    auth_url: &str,
    lease_id: Option<&str>,
) -> Result<serde_json::Value, Response> {
    require_active_lease(app_state, lease_id)?;

    let (host, port, callback_path) = parse_loopback_redirect(auth_url)
        .map_err(|reason| json_error(StatusCode::BAD_REQUEST, &reason))?;

    let session_id = Uuid::new_v4().to_string();
    let mut slot = session_store()
        .lock_or_err()
        .map_err(internal_error_response)?;
    *slot = Some(OauthRelaySession {
        id: session_id.clone(),
        host,
        port,
        callback_path,
        expires_at: Instant::now() + SESSION_TTL,
    });

    Ok(serde_json::json!({
        "sessionId": session_id,
        "port": port,
        "expiresInSeconds": SESSION_TTL.as_secs(),
    }))
}

/// Lease-gated core of `forward`: consume the session and return the pinned
/// forward target. Consuming before the dispatch makes the forward
/// single-use even when the loopback request itself fails — the user
/// restarts from `begin`, never by retrying into a half-known state.
#[allow(clippy::result_large_err)]
fn take_forward_target(
    app_state: &AppState,
    session_id: &str,
    path_and_query: &str,
    lease_id: Option<&str>,
) -> Result<(String, u16, String), Response> {
    require_active_lease(app_state, lease_id)?;

    let mut slot = session_store()
        .lock_or_err()
        .map_err(internal_error_response)?;
    let Some(session) = slot.take() else {
        return Err(json_error(
            StatusCode::CONFLICT,
            "no OAuth relay session is active",
        ));
    };
    if session.expires_at <= Instant::now() {
        return Err(json_error(
            StatusCode::CONFLICT,
            "OAuth relay session has expired",
        ));
    }
    if session.id != session_id {
        // Not the caller's session: put it back untouched.
        *slot = Some(session);
        return Err(json_error(
            StatusCode::CONFLICT,
            "OAuth relay session does not match",
        ));
    }
    drop(slot);

    validate_path_and_query(path_and_query, &session.callback_path)?;
    Ok((session.host, session.port, path_and_query.to_string()))
}

fn internal_error_response(err: impl std::fmt::Display) -> Response {
    internal_error(err)
}

#[allow(clippy::result_large_err)]
fn validate_path_and_query(path_and_query: &str, callback_path: &str) -> Result<(), Response> {
    let bad_request = |reason: &str| Err(json_error(StatusCode::BAD_REQUEST, reason));
    if path_and_query.len() > MAX_PATH_AND_QUERY_LEN {
        return bad_request("callback path is too long");
    }
    if !path_and_query
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && byte != b'\\')
    {
        return bad_request("callback path contains invalid characters");
    }
    // Only the exact registered redirect path, optionally with a query —
    // no sibling paths, no traversal past what the auth URL declared.
    let after_path = match path_and_query.strip_prefix(callback_path) {
        Some(rest) => rest,
        None => return bad_request("callback path does not match the session"),
    };
    if !(after_path.is_empty() || after_path.starts_with('?')) {
        return bad_request("callback path does not match the session");
    }
    Ok(())
}

/// `POST /remote/v1/oauth-relay/begin` — whitelist the loopback listener the
/// given auth URL redirects to, replacing any previous session.
pub(super) async fn remote_oauth_relay_begin(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<OauthRelayBeginRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    match begin_session(&server.app_state, &body.auth_url, lease_id) {
        Ok(payload) => Json(payload).into_response(),
        Err(response) => response,
    }
}

/// `POST /remote/v1/oauth-relay/forward` — replay the provider's redirect
/// against the desktop loopback listener registered by `begin`.
pub(super) async fn remote_oauth_relay_forward(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<OauthRelayForwardRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    let (host, port, path_and_query) = match take_forward_target(
        &server.app_state,
        &body.session_id,
        &body.path_and_query,
        lease_id,
    ) {
        Ok(target) => target,
        Err(response) => return response,
    };
    forward_to_loopback(&host, port, &path_and_query).await
}

/// A timeout is mandatory like `cloud::pairing::build_pair_client`: a
/// listener that accepts but never answers must not pin the phone's forward
/// request forever. Redirects stay unfollowed so the response the tool
/// serves is exactly what travels back — the relay never crawls anywhere.
async fn forward_to_loopback(host: &str, port: u16, path_and_query: &str) -> Response {
    let client = match reqwest::Client::builder()
        .timeout(FORWARD_TIMEOUT)
        .connect_timeout(FORWARD_CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(err) => return internal_error(err),
    };

    let target = format!("http://{host}:{port}{path_and_query}");
    let response = match client.get(&target).send().await {
        Ok(response) => response,
        Err(err) => {
            let reason = if err.is_connect() {
                "the desktop OAuth listener is not accepting connections"
            } else if err.is_timeout() {
                "the desktop OAuth listener did not answer in time"
            } else {
                "forward to the desktop OAuth listener failed"
            };
            return json_error(StatusCode::BAD_GATEWAY, reason);
        }
    };

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/html")
        .to_string();
    // Stream with the cap applied while reading: collecting the whole body
    // first would let a hostile local service allocate unbounded memory for
    // the duration of the forward timeout.
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = MAX_FORWARD_RESPONSE_BYTES - body.len();
                if chunk.len() >= remaining {
                    body.extend_from_slice(&chunk[..remaining]);
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    Json(serde_json::json!({
        "status": status,
        "contentType": content_type,
        "body": String::from_utf8_lossy(&body),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use crate::remote_server::lease::RemoteControlLease;

    use super::*;

    const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/auth?scope=openid&access_type=offline&redirect_uri=http://localhost:63742&response_type=code&client_id=x.apps.googleusercontent.com";

    /// The store is process-global; tests touching it must not interleave.
    fn store_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state_with_lease(lease_id: &str) -> AppState {
        let state = AppState::new();
        state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: lease_id.into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
        state
    }

    fn set_session(id: &str, port: u16, callback_path: &str, expires_at: Instant) {
        *session_store().lock_or_err().unwrap() = Some(OauthRelaySession {
            id: id.into(),
            host: "127.0.0.1".into(),
            port,
            callback_path: callback_path.into(),
            expires_at,
        });
    }

    fn clear_session() {
        *session_store().lock_or_err().unwrap() = None;
    }

    #[test]
    fn parses_loopback_redirect_without_path() {
        let (host, port, path) = parse_loopback_redirect(GOOGLE_AUTH_URL).unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 63742);
        assert_eq!(path, "/");
    }

    #[test]
    fn parses_loopback_redirect_with_encoded_path() {
        let url = "https://example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8484%2Fpair%2Fcallback&state=abc";
        let (host, port, path) = parse_loopback_redirect(url).unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 8484);
        assert_eq!(path, "/pair/callback");
    }

    #[test]
    fn preserves_ipv6_loopback_address_family() {
        let url = "https://example.com/a?redirect_uri=http://[::1]:9443/cb";
        let (host, port, path) = parse_loopback_redirect(url).unwrap();
        assert_eq!(host, "[::1]");
        assert_eq!(port, 9443);
        assert_eq!(path, "/cb");
    }

    #[test]
    fn rejects_non_loopback_redirect() {
        let url = "https://example.com/a?redirect_uri=http://evil.example:8080/";
        assert!(parse_loopback_redirect(url).is_err());
    }

    #[test]
    fn rejects_privileged_port_and_missing_port() {
        let privileged = "https://example.com/a?redirect_uri=http://127.0.0.1:80/";
        assert!(parse_loopback_redirect(privileged).is_err());
        let missing = "https://example.com/a?redirect_uri=http://localhost/";
        assert!(parse_loopback_redirect(missing).is_err());
    }

    #[test]
    fn rejects_plain_http_auth_url_and_missing_redirect() {
        let http = "http://accounts.google.com/a?redirect_uri=http://localhost:9999/";
        assert!(parse_loopback_redirect(http).is_err());
        let none = "https://accounts.google.com/a?scope=openid";
        assert!(parse_loopback_redirect(none).is_err());
    }

    #[test]
    fn path_validation_pins_the_registered_path() {
        assert!(validate_path_and_query("/?code=abc", "/").is_ok());
        assert!(validate_path_and_query("/", "/").is_ok());
        assert!(validate_path_and_query("/cb?code=abc", "/cb").is_ok());
        assert!(validate_path_and_query("/cb", "/cb").is_ok());
        assert!(validate_path_and_query("/other?code=abc", "/cb").is_err());
        assert!(validate_path_and_query("/cbx?code=abc", "/cb").is_err());
        assert!(validate_path_and_query("/cb/../admin", "/cb").is_err());
        assert!(validate_path_and_query("/cb?code=a\\b", "/cb").is_err());
        assert!(validate_path_and_query("/cb?code=a b", "/cb").is_err());
    }

    #[test]
    fn begin_requires_active_lease() {
        let _guard = store_test_lock();
        let state = AppState::new();
        let err = begin_session(&state, GOOGLE_AUTH_URL, None).unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);
        let err = begin_session(&state, GOOGLE_AUTH_URL, Some("bogus")).unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn begin_rejects_invalid_auth_url_with_bad_request() {
        let _guard = store_test_lock();
        let state = state_with_lease("lease-1");
        let err = begin_session(
            &state,
            "https://example.com/a?redirect_uri=http://evil.example:8080/",
            Some("lease-1"),
        )
        .unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn forward_target_is_single_use_and_id_checked() {
        let _guard = store_test_lock();
        let state = state_with_lease("lease-1");
        set_session("session-1", 60000, "/", Instant::now() + SESSION_TTL);

        // Wrong id leaves the session in place.
        let err =
            take_forward_target(&state, "session-2", "/?code=x", Some("lease-1")).unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);

        let (host, port, path) =
            take_forward_target(&state, "session-1", "/?code=x", Some("lease-1")).unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 60000);
        assert_eq!(path, "/?code=x");

        // Second take fails: single-use.
        let err =
            take_forward_target(&state, "session-1", "/?code=x", Some("lease-1")).unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);
        clear_session();
    }

    #[test]
    fn forward_target_rejects_expired_session_and_missing_lease() {
        let _guard = store_test_lock();
        let state = state_with_lease("lease-1");

        set_session(
            "session-1",
            60000,
            "/",
            Instant::now() - Duration::from_secs(1),
        );
        let err =
            take_forward_target(&state, "session-1", "/?code=x", Some("lease-1")).unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);

        set_session("session-1", 60000, "/", Instant::now() + SESSION_TTL);
        let err = take_forward_target(&state, "session-1", "/?code=x", None).unwrap_err();
        assert_eq!(err.status(), StatusCode::CONFLICT);
        clear_session();
    }

    // The guard is the test-only serialization of the process-global session
    // store; nothing else locks inside it, so holding it across awaits cannot
    // deadlock and is exactly what keeps the sync store tests out.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn begin_then_forward_replays_the_redirect() {
        let _guard = store_test_lock();
        let state = state_with_lease("lease-1");

        // Stand-in for the CLI tool's loopback listener.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buffer = vec![0u8; 2048];
            let read = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\nconnection: close\r\n\r\ndone",
                )
                .await
                .unwrap();
            request
        });

        let auth_url = format!(
            "https://accounts.google.com/o/oauth2/auth?redirect_uri=http://localhost:{port}&response_type=code"
        );
        let begin = begin_session(&state, &auth_url, Some("lease-1")).unwrap();
        let session_id = begin["sessionId"].as_str().unwrap().to_string();
        assert_eq!(begin["port"].as_u64().unwrap(), u64::from(port));

        let (target_host, target_port, path_and_query) = take_forward_target(
            &state,
            &session_id,
            "/?code=4%2Fauth-code&scope=openid",
            Some("lease-1"),
        )
        .unwrap();
        let response = forward_to_loopback(&target_host, target_port, &path_and_query).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["status"].as_u64().unwrap(), 200);
        assert_eq!(json["body"].as_str().unwrap(), "done");

        let seen = served.await.unwrap();
        assert!(seen.starts_with("GET /?code=4%2Fauth-code&scope=openid HTTP/1.1"));
    }
}
