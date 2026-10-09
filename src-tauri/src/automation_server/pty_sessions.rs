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
    TerminatePtySessionRequest,
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

pub async fn terminate_detached(State(state): State<ServerState>) -> impl IntoResponse {
    respond(move || terminate_detached_pty_sessions_inner(&state.app_state)).await
}
