//! Dev-only controls for the same fail-stop and recovery used by desktop panes.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::helpers::{bridge_request, err_json};
use super::ServerState;

pub async fn fail_stop(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    if !cfg!(debug_assertions) {
        return (
            StatusCode::FORBIDDEN,
            Json(err_json("dev-only output fault injection")),
        )
            .into_response();
    }
    let result = (|| {
        let session = crate::terminal_output::terminal_output_session_for(
            &state.app_state.terminal_protocol_states,
            &id,
        )?
        .ok_or("Terminal not found")?;
        let diagnostics = session.desktop_output_diagnostics()?;
        let token = diagnostics
            .lease_token
            .ok_or("Terminal output is not attached")?;
        session.fail_stop_desktop_surface(session.generation(), &token, "surface_unavailable")
    })();
    match result {
        Ok(stopped) => Json(serde_json::json!({ "stopped": stopped })).into_response(),
        Err(error) => (StatusCode::CONFLICT, Json(err_json(&error))).into_response(),
    }
}

pub async fn reconnect(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    if !cfg!(debug_assertions) {
        return (
            StatusCode::FORBIDDEN,
            Json(err_json("dev-only output reconnect")),
        )
            .into_response();
    }
    match bridge_request(
        &state,
        "action",
        "terminals",
        "reconnectOutput",
        serde_json::json!({ "id": id }),
    )
    .await
    {
        Ok(data) => Json(data).into_response(),
        Err(error) => error.into_response(),
    }
}
