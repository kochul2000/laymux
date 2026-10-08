use super::ServerState;
use axum::extract::Path;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

/// Observe authoritative service identity without injecting terminal input.
pub(super) async fn status(State(server): State<ServerState>) -> impl IntoResponse {
    let Some(daemon) = server.app_state.daemon.get() else {
        return (StatusCode::OK, Json(serde_json::json!({"mode":"local"})));
    };
    match daemon
        .read(crate::daemon_requests::ReadCommand::Catalog)
        .await
    {
        Ok(catalog) => (
            StatusCode::OK,
            Json(
                serde_json::json!({"mode":"daemon","incarnation":daemon.incarnation().ok(),"catalog":catalog}),
            ),
        ),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"mode":"daemon","error":error})),
        ),
    }
}

pub(super) async fn checkpoint(
    State(server): State<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(daemon) = server.app_state.daemon.get() else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"detached terminal service is not active"})),
        );
    };
    match daemon.source_checkpoint(&id).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":error})),
        ),
    }
}
