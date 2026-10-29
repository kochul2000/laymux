use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use crate::{pty::PtyHandle, state::AppState};

fn tracked_handle(count: &Arc<AtomicUsize>) -> PtyHandle {
    PtyHandle::from_test_writer(Box::new(Vec::<u8>::new()))
        .with_graceful_close_probe(Arc::clone(count))
}

#[test]
fn explicit_close_requests_cooperative_shutdown_only_once_per_handle() {
    let count = Arc::new(AtomicUsize::new(0));
    let handle = tracked_handle(&count);
    handle.terminate_gracefully().unwrap();
    handle.clone().terminate_gracefully().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn normal_app_exit_cooperatively_ends_local_fallback_terminals_too() {
    let count = Arc::new(AtomicUsize::new(0));
    let state = AppState::new();
    state
        .pty_handles
        .lock()
        .unwrap()
        .insert("local-pane".into(), tracked_handle(&count));
    state.terminate_daemon_sessions_on_exit();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(state);
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn installer_handoff_skips_cooperative_signals_even_for_local_fallbacks() {
    let count = Arc::new(AtomicUsize::new(0));
    let state = AppState::new();
    state
        .pty_handles
        .lock()
        .unwrap()
        .insert("local-pane".into(), tracked_handle(&count));
    state.begin_update_handoff();
    state.terminate_child_processes();
    state.terminate_daemon_sessions_on_exit();
    drop(state);
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[test]
fn restart_handoff_skips_signals_and_cancellation_restores_normal_shutdown() {
    let count = Arc::new(AtomicUsize::new(0));
    let state = AppState::new();
    state
        .pty_handles
        .lock()
        .unwrap()
        .insert("pane".into(), tracked_handle(&count));
    state.begin_update_handoff();
    state.terminate_daemon_sessions_on_exit();
    assert_eq!(count.load(Ordering::SeqCst), 0);
    state.cancel_update_handoff();
    state.terminate_daemon_sessions_on_exit();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
