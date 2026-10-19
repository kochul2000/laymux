//! Worktree operations use exactly the same guards as desktop Tauri commands.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use super::helpers::{bridge_request, err_json};
use super::ServerState;
use crate::commands;
use crate::error::AppError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRequest {
    working_dir: String,
    source_terminal_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectRequest {
    working_dir: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveRequest {
    working_dir: String,
    path: String,
    expected_head: String,
}

async fn respond<T: serde::Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> (StatusCode, Json<serde_json::Value>) {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => (
            StatusCode::OK,
            Json(serde_json::json!({"success": true, "data": value})),
        ),
        Ok(Err(error)) => (StatusCode::CONFLICT, Json(err_json(&error.to_string()))),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&error.to_string())),
        ),
    }
}

pub async fn list(
    State(state): State<ServerState>,
    Query(request): Query<ListRequest>,
) -> impl IntoResponse {
    respond(move || {
        commands::get_worktree_snapshot_inner(
            &state.app_state,
            &request.working_dir,
            request.source_terminal_id.as_deref(),
        )
    })
    .await
}

pub async fn inspect(
    State(state): State<ServerState>,
    Json(request): Json<InspectRequest>,
) -> impl IntoResponse {
    respond(move || {
        commands::inspect_worktree_inner(&state.app_state, &request.working_dir, &request.path)
    })
    .await
}

pub async fn remove(
    State(state): State<ServerState>,
    Json(request): Json<RemoveRequest>,
) -> impl IntoResponse {
    respond(move || {
        commands::remove_worktree_inner(
            &state.app_state,
            &request.working_dir,
            &request.path,
            &request.expected_head,
        )
    })
    .await
}

pub async fn control(
    State(state): State<ServerState>,
    Json(request): Json<serde_json::Value>,
) -> impl IntoResponse {
    match bridge_request(&state, "action", "worktrees", "control", request).await {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_requires_reviewed_head_and_has_no_force_escape_hatch() {
        let base = serde_json::json!({"workingDir":"D:/repo","path":"D:/tree"});
        assert!(serde_json::from_value::<RemoveRequest>(base.clone()).is_err());
        let mut request = base;
        request["expectedHead"] = "abc".into();
        assert!(serde_json::from_value::<RemoveRequest>(request.clone()).is_ok());
        request["force"] = true.into();
        assert!(serde_json::from_value::<RemoveRequest>(request).is_err());
    }
}
