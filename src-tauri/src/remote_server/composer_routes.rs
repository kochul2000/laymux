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

const COMPOSER_STARRED_ENTRY_VALUE_REQUIRED_ERROR: &str =
    "Composer starred entry value is required";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ComposerStarredQuery {
    lease_id: Option<String>,
    revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ComposerStarredUpdate {
    lease_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    value: Option<String>,
    starred: bool,
    label: Option<String>,
    send: Option<bool>,
    previous_value: Option<String>,
}

impl ComposerStarredUpdate {
    fn resolve_value(&self) -> Result<String, &'static str> {
        match (&self.value, &self.text) {
            (Some(value), Some(text)) if value != text => {
                Err("Composer starred entry text and value must match")
            }
            (Some(value), _) => Ok(value.clone()),
            (None, Some(text)) => Ok(text.clone()),
            (None, None) => Err(COMPOSER_STARRED_ENTRY_VALUE_REQUIRED_ERROR),
        }
    }
}

#[derive(Debug, Serialize)]
struct ComposerStarredResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<crate::settings::ComposerStarredEntry>>,
    revision: u64,
}

pub(super) async fn remote_composer_starred(
    State(server): State<ServerState>,
    Query(query): Query<ComposerStarredQuery>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, query.lease_id.as_deref()) {
        return response;
    }
    match tokio::task::spawn_blocking(move || {
        crate::settings::composer_starred_snapshot(query.revision)
    })
    .await
    {
        Ok(Ok(snapshot)) => Json(ComposerStarredResponse {
            entries: snapshot.entries,
            revision: snapshot.revision,
        })
        .into_response(),
        Ok(Err(error)) => internal_error(error),
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
    let value = match body.resolve_value() {
        Ok(value) => value,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error),
    };
    if body.starred {
        if let Err(error) = crate::settings::validate_composer_starred_entry(&value) {
            return json_error(StatusCode::BAD_REQUEST, &error);
        }
    }
    if let Some(label) = body.label.as_deref() {
        if let Err(error) = crate::settings::validate_composer_starred_label(label) {
            return json_error(StatusCode::BAD_REQUEST, &error);
        }
    }

    let app_handle = server.app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::settings::update_composer_starred_entry_snapshot(
            &value,
            body.starred,
            body.label.as_deref(),
            body.send,
            body.previous_value.as_deref(),
            |entries| {
                if let Err(error) = app_handle.emit(EVENT_COMPOSER_STARRED_ENTRIES_CHANGED, entries)
                {
                    tracing::warn!(%error, "failed to emit composer starred entries change");
                }
            },
        )
    })
    .await;
    match result {
        Ok(Ok(snapshot)) => Json(ComposerStarredResponse {
            entries: snapshot.entries,
            revision: snapshot.revision,
        })
        .into_response(),
        Ok(Err(error))
            if error == crate::settings::COMPOSER_STARRED_ENTRIES_FULL_ERROR
                || error == crate::settings::COMPOSER_STARRED_ENTRY_DUPLICATE_ERROR
                || error == crate::settings::COMPOSER_STARRED_ENTRY_NOT_FOUND_ERROR =>
        {
            json_error(StatusCode::BAD_REQUEST, &error)
        }
        Ok(Err(error)) => internal_error(error),
        Err(error) => internal_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composer_starred_update_requires_text_or_value() {
        let update: ComposerStarredUpdate = serde_json::from_str(r#"{"starred":false}"#).unwrap();

        assert_eq!(
            update.resolve_value(),
            Err(COMPOSER_STARRED_ENTRY_VALUE_REQUIRED_ERROR)
        );
    }
}
