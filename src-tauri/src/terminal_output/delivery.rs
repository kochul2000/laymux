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
    TERMINAL_OUTPUT_CONTINUATION_CONTROL_TIMEOUT_MS, TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES,
    TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS, TERMINAL_OUTPUT_ENVELOPE_RECEIPT_TIMEOUT_MS,
    TERMINAL_OUTPUT_ENVELOPE_REPAIR_MAX_ATTEMPTS, TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES,
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
    pub(super) in_flight: VecDeque<InFlightEnvelope>,
    pub(super) emitter_call_expires_at: Option<Instant>,
    pub(super) recent_receipts: VecDeque<ReceiptRecord>,
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
            Duration::from_millis(TERMINAL_OUTPUT_ENVELOPE_RECEIPT_TIMEOUT_MS),
            Duration::from_millis(TERMINAL_OUTPUT_CONTINUATION_CONTROL_TIMEOUT_MS),
        )
    }

    fn with_timeouts(
        terminal_id: String,
        generation: u64,
        receipt_timeout: Duration,
        continuation_timeout: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(DeliveryInner {
                terminal_id,
                generation,
                state: Mutex::new(DeliveryState::default()),
                changed: Condvar::new(),
                receipt_timeout,
                continuation_timeout,
            }),
            worker: Mutex::new(None),
            shutdown_timeout: Mutex::new(continuation_timeout),
            shutdown_error: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(super) fn with_test_timeouts(
        terminal_id: String,
        generation: u64,
        timeout: Duration,
    ) -> Self {
        Self::with_timeouts(terminal_id, generation, timeout, timeout)
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
        state.in_flight.clear();
        state.emitter_call_expires_at = None;
        state.recent_receipts.clear();
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
        if let Some(last) = state
            .recent_receipts
            .iter()
            .find(|last| last.identity == *identity)
        {
            return if last.seq_end != seq_end {
                Err("terminal output receipt identity was reused with a different sequence".into())
            } else if let Some(error) = last.terminal_error.as_ref() {
                Err(error.clone())
            } else {
                Ok(TerminalOutputControlCompletion::Duplicate)
            };
        }
        let Some(slot_index) = state
            .in_flight
            .iter()
            .position(|in_flight| in_flight.identity() == *identity)
        else {
            if let Some(in_flight) = state.in_flight.iter().find(|in_flight| {
                let candidate = in_flight.identity();
                candidate.generation == identity.generation
                    && candidate.lease_token == identity.lease_token
                    && candidate.envelope_id == identity.envelope_id
            }) {
                ensure_same_envelope_or_stale(&in_flight.identity(), identity)?;
            }
            return Ok(TerminalOutputControlCompletion::Stale);
        };
        let expected_identity = state.in_flight[slot_index].identity();
        ensure_same_envelope_or_stale(&expected_identity, identity)?;
        let seq_start = state.in_flight[slot_index].envelope.seq_start;
        if state.in_flight[slot_index].envelope.seq_end != seq_end {
            return Err("terminal output receipt sequence does not match its envelope".into());
        }
        state.in_flight.remove(slot_index);
        state.recent_receipts.push_back(ReceiptRecord {
            identity: identity.clone(),
            seq_start,
            seq_end,
            terminal_error: None,
        });
        while state.recent_receipts.len()
            > crate::constants::TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT * 2
        {
            state.recent_receipts.pop_front();
        }
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
        let Some(last) = state
            .recent_receipts
            .iter_mut()
            .find(|last| last.identity == *identity && last.seq_end == seq_end)
        else {
            return Err("accepted terminal output receipt lost its result record".into());
        };
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
            .recent_receipts
            .iter()
            .any(|last| last.identity == *identity)
        {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::AlreadyReceipted,
                None,
            ));
        }
        if state.in_flight.is_empty() {
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
        }
        let Some(in_flight) = state
            .in_flight
            .iter_mut()
            .find(|in_flight| in_flight.identity() == *identity)
        else {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::Mismatch,
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
        if in_flight.repair_attempts >= TERMINAL_OUTPUT_ENVELOPE_REPAIR_MAX_ATTEMPTS {
            return Ok(repair_response(
                TerminalOutputEnvelopeRepairStatus::Exhausted,
                None,
            ));
        }
        in_flight.repair_attempts += 1;
        in_flight.expires_at = Instant::now() + self.inner.receipt_timeout;
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
        if seq < state.parsed_seq || seq > state.observed_seq {
            return Err("terminal output parsed sequence is outside the admitted range".into());
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
            if !state.in_flight.is_empty() || !state.pending.is_empty() {
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
            in_flight: state.in_flight.iter().cloned().collect(),
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
}
