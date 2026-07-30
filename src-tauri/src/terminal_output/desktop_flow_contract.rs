use std::time::Instant;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFlowControl {
    /// Opaque attach lease identity; strings cross the JavaScript boundary losslessly.
    pub token: String,
    pub window_bytes: usize,
    pub next_envelope_id: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DesktopOutputState {
    Healthy,
    Backpressured,
    FailStopped,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopOutputFailureReason {
    ContinuationExpired,
    ParsedProgressExpired,
    IdentityConflict,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOutputDiagnostics {
    pub state: DesktopOutputState,
    pub reason: Option<DesktopOutputFailureReason>,
    /// Which invariant the fail-stop tripped on. `reason` alone collapses several
    /// distinct faults onto one code, so keep the message that named the cause.
    pub reason_detail: Option<String>,
    pub lease_token: Option<String>,
    pub parsed_ack: Option<u64>,
    pub effective_limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuationRequest {
    pub envelope_id: u64,
    pub client_grant_id: String,
    pub frame_start_seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationCloseReason {
    Terminator,
    Malformed,
    Timeout,
    Oversized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuationCompletion {
    Opened { effective_limit: u64 },
    Duplicate { effective_limit: u64 },
    Closed,
    Stale,
    BootstrapRejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GrantKey {
    pub(super) envelope_id: u64,
    pub(super) client_grant_id: String,
}

#[derive(Debug, Clone)]
pub(super) struct ContinuationGrant {
    pub(super) key: GrantKey,
    pub(super) frame_start_seq: u64,
    pub(super) effective_limit: u64,
    pub(super) expires_at: Instant,
    pub(super) last_source_seq: u64,
    pub(super) close: Option<(u64, ContinuationCloseReason)>,
}

#[derive(Debug, Clone)]
pub(super) struct DesktopOutputLease {
    pub(super) token: Option<String>,
    pub(super) parsed_ack: u64,
    pub(super) base_credit: u64,
    pub(super) grant: Option<ContinuationGrant>,
    pub(super) last_grant: Option<ContinuationGrant>,
}

#[derive(Debug, Clone)]
pub(super) struct ProgressDeadline {
    pub(super) token: Option<String>,
    pub(super) parsed_ack: u64,
    pub(super) expires_at: Instant,
}

pub(super) struct DesktopOutputFlowState {
    pub(super) next_token: u64,
    pub(super) active: Option<DesktopOutputLease>,
    pub(super) output_state: DesktopOutputState,
    pub(super) failure_reason: Option<DesktopOutputFailureReason>,
    pub(super) failure_detail: Option<String>,
    pub(super) progress_deadline: Option<ProgressDeadline>,
    pub(super) retired: bool,
}

impl Default for DesktopOutputFlowState {
    fn default() -> Self {
        Self {
            next_token: 0,
            active: None,
            output_state: DesktopOutputState::Healthy,
            failure_reason: None,
            failure_detail: None,
            progress_deadline: None,
            retired: false,
        }
    }
}

pub(super) fn credit(window_bytes: usize) -> u64 {
    window_bytes.max(1) as u64
}

pub(super) fn key(request: &ContinuationRequest) -> GrantKey {
    GrantKey {
        envelope_id: request.envelope_id,
        client_grant_id: request.client_grant_id.clone(),
    }
}

pub(super) fn effective_limit(lease: &DesktopOutputLease) -> u64 {
    let base = lease.parsed_ack.saturating_add(lease.base_credit);
    lease
        .grant
        .as_ref()
        .map_or(base, |grant| base.max(grant.effective_limit))
}

pub(super) fn reset_healthy(state: &mut DesktopOutputFlowState) {
    if state.output_state != DesktopOutputState::FailStopped {
        state.output_state = DesktopOutputState::Healthy;
        state.progress_deadline = None;
    }
}

pub(super) fn fail_stop(state: &mut DesktopOutputFlowState, reason: DesktopOutputFailureReason) {
    fail_stop_detailed(state, reason, None);
}

pub(super) fn fail_stop_detailed(
    state: &mut DesktopOutputFlowState,
    reason: DesktopOutputFailureReason,
    detail: Option<&str>,
) {
    if state.output_state != DesktopOutputState::FailStopped {
        state.output_state = DesktopOutputState::FailStopped;
        state.failure_reason = Some(reason);
        state.failure_detail = detail.map(str::to_owned);
        state.progress_deadline = None;
    }
}

pub(super) fn failure_message(state: &DesktopOutputFlowState) -> String {
    format!(
        "terminal desktop output fail-stopped: {:?}",
        state.failure_reason
    )
}
