use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::time;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::automation_server::ServerState;
use crate::lock_ext::MutexExt;

use super::auth::remote_guard;
use super::lease::{
    active_lease_matches, effective_heartbeat_timeout_seconds, emit_remote_control_status,
    get_remote_control_status, prune_expired_lease, require_active_lease, status_from_lease,
    RemoteControlLease,
};
use super::{internal_error, json_error};

const REMOTE_LEASE_HEADER: &str = "x-laymux-remote-lease";
const OUTPUT_INITIAL_BYTES: usize = 64 * 1024;
const OUTPUT_POLL_MS: u64 = 50;
const LEASE_CHECK_MS: u64 = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalInfo {
    id: String,
    title: String,
    profile: String,
    cwd: Option<String>,
    branch: Option<String>,
    cols: u16,
    rows: u16,
    sync_group: String,
    command_running: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequest {
    client_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRequest {
    lease_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteRequest {
    data: String,
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeRequest {
    cols: u16,
    rows: u16,
    lease_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteQuery {
    lease_id: Option<String>,
}

pub fn build_router() -> Router<ServerState> {
    Router::new()
        .route("/remote/v1/health", get(remote_health))
        .route("/remote/v1/session/status", get(remote_session_status))
        .route("/remote/v1/session/claim", post(remote_session_claim))
        .route(
            "/remote/v1/session/heartbeat",
            post(remote_session_heartbeat),
        )
        .route("/remote/v1/session/release", post(remote_session_release))
        .route("/remote/v1/terminals", get(remote_terminals_list))
        .route(
            "/remote/v1/terminals/{id}/write",
            post(remote_terminal_write),
        )
        .route(
            "/remote/v1/terminals/{id}/resize",
            post(remote_terminal_resize),
        )
        .route(
            "/remote/v1/terminals/{id}/output",
            get(remote_terminal_output_ws),
        )
        .layer(middleware::from_fn(remote_guard))
        .layer(CorsLayer::permissive())
}

async fn remote_health() -> Response {
    Json(serde_json::json!({
        "ok": true,
        "mode": "directRemote"
    }))
    .into_response()
}

async fn remote_session_status(State(server): State<ServerState>) -> Response {
    match get_remote_control_status(&server.app_state) {
        Ok(status) => Json(status).into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn remote_session_claim(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<ClaimRequest>,
) -> Response {
    let settings = crate::settings::load_settings().remote;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let status = {
        let mut current = match server.app_state.remote_control.lock_or_err() {
            Ok(current) => current,
            Err(err) => return internal_error(err),
        };
        prune_expired_lease(&mut current, Duration::from_secs(timeout_seconds));

        if current.is_some() {
            return (
                StatusCode::CONFLICT,
                Json(status_from_lease(&current, timeout_seconds)),
            )
                .into_response();
        }

        *current = Some(RemoteControlLease {
            lease_id: Uuid::new_v4().to_string(),
            remote_addr: addr.to_string(),
            client_name: body.client_name,
            last_heartbeat: Instant::now(),
        });
        status_from_lease(&current, timeout_seconds)
    };

    emit_remote_control_status(&server.app_handle, &status);
    Json(status).into_response()
}

async fn remote_session_heartbeat(
    State(server): State<ServerState>,
    Json(body): Json<LeaseRequest>,
) -> Response {
    let settings = crate::settings::load_settings().remote;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let status = {
        let mut current = match server.app_state.remote_control.lock_or_err() {
            Ok(current) => current,
            Err(err) => return internal_error(err),
        };
        prune_expired_lease(&mut current, Duration::from_secs(timeout_seconds));

        match current.as_mut() {
            Some(lease) if lease.lease_id == body.lease_id => {
                lease.last_heartbeat = Instant::now();
                status_from_lease(&current, timeout_seconds)
            }
            _ => {
                return json_error(
                    StatusCode::CONFLICT,
                    "remote controller lease is not active",
                );
            }
        }
    };

    Json(status).into_response()
}

async fn remote_session_release(
    State(server): State<ServerState>,
    Json(body): Json<LeaseRequest>,
) -> Response {
    let settings = crate::settings::load_settings().remote;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let status = {
        let mut current = match server.app_state.remote_control.lock_or_err() {
            Ok(current) => current,
            Err(err) => return internal_error(err),
        };
        prune_expired_lease(&mut current, Duration::from_secs(timeout_seconds));

        match current.as_ref() {
            Some(lease) if lease.lease_id == body.lease_id => {
                *current = None;
            }
            Some(_) => {
                return json_error(
                    StatusCode::CONFLICT,
                    "remote controller lease is not active",
                );
            }
            None => {}
        }
        status_from_lease(&current, timeout_seconds)
    };

    emit_remote_control_status(&server.app_handle, &status);
    Json(status).into_response()
}

async fn remote_terminals_list(State(server): State<ServerState>) -> Response {
    let terminals = match server.app_state.terminals.lock_or_err() {
        Ok(terminals) => terminals,
        Err(err) => return internal_error(err),
    };

    let result: Vec<RemoteTerminalInfo> = terminals
        .values()
        .map(|session| RemoteTerminalInfo {
            id: session.id.clone(),
            title: session.title.clone(),
            profile: session.config.profile.clone(),
            cwd: session.cwd.clone(),
            branch: session.branch.clone(),
            cols: session.config.cols,
            rows: session.config.rows,
            sync_group: session.config.sync_group.clone(),
            command_running: session.command_running,
        })
        .collect();

    Json(serde_json::json!({ "terminals": result })).into_response()
}

async fn remote_terminal_write(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalWriteRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    let ptys = match server.app_state.pty_handles.lock_or_err() {
        Ok(ptys) => ptys,
        Err(err) => return internal_error(err),
    };
    let Some(handle) = ptys.get(&id) else {
        return json_error(StatusCode::NOT_FOUND, "terminal session not found");
    };

    match handle.write(body.data.as_bytes()) {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

async fn remote_terminal_resize(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalResizeRequest>,
) -> Response {
    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers));
    if let Err(response) = require_active_lease(&server.app_state, lease_id) {
        return response;
    }

    {
        let mut terminals = match server.app_state.terminals.lock_or_err() {
            Ok(terminals) => terminals,
            Err(err) => return internal_error(err),
        };
        let Some(session) = terminals.get_mut(&id) else {
            return json_error(StatusCode::NOT_FOUND, "terminal session not found");
        };
        session.config.cols = body.cols;
        session.config.rows = body.rows;
    }

    let ptys = match server.app_state.pty_handles.lock_or_err() {
        Ok(ptys) => ptys,
        Err(err) => return internal_error(err),
    };
    if let Some(handle) = ptys.get(&id) {
        if let Err(err) = handle.resize(body.cols, body.rows) {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err);
        }
    }

    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn remote_terminal_output_ws(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RemoteQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(lease_id) = query.lease_id.filter(|value| !value.is_empty()) else {
        return json_error(StatusCode::CONFLICT, "remote controller lease is required");
    };
    if let Err(response) = require_active_lease(&server.app_state, Some(&lease_id)) {
        return response;
    }

    ws.on_upgrade(move |socket| stream_terminal_output(socket, server.app_state, id, lease_id))
}

async fn stream_terminal_output(
    mut socket: WebSocket,
    app_state: std::sync::Arc<crate::state::AppState>,
    id: String,
    lease_id: String,
) {
    let initial_snapshot = {
        let buffers = match app_state.output_buffers.lock_or_err() {
            Ok(buffers) => buffers,
            Err(err) => {
                tracing::warn!(terminal_id = %id, error = %err, "remote output stream failed to lock buffers");
                return;
            }
        };
        buffers.get(&id).map(|buffer| {
            (
                buffer.recent_bytes(OUTPUT_INITIAL_BYTES),
                buffer.write_seq(),
            )
        })
    };
    let Some((initial, mut seq)) = initial_snapshot else {
        let _ = socket
            .send(Message::Text("terminal session not found".into()))
            .await;
        return;
    };
    if !initial.is_empty() && socket.send(Message::Binary(initial.into())).await.is_err() {
        return;
    }

    let mut interval = time::interval(Duration::from_millis(OUTPUT_POLL_MS));
    let mut lease_check = time::interval(Duration::from_millis(LEASE_CHECK_MS));
    loop {
        tokio::select! {
            maybe_msg = socket.recv() => {
                match maybe_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        tracing::debug!(terminal_id = %id, error = %err, "remote output websocket closed");
                        break;
                    }
                }
            }
            _ = interval.tick() => {
                let bytes = {
                    let buffers = match app_state.output_buffers.lock_or_err() {
                        Ok(buffers) => buffers,
                        Err(err) => {
                            tracing::warn!(terminal_id = %id, error = %err, "remote output stream failed to lock buffers");
                            break;
                        }
                    };
                    let Some(buffer) = buffers.get(&id) else {
                        break;
                    };
                    let bytes = buffer.bytes_since(seq);
                    seq = buffer.write_seq();
                    bytes
                };

                if !bytes.is_empty() && socket.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            _ = lease_check.tick() => {
                match active_lease_matches(&app_state, &lease_id) {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Err(err) => {
                        tracing::warn!(terminal_id = %id, error = %err, "remote output stream failed to check lease");
                        break;
                    }
                }
            }
        }
    }
}

fn lease_id_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REMOTE_LEASE_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}
