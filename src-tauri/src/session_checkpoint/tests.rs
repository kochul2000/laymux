use super::*;
use crate::lock_ext::MutexExt;
use std::io::Write;
use std::sync::{Arc, Condvar};
use std::time::Instant;

struct StuckWriter {
    gate: Arc<(Mutex<bool>, Condvar)>,
    entered: Option<std::sync::mpsc::Sender<()>>,
}

impl Write for StuckWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if let Some(entered) = self.entered.take() {
            let _ = entered.send(());
        }
        let (released, wake) = &*self.gate;
        let mut released = released.lock().unwrap();
        while !*released {
            released = wake.wait(released).unwrap();
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn finalization_gate_can_be_cancelled_after_an_install_failure() {
    let runtime = SessionCheckpointRuntime::default();
    assert!(runtime.ensure_mutations_allowed().is_ok());
    runtime.begin_finalization().unwrap();
    assert!(runtime.ensure_mutations_allowed().is_err());
    runtime.cancel_finalization();
    assert!(runtime.ensure_mutations_allowed().is_ok());
}

#[tokio::test]
async fn global_finalization_rejects_input_and_duplicate_update() {
    use crate::remote_server::HumanControlOrigin;
    let state = AppState::new();
    // Updates retain the global input fence; background eviction no longer uses it.
    state
        .session_checkpoint
        .begin_finalization_and_drain(&state)
        .await
        .unwrap();
    let error = "destructive session finalization is in progress";
    assert_eq!(
        crate::commands::write_to_terminal_inner(
            &state,
            "visible-pane",
            b"a",
            HumanControlOrigin::Local,
        )
        .unwrap_err(),
        error,
    );
    assert_eq!(
        crate::commands::write_terminal_input_inner(
            &state,
            "visible-pane",
            "whole pasted sentence",
            false,
            HumanControlOrigin::Local,
        )
        .unwrap_err(),
        error,
    );
    assert_eq!(
        state
            .session_checkpoint
            .begin_finalization_and_drain(&state)
            .await
            .unwrap_err(),
        "destructive session finalization is already in progress",
    );
    state.session_checkpoint.cancel_finalization();
    assert!(state.session_checkpoint.begin_mutation().is_ok());
}

#[test]
fn eviction_checkpoint_request_serializes_its_exact_targets() {
    let request = SessionCheckpointRequest {
        request_id: 7,
        reason: "eviction",
        require_conclusive: true,
        terminal_ids: Some(vec!["terminal-p1".into()]),
    };

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::json!({
            "requestId": 7,
            "reason": "eviction",
            "requireConclusive": true,
            "terminalIds": ["terminal-p1"],
        })
    );
}

#[test]
fn hidden_terminal_teardowns_start_in_parallel() {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let worker_gate = Arc::clone(&gate);
    let worker = std::thread::spawn(move || {
        run_hidden_close_batch(vec!["t1".into(), "t2".into(), "t3".into()], |_| {
            started_tx.send(()).unwrap();
            let (released, wake) = &*worker_gate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(())
        })
    });

    for _ in 0..3 {
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("every hidden terminal teardown should start before any finishes");
    }
    let (released, wake) = &*gate;
    *released.lock().unwrap() = true;
    wake.notify_all();

    let results = worker.join().unwrap();
    assert_eq!(results.len(), 3);
    assert!(results.into_iter().all(|(_, result)| result.is_ok()));
}

#[tokio::test]
async fn finalization_waits_for_an_admitted_mutation_to_finish() {
    let state = std::sync::Arc::new(AppState::new());
    let permit = state.session_checkpoint.begin_mutation().unwrap();
    let task_state = state.clone();
    let drain = tokio::spawn(async move {
        task_state
            .session_checkpoint
            .begin_finalization_and_drain(&task_state)
            .await
    });

    tokio::task::yield_now().await;
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_err());
    assert!(!drain.is_finished());
    drop(permit);

    assert!(drain.await.unwrap().is_ok());
}

#[tokio::test]
async fn terminal_close_admission_waits_for_a_cancelled_finalization() {
    let state = std::sync::Arc::new(AppState::new());
    state
        .session_checkpoint
        .begin_finalization_for_test()
        .unwrap();
    let task_state = state.clone();
    let waiting_close = tokio::spawn(async move {
        let permit = task_state
            .session_checkpoint
            .begin_mutation_after_finalization()
            .await;
        drop(permit);
        Ok::<(), String>(())
    });

    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!waiting_close.is_finished());

    state.session_checkpoint.cancel_finalization();
    assert!(tokio::time::timeout(Duration::from_secs(1), waiting_close)
        .await
        .expect("close admission should wake after cancellation")
        .unwrap()
        .is_ok());
}

#[tokio::test]
async fn finalization_waits_for_a_quarantined_pty_completion() {
    let state = std::sync::Arc::new(AppState::new());
    state
        .remote_control
        .lock_or_err()
        .unwrap()
        .register_enqueued_remote_operation_for_test("lease-1", "terminal-1");
    let task_state = state.clone();
    let drain = tokio::spawn(async move {
        task_state
            .session_checkpoint
            .begin_finalization_and_drain(&task_state)
            .await
    });

    tokio::task::yield_now().await;
    assert!(!drain.is_finished());
    state
        .remote_control
        .lock_or_err()
        .unwrap()
        .clear_active_operations_for_test();

    assert!(drain.await.unwrap().is_ok());
}

#[tokio::test]
async fn finalization_waits_for_a_frontend_action_past_http_timeout() {
    let state = std::sync::Arc::new(AppState::new());
    state
        .session_checkpoint
        .begin_detached_mutation("action-1")
        .unwrap();
    let task_state = state.clone();
    let drain = tokio::spawn(async move {
        task_state
            .session_checkpoint
            .begin_finalization_and_drain(&task_state)
            .await
    });

    tokio::task::yield_now().await;
    assert!(!drain.is_finished());
    assert!(state
        .session_checkpoint
        .finish_detached_mutation("action-1")
        .unwrap());

    assert!(drain.await.unwrap().is_ok());
}

#[tokio::test]
async fn finalization_waits_for_a_retired_faulted_pty_worker_completion() {
    let state = std::sync::Arc::new(AppState::new());
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let handle = crate::pty::PtyHandle::from_test_writer(Box::new(StuckWriter {
        gate: Arc::clone(&gate),
        entered: Some(entered_tx),
    }));
    state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .insert("terminal-1".into(), handle.clone());

    let writer = std::thread::spawn(move || {
        handle.write_guarded_until(
            b"blocked",
            Instant::now() + Duration::from_millis(20),
            || true,
        )
    });
    entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("platform writer should start before close");
    let retired_handle = state
        .pty_handles
        .lock_or_err()
        .unwrap()
        .remove("terminal-1")
        .unwrap();
    state
        .session_checkpoint
        .quarantine_retired_pty_completion(retired_handle.control_completion())
        .unwrap();
    let _ = retired_handle.terminate();
    drop(retired_handle);
    assert!(writer.join().unwrap().is_err());
    assert!(!pty_control_operations_drained(&state).unwrap());

    let task_state = state.clone();
    let drain = tokio::spawn(async move {
        task_state
            .session_checkpoint
            .begin_finalization_and_drain(&task_state)
            .await
    });
    tokio::task::yield_now().await;
    assert!(!drain.is_finished());

    let (released, wake) = &*gate;
    *released.lock().unwrap() = true;
    wake.notify_all();
    assert!(drain.await.unwrap().is_ok());
}
