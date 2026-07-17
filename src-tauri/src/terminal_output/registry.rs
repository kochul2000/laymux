use super::*;

/// Rollback guard for the create path. Until committed, every error (including
/// PTY spawn failure) conditionally retires only this generation and removes
/// its compatibility projections.
pub struct TerminalOutputRegistration {
    protocol_states: SharedTerminalProtocolStates,
    output_buffers: Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: String,
    session: Arc<TerminalOutputSession>,
    committed: bool,
}

impl TerminalOutputRegistration {
    pub fn session(&self) -> Arc<TerminalOutputSession> {
        Arc::clone(&self.session)
    }

    pub fn commit(mut self) -> Result<Arc<TerminalOutputSession>, String> {
        self.session.commit_creation()?;
        self.committed = true;
        Ok(Arc::clone(&self.session))
    }
}

impl Drop for TerminalOutputRegistration {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Err(error) = retire_terminal_output_session_impl(
            &self.protocol_states,
            &self.output_buffers,
            &self.terminal_id,
            &self.session,
            true,
        ) {
            tracing::warn!(
                terminal_id = %self.terminal_id,
                generation = self.session.generation(),
                %error,
                "failed to roll back terminal output registration"
            );
        }
    }
}

pub fn new_protocol_gate() -> TerminalProtocolGate {
    Arc::new(Mutex::new(TerminalProtocolState::new()))
}

/// Atomically reserve a terminal id and install one canonical output session.
/// The returned guard must be committed only after the PTY/session tables are
/// fully installed; otherwise Drop performs generation-conditional rollback.
pub fn register_terminal_output_session(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
) -> Result<TerminalOutputRegistration, String> {
    let mut registry = protocol_states.sessions.lock_or_err()?;
    if registry.active.contains_key(terminal_id) {
        return Err(format!("Session '{terminal_id}' already exists"));
    }

    let mut gates = protocol_states.lock_or_err()?;
    let mut buffers = output_buffers.lock_or_err()?;
    if gates.contains_key(terminal_id) || buffers.contains_key(terminal_id) {
        return Err(format!("Session '{terminal_id}' already exists"));
    }

    registry.next_generation = registry.next_generation.wrapping_add(1).max(1);
    let generation = registry.next_generation;
    let output = TerminalOutputBuffer::default();
    let session = Arc::new(TerminalOutputSession::new(
        terminal_id.to_string(),
        generation,
        output.clone(),
    ));
    gates.insert(terminal_id.to_string(), session.protocol_gate());
    buffers.insert(terminal_id.to_string(), output);
    registry
        .active
        .insert(terminal_id.to_string(), Arc::clone(&session));

    Ok(TerminalOutputRegistration {
        protocol_states: protocol_states.clone(),
        output_buffers: Arc::clone(output_buffers),
        terminal_id: terminal_id.to_string(),
        session,
        committed: false,
    })
}

pub fn terminal_output_session_for(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
) -> Result<Option<Arc<TerminalOutputSession>>, String> {
    Ok(protocol_states
        .sessions
        .lock_or_err()?
        .active
        .get(terminal_id)
        .cloned())
}

/// Retire and remove only `expected`, never a newer generation that reused the
/// same terminal id.
pub fn retire_terminal_output_session(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
) -> Result<bool, String> {
    retire_terminal_output_session_impl(
        protocol_states,
        output_buffers,
        terminal_id,
        expected,
        false,
    )
}

fn retire_terminal_output_session_impl(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
    allow_creating: bool,
) -> Result<bool, String> {
    let mut registry = protocol_states.sessions.lock_or_err()?;
    let Some(current) = registry.active.get(terminal_id).cloned() else {
        return Ok(false);
    };
    if !Arc::ptr_eq(&current, expected) {
        return Ok(false);
    }

    current.retire(allow_creating)?;
    remove_compatibility_projections(protocol_states, output_buffers, terminal_id, Some(&current))?;
    registry.active.remove(terminal_id);
    Ok(true)
}

/// Close-path transaction. The registry remains locked from current-generation
/// selection through retirement and compatibility-index cleanup, so a create
/// reservation cannot appear between a `None` lookup and legacy cleanup.
pub fn retire_terminal_output_for_close(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
) -> Result<bool, String> {
    let mut registry = protocol_states.sessions.lock_or_err()?;
    let current = registry.active.get(terminal_id).cloned();
    if let Some(current) = current {
        current.retire(false)?;
        remove_compatibility_projections(
            protocol_states,
            output_buffers,
            terminal_id,
            Some(&current),
        )?;
        registry.active.remove(terminal_id);
        return Ok(true);
    }

    remove_compatibility_projections(protocol_states, output_buffers, terminal_id, None)?;
    Ok(false)
}

fn remove_compatibility_projections(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: Option<&Arc<TerminalOutputSession>>,
) -> Result<(), String> {
    let mut gates = protocol_states.lock_or_err()?;
    let remove_gate = expected.is_none_or(|session| {
        gates
            .get(terminal_id)
            .is_some_and(|gate| Arc::ptr_eq(gate, &session.protocol))
    });
    if remove_gate {
        gates.remove(terminal_id);
    }
    drop(gates);

    let mut buffers = output_buffers.lock_or_err()?;
    let remove_buffer = expected.is_none_or(|session| {
        buffers
            .get(terminal_id)
            .is_some_and(|buffer| buffer.same_storage(&session.output))
    });
    if remove_buffer {
        buffers.remove(terminal_id);
    }
    Ok(())
}

/// Cleanup fallback for sessions created by older/tests-only code that only
/// populated the compatibility maps.
pub fn remove_legacy_terminal_output(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
) -> Result<(), String> {
    remove_compatibility_projections(protocol_states, output_buffers, terminal_id, None)
}

pub fn protocol_gate_for(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
) -> Result<TerminalProtocolGate, String> {
    protocol_states
        .lock_or_err()?
        .get(terminal_id)
        .cloned()
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))
}

/// Legacy compatibility path. Production PTY callbacks use the captured
/// `TerminalOutputSession::record_output` so a stale generation cannot resolve
/// a replacement ring by terminal id.
pub fn record_terminal_output(
    protocol_gate: &TerminalProtocolGate,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    data: &[u8],
) -> Result<TerminalOutputDelta, String> {
    let mut protocol = protocol_gate.lock_or_err()?;
    protocol.process_output(data);
    let buffers = output_buffers.lock_or_err()?;
    let buffer = buffers
        .get(terminal_id)
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?;
    let written = buffer.push_sequenced(data);
    Ok(TerminalOutputDelta {
        seq_start: written.seq_start,
        seq_end: written.seq_end,
        data: written.data,
    })
}

/// Capture protocol modes and snapshot bytes from the same generation/prefix.
pub fn attach_terminal_output(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    max_snapshot_bytes: usize,
) -> Result<TerminalOutputAttachment, String> {
    if let Some(session) = terminal_output_session_for(protocol_states, terminal_id)? {
        return session.attach(max_snapshot_bytes);
    }

    // Legacy/test fallback for manually populated compatibility maps.
    let protocol_gate = protocol_gate_for(protocol_states, terminal_id)?;
    let protocol = protocol_gate.lock_or_err()?;
    let protocol_snapshot = protocol.snapshot();
    let buffers = output_buffers.lock_or_err()?;
    let buffer = buffers
        .get(terminal_id)
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?;
    let snapshot = buffer.snapshot(max_snapshot_bytes);
    Ok(attachment_from_snapshot(protocol_snapshot, snapshot))
}

/// Atomically capture attach state/snapshot and register a bounded subscriber.
pub fn attach_and_subscribe_terminal_output(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    max_snapshot_bytes: usize,
) -> Result<TerminalOutputSubscribedAttachment, String> {
    attach_and_subscribe_terminal_output_with_capacity(
        protocol_states,
        terminal_id,
        max_snapshot_bytes,
        TERMINAL_OUTPUT_SUBSCRIBER_CAPACITY,
    )
}

pub fn attach_and_subscribe_terminal_output_with_capacity(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    max_snapshot_bytes: usize,
    queue_capacity: usize,
) -> Result<TerminalOutputSubscribedAttachment, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .attach_and_subscribe(max_snapshot_bytes, queue_capacity)
}

pub(super) fn attachment_from_snapshot(
    protocol: TerminalProtocolSnapshot,
    snapshot: TerminalOutputSlice,
) -> TerminalOutputAttachment {
    TerminalOutputAttachment {
        state: TerminalAttachState {
            version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
            snapshot_start_seq: snapshot.seq_start,
            snapshot_seq: snapshot.seq_end,
            protocol_revision: protocol.revision,
            modes: TerminalAttachModes {
                bracketed_paste: protocol.bracketed_paste,
            },
        },
        snapshot: snapshot.data,
    }
}
