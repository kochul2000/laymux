use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::constants::{
    TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES, TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES,
};
use crate::lock_ext::MutexExt;

#[path = "desktop_flow_contract.rs"]
mod contract;
pub use contract::TerminalOutputFlowControl;
use contract::*;
pub(super) use contract::{
    ContinuationCloseReason, ContinuationCompletion, ContinuationRequest, DesktopOutputDiagnostics,
    DesktopOutputFailureReason, DesktopOutputState,
};

const DESKTOP_FLOW_DEADLINE: Duration = Duration::from_secs(5);

/// Generation-local parsed-credit and normal-frame continuation gate.
///
/// The owning session adds terminal id and generation to `diagnostics()`. This
/// type owns only the attach token, parsed ACK, grant identity and bounded
/// waiter liveness; it never resets or replays the screen.
pub(super) struct DesktopOutputFlow {
    state: Mutex<DesktopOutputFlowState>,
    changed: Condvar,
    retired: AtomicBool,
    continuation_bytes: u64,
    deadline: Duration,
}

impl DesktopOutputFlow {
    pub(super) fn new() -> Self {
        Self::with_policy(
            TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES as u64,
            DESKTOP_FLOW_DEADLINE,
        )
    }

    fn with_policy(continuation_bytes: u64, deadline: Duration) -> Self {
        Self {
            state: Mutex::new(DesktopOutputFlowState::default()),
            changed: Condvar::new(),
            retired: AtomicBool::new(false),
            continuation_bytes,
            deadline,
        }
    }

    pub(super) fn begin_bootstrap(&self, window_bytes: usize) -> Result<(), String> {
        let mut state = self.lock_state()?;
        if state.retired {
            return Ok(());
        }
        if state.output_state == DesktopOutputState::FailStopped {
            return Err(failure_message(&state));
        }
        state.active = Some(DesktopOutputLease {
            token: None,
            parsed_ack: 0,
            base_credit: credit(window_bytes),
            grant: None,
            last_grant: None,
        });
        reset_healthy(&mut state);
        self.changed.notify_all();
        Ok(())
    }

    pub(super) fn attach(
        &self,
        parsed_ack: u64,
        window_bytes: usize,
    ) -> Result<TerminalOutputFlowControl, String> {
        let mut state = self.lock_state()?;
        if state.retired {
            return Err("cannot attach retired terminal desktop flow".into());
        }
        if state.output_state == DesktopOutputState::FailStopped {
            return Err(failure_message(&state));
        }
        if state
            .active
            .as_ref()
            .is_some_and(|lease| lease.grant.is_some())
        {
            return Err("cannot replace desktop lease while a continuation grant is active".into());
        }
        state.next_token = state.next_token.wrapping_add(1).max(1);
        let token = state.next_token.to_string();
        let base_credit = credit(window_bytes);
        state.active = Some(DesktopOutputLease {
            token: Some(token.clone()),
            parsed_ack,
            base_credit,
            grant: None,
            last_grant: None,
        });
        reset_healthy(&mut state);
        self.changed.notify_all();
        Ok(TerminalOutputFlowControl {
            token,
            window_bytes: base_credit as usize,
            next_envelope_id: 1,
        })
    }

    pub(super) fn acknowledge(
        &self,
        token: &str,
        seq: u64,
        current_seq: u64,
    ) -> Result<bool, String> {
        if seq > current_seq {
            return Err(format!(
                "terminal output ACK {seq} is ahead of current sequence {current_seq}"
            ));
        }
        let mut state = self.lock_state()?;
        if state.retired || state.output_state == DesktopOutputState::FailStopped {
            return Ok(false);
        }
        let Some(active) = state.active.as_mut() else {
            return Ok(false);
        };
        if active.token.as_deref() != Some(token) {
            return Ok(false);
        }
        if seq < active.parsed_ack {
            return Err(format!(
                "terminal output ACK {seq} is behind acknowledged sequence {}",
                active.parsed_ack
            ));
        }
        if seq > active.parsed_ack {
            active.parsed_ack = seq;
            if let Some(grant) = active.grant.as_mut() {
                grant.expires_at = Instant::now() + self.deadline;
            }
            state.progress_deadline = None;
            state.output_state = DesktopOutputState::Healthy;
            self.changed.notify_all();
        }
        Ok(true)
    }

    pub(super) fn open_continuation(
        &self,
        token: &str,
        request: &ContinuationRequest,
        current_seq: u64,
    ) -> Result<ContinuationCompletion, String> {
        let mut state = self.lock_state()?;
        if state.retired || state.output_state == DesktopOutputState::FailStopped {
            return Ok(ContinuationCompletion::Stale);
        }
        let Some(lease) = state.active.as_ref() else {
            return Ok(ContinuationCompletion::Stale);
        };
        if lease.token.is_none() {
            return Ok(ContinuationCompletion::BootstrapRejected);
        }
        if lease.token.as_deref() != Some(token) {
            return Ok(ContinuationCompletion::Stale);
        }
        let key = key(request);
        if let Some(grant) = lease.grant.as_ref().or(lease.last_grant.as_ref()) {
            if grant.key == key {
                if grant.frame_start_seq != request.frame_start_seq {
                    return self.identity_fault(
                        &mut state,
                        "continuation identity was reused with a different frame start",
                    );
                }
                return Ok(ContinuationCompletion::Duplicate {
                    effective_limit: grant.effective_limit,
                });
            }
        }
        if request.frame_start_seq < lease.parsed_ack || request.frame_start_seq > current_seq {
            return self.identity_fault(
                &mut state,
                "continuation frame start is outside the current unparsed source range",
            );
        }
        if lease.grant.is_some() {
            return self.identity_fault(
                &mut state,
                "a different continuation identity is already active",
            );
        }
        let parsed_ack = lease.parsed_ack;
        let base_limit = parsed_ack.saturating_add(lease.base_credit);
        let Some(frame_limit) = request.frame_start_seq.checked_add(self.continuation_bytes) else {
            return self
                .identity_fault(&mut state, "terminal output continuation sequence overflow");
        };
        let effective_limit = base_limit.max(frame_limit);
        let grant = ContinuationGrant {
            key,
            frame_start_seq: request.frame_start_seq,
            effective_limit,
            expires_at: Instant::now() + self.deadline,
            last_source_seq: current_seq,
            close: None,
        };
        let Some(active) = state.active.as_mut() else {
            return Err("terminal output lease disappeared before grant commit".into());
        };
        active.grant = Some(grant);
        state.progress_deadline = None;
        self.changed.notify_all();
        Ok(ContinuationCompletion::Opened { effective_limit })
    }

    pub(super) fn close_continuation(
        &self,
        token: &str,
        request: &ContinuationRequest,
        close_seq: u64,
        current_seq: u64,
        reason: ContinuationCloseReason,
    ) -> Result<ContinuationCompletion, String> {
        let mut state = self.lock_state()?;
        if state.retired || state.output_state == DesktopOutputState::FailStopped {
            return Ok(ContinuationCompletion::Stale);
        }
        let Some(lease) = state.active.as_mut() else {
            return Ok(ContinuationCompletion::Stale);
        };
        if lease.token.as_deref() != Some(token) {
            return Ok(ContinuationCompletion::Stale);
        }
        let request_key = key(request);
        if let Some(last) = lease.last_grant.as_ref() {
            if last.key == request_key && last.frame_start_seq == request.frame_start_seq {
                if last.close == Some((close_seq, reason)) {
                    return Ok(ContinuationCompletion::Closed);
                }
                return self.identity_fault(
                    &mut state,
                    "continuation close identity was reused with different payload",
                );
            }
        }
        let Some(mut grant) = lease.grant.take() else {
            return Ok(ContinuationCompletion::Stale);
        };
        if grant.key == request_key && grant.frame_start_seq != request.frame_start_seq {
            lease.grant = Some(grant);
            return self.identity_fault(
                &mut state,
                "continuation close identity changed its frame start",
            );
        }
        if grant.key != request_key {
            lease.grant = Some(grant);
            return Ok(ContinuationCompletion::Stale);
        }
        let frame_limit = grant
            .frame_start_seq
            .saturating_add(self.continuation_bytes);
        let oversized_limit =
            frame_limit.saturating_add(TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES as u64);
        let valid_boundary = match reason {
            ContinuationCloseReason::Oversized => {
                close_seq > frame_limit && close_seq <= oversized_limit
            }
            _ => close_seq >= grant.frame_start_seq && close_seq <= frame_limit,
        } && close_seq <= current_seq;
        if !valid_boundary {
            lease.grant = Some(grant);
            return self.identity_fault(
                &mut state,
                "continuation close reason does not match its sequence boundary",
            );
        }
        grant.close = Some((close_seq, reason));
        lease.last_grant = Some(grant);
        state.progress_deadline = None;
        self.changed.notify_all();
        Ok(ContinuationCompletion::Closed)
    }

    pub(super) fn wait_for_capacity(&self, produced_seq: u64) -> Result<(), String> {
        self.wait_for_capacity_range(produced_seq, produced_seq, false)
    }

    /// Admit one completed PTY read at the credit boundary. The read that
    /// started at or before the current limit may finish by at most one read
    /// chunk beyond it; the following read blocks until parsed/continuation
    /// progress moves the limit.
    pub(super) fn wait_for_read_capacity(
        &self,
        seq_start: u64,
        seq_end: u64,
    ) -> Result<(), String> {
        if seq_end < seq_start
            || seq_end.saturating_sub(seq_start) > TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES as u64
        {
            return Err("terminal output read exceeds the bounded source chunk".into());
        }
        self.wait_for_capacity_range(seq_start, seq_end, true)
    }

    fn wait_for_capacity_range(
        &self,
        seq_start: u64,
        seq_end: u64,
        allow_read_overshoot: bool,
    ) -> Result<(), String> {
        let mut state = self.lock_state()?;
        loop {
            if state.retired {
                return Ok(());
            }
            if state.output_state == DesktopOutputState::FailStopped {
                return Err(failure_message(&state));
            }
            let Some(lease) = state.active.as_mut() else {
                return Ok(());
            };
            let now = Instant::now();
            if lease
                .grant
                .as_ref()
                .is_some_and(|grant| now >= grant.expires_at)
            {
                fail_stop(&mut state, DesktopOutputFailureReason::ContinuationExpired);
                self.changed.notify_all();
                return Err(failure_message(&state));
            }
            let limit = effective_limit(lease);
            let admitted = if allow_read_overshoot {
                seq_start <= limit
                    && seq_end <= limit.saturating_add(TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES as u64)
            } else {
                seq_end <= limit
            };
            if admitted {
                if let Some(grant) = lease.grant.as_mut() {
                    if seq_end > grant.last_source_seq {
                        grant.last_source_seq = seq_end;
                        grant.expires_at = now + self.deadline;
                    }
                }
                if state.output_state == DesktopOutputState::Backpressured {
                    reset_healthy(&mut state);
                }
                return Ok(());
            }
            let token = lease.token.clone();
            let parsed_ack = lease.parsed_ack;
            state.output_state = DesktopOutputState::Backpressured;
            let progress_expiry = match state.progress_deadline.as_ref() {
                Some(deadline) if deadline.token == token && deadline.parsed_ack == parsed_ack => {
                    deadline.expires_at
                }
                _ => {
                    let expires_at = now + self.deadline;
                    state.progress_deadline = Some(ProgressDeadline {
                        token,
                        parsed_ack,
                        expires_at,
                    });
                    expires_at
                }
            };
            let grant_expiry = state
                .active
                .as_ref()
                .and_then(|lease| lease.grant.as_ref().map(|grant| grant.expires_at));
            let wake_at =
                grant_expiry.map_or(progress_expiry, |expiry| expiry.min(progress_expiry));
            if now >= wake_at {
                let reason = if grant_expiry.is_some_and(|expiry| now >= expiry) {
                    DesktopOutputFailureReason::ContinuationExpired
                } else {
                    DesktopOutputFailureReason::ParsedProgressExpired
                };
                fail_stop(&mut state, reason);
                self.changed.notify_all();
                return Err(failure_message(&state));
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, wake_at.saturating_duration_since(now))
                .map_err(|error| format!("terminal desktop flow lock poisoned: {error}"))?;
            state = next;
        }
    }

    pub(super) fn note_continuation_receipt(&self, token: &str) -> Result<bool, String> {
        let mut state = self.lock_state()?;
        if state.retired || state.output_state == DesktopOutputState::FailStopped {
            return Ok(false);
        }
        let Some(active) = state.active.as_mut() else {
            return Ok(false);
        };
        if active.token.as_deref() != Some(token) {
            return Ok(false);
        }
        let Some(grant) = active.grant.as_mut() else {
            return Ok(false);
        };
        grant.expires_at = Instant::now() + self.deadline;
        self.changed.notify_all();
        Ok(true)
    }

    pub(super) fn diagnostics(&self) -> Result<DesktopOutputDiagnostics, String> {
        let state = self.lock_state()?;
        let active = state.active.as_ref();
        Ok(DesktopOutputDiagnostics {
            state: state.output_state,
            reason: state.failure_reason,
            reason_detail: state.failure_detail.clone(),
            lease_token: active.and_then(|lease| lease.token.clone()),
            parsed_ack: active.map(|lease| lease.parsed_ack),
            effective_limit: active.map(effective_limit),
        })
    }

    /// Delivery owns the independent server watchdog for a lost continuation
    /// close. Its expiry notification is authoritative only while this flow
    /// still owns an active grant; a close that already cleared the grant must
    /// never be converted into a delayed false failure.
    pub(super) fn fail_stop_expired_continuation(&self) -> Result<bool, String> {
        let mut state = self.lock_state()?;
        if state.retired || state.output_state == DesktopOutputState::FailStopped {
            return Ok(false);
        }
        if state
            .active
            .as_ref()
            .is_none_or(|lease| lease.grant.is_none())
        {
            return Ok(false);
        }
        fail_stop(&mut state, DesktopOutputFailureReason::ContinuationExpired);
        self.changed.notify_all();
        Ok(true)
    }

    pub(super) fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        let mut state = self
            .state
            .lock_or_recover_for_discard("retiring terminal desktop flow");
        state.retired = true;
        state.active = None;
        state.progress_deadline = None;
        self.changed.notify_all();
    }

    pub(super) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, DesktopOutputFlowState>, String> {
        self.state.lock_or_err().map_err(|error| format!("{error}"))
    }

    fn identity_fault<T>(
        &self,
        state: &mut DesktopOutputFlowState,
        message: &str,
    ) -> Result<T, String> {
        fail_stop_detailed(
            state,
            DesktopOutputFailureReason::IdentityConflict,
            Some(message),
        );
        self.changed.notify_all();
        Err(message.into())
    }

    #[cfg(test)]
    fn for_test(continuation_bytes: u64, deadline: Duration) -> Self {
        Self::with_policy(continuation_bytes, deadline)
    }

    #[cfg(test)]
    pub(super) fn poison_for_test(&self) {
        let _state = self.state.lock().unwrap();
        panic!("poison terminal desktop flow for test");
    }
}

#[cfg(test)]
#[path = "desktop_flow_tests.rs"]
mod desktop_flow_tests;
