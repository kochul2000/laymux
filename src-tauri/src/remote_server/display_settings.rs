use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::automation_server::settings_bridge::{apply_settings_patch, get_settings_snapshot};
use crate::automation_server::ServerState;
use crate::settings::contract::settings_revision;
use crate::settings::models::{Settings, REMOTE_FONT_SIZE_MAX, REMOTE_FONT_SIZE_MIN};
use crate::state::AppState;

use super::lease::{begin_remote_lease_mutation, RemoteLeaseMutationPermit};
use super::routes::REMOTE_LEASE_HEADER;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteDisplaySettingsResponse {
    terminal_font_size: u16,
    composer_font_size: u16,
    revision: String,
}

impl From<&Settings> for RemoteDisplaySettingsResponse {
    fn from(settings: &Settings) -> Self {
        let remote = &settings.remote;
        Self {
            terminal_font_size: remote
                .terminal_font_size
                .clamp(REMOTE_FONT_SIZE_MIN, REMOTE_FONT_SIZE_MAX),
            composer_font_size: remote
                .composer_font_size
                .clamp(REMOTE_FONT_SIZE_MIN, REMOTE_FONT_SIZE_MAX),
            revision: settings_revision(settings),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateRemoteDisplaySettingsRequest {
    terminal_font_size: u16,
    composer_font_size: u16,
    lease_id: Option<String>,
    expected_revision: String,
}

pub(super) async fn remote_display_settings(State(server): State<ServerState>) -> Response {
    match get_settings_snapshot(&server).await {
        Ok(settings) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(RemoteDisplaySettingsResponse::from(&settings)),
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn update_remote_display_settings(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<UpdateRemoteDisplaySettingsRequest>,
) -> Response {
    let _mutation_permit = match begin_display_settings_mutation(&server.app_state, &headers, &body)
    {
        Ok(permit) => permit,
        Err(response) => return response,
    };

    let patch = json!({
        "remote": {
            "terminalFontSize": body.terminal_font_size,
            "composerFontSize": body.composer_font_size,
        }
    });
    match apply_settings_patch(&server, &patch, Some(&body.expected_revision)).await {
        Ok(prepared) => {
            let Some(candidate) = prepared.candidate else {
                return super::internal_error("validated Remote display settings are missing");
            };
            Json(RemoteDisplaySettingsResponse::from(&candidate)).into_response()
        }
        Err(error) => error.into_response(),
    }
}

#[allow(clippy::result_large_err)]
fn begin_display_settings_mutation<'a>(
    app_state: &'a AppState,
    headers: &HeaderMap,
    body: &UpdateRemoteDisplaySettingsRequest,
) -> Result<RemoteLeaseMutationPermit<'a>, Response> {
    let lease_id = body.lease_id.as_deref().or_else(|| {
        headers
            .get(REMOTE_LEASE_HEADER)
            .and_then(|value| value.to_str().ok())
    });
    begin_remote_lease_mutation(app_state, lease_id)
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use axum::http::StatusCode;

    use super::*;
    use crate::lock_ext::MutexExt;
    use crate::remote_server::RemoteControlLease;
    use crate::state::AppState;

    #[test]
    fn response_projects_only_bounded_display_font_sizes() {
        let mut settings = Settings::default();
        settings.remote.terminal_font_size = 0;
        settings.remote.composer_font_size = u16::MAX;

        let response = RemoteDisplaySettingsResponse::from(&settings);

        assert_eq!(response.terminal_font_size, REMOTE_FONT_SIZE_MIN);
        assert_eq!(response.composer_font_size, REMOTE_FONT_SIZE_MAX);
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "terminalFontSize": 6,
                "composerFontSize": 72,
                "revision": settings_revision(&settings),
            })
        );
    }

    #[test]
    fn update_requires_the_existing_active_controller_lease() {
        let app_state = AppState::new();
        app_state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: "lease-active".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
        let headers = HeaderMap::new();

        let missing = UpdateRemoteDisplaySettingsRequest {
            terminal_font_size: 14,
            composer_font_size: 16,
            lease_id: None,
            expected_revision: "revision-1".into(),
        };
        let missing_error = match begin_display_settings_mutation(&app_state, &headers, &missing) {
            Ok(_) => panic!("missing lease must be rejected"),
            Err(error) => error,
        };
        assert_eq!(missing_error.status(), StatusCode::CONFLICT);

        let stale = UpdateRemoteDisplaySettingsRequest {
            lease_id: Some("lease-stale".into()),
            ..missing
        };
        let stale_error = match begin_display_settings_mutation(&app_state, &headers, &stale) {
            Ok(_) => panic!("stale lease must be rejected"),
            Err(error) => error,
        };
        assert_eq!(stale_error.status(), StatusCode::CONFLICT);

        let active = UpdateRemoteDisplaySettingsRequest {
            lease_id: Some("lease-active".into()),
            ..stale
        };
        assert!(begin_display_settings_mutation(&app_state, &headers, &active).is_ok());
    }
}
