use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::app_update;
use crate::automation_server::ServerState;
use crate::state::AppState;

use super::lease::{begin_remote_lease_mutation, RemoteLeaseMutationPermit};
use super::routes::REMOTE_LEASE_HEADER;
use super::{internal_error, json_error};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteUpdateInstallRequest {
    lease_id: Option<String>,
}

pub(super) async fn remote_update_status(State(server): State<ServerState>) -> Response {
    update_response(server.app_state.app_update.snapshot())
}

pub(super) async fn remote_update_check(State(server): State<ServerState>) -> Response {
    update_response(app_update::check_now(&server.app_handle, &server.app_state.app_update).await)
}

pub(super) async fn remote_update_install(
    State(server): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<RemoteUpdateInstallRequest>,
) -> Response {
    // Authorization linearizes at acceptance. Once scheduled, the signed
    // download/installer survives lease expiry because cancelling a partially
    // applied process update would be less safe than completing it (ADR-0174).
    let _permit = match begin_update_install(&server.app_state, &headers, &body) {
        Ok(permit) => permit,
        Err(response) => return response,
    };
    update_response(app_update::schedule_install(
        server.app_handle.clone(),
        Arc::clone(&server.app_state.app_update),
    ))
}

fn update_response(result: Result<app_update::UpdateStatus, String>) -> Response {
    match result {
        Ok(status) => ([(header::CACHE_CONTROL, "no-store")], Json(status)).into_response(),
        Err(error)
            if error.contains("already running")
                || error.contains("pending update")
                // A channel switch between check and install is a client-state
                // conflict, not a server fault (ADR-0190).
                || error.contains(app_update::UPDATE_CHANNEL_CHANGED_ERROR) =>
        {
            json_error(StatusCode::CONFLICT, &error)
        }
        Err(error) if error.contains("disabled in development") => {
            json_error(StatusCode::NOT_IMPLEMENTED, &error)
        }
        Err(error) => internal_error(error),
    }
}

#[allow(clippy::result_large_err)]
fn begin_update_install<'a>(
    app_state: &'a AppState,
    headers: &HeaderMap,
    body: &RemoteUpdateInstallRequest,
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

    use super::*;
    use crate::lock_ext::MutexExt;
    use crate::remote_server::RemoteControlLease;

    #[test]
    fn install_requires_the_active_controller_lease() {
        let app_state = AppState::new();
        app_state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: "lease-active".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
        let headers = HeaderMap::new();

        let missing = RemoteUpdateInstallRequest { lease_id: None };
        let missing_error = match begin_update_install(&app_state, &headers, &missing) {
            Ok(_) => panic!("missing lease must be rejected"),
            Err(error) => error,
        };
        assert_eq!(missing_error.status(), StatusCode::CONFLICT);

        let stale = RemoteUpdateInstallRequest {
            lease_id: Some("lease-stale".into()),
        };
        let stale_error = match begin_update_install(&app_state, &headers, &stale) {
            Ok(_) => panic!("stale lease must be rejected"),
            Err(error) => error,
        };
        assert_eq!(stale_error.status(), StatusCode::CONFLICT);

        let active = RemoteUpdateInstallRequest {
            lease_id: Some("lease-active".into()),
        };
        assert!(begin_update_install(&app_state, &headers, &active).is_ok());
    }
}
