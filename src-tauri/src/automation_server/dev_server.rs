use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use super::ServerState;

pub async fn fail_stop(State(state): State<ServerState>) -> Response {
    if !cfg!(debug_assertions) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let server = state.app_state.automation_server.clone();
    tokio::spawn(async move {
        // Let the initiating HTTP request finish before aborting its listener.
        tokio::time::sleep(crate::constants::AUTOMATION_FAILURE_INJECTION_DELAY).await;
        if let Err(error) = server.fail_stop().await {
            tracing::warn!(%error, "Server failure injection failed");
        }
    });
    Json(serde_json::json!({"scheduled": true})).into_response()
}
