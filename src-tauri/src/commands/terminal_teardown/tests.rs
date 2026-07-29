use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use crate::pty;
use crate::terminal::{TerminalConfig, TerminalSession};

use super::*;

struct SharedTestWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedTestWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn install_test_terminal_generation(
    state: &AppState,
    terminal_id: &str,
) -> (Arc<TerminalOutputSession>, pty::PtyHandle) {
    let registration = terminal_output::register_terminal_output_session(
        &state.terminal_protocol_states,
        &state.output_buffers,
        terminal_id,
    )
    .unwrap();
    let output_session = registration.session();
    state.terminals.lock_or_err().unwrap().insert(
        terminal_id.into(),
        TerminalSession::new(terminal_id.into(), TerminalConfig::default()),
    );
    let handle = pty::PtyHandle::from_test_writer(Box::new(SharedTestWriter(Arc::new(
        Mutex::new(Vec::new()),
    ))));
    state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .insert(terminal_id.into(), handle.clone());
    registration.commit().unwrap();
    (output_session, handle)
}

fn real_pty_terminal_config() -> TerminalConfig {
    #[cfg(windows)]
    let (profile, command_line) = ("PowerShell", "powershell.exe -NoLogo -NoProfile");
    #[cfg(not(windows))]
    let (profile, command_line) = ("sh", "/bin/sh");

    TerminalConfig {
        profile: profile.into(),
        command_line: command_line.into(),
        ..TerminalConfig::default()
    }
}

fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    predicate()
}

fn terminate_detached_for_test(
    terminal_id: &str,
    generation: u64,
    detached: DetachedFatalGeneration,
) {
    if let Some(handle) = detached.handle {
        terminate_detached_handle(terminal_id, generation, handle);
    }
}

#[test]
fn fatal_teardown_request_is_generation_local_and_exactly_once() {
    let state = AppState::new();
    let (session, handle) = install_test_terminal_generation(&state, "fatal");

    assert!(session.request_fatal_teardown());
    assert!(!session.request_fatal_teardown());
    let detached = detach_terminal_output_generation(&state, "fatal", &session)
        .unwrap()
        .unwrap();
    terminate_detached_for_test("fatal", session.generation(), detached);
    assert!(detach_terminal_output_generation(&state, "fatal", &session)
        .unwrap()
        .is_none());

    assert!(!state.terminals.lock_or_err().unwrap().contains_key("fatal"));
    assert!(!state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .contains_key("fatal"));
    assert!(
        terminal_output::terminal_output_session_for(&state.terminal_protocol_states, "fatal")
            .unwrap()
            .is_none()
    );
    assert!(state
        .terminal_protocol_states
        .lock_or_err()
        .unwrap()
        .get("fatal")
        .is_none());
    assert!(state
        .output_buffers
        .lock_or_err()
        .unwrap()
        .get("fatal")
        .is_none());
    assert!(handle.write(b"after-fatal").is_err());
}

#[test]
fn fatal_detach_returns_and_terminates_pty_when_delivery_emitter_join_times_out() {
    let state = AppState::new();
    let (session, handle) = install_test_terminal_generation(&state, "fatal-stuck-emitter");
    session.set_delivery_shutdown_timeout_for_test(Duration::from_millis(20));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let release_for_emit = Arc::clone(&release_rx);
    session
        .start_desktop_output_delivery(Arc::new(move |_, _| {
            entered_tx.send(()).unwrap();
            let _ = release_for_emit.lock().unwrap().recv();
            Ok(())
        }))
        .unwrap();
    session
        .begin_desktop_output_bootstrap(crate::constants::TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES)
        .unwrap();
    terminal_output::attach_desktop_terminal_output(
        &state.terminal_protocol_states,
        "fatal-stuck-emitter",
        crate::constants::TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
        crate::constants::TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
    )
    .unwrap();
    session.record_desktop_output(b"blocked").unwrap();
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    let detached = detach_terminal_output_generation(&state, "fatal-stuck-emitter", &session)
        .unwrap()
        .unwrap();
    assert_eq!(
        session.delivery_failure(),
        Some(terminal_output::TerminalOutputDeliveryCloseReason::WorkerShutdownTimedOut)
    );
    terminate_detached_for_test("fatal-stuck-emitter", session.generation(), detached);
    assert!(handle.write(b"after-fatal").is_err());
    release_tx.send(()).unwrap();
}

#[test]
fn explicit_close_releases_terminal_catalog_before_delivery_join() {
    let state = Arc::new(AppState::new());
    let (closing_session, closing_handle) =
        install_test_terminal_generation(&state, "close-stuck-emitter");
    let (_other_session, other_handle) = install_test_terminal_generation(&state, "other-live");
    closing_session.set_delivery_shutdown_timeout_for_test(Duration::from_secs(1));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let release_for_emit = Arc::clone(&release_rx);
    closing_session
        .start_desktop_output_delivery(Arc::new(move |_, _| {
            entered_tx.send(()).unwrap();
            let _ = release_for_emit.lock().unwrap().recv();
            Ok(())
        }))
        .unwrap();
    closing_session
        .begin_desktop_output_bootstrap(crate::constants::TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES)
        .unwrap();
    terminal_output::attach_desktop_terminal_output(
        &state.terminal_protocol_states,
        "close-stuck-emitter",
        crate::constants::TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
        crate::constants::TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
    )
    .unwrap();
    closing_session.record_desktop_output(b"blocked").unwrap();
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    // Mirror the explicit close transaction: same-id create stays excluded
    // through logical retirement and handle transfer, but physical delivery
    // settlement is transferred beyond the outer catalog guard.
    let mut terminals = state.terminals.lock_or_err().unwrap();
    let retirement = terminal_output::begin_terminal_output_retirement_for_close(
        &state.terminal_protocol_states,
        &state.output_buffers,
        "close-stuck-emitter",
    )
    .unwrap()
    .unwrap();
    terminals.remove("close-stuck-emitter").unwrap();
    let detached_handle = state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .remove("close-stuck-emitter")
        .unwrap();
    drop(terminals);

    let (finish_started_tx, finish_started_rx) = std::sync::mpsc::channel::<()>();
    let (finish_done_tx, finish_done_rx) = std::sync::mpsc::channel::<()>();
    let finish_worker = thread::spawn(move || {
        finish_started_tx.send(()).unwrap();
        retirement.finish();
        finish_done_tx.send(()).unwrap();
    });
    finish_started_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(finish_done_rx
        .recv_timeout(Duration::from_millis(30))
        .is_err());

    let catalog = state.terminals.lock_or_err().unwrap();
    assert!(catalog.contains_key("other-live"));
    drop(catalog);
    assert!(other_handle.write(b"still-live").is_ok());

    release_tx.send(()).unwrap();
    finish_done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    finish_worker.join().unwrap();
    detached_handle.terminate().unwrap();
    assert!(closing_handle.write(b"after-close").is_err());
}

#[test]
fn pending_create_fatal_retires_the_reservation_and_makes_commit_fail() {
    let state = AppState::new();
    let registration = terminal_output::register_terminal_output_session(
        &state.terminal_protocol_states,
        &state.output_buffers,
        "pending",
    )
    .unwrap();
    let session = registration.session();
    assert!(session.request_fatal_teardown());

    assert!(
        detach_terminal_output_generation(&state, "pending", &session)
            .unwrap()
            .is_some()
    );
    assert!(registration.commit().is_err());
    assert!(terminal_output::terminal_output_session_for(
        &state.terminal_protocol_states,
        "pending"
    )
    .unwrap()
    .is_none());
}

#[test]
fn stale_fatal_teardown_cannot_remove_a_reused_terminal_id() {
    let state = AppState::new();
    let (old_session, _old_handle) = install_test_terminal_generation(&state, "reused");
    let old_exec_lock = Arc::new(tokio::sync::Mutex::new(()));
    state.exec_locks.lock_or_err().unwrap().insert(
        "reused".into(),
        crate::state::TerminalExecLockEntry {
            generation: old_session.generation(),
            lock: Arc::clone(&old_exec_lock),
        },
    );
    let detached = detach_terminal_output_generation(&state, "reused", &old_session)
        .unwrap()
        .unwrap();
    terminate_detached_for_test("reused", old_session.generation(), detached);
    assert!(!state
        .exec_locks
        .lock_or_err()
        .unwrap()
        .contains_key("reused"));

    let (new_session, new_handle) = install_test_terminal_generation(&state, "reused");
    let new_exec_lock = Arc::new(tokio::sync::Mutex::new(()));
    state.exec_locks.lock_or_err().unwrap().insert(
        "reused".into(),
        crate::state::TerminalExecLockEntry {
            generation: new_session.generation(),
            lock: Arc::clone(&new_exec_lock),
        },
    );
    assert_ne!(old_session.generation(), new_session.generation());
    assert!(
        detach_terminal_output_generation(&state, "reused", &old_session)
            .unwrap()
            .is_none()
    );

    assert!(state
        .terminals
        .lock_or_err()
        .unwrap()
        .contains_key("reused"));
    assert!(state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .contains_key("reused"));
    assert!(Arc::ptr_eq(
        &state
            .exec_locks
            .lock_or_err()
            .unwrap()
            .get("reused")
            .unwrap()
            .lock,
        &new_exec_lock
    ));
    assert!(new_handle.write(b"current").is_ok());
}

#[test]
fn old_teardown_cannot_remove_a_same_arc_exec_lock_rebound_to_a_new_generation() {
    let state = Arc::new(AppState::new());
    let (old_session, _old_handle) = install_test_terminal_generation(&state, "exec-aba");
    let reused_arc = Arc::new(tokio::sync::Mutex::new(()));
    state.exec_locks.lock_or_err().unwrap().insert(
        "exec-aba".into(),
        crate::state::TerminalExecLockEntry {
            generation: old_session.generation(),
            lock: Arc::clone(&reused_arc),
        },
    );

    let worker_state = Arc::clone(&state);
    let worker_session = Arc::clone(&old_session);
    let (unlocked_tx, unlocked_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        detach_terminal_output_generation_with_post_unlock(
            &worker_state,
            "exec-aba",
            &worker_session,
            move || {
                unlocked_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
            },
        )
        .unwrap()
        .unwrap()
    });
    unlocked_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    let (new_session, new_handle) = install_test_terminal_generation(&state, "exec-aba");
    state.exec_locks.lock_or_err().unwrap().insert(
        "exec-aba".into(),
        crate::state::TerminalExecLockEntry {
            generation: new_session.generation(),
            // Deliberately reuse the Arc to prove cleanup keys on
            // generation identity rather than pointer identity alone.
            lock: Arc::clone(&reused_arc),
        },
    );
    resume_tx.send(()).unwrap();
    let detached = worker.join().unwrap();
    terminate_detached_for_test("exec-aba", old_session.generation(), detached);

    let locks = state.exec_locks.lock_or_err().unwrap();
    let current = locks.get("exec-aba").unwrap();
    assert_eq!(current.generation, new_session.generation());
    assert!(Arc::ptr_eq(&current.lock, &reused_arc));
    drop(locks);
    assert!(new_handle.write(b"current").is_ok());
}

#[test]
fn spawned_pty_fatal_stops_reader_and_tears_down_child_master_and_writer() {
    let terminal_id = "fatal-real-pty";
    let state = Arc::new(AppState::new());
    let registration = terminal_output::register_terminal_output_session(
        &state.terminal_protocol_states,
        &state.output_buffers,
        terminal_id,
    )
    .unwrap();
    let output_session = registration.session();
    let terminal_session = TerminalSession::new(terminal_id.into(), real_pty_terminal_config());
    let armed = Arc::new(AtomicBool::new(false));
    let fatal_callbacks = Arc::new(AtomicUsize::new(0));
    let callback_state = Arc::clone(&state);
    let callback_session = Arc::clone(&output_session);
    let callback_armed = Arc::clone(&armed);
    let callback_count = Arc::clone(&fatal_callbacks);
    let spawned = pty::spawn_pty_with_metadata(&terminal_session, move |_| {
        if !callback_armed.load(Ordering::Acquire) {
            return PtyOutputControl::Continue;
        }
        callback_count.fetch_add(1, Ordering::AcqRel);
        request_terminal_output_fatal_teardown_inner(
            &callback_state,
            terminal_id,
            &callback_session,
            "integration_test",
            |_, _| {},
        )
    })
    .unwrap();
    let handle = spawned.handle;

    state
        .terminals
        .lock_or_err()
        .unwrap()
        .insert(terminal_id.into(), terminal_session);
    state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .insert(terminal_id.into(), handle.clone());
    registration.commit().unwrap();

    armed.store(true, Ordering::Release);
    #[cfg(windows)]
    handle.write(b"Write-Output fatal\r").unwrap();
    #[cfg(not(windows))]
    handle.write(b"printf fatal\n").unwrap();

    assert!(wait_until(Duration::from_secs(5), || {
        !state
            .pty_handles
            .lock_or_err()
            .unwrap()
            .contains_key(terminal_id)
    }));
    assert!(wait_until(Duration::from_secs(5), || {
        handle.child_exited_for_test()
    }));
    assert_eq!(fatal_callbacks.load(Ordering::Acquire), 1);
    assert!(handle.write(b"after-fatal").is_err());
    assert!(handle.resize(100, 30).is_err());
    assert!(!state
        .terminals
        .lock_or_err()
        .unwrap()
        .contains_key(terminal_id));
    assert!(terminal_output::terminal_output_session_for(
        &state.terminal_protocol_states,
        terminal_id,
    )
    .unwrap()
    .is_none());
    assert!(!state
        .terminal_protocol_states
        .lock_or_err()
        .unwrap()
        .contains_key(terminal_id));
    assert!(!state
        .output_buffers
        .lock_or_err()
        .unwrap()
        .contains_key(terminal_id));
}
