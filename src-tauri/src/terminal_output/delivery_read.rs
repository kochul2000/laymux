use super::*;

impl DesktopOutputDelivery {
    /// Read an announced envelope without consuming repair budget or extending
    /// its lifetime. Receipt/retirement may make the hint stale.
    pub fn read_announced_envelope(
        &self,
        identity: &TerminalOutputEnvelopeIdentity,
        seq_start: u64,
        seq_end: u64,
    ) -> Result<Option<TerminalOutputDeltaEnvelopeV3>, String> {
        let state = self.inner.state.lock_or_err()?;
        if state.closed || !current_lease(&state, self.inner.generation, identity) {
            return Ok(None);
        }
        Ok(state
            .in_flight
            .as_ref()
            .filter(|entry| {
                entry.identity() == *identity
                    && entry.envelope.seq_start == seq_start
                    && entry.envelope.seq_end == seq_end
            })
            .map(|entry| entry.envelope.clone()))
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
}
