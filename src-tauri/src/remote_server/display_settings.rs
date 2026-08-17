use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::automation_server::settings_bridge::apply_settings_patch;
use crate::automation_server::ServerState;
use crate::constants::{REMOTE_FONT_SIZE_MAX, REMOTE_FONT_SIZE_MIN};

use super::access::effective_remote_settings;
use super::lease::require_active_lease;
use super::{internal_error, json_error};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteDisplaySettings {
    terminal_font_size: u16,
    composer_font_size: u16,
}

impl From<&crate::settings::models::RemoteSettings> for RemoteDisplaySettings {
    fn from(settings: &crate::settings::models::RemoteSettings) -> Self {
        Self {
            terminal_font_size: settings.terminal_font_size,
            composer_font_size: settings.composer_font_size,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteDisplaySettingsPatch {
    lease_id: Option<String>,
    terminal_font_size: Option<u16>,
    composer_font_size: Option<u16>,
}

pub(super) async fn remote_display_settings_get(State(server): State<ServerState>) -> Response {
    match effective_remote_settings(&server.app_state) {
        Ok(settings) => Json(RemoteDisplaySettings::from(&settings)).into_response(),
        Err(error) => internal_error(error),
    }
}

pub(super) async fn remote_display_settings_patch(
    State(server): State<ServerState>,
    Json(body): Json<RemoteDisplaySettingsPatch>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, body.lease_id.as_deref()) {
        return response;
    }
    if body.terminal_font_size.is_none() && body.composer_font_size.is_none() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "at least one display setting is required",
        );
    }
    if let Some(response) = invalid_font_size_response(&body) {
        return response;
    }

    let mut remote_patch = serde_json::Map::new();
    if let Some(value) = body.terminal_font_size {
        remote_patch.insert("terminalFontSize".into(), json!(value));
    }
    if let Some(value) = body.composer_font_size {
        remote_patch.insert("composerFontSize".into(), json!(value));
    }

    match apply_settings_patch(&server, &json!({ "remote": remote_patch }), None).await {
        Ok(prepared) => {
            let Some(candidate) = prepared.candidate.as_ref() else {
                return internal_error("validated settings candidate is missing");
            };
            Json(RemoteDisplaySettings::from(&candidate.remote)).into_response()
        }
        Err(error) => error.into_response(),
    }
}

fn invalid_font_size_response(body: &RemoteDisplaySettingsPatch) -> Option<Response> {
    for (name, value) in [
        ("terminalFontSize", body.terminal_font_size),
        ("composerFontSize", body.composer_font_size),
    ] {
        if value
            .is_some_and(|value| !(REMOTE_FONT_SIZE_MIN..=REMOTE_FONT_SIZE_MAX).contains(&value))
        {
            return Some(json_error(
                StatusCode::BAD_REQUEST,
                &format!(
                    "{name} must be between {REMOTE_FONT_SIZE_MIN} and {REMOTE_FONT_SIZE_MAX}"
                ),
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_exposes_only_remote_display_values() {
        let mut settings = crate::settings::models::RemoteSettings::default();
        settings.auth_token = "secret".into();
        settings.terminal_font_size = 18;
        settings.composer_font_size = 16;

        let value = serde_json::to_value(RemoteDisplaySettings::from(&settings)).unwrap();

        assert_eq!(
            value,
            json!({ "terminalFontSize": 18, "composerFontSize": 16 })
        );
        assert!(!value.to_string().contains("secret"));
    }

    #[test]
    fn patch_rejects_font_sizes_outside_the_contract() {
        let body = RemoteDisplaySettingsPatch {
            lease_id: Some("lease-1".into()),
            terminal_font_size: Some(REMOTE_FONT_SIZE_MIN - 1),
            composer_font_size: Some(REMOTE_FONT_SIZE_MAX + 1),
        };

        assert!(invalid_font_size_response(&body).is_some());
    }
}
