//! `POST /api/v1/dev/update-handoff`: the update handoff of ADR-0308 without
//! an installer, so dev can verify that the next GUI adopts the daemon
//! sessions. Debug builds only.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::helpers::err_json;
use super::ServerState;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateHandoffMode {
    /// Run actual checkpoint/cache preparation, then release the fence without
    /// installing or exiting. Distinct from the legacy post-install handoff.
    Prepare,
    /// The Windows path: the installer teardown, then the updater's
    /// `process::exit`.
    Installer,
    /// The Linux path: `app.restart()` after a successful install.
    Restart,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct UpdateHandoffRequest {
    pub mode: UpdateHandoffMode,
}

/// `prepare` exercises the real pre-install fence, checkpoint and output cache,
/// then restores the dev status. `installer`/`restart` exercise only the
/// post-install handoff and exit shortly after the reply.
pub async fn update_handoff(
    State(state): State<ServerState>,
    Json(request): Json<UpdateHandoffRequest>,
) -> impl IntoResponse {
    if !cfg!(debug_assertions) {
        return (
            StatusCode::FORBIDDEN,
            Json(err_json("dev-only update handoff")),
        );
    }
    if matches!(request.mode, UpdateHandoffMode::Prepare) {
        #[cfg(debug_assertions)]
        {
            // Keep preparation alive if the HTTP caller disconnects. Its guard
            // must release status/fence only after the frontend work settles.
            let result = tokio::spawn(crate::app_update::dev::prepare(
                state.app_handle.clone(),
                state.app_state.clone(),
            ))
            .await;
            return match result {
                Ok(Ok(result)) => (
                    StatusCode::OK,
                    Json(serde_json::json!({ "success": true, "result": result })),
                ),
                Ok(Err(error)) => (StatusCode::CONFLICT, Json(err_json(&error))),
                Err(error) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(err_json(&error.to_string())),
                ),
            };
        }
    }
    tokio::spawn(async move {
        // Let the reply leave first.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        match request.mode {
            UpdateHandoffMode::Prepare => {}
            UpdateHandoffMode::Installer => {
                crate::update_install_guard::release_installer_file_locks(&state.app_state);
                std::process::exit(0);
            }
            UpdateHandoffMode::Restart => {
                state.app_state.begin_update_handoff();
                crate::update_title_handoff::begin(&state.app_state).save(&state.app_state);
                state.app_handle.restart();
            }
        }
    });
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "success": true })),
    )
}
