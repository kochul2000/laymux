use super::{VoiceEvents, VoiceManager};
use crate::automation_server::ServerState;
use crate::remote_server::{
    begin_human_control_operation, require_active_lease, HumanControlOrigin,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Start {
    terminal_id: String,
    sdp: String,
    lease_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionQuery {
    session_id: String,
    lease_id: Option<String>,
    #[serde(default)]
    since: u64,
}

pub(crate) fn router(remote: bool) -> Router<ServerState> {
    if remote {
        Router::new()
            .route("/remote/v1/voice/start", post(remote_start))
            .route("/remote/v1/voice/events", post(remote_events))
            .route("/remote/v1/voice/stop", post(remote_stop))
    } else {
        Router::new()
            .route("/api/v1/voice/start", post(local_start))
            .route("/api/v1/voice/events", get(local_events))
            .route("/api/v1/voice/stop", post(local_stop))
    }
}
fn error(message: String) -> Response {
    (StatusCode::CONFLICT, Json(json!({"error":message}))).into_response()
}
async fn start(server: ServerState, body: Start, remote: bool) -> Response {
    let owner = if remote {
        if let Err(r) = require_active_lease(&server.app_state, body.lease_id.as_deref()) {
            return r;
        }
        body.lease_id
    } else {
        None
    };
    let origin = owner
        .as_ref()
        .map(|lease_id| HumanControlOrigin::Remote {
            lease_id: lease_id.clone(),
        })
        .unwrap_or(HumanControlOrigin::Local);
    if let Err(e) = begin_human_control_operation(&server.app_state, origin, &body.terminal_id) {
        return error(e);
    }
    match VoiceManager::start(server.app_state, body.terminal_id, body.sdp, owner).await {
        Ok(id) => Json(json!({"sessionId":id})).into_response(),
        Err(e) => error(e),
    }
}
fn events(server: ServerState, query: SessionQuery, remote: bool) -> Response {
    let owner = if remote {
        if let Err(r) = require_active_lease(&server.app_state, query.lease_id.as_deref()) {
            return r;
        }
        query.lease_id.as_deref()
    } else {
        None
    };
    match server
        .app_state
        .agent_voice
        .poll(&query.session_id, owner, query.since)
    {
        Ok(value) => Json(value).into_response(),
        Err(e) => error(e),
    }
}
fn stop(server: ServerState, query: SessionQuery, remote: bool) -> Response {
    let owner = if remote {
        query.lease_id.as_deref()
    } else {
        None
    };
    if remote && owner.is_none() {
        return error("Remote voice owner is required".into());
    }
    match server.app_state.agent_voice.stop(&query.session_id, owner) {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(e) => error(e),
    }
}
async fn local_start(State(s): State<ServerState>, Json(b): Json<Start>) -> Response {
    start(s, b, false).await
}
async fn remote_start(State(s): State<ServerState>, Json(b): Json<Start>) -> Response {
    start(s, b, true).await
}
async fn local_events(State(s): State<ServerState>, Query(q): Query<SessionQuery>) -> Response {
    events(s, q, false)
}
async fn remote_events(State(s): State<ServerState>, Json(q): Json<SessionQuery>) -> Response {
    events(s, q, true)
}
async fn local_stop(State(s): State<ServerState>, Json(q): Json<SessionQuery>) -> Response {
    stop(s, q, false)
}
async fn remote_stop(State(s): State<ServerState>, Json(q): Json<SessionQuery>) -> Response {
    stop(s, q, true)
}

#[tauri::command]
pub async fn voice_start(
    terminal_id: String,
    sdp: String,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<String, String> {
    {
        let _permit =
            begin_human_control_operation(&state, HumanControlOrigin::Local, &terminal_id)?;
    }
    VoiceManager::start(state.inner().clone(), terminal_id, sdp, None).await
}
#[tauri::command]
pub fn voice_events(
    session_id: String,
    since: u64,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<VoiceEvents, String> {
    state.agent_voice.poll(&session_id, None, since)
}
#[tauri::command]
pub fn voice_stop(
    session_id: String,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<(), String> {
    state.agent_voice.stop(&session_id, None)
}
