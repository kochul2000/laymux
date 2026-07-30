use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Instant;

use super::delivery::{DeliveryInner, DeliveryState};
use super::delivery_contract::TerminalOutputDeliveryCloseReason;
use super::delivery_worker::{publish_close, WorkerThread};

pub(super) fn spawn_deadline_worker(inner: Arc<DeliveryInner>) -> Result<WorkerThread, String> {
    let name = format!(
        "terminal-output-deadline-{}-{}",
        inner.terminal_id, inner.generation
    );
    let (completed_tx, completed) = mpsc::channel();
    let handle = thread::Builder::new()
        .name(name)
        .spawn(move || {
            if catch_unwind(AssertUnwindSafe(|| run(Arc::clone(&inner)))).is_err() {
                publish_close(&inner, TerminalOutputDeliveryCloseReason::WorkerPanicked);
            }
            let _ = completed_tx.send(());
        })
        .map_err(|error| format!("failed to start terminal output deadline owner: {error}"))?;
    Ok(WorkerThread::new(handle, completed))
}

fn run(inner: Arc<DeliveryInner>) {
    let mut state = match inner.state.lock() {
        Ok(state) => state,
        Err(error) => {
            let detail = error.to_string();
            drop(error.into_inner());
            publish_close(
                &inner,
                TerminalOutputDeliveryCloseReason::ContractViolation(detail),
            );
            return;
        }
    };
    loop {
        if state.closed {
            return;
        }
        let now = Instant::now();
        if let Some(reason) = expired_reason(&state, now) {
            drop(state);
            publish_close(&inner, reason);
            return;
        }
        state = if let Some(deadline) = earliest_deadline(&state) {
            match inner
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
            {
                Ok((state, _)) => state,
                Err(error) => {
                    let detail = error.to_string();
                    drop(error.into_inner().0);
                    publish_close(
                        &inner,
                        TerminalOutputDeliveryCloseReason::ContractViolation(detail),
                    );
                    return;
                }
            }
        } else {
            match inner.changed.wait(state) {
                Ok(state) => state,
                Err(error) => {
                    let detail = error.to_string();
                    drop(error.into_inner());
                    publish_close(
                        &inner,
                        TerminalOutputDeliveryCloseReason::ContractViolation(detail),
                    );
                    return;
                }
            }
        };
    }
}

fn expired_reason(
    state: &DeliveryState,
    now: Instant,
) -> Option<TerminalOutputDeliveryCloseReason> {
    let receipt = state.in_flight.iter().map(|item| item.expires_at).min();
    let continuation = state
        .lease
        .as_ref()
        .and_then(|lease| lease.grant_expires_at);
    let emitter = state.emitter_call_expires_at;
    let earliest = earliest_deadline(state)?;
    if now < earliest {
        return None;
    }
    if emitter == Some(earliest) {
        return Some(TerminalOutputDeliveryCloseReason::EmitFailed(
            "synchronous emitter call timed out".into(),
        ));
    }
    if receipt == Some(earliest) {
        return Some(TerminalOutputDeliveryCloseReason::ReceiptExpired);
    }
    if continuation == Some(earliest) {
        return Some(TerminalOutputDeliveryCloseReason::ContinuationExpired);
    }
    None
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
