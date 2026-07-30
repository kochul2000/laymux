use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::delivery::{DeliveryInner, DeliveryState};
use super::delivery_contract::*;
use super::delivery_deadline::spawn_deadline_worker;
use crate::constants::{
    EVENT_TERMINAL_OUTPUT_V3_PREFIX, TERMINAL_OUTPUT_ENVELOPE_EMIT_MAX_ATTEMPTS,
    TERMINAL_OUTPUT_ENVELOPE_EMIT_RETRY_MS, TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES,
    TERMINAL_OUTPUT_ENVELOPE_MAX_DELAY_MS, TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS,
    TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT, TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES,
    TERMINAL_OUTPUT_ENVELOPE_QUIET_MS,
};
use crate::lock_ext::MutexExt;

pub(super) struct WorkerThread {
    handle: JoinHandle<()>,
    completed: mpsc::Receiver<()>,
}

impl WorkerThread {
    pub(super) fn new(handle: JoinHandle<()>, completed: mpsc::Receiver<()>) -> Self {
        Self { handle, completed }
    }

    pub(super) fn join_before(self, deadline: Instant) -> Result<(), String> {
        match self
            .completed
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => self
                .handle
                .join()
                .map_err(|_| "terminal output delivery worker panicked".to_string()),
            Err(RecvTimeoutError::Timeout) => {
                // Rust cannot cancel an arbitrary synchronous emitter. Dropping
                // the handle detaches only after the caller has received an
                // explicit typed failure; the already-published closed state
                // keeps every flow/admission waiter finite.
                Err("terminal output delivery worker shutdown timed out".into())
            }
        }
    }
}

pub(super) struct DeliveryWorkerHandle {
    emitter: WorkerThread,
    deadline: WorkerThread,
}

impl DeliveryWorkerHandle {
    pub(super) fn join_timeout(self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        // The deadline owner never calls the synchronous emitter and therefore
        // must settle first. The remaining budget bounds an emitter that
        // ignored the already-published close.
        self.deadline.join_before(deadline)?;
        self.emitter.join_before(deadline)
    }
}

pub(super) fn spawn_worker(
    inner: Arc<DeliveryInner>,
    emitter: Arc<TerminalOutputEnvelopeEmitter>,
) -> Result<DeliveryWorkerHandle, String> {
    let deadline = spawn_deadline_worker(Arc::clone(&inner))?;
    let name = format!(
        "terminal-output-emitter-{}-{}",
        inner.terminal_id, inner.generation
    );
    let (completed_tx, completed) = mpsc::channel();
    let emitter_inner = Arc::clone(&inner);
    let emitter_handle = thread::Builder::new().name(name).spawn(move || {
        if catch_unwind(AssertUnwindSafe(|| {
            run_worker(Arc::clone(&emitter_inner), emitter)
        }))
        .is_err()
        {
            publish_close(
                &emitter_inner,
                TerminalOutputDeliveryCloseReason::WorkerPanicked,
            );
        }
        let _ = completed_tx.send(());
    });
    let handle = match emitter_handle {
        Ok(handle) => handle,
        Err(error) => {
            publish_close(&inner, TerminalOutputDeliveryCloseReason::WorkerPanicked);
            let _ = deadline.join_before(Instant::now() + Duration::from_secs(1));
            return Err(format!("failed to start terminal output delivery: {error}"));
        }
    };
    Ok(DeliveryWorkerHandle {
        emitter: WorkerThread { handle, completed },
        deadline,
    })
}

fn run_worker(inner: Arc<DeliveryInner>, emitter: Arc<TerminalOutputEnvelopeEmitter>) {
    loop {
        let envelope = match next_envelope(&inner) {
            Ok(Some(envelope)) => envelope,
            Ok(None) => return,
            Err(reason) => {
                publish_close(&inner, reason);
                return;
            }
        };
        if let Err(reason) = emit_with_retry(&inner, &emitter, &envelope) {
            publish_close(&inner, reason);
            return;
        }
    }
}

fn emit_with_retry(
    inner: &DeliveryInner,
    emitter: &Arc<TerminalOutputEnvelopeEmitter>,
    envelope: &TerminalOutputDeltaEnvelopeV3,
) -> Result<(), TerminalOutputDeliveryCloseReason> {
    let identity = TerminalOutputEnvelopeIdentity::from(envelope);
    let event = format!("{EVENT_TERMINAL_OUTPUT_V3_PREFIX}{}", inner.terminal_id);
    for attempt in 1..=TERMINAL_OUTPUT_ENVELOPE_EMIT_MAX_ATTEMPTS {
        let current = inner.state.lock().ok().is_some_and(|state| {
            !state.closed
                && state
                    .in_flight
                    .iter()
                    .any(|in_flight| in_flight.identity() == identity)
        });
        if !current {
            return Ok(());
        }
        arm_emitter_call(inner, &identity)?;
        let result = emitter(&event, envelope);
        disarm_emitter_call(inner)?;
        match result {
            Ok(()) => return Ok(()),
            Err(error) if attempt == TERMINAL_OUTPUT_ENVELOPE_EMIT_MAX_ATTEMPTS => {
                tracing::error!(
                    terminal_id = %inner.terminal_id,
                    generation = inner.generation,
                    envelope_id = envelope.envelope_id,
                    attempts = attempt,
                    %error,
                    "terminal output v3 exact emit retries exhausted"
                );
                // Event delivery is only a notification edge. The immutable
                // in-flight envelope remains authoritative and the frontend's
                // exact-repair pull can still acquire it before the receipt
                // deadline. Closing here would discard that repair window and
                // contradict the lossless v3 contract.
                return Ok(());
            }
            Err(error) => {
                tracing::warn!(
                    terminal_id = %inner.terminal_id,
                    generation = inner.generation,
                    envelope_id = envelope.envelope_id,
                    attempt,
                    %error,
                    "retrying the same terminal output v3 envelope"
                );
                let state = inner.state.lock().map_err(|poisoned| {
                    TerminalOutputDeliveryCloseReason::ContractViolation(poisoned.to_string())
                })?;
                if state.closed
                    || !state
                        .in_flight
                        .iter()
                        .any(|in_flight| in_flight.identity() == identity)
                {
                    return Ok(());
                }
                let (state, _) = inner
                    .changed
                    .wait_timeout(
                        state,
                        Duration::from_millis(TERMINAL_OUTPUT_ENVELOPE_EMIT_RETRY_MS),
                    )
                    .map_err(|poisoned| {
                        TerminalOutputDeliveryCloseReason::ContractViolation(poisoned.to_string())
                    })?;
                if state
                    .in_flight
                    .iter()
                    .any(|in_flight| Instant::now() >= in_flight.expires_at)
                {
                    return Err(TerminalOutputDeliveryCloseReason::ReceiptExpired);
                }
            }
        }
    }
    Ok(())
}

fn arm_emitter_call(
    inner: &DeliveryInner,
    identity: &TerminalOutputEnvelopeIdentity,
) -> Result<(), TerminalOutputDeliveryCloseReason> {
    let mut state = inner.state.lock().map_err(|poisoned| {
        TerminalOutputDeliveryCloseReason::ContractViolation(poisoned.to_string())
    })?;
    if state.closed
        || !state
            .in_flight
            .iter()
            .any(|in_flight| in_flight.identity() == *identity)
    {
        return Ok(());
    }
    state.emitter_call_expires_at = Some(Instant::now() + inner.receipt_timeout);
    inner.changed.notify_all();
    Ok(())
}

fn disarm_emitter_call(inner: &DeliveryInner) -> Result<(), TerminalOutputDeliveryCloseReason> {
    let mut state = inner.state.lock().map_err(|poisoned| {
        TerminalOutputDeliveryCloseReason::ContractViolation(poisoned.to_string())
    })?;
    state.emitter_call_expires_at = None;
    inner.changed.notify_all();
    Ok(())
}

fn next_envelope(
    inner: &DeliveryInner,
) -> Result<Option<TerminalOutputDeltaEnvelopeV3>, TerminalOutputDeliveryCloseReason> {
    let mut state = inner
        .state
        .lock_or_err()
        .map_err(|error| TerminalOutputDeliveryCloseReason::ContractViolation(error.to_string()))?;
    loop {
        if state.closed {
            return Ok(None);
        }
        let now = Instant::now();
        if state
            .lease
            .as_ref()
            .and_then(|lease| lease.grant_expires_at)
            .is_some_and(|deadline| now >= deadline)
        {
            return Err(TerminalOutputDeliveryCloseReason::ContinuationExpired);
        }
        if state
            .in_flight
            .iter()
            .any(|in_flight| now >= in_flight.expires_at)
        {
            return Err(TerminalOutputDeliveryCloseReason::ReceiptExpired);
        }
        let wake_deadline = earliest_deadline(&state);
        let Some(first) = state.pending.front() else {
            state = wait(inner, state, wake_deadline)?;
            continue;
        };
        if state.lease.is_none() || state.in_flight.len() >= TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT
        {
            state = wait(inner, state, wake_deadline)?;
            continue;
        }
        let first_at = first.1;
        let last_at = state.pending.back().map_or(first_at, |delta| delta.1);
        let full = state.pending.len() >= TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS
            || state.pending_bytes >= TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES;
        let batch_deadline = (last_at + Duration::from_millis(TERMINAL_OUTPUT_ENVELOPE_QUIET_MS))
            .min(first_at + Duration::from_millis(TERMINAL_OUTPUT_ENVELOPE_MAX_DELAY_MS));
        if !full && now < batch_deadline {
            state = wait(
                inner,
                state,
                Some(min_deadline(wake_deadline, batch_deadline)),
            )?;
            continue;
        }
        break;
    }
    let envelope = build_next(inner.generation, inner.receipt_timeout, &mut state)
        .map_err(TerminalOutputDeliveryCloseReason::ContractViolation)?;
    inner.changed.notify_all();
    Ok(Some(envelope))
}

fn earliest_deadline(state: &DeliveryState) -> Option<Instant> {
    [
        state.in_flight.iter().map(|item| item.expires_at).min(),
        state
            .lease
            .as_ref()
            .and_then(|lease| lease.grant_expires_at),
        state.emitter_call_expires_at,
    ]
    .into_iter()
    .flatten()
    .min()
}

fn min_deadline(current: Option<Instant>, next: Instant) -> Instant {
    current.map_or(next, |current| current.min(next))
}

fn wait<'a>(
    inner: &DeliveryInner,
    state: std::sync::MutexGuard<'a, DeliveryState>,
    deadline: Option<Instant>,
) -> Result<std::sync::MutexGuard<'a, DeliveryState>, TerminalOutputDeliveryCloseReason> {
    if let Some(deadline) = deadline {
        let (state, _) = inner
            .changed
            .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| {
                TerminalOutputDeliveryCloseReason::ContractViolation(error.to_string())
            })?;
        Ok(state)
    } else {
        inner.changed.wait(state).map_err(|error| {
            TerminalOutputDeliveryCloseReason::ContractViolation(error.to_string())
        })
    }
}

fn build_next(
    generation: u64,
    receipt_timeout: Duration,
    state: &mut DeliveryState,
) -> Result<TerminalOutputDeltaEnvelopeV3, String> {
    let lease = state
        .lease
        .clone()
        .ok_or_else(|| "terminal output lease disappeared before envelope build".to_string())?;
    let first_geometry = state
        .pending
        .front()
        .ok_or_else(|| "terminal output pending queue emptied before envelope build".to_string())?
        .0
        .geometry;
    let mut deltas = Vec::new();
    let mut bytes = 0usize;
    while deltas.len() < TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS {
        let Some(front) = state.pending.front() else {
            break;
        };
        if front.0.geometry != first_geometry
            || bytes.saturating_add(front.0.data.len()) > TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES
        {
            break;
        }
        let queued = state
            .pending
            .pop_front()
            .ok_or_else(|| "terminal output pending queue changed during build".to_string())?;
        bytes += queued.0.data.len();
        state.pending_bytes -= queued.0.data.len();
        deltas.push(queued.0);
    }
    let envelope_id = state
        .next_envelope_id
        .checked_add(1)
        .ok_or_else(|| "terminal output envelope id overflow".to_string())?;
    let envelope = build_envelope(generation, envelope_id, &lease, &deltas)?;
    let wire_bytes = serde_json::to_vec(&envelope)
        .map_err(|error| format!("failed to serialize terminal output envelope: {error}"))?
        .len();
    if wire_bytes >= TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES {
        return Err(format!(
            "terminal output envelope wire size {wire_bytes} exceeds compact limit"
        ));
    }
    state.next_envelope_id = envelope_id;
    state.in_flight.push_back(InFlightEnvelope {
        envelope: envelope.clone(),
        expires_at: Instant::now() + receipt_timeout,
        repair_attempts: 0,
    });
    state.pending_bytes = state.pending.iter().map(|item| item.0.data.len()).sum();
    Ok(envelope)
}

pub(super) fn publish_close(inner: &DeliveryInner, reason: TerminalOutputDeliveryCloseReason) {
    let hook = {
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.closed {
            return;
        }
        state.closed = true;
        state.close_reason = Some(reason.clone());
        state.pending.clear();
        state.pending_bytes = 0;
        state.in_flight.clear();
        state.emitter_call_expires_at = None;
        inner.changed.notify_all();
        state.close_hook.clone()
    };
    if let Some(hook) = hook {
        let _ = catch_unwind(AssertUnwindSafe(|| hook(reason)));
    }
}

pub(super) fn publish_worker_shutdown_timeout(inner: &DeliveryInner) {
    let hook = inner
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .close_hook
        .clone();
    if let Some(hook) = hook {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            hook(TerminalOutputDeliveryCloseReason::WorkerShutdownTimedOut)
        }));
    }
}
