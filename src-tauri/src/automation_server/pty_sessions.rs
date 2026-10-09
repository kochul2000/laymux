//! `/api/v1/pty-sessions`: the PTY daemon session inventory (ADR-0306), so the
//! settings panel's actions can be driven and verified without the UI.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::helpers::err_json;
use super::ServerState;
use crate::commands::{
    list_pty_sessions_inner, terminate_detached_pty_sessions_inner, terminate_pty_session_inner,
    TerminateDetachedPtySessionsRequest, TerminatePtySessionRequest,
};

async fn respond<T: serde::Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> (StatusCode, Json<serde_json::Value>) {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "data": value })),
        ),
        Ok(Err(error)) => (StatusCode::SERVICE_UNAVAILABLE, Json(err_json(&error))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&error.to_string())),
        ),
    }
}

pub async fn list(State(state): State<ServerState>) -> impl IntoResponse {
    respond(move || list_pty_sessions_inner(&state.app_state)).await
}

pub async fn terminate(
    State(state): State<ServerState>,
    Json(request): Json<TerminatePtySessionRequest>,
) -> impl IntoResponse {
    respond(move || terminate_pty_session_inner(&state.app_state, &request)).await
}

pub async fn terminate_detached(
    State(state): State<ServerState>,
    Json(request): Json<TerminateDetachedPtySessionsRequest>,
) -> impl IntoResponse {
    respond(move || terminate_detached_pty_sessions_inner(&state.app_state, &request)).await
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHandoffRequest {
    /// `installer`: the Windows path (installer teardown, then the updater's
    /// `process::exit`). `restart`: the Linux path (`app.restart()`).
    pub mode: String,
}

/// POST /api/v1/dev/update-handoff — run the update handoff of ADR-0308
/// without an installer, so dev can verify that the next GUI adopts the
/// daemon sessions. Debug builds only. The process exits right after the
/// reply.
pub async fn dev_update_handoff(
    State(state): State<ServerState>,
    Json(request): Json<UpdateHandoffRequest>,
) -> impl IntoResponse {
    if !cfg!(debug_assertions) {
        return (
            StatusCode::FORBIDDEN,
            Json(err_json("dev-only update handoff")),
        );
    }
    let installer = match request.mode.as_str() {
        "installer" => true,
        "restart" => false,
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(err_json(&format!("unknown mode '{other}'"))),
            )
        }
    };
    tokio::spawn(async move {
        // Let the reply leave first.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if installer {
            // What the updater's `on_before_exit` hook runs, then the exit
            // that follows it (no destructors run).
            crate::update_install_guard::release_installer_file_locks(&state.app_state);
            std::process::exit(0);
        }
        state.app_state.begin_update_handoff();
        state.app_handle.restart();
    });
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "success": true, "mode": request.mode })),
    )
}
