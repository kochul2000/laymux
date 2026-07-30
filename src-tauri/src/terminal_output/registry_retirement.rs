use super::*;

/// Physical delivery settlement deferred beyond every caller-owned catalog or
/// AppState guard. Logical retirement and compatibility removal have already
/// completed when this token is returned.
#[must_use = "terminal output retirement must be settled after releasing outer locks"]
pub struct TerminalOutputRetirement {
    session: Arc<TerminalOutputSession>,
}

impl TerminalOutputRetirement {
    pub fn finish(self) {
        self.session.finish_retirement();
    }
}

/// Retire and remove only `expected`, never a newer generation that reused the
/// same terminal id.
pub fn retire_terminal_output_session(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
) -> Result<bool, String> {
    Ok(retire_terminal_output_session_and_then(
        protocol_states,
        output_buffers,
        terminal_id,
        expected,
        || (),
    )?
    .is_some())
}

/// Retire exactly `expected` and run id-keyed discard cleanup before another
/// generation can reserve the same terminal id.
///
/// The callback runs while the session-registry guard is still held, after the
/// old generation and its compatibility projections have been removed. It may
/// acquire only later AppState locks in the global order and must not block on
/// platform resource shutdown. The delivery barrier and bounded worker join
/// run only after this callback returns and the registry guard is released.
pub fn retire_terminal_output_session_and_then<T>(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
    on_retired: impl FnOnce() -> T,
) -> Result<Option<T>, String> {
    let Some((retired, retirement)) = retire_terminal_output_session_and_then_deferred(
        protocol_states,
        output_buffers,
        terminal_id,
        expected,
        on_retired,
    )?
    else {
        return Ok(None);
    };
    retirement.finish();
    Ok(Some(retired))
}

/// Logical generation retirement plus caller-owned id cleanup. The returned
/// physical settlement token must be finished only after every outer catalog
/// and AppState guard held by the caller has been released.
pub fn retire_terminal_output_session_and_then_deferred<T>(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
    on_retired: impl FnOnce() -> T,
) -> Result<Option<(T, TerminalOutputRetirement)>, String> {
    let (current, retired) = {
        let mut registry = protocol_states
            .sessions
            .lock_or_recover_for_discard("retiring terminal output session registry");
        let Some(current) = registry.active.get(terminal_id).cloned() else {
            return Ok(None);
        };
        if !Arc::ptr_eq(&current, expected) {
            return Ok(None);
        }

        current.begin_retirement(false);
        remove_compatibility_projections(
            protocol_states,
            output_buffers,
            terminal_id,
            Some(&current),
        )?;
        registry.active.remove(terminal_id);
        let retired = on_retired();
        (current, retired)
    };
    Ok(Some((
        retired,
        TerminalOutputRetirement { session: current },
    )))
}

pub(super) fn retire_terminal_output_session_impl(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
    allow_creating: bool,
) -> Result<bool, String> {
    let current = {
        let mut registry = protocol_states
            .sessions
            .lock_or_recover_for_discard("retiring terminal output session registry");
        let Some(current) = registry.active.get(terminal_id).cloned() else {
            return Ok(false);
        };
        if !Arc::ptr_eq(&current, expected) {
            return Ok(false);
        }

        current.begin_retirement(allow_creating);
        remove_compatibility_projections(
            protocol_states,
            output_buffers,
            terminal_id,
            Some(&current),
        )?;
        registry.active.remove(terminal_id);
        current
    };
    current.finish_retirement();
    Ok(true)
}

/// Close-path transaction. The registry remains locked from current-generation
/// selection through retirement publication and compatibility-index cleanup,
/// so a create reservation cannot appear between a `None` lookup and legacy
/// cleanup. Delivery settlement runs after the registry guard is released.
pub fn retire_terminal_output_for_close(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
) -> Result<bool, String> {
    let Some(retirement) =
        begin_terminal_output_retirement_for_close(protocol_states, output_buffers, terminal_id)?
    else {
        return Ok(false);
    };
    retirement.finish();
    Ok(true)
}

/// Publish logical close and transfer physical delivery settlement to the
/// caller. This is the close-command variant used while its terminal catalog
/// guard still excludes same-id create; `finish` belongs after that guard and
/// every other AppState lock have been released.
pub fn begin_terminal_output_retirement_for_close(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
) -> Result<Option<TerminalOutputRetirement>, String> {
    let current = {
        let mut registry = protocol_states
            .sessions
            .lock_or_recover_for_discard("closing terminal output session registry");
        let current = registry.active.get(terminal_id).cloned();
        let Some(current) = current else {
            remove_compatibility_projections(protocol_states, output_buffers, terminal_id, None)?;
            return Ok(None);
        };

        current.begin_retirement(false);
        remove_compatibility_projections(
            protocol_states,
            output_buffers,
            terminal_id,
            Some(&current),
        )?;
        registry.active.remove(terminal_id);
        current
    };
    Ok(Some(TerminalOutputRetirement { session: current }))
}

fn remove_compatibility_projections(
    protocol_states: &SharedTerminalProtocolStates,
    output_buffers: &Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    terminal_id: &str,
    expected: Option<&Arc<TerminalOutputSession>>,
) -> Result<(), String> {
    let mut gates =
        protocol_states.lock_or_recover_for_discard("removing terminal protocol projection");
    let remove_gate = expected.is_none_or(|session| {
        gates
            .get(terminal_id)
            .is_some_and(|gate| Arc::ptr_eq(gate, &session.protocol))
    });
    if remove_gate {
        gates.remove(terminal_id);
    }
    drop(gates);

    let mut buffers =
        output_buffers.lock_or_recover_for_discard("removing terminal output ring projection");
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
