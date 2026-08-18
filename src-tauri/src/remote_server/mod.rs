mod access;
mod android_e2e_output;
mod android_e2e_routes;
mod android_pairing_routes;
mod appearance;
mod assets;
mod auth;
mod display_settings;
mod font_assets;
mod github_repo_routes;
mod lease;
mod navigation;
mod navigation_routes;
mod navigation_step_routes;
mod oauth_relay_routes;
mod page;
mod page_assets;
mod pwa;
mod render_checkpoint;
mod routes;
mod terminal_info;
mod update_routes;
mod viewer_page;
mod viewer_routes;
mod widget_routes;

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
pub(crate) use android_e2e_output::{
    parse_android_e2e_output_route, prepare_android_e2e_output, stream_android_e2e_output,
    unix_time_seconds, PreparedAndroidE2eOutput, ANDROID_E2E_OUTPUT_PATH,
    E2E_OUTPUT_MAX_ENCRYPTED_RECORD_BYTES, E2E_OUTPUT_OPEN_RECORD_LIMIT,
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
pub(crate) use render_checkpoint::{
    attach_and_subscribe_render_checkpoint, RenderCheckpointAttachError,
    RenderCheckpointAttachErrorKind,
};
pub use routes::build_router;

pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

pub(crate) fn internal_error(err: impl std::fmt::Display) -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string())
}
