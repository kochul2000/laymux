mod auth;
mod lease;
mod routes;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

pub use lease::{
    get_remote_control_status, reclaim_remote_control, RemoteControlLease, RemoteControlStatus,
};
pub use routes::build_router;

pub(crate) fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

pub(crate) fn internal_error(err: impl std::fmt::Display) -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string())
}
