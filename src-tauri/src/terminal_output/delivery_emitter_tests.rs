use super::*;

#[test]
fn production_delivery_expiry_outlives_a_frontend_stall_and_recovery_round() {
    let delivery = DesktopOutputDelivery::new("production-expiry-budget".into(), 1);

    // ADR-0122: one 5 s WebView stall, the pull watchdog's bounded 3 s
    // recovery poll, and one 5 s control attempt must all fit before the
    // backend destroys the frozen envelope/grant. The remaining 2 s is the
    // explicit scheduling margin rather than an accidental equality race.
    let expected = Duration::from_secs(15);
    assert_eq!(delivery.inner.receipt_timeout, expected);
    assert_eq!(delivery.inner.continuation_timeout, expected);
}

#[test]
fn receipted_envelope_cannot_rearm_a_synchronous_emitter_call() {
    let delivery = DesktopOutputDelivery::new("receipt-before-arm".into(), 1);
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
    let envelope_identity = identity(&envelope);
    assert_eq!(
        delivery
            .acknowledge_receipt(&envelope_identity, envelope.seq_end)
            .unwrap(),
        TerminalOutputReceiptCompletion::Accepted
    );

    assert!(
        !super::super::delivery_worker::arm_emitter_call(&delivery.inner, &envelope_identity,)
            .unwrap()
    );
    assert!(delivery
        .inner
        .state
        .lock()
        .unwrap()
        .emitter_call_expires_at
        .is_none());

    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn hung_emitter_after_exact_repair_receipt_still_releases_the_pending_cap_waiter() {
    let delivery = Arc::new(DesktopOutputDelivery::with_test_timeouts(
        "hung-after-repair".into(),
        1,
        Duration::from_millis(200),
    ));
    install(&delivery, 0);
    let (entered_tx, entered_rx) = std_mpsc::channel::<TerminalOutputDeltaEnvelopeV3>();
    let (release_tx, release_rx) = std_mpsc::channel::<()>();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let release_for_emit = Arc::clone(&release_rx);
    let (reason_tx, reason_rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_, envelope| {
                entered_tx.send(envelope.clone()).unwrap();
                let _ = release_for_emit.lock().unwrap().recv();
                Ok(())
            }),
            Arc::new(move |reason| reason_tx.send(reason).unwrap()),
        )
        .unwrap();

    let cap = TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES;
    delivery.enqueue(delta(0, cap)).unwrap();
    let frozen = entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let before_pending = {
        let state = delivery.inner.state.lock().unwrap();
        let in_flight = state.in_flight.as_ref().unwrap();
        (in_flight.expires_at, in_flight.repair_attempts)
    };
    let pending = delivery
        .repair_envelope(&identity(&frozen), frozen.seq_start)
        .unwrap();
    assert_eq!(
        pending.status,
        TerminalOutputEnvelopeRepairStatus::EventPending
    );
    assert!(pending.envelope.is_none());
    {
        let mut state = delivery.inner.state.lock().unwrap();
        let in_flight = state.in_flight.as_mut().unwrap();
        assert_eq!(
            (in_flight.expires_at, in_flight.repair_attempts),
            before_pending
        );
        in_flight.repair_not_before = Instant::now();
    }
    let repaired = delivery
        .repair_envelope(&identity(&frozen), frozen.seq_start)
        .unwrap();
    assert_eq!(repaired.status, TerminalOutputEnvelopeRepairStatus::Exact);
    assert_eq!(repaired.envelope.as_ref(), Some(&frozen));
    assert_eq!(
        delivery
            .acknowledge_receipt(&identity(&frozen), frozen.seq_end)
            .unwrap(),
        TerminalOutputReceiptCompletion::Accepted
    );

    delivery.enqueue(delta(cap as u64, cap)).unwrap();
    let waiting = Arc::clone(&delivery);
    let (waiter_tx, waiter_rx) = std_mpsc::channel();
    let waiter = thread::spawn(move || {
        let result = waiting.wait_for_admission((cap * 2) as u64, (cap * 2 + 1) as u64, 1);
        let _ = waiter_tx.send(result);
    });
    let admission = waiter_rx.recv_timeout(Duration::from_secs(1));
    let reason = reason_rx.recv_timeout(Duration::from_secs(1));
    // Cleanup is unconditional so a liveness regression fails instead of
    // leaving either the test waiter or injected synchronous emitter hung.
    delivery.close(TerminalOutputDeliveryCloseReason::SurfaceUnavailable);
    drop(release_tx);
    waiter.join().unwrap();
    delivery.join().unwrap();
    assert_eq!(
        admission.unwrap().unwrap(),
        TerminalOutputDeliveryAdmission::Closed
    );
    assert!(matches!(
        reason.unwrap(),
        TerminalOutputDeliveryCloseReason::EmitFailed(reason)
            if reason == "synchronous emitter call timed out"
    ));
}

#[test]
fn emit_failure_preserves_frozen_envelope_for_exact_repair() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    install(&delivery, 0);
    let (failed_tx, failed_rx) = std_mpsc::channel();
    let (reason_tx, reason_rx) = std_mpsc::channel();
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_for_emit = Arc::clone(&attempts);
    delivery
        .start(
            Arc::new(move |_: &str, envelope: &TerminalOutputDeltaEnvelopeV3| {
                attempts_for_emit.fetch_add(1, Ordering::SeqCst);
                failed_tx.send(envelope.clone()).unwrap();
                Err("injected emit loss".into())
            }),
            Arc::new(move |reason| reason_tx.send(reason).unwrap()),
        )
        .unwrap();
    delivery.enqueue(delta(0, 1)).unwrap();
    let envelope = failed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    while attempts.load(Ordering::SeqCst)
        < crate::constants::TERMINAL_OUTPUT_ENVELOPE_EMIT_MAX_ATTEMPTS
    {
        std::thread::yield_now();
    }
    assert_eq!(
        attempts.load(Ordering::SeqCst),
        crate::constants::TERMINAL_OUTPUT_ENVELOPE_EMIT_MAX_ATTEMPTS
    );
    assert!(matches!(
        reason_rx.try_recv(),
        Err(std_mpsc::TryRecvError::Empty)
    ));
    let pending = delivery
        .repair_envelope(&identity(&envelope), envelope.seq_start)
        .unwrap();
    assert_eq!(
        pending.status,
        TerminalOutputEnvelopeRepairStatus::EventPending
    );
    assert!(pending.envelope.is_none());
    {
        let mut state = delivery.inner.state.lock().unwrap();
        let in_flight = state.in_flight.as_mut().unwrap();
        assert_eq!(in_flight.repair_attempts, 0);
        in_flight.repair_not_before = Instant::now();
    }
    let repaired = delivery
        .repair_envelope(&identity(&envelope), envelope.seq_start)
        .unwrap();
    assert_eq!(repaired.status, TerminalOutputEnvelopeRepairStatus::Exact);
    assert_eq!(repaired.envelope.as_ref(), Some(&envelope));
    assert_eq!(
        delivery
            .acknowledge_receipt(&identity(&envelope), envelope.seq_end)
            .unwrap(),
        TerminalOutputReceiptCompletion::Accepted
    );
    assert_eq!(
        delivery.enqueue(delta(1, 1)).unwrap(),
        TerminalOutputDeliveryAdmission::Queued
    );
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}

#[test]
fn transient_emit_failure_retries_the_exact_same_envelope_identity_and_payload() {
    let delivery = DesktopOutputDelivery::new("t1".into(), 1);
    install(&delivery, 0);
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempts_for_emit = Arc::clone(&attempts);
    let (tx, rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |event, envelope| {
                assert_eq!(event, "terminal-output-v3-t1");
                tx.send(envelope.clone()).unwrap();
                if attempts_for_emit.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err("transient emit failure".into())
                } else {
                    Ok(())
                }
            }),
            Arc::new(|_| {}),
        )
        .unwrap();
    delivery.enqueue(delta(0, 3)).unwrap();
    let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let retried = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(retried, first);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    delivery
        .acknowledge_receipt(&identity(&retried), retried.seq_end)
        .unwrap();
    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    delivery.join().unwrap();
}
