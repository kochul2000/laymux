use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::header::{CONNECTION, CONTENT_LENGTH};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Uri};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle as TauriJoinHandle;
use tauri::AppHandle;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle as TokioJoinHandle;
use tokio::time::{interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http as ws_http;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

use super::{keyring_store, CloudStatus};
use crate::automation_server::ServerState;
use crate::constants::{
    DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS, MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS,
};
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::remote_server::{self, TunnelAuthorized};
use crate::settings::load_settings;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

const CONTROL_STREAM_ID: &str = "0";
const FRAME_READY: &str = "ready";
const FRAME_HEARTBEAT: &str = "heartbeat";
const FRAME_HEARTBEAT_ACK: &str = "heartbeat.ack";
const FRAME_ECHO_REQUEST: &str = "echo.request";
const FRAME_ECHO_RESPONSE: &str = "echo.response";
const FRAME_STREAM_OPEN: &str = "stream.open";
const FRAME_STREAM_DATA: &str = "stream.data";
const FRAME_STREAM_CLOSE: &str = "stream.close";
const FRAME_STREAM_ERROR: &str = "stream.error";

const KIND_HTTP_REQUEST: &str = "http.request";
const KIND_HTTP_RESPONSE: &str = "http.response";
const KIND_WEBSOCKET: &str = "websocket";
const KIND_WEBSOCKET_ACCEPT: &str = "websocket.accept";
const ENCODING_BASE64: &str = "base64";

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const OUTBOUND_QUEUE_SIZE: usize = 256;
const STREAM_QUEUE_MAX_SIZE: usize = 64;
const STREAM_PENDING_BYTES_LIMIT: usize = 4 * 1024 * 1024;
const MAX_ACTIVE_STREAMS: usize = 128;
const SOCKET_PENDING_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const HTTP_REQUEST_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const HTTP_RESPONSE_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const BACKPRESSURE_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_INITIAL_BYTES: usize = 64 * 1024;
const OUTPUT_POLL_MS: u64 = 50;
const LEASE_CHECK_MS: u64 = 500;
const STREAM_DATA_CHUNK_BYTES: usize = 64 * 1024;
const MAX_BACKOFF_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct TunnelFrame {
    pub stream_id: String,
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

impl TunnelFrame {
    fn new(stream_id: impl Into<String>, frame_type: impl Into<String>, payload: Value) -> Self {
        Self {
            stream_id: stream_id.into(),
            frame_type: frame_type.into(),
            payload: Some(payload),
        }
    }

    fn empty(stream_id: impl Into<String>, frame_type: impl Into<String>) -> Self {
        Self {
            stream_id: stream_id.into(),
            frame_type: frame_type.into(),
            payload: Some(json!({})),
        }
    }
}

#[derive(Debug)]
pub struct TunnelControl {
    shutdown: watch::Sender<bool>,
    join: TauriJoinHandle<()>,
}

impl TunnelControl {
    fn stop(self) {
        let _ = self.shutdown.send(true);
        self.join.abort();
    }
}

#[derive(Debug, Clone)]
struct TunnelConfig {
    tunnel_url: String,
    device_token: String,
    instance_id: Option<String>,
}

#[derive(Debug)]
enum ActiveStream {
    Http(IncomingHttpRequest),
    Responding {
        response_id: u64,
        pending_bytes: usize,
        join: TokioJoinHandle<()>,
    },
    WebSocket {
        shutdown: watch::Sender<bool>,
        join: TokioJoinHandle<()>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamOpenPayload {
    kind: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    headers: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
struct IncomingHttpRequest {
    method: String,
    path: String,
    query: Option<String>,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    queued_frames: usize,
}

impl IncomingHttpRequest {
    fn new(payload: StreamOpenPayload) -> Result<Self, AppError> {
        let method = payload
            .method
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Other("HTTP tunnel request is missing method".into()))?;
        let path = payload
            .path
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Other("HTTP tunnel request is missing path".into()))?;

        Ok(Self {
            method,
            path,
            query: payload.query.filter(|value| !value.is_empty()),
            headers: payload.headers,
            body: Vec::new(),
            queued_frames: 0,
        })
    }

    fn push_data(&mut self, data: &[u8]) -> Result<(), StreamErrorPayload> {
        if self.queued_frames >= STREAM_QUEUE_MAX_SIZE {
            return Err(StreamErrorPayload::new(
                "backpressure_timeout",
                "stream data queue limit exceeded",
                false,
            ));
        }
        if self.body.len().saturating_add(data.len()) > STREAM_PENDING_BYTES_LIMIT
            || self.body.len().saturating_add(data.len()) > HTTP_REQUEST_BYTES_LIMIT
        {
            return Err(StreamErrorPayload::new(
                "backpressure_limit_exceeded",
                "stream pending byte limit exceeded",
                false,
            ));
        }
        self.queued_frames += 1;
        self.body.extend_from_slice(data);
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamErrorPayload {
    message: String,
    code: String,
    retryable: bool,
}

impl StreamErrorPayload {
    fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            retryable,
        }
    }
}

type OutboundSender = mpsc::Sender<TunnelFrame>;
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResponseCompletion {
    stream_id: String,
    response_id: u64,
}

type CompletionSender = mpsc::UnboundedSender<ResponseCompletion>;

#[derive(Debug)]
enum TunnelConnectionError {
    Retry(AppError),
    FatalAuth(AppError),
}

impl TunnelConnectionError {
    fn retry(message: impl Into<String>) -> Self {
        Self::Retry(AppError::Other(message.into()))
    }

    fn fatal_auth(message: impl Into<String>) -> Self {
        Self::FatalAuth(AppError::Other(message.into()))
    }
}

impl From<AppError> for TunnelConnectionError {
    fn from(error: AppError) -> Self {
        Self::Retry(error)
    }
}

pub async fn start_tunnel_from_settings(
    state: Arc<AppState>,
    app_handle: AppHandle,
) -> Result<CloudStatus, AppError> {
    stop_tunnel(&state)?;

    let settings = load_settings().remote;
    let config = build_tunnel_config(&settings).await?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let worker_state = state.clone();
    let worker_app = app_handle.clone();
    let worker_config = config.clone();
    let join = tauri::async_runtime::spawn(async move {
        run_tunnel_loop(worker_state, worker_app, worker_config, shutdown_rx).await;
    });

    {
        let mut tunnel = state.cloud_tunnel.lock_or_err()?;
        *tunnel = Some(TunnelControl {
            shutdown: shutdown_tx,
            join,
        });
    }

    set_cloud_status(
        &state,
        false,
        config.instance_id.clone().or(settings.cloud_instance_id),
        None,
    )
}

pub async fn start_auto_reconnect(
    state: Arc<AppState>,
    app_handle: AppHandle,
) -> Result<Option<CloudStatus>, AppError> {
    let settings = load_settings().remote;
    if !settings.cloud_enabled || !settings.cloud_auto_reconnect {
        return Ok(None);
    }
    if settings
        .cloud_tunnel_url
        .as_deref()
        .unwrap_or("")
        .is_empty()
    {
        return Ok(None);
    }
    if read_device_token_async().await?.is_none() {
        return Ok(None);
    }

    start_tunnel_from_settings(state, app_handle)
        .await
        .map(Some)
}

pub fn stop_tunnel(state: &AppState) -> Result<(), AppError> {
    {
        let mut tunnel = state.cloud_tunnel.lock_or_err()?;
        if let Some(control) = tunnel.take() {
            control.stop();
        }
    }
    Ok(())
}

async fn build_tunnel_config(settings: &RemoteSettings) -> Result<TunnelConfig, AppError> {
    if !settings.cloud_enabled {
        return Err(AppError::Other("Cloud tunnel is not enabled".into()));
    }
    let tunnel_url = settings
        .cloud_tunnel_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Other("Cloud tunnel URL is missing".into()))?;
    let device_token = read_device_token_async()
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Other("Cloud device token is missing".into()))?;

    Ok(TunnelConfig {
        tunnel_url,
        device_token,
        instance_id: settings.cloud_instance_id.clone(),
    })
}

async fn read_device_token_async() -> Result<Option<String>, AppError> {
    tokio::task::spawn_blocking(keyring_store::get_device_token)
        .await
        .map_err(|e| AppError::Other(format!("Cloud keyring task failed: {e}")))?
}

async fn run_tunnel_loop(
    state: Arc<AppState>,
    app_handle: AppHandle,
    config: TunnelConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut attempt = 0_u32;
    let mut preserve_last_error = false;
    loop {
        if *shutdown.borrow() {
            break;
        }

        match connect_once(
            state.clone(),
            app_handle.clone(),
            config.clone(),
            shutdown.clone(),
        )
        .await
        {
            Ok(()) => {
                attempt = 0;
                let _ = set_cloud_status(&state, false, config.instance_id.clone(), None);
                if *shutdown.borrow() {
                    break;
                }
            }
            Err(TunnelConnectionError::Retry(error)) => {
                attempt = attempt.saturating_add(1);
                let _ = set_cloud_status(
                    &state,
                    false,
                    config.instance_id.clone(),
                    Some(error.to_string()),
                );
                tracing::warn!(error = %error, "cloud tunnel connection failed");
            }
            Err(TunnelConnectionError::FatalAuth(error)) => {
                preserve_last_error = true;
                let _ = set_cloud_status(
                    &state,
                    false,
                    config.instance_id.clone(),
                    Some(error.to_string()),
                );
                tracing::warn!(error = %error, "cloud tunnel authentication failed");
                break;
            }
        }

        let delay = reconnect_backoff(attempt);
        tokio::select! {
            _ = sleep(delay) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
        }
    }

    if !preserve_last_error {
        let _ = set_cloud_status(&state, false, config.instance_id, None);
    }
}

async fn connect_once(
    state: Arc<AppState>,
    app_handle: AppHandle,
    config: TunnelConfig,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), TunnelConnectionError> {
    let request = build_ws_request(&config.tunnel_url, &config.device_token)?;
    let (socket, _) = connect_async(request).await.map_err(map_ws_dial_error)?;
    let (mut writer, mut reader) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<TunnelFrame>(OUTBOUND_QUEUE_SIZE);
    let (completion_tx, mut completion_rx) = mpsc::unbounded_channel::<ResponseCompletion>();
    let mut writer_shutdown = shutdown.clone();

    let writer_join = tokio::spawn(async move {
        let mut heartbeat = interval(HEARTBEAT_INTERVAL);
        loop {
            tokio::select! {
                maybe_frame = outbound_rx.recv() => {
                    let Some(frame) = maybe_frame else {
                        break;
                    };
                    let Ok(text) = serde_json::to_string(&frame) else {
                        continue;
                    };
                    if writer.send(WsMessage::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    let frame = TunnelFrame::empty(CONTROL_STREAM_ID, FRAME_HEARTBEAT);
                    let Ok(text) = serde_json::to_string(&frame) else {
                        continue;
                    };
                    if writer.send(WsMessage::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                changed = writer_shutdown.changed() => {
                    if changed.is_err() || *writer_shutdown.borrow() {
                        let _ = writer.send(WsMessage::Close(None)).await;
                        break;
                    }
                }
            }
        }
    });

    let mut active_streams: HashMap<String, ActiveStream> = HashMap::new();
    let mut socket_pending_bytes = 0_usize;
    let mut next_response_id = 1_u64;
    let mut terminal_error: Option<TunnelConnectionError> = None;
    loop {
        tokio::select! {
            message = reader.next() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    Ok(WsMessage::Text(text)) => {
                        match parse_frame(text.as_ref()) {
                            Ok(frame) => {
                                handle_frame(
                                    frame,
                                    &mut active_streams,
                                    &mut socket_pending_bytes,
                                    &mut next_response_id,
                                    &outbound_tx,
                                    &completion_tx,
                                    &state,
                                    &app_handle,
                                ).await;
                            }
                            Err(error) => {
                                handle_malformed_frame(text.as_ref(), error, &outbound_tx).await;
                            }
                        }
                    }
                    Ok(WsMessage::Close(frame)) => {
                        if let Some(error) = close_frame_auth_error(frame.as_ref()) {
                            terminal_error = Some(TunnelConnectionError::FatalAuth(error));
                        }
                        break;
                    }
                    Ok(WsMessage::Ping(_)) | Ok(WsMessage::Pong(_)) => {}
                    Ok(WsMessage::Binary(_)) => {
                        tracing::debug!("cloud tunnel ignored raw binary message");
                    }
                    Ok(WsMessage::Frame(_)) => {}
                    Err(error) => {
                        terminal_error = Some(TunnelConnectionError::retry(format!(
                            "Cloud tunnel read failed: {error}"
                        )));
                        break;
                    }
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            completed = completion_rx.recv() => {
                if let Some(completion) = completed {
                    let _ = handle_response_completion(
                        &mut active_streams,
                        completion,
                        &mut socket_pending_bytes,
                    );
                }
            }
        }
    }

    for (_, stream) in active_streams.drain() {
        close_active_stream(stream);
    }
    writer_join.abort();
    if let Some(error) = terminal_error {
        return Err(error);
    }
    Ok(())
}

fn build_ws_request(
    tunnel_url: &str,
    device_token: &str,
) -> Result<ws_http::Request<()>, AppError> {
    let mut request = tunnel_url
        .into_client_request()
        .map_err(|e| AppError::Other(format!("Invalid cloud tunnel URL: {e}")))?;
    let header = ws_http::HeaderValue::from_str(&format!("Bearer {device_token}"))
        .map_err(|e| AppError::Other(format!("Invalid cloud device token header: {e}")))?;
    request
        .headers_mut()
        .insert(ws_http::header::AUTHORIZATION, header);
    Ok(request)
}

fn map_ws_dial_error(error: WsError) -> TunnelConnectionError {
    match error {
        WsError::Http(response) if response.status() == ws_http::StatusCode::UNAUTHORIZED => {
            TunnelConnectionError::fatal_auth(
                "Cloud tunnel authentication failed during handshake; re-pair is required",
            )
        }
        other => TunnelConnectionError::retry(format!("Cloud tunnel dial failed: {other}")),
    }
}

fn close_frame_auth_error(frame: Option<&CloseFrame>) -> Option<AppError> {
    let frame = frame?;
    let code = close_code_u16(frame.code);
    if !auth_close_code(code) {
        return None;
    }

    let reason = frame.reason.to_string();
    let message = if reason.trim().is_empty() {
        format!("Cloud tunnel authentication failed with close code {code}; re-pair is required")
    } else {
        format!(
            "Cloud tunnel authentication failed with close code {code}: {reason}; re-pair is required"
        )
    };
    Some(AppError::Other(message))
}

fn close_code_u16(code: CloseCode) -> u16 {
    code.into()
}

fn auth_close_code(code: u16) -> bool {
    code == 4001 || code % 1000 == 401
}

fn parse_frame(text: &str) -> Result<TunnelFrame, AppError> {
    serde_json::from_str(text).map_err(AppError::Json)
}

async fn handle_malformed_frame(text: &str, error: AppError, outbound_tx: &OutboundSender) {
    if let Some(stream_id) = stream_id_from_malformed_frame(text) {
        let _ = send_stream_error(
            outbound_tx,
            &stream_id,
            StreamErrorPayload::new("malformed_frame", error.to_string(), false),
        )
        .await;
        return;
    }

    tracing::warn!(error = %error, "cloud tunnel ignored malformed frame");
}

fn stream_id_from_malformed_frame(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("stream_id")
        .or_else(|| value.get("streamId"))
        .and_then(Value::as_str)
        .filter(|stream_id| !stream_id.trim().is_empty())
        .map(str::to_string)
}

async fn handle_frame(
    frame: TunnelFrame,
    active_streams: &mut HashMap<String, ActiveStream>,
    socket_pending_bytes: &mut usize,
    next_response_id: &mut u64,
    outbound_tx: &OutboundSender,
    completion_tx: &CompletionSender,
    state: &Arc<AppState>,
    app_handle: &AppHandle,
) {
    let outbound = outbound_tx.clone();
    let completion = completion_tx.clone();
    let dispatch_state = state.clone();
    let app_handle = app_handle.clone();
    handle_frame_with_dispatch(
        frame,
        active_streams,
        socket_pending_bytes,
        next_response_id,
        outbound_tx,
        state.clone(),
        move |task_stream_id, response_id, request| {
            tokio::spawn(async move {
                if let Err(error) = dispatch_http_stream(
                    task_stream_id.clone(),
                    request,
                    outbound.clone(),
                    dispatch_state,
                    app_handle,
                )
                .await
                {
                    let _ = send_stream_error(
                        &outbound,
                        &task_stream_id,
                        StreamErrorPayload::new("http_dispatch_failed", error.to_string(), false),
                    )
                    .await;
                }
                let _ = completion.send(ResponseCompletion {
                    stream_id: task_stream_id,
                    response_id,
                });
            })
        },
    )
    .await;
}

async fn handle_frame_with_dispatch(
    frame: TunnelFrame,
    active_streams: &mut HashMap<String, ActiveStream>,
    socket_pending_bytes: &mut usize,
    next_response_id: &mut u64,
    outbound_tx: &OutboundSender,
    state: Arc<AppState>,
    spawn_dispatch: impl FnOnce(String, u64, IncomingHttpRequest) -> TokioJoinHandle<()>,
) {
    match frame.frame_type.as_str() {
        FRAME_READY | FRAME_HEARTBEAT_ACK => {
            if let Err(error) = apply_ready_frame(&state, &frame) {
                tracing::warn!(error = %error, "cloud tunnel ready handling failed");
            }
        }
        FRAME_ECHO_REQUEST => {
            let response = TunnelFrame::new(
                frame.stream_id,
                FRAME_ECHO_RESPONSE,
                frame.payload.unwrap_or_default(),
            );
            let _ = send_frame(outbound_tx, response).await;
        }
        FRAME_STREAM_OPEN => {
            handle_stream_open(
                frame,
                active_streams,
                socket_pending_bytes,
                outbound_tx,
                &state,
            )
            .await;
        }
        FRAME_STREAM_DATA => {
            handle_stream_data(frame, active_streams, socket_pending_bytes, outbound_tx).await;
        }
        FRAME_STREAM_CLOSE => {
            handle_stream_close(
                frame,
                active_streams,
                socket_pending_bytes,
                next_response_id,
                outbound_tx,
                spawn_dispatch,
            )
            .await;
        }
        FRAME_STREAM_ERROR => {
            if let Some(stream) =
                remove_active_stream(active_streams, &frame.stream_id, socket_pending_bytes)
            {
                close_active_stream(stream);
            }
            tracing::debug!(stream_id = %frame.stream_id, "cloud tunnel stream error received");
        }
        other => {
            tracing::debug!(frame_type = other, "cloud tunnel ignored unknown frame");
        }
    }
}

fn apply_ready_frame(state: &AppState, frame: &TunnelFrame) -> Result<CloudStatus, AppError> {
    let instance_id = frame
        .payload
        .as_ref()
        .and_then(|payload| payload.get("instanceId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    set_cloud_status(state, true, instance_id, None)
}

fn set_cloud_status(
    state: &AppState,
    connected: bool,
    instance_id: Option<String>,
    last_error: Option<String>,
) -> Result<CloudStatus, AppError> {
    let mut cloud = state.cloud.lock_or_err()?;
    let next = CloudStatus {
        connected,
        instance_id: instance_id.or_else(|| cloud.instance_id.clone()),
        last_error,
    };
    *cloud = next.clone();
    Ok(next)
}

async fn handle_stream_open(
    frame: TunnelFrame,
    active_streams: &mut HashMap<String, ActiveStream>,
    socket_pending_bytes: &mut usize,
    outbound_tx: &OutboundSender,
    state: &Arc<AppState>,
) {
    if active_streams.contains_key(&frame.stream_id) {
        let _ = send_stream_error(
            outbound_tx,
            &frame.stream_id,
            StreamErrorPayload::new("stream_id_conflict", "stream id is already active", false),
        )
        .await;
        return;
    }
    if active_streams.len() >= MAX_ACTIVE_STREAMS {
        let _ = send_stream_error(
            outbound_tx,
            &frame.stream_id,
            StreamErrorPayload::new("too_many_streams", "active stream limit exceeded", false),
        )
        .await;
        return;
    }

    let payload = match parse_stream_open_payload(&frame) {
        Ok(payload) => payload,
        Err(error) => {
            let _ = send_stream_error(
                outbound_tx,
                &frame.stream_id,
                StreamErrorPayload::new("bad_stream_open", error.to_string(), false),
            )
            .await;
            return;
        }
    };

    match payload.kind.as_str() {
        KIND_HTTP_REQUEST => match IncomingHttpRequest::new(payload) {
            Ok(request) => {
                active_streams.insert(frame.stream_id, ActiveStream::Http(request));
            }
            Err(error) => {
                let _ = send_stream_error(
                    outbound_tx,
                    &frame.stream_id,
                    StreamErrorPayload::new("bad_http_request", error.to_string(), false),
                )
                .await;
            }
        },
        KIND_WEBSOCKET => {
            let Some(path) = payload.path else {
                let _ = send_stream_error(
                    outbound_tx,
                    &frame.stream_id,
                    StreamErrorPayload::new(
                        "bad_websocket",
                        "websocket stream is missing path",
                        false,
                    ),
                )
                .await;
                return;
            };
            let Some(terminal_id) = terminal_id_from_output_path(&path) else {
                let _ = send_stream_error(
                    outbound_tx,
                    &frame.stream_id,
                    StreamErrorPayload::new("bad_websocket", "unsupported websocket path", false),
                )
                .await;
                return;
            };
            let Some(lease_id) = query_param(payload.query.as_deref(), "leaseId") else {
                let _ = send_stream_error(
                    outbound_tx,
                    &frame.stream_id,
                    StreamErrorPayload::new(
                        "bad_websocket",
                        "websocket stream is missing leaseId",
                        false,
                    ),
                )
                .await;
                return;
            };
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            let join = tokio::spawn(stream_terminal_output_over_tunnel(
                outbound_tx.clone(),
                state.clone(),
                frame.stream_id.clone(),
                terminal_id,
                lease_id,
                shutdown_rx,
            ));
            active_streams.insert(
                frame.stream_id,
                ActiveStream::WebSocket {
                    shutdown: shutdown_tx,
                    join,
                },
            );
        }
        _ => {
            let _ = send_stream_error(
                outbound_tx,
                &frame.stream_id,
                StreamErrorPayload::new(
                    "unsupported_stream_kind",
                    "unsupported stream kind",
                    false,
                ),
            )
            .await;
        }
    }
    let _ = socket_pending_bytes;
}

fn parse_stream_open_payload(frame: &TunnelFrame) -> Result<StreamOpenPayload, AppError> {
    let payload = frame
        .payload
        .clone()
        .ok_or_else(|| AppError::Other("stream.open payload is missing".into()))?;
    serde_json::from_value(payload).map_err(AppError::Json)
}

async fn handle_stream_data(
    frame: TunnelFrame,
    active_streams: &mut HashMap<String, ActiveStream>,
    socket_pending_bytes: &mut usize,
    outbound_tx: &OutboundSender,
) {
    let stream_id = frame.stream_id.clone();
    let Some(ActiveStream::Http(request)) = active_streams.get_mut(&stream_id) else {
        match active_streams.get(&stream_id) {
            Some(ActiveStream::WebSocket { .. }) => {}
            Some(ActiveStream::Responding { .. }) => {
                let _ = send_stream_error(
                    outbound_tx,
                    &stream_id,
                    StreamErrorPayload::new(
                        "stream_not_writable",
                        "stream is already awaiting response",
                        false,
                    ),
                )
                .await;
            }
            None => {
                let _ = send_unknown_stream(outbound_tx, &stream_id).await;
            }
            Some(ActiveStream::Http(_)) => {}
        }
        return;
    };

    let decoded = match decode_stream_data(&frame) {
        Ok(decoded) => decoded,
        Err(error) => {
            let _ = send_stream_error(
                outbound_tx,
                &stream_id,
                StreamErrorPayload::new("bad_stream_data", error.to_string(), false),
            )
            .await;
            remove_active_stream(active_streams, &stream_id, socket_pending_bytes);
            return;
        }
    };

    if socket_pending_bytes.saturating_add(decoded.len()) > SOCKET_PENDING_BYTES_LIMIT {
        let _ = send_stream_error(
            outbound_tx,
            &stream_id,
            StreamErrorPayload::new(
                "backpressure_limit_exceeded",
                "socket pending byte limit exceeded",
                false,
            ),
        )
        .await;
        remove_active_stream(active_streams, &stream_id, socket_pending_bytes);
        return;
    }

    if let Err(error) = request.push_data(&decoded) {
        let _ = send_stream_error(outbound_tx, &stream_id, error).await;
        remove_active_stream(active_streams, &stream_id, socket_pending_bytes);
        return;
    }
    *socket_pending_bytes = socket_pending_bytes.saturating_add(decoded.len());
}

async fn handle_stream_close(
    frame: TunnelFrame,
    active_streams: &mut HashMap<String, ActiveStream>,
    socket_pending_bytes: &mut usize,
    next_response_id: &mut u64,
    outbound_tx: &OutboundSender,
    spawn_dispatch: impl FnOnce(String, u64, IncomingHttpRequest) -> TokioJoinHandle<()>,
) {
    if begin_http_response_dispatch(
        active_streams,
        &frame.stream_id,
        next_response_id,
        spawn_dispatch,
    ) {
        return;
    }

    match active_streams.remove(&frame.stream_id) {
        Some(stream @ ActiveStream::WebSocket { .. }) => {
            subtract_stream_pending_bytes(&stream, socket_pending_bytes);
            close_active_stream(stream);
            let _ = send_frame(
                outbound_tx,
                TunnelFrame::empty(frame.stream_id, FRAME_STREAM_CLOSE),
            )
            .await;
        }
        Some(stream @ ActiveStream::Responding { .. }) => {
            subtract_stream_pending_bytes(&stream, socket_pending_bytes);
            close_active_stream(stream);
        }
        Some(stream @ ActiveStream::Http(_)) => {
            active_streams.insert(frame.stream_id, stream);
        }
        None => {
            let _ = send_unknown_stream(outbound_tx, &frame.stream_id).await;
        }
    }
}

fn begin_http_response_dispatch(
    active_streams: &mut HashMap<String, ActiveStream>,
    stream_id: &str,
    next_response_id: &mut u64,
    spawn_dispatch: impl FnOnce(String, u64, IncomingHttpRequest) -> TokioJoinHandle<()>,
) -> bool {
    let Some(stream) = active_streams.remove(stream_id) else {
        return false;
    };

    let ActiveStream::Http(request) = stream else {
        active_streams.insert(stream_id.to_string(), stream);
        return false;
    };

    let pending_bytes = request.body.len();
    let response_id = allocate_response_id(next_response_id);
    let task_stream_id = stream_id.to_string();
    let join = spawn_dispatch(task_stream_id, response_id, request);

    active_streams.insert(
        stream_id.to_string(),
        ActiveStream::Responding {
            response_id,
            pending_bytes,
            join,
        },
    );
    true
}

fn allocate_response_id(next_response_id: &mut u64) -> u64 {
    let response_id = (*next_response_id).max(1);
    *next_response_id = match response_id.checked_add(1) {
        Some(next) => next,
        None => 1,
    };
    response_id
}

fn handle_response_completion(
    active_streams: &mut HashMap<String, ActiveStream>,
    completion: ResponseCompletion,
    socket_pending_bytes: &mut usize,
) -> bool {
    let matches_current = matches!(
        active_streams.get(&completion.stream_id),
        Some(ActiveStream::Responding { response_id, .. }) if *response_id == completion.response_id
    );
    if !matches_current {
        tracing::debug!(
            stream_id = %completion.stream_id,
            response_id = completion.response_id,
            "ignored stale cloud tunnel response completion"
        );
        return false;
    }

    if let Some(stream) =
        remove_active_stream(active_streams, &completion.stream_id, socket_pending_bytes)
    {
        close_active_stream(stream);
        return true;
    }
    false
}

async fn dispatch_http_stream(
    stream_id: String,
    request: IncomingHttpRequest,
    outbound_tx: OutboundSender,
    state: Arc<AppState>,
    app_handle: AppHandle,
) -> Result<(), AppError> {
    let request = build_internal_remote_request(request)?;
    let server_state = ServerState {
        app_state: state,
        app_handle,
    };
    let router = crate::remote_server::build_router(server_state.clone()).with_state(server_state);
    let response = router
        .oneshot(request)
        .await
        .map_err(|e| AppError::Other(format!("Remote router dispatch failed: {e}")))?;

    send_http_response(stream_id, response, &outbound_tx).await
}

fn build_internal_remote_request(request: IncomingHttpRequest) -> Result<Request<Body>, AppError> {
    let method = request
        .method
        .parse::<Method>()
        .map_err(|e| AppError::Other(format!("Invalid tunneled HTTP method: {e}")))?;
    let uri = build_uri(&request.path, request.query.as_deref())?;
    let mut builder = Request::builder().method(method).uri(uri);
    let headers = builder
        .headers_mut()
        .ok_or_else(|| AppError::Other("Failed to build tunneled request headers".into()))?;
    copy_headers(&request.headers, headers)?;

    let mut request = builder
        .body(Body::from(request.body))
        .map_err(|e| AppError::Other(format!("Failed to build tunneled request: {e}")))?;
    request.extensions_mut().insert(TunnelAuthorized);
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        0,
    )));
    Ok(request)
}

fn build_uri(path: &str, query: Option<&str>) -> Result<Uri, AppError> {
    if !path.starts_with('/') {
        return Err(AppError::Other("Tunneled path must be origin-form".into()));
    }
    let value = match query.filter(|value| !value.is_empty()) {
        Some(query) => format!("{path}?{query}"),
        None => path.to_string(),
    };
    value
        .parse::<Uri>()
        .map_err(|e| AppError::Other(format!("Invalid tunneled URI: {e}")))
}

fn copy_headers(source: &[(String, String)], target: &mut HeaderMap) -> Result<(), AppError> {
    for (name, value) in source {
        let normalized = name.trim().to_ascii_lowercase();
        if normalized.is_empty() || hop_by_hop_header(&normalized) {
            continue;
        }
        let name = HeaderName::from_bytes(normalized.as_bytes())
            .map_err(|e| AppError::Other(format!("Invalid tunneled header name: {e}")))?;
        let value = HeaderValue::from_str(value)
            .map_err(|e| AppError::Other(format!("Invalid tunneled header value: {e}")))?;
        target.append(name, value);
    }
    Ok(())
}

async fn send_http_response(
    stream_id: String,
    response: axum::response::Response,
    outbound_tx: &OutboundSender,
) -> Result<(), AppError> {
    let status = response.status().as_u16();
    let headers = response_headers(response.headers());
    let body = to_bytes(response.into_body(), HTTP_RESPONSE_BYTES_LIMIT + 1)
        .await
        .map_err(|e| AppError::Other(format!("Remote response body read failed: {e}")))?;
    if body.len() > HTTP_RESPONSE_BYTES_LIMIT {
        return Err(AppError::Other(
            "Remote response body exceeded tunnel limit".into(),
        ));
    }

    let open = TunnelFrame::new(
        stream_id.clone(),
        FRAME_STREAM_OPEN,
        json!({
            "kind": KIND_HTTP_RESPONSE,
            "status": status,
            "headers": headers,
        }),
    );
    send_frame(outbound_tx, open).await?;
    for chunk in body.chunks(STREAM_DATA_CHUNK_BYTES) {
        send_stream_data(outbound_tx, &stream_id, chunk).await?;
    }
    send_frame(
        outbound_tx,
        TunnelFrame::empty(stream_id, FRAME_STREAM_CLOSE),
    )
    .await
}

fn response_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str().to_ascii_lowercase();
            if hop_by_hop_header(&name) {
                return None;
            }
            value.to_str().ok().map(|value| (name, value.to_string()))
        })
        .collect()
}

fn hop_by_hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "authorization"
    ) || name.eq_ignore_ascii_case(CONNECTION.as_str())
        || name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
}

async fn stream_terminal_output_over_tunnel(
    outbound_tx: OutboundSender,
    app_state: Arc<AppState>,
    stream_id: String,
    terminal_id: String,
    lease_id: String,
    mut shutdown: watch::Receiver<bool>,
) {
    let timeout_seconds = remote_output_timeout_seconds(&app_state);
    match remote_server::active_lease_matches_with_timeout(
        &app_state,
        &lease_id,
        Duration::from_secs(timeout_seconds),
    ) {
        Ok(true) => {}
        Ok(false) => {
            let _ = send_stream_error(
                &outbound_tx,
                &stream_id,
                StreamErrorPayload::new(
                    "lease_not_active",
                    "remote controller lease is not active",
                    false,
                ),
            )
            .await;
            return;
        }
        Err(error) => {
            let _ = send_stream_error(
                &outbound_tx,
                &stream_id,
                StreamErrorPayload::new("lease_check_failed", error, false),
            )
            .await;
            return;
        }
    }

    let (initial, mut seq) = match terminal_output_snapshot(&app_state, &terminal_id) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => {
            let _ = send_stream_error(
                &outbound_tx,
                &stream_id,
                StreamErrorPayload::new("terminal_not_found", "terminal session not found", false),
            )
            .await;
            return;
        }
        Err(error) => {
            let _ = send_stream_error(
                &outbound_tx,
                &stream_id,
                StreamErrorPayload::new("lock_failed", error.to_string(), false),
            )
            .await;
            return;
        }
    };

    // Handshake: the server holds the output stream pending a
    // `stream.open{kind:"websocket.accept"}` on the same stream_id. Without it
    // the server drops srv-XXX and rejects our subsequent output frames as
    // "Unknown stream_id". Send it once, after the local terminal (dial) is
    // confirmed present, before any output data. (HTTP sends stream.open
    // {http.response}; the websocket path needs its accept analog.)
    if send_frame(
        &outbound_tx,
        TunnelFrame::new(
            &stream_id,
            FRAME_STREAM_OPEN,
            json!({ "kind": KIND_WEBSOCKET_ACCEPT }),
        ),
    )
    .await
    .is_err()
    {
        return;
    }

    if !initial.is_empty()
        && send_stream_data(&outbound_tx, &stream_id, &initial)
            .await
            .is_err()
    {
        return;
    }

    let mut output_interval = interval(Duration::from_millis(OUTPUT_POLL_MS));
    let mut lease_check = interval(Duration::from_millis(LEASE_CHECK_MS));
    let mut sent_error = false;
    loop {
        tokio::select! {
            _ = output_interval.tick() => {
                let bytes = match terminal_output_delta(&app_state, &terminal_id, &mut seq) {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => {
                        let _ = send_stream_error(
                            &outbound_tx,
                            &stream_id,
                            StreamErrorPayload::new("terminal_not_found", "terminal session not found", false),
                        ).await;
                        sent_error = true;
                        break;
                    }
                    Err(error) => {
                        let _ = send_stream_error(
                            &outbound_tx,
                            &stream_id,
                            StreamErrorPayload::new("lock_failed", error.to_string(), false),
                        ).await;
                        sent_error = true;
                        break;
                    }
                };

                if !bytes.is_empty() && send_stream_data(&outbound_tx, &stream_id, &bytes).await.is_err() {
                    break;
                }
            }
            _ = lease_check.tick() => {
                match remote_server::active_lease_matches_with_timeout(
                    &app_state,
                    &lease_id,
                    Duration::from_secs(timeout_seconds),
                ) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        let _ = send_stream_error(
                            &outbound_tx,
                            &stream_id,
                            StreamErrorPayload::new("lease_check_failed", error, false),
                        ).await;
                        sent_error = true;
                        break;
                    }
                }
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
        }
    }

    if !sent_error {
        let _ = send_frame(
            &outbound_tx,
            TunnelFrame::empty(stream_id, FRAME_STREAM_CLOSE),
        )
        .await;
    }
}

fn terminal_output_snapshot(
    app_state: &AppState,
    terminal_id: &str,
) -> Result<Option<(Vec<u8>, u64)>, AppError> {
    let buffers = app_state.output_buffers.lock_or_err()?;
    Ok(buffers.get(terminal_id).map(|buffer| {
        (
            buffer.recent_bytes(OUTPUT_INITIAL_BYTES),
            buffer.write_seq(),
        )
    }))
}

fn terminal_output_delta(
    app_state: &AppState,
    terminal_id: &str,
    seq: &mut u64,
) -> Result<Option<Vec<u8>>, AppError> {
    let buffers = app_state.output_buffers.lock_or_err()?;
    let Some(buffer) = buffers.get(terminal_id) else {
        return Ok(None);
    };
    let bytes = buffer.bytes_since(*seq);
    *seq = buffer.write_seq();
    Ok(Some(bytes))
}

fn remote_output_timeout_seconds(app_state: &AppState) -> u64 {
    normalize_remote_output_timeout_seconds(
        remote_server::get_remote_control_status(app_state)
            .ok()
            .map(|status| status.heartbeat_timeout_seconds),
    )
}

fn normalize_remote_output_timeout_seconds(timeout_seconds: Option<u64>) -> u64 {
    timeout_seconds
        .unwrap_or(DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS)
        .max(MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS)
}

async fn send_stream_data(
    outbound_tx: &OutboundSender,
    stream_id: &str,
    data: &[u8],
) -> Result<(), AppError> {
    if data.is_empty() {
        return Ok(());
    }
    send_frame(
        outbound_tx,
        TunnelFrame::new(
            stream_id,
            FRAME_STREAM_DATA,
            json!({
                "encoding": ENCODING_BASE64,
                "data": BASE64.encode(data),
            }),
        ),
    )
    .await
}

async fn send_stream_error(
    outbound_tx: &OutboundSender,
    stream_id: &str,
    payload: StreamErrorPayload,
) -> Result<(), AppError> {
    let payload = serde_json::to_value(payload).map_err(AppError::Json)?;
    send_frame(
        outbound_tx,
        TunnelFrame::new(stream_id, FRAME_STREAM_ERROR, payload),
    )
    .await
}

async fn send_unknown_stream(
    outbound_tx: &OutboundSender,
    stream_id: &str,
) -> Result<(), AppError> {
    send_stream_error(
        outbound_tx,
        stream_id,
        StreamErrorPayload::new("unknown_stream", "stream is not active", false),
    )
    .await
}

async fn send_frame(outbound_tx: &OutboundSender, frame: TunnelFrame) -> Result<(), AppError> {
    timeout(BACKPRESSURE_TIMEOUT, outbound_tx.send(frame))
        .await
        .map_err(|_| AppError::Other("Cloud tunnel outbound backpressure timeout".into()))?
        .map_err(|_| AppError::Other("Cloud tunnel outbound writer closed".into()))
}

fn decode_stream_data(frame: &TunnelFrame) -> Result<Vec<u8>, AppError> {
    let payload = frame
        .payload
        .as_ref()
        .ok_or_else(|| AppError::Other("stream.data payload is missing".into()))?;
    let encoding = payload
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or(ENCODING_BASE64);
    if encoding != ENCODING_BASE64 {
        return Err(AppError::Other(format!(
            "Unsupported stream.data encoding: {encoding}"
        )));
    }
    let data = payload
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Other("stream.data payload is missing data".into()))?;
    BASE64
        .decode(data)
        .map_err(|e| AppError::Other(format!("Invalid stream.data base64: {e}")))
}

fn remove_active_stream(
    active_streams: &mut HashMap<String, ActiveStream>,
    stream_id: &str,
    socket_pending_bytes: &mut usize,
) -> Option<ActiveStream> {
    let stream = active_streams.remove(stream_id)?;
    subtract_stream_pending_bytes(&stream, socket_pending_bytes);
    Some(stream)
}

fn subtract_stream_pending_bytes(stream: &ActiveStream, socket_pending_bytes: &mut usize) {
    let pending_bytes = match stream {
        ActiveStream::Http(request) => request.body.len(),
        ActiveStream::Responding { pending_bytes, .. } => *pending_bytes,
        ActiveStream::WebSocket { .. } => 0,
    };
    *socket_pending_bytes = socket_pending_bytes.saturating_sub(pending_bytes);
}

fn close_active_stream(stream: ActiveStream) {
    match stream {
        ActiveStream::WebSocket { shutdown, join } => {
            let _ = shutdown.send(true);
            join.abort();
        }
        ActiveStream::Responding { join, .. } => {
            join.abort();
        }
        ActiveStream::Http(_) => {}
    }
}

fn terminal_id_from_output_path(path: &str) -> Option<String> {
    path.strip_prefix("/remote/v1/terminals/")
        .and_then(|rest| rest.strip_suffix("/output"))
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key && !value.is_empty()).then(|| decode_query_component(value))?
    })
}

fn decode_query_component(value: &str) -> Option<String> {
    let input = value.as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        match input[index] {
            b'%' => {
                let high = hex_value(*input.get(index + 1)?)?;
                let low = hex_value(*input.get(index + 2)?)?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn reconnect_backoff(attempt: u32) -> Duration {
    let shift = attempt.min(5);
    let seconds = (1_u64 << shift).min(MAX_BACKOFF_SECONDS);
    Duration::from_secs(seconds)
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::Path;
    use std::time::Instant;

    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use serial_test::serial;

    use super::*;
    use crate::output_buffer::TerminalOutputBuffer;
    use crate::settings::{save_settings, Settings};

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

    fn http_open_frame(stream_id: impl Into<String>) -> TunnelFrame {
        TunnelFrame::new(
            stream_id,
            FRAME_STREAM_OPEN,
            json!({
                "kind": KIND_HTTP_REQUEST,
                "method": "POST",
                "path": "/remote/v1/health",
            }),
        )
    }

    fn error_code(frame: &TunnelFrame) -> Option<&str> {
        frame.payload.as_ref()?.get("code")?.as_str()
    }

    fn save_remote_enabled(enabled: bool) {
        save_remote_enabled_with_token(enabled, "remote-token");
    }

    fn save_remote_enabled_with_token(enabled: bool, auth_token: &str) {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = auth_token.into();
        save_settings(&settings).unwrap();
    }

    #[test]
    fn remote_output_timeout_uses_shared_reconnect_policy() {
        assert_eq!(normalize_remote_output_timeout_seconds(None), 45);
        assert_eq!(normalize_remote_output_timeout_seconds(Some(5)), 30);
        assert_eq!(normalize_remote_output_timeout_seconds(Some(60)), 60);
    }

    fn state_with_terminal_output_and_lease(lease_id: &str) -> Arc<AppState> {
        let state = Arc::new(AppState::new());
        let mut buffer = TerminalOutputBuffer::default();
        buffer.push(b"initial output");
        {
            let mut buffers = state.output_buffers.lock_or_err().unwrap();
            buffers.insert("term-1".into(), buffer);
        }
        {
            let mut control = state.remote_control.lock_or_err().unwrap();
            control.lease = Some(remote_server::RemoteControlLease {
                lease_id: lease_id.into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: Instant::now(),
            });
        }
        state
    }

    async fn spawn_output_stream(
        state: Arc<AppState>,
        lease_id: &str,
    ) -> (
        mpsc::Receiver<TunnelFrame>,
        watch::Sender<bool>,
        TokioJoinHandle<()>,
    ) {
        let (tx, rx) = mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let join = tokio::spawn(stream_terminal_output_over_tunnel(
            tx,
            state,
            "srv-output".into(),
            "term-1".into(),
            lease_id.into(),
            shutdown_rx,
        ));
        (rx, shutdown_tx, join)
    }

    async fn assert_output_stream_rejects_before_accept(
        mut rx: mpsc::Receiver<TunnelFrame>,
        join: TokioJoinHandle<()>,
    ) {
        let first = timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.stream_id, "srv-output");
        assert_eq!(first.frame_type, FRAME_STREAM_ERROR);
        assert_eq!(error_code(&first), Some("lease_not_active"));

        timeout(Duration::from_secs(1), join)
            .await
            .unwrap()
            .unwrap();
        assert!(rx.recv().await.is_none());
    }

    fn pending_response_task() -> TokioJoinHandle<()> {
        tokio::spawn(async {
            std::future::pending::<()>().await;
        })
    }

    async fn handle_test_frame(
        frame: TunnelFrame,
        active_streams: &mut HashMap<String, ActiveStream>,
        socket_pending_bytes: &mut usize,
        next_response_id: &mut u64,
        outbound_tx: &OutboundSender,
        state: Arc<AppState>,
        spawn_dispatch: impl FnOnce(String, u64, IncomingHttpRequest) -> TokioJoinHandle<()>,
    ) {
        handle_frame_with_dispatch(
            frame,
            active_streams,
            socket_pending_bytes,
            next_response_id,
            outbound_tx,
            state,
            spawn_dispatch,
        )
        .await;
    }

    fn pending_dispatch() -> impl FnOnce(String, u64, IncomingHttpRequest) -> TokioJoinHandle<()> {
        |_, _, _| pending_response_task()
    }

    fn immediate_completion_dispatch(
        completion_tx: CompletionSender,
    ) -> impl FnOnce(String, u64, IncomingHttpRequest) -> TokioJoinHandle<()> {
        move |stream_id, response_id, _| {
            let _ = completion_tx.send(ResponseCompletion {
                stream_id,
                response_id,
            });
            pending_response_task()
        }
    }

    fn close_test_streams(active_streams: HashMap<String, ActiveStream>) {
        for (_, stream) in active_streams {
            close_active_stream(stream);
        }
    }

    #[test]
    fn stream_frame_codec_round_trips() {
        let frame = TunnelFrame::new(
            "srv-1",
            FRAME_STREAM_OPEN,
            json!({
                "kind": KIND_HTTP_REQUEST,
                "method": "POST",
                "path": "/remote/v1/health",
                "query": "leaseId=l1",
                "headers": [["content-type", "application/json"]]
            }),
        );

        let json = serde_json::to_string(&frame).unwrap();
        let decoded: TunnelFrame = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded, frame);
    }

    #[test]
    fn stream_data_decodes_base64() {
        let frame = TunnelFrame::new(
            "srv-1",
            FRAME_STREAM_DATA,
            json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(b"hello") }),
        );

        assert_eq!(decode_stream_data(&frame).unwrap(), b"hello");
    }

    #[test]
    fn ready_frame_marks_cloud_connected() {
        let state = AppState::new();
        let frame = TunnelFrame::new(
            CONTROL_STREAM_ID,
            FRAME_READY,
            json!({ "instanceId": "instance-1" }),
        );

        let status = apply_ready_frame(&state, &frame).unwrap();

        assert!(status.connected);
        assert_eq!(status.instance_id.as_deref(), Some("instance-1"));
        assert_eq!(*state.cloud.lock_or_err().unwrap(), status);
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_capped() {
        assert_eq!(reconnect_backoff(0), Duration::from_secs(1));
        assert_eq!(reconnect_backoff(1), Duration::from_secs(2));
        assert_eq!(reconnect_backoff(4), Duration::from_secs(16));
        assert_eq!(reconnect_backoff(5), Duration::from_secs(30));
        assert_eq!(reconnect_backoff(12), Duration::from_secs(30));
    }

    #[test]
    fn http_body_backpressure_rejects_limit_overflow() {
        let payload = StreamOpenPayload {
            kind: KIND_HTTP_REQUEST.into(),
            method: Some("POST".into()),
            path: Some("/remote/v1/health".into()),
            query: None,
            headers: Vec::new(),
        };
        let mut request = IncomingHttpRequest::new(payload).unwrap();
        request.body = vec![0; STREAM_PENDING_BYTES_LIMIT];

        let error = request.push_data(&[1]).unwrap_err();

        assert_eq!(error.code, "backpressure_limit_exceeded");
    }

    #[test]
    fn build_internal_request_injects_loopback_and_tunnel_marker() {
        let request = IncomingHttpRequest {
            method: "GET".into(),
            path: "/remote/v1/health".into(),
            query: Some("x=1".into()),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("connection".into(), "keep-alive".into()),
                ("authorization".into(), "Bearer external".into()),
            ],
            body: Vec::new(),
            queued_frames: 0,
        };

        let request = build_internal_remote_request(request).unwrap();

        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.uri(), "/remote/v1/health?x=1");
        assert!(request.headers().get("authorization").is_none());
        assert!(request.headers().get(CONNECTION).is_none());
        assert!(request.extensions().get::<TunnelAuthorized>().is_some());
        let ConnectInfo(addr) = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .copied()
            .unwrap();
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    #[test]
    #[serial]
    fn tunnel_request_does_not_enable_runtime_direct_remote() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());

        let mut settings = Settings::default();
        settings.remote.enabled = false;
        settings.remote.auth_token = "persistent-token".into();
        save_settings(&settings).unwrap();

        let state = AppState::new();
        let request = IncomingHttpRequest {
            method: "GET".into(),
            path: "/remote/v1/health".into(),
            query: None,
            headers: Vec::new(),
            body: Vec::new(),
            queued_frames: 0,
        };

        let request = build_internal_remote_request(request).unwrap();
        let status = remote_server::get_remote_access_status(&state).unwrap();

        assert!(request.extensions().get::<TunnelAuthorized>().is_some());
        assert!(!status.runtime_enabled);
        assert!(!status.effective_enabled);
        assert!(status.auth_token_configured);
    }

    #[tokio::test]
    #[serial]
    async fn terminal_output_stream_sends_websocket_accept_before_data() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());

        save_remote_enabled(true);
        let state = state_with_terminal_output_and_lease("lease-1");
        let (mut rx, shutdown_tx, join) = spawn_output_stream(state, "lease-1").await;

        let first = timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.stream_id, "srv-output");
        assert_eq!(first.frame_type, FRAME_STREAM_OPEN);
        assert_eq!(
            first
                .payload
                .as_ref()
                .and_then(|payload| payload.get("kind"))
                .and_then(Value::as_str),
            Some(KIND_WEBSOCKET_ACCEPT)
        );

        let second = timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.stream_id, "srv-output");
        assert_eq!(second.frame_type, FRAME_STREAM_DATA);
        assert_eq!(decode_stream_data(&second).unwrap(), b"initial output");

        shutdown_tx.send(true).unwrap();
        timeout(Duration::from_secs(1), join)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn terminal_output_stream_accepts_enabled_cloud_lease_without_remote_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());

        save_remote_enabled_with_token(true, "");
        let state = state_with_terminal_output_and_lease("lease-1");
        let (mut rx, shutdown_tx, join) = spawn_output_stream(state, "lease-1").await;

        let first = timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.stream_id, "srv-output");
        assert_eq!(first.frame_type, FRAME_STREAM_OPEN);
        assert_eq!(
            first
                .payload
                .as_ref()
                .and_then(|payload| payload.get("kind"))
                .and_then(Value::as_str),
            Some(KIND_WEBSOCKET_ACCEPT)
        );

        let second = timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.stream_id, "srv-output");
        assert_eq!(second.frame_type, FRAME_STREAM_DATA);
        assert_eq!(decode_stream_data(&second).unwrap(), b"initial output");

        shutdown_tx.send(true).unwrap();
        timeout(Duration::from_secs(1), join)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    #[serial]
    async fn terminal_output_stream_rejects_disabled_remote_before_accept_or_data() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());

        save_remote_enabled(false);
        let state = state_with_terminal_output_and_lease("lease-1");
        let (rx, _shutdown_tx, join) = spawn_output_stream(state, "lease-1").await;

        assert_output_stream_rejects_before_accept(rx, join).await;
    }

    #[tokio::test]
    #[serial]
    async fn terminal_output_stream_rejects_invalid_lease_before_accept_or_data() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());

        save_remote_enabled(true);
        let state = state_with_terminal_output_and_lease("lease-1");
        let (rx, _shutdown_tx, join) = spawn_output_stream(state, "stale-lease").await;

        assert_output_stream_rejects_before_accept(rx, join).await;
    }

    #[tokio::test]
    async fn same_stream_id_reopen_conflicts_before_response_completion() {
        let (tx, mut rx) = mpsc::channel(4);
        let state = Arc::new(AppState::new());
        let mut active_streams = HashMap::new();
        let mut socket_pending_bytes = 0;
        let mut next_response_id = 1;

        handle_test_frame(
            http_open_frame("srv-1"),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;
        handle_test_frame(
            TunnelFrame::empty("srv-1", FRAME_STREAM_CLOSE),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;

        handle_test_frame(
            http_open_frame("srv-1"),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state,
            pending_dispatch(),
        )
        .await;

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.frame_type, FRAME_STREAM_ERROR);
        assert_eq!(error_code(&frame), Some("stream_id_conflict"));
        assert!(matches!(
            active_streams.get("srv-1"),
            Some(ActiveStream::Responding { .. })
        ));
        close_test_streams(active_streams);
    }

    #[tokio::test]
    async fn stale_completion_does_not_remove_reopened_stream_or_decrement_counter() {
        let (tx, _rx) = mpsc::channel(4);
        let (completion_tx, mut completion_rx) = mpsc::unbounded_channel();
        let state = Arc::new(AppState::new());
        let mut active_streams = HashMap::new();
        let mut socket_pending_bytes = 0;
        let mut next_response_id = 1;

        handle_test_frame(
            http_open_frame("srv-1"),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;
        handle_test_frame(
            TunnelFrame::new(
                "srv-1",
                FRAME_STREAM_DATA,
                json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(b"old") }),
            ),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;
        handle_test_frame(
            TunnelFrame::empty("srv-1", FRAME_STREAM_CLOSE),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            immediate_completion_dispatch(completion_tx),
        )
        .await;
        assert!(matches!(
            active_streams.get("srv-1"),
            Some(ActiveStream::Responding { response_id: 1, .. })
        ));
        assert_eq!(socket_pending_bytes, 3);

        handle_test_frame(
            TunnelFrame::empty("srv-1", FRAME_STREAM_ERROR),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;
        assert!(!active_streams.contains_key("srv-1"));
        assert_eq!(socket_pending_bytes, 0);

        handle_test_frame(
            http_open_frame("srv-1"),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;
        handle_test_frame(
            TunnelFrame::new(
                "srv-1",
                FRAME_STREAM_DATA,
                json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(b"new") }),
            ),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state,
            pending_dispatch(),
        )
        .await;

        let stale = completion_rx.recv().await.unwrap();
        assert!(!handle_response_completion(
            &mut active_streams,
            stale,
            &mut socket_pending_bytes
        ));
        assert!(matches!(
            active_streams.get("srv-1"),
            Some(ActiveStream::Http(request)) if request.body == b"new"
        ));
        assert_eq!(socket_pending_bytes, 3);
        close_test_streams(active_streams);
    }

    #[tokio::test]
    async fn open_data_close_reopen_cycle_hits_active_stream_limit() {
        let (tx, mut rx) = mpsc::channel(4);
        let state = Arc::new(AppState::new());
        let mut active_streams = HashMap::new();
        let mut socket_pending_bytes = 0;
        let mut next_response_id = 1;

        for index in 0..MAX_ACTIVE_STREAMS {
            let stream_id = format!("srv-{index}");
            handle_test_frame(
                http_open_frame(&stream_id),
                &mut active_streams,
                &mut socket_pending_bytes,
                &mut next_response_id,
                &tx,
                state.clone(),
                pending_dispatch(),
            )
            .await;
            handle_test_frame(
                TunnelFrame::new(
                    &stream_id,
                    FRAME_STREAM_DATA,
                    json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(b"x") }),
                ),
                &mut active_streams,
                &mut socket_pending_bytes,
                &mut next_response_id,
                &tx,
                state.clone(),
                pending_dispatch(),
            )
            .await;
            handle_test_frame(
                TunnelFrame::empty(&stream_id, FRAME_STREAM_CLOSE),
                &mut active_streams,
                &mut socket_pending_bytes,
                &mut next_response_id,
                &tx,
                state.clone(),
                pending_dispatch(),
            )
            .await;
        }

        handle_test_frame(
            http_open_frame("srv-overflow"),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state,
            pending_dispatch(),
        )
        .await;

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.frame_type, FRAME_STREAM_ERROR);
        assert_eq!(error_code(&frame), Some("too_many_streams"));
        assert!(!active_streams.contains_key("srv-overflow"));
        assert_eq!(active_streams.len(), MAX_ACTIVE_STREAMS);
        close_test_streams(active_streams);
    }

    #[tokio::test]
    async fn open_data_close_reopen_cycle_hits_socket_pending_limit() {
        let (tx, mut rx) = mpsc::channel(4);
        let state = Arc::new(AppState::new());
        let mut active_streams = HashMap::new();
        let mut socket_pending_bytes = 0;
        let mut next_response_id = 1;
        let chunk = vec![b'x'; SOCKET_PENDING_BYTES_LIMIT / 8];

        for index in 0..8 {
            let stream_id = format!("srv-{index}");
            handle_test_frame(
                http_open_frame(&stream_id),
                &mut active_streams,
                &mut socket_pending_bytes,
                &mut next_response_id,
                &tx,
                state.clone(),
                pending_dispatch(),
            )
            .await;
            handle_test_frame(
                TunnelFrame::new(
                    &stream_id,
                    FRAME_STREAM_DATA,
                    json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(&chunk) }),
                ),
                &mut active_streams,
                &mut socket_pending_bytes,
                &mut next_response_id,
                &tx,
                state.clone(),
                pending_dispatch(),
            )
            .await;
            handle_test_frame(
                TunnelFrame::empty(&stream_id, FRAME_STREAM_CLOSE),
                &mut active_streams,
                &mut socket_pending_bytes,
                &mut next_response_id,
                &tx,
                state.clone(),
                pending_dispatch(),
            )
            .await;
        }
        assert_eq!(socket_pending_bytes, SOCKET_PENDING_BYTES_LIMIT);

        handle_test_frame(
            http_open_frame("srv-overflow"),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state.clone(),
            pending_dispatch(),
        )
        .await;
        handle_test_frame(
            TunnelFrame::new(
                "srv-overflow",
                FRAME_STREAM_DATA,
                json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(b"x") }),
            ),
            &mut active_streams,
            &mut socket_pending_bytes,
            &mut next_response_id,
            &tx,
            state,
            pending_dispatch(),
        )
        .await;

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.frame_type, FRAME_STREAM_ERROR);
        assert_eq!(error_code(&frame), Some("backpressure_limit_exceeded"));
        assert!(!active_streams.contains_key("srv-overflow"));
        assert_eq!(socket_pending_bytes, SOCKET_PENDING_BYTES_LIMIT);
        close_test_streams(active_streams);
    }

    #[test]
    fn auth_close_codes_are_fatal() {
        let close = CloseFrame {
            code: CloseCode::Library(4001),
            reason: "device token expired".into(),
        };
        let error = close_frame_auth_error(Some(&close)).unwrap();
        assert!(error.to_string().contains("re-pair"));

        assert!(auth_close_code(401));
        assert!(auth_close_code(4401));
        assert!(!auth_close_code(1000));
    }

    #[test]
    fn websocket_handshake_401_is_fatal() {
        let response = ws_http::Response::builder()
            .status(ws_http::StatusCode::UNAUTHORIZED)
            .body(None)
            .unwrap();
        let error = map_ws_dial_error(WsError::Http(Box::new(response)));

        assert!(matches!(error, TunnelConnectionError::FatalAuth(_)));
    }

    #[tokio::test]
    async fn malformed_stream_frame_emits_error_without_closing_connection() {
        let (tx, mut rx) = mpsc::channel(4);
        let text = r#"{"stream_id":"srv-1","payload":{}}"#;
        let error = parse_frame(text).unwrap_err();

        handle_malformed_frame(text, error, &tx).await;

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.stream_id, "srv-1");
        assert_eq!(frame.frame_type, FRAME_STREAM_ERROR);
        assert_eq!(error_code(&frame), Some("malformed_frame"));
    }

    #[tokio::test]
    async fn malformed_json_without_stream_id_is_ignored_per_frame() {
        let (tx, mut rx) = mpsc::channel(4);
        let text = "{not-json";
        let error = parse_frame(text).unwrap_err();

        handle_malformed_frame(text, error, &tx).await;

        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn response_mapping_emits_open_data_close() {
        let (tx, mut rx) = mpsc::channel(8);
        let response = (
            StatusCode::CREATED,
            [(
                HeaderName::from_static("x-test"),
                HeaderValue::from_static("ok"),
            )],
            "body",
        )
            .into_response();

        send_http_response("srv-1".into(), response, &tx)
            .await
            .unwrap();
        drop(tx);

        let frames: Vec<TunnelFrame> = {
            let mut frames = Vec::new();
            while let Some(frame) = rx.recv().await {
                frames.push(frame);
            }
            frames
        };

        assert_eq!(frames[0].frame_type, FRAME_STREAM_OPEN);
        assert_eq!(frames[0].payload.as_ref().unwrap()["status"], 201);
        assert_eq!(frames[1].frame_type, FRAME_STREAM_DATA);
        assert_eq!(decode_stream_data(&frames[1]).unwrap(), b"body");
        assert_eq!(frames[2].frame_type, FRAME_STREAM_CLOSE);
    }
}
