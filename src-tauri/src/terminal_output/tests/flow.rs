use super::super::*;
use std::collections::HashMap;
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

fn flow_test_session() -> Arc<TerminalOutputSession> {
    let session = Arc::new(TerminalOutputSession::new(
        "flow".into(),
        1,
        TerminalOutputBuffer::new(64),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    session
}

fn spawn_capacity_waiter(
    session: &Arc<TerminalOutputSession>,
    produced_seq: u64,
) -> (std_mpsc::Receiver<()>, thread::JoinHandle<()>) {
    let session = Arc::clone(session);
    let (entered_tx, entered_rx) = std_mpsc::channel();
    let (done_tx, done_rx) = std_mpsc::channel();
    let worker = thread::spawn(move || {
        entered_tx.send(()).unwrap();
        session
            .wait_for_desktop_output_capacity(produced_seq)
            .unwrap();
        done_tx.send(()).unwrap();
    });
    entered_rx.recv().unwrap();
    (done_rx, worker)
}

#[test]
fn desktop_bootstrap_bounds_output_before_the_first_attach_and_ack() {
    let session = flow_test_session();
    session.begin_desktop_output_bootstrap(4).unwrap();
    let delta = session.record_output(b"data").unwrap().unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, delta.seq_end);

    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());
    let attached = session.attach_desktop(64, 4).unwrap();
    assert_eq!(attached.attachment.snapshot, b"data");
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    assert!(session
        .acknowledge_desktop_output(
            session.generation(),
            &attached.flow_control.token,
            attached.attachment.state.snapshot_seq,
        )
        .unwrap());
    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
}

#[test]
fn omitted_full_edge_event_is_pulled_from_the_ring_and_ack_releases_the_reader() {
    let session = flow_test_session();
    let attached = session.attach_desktop(64, 4).unwrap();
    assert_eq!(attached.attachment.state.snapshot_seq, 0);

    // Model `app.emit` dropping the only delta that fills the credit window:
    // the backend records it, but the surface learns no sequence from an event.
    let delta = session.record_output(b"data").unwrap().unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, delta.seq_end);
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    // The desktop pull watchdog asks from its last contiguous parsed prefix.
    // Exact resume remains available because window + one PTY read fits inside
    // the ring, and parsing/ACKing that range releases the same waiter.
    let resumed = session
        .resume_output(session.generation(), attached.attachment.state.snapshot_seq)
        .unwrap()
        .unwrap();
    assert_eq!((resumed.seq_start, resumed.seq_end), (0, 4));
    assert_eq!(resumed.data, b"data");
    assert!(session
        .acknowledge_desktop_output(
            session.generation(),
            &attached.flow_control.token,
            resumed.seq_end,
        )
        .unwrap());

    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
}

#[test]
fn record_failure_claims_one_fatal_teardown_before_poison_tolerant_retirement() {
    let session = flow_test_session();
    session.begin_desktop_output_bootstrap(4).unwrap();
    let attached = session.attach_desktop(64, 4).unwrap();

    // `record_output` can only fail after a protocol/runtime lock is poisoned.
    // Deliberately poison the protocol gate to exercise the production error
    // branch instead of calling the fatal wait helper in isolation.
    let protocol = Arc::clone(&session.protocol);
    assert!(thread::spawn(move || {
        let _protocol = protocol.lock().unwrap();
        panic!("poison terminal output protocol for fail-closed test");
    })
    .join()
    .is_err());

    assert!(session.record_output(b"lost").is_err());
    assert!(session.request_fatal_teardown());
    assert!(!session.request_fatal_teardown());

    // Neither parsed credit nor a replacement desktop token can manufacture a
    // sequence for the unrecorded bytes. The poisoned protocol also rejects an
    // attach, while an ACK remains harmless and cannot open the fatal gate.
    assert!(session
        .acknowledge_desktop_output(session.generation(), &attached.flow_control.token, 0)
        .unwrap());
    assert!(session.attach_desktop(64, 4).is_err());
    // Retirement recovers poison only to discard the generation. The production
    // callback has already returned Stop; no poisoned Condvar wait remains.
    session.retire(false).unwrap();
    assert!(session.record_output(b"after-retire").is_err());
}

#[test]
fn poisoned_runtime_rejects_operations_but_close_discards_the_generation() {
    let session = flow_test_session();
    let runtime_session = Arc::clone(&session);
    assert!(thread::spawn(move || {
        let _runtime = runtime_session.runtime.lock().unwrap();
        panic!("poison terminal output runtime");
    })
    .join()
    .is_err());

    assert!(session.record_output(b"must-not-be-recorded").is_err());
    assert!(session.attach(64).is_err());
    assert!(session.request_fatal_teardown());
    assert!(!session.request_fatal_teardown());
    session.retire(false).unwrap();
    assert!(session.is_terminal_output_retired());
}

#[test]
fn poisoned_ring_rejects_the_chunk_and_claims_one_fatal_teardown() {
    let session = flow_test_session();
    session.output.poison_for_test();

    assert!(session.record_output(b"must-not-get-a-sequence").is_err());
    assert!(session.request_fatal_teardown());
    assert!(!session.request_fatal_teardown());
    session.retire(false).unwrap();
    assert!(session.is_terminal_output_retired());
}

#[test]
fn poisoned_credit_state_never_fails_open_and_claims_one_fatal_teardown() {
    let session = flow_test_session();
    session.begin_desktop_output_bootstrap(4).unwrap();
    let attached = session.attach_desktop(64, 4).unwrap();
    session.record_output(b"data").unwrap().unwrap();

    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        session.desktop_flow.poison_for_test();
    }))
    .is_err());

    // Normal credit operations reject poison instead of trusting a potentially
    // half-mutated acknowledged prefix and opening the producer gate.
    assert!(session.wait_for_desktop_output_capacity(4).is_err());
    assert!(session
        .acknowledge_desktop_output(session.generation(), &attached.flow_control.token, 4)
        .is_err());
    assert!(session.attach_desktop(64, 4).is_err());

    assert!(session.request_fatal_teardown());
    assert!(!session.request_fatal_teardown());

    session.retire(false).unwrap();
    assert!(session.is_terminal_output_retired());
}

#[test]
fn remote_only_session_without_a_desktop_lease_never_waits_for_frontend_credit() {
    let session = flow_test_session();
    let delta = session.record_output(b"remote").unwrap().unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, delta.seq_end);

    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
}

#[tokio::test]
async fn remote_subscriber_receives_the_shared_delta_before_desktop_credit_releases_producer() {
    let session = flow_test_session();
    let mut remote = Arc::clone(&session).attach_and_subscribe(64, 4).unwrap();
    let desktop = session.attach_desktop(64, 4).unwrap();

    let delta = session.record_output(b"data").unwrap().unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, delta.seq_end);

    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), remote.subscription.recv())
            .await
            .unwrap(),
        Some(TerminalOutputSubscriptionEvent::Delta(delta.clone()))
    );
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    assert!(session
        .acknowledge_desktop_output(
            session.generation(),
            &desktop.flow_control.token,
            delta.seq_end,
        )
        .unwrap());
    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();

    let next = session.record_output(b"next").unwrap().unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), remote.subscription.recv())
            .await
            .unwrap(),
        Some(TerminalOutputSubscriptionEvent::Delta(next))
    );
}

#[test]
fn ack_before_wait_is_not_lost() {
    let session = flow_test_session();
    session.record_output(b"data").unwrap().unwrap();
    let attached = session.attach_desktop(64, 4).unwrap();
    assert!(session
        .acknowledge_desktop_output(
            session.generation(),
            &attached.flow_control.token,
            attached.attachment.state.snapshot_seq,
        )
        .unwrap());

    let (done, worker) = spawn_capacity_waiter(&session, 4);
    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
}

#[test]
fn one_desktop_lease_per_generation_replaces_the_old_token_and_wakes_waiters() {
    let session = flow_test_session();
    session.record_output(b"data").unwrap().unwrap();
    let first = session.attach_desktop(64, 4).unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, 4);
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    let second = session.attach_desktop(64, 4).unwrap();
    assert_ne!(first.flow_control.token, second.flow_control.token);
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());
    assert!(!session
        .acknowledge_desktop_output(
            session.generation(),
            &first.flow_control.token,
            first.attachment.state.snapshot_seq,
        )
        .unwrap());
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    assert!(session
        .acknowledge_desktop_output(
            session.generation(),
            &second.flow_control.token,
            second.attachment.state.snapshot_seq,
        )
        .unwrap());
    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
}

#[test]
fn desktop_ack_validates_generation_token_monotonicity_and_write_boundary() {
    let session = flow_test_session();
    session.record_output(b"data").unwrap().unwrap();
    let attached = session.attach_desktop(64, 4).unwrap();
    let token = &attached.flow_control.token;

    assert!(!session
        .acknowledge_desktop_output(session.generation() + 1, token, 1)
        .unwrap());
    assert!(!session
        .acknowledge_desktop_output(session.generation(), "stale-token", 1)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(session.generation(), token, 3)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(session.generation(), token, 3)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(session.generation(), token, 2)
        .is_err());
    assert!(session
        .acknowledge_desktop_output(session.generation(), token, 5)
        .is_err());
}

#[test]
fn retiring_a_session_releases_a_blocked_pty_reader() {
    let session = flow_test_session();
    session.record_output(b"data").unwrap().unwrap();
    session.attach_desktop(64, 4).unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, 4);
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    session.retire(false).unwrap();
    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
}

#[test]
fn desktop_flow_window_keeps_every_unacked_live_byte_inside_the_ring() {
    const _: () = assert!(
        crate::constants::TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES
            + crate::pty::PTY_READ_BUFFER_BYTES
            < crate::constants::TERMINAL_OUTPUT_RING_MAX_BYTES
    );

    let ring = TerminalOutputBuffer::default();
    let retained_live_bytes = crate::constants::TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES
        + crate::pty::PTY_READ_BUFFER_BYTES;
    let bytes = vec![b'x'; retained_live_bytes];
    ring.push_sequenced(&bytes).unwrap();
    let recovered = ring
        .delta_since(0)
        .unwrap()
        .expect("the whole bounded unacked prefix must remain repairable");
    assert_eq!(recovered.seq_start, 0);
    assert_eq!(recovered.seq_end, retained_live_bytes as u64);
    assert_eq!(recovered.data, bytes);
}

#[test]
fn creation_rollback_retires_the_bootstrap_lease_and_wakes_a_waiter() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = Arc::new(Mutex::new(HashMap::new()));
    let registration = register_terminal_output_session(&states, &buffers, "rollback").unwrap();
    let session = registration.session();
    session.begin_desktop_output_bootstrap(4).unwrap();
    session.record_output(b"data").unwrap().unwrap();
    let (done, worker) = spawn_capacity_waiter(&session, 4);
    assert!(done.recv_timeout(Duration::from_millis(30)).is_err());

    drop(registration);
    done.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
    assert!(terminal_output_session_for(&states, "rollback")
        .unwrap()
        .is_none());
}
