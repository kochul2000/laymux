use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::android_pairing::{
    AndroidPairingAckError, AndroidPairingAckRequest, AndroidPairingAckResponse,
};

use super::json_error;

/// Confirms ownership of the QR seed. Transport authorization only gets the
/// request to this handler; the HMAC proof remains the pairing authority.
pub(super) async fn remote_android_pairing_ack(
    Json(request): Json<AndroidPairingAckRequest>,
) -> Response {
    match crate::android_pairing::confirm(request).await {
        Ok(response) => Json::<AndroidPairingAckResponse>(response).into_response(),
        Err(AndroidPairingAckError::Invalid) => json_error(
            StatusCode::UNAUTHORIZED,
            "android pairing confirmation is invalid",
        ),
        Err(AndroidPairingAckError::Expired) => {
            json_error(StatusCode::GONE, "android pairing invitation expired")
        }
        Err(AndroidPairingAckError::AlreadyConfirmed) => json_error(
            StatusCode::CONFLICT,
            "android pairing was confirmed by another client",
        ),
        Err(AndroidPairingAckError::Internal(error)) => {
            tracing::warn!(%error, "android pairing confirmation failed");
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "android pairing confirmation failed",
            )
        }
    }
}
