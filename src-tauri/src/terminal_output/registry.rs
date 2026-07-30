use super::registry_retirement::retire_terminal_output_session_impl;
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
    register_terminal_output_session_with_geometry(
        protocol_states,
        output_buffers,
        terminal_id,
        TerminalGeometry::default(),
    )
}

pub fn register_terminal_output_session_with_geometry(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    geometry: TerminalGeometry,
) -> Result<TerminalOutputRegistration, String> {
    if geometry.cols == 0 || geometry.rows == 0 {
        return Err("terminal size must be positive".into());
    }
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
        geometry,
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
    let written = buffer.push_sequenced(data)?;
    Ok(TerminalOutputDelta {
        generation: 0,
        seq_start: written.seq_start,
        seq_end: written.seq_end,
        data: written.data,
        geometry: TerminalGeometry::default(),
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
    let snapshot = buffer.snapshot(max_snapshot_bytes)?;
    Ok(attachment_from_snapshot(
        0,
        TerminalGeometry::default(),
        protocol_snapshot,
        snapshot,
    ))
}

/// Capture the desktop snapshot and atomically replace its parsed-credit lease.
pub fn attach_desktop_terminal_output(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    max_snapshot_bytes: usize,
    window_bytes: usize,
) -> Result<DesktopTerminalOutputAttachment, String> {
    match attach_desktop_terminal_output_outcome(
        protocol_states,
        terminal_id,
        max_snapshot_bytes,
        window_bytes,
    )? {
        DesktopTerminalOutputAttachOutcome::Attached(attachment) => Ok(attachment),
        DesktopTerminalOutputAttachOutcome::FailStopped {
            generation, reason, ..
        } => Err(format!(
            "terminal output generation {generation} is fail-stopped: {reason}"
        )),
    }
}

pub fn attach_desktop_terminal_output_outcome(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    max_snapshot_bytes: usize,
    window_bytes: usize,
) -> Result<DesktopTerminalOutputAttachOutcome, String> {
    attach_desktop_terminal_output_outcome_with_hook(
        protocol_states,
        terminal_id,
        max_snapshot_bytes,
        window_bytes,
        || {},
    )
}

pub(super) fn attach_desktop_terminal_output_outcome_with_hook(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    max_snapshot_bytes: usize,
    window_bytes: usize,
    after_outcome: impl FnOnce(),
) -> Result<DesktopTerminalOutputAttachOutcome, String> {
    let session = terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?;
    let outcome = session.attach_desktop_outcome(max_snapshot_bytes, window_bytes)?;
    after_outcome();
    let registry = protocol_states.sessions.lock_or_err()?;
    let current = registry.active.get(terminal_id);
    if current.is_none_or(|current| {
        !Arc::ptr_eq(current, &session) || current.generation() != session.generation()
    }) {
        return Err(format!(
            "terminal output generation changed during desktop attach for '{terminal_id}'"
        ));
    }
    Ok(outcome)
}

pub fn acknowledge_desktop_terminal_output(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    generation: u64,
    token: &str,
    seq: u64,
) -> Result<bool, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .acknowledge_desktop_output(generation, token, seq)
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

/// Serve a surface's sequence-exact gap repair ([ADR-0072]).
///
/// A missing terminal is an error (the surface must stop), while a range the
/// ring can no longer bridge is `Ok(None)` (the surface must reattach).
///
/// [ADR-0072]: ../../../docs/adr/0072-terminal-output-gap-sequence-exact-repair.md
pub fn resume_terminal_output(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    generation: u64,
    seq: u64,
) -> Result<Option<TerminalOutputDelta>, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .resume_output(generation, seq)
}

pub fn terminal_render_checkpoint_target(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
) -> Result<TerminalRenderCheckpointTarget, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .checkpoint_target()
}

pub fn update_terminal_output_geometry(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    cols: u16,
    rows: u16,
) -> Result<TerminalGeometry, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .update_geometry(cols, rows)
}

pub fn attach_and_subscribe_terminal_output_from_render_checkpoint(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    checkpoint: TerminalRenderCheckpoint,
) -> Result<TerminalOutputSubscribedAttachment, String> {
    attach_and_subscribe_terminal_output_from_render_checkpoint_with_capacity(
        protocol_states,
        terminal_id,
        checkpoint,
        TERMINAL_OUTPUT_SUBSCRIBER_CAPACITY,
    )
}

pub fn attach_and_subscribe_terminal_output_from_render_checkpoint_with_capacity(
    protocol_states: &SharedTerminalProtocolStates,
    terminal_id: &str,
    checkpoint: TerminalRenderCheckpoint,
    queue_capacity: usize,
) -> Result<TerminalOutputSubscribedAttachment, String> {
    terminal_output_session_for(protocol_states, terminal_id)?
        .ok_or_else(|| format!("Session '{terminal_id}' not found"))?
        .attach_and_subscribe_from_render_checkpoint(checkpoint, queue_capacity)
}

pub(super) fn attachment_from_snapshot(
    generation: u64,
    geometry: TerminalGeometry,
    protocol: TerminalProtocolSnapshot,
    snapshot: TerminalOutputSlice,
) -> TerminalOutputAttachment {
    TerminalOutputAttachment {
        state: TerminalAttachState {
            version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
            generation,
            snapshot_start_seq: snapshot.seq_start,
            snapshot_seq: snapshot.seq_end,
            source_start_seq: snapshot.seq_start,
            source_seq: snapshot.seq_end,
            snapshot_kind: TerminalSnapshotKind::Raw,
            protocol_revision: protocol.revision,
            modes: TerminalAttachModes {
                bracketed_paste: protocol.bracketed_paste,
            },
            geometry,
        },
        snapshot: snapshot.data,
    }
}
