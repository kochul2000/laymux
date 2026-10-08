use super::*;

#[test]
fn external_control_preserves_deadline_and_fifo_and_submit_as_one_job() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let record = observed.clone();
    let worker =
        PtyControlWorker::spawn_external(Arc::new(move |action, deadline, cancelled, complete| {
            assert!(!cancelled.load(Ordering::Acquire));
            record.lock().unwrap().push((action, deadline));
            complete.store(true, Ordering::Release);
            Ok(())
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let write = worker.submit_write(b"body", true, deadline).unwrap();
    let resize = worker.submit_resize(60, 20, deadline).unwrap();
    write
        .result
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    resize
        .result
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    let seen = observed.lock().unwrap();
    assert!(
        matches!(&seen[0].0, ExternalControlAction::Write { data, submit: true } if data == b"body")
    );
    assert!(matches!(
        &seen[1].0,
        ExternalControlAction::Resize { cols: 60, rows: 20 }
    ));
    assert!(seen.iter().all(|(_, actual)| *actual == deadline));
    worker.close();
}

#[test]
fn transport_failure_cannot_synthesize_physical_completion() {
    let acknowledged = Arc::new(Mutex::new(None));
    let source = acknowledged.clone();
    let worker = PtyControlWorker::spawn_external(Arc::new(move |_, _, _, complete| {
        *source.lock().unwrap() = Some(complete);
        Err("ambiguous transport outcome".into())
    }))
    .unwrap();
    let pending = worker
        .submit_write(b"do-once", false, Instant::now() + Duration::from_secs(1))
        .unwrap();
    assert!(pending
        .result
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .is_err());
    let completion = worker.completion();
    std::thread::sleep(Duration::from_millis(30));
    assert!(
        !completion.is_complete(),
        "local worker exit is not a daemon physical completion ACK"
    );
    acknowledged
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .store(true, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !completion.is_complete() {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    worker.close();
}

#[test]
fn an_ambiguous_proxy_error_keeps_the_human_owner_transition_fenced() {
    let source_ack = Arc::new(Mutex::new(None));
    let ack = source_ack.clone();
    let handle = crate::pty::PtyHandle::from_external(
        4,
        Arc::new(move |_, _, _, complete| {
            *ack.lock().unwrap() = Some(complete);
            Err("source outcome is unknown".into())
        }),
    )
    .unwrap();
    let state = crate::state::AppState::new();
    let permit = crate::remote_server::begin_human_control_operation(
        &state,
        crate::remote_server::HumanControlOrigin::Local,
        "proxy-fence",
    )
    .unwrap();
    let pending = permit
        .enqueue_pty_job(|| handle.enqueue_write(b"must-run-once", false, permit.deadline()))
        .unwrap();
    let result =
        handle.await_enqueued_control_job(pending, permit.deadline(), || permit.is_current());
    assert!(crate::commands::finish_human_control_io(permit, &handle, result).is_err());
    assert!(
        !crate::remote_server::human_control_operations_drained(&state).unwrap(),
        "an RPC error cannot release the source physical completion barrier"
    );
    source_ack
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .store(true, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !crate::remote_server::human_control_operations_drained(&state).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
}
