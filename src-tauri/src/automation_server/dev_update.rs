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

/// Runs what the GUI does after an update is installed, not the update
/// checkpoint and input freeze before it (`app_update_install::prepare`):
/// it verifies that the daemon sessions outlive the GUI, not the agent
/// resume decisions of a checkpoint. The process exits right after the
/// reply.
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
    tokio::spawn(async move {
        // Let the reply leave first.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        match request.mode {
            UpdateHandoffMode::Installer => {
                crate::update_install_guard::release_installer_file_locks(&state.app_state);
                std::process::exit(0);
            }
            UpdateHandoffMode::Restart => {
                state.app_state.begin_update_handoff();
                state.app_handle.restart();
            }
        }
    });
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "success": true })),
    )
}
