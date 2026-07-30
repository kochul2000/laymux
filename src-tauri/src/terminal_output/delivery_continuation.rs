use std::time::Instant;

use super::delivery::{DeliveryState, DesktopOutputDelivery};
use super::delivery_contract::*;
use crate::lock_ext::MutexExt;

impl DesktopOutputDelivery {
    pub fn open_continuation(
        &self,
        opener: &TerminalOutputEnvelopeIdentity,
        grant_id: &str,
        frame_start_seq: u64,
    ) -> Result<TerminalOutputControlCompletion, String> {
        if grant_id.is_empty() || opener.grant_id.is_some() {
            return Err("invalid terminal output continuation opener identity".into());
        }
        let record = HoldRecord {
            opener: opener.clone(),
            grant_id: grant_id.into(),
            frame_start_seq,
        };
        let mut state = self.inner.state.lock_or_err()?;
        if !current_lease(&state, self.inner.generation, opener) {
            return Ok(TerminalOutputControlCompletion::Stale);
        }
        if let Some(last) = state.last_hold.as_ref() {
            if last.opener == *opener {
                return if *last == record {
                    Ok(TerminalOutputControlCompletion::Duplicate)
                } else {
                    Err(format!(
                        "terminal output hold identity was reused with different payload \
                         (previous: grant={} frameStart={}; incoming: grant={} frameStart={}; \
                         opener={:?})",
                        last.grant_id,
                        last.frame_start_seq,
                        record.grant_id,
                        record.frame_start_seq,
                        opener
                    ))
                };
            }
        }
        let boundary = state
            .in_flight
            .iter()
            .find(|in_flight| in_flight.identity() == *opener)
            .map(|in_flight| (in_flight.envelope.seq_start, in_flight.envelope.seq_end))
            .or_else(|| {
                state
                    .recent_receipts
                    .iter()
                    .find(|receipt| receipt.identity == *opener)
                    .map(|receipt| (receipt.seq_start, receipt.seq_end))
            });
        let Some((seq_start, seq_end)) = boundary else {
            if let Some(in_flight) = state.in_flight.iter().find(|in_flight| {
                let candidate = in_flight.identity();
                candidate.generation == opener.generation
                    && candidate.lease_token == opener.lease_token
                    && candidate.envelope_id == opener.envelope_id
            }) {
                ensure_same_envelope_or_stale(&in_flight.identity(), opener)?;
            }
            return Ok(TerminalOutputControlCompletion::Stale);
        };
        if frame_start_seq < seq_start || frame_start_seq >= seq_end {
            return Err("continuation opener is outside its envelope sequence range".into());
        }
        let lease = state
            .lease
            .as_mut()
            .ok_or_else(|| "terminal output lease disappeared before hold".to_string())?;
        if lease.grant_id.is_some() {
            return Err("a different terminal output continuation is already active".into());
        }
        lease.grant_id = Some(grant_id.into());
        lease.grant_expires_at = Some(Instant::now() + self.inner.continuation_timeout);
        state.last_hold = Some(record);
        self.inner.changed.notify_all();
        Ok(TerminalOutputControlCompletion::Accepted)
    }

    pub fn close_continuation(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        close_seq: u64,
        reason: &str,
    ) -> Result<TerminalOutputContinuationCompletion, String> {
        if identity.grant_id.as_deref().is_none_or(str::is_empty) || !is_valid_close_reason(reason)
        {
            return Err("invalid terminal output continuation close identity".into());
        }
        let mut state = self.inner.state.lock_or_err()?;
        if !current_lease(&state, self.inner.generation, identity) {
            return Ok(continuation(
                TerminalOutputControlCompletion::Stale,
                None,
                None,
            ));
        }
        if let Some(last) = state.last_close.as_ref() {
            if last.identity == *identity {
                return if last.close_seq == close_seq && last.reason == reason {
                    Ok(continuation(
                        TerminalOutputControlCompletion::Duplicate,
                        Some(last.opener_envelope_id),
                        Some(last.frame_start_seq),
                    ))
                } else {
                    Err("terminal output close identity was reused with different payload".into())
                };
            }
        }
        let in_flight_boundary = state.in_flight.iter().find_map(|in_flight| {
            continuation_close_matches(&in_flight.identity(), identity)
                .then_some((in_flight.envelope.seq_start, in_flight.envelope.seq_end))
        });
        let receipt_boundary = state
            .recent_receipts
            .iter()
            .find(|receipt| continuation_close_matches(&receipt.identity, identity))
            .map(|receipt| receipt.seq_end);
        match (in_flight_boundary, receipt_boundary) {
            (Some((seq_start, seq_end)), _) if close_seq >= seq_start && close_seq <= seq_end => {}
            (None, Some(seq_end)) if close_seq == seq_end => {}
            (Some(_), _) | (None, Some(_)) => {
                return Err("continuation close is outside its envelope sequence range".into());
            }
            (None, None) => {
                if let Some(in_flight) = state
                    .in_flight
                    .iter()
                    .find(|in_flight| in_flight.envelope.envelope_id == identity.envelope_id)
                {
                    ensure_same_envelope_or_stale(&in_flight.identity(), identity)?;
                } else if let Some(receipt) = state
                    .recent_receipts
                    .iter()
                    .find(|receipt| receipt.identity.envelope_id == identity.envelope_id)
                {
                    ensure_same_envelope_or_stale(&receipt.identity, identity)?;
                }
                return Ok(continuation(
                    TerminalOutputControlCompletion::Stale,
                    None,
                    None,
                ));
            }
        }
        let grant_id = identity.grant_id.as_deref();
        let hold = state
            .last_hold
            .as_ref()
            .filter(|hold| Some(hold.grant_id.as_str()) == grant_id)
            .ok_or_else(|| "terminal output active grant has no opener record".to_string())?;
        let frame_start_seq = hold.frame_start_seq;
        let opener_envelope_id = hold.opener.envelope_id;
        let lease = state
            .lease
            .as_mut()
            .ok_or_else(|| "terminal output lease disappeared before close".to_string())?;
        if lease.grant_id.as_deref() != grant_id {
            return Err("terminal output close does not own the active grant".into());
        }
        lease.grant_id = None;
        lease.grant_expires_at = None;
        state.last_close = Some(CloseRecord {
            identity: identity.clone(),
            opener_envelope_id,
            close_seq,
            reason: reason.into(),
            frame_start_seq,
        });
        self.inner.changed.notify_all();
        Ok(continuation(
            TerminalOutputControlCompletion::Accepted,
            Some(opener_envelope_id),
            Some(frame_start_seq),
        ))
    }
}

fn is_valid_close_reason(reason: &str) -> bool {
    matches!(
        reason,
        "close" | "abort:malformed" | "abort:timeout" | "abort:oversized"
    )
}

fn continuation_close_matches(
    in_flight: &TerminalOutputEnvelopeIdentity,
    close: &TerminalOutputEnvelopeIdentity,
) -> bool {
    in_flight.generation == close.generation
        && in_flight.lease_token == close.lease_token
        && in_flight.envelope_id == close.envelope_id
        && (in_flight.grant_id == close.grant_id
            || (in_flight.grant_id.is_none() && close.grant_id.is_some()))
}

fn current_lease(
    state: &DeliveryState,
    generation: u64,
    identity: &TerminalOutputEnvelopeIdentity,
) -> bool {
    identity.generation == generation
        && state.lease.as_ref().map(|lease| lease.token.as_str())
            == Some(identity.lease_token.as_str())
}

fn ensure_same_envelope_or_stale(
    expected: &TerminalOutputEnvelopeIdentity,
    actual: &TerminalOutputEnvelopeIdentity,
) -> Result<(), String> {
    if expected.generation == actual.generation
        && expected.lease_token == actual.lease_token
        && expected.envelope_id == actual.envelope_id
        && expected.grant_id != actual.grant_id
    {
        return Err("terminal output envelope identity changed its continuation grant".into());
    }
    Ok(())
}

fn continuation(
    completion: TerminalOutputControlCompletion,
    opener_envelope_id: Option<u64>,
    frame_start_seq: Option<u64>,
) -> TerminalOutputContinuationCompletion {
    TerminalOutputContinuationCompletion {
        completion,
        opener_envelope_id,
        frame_start_seq,
    }
}
