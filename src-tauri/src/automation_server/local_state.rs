use axum::{http::StatusCode, Json};
use serde_json::{json, Value};

pub async fn export_configuration() -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let result = tokio::task::spawn_blocking(crate::commands::export_portable_settings)
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    result
        .map(|settings| Json(json!({"settings":settings})))
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":error})),
            )
        })
}
