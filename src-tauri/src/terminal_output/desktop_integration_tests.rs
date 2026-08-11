use std::sync::{mpsc as std_mpsc, Arc};
use std::time::Duration;

use super::desktop_integration::{delivery_reason_code, delivery_reason_detail};
use super::*;
use crate::constants::{
    TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES, TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
};

fn live_session() -> (
    Arc<TerminalOutputSession>,
    std_mpsc::Receiver<TerminalOutputDeltaEnvelopeV3>,
) {
    let session = Arc::new(TerminalOutputSession::new(
        "t1".into(),
        1,
        TerminalOutputBuffer::default(),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    let (tx, rx) = std_mpsc::channel();
    session
        .start_desktop_output_delivery(Arc::new(move |event, envelope| {
            assert_eq!(event, "terminal-output-v3-t1");
            tx.send(envelope.clone()).unwrap();
            Ok(())
        }))
        .unwrap();
    session
        .begin_desktop_output_bootstrap(TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES)
        .unwrap();
    (session, rx)
}

fn identity(envelope: &TerminalOutputDeltaEnvelopeV3) -> TerminalOutputEnvelopeIdentity {
    TerminalOutputEnvelopeIdentity {
        generation: envelope.generation,
        lease_token: envelope.lease_token.clone(),
        envelope_id: envelope.envelope_id,
        grant_id: envelope.grant_id.clone(),
    }
}

#[test]
fn session_attach_and_controls_project_closing_envelope_to_the_opener_grant() {
    let (session, rx) = live_session();
    session.record_desktop_output(b"boot").unwrap();
    let attached = session
        .attach_desktop(
            TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
            TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
        )
        .unwrap();
    assert_eq!(attached.attachment.snapshot, b"boot");
    assert_eq!(attached.attachment.state.snapshot_start_seq, 0);
    assert_eq!(attached.flow_control.next_envelope_id, 1);

    session.record_desktop_output(b"open").unwrap();
    let opener = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let before_hold = session.desktop_output_diagnostics().unwrap();
    assert_eq!(before_hold.generation, 1);
    assert_eq!(before_hold.write_seq, opener.seq_end);
    assert_eq!(
        before_hold.receipt_slot.as_ref().unwrap().envelope_id,
        opener.envelope_id
    );
    let frame_start = opener.seq_start + 1;
    assert!(session
        .hold_desktop_continuation(
            opener.generation,
            &opener.lease_token,
            opener.envelope_id,
            "grant-1",
            frame_start,
        )
        .unwrap());
    assert!(session
        .hold_desktop_continuation(
            opener.generation,
            &opener.lease_token,
            opener.envelope_id,
            "grant-1",
            frame_start,
        )
        .unwrap());
    let held = session.desktop_output_diagnostics().unwrap();
    assert_eq!(held.active_grant_id.as_deref(), Some("grant-1"));
    assert!(session
        .acknowledge_desktop_envelope(&identity(&opener), opener.seq_end)
        .unwrap());

    session.record_desktop_output(b"close").unwrap();
    let closing = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_ne!(closing.envelope_id, opener.envelope_id);
    assert_eq!(closing.grant_id.as_deref(), Some("grant-1"));
    assert!(session
        .close_desktop_continuation(
            closing.generation,
            &closing.lease_token,
            closing.envelope_id,
            "grant-1",
            closing.seq_end,
            "close",
        )
        .unwrap());
    assert!(session
        .close_desktop_continuation(
            closing.generation,
            &closing.lease_token,
            closing.envelope_id,
            "grant-1",
            closing.seq_end,
            "close",
        )
        .unwrap());
    assert!(session
        .acknowledge_desktop_envelope(&identity(&closing), closing.seq_end)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(closing.generation, &closing.lease_token, closing.seq_end,)
        .unwrap());

    session.record_desktop_output(b"after").unwrap();
    let after = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(after.grant_id, None);
    session.retire(false).unwrap();
}

#[test]
fn late_lower_parsed_ack_is_absorbed_without_a_contract_fault() {
    let (session, rx) = live_session();
    session
        .attach_desktop(
            TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
            TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
        )
        .unwrap();

    session.record_desktop_output(b"first").unwrap();
    let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(session
        .acknowledge_desktop_envelope(&identity(&first), first.seq_end)
        .unwrap());
    session.record_desktop_output(b"second").unwrap();
    let second = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(session
        .acknowledge_desktop_envelope(&identity(&second), second.seq_end)
        .unwrap());

    // The frontend's in-place ACK retry (ADR-0095 control liveness) can let a
    // replacement ACK for a newer prefix land before the timed-out original.
    assert!(session
        .acknowledge_desktop_output(second.generation, &second.lease_token, second.seq_end)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(first.generation, &first.lease_token, first.seq_end)
        .unwrap());
    // An exact duplicate of the current frontier stays idempotent as well.
    assert!(session
        .acknowledge_desktop_output(second.generation, &second.lease_token, second.seq_end)
        .unwrap());

    let diagnostics = session.desktop_output_diagnostics().unwrap();
    assert_eq!(diagnostics.desktop_output_state, "healthy");
    assert_eq!(diagnostics.parsed_ack, Some(second.seq_end));

    // Delivery is still alive on the same generation and lease.
    session.record_desktop_output(b"after").unwrap();
    let after = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(after.lease_token, second.lease_token);
    session.retire(false).unwrap();
}

#[test]
fn timeout_abort_closes_from_last_receipt_while_old_grant_successor_is_in_flight() {
    let (session, rx) = live_session();
    let attached = session
        .attach_desktop(
            TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
            TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
        )
        .unwrap();

    session.record_desktop_output(b"open").unwrap();
    let opener = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(session
        .hold_desktop_continuation(
            opener.generation,
            &opener.lease_token,
            opener.envelope_id,
            "grant-timeout",
            opener.seq_start,
        )
        .unwrap());
    assert!(session
        .acknowledge_desktop_envelope(&identity(&opener), opener.seq_end)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(opener.generation, &opener.lease_token, opener.seq_end)
        .unwrap());

    // The backend may emit one old-grant successor after the last receipt and
    // before the frontend's timeout close command arrives.
    session.record_desktop_output(b"body").unwrap();
    let old_grant_successor = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        old_grant_successor.grant_id.as_deref(),
        Some("grant-timeout")
    );
    assert!(session
        .close_desktop_continuation(
            opener.generation,
            &opener.lease_token,
            opener.envelope_id,
            "grant-timeout",
            opener.seq_end,
            "abort:timeout",
        )
        .unwrap());
    assert!(session
        .acknowledge_desktop_envelope(&identity(&old_grant_successor), old_grant_successor.seq_end,)
        .unwrap());
    assert!(session
        .acknowledge_desktop_output(
            old_grant_successor.generation,
            &old_grant_successor.lease_token,
            old_grant_successor.seq_end,
        )
        .unwrap());

    session.record_desktop_output(b"after").unwrap();
    let after = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(after.grant_id, None);
    assert_eq!(attached.flow_control.token, after.lease_token);
    session
        .acknowledge_desktop_envelope(&identity(&after), after.seq_end)
        .unwrap();
    session.retire(false).unwrap();
}

#[test]
fn emitter_failure_is_repaired_from_the_frozen_envelope() {
    let session = Arc::new(TerminalOutputSession::new(
        "failed".into(),
        1,
        TerminalOutputBuffer::default(),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    session
        .start_desktop_output_delivery(Arc::new(|_, _| Err("injected emit failure".into())))
        .unwrap();
    session
        .begin_desktop_output_bootstrap(TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES)
        .unwrap();
    session
        .attach_desktop(
            TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
            TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
        )
        .unwrap();
    session.record_desktop_output(b"retained").unwrap();
    let mut slot = None;
    for _ in 0..100 {
        slot = session.desktop_output_diagnostics().unwrap().receipt_slot;
        if slot.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let slot = slot.expect("failed emit must retain a repairable receipt slot");
    let in_flight = TerminalOutputEnvelopeIdentity {
        generation: slot.generation,
        lease_token: slot.lease_token,
        envelope_id: slot.envelope_id,
        grant_id: slot.grant_id,
    };
    let pending = session.repair_desktop_envelope(&in_flight, 0).unwrap();
    assert_eq!(
        pending.status,
        TerminalOutputEnvelopeRepairStatus::EventPending
    );
    assert!(pending.envelope.is_none());
    session
        .desktop_delivery
        .inner
        .state
        .lock()
        .unwrap()
        .in_flight
        .as_mut()
        .unwrap()
        .repair_not_before = std::time::Instant::now();
    let repaired = session.repair_desktop_envelope(&in_flight, 0).unwrap();
    assert_eq!(repaired.status, TerminalOutputEnvelopeRepairStatus::Exact);
    let envelope = repaired.envelope.unwrap();
    assert_eq!(envelope.data, b"retained");
    assert!(session
        .acknowledge_desktop_envelope(&identity(&envelope), envelope.seq_end)
        .unwrap());
    assert_eq!(session.delivery_failure(), None);
    assert_eq!(session.output.write_seq().unwrap(), 8);
    assert_eq!(
        session
            .attach(TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES)
            .unwrap()
            .snapshot,
        b"retained"
    );
    assert!(session.record_desktop_output(b"admitted").is_ok());
    assert_eq!(session.output.write_seq().unwrap(), 16);
    session.retire(false).unwrap();
}

#[test]
fn incomplete_desktop_snapshot_is_typed_and_never_clamped() {
    let session = Arc::new(TerminalOutputSession::new(
        "snapshot-gap".into(),
        1,
        TerminalOutputBuffer::new(4),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    session
        .start_desktop_output_delivery(Arc::new(|_, _| Ok(())))
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();
    session.record_output(b"12345678").unwrap();
    assert!(session.attach_desktop(32, 32).is_err());
    let diagnostics = session.desktop_output_diagnostics().unwrap();
    assert_eq!(diagnostics.ring_start_seq, 4);
    assert_eq!(diagnostics.write_seq, 8);
    assert_eq!(
        diagnostics.reason.as_deref(),
        Some("desktop_snapshot_incomplete")
    );
    session.retire(false).unwrap();
}

#[test]
fn delivery_install_failure_fail_stops_both_attach_projections() {
    let session = Arc::new(TerminalOutputSession::new(
        "attach-projection".into(),
        1,
        TerminalOutputBuffer::default(),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    session
        .start_desktop_output_delivery(Arc::new(|_, _| Ok(())))
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();

    // Force the delivery projection ahead of the exact empty ring snapshot.
    // Flow attach succeeds first; install failure must close both projections
    // instead of leaving two live tokens/frontiers behind.
    session
        .desktop_delivery
        .inner
        .state
        .lock()
        .unwrap()
        .observed_seq = 1;
    let error = session.attach_desktop(32, 32).unwrap_err();
    assert!(error.contains("flow/delivery projection failed"));
    assert!(session.is_terminal_output_retired());
    let diagnostics = session.desktop_output_diagnostics().unwrap();
    assert_eq!(diagnostics.desktop_output_state, "failStopped");
    assert_eq!(diagnostics.reason.as_deref(), Some("identity_conflict"));
    session.retire(false).unwrap();
}

#[test]
fn surface_fail_stop_accepts_only_current_identity_and_notifies_once() {
    let session = Arc::new(TerminalOutputSession::new(
        "surface-stop".into(),
        7,
        TerminalOutputBuffer::default(),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    let (notice_tx, notice_rx) = std_mpsc::channel();
    session
        .start_desktop_output_delivery_with_notifier(
            Arc::new(|_, _| Ok(())),
            Arc::new(move |notice| notice_tx.send(notice.clone()).unwrap()),
        )
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();
    let attached = session.attach_desktop(32, 32).unwrap();
    let token = attached.flow_control.token;

    assert!(session
        .fail_stop_desktop_surface(7, &token, "not-allowed")
        .is_err());
    assert!(!session
        .fail_stop_desktop_surface(8, &token, "surface_unavailable")
        .unwrap());
    assert!(!session
        .fail_stop_desktop_surface(7, "stale-token", "surface_unavailable")
        .unwrap());
    assert!(notice_rx.recv_timeout(Duration::from_millis(30)).is_err());

    assert!(session
        .fail_stop_desktop_surface(7, &token, "control_orphan_cap")
        .unwrap());
    let notice = notice_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        notice,
        TerminalOutputFailStopNotice {
            terminal_id: "surface-stop".into(),
            generation: 7,
            lease_token: Some(token.clone()),
            reason: "control_orphan_cap".into(),
        }
    );
    assert_eq!(
        serde_json::to_value(&notice).unwrap(),
        serde_json::json!({
            "terminalId": "surface-stop",
            "generation": 7,
            "leaseToken": token,
            "reason": "control_orphan_cap",
        })
    );
    assert_eq!(
        session
            .desktop_output_diagnostics()
            .unwrap()
            .reason
            .as_deref(),
        Some("control_orphan_cap")
    );

    assert!(session
        .fail_stop_desktop_surface(7, &token, "surface_unavailable")
        .unwrap());
    super::delivery_worker::publish_worker_shutdown_timeout(&session.desktop_delivery.inner);
    assert!(notice_rx.recv_timeout(Duration::from_millis(30)).is_err());
    assert_eq!(
        session
            .desktop_output_diagnostics()
            .unwrap()
            .reason
            .as_deref(),
        Some("control_orphan_cap")
    );
    session.retire(false).unwrap();
}

#[test]
fn production_v3_parsed_ack_error_cannot_fall_back_to_a_legacy_prefix() {
    let session = Arc::new(TerminalOutputSession::new(
        "parsed-ack".into(),
        1,
        TerminalOutputBuffer::default(),
        TerminalGeometry::default(),
    ));
    session.commit_creation().unwrap();
    let (notice_tx, notice_rx) = std_mpsc::channel();
    session
        .start_desktop_output_delivery_with_notifier(
            Arc::new(|_, _| Ok(())),
            Arc::new(move |notice| notice_tx.send(notice.clone()).unwrap()),
        )
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();
    let attached = session.attach_desktop(32, 32).unwrap();
    session.record_desktop_output(b"v3").unwrap();

    let error = session
        .acknowledge_desktop_output(
            session.generation(),
            &attached.flow_control.token,
            attached.attachment.state.snapshot_seq + 4,
        )
        .unwrap_err();
    assert!(error.contains("parsed ACK validation failed"));
    assert!(error.contains("legacy parsed ACK is unavailable on a production v3 lease"));
    let diagnostics = session.desktop_output_diagnostics().unwrap();
    assert_eq!(diagnostics.desktop_output_state, "failStopped");
    assert_eq!(diagnostics.reason.as_deref(), Some("identity_conflict"));
    let notice = notice_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(notice.terminal_id, "parsed-ack");
    assert_eq!(notice.lease_token, Some(attached.flow_control.token));
    assert_eq!(notice.reason, "identity_conflict");
    assert!(notice_rx.recv_timeout(Duration::from_millis(30)).is_err());
    session.retire(false).unwrap();
}

#[test]
fn receipt_flow_projection_failure_is_sticky_for_exact_retries() {
    let (session, rx) = live_session();
    session.attach_desktop(32, 32).unwrap();
    session.record_desktop_output(b"receipt").unwrap();
    let envelope = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let identity = identity(&envelope);

    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        session.desktop_flow.poison_for_test();
    }))
    .is_err());

    let first = session
        .acknowledge_desktop_envelope(&identity, envelope.seq_end)
        .unwrap_err();
    let retry = session
        .acknowledge_desktop_envelope(&identity, envelope.seq_end)
        .unwrap_err();
    assert_eq!(retry, first);
    assert!(first.contains("receipt flow projection failed"));
    // The contract failure keeps the reported code stable while carrying the
    // message that names it. Assert the observable pair, not the enum variant:
    // `reason` alone cannot distinguish this from a real identity conflict.
    let failure = session.delivery_failure().unwrap();
    assert_eq!(delivery_reason_code(&failure), "identity_conflict");
    assert_eq!(
        delivery_reason_detail(&failure).as_deref(),
        Some(first.as_str())
    );
    // `desktop_output_diagnostics()` is not reachable here: this test poisons the
    // flow lock on purpose, and reading it is what fails. The endpoint-level
    // projection of the same pair is covered in
    // `automation_server::terminal_output_diagnostics`.
    session.retire(false).unwrap();
}
