use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::delivery_contract::*;
use super::delivery_support::*;
use super::delivery_worker::{
    publish_close, publish_worker_shutdown_timeout, spawn_worker, DeliveryWorkerHandle,
};
use super::TerminalOutputDelta;
use crate::constants::{
    TERMINAL_OUTPUT_DELIVERY_WORKER_SHUTDOWN_TIMEOUT_MS,
    TERMINAL_OUTPUT_ENVELOPE_EMITTER_CALL_TIMEOUT_MS, TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES,
    TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS, TERMINAL_OUTPUT_ENVELOPE_REPAIR_MAX_ATTEMPTS,
    TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES, TERMINAL_OUTPUT_SERVER_DELIVERY_EXPIRY_MS,
};
use crate::lock_ext::MutexExt;

#[derive(Default)]
pub(super) struct DeliveryState {
    pub(super) closed: bool,
    pub(super) close_reason: Option<TerminalOutputDeliveryCloseReason>,
    pub(super) delivery_started: bool,
    pub(super) close_hook: Option<TerminalOutputDeliveryCloseHook>,
    pub(super) lease: Option<DeliveryLease>,
    pub(super) next_envelope_id: u64,
    pub(super) observed_seq: u64,
    pub(super) parsed_seq: u64,
    pub(super) pending: VecDeque<(TerminalOutputDelta, Instant)>,
    pub(super) pending_bytes: usize,
    pub(super) in_flight: Option<InFlightEnvelope>,
    pub(super) emitter_call_expires_at: Option<Instant>,
    pub(super) last_receipt: Option<ReceiptRecord>,
    pub(super) last_hold: Option<HoldRecord>,
    pub(super) last_close: Option<CloseRecord>,
}

pub(super) struct DeliveryInner {
    pub(super) terminal_id: String,
    pub(super) generation: u64,
    pub(super) state: Mutex<DeliveryState>,
    pub(super) changed: Condvar,
    pub(super) receipt_timeout: Duration,
    pub(super) continuation_timeout: Duration,
    pub(super) emitter_call_timeout: Duration,
}

pub struct DesktopOutputDelivery {
    pub(super) inner: Arc<DeliveryInner>,
    worker: Mutex<Option<DeliveryWorkerHandle>>,
    shutdown_timeout: Mutex<Duration>,
    shutdown_error: Mutex<Option<String>>,
}

impl DesktopOutputDelivery {
    pub fn new(terminal_id: String, generation: u64) -> Self {
        Self::with_timeouts(
            terminal_id,
            generation,
            Duration::from_millis(TERMINAL_OUTPUT_SERVER_DELIVERY_EXPIRY_MS),
            Duration::from_millis(TERMINAL_OUTPUT_SERVER_DELIVERY_EXPIRY_MS),
            Duration::from_millis(TERMINAL_OUTPUT_ENVELOPE_EMITTER_CALL_TIMEOUT_MS),
            Duration::from_millis(TERMINAL_OUTPUT_DELIVERY_WORKER_SHUTDOWN_TIMEOUT_MS),
        )
    }

    fn with_timeouts(
        terminal_id: String,
        generation: u64,
        receipt_timeout: Duration,
        continuation_timeout: Duration,
        emitter_call_timeout: Duration,
        shutdown_timeout: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(DeliveryInner {
                terminal_id,
                generation,
                state: Mutex::new(DeliveryState::default()),
                changed: Condvar::new(),
                receipt_timeout,
                continuation_timeout,
                emitter_call_timeout,
            }),
            worker: Mutex::new(None),
            shutdown_timeout: Mutex::new(shutdown_timeout),
            shutdown_error: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(super) fn with_test_timeouts(
        terminal_id: String,
        generation: u64,
        timeout: Duration,
    ) -> Self {
        Self::with_timeouts(terminal_id, generation, timeout, timeout, timeout, timeout)
    }

    pub fn start(
        &self,
        emitter: Arc<TerminalOutputEnvelopeEmitter>,
        close_hook: TerminalOutputDeliveryCloseHook,
    ) -> Result<(), String> {
        let mut worker = self.worker.lock_or_err()?;
        if worker.is_some() {
            return Err("terminal output delivery already started".into());
        }
        let mut state = self.inner.state.lock_or_err()?;
        if state.closed {
            return Err("terminal output delivery is closed".into());
        }
        state.close_hook = Some(close_hook);
        state.delivery_started = true;
        drop(state);
        *worker = Some(spawn_worker(Arc::clone(&self.inner), emitter)?);
        Ok(())
    }

    /// Replace the desktop lease with an attach snapshot and return the exact
    /// first envelope id the new surface must accept.
    pub fn install_lease(
        &self,
        token: String,
        parsed_seq: u64,
        snapshot_seq: u64,
    ) -> Result<u64, String> {
        if token.is_empty()
            || parsed_seq > snapshot_seq
            || snapshot_seq - parsed_seq > TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES as u64
        {
            return Err("invalid terminal output delivery lease boundary".into());
        }
        let mut state = self.inner.state.lock_or_err()?;
        if state.closed {
            return Err("terminal output delivery is closed".into());
        }
        if state.observed_seq > snapshot_seq {
            return Err("terminal output snapshot is behind recorded delivery bytes".into());
        }
        if state
            .lease
            .as_ref()
            .is_some_and(|lease| lease.grant_id.is_some())
        {
            return Err("cannot replace terminal output lease with an active continuation".into());
        }
        state.lease = Some(DeliveryLease {
            token,
            grant_id: None,
            grant_expires_at: None,
            v3_admitted: false,
        });
        state.observed_seq = snapshot_seq;
        state.parsed_seq = parsed_seq;
        state.pending.clear();
        state.pending_bytes = 0;
        state.in_flight = None;
        state.emitter_call_expires_at = None;
        state.last_receipt = None;
        state.last_hold = None;
        state.last_close = None;
        let next = state
            .next_envelope_id
            .checked_add(1)
            .ok_or_else(|| "terminal output envelope id overflow".to_string())?;
        self.inner.changed.notify_all();
        Ok(next)
    }

    /// Block before the ring is mutated until this exact delta has bounded
    /// delivery storage. The single session ingress gate prevents another
    /// producer from consuming the reservation.
    pub fn wait_for_admission(
        &self,
        seq_start: u64,
        seq_end: u64,
        byte_len: usize,
    ) -> Result<TerminalOutputDeliveryAdmission, String> {
        validate_delta_range(seq_start, seq_end, byte_len)?;
        let mut state = self.inner.state.lock_or_err()?;
        loop {
            if state.closed {
                return Ok(TerminalOutputDeliveryAdmission::Closed);
            }
            if state.lease.is_none() {
                return if seq_start == state.observed_seq {
                    Ok(TerminalOutputDeliveryAdmission::BootstrapRingOnly)
                } else {
                    Err("terminal output bootstrap sequence is not contiguous".into())
                };
            }
            if seq_end <= state.observed_seq {
                return Ok(TerminalOutputDeliveryAdmission::CoveredBySnapshot);
            }
            if seq_start != state.observed_seq {
                return Err("terminal output delivery sequence is not contiguous".into());
            }
            if seq_end.saturating_sub(state.parsed_seq)
                <= TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES as u64
                && state.pending.len() < TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS
                && state.pending_bytes.saturating_add(byte_len)
                    <= TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES
            {
                return Ok(TerminalOutputDeliveryAdmission::Queued);
            }
            state = self
                .inner
                .changed
                .wait(state)
                .map_err(|error| format!("terminal output delivery lock poisoned: {error}"))?;
        }
    }

    pub fn enqueue(
        &self,
        delta: TerminalOutputDelta,
    ) -> Result<TerminalOutputDeliveryAdmission, String> {
        if delta.generation != self.inner.generation {
            return Err("invalid terminal output delivery generation".into());
        }
        let admission =
            self.wait_for_admission(delta.seq_start, delta.seq_end, delta.data.len())?;
        let mut state = self.inner.state.lock_or_err()?;
        match admission {
            TerminalOutputDeliveryAdmission::Closed => return Ok(admission),
            TerminalOutputDeliveryAdmission::BootstrapRingOnly => {
                state.observed_seq = delta.seq_end;
            }
            TerminalOutputDeliveryAdmission::CoveredBySnapshot => {}
            TerminalOutputDeliveryAdmission::Queued => {
                if state.closed {
                    return Ok(TerminalOutputDeliveryAdmission::Closed);
                }
                if delta.seq_start != state.observed_seq {
                    if delta.seq_end <= state.observed_seq {
                        return Ok(TerminalOutputDeliveryAdmission::CoveredBySnapshot);
                    }
                    return Err("terminal output admission changed before enqueue".into());
                }
                state.observed_seq = delta.seq_end;
                if let Some(lease) = state.lease.as_mut() {
                    lease.v3_admitted = true;
                }
                state.pending_bytes += delta.data.len();
                if let Some(lease) = state.lease.as_mut() {
                    if lease.grant_id.is_some() {
                        lease.grant_expires_at =
                            Some(Instant::now() + self.inner.continuation_timeout);
                    }
                }
                state.pending.push_back((delta, Instant::now()));
                self.inner.changed.notify_all();
            }
        }
        Ok(admission)
    }

    pub fn acknowledge_receipt(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        seq_end: u64,
    ) -> Result<TerminalOutputReceiptCompletion, String> {
        let mut state = self.inner.state.lock_or_err()?;
        if !current_lease(&state, self.inner.generation, identity) {
            return Ok(TerminalOutputControlCompletion::Stale);
        }
        if let Some(last) = state.last_receipt.as_ref() {
            if last.identity == *identity {
                return if last.seq_end != seq_end {
                    Err(
                        "terminal output receipt identity was reused with a different sequence"
                            .into(),
                    )
                } else if let Some(error) = last.terminal_error.as_ref() {
                    Err(error.clone())
                } else {
                    Ok(TerminalOutputControlCompletion::Duplicate)
                };
            }
        }
        let Some(in_flight) = state.in_flight.as_ref() else {
            return Ok(TerminalOutputControlCompletion::Stale);
        };
        let expected_identity = in_flight.identity();
        ensure_same_envelope_or_stale(&expected_identity, identity)?;
        if expected_identity != *identity {
            return Ok(TerminalOutputControlCompletion::Stale);
        }
        if in_flight.envelope.seq_end != seq_end {
            return Err("terminal output receipt sequence does not match its envelope".into());
        }
        state.in_flight = None;
        state.last_receipt = Some(ReceiptRecord {
            identity: identity.clone(),
            seq_end,
            terminal_error: None,
        });
        if let Some(lease) = state.lease.as_mut() {
            if lease.grant_id.is_some() {
                lease.grant_expires_at = Some(Instant::now() + self.inner.continuation_timeout);
            }
        }
        self.inner.changed.notify_all();
        Ok(TerminalOutputControlCompletion::Accepted)
    }

    /// Preserve the terminal result of the receipt's second (flow) projection.
    /// The session control gate serializes this directly after an accepted
    /// delivery receipt, so the exact receipt record must still be current.
    pub fn preserve_receipt_projection_failure(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        seq_end: u64,
        error: &str,
    ) -> Result<(), String> {
        let mut state = self.inner.state.lock_or_err()?;
        let Some(last) = state.last_receipt.as_mut() else {
            return Err("accepted terminal output receipt lost its result record".into());
        };
        if last.identity != *identity || last.seq_end != seq_end {
            return Err("accepted terminal output receipt result identity changed".into());
        }
        match last.terminal_error.as_ref() {
            Some(existing) if existing != error => {
                Err("terminal output receipt terminal result changed".into())
            }
            Some(_) => Ok(()),
            None => {
                last.terminal_error = Some(error.into());
                Ok(())
            }
        }
    }

    /// Return the immutable in-flight v3 envelope without emitting another
    /// event. A repair never creates a second in-flight slot or advances ids.
    pub fn repair_envelope(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        expected_seq_start: u64,
    ) -> Result<TerminalOutputEnvelopeRepairResponse, String> {
        let mut state = self.inner.state.lock_or_err()?;
        if state.closed || !current_lease(&state, self.inner.generation, identity) {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::Stale,
                None,
            ));
        }
        if state
            .last_receipt
            .as_ref()
            .is_some_and(|last| last.identity == *identity)
        {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::AlreadyReceipted,
                None,
            ));
        }
        let Some(in_flight) = state.in_flight.as_mut() else {
            // `observed_seq` includes every delta already admitted to the
            // pending queue. While the worker is between a completed receipt
            // and its next envelope build, the frontend legitimately asks at
            // the first pending delta rather than at that queue's tail.
            let next_delivery_seq = state
                .pending
                .front()
                .map_or(state.observed_seq, |(delta, _)| delta.seq_start);
            let expected_next = state.next_envelope_id.checked_add(1) == Some(identity.envelope_id)
                && next_delivery_seq == expected_seq_start;
            return Ok(repair_response(
                if expected_next {
                    TerminalOutputEnvelopeRepairStatus::Idle
                } else {
                    TerminalOutputEnvelopeRepairStatus::Stale
                },
                None,
            ));
        };
        let expected_identity = in_flight.identity();
        if expected_identity != *identity || in_flight.envelope.seq_start != expected_seq_start {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::Mismatch,
                None,
            ));
        }
        if Instant::now() < in_flight.repair_not_before {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::EventPending,
                None,
            ));
        }
        if in_flight.repair_attempts >= TERMINAL_OUTPUT_ENVELOPE_REPAIR_MAX_ATTEMPTS {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::Exhausted,
                None,
            ));
        }
        in_flight.repair_attempts += 1;
        let envelope = in_flight.envelope.clone();
        self.inner.changed.notify_all();
        Ok(repair_response(
            TerminalOutputEnvelopeRepairStatus::Exact,
            Some(envelope),
        ))
    }

    pub fn acknowledge_parsed(
        &self,
        generation: u64,
        token: &str,
        seq: u64,
    ) -> Result<bool, String> {
        let mut state = self.inner.state.lock_or_err()?;
        if generation != self.inner.generation
            || state.lease.as_ref().map(|lease| lease.token.as_str()) != Some(token)
        {
            return Ok(false);
        }
        if seq > state.observed_seq {
            return Err("terminal output parsed sequence is outside the admitted range".into());
        }
        // The frontend's in-place ACK retry (ADR-0095 control liveness) can
        // leave one timed-out duplicate racing its replacement, so a lower
        // sequence on the active lease is a late duplicate, not a contract
        // fault. The parsed frontier is monotonic; absorbing it loses nothing.
        if seq < state.parsed_seq {
            return Ok(true);
        }
        if seq > state.parsed_seq {
            state.parsed_seq = seq;
            if let Some(lease) = state.lease.as_mut() {
                if lease.grant_id.is_some() {
                    lease.grant_expires_at = Some(Instant::now() + self.inner.continuation_timeout);
                }
            }
            self.inner.changed.notify_all();
        }
        Ok(true)
    }

    /// Staged v2 compatibility: legacy `record_output` callers can advance the
    /// shared ring without entering the v3 queue. This projection is permitted
    /// only while v3 owns no pending or in-flight byte, so it cannot disguise a
    /// missing v3 admission.
    pub fn acknowledge_parsed_legacy_prefix(
        &self,
        generation: u64,
        token: &str,
        seq: u64,
        current_seq: u64,
    ) -> Result<bool, String> {
        let mut state = self.inner.state.lock_or_err()?;
        if generation != self.inner.generation
            || state.lease.as_ref().map(|lease| lease.token.as_str()) != Some(token)
        {
            return Ok(false);
        }
        if state.delivery_started || state.lease.as_ref().is_some_and(|lease| lease.v3_admitted) {
            return Err("legacy parsed ACK is unavailable on a production v3 lease".into());
        }
        if seq < state.parsed_seq || seq > current_seq {
            return Err("terminal output parsed sequence is outside the ring prefix".into());
        }
        if seq > state.observed_seq {
            if state.in_flight.is_some() || !state.pending.is_empty() {
                return Err("legacy parsed ACK cannot skip admitted v3 delivery bytes".into());
            }
            state.observed_seq = current_seq;
        }
        state.parsed_seq = seq;
        self.inner.changed.notify_all();
        Ok(true)
    }

    pub fn close(&self, reason: TerminalOutputDeliveryCloseReason) {
        publish_close(&self.inner, reason);
    }

    pub(super) fn diagnostics(&self) -> Result<DeliveryDiagnostics, String> {
        let state = self.inner.state.lock_or_err()?;
        Ok(DeliveryDiagnostics {
            closed: state.closed,
            close_reason: state.close_reason.clone(),
            lease_token: state.lease.as_ref().map(|lease| lease.token.clone()),
            grant_id: state
                .lease
                .as_ref()
                .and_then(|lease| lease.grant_id.clone()),
            parsed_seq: state.parsed_seq,
            observed_seq: state.observed_seq,
            pending_bytes: state.pending_bytes,
            in_flight: state.in_flight.clone(),
        })
    }

    pub fn join(&self) -> Result<(), String> {
        if let Some(error) = self.shutdown_error.lock_or_err()?.clone() {
            return Err(error);
        }
        if let Some(worker) = self.worker.lock_or_err()?.take() {
            let shutdown_timeout = *self.shutdown_timeout.lock_or_err()?;
            if let Err(error) = worker.join_timeout(shutdown_timeout) {
                *self.shutdown_error.lock_or_err()? = Some(error.clone());
                publish_worker_shutdown_timeout(&self.inner);
                return Err(error);
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn set_shutdown_timeout_for_test(&self, timeout: Duration) {
        *self.shutdown_timeout.lock().unwrap() = timeout;
    }

    #[cfg(test)]
    pub(super) fn shutdown_timeout_for_test(&self) -> Duration {
        *self.shutdown_timeout.lock().unwrap()
    }
}
