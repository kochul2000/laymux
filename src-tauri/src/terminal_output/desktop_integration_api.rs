use super::*;

pub fn acknowledge_desktop_terminal_output_envelope(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    identity: &TerminalOutputEnvelopeIdentity,
    seq_end: u64,
) -> Result<bool, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .acknowledge_desktop_envelope(identity, seq_end)
}

pub fn repair_desktop_terminal_output_envelope(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    identity: &TerminalOutputEnvelopeIdentity,
    seq_start: u64,
) -> Result<TerminalOutputEnvelopeRepairResponse, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .repair_desktop_envelope(identity, seq_start)
}

pub fn fail_stop_desktop_terminal_output_surface(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    generation: u64,
    token: &str,
    reason: &str,
) -> Result<bool, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .fail_stop_desktop_surface(generation, token, reason)
}

pub fn hold_desktop_terminal_output_continuation(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    generation: u64,
    token: &str,
    envelope_id: u64,
    grant_id: &str,
    frame_start_seq: u64,
) -> Result<bool, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .hold_desktop_continuation(generation, token, envelope_id, grant_id, frame_start_seq)
}

#[allow(clippy::too_many_arguments)]
pub fn close_desktop_terminal_output_continuation(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    generation: u64,
    token: &str,
    envelope_id: u64,
    grant_id: &str,
    close_seq: u64,
    reason: &str,
) -> Result<bool, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .close_desktop_continuation(generation, token, envelope_id, grant_id, close_seq, reason)
}

pub fn terminal_output_diagnostics(
    protocol_states: &SharedTerminalProtocolStates,
) -> Result<Vec<TerminalOutputDesktopDiagnostics>, String> {
    let sessions: Vec<_> = protocol_states
        .sessions
        .lock_or_err()?
        .active
        .values()
        .cloned()
        .collect();
    let mut diagnostics = Vec::with_capacity(sessions.len());
    for session in sessions {
        diagnostics.push(
            session
                .desktop_output_diagnostics()
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        terminal_id = %session.terminal_id,
                        generation = session.generation,
                        %error,
                        "isolated terminal output diagnostics failure"
                    );
                    TerminalOutputDesktopDiagnostics {
                        terminal_id: session.terminal_id.clone(),
                        generation: session.generation,
                        desktop_output_state: "failStopped".into(),
                        reason: Some("surface_unavailable".into()),
                        reason_detail: Some(error.clone()),
                        lease_token: None,
                        parsed_ack: None,
                        write_seq: 0,
                        ring_start_seq: 0,
                        ring_end_seq: 0,
                        delivery_observed_seq: 0,
                        pending_delivery_bytes: 0,
                        active_grant_id: None,
                        receipt_slot: None,
                    }
                }),
        );
    }
    diagnostics.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
    Ok(diagnostics)
}
