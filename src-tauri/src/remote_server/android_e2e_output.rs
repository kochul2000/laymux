use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, watch};
use tokio::time::{interval, timeout};

use crate::android_e2e::{
    AndroidE2eOutputCipher, AndroidE2eSession, E2eError, OUTPUT_RECORD_BINARY, OUTPUT_RECORD_OPEN,
    OUTPUT_RECORD_TEXT,
};
use crate::automation_server::ServerState;
use crate::constants::{
    DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS, MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS,
    REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES, TERMINAL_OUTPUT_RING_MAX_BYTES,
};
use crate::error::AppError;
use crate::state::AppState;
use crate::terminal_output::{
    TerminalOutputFrameHeaderV1, TerminalOutputSubscribedAttachment,
    TerminalOutputSubscriptionEvent,
};

use super::{
    active_lease_matches_with_timeout, attach_and_subscribe_render_checkpoint,
    effective_remote_settings, effective_snapshot_max_bytes, get_remote_control_status, json_error,
    RenderCheckpointAttachError,
};

pub(crate) const ANDROID_E2E_OUTPUT_PATH: &str = "/remote/v1/e2e/output";
pub(crate) const E2E_OUTPUT_OPEN_RECORD_LIMIT: usize = 4 * 1024;
pub(crate) const E2E_OUTPUT_RECORD_WIRE_OVERHEAD_BYTES: usize = 1 + 8 + 16;
pub(crate) const E2E_OUTPUT_MAX_PLAINTEXT_RECORD_BYTES: usize =
    1 + REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES + TERMINAL_OUTPUT_RING_MAX_BYTES;
pub(crate) const E2E_OUTPUT_MAX_ENCRYPTED_RECORD_BYTES: usize =
    E2E_OUTPUT_MAX_PLAINTEXT_RECORD_BYTES + E2E_OUTPUT_RECORD_WIRE_OVERHEAD_BYTES;

const E2E_OUTPUT_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const E2E_OUTPUT_INPUT_QUEUE_SIZE: usize = 2;
const E2E_OUTPUT_OUTPUT_QUEUE_SIZE: usize = 2;
const LEASE_CHECK_MS: u64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AndroidE2eOutputRoute {
    instance_id: String,
    session_id: String,
    stream_nonce: String,
}

pub(crate) struct PreparedAndroidE2eOutput {
    session: Arc<AndroidE2eSession>,
    cipher: AndroidE2eOutputCipher,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AndroidE2eOutputOpen {
    terminal_id: String,
    lease_id: String,
}

pub(crate) async fn remote_android_e2e_output_ws(
    State(server): State<ServerState>,
    RawQuery(raw_query): RawQuery,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(route) = parse_local_android_e2e_output_route(raw_query.as_deref()) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Android E2E output route is invalid",
        );
    };
    let now = match unix_time_seconds() {
        Ok(now) => now,
        Err(error) => return super::internal_error(error),
    };
    let prepared = match prepare_android_e2e_output(&server.app_state, route, now).await {
        Ok(prepared) => prepared,
        Err(_) => {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "Android E2E output session is unavailable",
            )
        }
    };

    ws.max_message_size(E2E_OUTPUT_OPEN_RECORD_LIMIT)
        .max_frame_size(E2E_OUTPUT_OPEN_RECORD_LIMIT)
        .on_upgrade(move |socket| stream_local_android_e2e_output(socket, server, prepared))
        .into_response()
}

async fn stream_local_android_e2e_output(
    socket: WebSocket,
    server: ServerState,
    prepared: PreparedAndroidE2eOutput,
) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (input_tx, input_rx) = mpsc::channel(E2E_OUTPUT_INPUT_QUEUE_SIZE);
    let reader = tokio::spawn(async move {
        let mut accepted_open = false;
        while let Some(message) = socket_rx.next().await {
            match message {
                Ok(Message::Binary(bytes))
                    if !accepted_open && bytes.len() <= E2E_OUTPUT_OPEN_RECORD_LIMIT =>
                {
                    accepted_open = true;
                    if input_tx.send(bytes.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                Ok(Message::Close(_)) | Ok(Message::Text(_)) | Ok(Message::Binary(_)) | Err(_) => {
                    break;
                }
            }
        }
    });

    let (output_tx, mut output_rx) = mpsc::channel(E2E_OUTPUT_OUTPUT_QUEUE_SIZE);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let core_state = Arc::clone(&server.app_state);
    let attach_server = server.clone();
    let core = tokio::spawn(stream_android_e2e_output(
        core_state,
        prepared,
        input_rx,
        shutdown_rx,
        move |terminal_id| async move {
            let settings = effective_remote_settings(&attach_server.app_state)
                .map_err(RenderCheckpointAttachError::fatal)?;
            let snapshot_max_bytes = effective_snapshot_max_bytes(&settings);
            attach_and_subscribe_render_checkpoint(&attach_server, &terminal_id, snapshot_max_bytes)
                .await
        },
        move |record| {
            let output_tx = output_tx.clone();
            async move {
                output_tx
                    .send(record)
                    .await
                    .map_err(|_| AppError::Other("Android E2E output socket closed".into()))
            }
        },
    ));

    while let Some(record) = output_rx.recv().await {
        if socket_tx
            .send(Message::Binary(record.into()))
            .await
            .is_err()
        {
            break;
        }
    }
    drop(output_rx);
    let _ = shutdown_tx.send(true);
    reader.abort();
    let _ = reader.await;
    let _ = core.await;
    let _ = socket_tx.send(Message::Close(None)).await;
}

pub(crate) fn parse_android_e2e_output_route(query: Option<&str>) -> Option<AndroidE2eOutputRoute> {
    parse_android_e2e_output_route_with_auth(query, false)
}

fn parse_local_android_e2e_output_route(query: Option<&str>) -> Option<AndroidE2eOutputRoute> {
    parse_android_e2e_output_route_with_auth(query, true)
}

fn parse_android_e2e_output_route_with_auth(
    query: Option<&str>,
    allow_auth_token: bool,
) -> Option<AndroidE2eOutputRoute> {
    let mut instance_id = None;
    let mut session_id = None;
    let mut stream_nonce = None;
    let mut auth_token_seen = false;
    let mut route_field_count = 0;
    for pair in query?.split('&') {
        let (name, value) = pair.split_once('=')?;
        if allow_auth_token && name == "token" {
            if auth_token_seen || value.is_empty() {
                return None;
            }
            auth_token_seen = true;
            continue;
        }
        if value.is_empty() || value.contains(['%', '+']) {
            return None;
        }
        route_field_count += 1;
        match name {
            "instanceId" if instance_id.is_none() => instance_id = Some(value.to_string()),
            "sessionId" if session_id.is_none() => session_id = Some(value.to_string()),
            "streamNonce" if stream_nonce.is_none() => stream_nonce = Some(value.to_string()),
            _ => return None,
        }
    }
    if route_field_count != 3 {
        return None;
    }
    let route = AndroidE2eOutputRoute {
        instance_id: instance_id?,
        session_id: session_id?,
        stream_nonce: stream_nonce?,
    };
    if !valid_remote_identifier(&route.instance_id)
        || !valid_canonical_base64url(&route.session_id, 16)
        || !valid_canonical_base64url(&route.stream_nonce, 32)
    {
        return None;
    }
    Some(route)
}

pub(crate) async fn prepare_android_e2e_output(
    app_state: &Arc<AppState>,
    route: AndroidE2eOutputRoute,
    now: u64,
) -> Result<PreparedAndroidE2eOutput, E2eError> {
    let session = app_state
        .android_e2e
        .session(&route.instance_id, &route.session_id, now)?;
    let cipher = session.open_output_cipher(&route.stream_nonce, now).await?;
    Ok(PreparedAndroidE2eOutput { session, cipher })
}

pub(crate) async fn stream_android_e2e_output<F, Fut, A, AttachFuture>(
    app_state: Arc<AppState>,
    prepared: PreparedAndroidE2eOutput,
    mut input: mpsc::Receiver<Vec<u8>>,
    mut shutdown: watch::Receiver<bool>,
    attach: A,
    mut send_record: F,
) where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
    A: FnOnce(String) -> AttachFuture,
    AttachFuture:
        Future<Output = Result<TerminalOutputSubscribedAttachment, RenderCheckpointAttachError>>,
{
    let PreparedAndroidE2eOutput {
        session,
        mut cipher,
    } = prepared;
    let encrypted_open = match timeout(E2E_OUTPUT_OPEN_TIMEOUT, input.recv()).await {
        Ok(Some(record)) => record,
        _ => return,
    };
    let plaintext = match cipher.decrypt_request(&encrypted_open) {
        Ok(plaintext) => plaintext,
        Err(_) => return,
    };
    let Some((&OUTPUT_RECORD_OPEN, open_json)) = plaintext.split_first() else {
        return;
    };
    let open: AndroidE2eOutputOpen = match serde_json::from_slice(open_json) {
        Ok(open) => open,
        Err(_) => return,
    };
    if !valid_remote_identifier(&open.terminal_id) || !valid_remote_identifier(&open.lease_id) {
        return;
    }

    let timeout_seconds = remote_output_timeout_seconds(&app_state);
    if !active_lease_matches_with_timeout(
        &app_state,
        &open.lease_id,
        Duration::from_secs(timeout_seconds),
    )
    .unwrap_or(false)
    {
        return;
    }
    let subscribed = match attach(open.terminal_id.clone()).await {
        Ok(subscribed) => subscribed,
        Err(_) => return,
    };
    if !active_lease_matches_with_timeout(
        &app_state,
        &open.lease_id,
        Duration::from_secs(timeout_seconds),
    )
    .unwrap_or(false)
    {
        return;
    }
    if unix_time_seconds()
        .ok()
        .and_then(|now| session.ensure_active(now).ok())
        .is_none()
    {
        return;
    }

    let attachment = subscribed.attachment;
    let generation = subscribed.generation;
    let wire_seq_offset = subscribed.wire_seq_offset;
    let mut subscription = subscribed.subscription;
    if send_android_e2e_output_pair(
        &mut cipher,
        TerminalOutputFrameHeaderV1::snapshot(&attachment),
        &attachment.snapshot,
        &mut send_record,
    )
    .await
    .is_err()
    {
        return;
    }

    let mut lease_check = interval(Duration::from_millis(LEASE_CHECK_MS));
    loop {
        tokio::select! {
            event = subscription.recv() => {
                let delta = match event {
                    Some(TerminalOutputSubscriptionEvent::Delta(delta)) => delta,
                    Some(TerminalOutputSubscriptionEvent::Gap { .. })
                    | Some(TerminalOutputSubscriptionEvent::Retired { .. })
                    | None => break,
                };
                let header = match TerminalOutputFrameHeaderV1::delta_with_offset(
                    &delta,
                    wire_seq_offset,
                ) {
                    Ok(header) => header,
                    Err(_) => break,
                };
                if send_android_e2e_output_pair(
                    &mut cipher,
                    header,
                    &delta.data,
                    &mut send_record,
                ).await.is_err() {
                    break;
                }
            }
            _ = lease_check.tick() => {
                let lease_active = active_lease_matches_with_timeout(
                    &app_state,
                    &open.lease_id,
                    Duration::from_secs(timeout_seconds),
                ).unwrap_or(false);
                let session_active = unix_time_seconds()
                    .ok()
                    .is_some_and(|now| session.ensure_active(now).is_ok());
                if !lease_active || !session_active {
                    break;
                }
            }
            client_record = input.recv() => {
                if client_record.is_none() {
                    break;
                }
                // The v1 output socket is server-to-client after its encrypted OPEN.
                break;
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
        }
    }
    tracing::debug!(
        terminal_id = %open.terminal_id,
        generation,
        "Android E2E terminal output stream closed"
    );
}

async fn send_android_e2e_output_pair<F, Fut>(
    cipher: &mut AndroidE2eOutputCipher,
    header: TerminalOutputFrameHeaderV1,
    data: &[u8],
    send_record: &mut F,
) -> Result<(), AppError>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    if header.byte_length != data.len()
        || header.seq_end.saturating_sub(header.seq_start) != data.len() as u64
    {
        return Err(AppError::Other(
            "Android E2E terminal output frame length mismatch".into(),
        ));
    }
    let header_json = serde_json::to_vec(&header)?;
    let mut text_plaintext = Vec::with_capacity(1 + header_json.len());
    text_plaintext.push(OUTPUT_RECORD_TEXT);
    text_plaintext.extend_from_slice(&header_json);
    let encrypted_header = cipher
        .encrypt_response(&text_plaintext)
        .map_err(android_e2e_error)?;
    send_record(encrypted_header).await?;

    let mut binary_plaintext = Vec::with_capacity(1 + data.len());
    binary_plaintext.push(OUTPUT_RECORD_BINARY);
    binary_plaintext.extend_from_slice(data);
    let encrypted_data = cipher
        .encrypt_response(&binary_plaintext)
        .map_err(android_e2e_error)?;
    if encrypted_data.len() > E2E_OUTPUT_MAX_ENCRYPTED_RECORD_BYTES {
        return Err(AppError::Other(
            "Android E2E output record exceeded protocol limit".into(),
        ));
    }
    send_record(encrypted_data).await
}

fn android_e2e_error(error: E2eError) -> AppError {
    match error {
        E2eError::Internal(error) => error,
        _ => AppError::Other("Android E2E output record failed".into()),
    }
}

fn valid_canonical_base64url(value: &str, expected_bytes: usize) -> bool {
    URL_SAFE_NO_PAD.decode(value).ok().is_some_and(|decoded| {
        decoded.len() == expected_bytes && URL_SAFE_NO_PAD.encode(decoded) == value
    })
}

fn valid_remote_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn unix_time_seconds() -> Result<u64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| AppError::Other(format!("System clock is before Unix epoch: {error}")))
}

fn remote_output_timeout_seconds(app_state: &AppState) -> u64 {
    get_remote_control_status(app_state)
        .ok()
        .map(|status| status.heartbeat_timeout_seconds)
        .unwrap_or(DEFAULT_REMOTE_HEARTBEAT_TIMEOUT_SECONDS)
        .max(MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock_ext::MutexExt;
    use std::time::Instant;

    const QUERY: &str = "instanceId=desktop-7&sessionId=UFFSU1RVVldYWVpbXF1eXw&streamNonce=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    #[test]
    fn connector_local_route_accepts_only_the_remote_auth_query_extension() {
        assert!(parse_android_e2e_output_route(Some(QUERY)).is_some());
        assert!(parse_local_android_e2e_output_route(Some(&format!(
            "{QUERY}&token=local%2Ftoken"
        )))
        .is_some());
        assert!(parse_local_android_e2e_output_route(Some(&format!("{QUERY}&debug=1"))).is_none());
    }

    #[test]
    fn connector_local_route_keeps_routing_fields_canonical() {
        assert!(parse_local_android_e2e_output_route(Some(
            "instanceId=desktop%2D7&sessionId=UFFSU1RVVldYWVpbXF1eXw&streamNonce=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&token=local"
        ))
        .is_none());
    }

    #[tokio::test]
    async fn shared_core_decrypts_open_and_emits_remote_v1_header_binary_pair() {
        let now = unix_time_seconds().unwrap();
        let (session, cipher, mut peer) =
            crate::android_e2e::test_output_cipher_pair(now, now + 60).await;
        let prepared = PreparedAndroidE2eOutput { session, cipher };
        let app_state = Arc::new(AppState::new());
        {
            let mut control = app_state.remote_control.lock_or_err().unwrap();
            control.lease = Some(crate::remote_server::RemoteControlLease {
                lease_id: "lease-1".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: Some("android-test".into()),
                last_heartbeat: Instant::now(),
            });
        }
        let registration = crate::terminal_output::register_terminal_output_session(
            &app_state.terminal_protocol_states,
            &app_state.output_buffers,
            "terminal-1",
        )
        .unwrap();
        let terminal_session = registration.commit().unwrap();
        terminal_session.record_output(b"snapshot-bytes").unwrap();

        let mut open = vec![OUTPUT_RECORD_OPEN];
        open.extend_from_slice(br#"{"terminalId":"terminal-1","leaseId":"lease-1"}"#);
        let encrypted_open = peer.encrypt_request(&open).unwrap();
        let (input_tx, input_rx) = mpsc::channel(E2E_OUTPUT_INPUT_QUEUE_SIZE);
        input_tx.send(encrypted_open).await.unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (record_tx, mut record_rx) = mpsc::channel(2);
        let attach_state = Arc::clone(&app_state);
        let core = tokio::spawn(stream_android_e2e_output(
            Arc::clone(&app_state),
            prepared,
            input_rx,
            shutdown_rx,
            move |terminal_id| async move {
                crate::terminal_output::attach_and_subscribe_terminal_output(
                    &attach_state.terminal_protocol_states,
                    &terminal_id,
                    E2E_OUTPUT_MAX_PLAINTEXT_RECORD_BYTES,
                )
                .map_err(RenderCheckpointAttachError::fatal)
            },
            move |record| {
                let record_tx = record_tx.clone();
                async move {
                    record_tx
                        .send(record)
                        .await
                        .map_err(|_| AppError::Other("test output receiver closed".into()))
                }
            },
        ));

        let encrypted_header = timeout(Duration::from_secs(1), record_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let encrypted_binary = timeout(Duration::from_secs(1), record_rx.recv())
            .await
            .unwrap()
            .unwrap();
        shutdown_tx.send(true).unwrap();
        core.await.unwrap();

        let header_plaintext = peer.decrypt_response(&encrypted_header).unwrap();
        assert_eq!(header_plaintext[0], OUTPUT_RECORD_TEXT);
        let header: TerminalOutputFrameHeaderV1 =
            serde_json::from_slice(&header_plaintext[1..]).unwrap();
        assert_eq!(
            header.phase,
            crate::terminal_output::TerminalOutputPhase::Snapshot
        );
        assert_eq!(header.byte_length, b"snapshot-bytes".len());

        let binary_plaintext = peer.decrypt_response(&encrypted_binary).unwrap();
        assert_eq!(binary_plaintext[0], OUTPUT_RECORD_BINARY);
        assert_eq!(&binary_plaintext[1..], b"snapshot-bytes");
    }
}
