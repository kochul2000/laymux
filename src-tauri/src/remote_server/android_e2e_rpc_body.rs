//! Pre-authentication bounds of the binary Android E2E RPC request body
//! (ADR-0351), shared by the Tailscale Direct route and the Cloud tunnel.
//!
//! Before AEAD the desktop holds at most the host-derived body limit per
//! request, and rejects the request as soon as its 31-byte prefix names no
//! live session or an unusable sequence. Neither check is authentication.
//!
//! On Tailscale Direct an early answer is only sent once the rest of the body
//! has been read and discarded (ADR-0352): the Android client reads the status
//! only after writing its whole body, so closing on an unread body would reset
//! the upload and hide the 401/410 behind a retryable write failure.

use std::time::Duration;

use axum::body::{Body, BodyDataStream};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use futures_util::StreamExt;
use tokio::time::{timeout, Instant};

use crate::android_e2e::{EnvelopeRejection, RpcRequestEnvelope};
use crate::constants::{
    android_e2e_rpc_body_limit, ANDROID_E2E_RPC_DISCARD_IDLE_TIMEOUT_SECS,
    ANDROID_E2E_RPC_DISCARD_TOTAL_TIMEOUT_SECS, ANDROID_E2E_RPC_MAX_BODY_BYTES,
};
use crate::state::AppState;

use super::access::effective_remote_settings;
use super::android_e2e_output::unix_time_seconds;
use super::android_e2e_routes::{e2e_error_response, no_store};
use super::attachments::AttachmentPolicy;
use super::{internal_error, json_error};

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

/// How much of an early-answered Direct body is read and discarded before
/// the answer is sent (ADR-0352).
#[derive(Debug, Clone, Copy)]
pub(super) struct DiscardBounds {
    /// Cumulative body bytes, counting what was already received. The
    /// largest body any host setting admits, so a client whose envelope was
    /// sized for a higher attachment maximum still learns its 413.
    pub(super) byte_cap: usize,
    /// Longest gap between two chunks.
    pub(super) idle: Duration,
    /// Total time spent discarding.
    pub(super) total: Duration,
}

impl DiscardBounds {
    pub(super) const DIRECT: Self = Self {
        byte_cap: ANDROID_E2E_RPC_MAX_BODY_BYTES,
        idle: Duration::from_secs(ANDROID_E2E_RPC_DISCARD_IDLE_TIMEOUT_SECS),
        total: Duration::from_secs(ANDROID_E2E_RPC_DISCARD_TOTAL_TIMEOUT_SECS),
    };
}

/// How the discard of an early-answered body ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DiscardOutcome {
    /// The body ended: the connection can carry the answer and stay usable.
    Drained,
    /// The body stopped with a read error; nobody is left to answer.
    Disconnected,
    /// The byte cap or a deadline ran out first: answer and close.
    Abandoned,
}

/// Reads and drops the rest of a body without holding it. `received` counts
/// the bytes the caller already took from the stream.
pub(super) async fn discard_remaining_body(
    stream: &mut BodyDataStream,
    mut received: usize,
    bounds: DiscardBounds,
) -> DiscardOutcome {
    let deadline = Instant::now() + bounds.total;
    loop {
        if received > bounds.byte_cap {
            return DiscardOutcome::Abandoned;
        }
        let wait = bounds
            .idle
            .min(deadline.saturating_duration_since(Instant::now()));
        match timeout(wait, stream.next()).await {
            Err(_) => return DiscardOutcome::Abandoned,
            Ok(None) => return DiscardOutcome::Drained,
            Ok(Some(Err(_))) => return DiscardOutcome::Disconnected,
            Ok(Some(Ok(chunk))) => received = received.saturating_add(chunk.len()),
        }
    }
}

/// Holds an early answer until the rest of the body is discarded. When the
/// discard gives up, the answer still goes out but closes the connection.
async fn answer_after_discard(
    stream: &mut BodyDataStream,
    received: usize,
    mut response: Response,
    bounds: DiscardBounds,
) -> Response {
    let outcome = discard_remaining_body(stream, received, bounds).await;
    if outcome == DiscardOutcome::Abandoned {
        tracing::debug!(
            status = response.status().as_u16(),
            "Android E2E early answer closes the connection after an unfinished discard"
        );
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
    response
}

/// Reads a Direct-route body under `limit`. A rejected prefix or an exceeded
/// limit is decided as soon as it is known, but answered only after the rest
/// of the body is discarded (ADR-0352).
pub(super) async fn read_android_e2e_rpc_body(
    state: &AppState,
    body: Body,
    limit: usize,
) -> Result<RpcRequestEnvelope, Response> {
    read_android_e2e_rpc_body_with(state, body, limit, DiscardBounds::DIRECT).await
}

pub(super) async fn read_android_e2e_rpc_body_with(
    state: &AppState,
    body: Body,
    limit: usize,
    discard: DiscardBounds,
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
        let total = received.len().saturating_add(chunk.len());
        if total > limit {
            drop(received);
            return Err(answer_after_discard(
                &mut stream,
                total,
                android_e2e_rpc_too_large_response(),
                discard,
            )
            .await);
        }
        received.extend_from_slice(&chunk);
        if !prefix_accepted {
            match check_android_e2e_rpc_prefix(state, &received) {
                AndroidE2eRpcPrefixVerdict::Pending => {}
                AndroidE2eRpcPrefixVerdict::Accepted => prefix_accepted = true,
                AndroidE2eRpcPrefixVerdict::Rejected(response) => {
                    let total = received.len();
                    drop(received);
                    return Err(answer_after_discard(&mut stream, total, response, discard).await);
                }
            }
        }
    }
    RpcRequestEnvelope::parse(received)
        .map_err(|rejection| no_store(envelope_rejection_response(rejection)))
}

#[cfg(test)]
#[path = "android_e2e_rpc_body_tests.rs"]
mod tests;
