use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::DefaultBodyLimit;
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
use crate::terminal_output::{TerminalOutputFrameHeaderV1, TerminalOutputSubscriptionEvent};

use super::access::{effective_remote_settings, with_effective_remote_control_state};
use super::android_e2e_output::{remote_android_e2e_output_ws, ANDROID_E2E_OUTPUT_PATH};
use super::android_e2e_routes::{
    remote_android_e2e_challenge, remote_android_e2e_establish, remote_android_e2e_rpc,
};
use super::android_pairing_routes::remote_android_pairing_ack;
use super::assets::{
    remote_addon_fit_js, remote_font, remote_unicode_provider_js, remote_web_links_addon_js,
    remote_xterm_css, remote_xterm_js,
};
use super::auth::remote_guard;
use super::display_settings::{remote_display_settings, update_remote_display_settings};
use super::font_assets::FONT_ROUTE_PATH;
use super::github_repo_routes::remote_terminal_github_repo;
use super::lease::{
    active_lease_matches_with_timeout, effective_heartbeat_timeout_seconds,
    emit_remote_control_status, get_remote_control_status, reclaim_lockout_active,
    require_active_lease, status_from_state, wait_for_remote_owner_transition_async,
    AndroidE2eClaimContext, ClaimReservationAttempt, HumanControlOrigin, RemoteControlLease,
    RemoteControlState, RemoteControlStatus, RemoteOwnerTransition,
};
use super::navigation_routes::{
    remote_layouts_list, remote_navigation, remote_notification_mark_read,
    remote_notifications_clear, remote_notifications_mark_all_read, remote_pane_visibility,
    remote_terminal_focus, remote_workspace_create, remote_workspace_switch_active,
    remote_workspace_visibility,
};
use super::navigation_step_routes::{
    remote_navigation_notification_step, remote_navigation_spatial_step,
};
use super::page::{remote_page, remote_page_redirect};
use super::page_assets::remote_hashed_asset;
use super::pwa::{remote_manifest, remote_pwa_icon, ICON_ROUTE_PATH, MANIFEST_ROUTE_PATH};
use super::terminal_info::remote_terminal_infos;
use super::update_routes::{remote_update_check, remote_update_install, remote_update_status};
use super::viewer_page::{remote_viewer_javascript, remote_viewer_page};
use super::viewer_routes::{
    remote_file_viewer_path_link, remote_file_viewer_render, remote_file_viewer_status,
};
use super::widget_routes::remote_widgets;
use super::{internal_error, json_error};

pub(super) const REMOTE_LEASE_HEADER: &str = "x-laymux-remote-lease";
const LEASE_CHECK_MS: u64 = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequest {
    client_name: Option<String>,
    claim_reservation_id: Option<String>,
    resume_token: Option<String>,
}

/// Successful claim payload: the shared status plus the secret, separately
/// scoped capabilities. The tokens appear only here — status and conflict
/// responses must never carry them.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResponse {
    #[serde(flatten)]
    status: RemoteControlStatus,
    resume_token: String,
    file_viewer_token: String,
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
    #[serde(default)]
    exact: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteQuery {
    lease_id: Option<String>,
}

pub fn build_router(state: ServerState) -> Router<ServerState> {
    let api_routes = Router::new()
        .route("/remote/v1/health", get(remote_health))
        .route(
            "/remote/v1/e2e/pair/ack",
            post(remote_android_pairing_ack).layer(DefaultBodyLimit::max(2 * 1024)),
        )
        .route(
            "/remote/v1/e2e/session/challenge",
            post(remote_android_e2e_challenge).layer(DefaultBodyLimit::max(2 * 1024)),
        )
        .route(
            "/remote/v1/e2e/session/establish",
            post(remote_android_e2e_establish).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/remote/v1/e2e/rpc",
            post(remote_android_e2e_rpc).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route(ANDROID_E2E_OUTPUT_PATH, get(remote_android_e2e_output_ws))
        .route("/remote/v1/session/status", get(remote_session_status))
        .route("/remote/v1/session/claim", post(remote_session_claim))
        .route(
            "/remote/v1/session/heartbeat",
            post(remote_session_heartbeat),
        )
        .route("/remote/v1/session/release", post(remote_session_release))
        .route(
            "/remote/v1/display-settings",
            get(remote_display_settings)
                .put(update_remote_display_settings)
                .layer(DefaultBodyLimit::max(2 * 1024)),
        )
        .route("/remote/v1/navigation", get(remote_navigation))
        .route("/remote/v1/layouts", get(remote_layouts_list))
        // Lease-free like `navigation`: the strip only reads (ADR-0124).
        .route("/remote/v1/widgets", get(remote_widgets))
        .route("/remote/v1/update", get(remote_update_status))
        .route("/remote/v1/update/check", post(remote_update_check))
        .route("/remote/v1/update/install", post(remote_update_install))
        .route(
            "/remote/v1/navigation/spatial",
            post(remote_navigation_spatial_step),
        )
        .route(
            "/remote/v1/navigation/notification",
            post(remote_navigation_notification_step),
        )
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
        .route("/remote/v1/workspaces", post(remote_workspace_create))
        .route(
            "/remote/v1/workspaces/{id}/visibility",
            post(remote_workspace_visibility),
        )
        .route(
            "/remote/v1/panes/{id}/visibility",
            post(remote_pane_visibility),
        )
        .route("/remote/v1/terminals", get(remote_terminals_list))
        .route(
            "/remote/v1/terminals/{id}/github-repo",
            get(remote_terminal_github_repo),
        )
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
        .route(
            "/remote/v1/file-viewer/status",
            get(remote_file_viewer_status),
        )
        .route(
            "/remote/v1/file-viewer/render",
            post(remote_file_viewer_render),
        )
        .route(
            "/remote/v1/file-viewer/path-link",
            post(remote_file_viewer_path_link),
        )
        // `route_layer`, not `layer`: `Router::layer` wraps the router's
        // fallback too, and `merge` donates that fallback to the combined
        // automation router — every unknown path of the whole server then
        // answered 401 "remote token is invalid" instead of 404 (issue #591).
        // The same applies to the cloud tunnel, which serves this router alone.
        // Authorization belongs to the routes it protects, so it must not
        // decide what happens to a path nobody registered.
        .route_layer(middleware::from_fn_with_state(state.clone(), remote_guard))
        // CORS stays on `layer` deliberately: it is a response decoration, not
        // a gate, and preflights must keep working. Whether it also covers the
        // fallback is harmless either way — the combined router replaces this
        // fallback with its own 404.
        .layer(CorsLayer::permissive());

    Router::new()
        .route("/remote", get(remote_page_redirect))
        .route("/remote/", get(remote_page))
        // Content-hashed immutable client assets (ADR-0169) — what the served
        // page actually references. The fixed vendor paths below stay for
        // compatibility with older clients and the E2E allowlist.
        .route("/remote/asset/{file_name}", get(remote_hashed_asset))
        .route("/remote/vendor/xterm.js", get(remote_xterm_js))
        .route("/remote/vendor/xterm.css", get(remote_xterm_css))
        .route(
            "/remote/vendor/unicode-provider.js",
            get(remote_unicode_provider_js),
        )
        .route("/remote/vendor/addon-fit.js", get(remote_addon_fit_js))
        .route(
            "/remote/vendor/addon-web-links.js",
            get(remote_web_links_addon_js),
        )
        // Desktop terminal font copy (ADR-0077). Gated inside the handler like
        // the other asset routes, not by `remote_guard`.
        .route(FONT_ROUTE_PATH, get(remote_font))
        // Home-screen install of the remote client (ADR-0091). Same gate as the
        // vendor assets.
        .route(MANIFEST_ROUTE_PATH, get(remote_manifest))
        .route(ICON_ROUTE_PATH, get(remote_pwa_icon))
        .route("/remote/viewer/", get(remote_viewer_page))
        .route("/remote/viewer/viewer.js", get(remote_viewer_javascript))
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

enum ClaimAttempt {
    Granted(Box<ClaimResponse>),
    AwaitHandoff(RemoteOwnerTransition),
    Rejected(Response),
}

fn conflict_status_response(current: &RemoteControlState, timeout_seconds: u64) -> Response {
    (
        StatusCode::CONFLICT,
        Json(status_from_state(current, timeout_seconds)),
    )
        .into_response()
}

/// One claim attempt under the owner lock. `allow_handoff_wait` is true only
/// on the first pass: a voluntary-release drain whose handoff capability
/// matches yields `AwaitHandoff`, and the caller retries once after the drain.
fn attempt_claim(
    settings: &crate::settings::models::RemoteSettings,
    current: &mut RemoteControlState,
    body: &ClaimRequest,
    remote_addr: &str,
    allow_handoff_wait: bool,
) -> ClaimAttempt {
    if !settings.enabled {
        return ClaimAttempt::Rejected(json_error(
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
        return ClaimAttempt::Rejected(json_error(
            StatusCode::CONFLICT,
            "remote control was reclaimed locally",
        ));
    }

    let resume_token = body.resume_token.as_deref();
    if current.transitioning {
        if allow_handoff_wait {
            if let Some(transition) = current.current_owner_transition() {
                if resume_token.is_some_and(|token| current.release_handoff_matches(token)) {
                    return ClaimAttempt::AwaitHandoff(transition);
                }
            }
        }
        return ClaimAttempt::Rejected(conflict_status_response(current, timeout_seconds));
    }

    if current.lease.is_some()
        && !resume_token.is_some_and(|token| current.remote_lease_takeover_allowed(token))
    {
        return ClaimAttempt::Rejected(conflict_status_response(current, timeout_seconds));
    }

    match current.resume_claim_reservation(
        body.claim_reservation_id.as_deref(),
        now,
        Duration::from_millis(REMOTE_CLAIM_RESERVATION_TTL_MS),
    ) {
        ClaimReservationAttempt::Busy { remaining } => {
            let Some(reservation_id) = body.claim_reservation_id.as_deref() else {
                return ClaimAttempt::Rejected(claim_reservation_rejected_response(Some(
                    remaining,
                )));
            };
            return ClaimAttempt::Rejected(claim_input_busy_response(reservation_id, remaining));
        }
        ClaimReservationAttempt::Rejected { remaining } => {
            return ClaimAttempt::Rejected(claim_reservation_rejected_response(remaining));
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
                return ClaimAttempt::Rejected(claim_input_busy_response(
                    &reservation_id,
                    Duration::from_millis(REMOTE_CLAIM_RESERVATION_TTL_MS),
                ));
            }
        }
        ClaimReservationAttempt::Consumed => {}
    }

    current.advance_owner_epoch();
    let lease_id = Uuid::new_v4().to_string();
    current.install_remote_lease(
        RemoteControlLease {
            lease_id: lease_id.clone(),
            remote_addr: remote_addr.to_owned(),
            client_name: body.client_name.clone(),
            last_heartbeat: now,
        },
        timeout,
    );
    let resume_token = current.issue_resume_capability(&lease_id);
    let file_viewer_token = current.issue_file_viewer_capability(&lease_id);
    ClaimAttempt::Granted(Box::new(ClaimResponse {
        status: status_from_state(current, timeout_seconds),
        resume_token,
        file_viewer_token,
    }))
}

fn complete_handoff_claim_attempt(
    settings: &crate::settings::models::RemoteSettings,
    current: &mut RemoteControlState,
    body: &ClaimRequest,
    remote_addr: &str,
    transition: RemoteOwnerTransition,
) -> ClaimAttempt {
    current.finalize_owner_transition_if_drained(transition);
    attempt_claim(settings, current, body, remote_addr, false)
}

async fn remote_session_claim(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    claim_context: Option<axum::Extension<AndroidE2eClaimContext>>,
    Json(body): Json<ClaimRequest>,
) -> Response {
    let remote_addr = addr.to_string();
    // A lease claimed through an E2E session must not outlive that session:
    // a reconnecting phone otherwise fights its own dead lease with 409s
    // until the heartbeat timeout (ADR-0170). The registry is consulted
    // outside the controller lock; the release re-validates under it.
    if let Some(response) = release_dead_android_e2e_lease(&server) {
        return response;
    }
    let attempt =
        match with_effective_remote_control_state(&server.app_state, |settings, current| {
            attempt_claim(settings, current, &body, &remote_addr, true)
        }) {
            Ok(attempt) => attempt,
            Err(err) => return internal_error(err),
        };

    let attempt = match attempt {
        ClaimAttempt::AwaitHandoff(transition) => {
            // A voluntary release is draining and the claimant proved the
            // handoff capability: follow the drain for its bounded budget,
            // then re-check the owner state under the lock. If the operation
            // is still draining, `attempt_claim` returns the structured status
            // conflict (`transitioning: true`) that keeps auto-reconnect armed.
            // A lock failure is observed again by the state access below and
            // remains an internal error rather than a retryable conflict.
            let _wait_result =
                wait_for_remote_owner_transition_async(&server.app_state, transition).await;
            match with_effective_remote_control_state(&server.app_state, |settings, current| {
                complete_handoff_claim_attempt(settings, current, &body, &remote_addr, transition)
            }) {
                Ok(attempt) => attempt,
                Err(err) => return internal_error(err),
            }
        }
        other => other,
    };

    match attempt {
        ClaimAttempt::Granted(response) => {
            if let (Some(axum::Extension(context)), Some(lease_id)) =
                (claim_context.as_ref(), response.status.lease_id.as_ref())
            {
                match server.app_state.remote_control.lock_or_err() {
                    Ok(mut control) => control.tag_android_e2e_lease(lease_id, context),
                    Err(err) => return internal_error(err),
                }
            }
            emit_remote_control_status(&server.app_handle, &response.status);
            Json(*response).into_response()
        }
        ClaimAttempt::Rejected(response) => response,
        ClaimAttempt::AwaitHandoff(_) => json_error(
            StatusCode::CONFLICT,
            "remote controller lease is not active",
        ),
    }
}

/// Releases a controller lease whose Android E2E session is gone (revoked by
/// a newer establish or expired). Returns an error response only on lock
/// failure; "nothing to release" is a normal claim precondition.
///
/// The registry is consulted between the two controller-lock sections, so the
/// world may move underneath: if another claim installs a fresh lease (and
/// possibly re-tags it for the successor session) in that window, the exact-tag
/// re-validation inside `release_android_e2e_lease_of_dead_session` turns this
/// call into a no-op — only the observed dead-session lease is ever released.
/// If operations are still draining, the release leaves `transitioning=true`
/// and the claim below answers the structured `transitioning` conflict the
/// page already retries; that drain is bounded by in-flight PTY writes, not by
/// the heartbeat timeout this path exists to avoid.
fn release_dead_android_e2e_lease(server: &ServerState) -> Option<Response> {
    let tag = match server.app_state.remote_control.lock_or_err() {
        Ok(control) => control.active_android_e2e_lease(),
        Err(err) => return Some(internal_error(err)),
    };
    let tag = tag?;
    // Session expiry is a protocol clock (unix epoch, ADR-0146); lease
    // transitions run on the monotonic clock like every other lease path.
    let now_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    if server
        .app_state
        .android_e2e
        .session_is_active(&tag.instance_id, &tag.session_id, now_epoch)
    {
        return None;
    }
    let released = match server.app_state.remote_control.lock_or_err() {
        Ok(mut control) => control.release_android_e2e_lease_of_dead_session(&tag, Instant::now()),
        Err(err) => return Some(internal_error(err)),
    };
    if released {
        if let Ok(status) = get_remote_control_status(&server.app_state) {
            emit_remote_control_status(&server.app_handle, &status);
        }
    }
    None
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
                // Voluntary release: the departing controller's resume
                // capability survives this drain (handoff window).
                let transition = current.begin_voluntary_release_transition(now);
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
    let result = match remote_terminal_infos(&server.app_state, &settings).await {
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
    if body.exact {
        return exact_resize_unavailable_response(&server.app_state, &lease_id);
    }

    terminal_control_response(resize_terminal_inner(
        &server.app_state,
        &id,
        body.cols,
        body.rows,
        HumanControlOrigin::Remote { lease_id },
    ))
}

fn exact_resize_unavailable_response(
    app_state: &crate::state::AppState,
    lease_id: &str,
) -> Response {
    if let Err(response) = require_active_lease(app_state, Some(lease_id)) {
        return response;
    }
    terminal_control_response(crate::pty_geometry::reject_unavailable_exact_geometry())
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
    let snapshot_max_bytes = super::effective_snapshot_max_bytes(&settings);

    ws.on_upgrade(move |socket| {
        stream_terminal_output(
            socket,
            server,
            id,
            lease_id,
            timeout_seconds,
            snapshot_max_bytes,
        )
    })
}

async fn stream_terminal_output(
    mut socket: WebSocket,
    server: ServerState,
    id: String,
    lease_id: String,
    timeout_seconds: u64,
    snapshot_max_bytes: usize,
) {
    let subscribed =
        match super::attach_and_subscribe_render_checkpoint(&server, &id, snapshot_max_bytes).await
        {
            Ok(subscribed) => subscribed,
            Err(err) => {
                tracing::warn!(terminal_id = %id, error = %err, "remote output attach failed");
                if err.kind() == super::RenderCheckpointAttachErrorKind::NotFound {
                    let _ = socket
                        .send(Message::Text("terminal session not found".into()))
                        .await;
                } else {
                    let _ = socket.send(Message::Close(None)).await;
                }
                return;
            }
        };

    // Checkpoint creation crosses the frontend bridge and may take several
    // seconds. Never disclose the newly reconstructed screen to a controller
    // whose lease was released, expired, or reclaimed during that wait.
    match active_lease_matches_with_timeout(
        &server.app_state,
        &lease_id,
        Duration::from_secs(timeout_seconds),
    ) {
        Ok(true) => {}
        Ok(false) => {
            tracing::warn!(terminal_id = %id, "remote output lease changed during attach");
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        Err(err) => {
            tracing::warn!(terminal_id = %id, error = %err, "remote output lease recheck failed");
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    }
    let attachment = subscribed.attachment;
    let generation = subscribed.generation;
    let wire_seq_offset = subscribed.wire_seq_offset;
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
                        let header = match TerminalOutputFrameHeaderV1::delta_with_offset(
                            &delta,
                            wire_seq_offset,
                        ) {
                            Ok(header) => header,
                            Err(err) => {
                                tracing::warn!(terminal_id = %id, error = %err, "remote output wire sequence failed");
                                break;
                            }
                        };
                        if send_output_pair(&mut socket, header, delta.data)
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
                    &server.app_state,
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
        Err(err) if err.contains("exact terminal geometry cutover is unavailable") => {
            json_error(StatusCode::NOT_IMPLEMENTED, &err)
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
        attempt_claim, claim_input_busy_response, complete_handoff_claim_attempt,
        exact_resize_unavailable_response, terminal_control_response, terminal_size_is_positive,
        ClaimAttempt, ClaimRequest, ClaimResponse, RemoteControlLease, RemoteControlState,
        TerminalResizeRequest,
    };
    use crate::lock_ext::MutexExt;
    use crate::settings::models::RemoteSettings;
    use crate::state::AppState;
    use axum::body::{to_bytes, Body};
    use axum::extract::Request;
    use axum::http::StatusCode;
    use axum::middleware::Next;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::{middleware, Router};
    use std::time::{Duration, Instant};
    use tower::ServiceExt;

    fn enabled_settings() -> RemoteSettings {
        RemoteSettings {
            enabled: true,
            ..RemoteSettings::default()
        }
    }

    fn claim_body(resume_token: Option<&str>) -> ClaimRequest {
        ClaimRequest {
            client_name: Some("phone".into()),
            claim_reservation_id: None,
            resume_token: resume_token.map(str::to_owned),
        }
    }

    fn expect_granted(attempt: ClaimAttempt) -> Box<ClaimResponse> {
        match attempt {
            ClaimAttempt::Granted(response) => response,
            ClaimAttempt::AwaitHandoff(_) => panic!("expected a granted claim, got AwaitHandoff"),
            ClaimAttempt::Rejected(response) => {
                panic!("expected a granted claim, got {}", response.status())
            }
        }
    }

    fn expect_rejected(attempt: ClaimAttempt) -> Response {
        match attempt {
            ClaimAttempt::Rejected(response) => response,
            ClaimAttempt::Granted(_) => panic!("expected a rejected claim, got Granted"),
            ClaimAttempt::AwaitHandoff(_) => {
                panic!("expected a rejected claim, got AwaitHandoff")
            }
        }
    }

    /// Pins the axum behaviour `build_router` relies on: a guard attached with
    /// `route_layer` runs for matched routes only, so an unregistered path is
    /// still a 404. `layer` would answer it with the guard's rejection, which
    /// is how issue #591 surfaced. `remote_guard` itself needs a Tauri
    /// `AppHandle`, so the guard is stood in for here.
    #[tokio::test]
    async fn route_layer_guards_matched_routes_without_owning_the_fallback() {
        async fn deny(_req: Request, _next: Next) -> Response {
            (StatusCode::UNAUTHORIZED, "remote token is invalid").into_response()
        }

        async fn status_of(router: Router, path: &str) -> StatusCode {
            let request = Request::builder().uri(path).body(Body::empty()).unwrap();
            router.oneshot(request).await.unwrap().status()
        }

        let guarded = || {
            Router::new()
                .route("/remote/v1/health", get(|| async { "health" }))
                .route_layer(middleware::from_fn(deny))
        };

        assert_eq!(
            status_of(guarded(), "/remote/v1/health").await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status_of(guarded(), "/remote/v1/nonexistent").await,
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn remote_resize_rejects_zero_dimensions() {
        assert!(!terminal_size_is_positive(0, 24));
        assert!(!terminal_size_is_positive(80, 0));
        assert!(!terminal_size_is_positive(0, 0));
        assert!(terminal_size_is_positive(80, 24));
    }

    #[test]
    fn remote_resize_schema_defaults_to_guarded_and_exact_is_fail_closed() {
        let guarded: TerminalResizeRequest = serde_json::from_value(serde_json::json!({
            "cols": 80,
            "rows": 24,
            "leaseId": "lease-1"
        }))
        .unwrap();
        assert!(!guarded.exact);

        let exact: TerminalResizeRequest = serde_json::from_value(serde_json::json!({
            "cols": 120,
            "rows": 40,
            "leaseId": "lease-1",
            "exact": true
        }))
        .unwrap();
        assert!(exact.exact);
        let response =
            terminal_control_response(crate::pty_geometry::reject_unavailable_exact_geometry());
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    }

    fn state_with_route_test_lease(lease_id: &str, last_heartbeat: Instant) -> AppState {
        let state = AppState::new();
        state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: lease_id.into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat,
        });
        state
    }

    #[test]
    fn exact_resize_validates_active_lease_before_reporting_unavailable() {
        let state = state_with_route_test_lease("lease-1", Instant::now());

        let bogus = exact_resize_unavailable_response(&state, "bogus");
        let valid = exact_resize_unavailable_response(&state, "lease-1");

        assert_eq!(bogus.status(), StatusCode::CONFLICT);
        assert_eq!(valid.status(), StatusCode::NOT_IMPLEMENTED);
        assert!(!state
            .remote_control
            .lock_or_err()
            .unwrap()
            .has_active_operations());
    }

    #[test]
    fn exact_resize_rejects_an_expired_lease_before_capability_rejection() {
        let state = state_with_route_test_lease(
            "stale",
            Instant::now() - Duration::from_secs(24 * 60 * 60),
        );

        let stale = exact_resize_unavailable_response(&state, "stale");

        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert!(!state
            .remote_control
            .lock_or_err()
            .unwrap()
            .has_active_operations());
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
        assert_eq!(request.resume_token, None);
    }

    #[test]
    fn claim_request_accepts_an_optional_resume_token() {
        let request: ClaimRequest = serde_json::from_value(serde_json::json!({
            "clientName": "phone",
            "resumeToken": "resume-1",
        }))
        .unwrap();
        assert_eq!(request.resume_token.as_deref(), Some("resume-1"));
    }

    #[test]
    fn claim_response_returns_both_secret_capabilities_next_to_the_flattened_status() {
        let settings = enabled_settings();
        let mut control = RemoteControlState::default();
        let granted = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:1",
            true,
        ));
        let body = serde_json::to_value(&*granted).unwrap();
        assert_eq!(body["active"], true);
        assert_eq!(body["leaseId"], granted.status.lease_id.clone().unwrap());
        assert_eq!(body["resumeToken"], granted.resume_token);
        assert_eq!(body["fileViewerToken"], granted.file_viewer_token);
        assert_ne!(granted.file_viewer_token, granted.resume_token);
    }

    #[test]
    fn takeover_needs_the_secret_capability_not_the_public_lease_id() {
        let settings = enabled_settings();
        let mut control = RemoteControlState::default();
        let first = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:1",
            true,
        ));
        let first_lease_id = first.status.lease_id.clone().unwrap();

        // The public lease id (status / conflict responses) proves nothing.
        let rejected = expect_rejected(attempt_claim(
            &settings,
            &mut control,
            &claim_body(Some(&first_lease_id)),
            "127.0.0.1:2",
            true,
        ));
        assert_eq!(rejected.status(), StatusCode::CONFLICT);

        let rejected = expect_rejected(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:2",
            true,
        ));
        assert_eq!(rejected.status(), StatusCode::CONFLICT);

        // The secret capability replaces the lease and rotates both secrets.
        let second = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(Some(&first.resume_token)),
            "127.0.0.1:1",
            true,
        ));
        assert_ne!(second.status.lease_id, first.status.lease_id);
        assert_ne!(second.resume_token, first.resume_token);
        assert_ne!(second.file_viewer_token, first.file_viewer_token);
        let second_lease_id = second.status.lease_id.as_deref().unwrap();
        assert!(control.file_viewer_capability_matches(second_lease_id, &second.file_viewer_token));
        assert!(!control.file_viewer_capability_matches(second_lease_id, &first.file_viewer_token));

        // The consumed capability is dead.
        let rejected = expect_rejected(attempt_claim(
            &settings,
            &mut control,
            &claim_body(Some(&first.resume_token)),
            "127.0.0.1:1",
            true,
        ));
        assert_eq!(rejected.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn claim_follows_a_voluntary_release_drain_only_with_the_handoff_capability() {
        let settings = enabled_settings();
        let mut control = RemoteControlState::default();
        let granted = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:1",
            true,
        ));
        let lease_id = granted.status.lease_id.clone().unwrap();

        // A PTY-enqueued Remote operation keeps the release drain pending, so
        // the reconnect races the transition exactly like a pagehide beacon
        // followed by an immediate reload claim.
        control.register_enqueued_remote_operation_for_test(&lease_id, "t1");
        let transition = control
            .begin_voluntary_release_transition(Instant::now())
            .expect("the active lease should begin the release transition");
        assert!(!control.finalize_owner_transition_if_drained(transition));

        // Without the handoff capability the drain stays a plain conflict.
        let rejected = expect_rejected(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:1",
            true,
        ));
        assert_eq!(rejected.status(), StatusCode::CONFLICT);

        // With it, the claim is told to await the drain instead of bouncing.
        let attempt = attempt_claim(
            &settings,
            &mut control,
            &claim_body(Some(&granted.resume_token)),
            "127.0.0.1:1",
            true,
        );
        assert!(matches!(attempt, ClaimAttempt::AwaitHandoff(_)));

        // Once the worker acknowledges the drained operation, the retry pass
        // (allow_handoff_wait = false) claims the freed lease.
        control.clear_active_operations_for_test();
        assert!(control.finalize_owner_transition_if_drained(transition));
        let second = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(Some(&granted.resume_token)),
            "127.0.0.1:1",
            false,
        ));
        assert_ne!(second.status.lease_id.as_deref(), Some(lease_id.as_str()));
        assert_ne!(second.resume_token, granted.resume_token);
    }

    #[tokio::test]
    async fn handoff_wait_timeout_returns_a_retryable_transition_conflict() {
        let settings = enabled_settings();
        let mut control = RemoteControlState::default();
        let granted = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:1",
            true,
        ));
        let lease_id = granted.status.lease_id.as_deref().unwrap();
        control.register_enqueued_remote_operation_for_test(lease_id, "t1");
        let transition = control
            .begin_voluntary_release_transition(Instant::now())
            .expect("the active lease should begin the release transition");

        let rejected = expect_rejected(complete_handoff_claim_attempt(
            &settings,
            &mut control,
            &claim_body(Some(&granted.resume_token)),
            "127.0.0.1:1",
            transition,
        ));
        assert_eq!(rejected.status(), StatusCode::CONFLICT);
        let body = to_bytes(rejected.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["active"], true);
        assert_eq!(body["transitioning"], true);
    }

    #[test]
    fn expiry_and_reclaim_drains_reject_the_old_capability() {
        let settings = enabled_settings();
        let mut control = RemoteControlState::default();
        let granted = expect_granted(attempt_claim(
            &settings,
            &mut control,
            &claim_body(None),
            "127.0.0.1:1",
            true,
        ));
        let lease_id = granted.status.lease_id.clone().unwrap();

        control.register_enqueued_remote_operation_for_test(&lease_id, "t1");
        control
            .begin_remote_owner_transition(Instant::now())
            .expect("the active lease should begin the transition");

        // The capability was revoked when the non-voluntary transition began:
        // no handoff wait, just the plain conflict (ADR-0027 confirmed loss).
        let rejected = expect_rejected(attempt_claim(
            &settings,
            &mut control,
            &claim_body(Some(&granted.resume_token)),
            "127.0.0.1:1",
            true,
        ));
        assert_eq!(rejected.status(), StatusCode::CONFLICT);
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
