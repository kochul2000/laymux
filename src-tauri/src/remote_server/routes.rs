use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::time;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::automation_server::ServerState;
use crate::commands::{resize_terminal_inner, write_terminal_input_inner, write_to_terminal_inner};
use crate::constants::{REMOTE_CLAIM_RESERVATION_TTL_MS, REMOTE_CLAIM_RETRY_AFTER_MS};
use crate::lock_ext::MutexExt;
use crate::terminal_output::{self, TerminalOutputFrameHeaderV1, TerminalOutputSubscriptionEvent};

use super::access::{effective_remote_settings, with_effective_remote_control_state};
use super::assets::{remote_addon_fit_js, remote_xterm_css, remote_xterm_js};
use super::auth::remote_guard;
use super::lease::{
    active_lease_matches_with_timeout, effective_heartbeat_timeout_seconds,
    emit_remote_control_status, get_remote_control_status, reclaim_lockout_active,
    require_active_lease, status_from_state, wait_for_remote_owner_transition_async,
    ClaimReservationAttempt, HumanControlOrigin, RemoteControlLease,
};
use super::navigation_routes::{
    remote_navigation, remote_notification_mark_read, remote_notifications_clear,
    remote_notifications_mark_all_read, remote_terminal_focus, remote_workspace_switch_active,
};
use super::page::{remote_page, remote_page_redirect};
use super::terminal_info::remote_terminal_infos;
use super::{internal_error, json_error};

pub(super) const REMOTE_LEASE_HEADER: &str = "x-laymux-remote-lease";
const OUTPUT_INITIAL_BYTES: usize = 64 * 1024;
const LEASE_CHECK_MS: u64 = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequest {
    client_name: Option<String>,
    claim_reservation_id: Option<String>,
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
struct TerminalInputRequest {
    text: String,
    submit: bool,
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

pub fn build_router(state: ServerState) -> Router<ServerState> {
    let api_routes = Router::new()
        .route("/remote/v1/health", get(remote_health))
        .route("/remote/v1/session/status", get(remote_session_status))
        .route("/remote/v1/session/claim", post(remote_session_claim))
        .route(
            "/remote/v1/session/heartbeat",
            post(remote_session_heartbeat),
        )
        .route("/remote/v1/session/release", post(remote_session_release))
        .route("/remote/v1/navigation", get(remote_navigation))
        .route(
            "/remote/v1/notifications/{id}/read",
            post(remote_notification_mark_read),
        )
        .route(
            "/remote/v1/notifications/mark-all-read",
            post(remote_notifications_mark_all_read),
        )
        .route(
            "/remote/v1/notifications",
            delete(remote_notifications_clear),
        )
        .route(
            "/remote/v1/workspaces/active",
            post(remote_workspace_switch_active),
        )
        .route("/remote/v1/terminals", get(remote_terminals_list))
        .route(
            "/remote/v1/terminals/{id}/focus",
            post(remote_terminal_focus),
        )
        .route(
            "/remote/v1/terminals/{id}/write",
            post(remote_terminal_write),
        )
        .route(
            "/remote/v1/terminals/{id}/input",
            post(remote_terminal_input),
        )
        .route(
            "/remote/v1/terminals/{id}/resize",
            post(remote_terminal_resize),
        )
        .route(
            "/remote/v1/terminals/{id}/output",
            get(remote_terminal_output_ws),
        )
        .layer(middleware::from_fn_with_state(state.clone(), remote_guard))
        .layer(CorsLayer::permissive());

    Router::new()
        .route("/remote", get(remote_page_redirect))
        .route("/remote/", get(remote_page))
        .route("/remote/vendor/xterm.js", get(remote_xterm_js))
        .route("/remote/vendor/xterm.css", get(remote_xterm_css))
        .route("/remote/vendor/addon-fit.js", get(remote_addon_fit_js))
        .merge(api_routes)
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
    let claim_result = with_effective_remote_control_state(
        &server.app_state,
        |settings, current| -> Result<_, Response> {
            if !settings.enabled {
                return Err(json_error(
                    StatusCode::FORBIDDEN,
                    "direct remote mode is disabled",
                ));
            }
            let timeout_seconds = effective_heartbeat_timeout_seconds(settings);
            let now = Instant::now();
            let timeout = Duration::from_secs(timeout_seconds);
            current.observe_lease_expiry(now, timeout);
            current.prune_expired_claim_reservation(now);

            if reclaim_lockout_active(current, now) {
                return Err(json_error(
                    StatusCode::CONFLICT,
                    "remote control was reclaimed locally",
                ));
            }

            if current.lease.is_some() {
                return Err((
                    StatusCode::CONFLICT,
                    Json(status_from_state(current, timeout_seconds)),
                )
                    .into_response());
            }

            match current.resume_claim_reservation(body.claim_reservation_id.as_deref(), now) {
                ClaimReservationAttempt::Busy { remaining } => {
                    let Some(reservation_id) = body.claim_reservation_id.as_deref() else {
                        return Err(claim_reservation_rejected_response(Some(remaining)));
                    };
                    return Err(claim_input_busy_response(reservation_id, remaining));
                }
                ClaimReservationAttempt::Rejected { remaining } => {
                    return Err(claim_reservation_rejected_response(remaining));
                }
                ClaimReservationAttempt::NoReservation => {
                    // Install the one-shot reservation while the Local permit is
                    // still registered. It remains after that permit finishes, so
                    // a fresh Local key job cannot overtake the token retry.
                    if current.has_active_operations() {
                        let reservation_id = current.create_claim_reservation(
                            now,
                            Duration::from_millis(REMOTE_CLAIM_RESERVATION_TTL_MS),
                        );
                        return Err(claim_input_busy_response(
                            &reservation_id,
                            Duration::from_millis(REMOTE_CLAIM_RESERVATION_TTL_MS),
                        ));
                    }
                }
                ClaimReservationAttempt::Consumed => {}
            }

            current.advance_owner_epoch();
            current.install_remote_lease(
                RemoteControlLease {
                    lease_id: Uuid::new_v4().to_string(),
                    remote_addr: addr.to_string(),
                    client_name: body.client_name,
                    last_heartbeat: now,
                },
                timeout,
            );
            Ok(status_from_state(current, timeout_seconds))
        },
    );
    let status = match claim_result {
        Ok(Ok(status)) => status,
        Ok(Err(response)) => return response,
        Err(err) => return internal_error(err),
    };

    emit_remote_control_status(&server.app_handle, &status);
    Json(status).into_response()
}

fn duration_millis_ceil(duration: Duration) -> u64 {
    let nanos = duration.as_nanos();
    let millis = nanos.saturating_add(999_999) / 1_000_000;
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn claim_input_busy_response(reservation_id: &str, remaining: Duration) -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "error": "terminal input is busy",
            "code": "input_busy",
            "claimReservationId": reservation_id,
            "retryAfterMs": REMOTE_CLAIM_RETRY_AFTER_MS,
            "reservationTtlMs": duration_millis_ceil(remaining),
        })),
    )
        .into_response()
}

fn claim_reservation_rejected_response(remaining: Option<Duration>) -> Response {
    let code = if remaining.is_some() {
        "claim_reserved"
    } else {
        "claim_reservation_invalid"
    };
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "error": "remote control claim reservation is not available to this request",
            "code": code,
            "retryAfterMs": REMOTE_CLAIM_RETRY_AFTER_MS,
            "reservationTtlMs": remaining.map(duration_millis_ceil).unwrap_or(0),
        })),
    )
        .into_response()
}

async fn remote_session_heartbeat(
    State(server): State<ServerState>,
    Json(body): Json<LeaseRequest>,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let (status, refreshed, expiry_started, expiry_finalized, transition) = {
        let mut current = match server.app_state.remote_control.lock_or_err() {
            Ok(current) => current,
            Err(err) => return internal_error(err),
        };
        let now = Instant::now();
        let timeout = Duration::from_secs(timeout_seconds);
        let was_transitioning = current.transitioning;
        let expiry_started = current.observe_lease_expiry(now, timeout);
        let expiry_finalized = was_transitioning && !current.transitioning;
        let refreshed = current.refresh_remote_lease(&body.lease_id, now, timeout);
        (
            status_from_state(&current, timeout_seconds),
            refreshed,
            expiry_started,
            expiry_finalized,
            current.current_owner_transition(),
        )
    };

    if !refreshed {
        if expiry_started || expiry_finalized || transition.is_some() {
            emit_remote_control_status(&server.app_handle, &status);
        }
        if let Some(transition) = transition {
            if wait_for_remote_owner_transition_async(&server.app_state, transition)
                .await
                .is_ok()
            {
                if let Ok(mut current) = server.app_state.remote_control.lock_or_err() {
                    let finalized = current.finalize_owner_transition_if_drained(transition);
                    let final_status = status_from_state(&current, timeout_seconds);
                    if finalized {
                        emit_remote_control_status(&server.app_handle, &final_status);
                    }
                }
            }
        }
        return json_error(
            StatusCode::CONFLICT,
            "remote controller lease is not active",
        );
    }
    Json(status).into_response()
}

async fn remote_session_release(
    State(server): State<ServerState>,
    Json(body): Json<LeaseRequest>,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let (transition, status) = {
        let mut current = match server.app_state.remote_control.lock_or_err() {
            Ok(current) => current,
            Err(err) => return internal_error(err),
        };
        let now = Instant::now();
        current.observe_lease_expiry(now, Duration::from_secs(timeout_seconds));
        current.prune_expired_claim_reservation(now);

        match current.lease.as_ref() {
            Some(lease) if lease.lease_id == body.lease_id => {
                let transition = current.begin_remote_owner_transition(now);
                let status = status_from_state(&current, timeout_seconds);
                (transition, status)
            }
            Some(_) => {
                return json_error(
                    StatusCode::CONFLICT,
                    "remote controller lease is not active",
                );
            }
            None => {
                current.cancel_claim_reservation();
                (None, status_from_state(&current, timeout_seconds))
            }
        }
    };

    if let Some(transition) = transition {
        emit_remote_control_status(&server.app_handle, &status);
        if let Err(err) =
            wait_for_remote_owner_transition_async(&server.app_state, transition).await
        {
            return json_error(StatusCode::CONFLICT, &err);
        }
        let mut current = match server.app_state.remote_control.lock_or_err() {
            Ok(current) => current,
            Err(err) => return internal_error(err),
        };
        let finalized = current.finalize_owner_transition_if_drained(transition);
        let status = status_from_state(&current, timeout_seconds);
        if finalized {
            emit_remote_control_status(&server.app_handle, &status);
        }
        return Json(status).into_response();
    }
    emit_remote_control_status(&server.app_handle, &status);
    Json(status).into_response()
}

async fn remote_terminals_list(State(server): State<ServerState>) -> Response {
    let settings = crate::settings::load_settings();
    let result = match remote_terminal_infos(&server.app_state, &settings) {
        Ok(terminals) => terminals,
        Err(err) => return internal_error(err),
    };

    Json(serde_json::json!({ "terminals": result })).into_response()
}

async fn remote_terminal_write(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalWriteRequest>,
) -> Response {
    let Some(lease_id) = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers))
        .map(str::to_owned)
    else {
        return json_error(StatusCode::CONFLICT, "remote controller lease is required");
    };

    terminal_control_response(write_to_terminal_inner(
        &server.app_state,
        &id,
        body.data.as_bytes(),
        HumanControlOrigin::Remote { lease_id },
    ))
}

async fn remote_terminal_input(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalInputRequest>,
) -> Response {
    let Some(lease_id) = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers))
        .map(str::to_owned)
    else {
        return json_error(StatusCode::CONFLICT, "remote controller lease is required");
    };

    terminal_control_response(write_terminal_input_inner(
        &server.app_state,
        &id,
        &body.text,
        body.submit,
        HumanControlOrigin::Remote { lease_id },
    ))
}

async fn remote_terminal_resize(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<TerminalResizeRequest>,
) -> Response {
    let Some(lease_id) = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&headers))
        .map(str::to_owned)
    else {
        return json_error(StatusCode::CONFLICT, "remote controller lease is required");
    };
    if !terminal_size_is_positive(body.cols, body.rows) {
        return json_error(StatusCode::BAD_REQUEST, "terminal size must be positive");
    }

    terminal_control_response(resize_terminal_inner(
        &server.app_state,
        &id,
        body.cols,
        body.rows,
        HumanControlOrigin::Remote { lease_id },
    ))
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
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);

    ws.on_upgrade(move |socket| {
        stream_terminal_output(socket, server.app_state, id, lease_id, timeout_seconds)
    })
}

async fn stream_terminal_output(
    mut socket: WebSocket,
    app_state: std::sync::Arc<crate::state::AppState>,
    id: String,
    lease_id: String,
    timeout_seconds: u64,
) {
    let subscribed = match terminal_output::attach_and_subscribe_terminal_output(
        &app_state.terminal_protocol_states,
        &id,
        OUTPUT_INITIAL_BYTES,
    ) {
        Ok(subscribed) => subscribed,
        Err(err) => {
            tracing::warn!(terminal_id = %id, error = %err, "remote output attach failed");
            let _ = socket
                .send(Message::Text("terminal session not found".into()))
                .await;
            return;
        }
    };
    let attachment = subscribed.attachment;
    let generation = subscribed.generation;
    let mut subscription = subscribed.subscription;
    if send_output_pair(
        &mut socket,
        TerminalOutputFrameHeaderV1::snapshot(&attachment),
        attachment.snapshot,
    )
    .await
    .is_err()
    {
        return;
    }

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
            event = subscription.recv() => {
                match event {
                    Some(TerminalOutputSubscriptionEvent::Delta(delta)) => {
                    if send_output_pair(
                        &mut socket,
                        TerminalOutputFrameHeaderV1::delta(&delta),
                        delta.data,
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                    }
                    Some(TerminalOutputSubscriptionEvent::Gap {
                        generation,
                        expected_seq,
                        retained_start_seq,
                        current_seq,
                    }) => {
                        tracing::warn!(
                            terminal_id = %id,
                            generation,
                            expected_seq,
                            retained_start_seq,
                            current_seq,
                            "remote output subscriber overflowed; closing for reattach"
                        );
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Some(TerminalOutputSubscriptionEvent::Retired { generation }) => {
                        tracing::debug!(terminal_id = %id, generation, "remote output generation retired");
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    None => {
                        tracing::debug!(terminal_id = %id, generation, "remote output subscription stopped");
                        break;
                    }
                }
            }
            _ = lease_check.tick() => {
                match active_lease_matches_with_timeout(
                    &app_state,
                    &lease_id,
                    Duration::from_secs(timeout_seconds),
                ) {
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

async fn send_output_pair(
    socket: &mut WebSocket,
    header: TerminalOutputFrameHeaderV1,
    data: Vec<u8>,
) -> Result<(), ()> {
    if header.byte_length != data.len()
        || header.seq_end.saturating_sub(header.seq_start) != data.len() as u64
    {
        tracing::error!(
            ?header,
            actual_length = data.len(),
            "terminal output frame length mismatch"
        );
        return Err(());
    }
    let header = serde_json::to_string(&header).map_err(|_| ())?;
    socket
        .send(Message::Text(header.into()))
        .await
        .map_err(|_| ())?;
    socket
        .send(Message::Binary(data.into()))
        .await
        .map_err(|_| ())
}

fn terminal_control_response(result: Result<(), String>) -> Response {
    match result {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) if err.contains("not found") => json_error(StatusCode::NOT_FOUND, &err),
        Err(err) if err.contains("size must be positive") => {
            json_error(StatusCode::BAD_REQUEST, &err)
        }
        Err(err) if err.contains("exceed") || err.contains("too large") => {
            json_error(StatusCode::PAYLOAD_TOO_LARGE, &err)
        }
        Err(err)
            if err.contains("controller")
                || err.contains("controlled")
                || err.contains("lease")
                || err.contains("ownership") =>
        {
            json_error(StatusCode::CONFLICT, &err)
        }
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    }
}

fn lease_id_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(REMOTE_LEASE_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn terminal_size_is_positive(cols: u16, rows: u16) -> bool {
    cols > 0 && rows > 0
}

#[cfg(test)]
mod tests {
    use super::{
        claim_input_busy_response, terminal_control_response, terminal_size_is_positive,
        ClaimRequest,
    };
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use std::time::Duration;

    #[test]
    fn remote_resize_rejects_zero_dimensions() {
        assert!(!terminal_size_is_positive(0, 24));
        assert!(!terminal_size_is_positive(80, 0));
        assert!(!terminal_size_is_positive(0, 0));
        assert!(terminal_size_is_positive(80, 24));
    }

    #[test]
    fn structured_input_limit_maps_to_payload_too_large() {
        let response = terminal_control_response(Err(
            "encoded terminal input is 1048577 bytes, exceeding the 1048576-byte limit".into(),
        ));
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn claim_request_accepts_an_optional_reservation_token() {
        let request: ClaimRequest = serde_json::from_value(serde_json::json!({
            "clientName": "phone",
            "claimReservationId": "reservation-1",
        }))
        .unwrap();
        assert_eq!(request.client_name.as_deref(), Some("phone"));
        assert_eq!(
            request.claim_reservation_id.as_deref(),
            Some("reservation-1")
        );
    }

    #[tokio::test]
    async fn input_busy_response_returns_the_one_shot_reservation_contract() {
        let response = claim_input_busy_response("reservation-1", Duration::from_millis(1_500));
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "input_busy");
        assert_eq!(body["claimReservationId"], "reservation-1");
        assert_eq!(body["retryAfterMs"], 25);
        assert_eq!(body["reservationTtlMs"], 1_500);
    }
}
