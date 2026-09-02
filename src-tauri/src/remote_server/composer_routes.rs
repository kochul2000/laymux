use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::automation_server::ServerState;
use crate::constants::EVENT_COMPOSER_STARRED_ENTRIES_CHANGED;

use super::lease::require_active_lease;
use super::{internal_error, json_error};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ComposerStarredQuery {
    lease_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ComposerStarredUpdate {
    lease_id: Option<String>,
    text: String,
    starred: bool,
}

#[derive(Debug, Serialize)]
struct ComposerStarredResponse {
    entries: Vec<String>,
}

pub(super) async fn remote_composer_starred(
    State(server): State<ServerState>,
    Query(query): Query<ComposerStarredQuery>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, query.lease_id.as_deref()) {
        return response;
    }
    match tokio::task::spawn_blocking(crate::settings::composer_starred_entries).await {
        Ok(entries) => Json(ComposerStarredResponse { entries }).into_response(),
        Err(error) => internal_error(error),
    }
}

pub(super) async fn remote_composer_starred_update(
    State(server): State<ServerState>,
    Json(body): Json<ComposerStarredUpdate>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, body.lease_id.as_deref()) {
        return response;
    }
    if let Err(error) = crate::settings::validate_composer_starred_entry(&body.text) {
        return json_error(StatusCode::BAD_REQUEST, &error);
    }

    let text = body.text;
    let app_handle = server.app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::settings::update_composer_starred_entry(&text, body.starred, |entries| {
            if let Err(error) = app_handle.emit(EVENT_COMPOSER_STARRED_ENTRIES_CHANGED, entries) {
                tracing::warn!(%error, "failed to emit composer starred entries change");
            }
        })
    })
    .await;
    match result {
        Ok(Ok(entries)) => Json(ComposerStarredResponse { entries }).into_response(),
        Ok(Err(error)) if error == crate::settings::COMPOSER_STARRED_ENTRIES_FULL_ERROR => {
            json_error(StatusCode::BAD_REQUEST, &error)
        }
        Ok(Err(error)) => internal_error(error),
        Err(error) => internal_error(error),
    }
}
