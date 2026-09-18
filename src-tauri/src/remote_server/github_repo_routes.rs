use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::automation_server::ServerState;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

use super::lease::require_active_lease;
use super::{internal_error, json_error};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteGithubRepoResponse {
    cwd: Option<String>,
    repo_base: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RemoteGithubSnapshotQuery {
    force: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteGithubSnapshotResponse {
    cwd: Option<String>,
    #[serde(flatten)]
    snapshot: crate::commands::GithubRepoSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteGithubActionRequest {
    lease_id: String,
    action: String,
    number: u64,
}

pub(super) async fn remote_terminal_github_repo(
    State(server): State<ServerState>,
    Path(id): Path<String>,
) -> Response {
    let app_state = server.app_state.clone();
    let result =
        tokio::task::spawn_blocking(move || remote_terminal_github_repo_for_state(&app_state, &id))
            .await;

    match result {
        Ok(Ok(Some(info))) => no_store_json(info),
        Ok(Ok(None)) => json_error(StatusCode::NOT_FOUND, "terminal session not found"),
        Ok(Err(err)) => internal_error(err),
        Err(err) => internal_error(format!("GitHub repository lookup task failed: {err}")),
    }
}

pub(super) async fn remote_terminal_github_snapshot(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    Query(query): Query<RemoteGithubSnapshotQuery>,
) -> Response {
    let cwd = match remote_terminal_cwd(&server.app_state, &id) {
        Ok(Some(cwd)) => cwd,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "terminal session not found"),
        Err(err) => return internal_error(err),
    };
    let snapshot =
        crate::commands::get_github_repo_snapshot(cwd.clone().unwrap_or_default(), query.force)
            .await;
    no_store_snapshot(RemoteGithubSnapshotResponse { cwd, snapshot })
}

pub(super) async fn remote_terminal_github_action(
    State(server): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<RemoteGithubActionRequest>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, Some(&body.lease_id)) {
        return response;
    }
    let cwd = match remote_terminal_cwd(&server.app_state, &id) {
        Ok(Some(Some(cwd))) => cwd,
        Ok(Some(None)) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "terminal working directory is unavailable",
            )
        }
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "terminal session not found"),
        Err(err) => return internal_error(err),
    };
    match crate::commands::run_github_item_action(cwd, body.action, body.number).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(err) => json_error(StatusCode::BAD_GATEWAY, &err),
    }
}

fn remote_terminal_cwd(
    app_state: &AppState,
    terminal_id: &str,
) -> Result<Option<Option<String>>, String> {
    let terminals = app_state.terminals.lock_or_err()?;
    Ok(terminals
        .get(terminal_id)
        .map(|terminal| terminal.cwd.clone()))
}

fn remote_terminal_github_repo_for_state(
    app_state: &AppState,
    terminal_id: &str,
) -> Result<Option<RemoteGithubRepoResponse>, String> {
    let cwd = {
        let terminals = app_state.terminals.lock_or_err()?;
        let Some(terminal) = terminals.get(terminal_id) else {
            return Ok(None);
        };
        terminal.cwd.clone()
    };

    // The terminal lock is intentionally released before filesystem access;
    // network-backed repositories can make `.git/config` reads slow.
    let repo_base = cwd
        .as_deref()
        .and_then(crate::git_watcher::resolve_github_base_from_working_dir);

    Ok(Some(RemoteGithubRepoResponse { cwd, repo_base }))
}

fn no_store_json(info: RemoteGithubRepoResponse) -> Response {
    let mut response = Json(info).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn no_store_snapshot(info: RemoteGithubSnapshotResponse) -> Response {
    let mut response = Json(info).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use crate::terminal::{TerminalConfig, TerminalSession};

    use super::*;

    fn insert_terminal(state: &AppState, id: &str, cwd: Option<String>) {
        let mut terminal = TerminalSession::new(id.into(), TerminalConfig::default());
        terminal.cwd = cwd;
        state.terminals.lock().unwrap().insert(id.into(), terminal);
    }

    #[test]
    fn github_repo_lookup_uses_terminal_cwd_and_normalizes_origin() {
        let dir = TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        let nested = dir.path().join("nested");
        fs::create_dir(&git_dir).unwrap();
        fs::create_dir(&nested).unwrap();
        fs::write(
            git_dir.join("config"),
            "[remote \"origin\"]\n\turl = https://github.com/owner/repo.git\n",
        )
        .unwrap();

        let state = AppState::new();
        let cwd = nested.to_string_lossy().into_owned();
        insert_terminal(&state, "terminal-1", Some(cwd.clone()));

        let response = remote_terminal_github_repo_for_state(&state, "terminal-1")
            .unwrap()
            .unwrap();
        assert_eq!(response.cwd.as_deref(), Some(cwd.as_str()));
        assert_eq!(
            response.repo_base.as_deref(),
            Some("https://github.com/owner/repo")
        );
    }

    #[test]
    fn github_repo_lookup_returns_null_for_non_repo_cwd() {
        let dir = TempDir::new().unwrap();
        let state = AppState::new();
        let cwd = dir.path().to_string_lossy().into_owned();
        insert_terminal(&state, "terminal-1", Some(cwd.clone()));

        let response = remote_terminal_github_repo_for_state(&state, "terminal-1")
            .unwrap()
            .unwrap();
        assert_eq!(response.cwd.as_deref(), Some(cwd.as_str()));
        assert!(response.repo_base.is_none());
    }

    #[test]
    fn github_repo_lookup_distinguishes_missing_terminal_from_missing_cwd() {
        let state = AppState::new();
        assert!(remote_terminal_github_repo_for_state(&state, "missing")
            .unwrap()
            .is_none());

        insert_terminal(&state, "terminal-1", None);
        let response = remote_terminal_github_repo_for_state(&state, "terminal-1")
            .unwrap()
            .unwrap();
        assert!(response.cwd.is_none());
        assert!(response.repo_base.is_none());
    }

    #[test]
    fn github_repo_success_response_disables_http_caching() {
        let response = no_store_json(RemoteGithubRepoResponse {
            cwd: Some("/repo".into()),
            repo_base: Some("https://github.com/owner/repo".into()),
        });

        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );
    }

    #[test]
    fn github_snapshot_and_action_resolve_cwd_from_the_exact_terminal() {
        let state = AppState::new();
        insert_terminal(&state, "terminal-1", Some("/repo/one".into()));
        insert_terminal(&state, "terminal-2", Some("/repo/two".into()));

        assert_eq!(
            remote_terminal_cwd(&state, "terminal-2").unwrap(),
            Some(Some("/repo/two".into()))
        );
        assert_eq!(remote_terminal_cwd(&state, "missing").unwrap(), None);
    }

    #[test]
    fn github_snapshot_response_flattens_the_desktop_contract() {
        let value = serde_json::to_value(RemoteGithubSnapshotResponse {
            cwd: Some("/repo".into()),
            snapshot: crate::commands::GithubRepoSnapshot {
                status: crate::commands::GithubRepoStatus::Ready,
                repo: Some("owner/repo".into()),
                repo_url: Some("https://github.com/owner/repo".into()),
                issues: Vec::new(),
                pulls: Vec::new(),
                fetched_at_ms: Some(257),
            },
        })
        .unwrap();

        assert_eq!(value["cwd"], "/repo");
        assert_eq!(value["status"]["type"], "ready");
        assert_eq!(value["repoUrl"], "https://github.com/owner/repo");
        assert_eq!(value["fetchedAtMs"], 257);
    }
}
