use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};

use tokio::sync::mpsc;

use super::desktop_flow::{
    ContinuationCloseReason, ContinuationCompletion, ContinuationRequest,
    DesktopOutputFailureReason, DesktopOutputState,
};
use super::*;

impl TerminalOutputSession {
    pub fn start_desktop_output_delivery(
        self: &Arc<Self>,
        emitter: Arc<TerminalOutputEnvelopeEmitter>,
    ) -> Result<(), String> {
        self.start_desktop_output_delivery_with_notifier(emitter, Arc::new(|_| {}))
    }

    pub fn start_desktop_output_delivery_with_notifier(
        self: &Arc<Self>,
        emitter: Arc<TerminalOutputEnvelopeEmitter>,
        notifier: Arc<TerminalOutputFailStopNotifier>,
    ) -> Result<(), String> {
        let weak: Weak<Self> = Arc::downgrade(self);
        self.desktop_delivery.start(
            emitter,
            Arc::new(move |reason| {
                if let Some(session) = weak.upgrade() {
                    if let Some(notice) = session.on_delivery_closed(reason) {
                        notifier(&notice);
                    }
                }
            }),
        )
    }

    pub(super) fn on_delivery_closed(
        &self,
        reason: TerminalOutputDeliveryCloseReason,
    ) -> Option<TerminalOutputFailStopNotice> {
        if reason != TerminalOutputDeliveryCloseReason::Retired {
            let mut failure = self
                .delivery_failure
                .lock_or_recover_for_discard("recording terminal output delivery failure");
            if failure.is_none() {
                *failure = Some(reason.clone());
            }
        }
        // Wake a PTY producer waiting on parsed credit. A lost continuation
        // close preserves a typed flow failure; other delivery failures retire
        // only this desktop transport. The terminal/catalog remains for
        // explicit user close/recreate and diagnostic inspection.
        if reason == TerminalOutputDeliveryCloseReason::ContinuationExpired
            && self
                .desktop_flow
                .fail_stop_expired_continuation()
                .unwrap_or(false)
        {
            return self.take_fail_stop_notice(&reason);
        }
        self.desktop_flow.retire();
        self.take_fail_stop_notice(&reason)
    }

    fn take_fail_stop_notice(
        &self,
        reason: &TerminalOutputDeliveryCloseReason,
    ) -> Option<TerminalOutputFailStopNotice> {
        if *reason == TerminalOutputDeliveryCloseReason::Retired
            || self
                .fail_stop_notice_sent
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        Some(self.fail_stop_notice(reason))
    }

    fn fail_stop_notice(
        &self,
        reason: &TerminalOutputDeliveryCloseReason,
    ) -> TerminalOutputFailStopNotice {
        let lease_token = self
            .desktop_delivery
            .diagnostics()
            .ok()
            .and_then(|diagnostics| diagnostics.lease_token);
        TerminalOutputFailStopNotice {
            terminal_id: self.terminal_id.clone(),
            generation: self.generation,
            lease_token,
            reason: delivery_reason_code(reason),
        }
    }

    pub(super) fn fail_delivery<T>(
        &self,
        reason: TerminalOutputDeliveryCloseReason,
        error: String,
    ) -> Result<T, String> {
        self.desktop_delivery.close(reason);
        Err(error)
    }

    pub(super) fn fail_delivery_contract<T>(&self, error: String) -> Result<T, String> {
        // Close with the detail-carrying variant. `delivery_reason_code` maps it
        // onto the same `identity_conflict` code, so the reported reason is
        // unchanged, but `reason_detail` now names which invariant tripped
        // instead of collapsing all twelve call sites onto one opaque code.
        self.fail_delivery(
            TerminalOutputDeliveryCloseReason::ContractViolation(error.clone()),
            error,
        )
    }

    pub fn delivery_failure(&self) -> Option<TerminalOutputDeliveryCloseReason> {
        self.delivery_failure
            .lock()
            .map(|failure| failure.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    pub fn desktop_output_diagnostics(&self) -> Result<TerminalOutputDesktopDiagnostics, String> {
        let flow = self.desktop_flow.diagnostics()?;
        let delivery = self.desktop_delivery.diagnostics()?;
        let write_seq = self.output.write_seq()?;
        let ring_start_seq = self.output.start_seq()?;
        let delivery_failure = self.delivery_failure();
        let reason = delivery_failure
            .as_ref()
            .map(delivery_reason_code)
            .or_else(|| delivery.close_reason.as_ref().map(delivery_reason_code))
            .or_else(|| flow.reason.map(flow_reason_code));
        // Resolve the detail from the same source that won `reason` above, so the
        // two can never describe different faults.
        let reason_detail = delivery_failure
            .as_ref()
            .and_then(delivery_reason_detail)
            .or_else(|| {
                delivery
                    .close_reason
                    .as_ref()
                    .and_then(delivery_reason_detail)
            })
            .or_else(|| flow.reason.and(flow.reason_detail.clone()));
        let state = if delivery_failure.is_some() || delivery.closed {
            "failStopped"
        } else {
            match flow.state {
                DesktopOutputState::Healthy => "healthy",
                DesktopOutputState::Backpressured => "backpressured",
                DesktopOutputState::FailStopped => "failStopped",
            }
        };
        let receipt_slot = delivery
            .in_flight
            .map(|slot| TerminalOutputReceiptSlotDiagnostics {
                generation: slot.envelope.generation,
                lease_token: slot.envelope.lease_token,
                envelope_id: slot.envelope.envelope_id,
                grant_id: slot.envelope.grant_id,
                seq_start: slot.envelope.seq_start,
                seq_end: slot.envelope.seq_end,
            });
        Ok(TerminalOutputDesktopDiagnostics {
            terminal_id: self.terminal_id.clone(),
            generation: self.generation,
            desktop_output_state: state.into(),
            reason,
            reason_detail,
            lease_token: delivery.lease_token.or(flow.lease_token),
            parsed_ack: flow.parsed_ack.or(Some(delivery.parsed_seq)),
            write_seq,
            ring_start_seq,
            ring_end_seq: write_seq,
            delivery_observed_seq: delivery.observed_seq,
            pending_delivery_bytes: delivery.pending_bytes,
            active_grant_id: delivery.grant_id,
            receipt_slot,
        })
    }

    /// Reserve parsed credit and delivery storage before the exact PTY bytes
    /// enter the protocol/ring prefix, then enqueue the already-owned delta.
    pub fn record_desktop_output(
        &self,
        data: &[u8],
    ) -> Result<Option<TerminalOutputDelta>, TerminalOutputRecordError> {
        if data.is_empty() {
            return Err(TerminalOutputRecordError::authoritative(
                "terminal output PTY delta must not be empty",
            ));
        }
        let _ingress = self
            .desktop_ingress_gate
            .lock_or_err()
            .map_err(|error| TerminalOutputRecordError::authoritative(error.to_string()))?;
        let seq_start = self
            .output
            .write_seq()
            .map_err(TerminalOutputRecordError::authoritative)?;
        let seq_end = seq_start.checked_add(data.len() as u64).ok_or_else(|| {
            TerminalOutputRecordError::authoritative("terminal output sequence overflow")
        })?;

        self.desktop_flow
            .wait_for_read_capacity(seq_start, seq_end)
            .map_err(|error| {
                let reason = if error.contains("ContinuationExpired") {
                    TerminalOutputDeliveryCloseReason::ContinuationExpired
                } else {
                    TerminalOutputDeliveryCloseReason::ParsedProgressExpired
                };
                self.desktop_delivery.close(reason);
                TerminalOutputRecordError::credit(error)
            })?;
        match self
            .desktop_delivery
            .wait_for_admission(seq_start, seq_end, data.len())
            .map_err(TerminalOutputRecordError::transport)?
        {
            TerminalOutputDeliveryAdmission::Closed => {
                return Err(TerminalOutputRecordError::transport(
                    "terminal output v3 delivery is fail-stopped",
                ))
            }
            TerminalOutputDeliveryAdmission::Queued
            | TerminalOutputDeliveryAdmission::CoveredBySnapshot
            | TerminalOutputDeliveryAdmission::BootstrapRingOnly => {}
        }
        let protected_start_seq = self
            .desktop_flow
            .diagnostics()
            .map_err(TerminalOutputRecordError::credit)?
            .parsed_ack
            .unwrap_or(
                self.output
                    .start_seq()
                    .map_err(TerminalOutputRecordError::authoritative)?,
            );

        let mut protocol = self
            .protocol
            .lock_or_err()
            .map_err(|error| TerminalOutputRecordError::authoritative(error.to_string()))?;
        let mut runtime = self
            .runtime
            .lock_or_err()
            .map_err(|error| TerminalOutputRecordError::authoritative(error.to_string()))?;
        if runtime.retired {
            return Ok(None);
        }
        if self
            .output
            .write_seq()
            .map_err(TerminalOutputRecordError::authoritative)?
            != seq_start
        {
            return Err(TerminalOutputRecordError::authoritative(
                "terminal output producer sequence changed during admission",
            ));
        }
        let written = self
            .output
            .push_sequenced_protected(data, protected_start_seq)
            .map_err(TerminalOutputRecordError::authoritative)?;
        protocol.process_output(data);
        let delta = TerminalOutputDelta {
            generation: self.generation,
            seq_start: written.seq_start,
            seq_end: written.seq_end,
            data: written.data,
            geometry: runtime.geometry,
        };
        notify_subscribers(self.generation, &self.output, &mut runtime, &delta)
            .map_err(TerminalOutputRecordError::authoritative)?;
        drop(runtime);
        drop(protocol);

        if self
            .desktop_delivery
            .enqueue(delta.clone())
            .map_err(TerminalOutputRecordError::transport)?
            == TerminalOutputDeliveryAdmission::Closed
        {
            return Err(TerminalOutputRecordError::transport(
                "terminal output v3 delivery closed after ring admission",
            ));
        }
        Ok(Some(delta))
    }

    pub fn acknowledge_desktop_envelope(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        seq_end: u64,
    ) -> Result<bool, String> {
        let _control = self.desktop_control_gate.lock_or_err()?;
        match self.desktop_delivery.acknowledge_receipt(identity, seq_end) {
            Ok(TerminalOutputControlCompletion::Accepted) => {
                match self
                    .desktop_flow
                    .note_continuation_receipt(&identity.lease_token)
                {
                    Ok(_) => Ok(true),
                    Err(error) => {
                        let terminal_error =
                            format!("terminal output receipt flow projection failed: {error}");
                        self.desktop_delivery.preserve_receipt_projection_failure(
                            identity,
                            seq_end,
                            &terminal_error,
                        )?;
                        self.fail_delivery_contract(terminal_error)
                    }
                }
            }
            Ok(TerminalOutputControlCompletion::Duplicate) => Ok(true),
            Ok(TerminalOutputControlCompletion::Stale) => Ok(false),
            Err(error) => self.fail_delivery_contract(error),
        }
    }

    pub fn repair_desktop_envelope(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        seq_start: u64,
    ) -> Result<TerminalOutputEnvelopeRepairResponse, String> {
        let _control = self.desktop_control_gate.lock_or_err()?;
        let response = self.desktop_delivery.repair_envelope(identity, seq_start)?;
        if response.status == TerminalOutputEnvelopeRepairStatus::Exhausted {
            self.desktop_delivery
                .close(TerminalOutputDeliveryCloseReason::SurfaceUnavailable);
        }
        Ok(response)
    }

    pub fn hold_desktop_continuation(
        &self,
        generation: u64,
        token: &str,
        envelope_id: u64,
        grant_id: &str,
        frame_start_seq: u64,
    ) -> Result<bool, String> {
        let _control = self.desktop_control_gate.lock_or_err()?;
        let opener = TerminalOutputEnvelopeIdentity {
            generation,
            lease_token: token.into(),
            envelope_id,
            grant_id: None,
        };
        match self
            .desktop_delivery
            .open_continuation(&opener, grant_id, frame_start_seq)
        {
            Ok(TerminalOutputControlCompletion::Stale) => return Ok(false),
            Ok(TerminalOutputControlCompletion::Duplicate)
            | Ok(TerminalOutputControlCompletion::Accepted) => {}
            Err(error) => return self.fail_delivery_contract(error),
        }
        let request = ContinuationRequest {
            envelope_id,
            client_grant_id: grant_id.into(),
            frame_start_seq,
        };
        match self
            .desktop_flow
            .open_continuation(token, &request, self.output.write_seq()?)
        {
            Ok(ContinuationCompletion::Opened { .. })
            | Ok(ContinuationCompletion::Duplicate { .. }) => Ok(true),
            Ok(other) => self.fail_delivery_contract(format!(
                "desktop continuation hold projection diverged: {other:?}"
            )),
            Err(error) => self.fail_delivery_contract(error),
        }
    }

    pub fn close_desktop_continuation(
        &self,
        generation: u64,
        token: &str,
        envelope_id: u64,
        grant_id: &str,
        close_seq: u64,
        reason: &str,
    ) -> Result<bool, String> {
        let close_reason = match parse_close_reason(reason) {
            Ok(reason) => reason,
            Err(error) => return self.fail_delivery_contract(error),
        };
        let _control = self.desktop_control_gate.lock_or_err()?;
        let identity = TerminalOutputEnvelopeIdentity {
            generation,
            lease_token: token.into(),
            envelope_id,
            grant_id: Some(grant_id.into()),
        };
        let completion = match self
            .desktop_delivery
            .close_continuation(&identity, close_seq, reason)
        {
            Ok(completion) => completion,
            Err(error) => return self.fail_delivery_contract(error),
        };
        match completion.completion {
            TerminalOutputControlCompletion::Stale => return Ok(false),
            TerminalOutputControlCompletion::Duplicate
            | TerminalOutputControlCompletion::Accepted => {}
        }
        let opener_envelope_id = completion
            .opener_envelope_id
            .ok_or_else(|| "accepted continuation close lost its opener identity".to_string())?;
        let frame_start_seq = completion
            .frame_start_seq
            .ok_or_else(|| "accepted continuation close lost its frame start".to_string())?;
        let request = ContinuationRequest {
            envelope_id: opener_envelope_id,
            client_grant_id: grant_id.into(),
            frame_start_seq,
        };
        match self.desktop_flow.close_continuation(
            token,
            &request,
            close_seq,
            self.output.write_seq()?,
            close_reason,
        ) {
            Ok(ContinuationCompletion::Closed) => Ok(true),
            Ok(other) => self.fail_delivery_contract(format!(
                "desktop continuation close projection diverged: {other:?}"
            )),
            Err(error) => self.fail_delivery_contract(error),
        }
    }
}

fn notify_subscribers(
    generation: u64,
    output: &TerminalOutputBuffer,
    runtime: &mut TerminalOutputSessionRuntime,
    delta: &TerminalOutputDelta,
) -> Result<(), String> {
    let retained_start_seq = output.start_seq()?;
    let mut remove = Vec::new();
    for (&subscriber_id, subscriber) in &mut runtime.subscribers {
        let terminal = || TerminalOutputSubscriptionTerminal::Gap {
            generation,
            expected_seq: subscriber.next_seq,
            retained_start_seq,
            current_seq: delta.seq_end,
        };
        if subscriber.next_seq != delta.seq_start {
            subscriber.terminal_tx.send_replace(Some(terminal()));
            remove.push(subscriber_id);
            continue;
        }
        match subscriber.delta_tx.try_send(delta.clone()) {
            Ok(()) => subscriber.next_seq = delta.seq_end,
            Err(mpsc::error::TrySendError::Full(_)) => {
                subscriber.terminal_tx.send_replace(Some(terminal()));
                remove.push(subscriber_id);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => remove.push(subscriber_id),
        }
    }
    for subscriber_id in remove {
        runtime.subscribers.remove(&subscriber_id);
    }
    Ok(())
}

fn parse_close_reason(reason: &str) -> Result<ContinuationCloseReason, String> {
    match reason {
        "close" => Ok(ContinuationCloseReason::Terminator),
        "abort:malformed" => Ok(ContinuationCloseReason::Malformed),
        "abort:timeout" => Ok(ContinuationCloseReason::Timeout),
        "abort:oversized" => Ok(ContinuationCloseReason::Oversized),
        _ => Err("invalid terminal output continuation close reason".into()),
    }
}

fn flow_reason_code(reason: DesktopOutputFailureReason) -> String {
    match reason {
        DesktopOutputFailureReason::ContinuationExpired => "continuation_expired",
        DesktopOutputFailureReason::ParsedProgressExpired => "parsed_progress_expired",
        DesktopOutputFailureReason::IdentityConflict => "identity_conflict",
    }
    .into()
}

pub(super) fn delivery_reason_code(reason: &TerminalOutputDeliveryCloseReason) -> String {
    match reason {
        TerminalOutputDeliveryCloseReason::EmitFailed(_) => "emit_failure",
        TerminalOutputDeliveryCloseReason::ReceiptExpired => "receipt_timeout",
        TerminalOutputDeliveryCloseReason::ContinuationExpired => "continuation_expired",
        TerminalOutputDeliveryCloseReason::ParsedProgressExpired => "parsed_progress_expired",
        TerminalOutputDeliveryCloseReason::DesktopSnapshotIncomplete => {
            "desktop_snapshot_incomplete"
        }
        TerminalOutputDeliveryCloseReason::IdentityConflict => "identity_conflict",
        TerminalOutputDeliveryCloseReason::SurfaceUnavailable => "surface_unavailable",
        TerminalOutputDeliveryCloseReason::ControlOrphanCap => "control_orphan_cap",
        TerminalOutputDeliveryCloseReason::ContractViolation(_) => "identity_conflict",
        TerminalOutputDeliveryCloseReason::WorkerPanicked => "surface_unavailable",
        TerminalOutputDeliveryCloseReason::WorkerShutdownTimedOut => "worker_shutdown_timeout",
        TerminalOutputDeliveryCloseReason::Retired => "surface_unavailable",
    }
    .into()
}

/// The message a close reason carried, for the variants that carry one.
///
/// `delivery_reason_code` maps `ContractViolation` onto `identity_conflict` and
/// `EmitFailed` onto `emit_failure`, discarding the only text that says which
/// invariant actually tripped. Diagnostics report it alongside the code.
pub(super) fn delivery_reason_detail(reason: &TerminalOutputDeliveryCloseReason) -> Option<String> {
    match reason {
        TerminalOutputDeliveryCloseReason::ContractViolation(detail)
        | TerminalOutputDeliveryCloseReason::EmitFailed(detail) => Some(detail.clone()),
        _ => None,
    }
}
