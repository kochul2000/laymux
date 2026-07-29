use super::delivery::{DeliveryState, DesktopOutputDelivery};
use super::delivery_contract::*;
use super::delivery_worker::publish_close;
use crate::constants::TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES;

pub(super) fn validate_delta_range(
    seq_start: u64,
    seq_end: u64,
    byte_len: usize,
) -> Result<(), String> {
    if byte_len == 0
        || byte_len > TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES
        || seq_end.saturating_sub(seq_start) != byte_len as u64
    {
        return Err("invalid terminal output delivery delta".into());
    }
    Ok(())
}

pub(super) fn current_lease(
    state: &DeliveryState,
    generation: u64,
    identity: &TerminalOutputEnvelopeIdentity,
) -> bool {
    identity.generation == generation
        && state.lease.as_ref().map(|lease| lease.token.as_str())
            == Some(identity.lease_token.as_str())
}

pub(super) fn ensure_same_envelope_or_stale(
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

pub(super) fn repair_response(
    status: TerminalOutputEnvelopeRepairStatus,
    envelope: Option<TerminalOutputDeltaEnvelopeV3>,
) -> TerminalOutputEnvelopeRepairResponse {
    TerminalOutputEnvelopeRepairResponse { status, envelope }
}

impl Drop for DesktopOutputDelivery {
    fn drop(&mut self) {
        publish_close(&self.inner, TerminalOutputDeliveryCloseReason::Retired);
        if let Err(error) = self.join() {
            tracing::error!(
                terminal_id = %self.inner.terminal_id,
                generation = self.inner.generation,
                %error,
                "terminal output delivery worker did not terminate during drop"
            );
        }
    }
}
