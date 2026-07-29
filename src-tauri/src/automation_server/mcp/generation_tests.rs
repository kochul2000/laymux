use super::*;

use std::io::Write;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct CountingWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn install_generation(
    state: &crate::state::AppState,
    terminal_id: &str,
    written: &Arc<Mutex<Vec<u8>>>,
) -> u64 {
    let mut terminals = state.terminals.lock().unwrap();
    let registration = crate::terminal_output::register_terminal_output_session(
        &state.terminal_protocol_states,
        &state.output_buffers,
        terminal_id,
    )
    .unwrap();
    let generation = registration.session().generation();
    terminals.insert(
        terminal_id.to_string(),
        crate::terminal::TerminalSession::new(
            terminal_id.to_string(),
            crate::terminal::TerminalConfig::default(),
        ),
    );
    state.pty_handles.lock().unwrap().insert(
        terminal_id.to_string(),
        crate::pty::PtyHandle::from_test_writer(Box::new(CountingWriter(Arc::clone(written)))),
    );
    state
        .output_buffers
        .lock()
        .unwrap()
        .get_mut(terminal_id)
        .unwrap()
        .push(b"\x1b]133;D;0\x07prompt$ ");
    registration.commit().unwrap();
    drop(terminals);
    generation
}

fn replace_generation(
    state: &crate::state::AppState,
    terminal_id: &str,
    written: &Arc<Mutex<Vec<u8>>>,
) -> u64 {
    let old_handle = {
        let mut terminals = state.terminals.lock().unwrap();
        crate::terminal_output::retire_terminal_output_for_close(
            &state.terminal_protocol_states,
            &state.output_buffers,
            terminal_id,
        )
        .unwrap();
        terminals.remove(terminal_id).unwrap();
        state.pty_handles.lock().unwrap().remove(terminal_id)
    };
    state.exec_locks.lock().unwrap().remove(terminal_id);
    if let Some(handle) = old_handle {
        handle.terminate().unwrap();
    }
    install_generation(state, terminal_id, written)
}

fn stale_ticket_after_same_id_recreate(
    state: &crate::state::AppState,
    terminal_id: &str,
    first_generation: u64,
    replacement_written: &Arc<Mutex<Vec<u8>>>,
) -> (TerminalExecTicket, u64) {
    let mut replacement_generation = None;
    let ticket = terminal_exec_ticket_in_with_hook(state, terminal_id, |observed_generation| {
        assert_eq!(observed_generation, first_generation);
        replacement_generation = Some(replace_generation(state, terminal_id, replacement_written));
        assert!(
            state.exec_locks.lock().unwrap().get(terminal_id).is_none(),
            "G2 must not have an exec entry before the stale G1 caller inserts"
        );
    })
    .unwrap();
    (ticket, replacement_generation.unwrap())
}

#[tokio::test]
async fn write_input_stale_generation_cannot_write_to_recreated_terminal_without_g2_exec_entry() {
    let state = crate::state::AppState::new();
    let g1_written = Arc::new(Mutex::new(Vec::new()));
    let g2_written = Arc::new(Mutex::new(Vec::new()));
    let g1 = install_generation(&state, "t1", &g1_written);
    let (ticket, g2) = stale_ticket_after_same_id_recreate(&state, "t1", g1, &g2_written);

    assert!(g2 > g1);
    assert_eq!(
        state
            .exec_locks
            .lock()
            .unwrap()
            .get("t1")
            .unwrap()
            .generation,
        g1,
        "the deterministic hook must reproduce the stale empty-table insertion"
    );
    let _guard = ticket.lock.lock().await;
    let chunks = McpHandler::plan_input_writes("stale", false, true, None);
    let error = McpHandler::write_input_after_lock_from_state(
        &state,
        "t1",
        ticket.generation,
        &chunks,
        false,
    )
    .await
    .unwrap_err();

    assert_eq!(error.is_error, Some(true));
    assert!(g1_written.lock().unwrap().is_empty());
    assert!(
        g2_written.lock().unwrap().is_empty(),
        "stale body or CR must never reach G2"
    );
}

#[tokio::test]
async fn execute_command_stale_generation_cannot_write_to_recreated_terminal_without_g2_exec_entry()
{
    let state = crate::state::AppState::new();
    let g1_written = Arc::new(Mutex::new(Vec::new()));
    let g2_written = Arc::new(Mutex::new(Vec::new()));
    let g1 = install_generation(&state, "t1", &g1_written);
    let (ticket, g2) = stale_ticket_after_same_id_recreate(&state, "t1", g1, &g2_written);

    assert!(g2 > g1);
    assert_eq!(
        state
            .exec_locks
            .lock()
            .unwrap()
            .get("t1")
            .unwrap()
            .generation,
        g1,
        "G2 still has no exec ticket when the stale G1 ticket is returned"
    );
    let _guard = ticket.lock.lock().await;
    let error = McpHandler::execute_command_prewrite_and_write_from_state(
        &state,
        "t1",
        ticket.generation,
        b"echo stale\r",
    )
    .unwrap_err();

    assert_eq!(error.is_error, Some(true));
    assert!(g1_written.lock().unwrap().is_empty());
    assert!(
        g2_written.lock().unwrap().is_empty(),
        "stale command+CR must never reach G2"
    );
}
