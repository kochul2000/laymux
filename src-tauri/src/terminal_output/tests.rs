use super::*;
use std::sync::{mpsc as std_mpsc, Barrier};
use std::thread;
use std::time::Duration;

fn empty_buffers() -> Arc<Mutex<HashMap<String, TerminalOutputBuffer>>> {
    Arc::new(Mutex::new(HashMap::new()))
}

#[test]
fn record_and_attach_share_one_protocol_output_prefix() {
    let states = SharedTerminalProtocolStates::default();
    let gate = new_protocol_gate();
    states
        .lock()
        .unwrap()
        .insert("t1".into(), Arc::clone(&gate));
    let buffers = Arc::new(Mutex::new(HashMap::from([(
        "t1".into(),
        TerminalOutputBuffer::new(8),
    )])));

    record_terminal_output(&gate, &buffers, "t1", b"old").unwrap();
    let delta = record_terminal_output(&gate, &buffers, "t1", b"\x1b[?2004htext").unwrap();
    assert_eq!(delta.seq_start, 3);
    assert_eq!(delta.seq_end, 15);

    let attachment = attach_terminal_output(&states, &buffers, "t1", 8).unwrap();
    assert_eq!(attachment.state.snapshot_start_seq, 7);
    assert_eq!(attachment.state.snapshot_seq, 15);
    assert!(attachment.state.modes.bracketed_paste);
    assert_eq!(attachment.state.protocol_revision, 1);
    assert_eq!(attachment.snapshot, b"004htext");

    let header = TerminalOutputFrameHeaderV1::snapshot(&attachment);
    assert_eq!(header.byte_length, 8);
    assert_eq!(header.seq_start, 7);
    assert_eq!(header.seq_end, 15);
    assert!(header.state.is_some());
}

#[test]
fn registration_is_an_atomic_reservation_and_drop_rolls_back() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();

    let first = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    assert!(register_terminal_output_session(&states, &buffers, "t1").is_err());
    assert!(states.lock().unwrap().contains_key("t1"));
    assert!(buffers.lock().unwrap().contains_key("t1"));

    drop(first);
    assert!(!states.lock().unwrap().contains_key("t1"));
    assert!(!buffers.lock().unwrap().contains_key("t1"));

    let second = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    assert_eq!(second.session().generation(), 2);
}

#[test]
fn simultaneous_create_reservations_have_exactly_one_winner() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let start = Arc::new(Barrier::new(8));
    let attempted = Arc::new(Barrier::new(8));
    let mut workers = Vec::new();

    for _ in 0..8 {
        let states = states.clone();
        let buffers = Arc::clone(&buffers);
        let start = Arc::clone(&start);
        let attempted = Arc::clone(&attempted);
        workers.push(thread::spawn(move || {
            start.wait();
            let registration = register_terminal_output_session(&states, &buffers, "t1");
            let won = registration.is_ok();
            attempted.wait();
            drop(registration);
            won
        }));
    }

    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|won| *won)
            .count(),
        1
    );
    assert!(terminal_output_session_for(&states, "t1")
        .unwrap()
        .is_none());
}

#[test]
fn close_cancels_an_uncommitted_create_reservation() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let registration = register_terminal_output_session(&states, &buffers, "t1").unwrap();

    assert!(retire_terminal_output_for_close(&states, &buffers, "t1").unwrap());
    assert!(!states.lock().unwrap().contains_key("t1"));
    assert!(!buffers.lock().unwrap().contains_key("t1"));
    assert!(registration.commit().is_err());
}

#[test]
fn poisoned_session_registry_is_recovered_only_for_close_discard() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let registration = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let session = registration.commit().unwrap();

    let sessions = Arc::clone(&states.sessions);
    assert!(thread::spawn(move || {
        let _registry = sessions.lock().unwrap();
        panic!("poison terminal output registry");
    })
    .join()
    .is_err());

    assert!(terminal_output_session_for(&states, "t1").is_err());
    assert!(retire_terminal_output_for_close(&states, &buffers, "t1").unwrap());
    assert!(session.is_terminal_output_retired());
    assert!(!states.lock().unwrap().contains_key("t1"));
    assert!(!buffers.lock().unwrap().contains_key("t1"));
}

#[test]
fn retired_callback_cannot_write_into_reused_terminal_id() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let first = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let old_session = first.commit().unwrap();
    old_session.record_output(b"old").unwrap().unwrap();
    assert_eq!(
        buffers.lock().unwrap()["t1"].recent_bytes(3).unwrap(),
        b"old"
    );
    assert!(retire_terminal_output_session(&states, &buffers, "t1", &old_session).unwrap());

    let second = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let new_session = second.commit().unwrap();
    assert!(old_session.record_output(b"stale").unwrap().is_none());
    new_session.record_output(b"new").unwrap().unwrap();

    let attachment = attach_terminal_output(&states, &buffers, "t1", 64).unwrap();
    assert_eq!(attachment.snapshot, b"new");
    assert_eq!(new_session.generation(), old_session.generation() + 1);
}

#[tokio::test]
async fn attach_and_subscribe_starts_at_the_atomic_snapshot_boundary() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let registration = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let session = registration.commit().unwrap();
    session.record_output(b"snapshot").unwrap().unwrap();

    let mut subscribed =
        attach_and_subscribe_terminal_output_with_capacity(&states, "t1", 64, 2).unwrap();
    assert_eq!(subscribed.attachment.snapshot, b"snapshot");
    let expected_seq = subscribed.attachment.state.snapshot_seq;

    session.record_output(b"delta").unwrap().unwrap();
    assert_eq!(
        subscribed.subscription.recv().await,
        Some(TerminalOutputSubscriptionEvent::Delta(
            TerminalOutputDelta {
                generation: session.generation(),
                seq_start: expected_seq,
                seq_end: expected_seq + 5,
                data: b"delta".to_vec(),
                geometry: TerminalGeometry::default(),
            }
        ))
    );
}

#[tokio::test]
async fn bounded_subscriber_overflow_reports_an_explicit_gap() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let registration = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let session = registration.commit().unwrap();
    let mut subscribed =
        attach_and_subscribe_terminal_output_with_capacity(&states, "t1", 64, 1).unwrap();

    session.record_output(b"first").unwrap().unwrap();
    session.record_output(b"second").unwrap().unwrap();

    assert_eq!(session.subscriber_count(), 0);
    assert!(matches!(
        subscribed.subscription.recv().await,
        Some(TerminalOutputSubscriptionEvent::Gap {
            generation,
            expected_seq: 5,
            retained_start_seq: 0,
            current_seq: 11,
        }) if generation == session.generation()
    ));
}

#[tokio::test]
async fn conditional_retire_notifies_subscriber_and_cannot_remove_a_new_generation() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let registration = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let old_session = registration.commit().unwrap();
    let mut subscribed =
        attach_and_subscribe_terminal_output_with_capacity(&states, "t1", 64, 1).unwrap();

    assert!(retire_terminal_output_session(&states, &buffers, "t1", &old_session).unwrap());
    assert_eq!(
        subscribed.subscription.recv().await,
        Some(TerminalOutputSubscriptionEvent::Retired {
            generation: old_session.generation(),
        })
    );

    let registration = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let new_session = registration.commit().unwrap();
    assert!(!retire_terminal_output_session(&states, &buffers, "t1", &old_session).unwrap());
    assert!(Arc::ptr_eq(
        &terminal_output_session_for(&states, "t1").unwrap().unwrap(),
        &new_session
    ));
}

#[test]
fn delta_header_never_carries_attach_state() {
    let delta = TerminalOutputDelta {
        generation: 1,
        seq_start: 4,
        seq_end: 7,
        data: b"abc".to_vec(),
        geometry: TerminalGeometry::default(),
    };
    let header = TerminalOutputFrameHeaderV1::delta(&delta);
    assert_eq!(header.phase, TerminalOutputPhase::Delta);
    assert_eq!(header.byte_length, 3);
    assert!(header.state.is_none());
}

#[test]
fn output_metadata_changes_at_the_sequenced_geometry_boundary() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let initial_geometry = TerminalGeometry::new(100, 30).unwrap();
    let registration =
        register_terminal_output_session_with_geometry(&states, &buffers, "t1", initial_geometry)
            .unwrap();
    let session = registration.commit().unwrap();

    let before = session.record_output(b"before").unwrap().unwrap();
    assert_eq!(before.generation, session.generation());
    assert_eq!(before.geometry, initial_geometry);

    let resized = update_terminal_output_geometry(&states, "t1", 120, 40).unwrap();
    assert_eq!(
        resized,
        TerminalGeometry {
            revision: 1,
            cols: 120,
            rows: 40
        }
    );
    let after = session.record_output(b"after").unwrap().unwrap();
    assert_eq!(after.geometry, resized);

    let attachment = attach_terminal_output(&states, &buffers, "t1", 64).unwrap();
    assert_eq!(attachment.state.generation, session.generation());
    assert_eq!(attachment.state.geometry, resized);
    assert_eq!(attachment.state.snapshot_kind, TerminalSnapshotKind::Raw);
    assert_eq!(attachment.state.source_seq, attachment.state.snapshot_seq);
}

#[tokio::test]
async fn render_checkpoint_attach_catches_up_and_offsets_wire_sequences() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let geometry = TerminalGeometry::new(80, 24).unwrap();
    let registration =
        register_terminal_output_session_with_geometry(&states, &buffers, "t1", geometry).unwrap();
    let session = registration.commit().unwrap();
    session.record_output(b"initial-frame").unwrap().unwrap();
    let target = terminal_render_checkpoint_target(&states, "t1").unwrap();
    session.record_output(b"-catchup").unwrap().unwrap();

    let checkpoint_data = "\x1b[2J\x1b[HSCREEN";
    let mut subscribed = attach_and_subscribe_terminal_output_from_render_checkpoint_with_capacity(
        &states,
        "t1",
        TerminalRenderCheckpoint {
            generation: target.generation,
            seq: target.seq,
            geometry: target.geometry,
            data: checkpoint_data.into(),
        },
        2,
    )
    .unwrap();

    assert_eq!(
        subscribed.attachment.state.snapshot_kind,
        TerminalSnapshotKind::Screen
    );
    assert_eq!(subscribed.attachment.state.source_start_seq, target.seq);
    assert_eq!(subscribed.attachment.state.source_seq, target.seq + 8);
    assert_eq!(
        subscribed.attachment.snapshot,
        [checkpoint_data.as_bytes(), b"-catchup"].concat()
    );
    assert_eq!(
        subscribed.attachment.state.snapshot_seq - subscribed.attachment.state.snapshot_start_seq,
        subscribed.attachment.snapshot.len() as u64
    );
    assert_eq!(subscribed.wire_seq_offset, checkpoint_data.len() as u64);

    let live = session.record_output(b"-live").unwrap().unwrap();
    let received = match subscribed.subscription.recv().await {
        Some(TerminalOutputSubscriptionEvent::Delta(delta)) => delta,
        other => panic!("expected live delta, got {other:?}"),
    };
    assert_eq!(received, live);
    let header =
        TerminalOutputFrameHeaderV1::delta_with_offset(&received, subscribed.wire_seq_offset)
            .unwrap();
    assert_eq!(header.seq_start, subscribed.attachment.state.snapshot_seq);
    assert_eq!(header.seq_end - header.seq_start, 5);
}

#[test]
fn render_checkpoint_attach_rejects_stale_generation_geometry_and_ring_gap() {
    let geometry = TerminalGeometry::new(80, 24).unwrap();
    let session = Arc::new(TerminalOutputSession::new(
        "t1".into(),
        9,
        TerminalOutputBuffer::new(5),
        geometry,
    ));
    session.commit_creation().unwrap();
    session.record_output(b"abcdefgh").unwrap().unwrap();

    let stale_generation = TerminalRenderCheckpoint {
        generation: 8,
        seq: 8,
        geometry,
        data: "screen".into(),
    };
    assert!(session
        .attach_and_subscribe_from_render_checkpoint(stale_generation, 1)
        .err()
        .unwrap()
        .contains("generation changed"));

    session.update_geometry(100, 30).unwrap();
    let stale_geometry = TerminalRenderCheckpoint {
        generation: 9,
        seq: 8,
        geometry,
        data: "screen".into(),
    };
    assert!(session
        .attach_and_subscribe_from_render_checkpoint(stale_geometry, 1)
        .err()
        .unwrap()
        .contains("geometry changed"));

    let current_geometry = session.checkpoint_target().unwrap().geometry;
    let behind_ring = TerminalRenderCheckpoint {
        generation: 9,
        seq: 2,
        geometry: current_geometry,
        data: "screen".into(),
    };
    assert!(session
        .attach_and_subscribe_from_render_checkpoint(behind_ring, 1)
        .err()
        .unwrap()
        .contains("fell behind"));
    assert_eq!(session.subscriber_count(), 0);
}

#[test]
fn resume_returns_the_exact_missing_range_for_a_delivery_gap() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let geometry = TerminalGeometry::new(80, 24).unwrap();
    let registration =
        register_terminal_output_session_with_geometry(&states, &buffers, "t1", geometry).unwrap();
    let session = registration.commit().unwrap();

    let delivered = session.record_output(b"frame-one").unwrap().unwrap();
    // Two chunks whose `terminal-output-v2` events never reached the surface.
    session.record_output(b"-lost-a").unwrap().unwrap();
    session.record_output(b"-lost-b").unwrap().unwrap();

    let resumed = resume_terminal_output(&states, "t1", session.generation(), delivered.seq_end)
        .unwrap()
        .expect("the ring still retains the gap range");

    assert_eq!(resumed.generation, session.generation());
    assert_eq!(resumed.seq_start, delivered.seq_end);
    assert_eq!(resumed.seq_end, 9 + 7 + 7);
    assert_eq!(resumed.data, b"-lost-a-lost-b");
    assert_eq!(resumed.geometry, geometry);
    assert_eq!(
        resumed.data.len() as u64,
        resumed.seq_end - resumed.seq_start,
        "the wire range must match the byte length exactly"
    );
}

#[test]
fn resume_refuses_to_clamp_a_range_the_ring_no_longer_retains() {
    let geometry = TerminalGeometry::new(80, 24).unwrap();
    let session = Arc::new(TerminalOutputSession::new(
        "t1".into(),
        4,
        TerminalOutputBuffer::new(5),
        geometry,
    ));
    session.commit_creation().unwrap();
    session.record_output(b"abcdefgh").unwrap().unwrap();

    // Ring retains [3, 8). Anything older must escalate to a fresh attach
    // instead of silently returning a shorter prefix.
    assert!(session.resume_output(4, 2).unwrap().is_none());
    assert_eq!(session.resume_output(4, 3).unwrap().unwrap().data, b"defgh");
    // A sequence ahead of the ring is a surface bug, never a clamp.
    assert!(session.resume_output(4, 9).unwrap().is_none());
    // A replaced generation can never be bridged by byte sequence.
    assert!(session.resume_output(3, 3).unwrap().is_none());
}

#[test]
fn resume_reports_the_current_authoritative_geometry() {
    let geometry = TerminalGeometry::new(80, 24).unwrap();
    let session = Arc::new(TerminalOutputSession::new(
        "t1".into(),
        1,
        TerminalOutputBuffer::new(64),
        geometry,
    ));
    session.commit_creation().unwrap();
    let delivered = session.record_output(b"before").unwrap().unwrap();
    let resized = session.update_geometry(100, 30).unwrap();
    session.record_output(b"after").unwrap().unwrap();

    let resumed = session
        .resume_output(1, delivered.seq_end)
        .unwrap()
        .expect("the ring retains the range");

    assert_eq!(resumed.data, b"after");
    assert_eq!(resumed.geometry, resized);
    assert_ne!(
        resumed.geometry.revision, geometry.revision,
        "a resize inside the gap must be visible to the surface so it can refuse the repair"
    );
}

#[test]
fn resume_rejects_a_retired_or_still_creating_generation() {
    let geometry = TerminalGeometry::new(80, 24).unwrap();
    let creating = Arc::new(TerminalOutputSession::new(
        "t1".into(),
        1,
        TerminalOutputBuffer::new(64),
        geometry,
    ));
    assert!(creating
        .resume_output(1, 0)
        .err()
        .unwrap()
        .contains("still being created"));

    creating.commit_creation().unwrap();
    creating.retire(false).unwrap();
    assert!(creating
        .resume_output(1, 0)
        .err()
        .unwrap()
        .contains("not found"));
}

#[test]
fn resume_reports_a_missing_terminal_instead_of_an_empty_range() {
    let states = SharedTerminalProtocolStates::default();
    assert!(resume_terminal_output(&states, "missing", 1, 0)
        .err()
        .unwrap()
        .contains("not found"));
}

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
fn record_failure_stays_fail_closed_until_poison_tolerant_retirement() {
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

    let worker_session = Arc::clone(&session);
    let (failed_tx, failed_rx) = std_mpsc::channel();
    let (done_tx, done_rx) = std_mpsc::channel();
    let worker = thread::spawn(move || {
        assert!(worker_session.record_output(b"lost").is_err());
        failed_tx.send(()).unwrap();
        worker_session.wait_for_terminal_output_retirement();
        done_tx.send(()).unwrap();
    });
    failed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());

    // Neither parsed credit nor a replacement desktop token can manufacture a
    // sequence for the unrecorded bytes. The poisoned protocol also rejects an
    // attach, while an ACK remains harmless and cannot open the fatal gate.
    assert!(session
        .acknowledge_desktop_output(session.generation(), &attached.flow_control.token, 0)
        .unwrap());
    assert!(session.attach_desktop(64, 4).is_err());
    assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());

    // Retirement recovers poison only to discard the generation. It completes
    // successfully, so the close command continues to PTY-handle termination;
    // the callback returns without running legacy/OSC emission.
    session.retire(false).unwrap();
    done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
    assert!(session.record_output(b"after-retire").is_err());
    session.wait_for_terminal_output_retirement();
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
    session.retire(false).unwrap();
    assert!(session.is_terminal_output_retired());
}

#[test]
fn poisoned_credit_state_never_fails_open_and_only_retirement_wakes_fatal_wait() {
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

    let fatal_session = Arc::clone(&session);
    let (entered_tx, entered_rx) = std_mpsc::channel();
    let (done_tx, done_rx) = std_mpsc::channel();
    let worker = thread::spawn(move || {
        entered_tx.send(()).unwrap();
        fatal_session.wait_for_terminal_output_retirement();
        done_tx.send(()).unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());

    session.retire(false).unwrap();
    done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    worker.join().unwrap();
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
