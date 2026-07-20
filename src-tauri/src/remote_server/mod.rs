mod access;
mod appearance;
mod assets;
mod auth;
mod lease;
mod navigation;
mod navigation_routes;
mod navigation_step_routes;
mod page;
mod routes;
mod terminal_info;
mod viewer_page;
mod viewer_routes;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[cfg(test)]
pub(crate) use access::update_persistent_remote_settings_for_test;
pub(crate) use access::{
    effective_remote_settings, effective_snapshot_max_bytes,
    update_persistent_cloud_settings_snapshot, update_persistent_remote_settings,
};
pub use access::{
    get_remote_access_status, set_remote_runtime_access, RemoteAccessRuntimeState,
    RemoteAccessStatus,
};
pub(crate) use auth::TunnelAuthorized;
pub(crate) use lease::{
    active_lease_matches_with_timeout, begin_human_control_operation, HumanControlOrigin,
    HumanControlPermit,
};
pub use lease::{
    get_remote_control_status, reclaim_remote_control, RemoteControlLease, RemoteControlState,
    RemoteControlStatus,
};
pub use routes::build_router;

pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

pub(crate) fn internal_error(err: impl std::fmt::Display) -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string())
}
