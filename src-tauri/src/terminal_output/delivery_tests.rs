use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[path = "delivery_emitter_tests.rs"]
mod emitter;
#[path = "delivery_retirement_tests.rs"]
mod retirement;

fn delta(seq_start: u64, bytes: usize) -> TerminalOutputDelta {
    TerminalOutputDelta {
        generation: 1,
        seq_start,
        seq_end: seq_start + bytes as u64,
        data: vec![(seq_start % 251) as u8; bytes],
        geometry: TerminalGeometry::new(80, 24).unwrap(),
    }
}

fn identity(envelope: &TerminalOutputDeltaEnvelopeV3) -> TerminalOutputEnvelopeIdentity {
    TerminalOutputEnvelopeIdentity {
        generation: envelope.generation,
        lease_token: envelope.lease_token.clone(),
        envelope_id: envelope.envelope_id,
        grant_id: envelope.grant_id.clone(),
    }
}

fn install(delivery: &DesktopOutputDelivery, snapshot_seq: u64) {
    delivery
        .install_lease("lease-1".into(), 0, snapshot_seq)
        .unwrap();
}

#[test]
fn bootstrap_stays_ring_only_until_an_attach_lease_is_installed() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(
                move |event: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                    tx.send((event.to_string(), envelope.clone())).unwrap();
                    Ok(())
                },
            ),
            Arc::new(|_| {}),
        )
        .unwrap();

    assert_eq!(
        delivery.enqueue(delta(0, 3)).unwrap(),
        TerminalOutputDeliveryAdmission::BootstrapRingOnly
    );
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    assert_eq!(
        delivery
            .acknowledge_receipt(
                &TerminalOutputEnvelopeIdentity {
                    generation: 1,
                    lease_token: "bootstrap-has-no-token".into(),
                    envelope_id: 1,
                    grant_id: None,
                },
                1
            )
            .unwrap(),
        TerminalOutputReceiptCompletion::Stale
    );

    install(&delivery, 3);
    assert_eq!(
        delivery.enqueue(delta(3, 4)).unwrap(),
        TerminalOutputDeliveryAdmission::Queued
    );
    let (event, envelope) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(event, "terminal-output-v3-t1");
    assert_eq!((envelope.seq_start, envelope.seq_end), (3, 7));
    assert_eq!(envelope.lease_token, "lease-1");

    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn one_envelope_obeys_all_structural_and_wire_caps() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    install(&delivery, 0);
    for index in 0..TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS {
        assert_eq!(
            delivery.enqueue(delta((index * 8) as u64, 8)).unwrap(),
            TerminalOutputDeliveryAdmission::Queued
        );
    }

    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    let envelope = rx.recv_timeout(Duration::from_secs(1)).unwrap();

    assert_eq!(envelope.version, TERMINAL_OUTPUT_ENVELOPE_VERSION);
    assert_eq!(envelope.data.len(), TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES);
    assert_eq!(
        envelope.delta_ends.len(),
        TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS
    );
    assert_eq!(envelope.geometry_runs.len(), 1);
    assert!(serde_json::to_vec(&envelope).unwrap().len() < TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES);

    delivery
        .acknowledge_receipt(&identity(&envelope), envelope.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn one_unreceipted_slot_and_identity_retries_are_exact() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    install(&delivery, 0);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    delivery.enqueue(delta(0, 1)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(first.grant_id, None);

    delivery.enqueue(delta(1, 1)).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    let mut stale = identity(&first);
    stale.lease_token = "stale-token".into();
    assert_eq!(
        delivery.acknowledge_receipt(&stale, first.seq_end).unwrap(),
        TerminalOutputReceiptCompletion::Stale
    );
    stale = identity(&first);
    stale.envelope_id += 99;
    assert_eq!(
        delivery.acknowledge_receipt(&stale, first.seq_end).unwrap(),
        TerminalOutputReceiptCompletion::Stale
    );
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());

    let first_identity = identity(&first);
    assert_eq!(
        delivery
            .acknowledge_receipt(&first_identity, first.seq_end)
            .unwrap(),
        TerminalOutputReceiptCompletion::Accepted
    );
    assert_eq!(
        delivery
            .acknowledge_receipt(&first_identity, first.seq_end)
            .unwrap(),
        TerminalOutputReceiptCompletion::Duplicate
    );
    let second = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(second.envelope_id, first.envelope_id + 1);

    delivery
        .acknowledge_receipt(&identity(&second), second.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn repair_distinguishes_receipted_parser_backlog_from_a_lost_in_flight_event() {
    let delivery = DesktopOutputDelivery::new("repair-parser-backlog".into(), 1);
    install(&delivery, 0);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();

    delivery.enqueue(delta(0, 1)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    delivery.enqueue(delta(1, 1)).unwrap();
    {
        let mut state = delivery.inner.state.lock().unwrap();
        state.pending.front_mut().unwrap().1 = Instant::now() + Duration::from_secs(60);
    }
    delivery
        .acknowledge_receipt(&identity(&first), first.seq_end)
        .unwrap();

    let next_identity = TerminalOutputEnvelopeIdentity {
        generation: 1,
        lease_token: "lease-1".into(),
        envelope_id: first.envelope_id + 1,
        grant_id: None,
    };
    let backlog = delivery
        .repair_envelope(&next_identity, first.seq_end)
        .unwrap();
    assert_eq!(
        backlog.status,
        TerminalOutputEnvelopeRepairStatus::Idle,
        "a receipted envelope with parser credit still behind can leave the next bytes pending"
    );
    assert!(backlog.envelope.is_none());
    let diagnostics = delivery.diagnostics().unwrap();
    assert_eq!(diagnostics.parsed_seq, 0);
    assert_eq!(diagnostics.observed_seq, 2);
    assert!(diagnostics.in_flight.is_none());

    {
        let mut state = delivery.inner.state.lock().unwrap();
        state.pending.front_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
        delivery.inner.changed.notify_all();
    }
    let emitted = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let fresh_event = delivery
        .repair_envelope(&identity(&emitted), emitted.seq_start)
        .unwrap();
    assert_eq!(
        fresh_event.status,
        TerminalOutputEnvelopeRepairStatus::EventPending
    );
    assert!(fresh_event.envelope.is_none());
    {
        let mut state = delivery.inner.state.lock().unwrap();
        state.in_flight.as_mut().unwrap().repair_not_before = Instant::now();
    }
    let lost_event = delivery
        .repair_envelope(&identity(&emitted), emitted.seq_start)
        .unwrap();
    assert_eq!(lost_event.status, TerminalOutputEnvelopeRepairStatus::Exact);
    assert_eq!(lost_event.envelope, Some(emitted.clone()));

    delivery
        .acknowledge_receipt(&identity(&emitted), emitted.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn unparsed_history_is_bounded_by_bytes_not_total_original_delta_count() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    install(&delivery, 0);
    for index in 0..TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS {
        delivery.enqueue(delta(index as u64, 1)).unwrap();
    }
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    delivery
        .acknowledge_receipt(&identity(&first), first.seq_end)
        .unwrap();

    let next_seq = TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS as u64;
    delivery.enqueue(delta(next_seq, 1)).unwrap();
    let second = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(second.seq_start, next_seq);
    delivery
        .acknowledge_receipt(&identity(&second), second.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn emitter_runs_without_the_delivery_state_lock() {
    let delivery = Arc::new(DesktopOutputDelivery::new("t1".into(), 1));
    install(&delivery, 0);
    let weak = Arc::downgrade(&delivery);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                let completion = weak
                    .upgrade()
                    .unwrap()
                    .acknowledge_receipt(&identity(envelope), envelope.seq_end)
                    .unwrap();
                tx.send(completion).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();

    delivery.enqueue(delta(0, 1)).unwrap();
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputReceiptCompletion::Accepted
    );
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn hold_and_close_require_the_current_full_identity_and_envelope_ranges() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    assert_eq!(delivery.install_lease("lease-1".into(), 0, 0).unwrap(), 1);
    let (tx, rx) = std_mpsc::channel::<TerminalOutputDeltaEnvelopeV3>();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();

    delivery.enqueue(delta(0, 4)).unwrap();
    let opener = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let opener_identity = identity(&opener);
    assert!(delivery
        .open_continuation(&opener_identity, "grant-1", opener.seq_end)
        .is_err());
    assert_eq!(
        delivery
            .open_continuation(&opener_identity, "grant-1", opener.seq_start + 1)
            .unwrap(),
        TerminalOutputControlCompletion::Accepted
    );
    assert_eq!(
        delivery
            .open_continuation(&opener_identity, "grant-1", opener.seq_start + 1)
            .unwrap(),
        TerminalOutputControlCompletion::Duplicate
    );
    assert!(delivery
        .open_continuation(&opener_identity, "grant-conflict", opener.seq_start + 1)
        .is_err());
    delivery
        .acknowledge_receipt(&opener_identity, opener.seq_end)
        .unwrap();

    delivery.enqueue(delta(4, 4)).unwrap();
    let closing = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(closing.grant_id.as_deref(), Some("grant-1"));
    let closing_identity = identity(&closing);
    assert!(delivery
        .close_continuation(&closing_identity, closing.seq_end + 1, "close")
        .is_err());
    let completion = delivery
        .close_continuation(&closing_identity, closing.seq_end, "close")
        .unwrap();
    assert_eq!(
        completion.completion,
        TerminalOutputControlCompletion::Accepted
    );
    assert_eq!(completion.opener_envelope_id, Some(opener.envelope_id));
    assert_eq!(completion.frame_start_seq, Some(opener.seq_start + 1));
    assert_eq!(
        delivery
            .close_continuation(&closing_identity, closing.seq_end, "close")
            .unwrap()
            .completion,
        TerminalOutputControlCompletion::Duplicate
    );
    delivery
        .acknowledge_receipt(&closing_identity, closing.seq_end)
        .unwrap();

    delivery.enqueue(delta(8, 1)).unwrap();
    let after = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(after.grant_id, None);
    delivery
        .acknowledge_receipt(&identity(&after), after.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn receipt_payload_conflict_does_not_release_the_in_flight_slot() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    install(&delivery, 0);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    delivery.enqueue(delta(0, 2)).unwrap();
    let envelope = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(delivery
        .acknowledge_receipt(&identity(&envelope), envelope.seq_end - 1)
        .is_err());
    let mut foreign_grant = identity(&envelope);
    foreign_grant.grant_id = Some("foreign-grant".into());
    assert!(delivery
        .acknowledge_receipt(&foreign_grant, envelope.seq_end)
        .is_err());
    assert_eq!(
        delivery
            .acknowledge_receipt(&identity(&envelope), envelope.seq_end)
            .unwrap(),
        TerminalOutputControlCompletion::Accepted
    );
    assert_eq!(
        delivery
            .install_lease("lease-2".into(), 0, envelope.seq_end)
            .unwrap(),
        envelope.envelope_id + 1
    );
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn lost_receipt_and_lost_close_expire_without_more_output() {
    let receipt =
        DesktopOutputDelivery::with_test_timeouts("receipt".into(), 1, Duration::from_millis(20));
    install(&receipt, 0);
    let (emitted_tx, emitted_rx) = std_mpsc::channel();
    let (reason_tx, reason_rx) = std_mpsc::channel();
    receipt
        .start(
            Arc::new(move |_, _| {
                emitted_tx.send(()).unwrap();
                Ok(())
            }),
            Arc::new(move |reason| reason_tx.send(reason).unwrap()),
        )
        .unwrap();
    receipt.enqueue(delta(0, 1)).unwrap();
    emitted_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        reason_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputDeliveryCloseReason::ReceiptExpired
    );
    receipt.join().unwrap();

    let hold =
        DesktopOutputDelivery::with_test_timeouts("hold".into(), 1, Duration::from_millis(20));
    install(&hold, 0);
    let (envelope_tx, envelope_rx) = std_mpsc::channel();
    let (reason_tx, reason_rx) = std_mpsc::channel();
    hold.start(
        Arc::new(move |_, envelope| {
            envelope_tx.send(envelope.clone()).unwrap();
            Ok(())
        }),
        Arc::new(move |reason| reason_tx.send(reason).unwrap()),
    )
    .unwrap();
    hold.enqueue(delta(0, 2)).unwrap();
    let opener = envelope_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    hold.open_continuation(&identity(&opener), "grant", opener.seq_start)
        .unwrap();
    hold.acknowledge_receipt(&identity(&opener), opener.seq_end)
        .unwrap();
    assert_eq!(
        reason_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputDeliveryCloseReason::ContinuationExpired
    );
    hold.join().unwrap();
}

#[test]
fn repair_grant_mismatch_is_a_typed_status_not_a_command_error() {
    let delivery = DesktopOutputDelivery::new("repair-mismatch".into(), 1);
    install(&delivery, 0);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_, envelope| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    delivery.enqueue(delta(0, 1)).unwrap();
    let envelope = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let mut mismatched = identity(&envelope);
    mismatched.grant_id = Some("foreign-grant".into());

    let response = delivery
        .repair_envelope(&mismatched, envelope.seq_start)
        .unwrap();
    assert_eq!(
        response.status,
        TerminalOutputEnvelopeRepairStatus::Mismatch
    );
    assert!(response.envelope.is_none());
    assert!(delivery.diagnostics().unwrap().in_flight.is_some());

    delivery
        .acknowledge_receipt(&identity(&envelope), envelope.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn continuation_close_rejects_unknown_reason_without_releasing_the_grant() {
    let delivery = DesktopOutputDelivery::new("close-reason".into(), 1);
    install(&delivery, 0);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_, envelope| {
                tx.send(envelope.clone()).unwrap();
                Ok(())
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    delivery.enqueue(delta(0, 1)).unwrap();
    let envelope = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let opener = identity(&envelope);
    assert_eq!(
        delivery
            .open_continuation(&opener, "grant-close-reason", envelope.seq_start)
            .unwrap(),
        TerminalOutputControlCompletion::Accepted
    );
    let closing = TerminalOutputEnvelopeIdentity {
        grant_id: Some("grant-close-reason".into()),
        ..opener
    };
    assert!(delivery
        .close_continuation(&closing, envelope.seq_end, "abort:invented")
        .is_err());
    assert_eq!(
        delivery.diagnostics().unwrap().grant_id.as_deref(),
        Some("grant-close-reason")
    );
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}
