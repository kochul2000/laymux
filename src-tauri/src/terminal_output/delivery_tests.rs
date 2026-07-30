use super::*;
use crate::constants::TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT;
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
fn bounded_receipt_pipeline_allows_out_of_order_ack_and_exact_retries() {
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
    let bytes = TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES;
    for index in 0..=TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT {
        delivery
            .enqueue(delta((index * bytes) as u64, bytes))
            .unwrap();
    }
    let mut envelopes = Vec::with_capacity(TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT);
    for _ in 0..TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT {
        envelopes.push(rx.recv_timeout(Duration::from_secs(1)).unwrap());
    }
    assert_eq!(
        envelopes
            .iter()
            .map(|envelope| envelope.envelope_id)
            .collect::<Vec<_>>(),
        (1..=TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT as u64).collect::<Vec<_>>()
    );
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    let first = &envelopes[0];
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
    let third = &envelopes[2];
    assert_eq!(
        delivery
            .acknowledge_receipt(&identity(third), third.seq_end)
            .unwrap(),
        TerminalOutputReceiptCompletion::Accepted
    );
    let fifth = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        fifth.envelope_id,
        TERMINAL_OUTPUT_ENVELOPE_MAX_IN_FLIGHT as u64 + 1
    );

    let first_identity = identity(first);
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
    for envelope in envelopes
        .iter()
        .skip(1)
        .filter(|envelope| envelope.envelope_id != third.envelope_id)
    {
        delivery
            .acknowledge_receipt(&identity(envelope), envelope.seq_end)
            .unwrap();
    }
    delivery
        .acknowledge_receipt(&identity(&fifth), fifth.seq_end)
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
    assert!(diagnostics.in_flight.is_empty());

    {
        let mut state = delivery.inner.state.lock().unwrap();
        state.pending.front_mut().unwrap().1 = Instant::now() - Duration::from_secs(1);
        delivery.inner.changed.notify_all();
    }
    let emitted = rx.recv_timeout(Duration::from_secs(1)).unwrap();
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
    delivery
        .acknowledge_receipt(&opener_identity, opener.seq_end)
        .unwrap();
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

    delivery.enqueue(delta(4, 4)).unwrap();
    let closing = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(closing.grant_id.as_deref(), Some("grant-1"));
    let closing_identity = identity(&closing);
    assert!(delivery
        .close_continuation(&closing_identity, closing.seq_end + 1, "close")
        .is_err());
    delivery
        .acknowledge_receipt(&closing_identity, closing.seq_end)
        .unwrap();
    let close_seq = closing.seq_start + 1;
    let completion = delivery
        .close_continuation(&closing_identity, close_seq, "close")
        .unwrap();
    assert_eq!(
        completion.completion,
        TerminalOutputControlCompletion::Accepted
    );
    assert_eq!(completion.opener_envelope_id, Some(opener.envelope_id));
    assert_eq!(completion.frame_start_seq, Some(opener.seq_start + 1));
    assert_eq!(
        delivery
            .close_continuation(&closing_identity, close_seq, "close")
            .unwrap()
            .completion,
        TerminalOutputControlCompletion::Duplicate
    );
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
    let mut conflicting_identity = identity(&envelope);
    conflicting_identity.grant_id = Some("foreign-grant".into());
    assert!(delivery
        .acknowledge_receipt(&conflicting_identity, envelope.seq_end)
        .is_err());
    assert!(delivery
        .acknowledge_receipt(&identity(&envelope), envelope.seq_end - 1)
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
    assert!(!delivery.diagnostics().unwrap().in_flight.is_empty());

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

#[test]
fn continuation_can_reopen_inside_an_envelope_frozen_with_the_closed_grant() {
    let delivery = DesktopOutputDelivery::new("overlapping-grants".into(), 1);
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

    delivery.enqueue(delta(0, 8)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let first_opener = identity(&first);
    delivery
        .open_continuation(&first_opener, "grant-1", first.seq_start)
        .unwrap();

    delivery.enqueue(delta(8, 8)).unwrap();
    let frozen_with_first_grant = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(frozen_with_first_grant.grant_id.as_deref(), Some("grant-1"));
    let first_close = TerminalOutputEnvelopeIdentity {
        grant_id: Some("grant-1".into()),
        ..first_opener
    };
    delivery
        .close_continuation(&first_close, first.seq_end, "close")
        .unwrap();

    let second_opener = TerminalOutputEnvelopeIdentity {
        grant_id: None,
        ..identity(&frozen_with_first_grant)
    };
    assert_eq!(
        delivery
            .open_continuation(&second_opener, "grant-2", frozen_with_first_grant.seq_start)
            .unwrap(),
        TerminalOutputControlCompletion::Accepted
    );
    let second_close = TerminalOutputEnvelopeIdentity {
        grant_id: Some("grant-2".into()),
        ..second_opener
    };
    assert_eq!(
        delivery
            .close_continuation(&second_close, frozen_with_first_grant.seq_end, "close")
            .unwrap()
            .completion,
        TerminalOutputControlCompletion::Accepted
    );

    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}
