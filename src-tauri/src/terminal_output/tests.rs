use super::*;
use std::sync::Barrier;
use std::thread;

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
fn retired_callback_cannot_write_into_reused_terminal_id() {
    let states = SharedTerminalProtocolStates::default();
    let buffers = empty_buffers();
    let first = register_terminal_output_session(&states, &buffers, "t1").unwrap();
    let old_session = first.commit().unwrap();
    old_session.record_output(b"old").unwrap().unwrap();
    assert_eq!(buffers.lock().unwrap()["t1"].recent_bytes(3), b"old");
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
                seq_start: expected_seq,
                seq_end: expected_seq + 5,
                data: b"delta".to_vec(),
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
        seq_start: 4,
        seq_end: 7,
        data: b"abc".to_vec(),
    };
    let header = TerminalOutputFrameHeaderV1::delta(&delta);
    assert_eq!(header.phase, TerminalOutputPhase::Delta);
    assert_eq!(header.byte_length, 3);
    assert!(header.state.is_none());
}
