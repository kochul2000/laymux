use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

pub async fn metrics() -> Response {
    if !cfg!(debug_assertions) {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(crate::activity_reconcile::metrics::snapshot()).into_response()
}
