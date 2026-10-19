//! Remote uses the desktop worktree service with terminal-bound authority.
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::automation_server::ServerState;
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

use super::lease::{begin_remote_lease_mutation, require_active_lease};
use super::{internal_error, json_error};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorktreeListRequest {
    lease_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorktreeInspectRequest {
    lease_id: String,
    cwd: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorktreeRemoveRequest {
    lease_id: String,
    cwd: String,
    path: String,
    expected_head: String,
}

pub(super) async fn remote_worktrees(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<WorktreeListRequest>,
) -> Response {
    blocking_response(
        tokio::task::spawn_blocking(move || snapshot_for_state(&server.app_state, &id, &body))
            .await,
    )
}

pub(super) async fn remote_worktree_inspect(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<WorktreeInspectRequest>,
) -> Response {
    blocking_response(
        tokio::task::spawn_blocking(move || inspect_for_state(&server.app_state, &id, &body)).await,
    )
}

pub(super) async fn remote_worktree_remove(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<WorktreeRemoveRequest>,
) -> Response {
    blocking_response(
        tokio::task::spawn_blocking(move || remove_for_state(&server.app_state, &id, &body)).await,
    )
}

fn blocking_response(result: Result<Result<Value, Response>, tokio::task::JoinError>) -> Response {
    match result {
        Ok(Ok(value)) => ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response(),
        Ok(Err(response)) => response,
        Err(error) => internal_error(error),
    }
}

#[allow(clippy::result_large_err)]
fn snapshot_for_state(
    state: &AppState,
    id: &str,
    body: &WorktreeListRequest,
) -> Result<Value, Response> {
    require_active_lease(state, Some(&body.lease_id))?;
    let cwd = terminal_cwd(state, id, None)?;
    let data = crate::commands::get_worktree_snapshot_inner(state, &cwd, Some(id))
        .map_err(worktree_error)?;
    Ok(json!({"success": true, "cwd": cwd, "data": data}))
}

#[allow(clippy::result_large_err)]
fn inspect_for_state(
    state: &AppState,
    id: &str,
    body: &WorktreeInspectRequest,
) -> Result<Value, Response> {
    require_active_lease(state, Some(&body.lease_id))?;
    let working_dir = qualified_cwd(state, id, &body.cwd)?;
    let data = crate::commands::inspect_worktree_inner(state, &working_dir, &body.path)
        .map_err(worktree_error)?;
    Ok(json!({"success": true, "data": data}))
}

#[allow(clippy::result_large_err)]
fn remove_for_state(
    state: &AppState,
    id: &str,
    body: &WorktreeRemoveRequest,
) -> Result<Value, Response> {
    with_removal_authority(state, id, body, |working_dir| {
        crate::commands::remove_worktree_inner(state, working_dir, &body.path, &body.expected_head)
    })?;
    Ok(json!({"success": true}))
}

#[allow(clippy::result_large_err)]
fn with_removal_authority<T>(
    state: &AppState,
    id: &str,
    body: &WorktreeRemoveRequest,
    remove: impl FnOnce(&str) -> Result<T, AppError>,
) -> Result<T, Response> {
    // Admission linearizes under the Remote owner gate. Once accepted, retain
    // this non-PTY barrier inside the blocking worker until Git has settled,
    // even if the HTTP caller disconnects or lease handoff begins meanwhile.
    let _permit = begin_remote_lease_mutation(state, Some(&body.lease_id))?;
    let working_dir = qualified_cwd(state, id, &body.cwd)?;
    // The raw source CWD is checked at admission. The shared command checks
    // fresh usage immediately before Git removal, including a source terminal
    // that moved into the target while Git inspection was running. No terminal
    // registry lock spans Git/filesystem I/O.
    remove(&working_dir).map_err(worktree_error)
}

#[allow(clippy::result_large_err)]
fn qualified_cwd(state: &AppState, id: &str, expected: &str) -> Result<String, Response> {
    let cwd = terminal_cwd(state, id, Some(expected))?;
    crate::worktree_context::resolve_working_dir(state, &cwd, Some(id)).map_err(worktree_error)
}

#[allow(clippy::result_large_err)]
fn terminal_cwd(state: &AppState, id: &str, expected: Option<&str>) -> Result<String, Response> {
    let cwd = {
        let terminals = state.terminals.lock_or_err().map_err(internal_error)?;
        let terminal = terminals
            .get(id)
            .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "terminal session not found"))?;
        terminal.cwd.clone()
    };
    let cwd = cwd.filter(|cwd| !cwd.trim().is_empty()).ok_or_else(|| {
        json_error(
            StatusCode::CONFLICT,
            "terminal working directory is unavailable",
        )
    })?;
    if expected.is_some_and(|expected| expected != cwd) {
        return Err(json_error(
            StatusCode::CONFLICT,
            "terminal working directory changed; refresh the Worktrees view",
        ));
    }
    Ok(cwd)
}

fn worktree_error(error: AppError) -> Response {
    match error {
        AppError::Lock(_) => internal_error(error),
        AppError::SessionNotFound(_) => json_error(StatusCode::NOT_FOUND, &error.to_string()),
        _ => json_error(StatusCode::CONFLICT, &error.to_string()),
    }
}

#[cfg(test)]
#[path = "worktree_routes_tests.rs"]
mod tests;
