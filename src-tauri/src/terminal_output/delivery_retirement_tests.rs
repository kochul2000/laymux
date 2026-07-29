use super::*;

#[test]
fn retirement_publishes_closed_while_emitter_is_pending_then_joins() {
    let delivery = Arc::new(DesktopOutputDelivery::new("t1".into(), 1));
    install(&delivery, 0);
    let (entered_tx, entered_rx) = std_mpsc::channel();
    let (release_tx, release_rx) = std_mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let release_for_emit = Arc::clone(&release_rx);
    let (reason_tx, reason_rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_: &str, _: &TerminalOutputDeltaEnvelopeV3| {
                entered_tx.send(()).unwrap();
                release_for_emit.lock().unwrap().recv().unwrap();
                Ok(())
            }),
            Arc::new(move |reason| {
                reason_tx.send(reason).unwrap();
            }),
        )
        .unwrap();
    delivery.enqueue(delta(0, 1)).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    let closing = Arc::clone(&delivery);
    let (closed_tx, closed_rx) = std_mpsc::channel();
    let closer = thread::spawn(move || {
        closing.close(TerminalOutputDeliveryCloseReason::Retired);
        closed_tx.send(()).unwrap();
    });
    closed_rx.recv_timeout(Duration::from_millis(30)).unwrap();
    assert_eq!(
        delivery.enqueue(delta(1, 1)).unwrap(),
        TerminalOutputDeliveryAdmission::Closed
    );
    assert_eq!(
        reason_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputDeliveryCloseReason::Retired
    );
    release_tx.send(()).unwrap();
    closer.join().unwrap();
    delivery.join().unwrap();
}

#[test]
fn stuck_emitter_has_a_typed_bounded_shutdown_failure_and_wakes_waiters() {
    let delivery =
        DesktopOutputDelivery::with_test_timeouts("stuck".into(), 1, Duration::from_millis(20));
    install(&delivery, 0);
    let (entered_tx, entered_rx) = std_mpsc::channel();
    let (release_tx, release_rx) = std_mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let release_for_emit = Arc::clone(&release_rx);
    let (exited_tx, exited_rx) = std_mpsc::channel();
    let (reason_tx, reason_rx) = std_mpsc::channel();
    delivery
        .start(
            Arc::new(move |_, _| {
                entered_tx.send(()).unwrap();
                let _ = release_for_emit.lock().unwrap().recv();
                exited_tx.send(()).unwrap();
                Ok(())
            }),
            Arc::new(move |reason| reason_tx.send(reason).unwrap()),
        )
        .unwrap();
    delivery.enqueue(delta(0, 1)).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    delivery.close(TerminalOutputDeliveryCloseReason::Retired);
    assert_eq!(
        delivery.enqueue(delta(1, 1)).unwrap(),
        TerminalOutputDeliveryAdmission::Closed
    );
    assert_eq!(
        reason_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputDeliveryCloseReason::Retired
    );
    let error = delivery.join().unwrap_err();
    assert!(error.contains("worker shutdown timed out"));
    assert_eq!(
        reason_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputDeliveryCloseReason::WorkerShutdownTimedOut
    );
    assert_eq!(delivery.join().unwrap_err(), error);

    release_tx.send(()).unwrap();
    exited_rx.recv_timeout(Duration::from_secs(1)).unwrap();
}
