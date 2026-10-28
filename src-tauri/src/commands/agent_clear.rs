//! Generation and input-revision checked composer clearing (ADR-0355).
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

use crate::constants::{
    AGENT_CLEAR_COMMAND, AGENT_CLEAR_DELETE_BATCH, AGENT_CLEAR_DELETE_PAIR,
    AGENT_CLEAR_MAX_WAIT_MS, TERMINAL_STRUCTURED_INPUT_MAX_BYTES,
};
use crate::lock_ext::MutexExt;
use crate::pty::PtyHandle;
use crate::remote_server::{begin_human_control_operation, HumanControlOrigin};
use crate::state::AppState;
use crate::terminal_output;
use crate::terminal_protocol::encode_terminal_input;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentClearInputStamp {
    generation: u64,
    input_revision: u64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentClearStep {
    DeleteDraft,
    SubmitClear,
}

fn origin(lease_id: Option<String>) -> HumanControlOrigin {
    lease_id.map_or(HumanControlOrigin::Local, |lease_id| {
        HumanControlOrigin::Remote { lease_id }
    })
}

#[tauri::command(async)]
pub fn begin_agent_clear(
    id: String,
    generation: u64,
    remote_lease_id: Option<String>,
    state: State<Arc<AppState>>,
) -> Result<AgentClearInputStamp, String> {
    begin_agent_clear_inner(&state, &id, generation, origin(remote_lease_id))
}

fn handle_for(state: &AppState, id: &str, generation: u64) -> Result<PtyHandle, String> {
    let handle = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Session '{id}' not found"))?;
    if handle.terminal_generation() != generation {
        return Err("Agent clear terminal generation changed".into());
    }
    Ok(handle)
}

fn begin_agent_clear_inner(
    state: &AppState,
    id: &str,
    generation: u64,
    origin: HumanControlOrigin,
) -> Result<AgentClearInputStamp, String> {
    begin_agent_clear_verified(state, id, generation, origin, || {
        let ids = std::collections::HashSet::from([id.to_owned()]);
        let observation = crate::wsl_probe::snapshot::GuestObservation::starting_now();
        let attributions = super::session_attribution::get_terminal_session_attributions_scoped(
            None,
            None,
            None,
            state,
            observation,
            Some(&ids),
        )?;
        use super::session_attribution::SessionAttributionState;
        let valid = attributions.get(id).is_some_and(|a| {
            a.generation == generation
                && matches!(
                    a.state,
                    SessionAttributionState::Identified
                        | SessionAttributionState::Fresh
                        | SessionAttributionState::ActiveButUnidentified
                )
                && matches!(a.provider, Some("claude" | "codex" | "grok"))
        });
        if valid {
            Ok(())
        } else {
            Err("Agent clear requires a fresh live agent observation".into())
        }
    })
}

fn begin_agent_clear_verified(
    state: &AppState,
    id: &str,
    generation: u64,
    origin: HumanControlOrigin,
    verify: impl FnOnce() -> Result<(), String>,
) -> Result<AgentClearInputStamp, String> {
    let permit = begin_human_control_operation(state, origin, id)?;
    let handle = handle_for(state, id, generation)?;
    let stamp = AgentClearInputStamp {
        generation,
        input_revision: handle.checkpoint_input_revision(),
    };
    verify()?;
    let current = handle_for(state, id, generation)?;
    if current.checkpoint_input_revision() != stamp.input_revision {
        return Err("Agent clear input changed during observation".into());
    }
    permit.finish()?;
    Ok(stamp)
}

#[tauri::command(async)]
pub fn agent_clear_input(
    id: String,
    expected: AgentClearInputStamp,
    step: AgentClearStep,
    remaining_ms: u64,
    remote_lease_id: Option<String>,
    state: State<Arc<AppState>>,
) -> Result<AgentClearInputStamp, String> {
    agent_clear_input_inner(
        &state,
        &id,
        expected,
        step,
        remaining_ms,
        origin(remote_lease_id),
    )
}

fn agent_clear_input_inner(
    state: &AppState,
    id: &str,
    expected: AgentClearInputStamp,
    step: AgentClearStep,
    remaining_ms: u64,
    origin: HumanControlOrigin,
) -> Result<AgentClearInputStamp, String> {
    let requested_deadline =
        Instant::now() + Duration::from_millis(remaining_ms.min(AGENT_CLEAR_MAX_WAIT_MS));
    let permit = begin_human_control_operation(state, origin, id)?;
    let handle = handle_for(state, id, expected.generation)?;
    let (body, submit) = match step {
        AgentClearStep::DeleteDraft => (
            AGENT_CLEAR_DELETE_PAIR.repeat(AGENT_CLEAR_DELETE_BATCH),
            false,
        ),
        AgentClearStep::SubmitClear => {
            let protocol = terminal_output::protocol_gate_for(&state.terminal_protocol_states, id)?;
            let bracketed_paste = protocol.lock_or_err()?.bracketed_paste();
            let body = encode_terminal_input(
                AGENT_CLEAR_COMMAND,
                false,
                bracketed_paste,
                TERMINAL_STRUCTURED_INPUT_MAX_BYTES,
            )
            .map_err(|error| error.to_string())?;
            (body, true)
        }
    };
    let deadline = permit.deadline().min(requested_deadline);
    let (pending, next) = permit.enqueue_pty_job(|| {
        if Instant::now() >= deadline {
            return Err("Agent clear deadline elapsed before input".into());
        }
        // The PTY gate also serializes direct Automation/MCP writes which do
        // not enter the human-owner gate. Compare and enqueue atomically there.
        let (pending, input_revision) =
            handle.enqueue_write_if_revision(expected.input_revision, &body, submit, deadline)?;
        // Capture our revision under the enqueue gate, never after awaiting I/O:
        // a later user's input must invalidate the next clear step.
        let next = AgentClearInputStamp {
            generation: expected.generation,
            input_revision,
        };
        Ok((pending, next))
    })?;
    let result = handle.await_enqueued_control_job(pending, deadline, || permit.is_current());
    super::terminal::finish_human_control_io(permit, &handle, result)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::terminal::write_to_terminal_inner;
    use crate::remote_server::RemoteControlLease;
    use std::io::{self, Write};
    use std::sync::Mutex;

    struct Writer(Arc<Mutex<Vec<u8>>>);
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    fn setup() -> (AppState, Arc<Mutex<Vec<u8>>>) {
        let state = AppState::new();
        terminal_output::register_terminal_output_session(
            &state.terminal_protocol_states,
            &state.output_buffers,
            "t",
        )
        .unwrap()
        .commit()
        .unwrap();
        let written = Arc::new(Mutex::new(Vec::new()));
        state.pty_handles.lock_or_err().unwrap().insert(
            "t".into(),
            PtyHandle::from_test_writer_for_generation(Box::new(Writer(Arc::clone(&written))), 7),
        );
        (state, written)
    }
    fn local() -> HumanControlOrigin {
        HumanControlOrigin::Local
    }

    // Queue/protocol tests inject only the ownership oracle. Production always
    // uses the strict scoped observation, covered separately below.
    fn begin_agent_clear_inner(
        state: &AppState,
        id: &str,
        generation: u64,
        origin: HumanControlOrigin,
    ) -> Result<AgentClearInputStamp, String> {
        begin_agent_clear_verified(state, id, generation, origin, || Ok(()))
    }

    #[test]
    fn input_during_fresh_ownership_observation_invalidates_the_clear_stamp() {
        let (state, written) = setup();
        let handle = state.pty_handles.lock_or_err().unwrap()["t"].clone();
        let result =
            begin_agent_clear_verified(&state, "t", 7, local(), || handle.write(b"new input"));
        assert!(result.is_err());
        assert_eq!(*written.lock().unwrap(), b"new input");
    }

    #[test]
    fn stale_display_ownership_cannot_authorize_clearing_a_shell_or_missing_agent() {
        let (state, written) = setup();
        assert!(super::begin_agent_clear_inner(&state, "t", 7, local()).is_err());
        assert!(written.lock().unwrap().is_empty());
    }

    #[test]
    fn own_deletion_advances_the_stamp_and_submission_is_a_fixed_command() {
        let (state, written) = setup();
        let stamp = begin_agent_clear_inner(&state, "t", 7, local()).unwrap();
        let next = agent_clear_input_inner(
            &state,
            "t",
            stamp,
            AgentClearStep::DeleteDraft,
            3000,
            local(),
        )
        .unwrap();
        assert_eq!(next.input_revision, stamp.input_revision + 1);
        agent_clear_input_inner(
            &state,
            "t",
            next,
            AgentClearStep::SubmitClear,
            3000,
            local(),
        )
        .unwrap();
        assert_eq!(
            *written.lock().unwrap(),
            [
                AGENT_CLEAR_DELETE_PAIR.repeat(AGENT_CLEAR_DELETE_BATCH),
                b"/clear\r".to_vec()
            ]
            .concat()
        );
    }

    #[test]
    fn external_input_invalidates_both_deletion_and_submission_without_redraw() {
        for step in [AgentClearStep::DeleteDraft, AgentClearStep::SubmitClear] {
            let (state, written) = setup();
            let stamp = begin_agent_clear_inner(&state, "t", 7, local()).unwrap();
            write_to_terminal_inner(&state, "t", b"new draft", local()).unwrap();
            let result = agent_clear_input_inner(&state, "t", stamp, step, 3000, local());
            assert!(
                result.is_err(),
                "intervening raw input must reject the clear step"
            );
            assert_eq!(*written.lock().unwrap(), b"new draft");
        }
    }

    #[test]
    fn direct_automation_writer_and_guarded_enqueue_have_one_order() {
        for _ in 0..16 {
            let written = Arc::new(Mutex::new(Vec::new()));
            let handle = PtyHandle::from_test_writer_for_generation(
                Box::new(Writer(Arc::clone(&written))),
                7,
            );
            let start = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let direct = scope.spawn(|| {
                    start.wait();
                    handle.write(b"user").unwrap();
                });
                start.wait();
                let deadline = Instant::now() + Duration::from_secs(3);
                let guarded = handle.enqueue_write_if_revision(0, b"/clear", false, deadline);
                match guarded {
                    Ok((pending, revision)) => {
                        assert_eq!(
                            revision, 1,
                            "receipt must not absorb a concurrent direct write"
                        );
                        handle
                            .await_enqueued_control_job(pending, deadline, || true)
                            .unwrap();
                        direct.join().unwrap();
                        assert_eq!(*written.lock().unwrap(), b"/clearuser");
                    }
                    Err(error) => {
                        assert!(error.contains("input changed"));
                        direct.join().unwrap();
                        assert_eq!(*written.lock().unwrap(), b"user");
                    }
                }
            });
        }
    }

    #[test]
    fn generation_deadline_and_remote_owner_are_enforced_before_writing() {
        let (state, written) = setup();
        assert!(begin_agent_clear_inner(&state, "t", 6, local()).is_err());
        let stamp = begin_agent_clear_inner(&state, "t", 7, local()).unwrap();
        assert!(agent_clear_input_inner(
            &state,
            "t",
            stamp,
            AgentClearStep::DeleteDraft,
            0,
            local()
        )
        .is_err());
        {
            let mut runtime = state.remote_access.lock_or_err().unwrap();
            runtime.enabled = true;
            runtime.auth_token = Some("test-token".into());
        }
        state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: "lease-clear".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
        assert!(begin_agent_clear_inner(&state, "t", 7, local()).is_err());
        assert!(begin_agent_clear_inner(&state, "t", 7, origin(Some("wrong".into()))).is_err());
        assert!(written.lock().unwrap().is_empty());
        let remote = || origin(Some("lease-clear".into()));
        let stamp = begin_agent_clear_inner(&state, "t", 7, remote()).unwrap();
        agent_clear_input_inner(
            &state,
            "t",
            stamp,
            AgentClearStep::SubmitClear,
            3000,
            remote(),
        )
        .unwrap();
        assert_eq!(*written.lock().unwrap(), b"/clear\r");
    }
}
