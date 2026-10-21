//! Pre-authentication bounds of the binary Android E2E RPC request body
//! (ADR-0351), shared by the Tailscale Direct route and the Cloud tunnel.
//!
//! Before AEAD the desktop holds at most the host-derived body limit per
//! request, and rejects the request as soon as its 31-byte prefix names no
//! live session or an unusable sequence. Neither check is authentication.

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use futures_util::StreamExt;

use crate::android_e2e::{EnvelopeRejection, RpcRequestEnvelope};
use crate::constants::android_e2e_rpc_body_limit;
use crate::state::AppState;

use super::access::effective_remote_settings;
use super::android_e2e_output::unix_time_seconds;
use super::android_e2e_routes::{e2e_error_response, no_store};
use super::attachments::AttachmentPolicy;
use super::{internal_error, json_error};

pub(crate) const ANDROID_E2E_RPC_PATH: &str = "/remote/v1/e2e/rpc";

/// Request body bound for `/remote/v1/e2e/rpc` from the host's effective
/// attachment maximum (ADR-0227 Decision 5(a), ADR-0351), whatever transport
/// carries the request.
pub(crate) fn android_e2e_rpc_request_limit(state: &AppState) -> Result<usize, String> {
    effective_remote_settings(state).map(|settings| {
        android_e2e_rpc_body_limit(AttachmentPolicy::from_settings(&settings, None).host_max_bytes)
    })
}

/// Outcome of the early prefix check on a partially received body.
pub(crate) enum AndroidE2eRpcPrefixVerdict {
    /// Fewer than 31 bytes have arrived.
    Pending,
    /// The prefix names a live session and a usable sequence. Not authentication.
    Accepted,
    /// The request cannot succeed; answer with this response without waiting
    /// for the rest of the body.
    Rejected(Response),
}

/// Checks the 31-byte prefix once it has arrived. It consumes no sequence and
/// renews no session lifetime or lease.
pub(crate) fn check_android_e2e_rpc_prefix(
    state: &AppState,
    received: &[u8],
) -> AndroidE2eRpcPrefixVerdict {
    let now = match unix_time_seconds() {
        Ok(now) => now,
        Err(error) => return AndroidE2eRpcPrefixVerdict::Rejected(no_store(internal_error(error))),
    };
    match state.android_e2e.check_rpc_prefix(received, now) {
        None => AndroidE2eRpcPrefixVerdict::Pending,
        Some(Ok(())) => AndroidE2eRpcPrefixVerdict::Accepted,
        Some(Err(rejection)) => {
            AndroidE2eRpcPrefixVerdict::Rejected(no_store(envelope_rejection_response(rejection)))
        }
    }
}

pub(crate) fn android_e2e_rpc_too_large_response() -> Response {
    no_store(json_error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Android E2E envelope exceeds the request limit",
    ))
}

pub(super) fn envelope_rejection_response(rejection: EnvelopeRejection) -> Response {
    match rejection {
        EnvelopeRejection::Malformed => json_error(
            StatusCode::BAD_REQUEST,
            "Android E2E envelope is not a valid binary request",
        ),
        EnvelopeRejection::Session(error) => e2e_error_response(error),
    }
}

/// Reads a Direct-route body under `limit`, answering early when the prefix
/// is rejected or the limit is exceeded.
pub(super) async fn read_android_e2e_rpc_body(
    state: &AppState,
    body: Body,
    limit: usize,
) -> Result<RpcRequestEnvelope, Response> {
    let mut received = Vec::new();
    let mut prefix_accepted = false;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            no_store(json_error(
                StatusCode::BAD_REQUEST,
                "Android E2E request body could not be read",
            ))
        })?;
        if received.len().saturating_add(chunk.len()) > limit {
            return Err(android_e2e_rpc_too_large_response());
        }
        received.extend_from_slice(&chunk);
        if !prefix_accepted {
            match check_android_e2e_rpc_prefix(state, &received) {
                AndroidE2eRpcPrefixVerdict::Pending => {}
                AndroidE2eRpcPrefixVerdict::Accepted => prefix_accepted = true,
                AndroidE2eRpcPrefixVerdict::Rejected(response) => return Err(response),
            }
        }
    }
    RpcRequestEnvelope::parse(&received)
        .map_err(|rejection| no_store(envelope_rejection_response(rejection)))
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use futures_util::stream;

    use super::*;

    fn live_state() -> (AppState, String) {
        let state = AppState::new();
        let session_id = URL_SAFE_NO_PAD.encode([3_u8; 16]);
        state
            .android_e2e
            .install_test_request_context("desktop-7", &session_id, u64::MAX);
        (state, session_id)
    }

    fn chunked(chunks: Vec<Vec<u8>>) -> Body {
        Body::from_stream(stream::iter(
            chunks.into_iter().map(Ok::<_, std::convert::Infallible>),
        ))
    }

    #[tokio::test]
    async fn direct_body_is_parsed_across_chunk_boundaries() {
        let (state, session_id) = live_state();
        let body = crate::android_e2e::encode_rpc_request(&session_id, 0, &[7_u8; 40]);
        let chunks = body.chunks(5).map(<[u8]>::to_vec).collect();
        let envelope = read_android_e2e_rpc_body(&state, chunked(chunks), 1024)
            .await
            .unwrap_or_else(|response| panic!("rejected: {}", response.status()));
        assert_eq!(envelope.session_id, session_id);
        assert_eq!(envelope.ciphertext, vec![7_u8; 40]);
    }

    #[tokio::test]
    async fn direct_body_is_rejected_at_the_prefix_without_reading_the_rest() {
        let (state, _) = live_state();
        let unknown = URL_SAFE_NO_PAD.encode([4_u8; 16]);
        let prefix = crate::android_e2e::encode_rpc_request(&unknown, 0, &[]);
        // The rest of the body never arrives: a stream that would hang after
        // the prefix proves the route answers from the prefix alone.
        let body = Body::from_stream(
            stream::iter(vec![Ok::<_, std::convert::Infallible>(prefix)]).chain(stream::pending()),
        );
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            read_android_e2e_rpc_body(&state, body, 1024),
        )
        .await
        .expect("prefix rejection must not wait for the body")
        .unwrap_err();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn direct_body_rejects_wrong_format_and_short_bodies() {
        let (state, session_id) = live_state();
        let mut wrong = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 16]);
        wrong[0] = 1;
        let response = read_android_e2e_rpc_body(&state, Body::from(wrong), 1024)
            .await
            .unwrap_err();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let short = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 15]);
        let response = read_android_e2e_rpc_body(&state, Body::from(short), 1024)
            .await
            .unwrap_err();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = read_android_e2e_rpc_body(&state, Body::from(vec![2_u8; 10]), 1024)
            .await
            .unwrap_err();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn direct_body_enforces_the_host_derived_limit() {
        let (state, session_id) = live_state();
        let body = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 100]);
        let exact = body.len();
        assert!(
            read_android_e2e_rpc_body(&state, Body::from(body.clone()), exact)
                .await
                .is_ok()
        );
        let response = read_android_e2e_rpc_body(&state, Body::from(body), exact - 1)
            .await
            .unwrap_err();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn request_limit_follows_the_host_attachment_setting() {
        let state = AppState::new();
        let settings = effective_remote_settings(&state).unwrap();
        let host = AttachmentPolicy::from_settings(&settings, None).host_max_bytes;
        assert_eq!(
            android_e2e_rpc_request_limit(&state).unwrap(),
            android_e2e_rpc_body_limit(host)
        );
    }
}
