use std::sync::Arc;
use std::time::Duration;

use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

use super::{keyring_store, tunnel, CloudStatus};
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::settings::{default_cloud_relay_base_url, load_settings, save_settings};
use crate::state::AppState;

const CALLBACK_PATH: &str = "/pair/callback";
const PAIRING_TIMEOUT: Duration = Duration::from_secs(180);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CALLBACK_REQUEST_BYTES: usize = 8192;
const CALLBACK_SUCCESS_HTML: &str =
    "<!doctype html><meta charset=\"utf-8\"><title>laymux</title><p>연결됨. 이 창은 닫아도 됩니다</p>";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairCompleteRequest {
    code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairCompleteResponse {
    pub instance_id: String,
    pub device_token: String,
    pub tunnel_url: String,
    pub server_base_url: String,
    pub device_token_expires_at: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CallbackOutcome {
    Continue,
    Complete(String),
    Failed(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CallbackHttpResponse {
    pub status_code: u16,
    pub reason: &'static str,
    pub body: String,
    pub outcome: CallbackOutcome,
}

pub async fn cloud_connect_start_inner(
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<CloudStatus, AppError> {
    match run_pairing_flow(&state).await {
        Ok(status) => match tunnel::start_tunnel_from_settings(state.clone(), app_handle).await {
            Ok(tunnel_status) => Ok(tunnel_status),
            Err(error) => {
                set_cloud_pairing_error(&state, format!("Cloud tunnel start failed: {error}")).map(
                    |mut next| {
                        next.instance_id = next.instance_id.or(status.instance_id);
                        next
                    },
                )
            }
        },
        Err(error) => set_cloud_pairing_error(&state, error.to_string()),
    }
}

async fn run_pairing_flow(state: &AppState) -> Result<CloudStatus, AppError> {
    let relay_base_url = normalized_relay_base_url(&load_settings().remote.relay_base_url);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Other(format!("Cloud pairing callback bind failed: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Other(format!("Cloud pairing callback address failed: {e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let state_token = generate_pairing_state();
    let pair_url = build_pair_url(
        &relay_base_url,
        &redirect_uri,
        &state_token,
        &desktop_device_name(),
    )?;

    open_system_browser_async(pair_url.to_string()).await?;
    let code = tokio::time::timeout(
        PAIRING_TIMEOUT,
        wait_for_pairing_callback(listener, state_token),
    )
    .await
    .map_err(|_| AppError::Other("Cloud pairing timed out".into()))??;

    let client = build_pair_client()?;
    let complete = complete_pairing(&client, &relay_base_url, &code).await?;
    persist_pairing_result(state, &relay_base_url, complete)
}

/// HTTP client for the `/api/desktop/pair/complete` exchange. A request/connect
/// timeout is mandatory: without it a relay that accepts the connection but
/// never responds would leave `cloud_connect_start` pending forever (and the
/// Settings UI stuck in the connecting state).
fn build_pair_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(COMPLETE_TIMEOUT)
        .connect_timeout(COMPLETE_CONNECT_TIMEOUT)
        .build()
        .map_err(|e| AppError::Other(format!("Cloud pairing HTTP client build failed: {e}")))
}

fn normalized_relay_base_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        default_cloud_relay_base_url()
    } else {
        trimmed.to_string()
    }
}

fn generate_pairing_state() -> String {
    Uuid::new_v4().to_string()
}

fn desktop_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "laymux-desktop".into())
}

pub(crate) fn build_pair_url(
    relay_base_url: &str,
    redirect_uri: &str,
    state: &str,
    name: &str,
) -> Result<Url, AppError> {
    let mut url = relay_url(relay_base_url, "pair/desktop")?;
    url.query_pairs_mut()
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state)
        .append_pair("name", name);
    Ok(url)
}

fn complete_url(relay_base_url: &str) -> Result<Url, AppError> {
    relay_url(relay_base_url, "api/desktop/pair/complete")
}

fn relay_url(relay_base_url: &str, path: &str) -> Result<Url, AppError> {
    let trimmed = relay_base_url.trim();
    let base = if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    };
    Url::parse(&base)
        .and_then(|url| url.join(path))
        .map_err(|e| AppError::Other(format!("Invalid cloud relay URL: {e}")))
}

async fn open_system_browser_async(url: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || open_system_browser(&url))
        .await
        .map_err(|e| AppError::Other(format!("Browser open task failed: {e}")))?
}

fn open_system_browser(url: &str) -> Result<(), AppError> {
    let mut command = browser_open_command(url);
    let status = command
        .status()
        .map_err(|e| AppError::Other(format!("Browser open failed: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "Browser open exited with status {status}"
        )))
    }
}

/// (program, args) for opening a URL in the system browser without going
/// through a shell. Kept as a pure function so tests can assert the URL is
/// passed as a single argument (never re-parsed by `cmd`, whose `&` operator
/// would otherwise split the `state`/`name` query params).
#[cfg(target_os = "windows")]
fn browser_open_argv(url: &str) -> (&'static str, Vec<String>) {
    // rundll32 hands the URL straight to the shell's protocol handler as one
    // argv entry — no `cmd /C start` shell metacharacter interpretation.
    (
        "rundll32.exe",
        vec!["url.dll,FileProtocolHandler".into(), url.to_string()],
    )
}

#[cfg(not(target_os = "windows"))]
fn browser_open_argv(url: &str) -> (&'static str, Vec<String>) {
    ("xdg-open", vec![url.to_string()])
}

fn browser_open_command(url: &str) -> std::process::Command {
    let (program, args) = browser_open_argv(url);
    let mut command = crate::process::headless_command(program);
    command.args(args);
    command
}

async fn wait_for_pairing_callback(
    listener: TcpListener,
    expected_state: String,
) -> Result<String, AppError> {
    let expected_port = listener
        .local_addr()
        .map_err(|e| AppError::Other(format!("Cloud pairing callback address failed: {e}")))?
        .port();
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| AppError::Other(format!("Cloud pairing callback accept failed: {e}")))?;
        let request = read_callback_request(&mut stream).await?;
        let response = handle_callback_request(&request, &expected_state, expected_port);
        write_callback_response(&mut stream, &response).await?;

        match response.outcome {
            CallbackOutcome::Continue => continue,
            CallbackOutcome::Complete(code) => return Ok(code),
            CallbackOutcome::Failed(message) => return Err(AppError::Other(message)),
        }
    }
}

async fn read_callback_request(stream: &mut TcpStream) -> Result<String, AppError> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];

    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() > MAX_CALLBACK_REQUEST_BYTES {
            return Err(AppError::Other(
                "Cloud pairing callback request too large".into(),
            ));
        }
    }

    Ok(String::from_utf8_lossy(&request).into_owned())
}

async fn write_callback_response(
    stream: &mut TcpStream,
    response: &CallbackHttpResponse,
) -> Result<(), AppError> {
    let body = response.body.as_bytes();
    let http = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status_code,
        response.reason,
        body.len()
    );
    stream.write_all(http.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await?;
    Ok(())
}

pub(crate) fn handle_callback_request(
    request: &str,
    expected_state: &str,
    expected_port: u16,
) -> CallbackHttpResponse {
    let Some(line) = request.lines().next() else {
        return callback_response(
            400,
            "Bad Request",
            "Invalid cloud pairing callback",
            CallbackOutcome::Continue,
        );
    };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();

    // Only accept origin-form targets ("/pair/callback?..."). Absolute-form
    // (e.g. "http://evil.test/pair/callback") is rejected so a rebinding /
    // proxied request can't be treated as our loopback callback.
    let parsed = parse_request_target(target);
    let Ok(url) = parsed else {
        return callback_response(
            400,
            "Bad Request",
            "Invalid cloud pairing callback",
            CallbackOutcome::Continue,
        );
    };

    if url.path() != CALLBACK_PATH {
        return callback_response(404, "Not Found", "Not found", CallbackOutcome::Continue);
    }

    if method != "GET" {
        return callback_response(
            405,
            "Method Not Allowed",
            "Method not allowed",
            CallbackOutcome::Continue,
        );
    }

    // Restrict Host to our loopback listener. Blocks DNS-rebinding requests
    // whose Host names a non-loopback authority even though the socket lands on
    // 127.0.0.1. Ignore (keep listening) rather than aborting the real flow.
    if !host_header_is_loopback(request, expected_port) {
        return callback_response(
            400,
            "Bad Request",
            "Invalid cloud pairing callback host",
            CallbackOutcome::Continue,
        );
    }

    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let state = query_value(&pairs, "state");
    if !constant_time_eq(state.unwrap_or_default(), expected_state) {
        return callback_response(
            400,
            "Bad Request",
            "Cloud pairing state did not match",
            CallbackOutcome::Failed("Cloud pairing state did not match".into()),
        );
    }

    if let Some(error) = query_value(&pairs, "error") {
        let message = format!("Cloud pairing failed: {error}");
        return callback_response(
            400,
            "Bad Request",
            "Cloud pairing failed",
            CallbackOutcome::Failed(message),
        );
    }

    let Some(code) = query_value(&pairs, "code").filter(|code| !code.is_empty()) else {
        return callback_response(
            400,
            "Bad Request",
            "Cloud pairing callback is missing code",
            CallbackOutcome::Failed("Cloud pairing callback is missing code".into()),
        );
    };

    callback_response(
        200,
        "OK",
        CALLBACK_SUCCESS_HTML,
        CallbackOutcome::Complete(code.to_string()),
    )
}

fn parse_request_target(target: &str) -> Result<Url, AppError> {
    // Origin-form only. An absolute-form target ("http://host/path") is what a
    // proxy or a rebinding attacker would send; our loopback listener is an
    // origin server and must never resolve one.
    if !target.starts_with('/') {
        return Err(AppError::Other(
            "Cloud pairing callback target must be origin-form".into(),
        ));
    }
    Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|e| AppError::Other(format!("Invalid cloud pairing callback target: {e}")))
}

/// True when the request's `Host` header names our loopback listener. Accepts
/// 127.0.0.1 / localhost / ::1; if a port is present it must match the listener.
/// A missing Host header is rejected (HTTP/1.1 requires it).
fn host_header_is_loopback(request: &str, expected_port: u16) -> bool {
    let Some(value) = request
        .lines()
        .skip(1)
        .take_while(|line| !line.is_empty())
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("host")
                .then(|| value.trim())
        })
    else {
        return false;
    };

    let (host, port) = split_host_port(value);
    let host_ok = matches!(host, "127.0.0.1" | "localhost" | "::1");
    let port_ok = match port {
        Some(port) => port == expected_port,
        None => true,
    };
    host_ok && port_ok
}

/// Split a `Host` header value into (host, port), normalizing a bracketed IPv6
/// literal (`[::1]:port`) to its inner form (`::1`).
fn split_host_port(value: &str) -> (&str, Option<u16>) {
    if let Some(rest) = value.strip_prefix('[') {
        // IPv6 literal: [host]:port
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
            return (host, port);
        }
        return (value, None);
    }
    match value.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()),
        None => (value, None),
    }
}

fn query_value<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.as_str())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();

    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(left_byte ^ right_byte);
    }

    diff == 0
}

fn callback_response(
    status_code: u16,
    reason: &'static str,
    body: &str,
    outcome: CallbackOutcome,
) -> CallbackHttpResponse {
    CallbackHttpResponse {
        status_code,
        reason,
        body: body.into(),
        outcome,
    }
}

async fn complete_pairing(
    client: &reqwest::Client,
    relay_base_url: &str,
    code: &str,
) -> Result<PairCompleteResponse, AppError> {
    let url = complete_url(relay_base_url)?;
    let response = client
        .post(url)
        .json(&PairCompleteRequest { code: code.into() })
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Cloud pairing complete request failed: {e}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| AppError::Other(format!("Cloud pairing complete response failed: {e}")))?;

    parse_pair_complete_response(status, &body)
}

pub(crate) fn parse_pair_complete_response(
    status: StatusCode,
    body: &str,
) -> Result<PairCompleteResponse, AppError> {
    if !status.is_success() {
        return Err(AppError::Other(format!(
            "Cloud pairing complete failed with HTTP {status}"
        )));
    }

    serde_json::from_str(body).map_err(AppError::Json)
}

pub(crate) fn persist_pairing_result(
    state: &AppState,
    relay_base_url: &str,
    complete: PairCompleteResponse,
) -> Result<CloudStatus, AppError> {
    keyring_store::set_device_token(&complete.device_token)?;

    let mut settings = load_settings();
    settings.remote.cloud_enabled = true;
    settings.remote.relay_base_url = normalized_relay_base_url(relay_base_url);
    settings.remote.cloud_instance_id = Some(complete.instance_id.clone());
    settings.remote.cloud_tunnel_url = Some(complete.tunnel_url);
    settings.remote.cloud_server_base_url = Some(complete.server_base_url);
    save_settings(&settings).map_err(AppError::Other)?;

    let status = CloudStatus {
        connected: false,
        instance_id: Some(complete.instance_id),
        last_error: None,
    };
    *state.cloud.lock_or_err()? = status.clone();
    Ok(status)
}

fn set_cloud_pairing_error(state: &AppState, message: String) -> Result<CloudStatus, AppError> {
    let mut cloud = state.cloud.lock_or_err()?;
    let status = CloudStatus {
        connected: false,
        instance_id: cloud.instance_id.clone(),
        last_error: Some(message),
    };
    *cloud = status.clone();
    Ok(status)
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::Path;

    use serial_test::serial;

    use super::*;
    use crate::settings::{load_settings, Settings};

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = env::var(key).ok();
            env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("APPDATA", dir)
    }

    #[cfg(not(target_os = "windows"))]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("HOME", dir)
    }

    const TEST_PORT: u16 = 8080;

    #[test]
    fn build_pair_url_targets_prod_pair_desktop() {
        // With the prod relay base, the desktop must open exactly
        // <PROD_CLOUD_RELAY_BASE_URL>/pair/desktop with the pairing query params.
        let url = build_pair_url(
            crate::settings::PROD_CLOUD_RELAY_BASE_URL,
            "http://127.0.0.1:54321/pair/callback",
            "state-123",
            "my-pc",
        )
        .unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("app.laymux.com"));
        assert_eq!(url.path(), "/pair/desktop");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            q.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:54321/pair/callback")
        );
        assert_eq!(q.get("state").map(String::as_str), Some("state-123"));
        assert_eq!(q.get("name").map(String::as_str), Some("my-pc"));
    }

    #[test]
    fn empty_relay_base_url_falls_back_to_build_default() {
        // An absent/blank relay URL normalizes to the compiled default:
        // dev(debug) → local relay, release → prod. Tests run in debug.
        assert_eq!(
            normalized_relay_base_url("   "),
            default_cloud_relay_base_url()
        );
        #[cfg(debug_assertions)]
        assert_eq!(
            normalized_relay_base_url(""),
            crate::settings::DEV_CLOUD_RELAY_BASE_URL
        );
    }

    #[test]
    fn callback_rejects_state_mismatch() {
        let response = handle_callback_request(
            "GET /pair/callback?code=abc&state=wrong HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 400);
        assert_eq!(
            response.outcome,
            CallbackOutcome::Failed("Cloud pairing state did not match".into())
        );
    }

    #[test]
    fn callback_reports_error_parameter() {
        let response = handle_callback_request(
            "GET /pair/callback?error=access_denied&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 400);
        assert_eq!(
            response.outcome,
            CallbackOutcome::Failed("Cloud pairing failed: access_denied".into())
        );
    }

    #[test]
    fn callback_returns_404_for_non_callback_path() {
        let response = handle_callback_request(
            "GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 404);
        assert_eq!(response.outcome, CallbackOutcome::Continue);
    }

    #[test]
    fn callback_accepts_matching_host_port() {
        let response = handle_callback_request(
            "GET /pair/callback?code=abc&state=expected HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 200);
        assert_eq!(response.outcome, CallbackOutcome::Complete("abc".into()));
    }

    #[test]
    fn callback_rejects_absolute_form_target() {
        let response = handle_callback_request(
            "GET http://evil.test/pair/callback?code=abc&state=expected HTTP/1.1\r\nHost: evil.test\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 400);
        assert_eq!(response.outcome, CallbackOutcome::Continue);
    }

    #[test]
    fn callback_rejects_foreign_host_header() {
        let response = handle_callback_request(
            "GET /pair/callback?code=abc&state=expected HTTP/1.1\r\nHost: evil.test\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 400);
        assert_eq!(response.outcome, CallbackOutcome::Continue);
    }

    #[test]
    fn callback_rejects_wrong_host_port() {
        let response = handle_callback_request(
            "GET /pair/callback?code=abc&state=expected HTTP/1.1\r\nHost: 127.0.0.1:9999\r\n\r\n",
            "expected",
            TEST_PORT,
        );

        assert_eq!(response.status_code, 400);
        assert_eq!(response.outcome, CallbackOutcome::Continue);
    }

    #[test]
    fn browser_open_argv_passes_url_as_single_argument() {
        let url = "http://127.0.0.1:5555/pair/callback?state=a&name=host&x=1";
        let (_program, args) = browser_open_argv(url);
        assert!(
            args.iter().any(|arg| arg == url),
            "url must be a single argv entry, never re-split by a shell: {args:?}"
        );
        // No argument may be a shell invocation that would re-parse `&`.
        assert!(!args.iter().any(|arg| arg == "/C" || arg == "start"));
    }

    #[tokio::test]
    async fn complete_pairing_times_out_when_relay_hangs() {
        // A relay that accepts the connection but never responds must not hang
        // the pairing flow forever.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            // Accept and hold the socket open without ever writing a response.
            let _accepted = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(300))
            .connect_timeout(Duration::from_millis(300))
            .build()
            .unwrap();
        let base = format!("http://{addr}");
        let result = complete_pairing(&client, &base, "code-123").await;

        assert!(
            result.is_err(),
            "hanging relay must produce a timeout error"
        );
        server.abort();
    }

    #[test]
    fn parses_successful_pair_complete_response() {
        let body = r#"{
          "instanceId": "instance-1",
          "deviceToken": "device-token-1",
          "tunnelUrl": "wss://relay.example.test/tunnel/instance-1",
          "serverBaseUrl": "https://relay.example.test",
          "deviceTokenExpiresAt": null
        }"#;

        let parsed = parse_pair_complete_response(StatusCode::OK, body).unwrap();

        assert_eq!(parsed.instance_id, "instance-1");
        assert_eq!(parsed.device_token, "device-token-1");
        assert_eq!(
            parsed.tunnel_url,
            "wss://relay.example.test/tunnel/instance-1"
        );
        assert_eq!(parsed.server_base_url, "https://relay.example.test");
        assert_eq!(parsed.device_token_expires_at, None);
    }

    #[test]
    fn reports_pair_complete_400() {
        let error = parse_pair_complete_response(StatusCode::BAD_REQUEST, "{}")
            .unwrap_err()
            .to_string();

        assert!(error.contains("Cloud pairing complete failed with HTTP 400 Bad Request"));
    }

    #[test]
    #[serial]
    fn successful_pairing_persists_credentials_settings_and_status() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        keyring_store::reset_mock_store().unwrap();
        save_settings(&Settings::default()).unwrap();

        let state = AppState::new();
        let status = persist_pairing_result(
            &state,
            "http://127.0.0.1:8000",
            PairCompleteResponse {
                instance_id: "instance-1".into(),
                device_token: "device-token-1".into(),
                tunnel_url: "wss://relay.example.test/tunnel/instance-1".into(),
                server_base_url: "https://relay.example.test".into(),
                device_token_expires_at: None,
            },
        )
        .unwrap();

        assert_eq!(
            status,
            CloudStatus {
                connected: false,
                instance_id: Some("instance-1".into()),
                last_error: None,
            }
        );
        assert_eq!(
            keyring_store::get_device_token().unwrap().as_deref(),
            Some("device-token-1")
        );

        let settings = load_settings();
        assert!(settings.remote.cloud_enabled);
        assert_eq!(settings.remote.relay_base_url, "http://127.0.0.1:8000");
        assert_eq!(
            settings.remote.cloud_instance_id.as_deref(),
            Some("instance-1")
        );
        assert_eq!(
            settings.remote.cloud_tunnel_url.as_deref(),
            Some("wss://relay.example.test/tunnel/instance-1")
        );
        assert_eq!(
            settings.remote.cloud_server_base_url.as_deref(),
            Some("https://relay.example.test")
        );
        assert_eq!(
            *state.cloud.lock_or_err().unwrap(),
            CloudStatus {
                connected: false,
                instance_id: Some("instance-1".into()),
                last_error: None,
            }
        );
    }
}
