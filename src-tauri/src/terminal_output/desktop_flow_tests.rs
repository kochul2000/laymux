use super::*;
use crate::constants::TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES;
use std::sync::{mpsc, Arc};
use std::thread;

const TEST_DEADLINE: Duration = Duration::from_millis(25);

fn request(envelope_id: u64, grant_id: &str, frame_start_seq: u64) -> ContinuationRequest {
    ContinuationRequest {
        envelope_id,
        client_grant_id: grant_id.into(),
        frame_start_seq,
    }
}

fn attached_flow(base: usize, continuation: u64) -> (Arc<DesktopOutputFlow>, String) {
    let flow = Arc::new(DesktopOutputFlow::for_test(continuation, TEST_DEADLINE));
    let token = flow.attach(0, base).unwrap().token;
    (flow, token)
}

fn waiter(
    flow: &Arc<DesktopOutputFlow>,
    seq: u64,
) -> (mpsc::Receiver<Result<(), String>>, thread::JoinHandle<()>) {
    let flow = Arc::clone(flow);
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        tx.send(flow.wait_for_capacity(seq)).unwrap();
    });
    (rx, worker)
}

#[test]
fn bootstrap_has_only_base_credit_and_rejects_continuation() {
    let flow = Arc::new(DesktopOutputFlow::for_test(8, TEST_DEADLINE));
    flow.begin_bootstrap(4).unwrap();
    let initial = flow.diagnostics().unwrap();
    assert_eq!(initial.effective_limit, Some(4));
    assert_eq!(
        flow.open_continuation("missing", &request(1, "g1", 3), 3)
            .unwrap(),
        ContinuationCompletion::BootstrapRejected
    );
    flow.wait_for_capacity(4).unwrap();

    let (rx, worker) = waiter(&flow, 5);
    let error = rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap_err();
    assert!(error.contains("ParsedProgressExpired"));
    worker.join().unwrap();
    let diagnostics = flow.diagnostics().unwrap();
    assert_eq!(diagnostics.state, DesktopOutputState::FailStopped);
    assert_eq!(
        diagnostics.reason,
        Some(DesktopOutputFailureReason::ParsedProgressExpired)
    );
}

#[test]
fn base_512k_plus_one_byte_is_admitted_only_by_the_frame_grant() {
    let (flow, token) = attached_flow(
        TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES,
        TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES as u64,
    );
    let frame_start = TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES as u64 - 1;
    flow.wait_for_capacity(TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES as u64)
        .unwrap();
    let opened = flow
        .open_continuation(&token, &request(1, "g1", frame_start), frame_start + 1)
        .unwrap();
    assert_eq!(
        opened,
        ContinuationCompletion::Opened {
            effective_limit: frame_start + TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES as u64
        }
    );
    assert!(flow
        .wait_for_capacity(TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES as u64 + 1)
        .is_ok());
}

#[test]
fn exact_one_mib_frame_closes_and_close_reason_is_immutable() {
    let (flow, token) = attached_flow(4, 1024 * 1024);
    let grant = request(9, "exact", 2);
    flow.open_continuation(&token, &grant, 2).unwrap();
    let close_seq = 2 + 1024 * 1024;
    assert_eq!(
        flow.close_continuation(
            &token,
            &grant,
            close_seq,
            close_seq,
            ContinuationCloseReason::Terminator,
        )
        .unwrap(),
        ContinuationCompletion::Closed
    );
    assert_eq!(
        flow.close_continuation(
            &token,
            &grant,
            close_seq,
            close_seq,
            ContinuationCloseReason::Terminator,
        )
        .unwrap(),
        ContinuationCompletion::Closed
    );
    assert!(flow
        .close_continuation(
            &token,
            &grant,
            close_seq,
            close_seq,
            ContinuationCloseReason::Malformed,
        )
        .is_err());
    assert_eq!(
        flow.diagnostics().unwrap().reason,
        Some(DesktopOutputFailureReason::IdentityConflict)
    );
}

#[test]
fn malformed_timeout_and_oversized_closes_are_bounded_fail_open_outcomes() {
    for (index, reason, close_seq) in [
        (1, ContinuationCloseReason::Malformed, 4),
        (2, ContinuationCloseReason::Timeout, 5),
        (3, ContinuationCloseReason::Oversized, 11),
    ] {
        let (flow, token) = attached_flow(4, 8);
        let grant = request(index, "fail-open", 2);
        flow.open_continuation(&token, &grant, 2).unwrap();
        assert_eq!(
            flow.close_continuation(&token, &grant, close_seq, close_seq, reason)
                .unwrap(),
            ContinuationCompletion::Closed
        );
        assert_eq!(
            flow.diagnostics().unwrap().state,
            DesktopOutputState::Healthy
        );
    }
}

#[test]
fn frame_start_must_be_inside_the_current_unparsed_source_range() {
    let (future, future_token) = attached_flow(4, 8);
    assert!(future
        .open_continuation(&future_token, &request(1, "future", 3), 2)
        .is_err());
    let stopped = future.diagnostics().unwrap();
    assert_eq!(
        stopped.reason,
        Some(DesktopOutputFailureReason::IdentityConflict)
    );
    assert!(future.attach(0, 4).is_err());
    assert!(future.begin_bootstrap(4).is_err());
    assert_eq!(future.diagnostics().unwrap(), stopped);

    let flow = DesktopOutputFlow::for_test(8, TEST_DEADLINE);
    let token = flow.attach(3, 4).unwrap().token;
    assert!(flow
        .open_continuation(&token, &request(2, "parsed", 2), 3)
        .is_err());
}

#[test]
fn close_boundary_and_reason_mismatch_fail_stop_without_replay() {
    let read_overshoot = TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES as u64;
    for (index, reason, close_seq, current_seq) in [
        (1, ContinuationCloseReason::Terminator, 1, 2),
        (2, ContinuationCloseReason::Terminator, 11, 11),
        (3, ContinuationCloseReason::Oversized, 10, 10),
        (
            4,
            ContinuationCloseReason::Oversized,
            10 + read_overshoot + 1,
            10 + read_overshoot + 1,
        ),
        (5, ContinuationCloseReason::Malformed, 5, 4),
    ] {
        let (flow, token) = attached_flow(4, 8);
        let grant = request(index, "invalid-close", 2);
        flow.open_continuation(&token, &grant, 2).unwrap();
        assert!(flow
            .close_continuation(&token, &grant, close_seq, current_seq, reason)
            .is_err());
        assert_eq!(
            flow.diagnostics().unwrap().reason,
            Some(DesktopOutputFailureReason::IdentityConflict)
        );
    }
}

#[test]
fn lost_close_expires_the_grant_and_wakes_every_waiter() {
    let (flow, token) = attached_flow(4, 8);
    flow.open_continuation(&token, &request(1, "lost", 2), 2)
        .unwrap();
    flow.wait_for_capacity(10).unwrap();
    let (first_rx, first) = waiter(&flow, 11);
    let (second_rx, second) = waiter(&flow, 11);

    for rx in [first_rx, second_rx] {
        let error = rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err();
        assert!(error.contains("ContinuationExpired"));
    }
    first.join().unwrap();
    second.join().unwrap();
    assert_eq!(
        flow.diagnostics().unwrap().reason,
        Some(DesktopOutputFailureReason::ContinuationExpired)
    );
}

#[test]
fn late_lower_ack_on_the_active_lease_is_a_stale_no_op() {
    let (flow, token) = attached_flow(4, 8);
    assert!(flow.acknowledge(&token, 3, 4).unwrap());

    // The frontend's in-place ACK retry can deliver a timed-out duplicate
    // after its replacement already advanced the frontier. It must neither
    // regress the frontier nor trip the delivery contract.
    assert!(flow.acknowledge(&token, 1, 4).unwrap());
    let diagnostics = flow.diagnostics().unwrap();
    assert_eq!(diagnostics.parsed_ack, Some(3));
    assert_eq!(diagnostics.state, DesktopOutputState::Healthy);

    assert!(flow.acknowledge(&token, 4, 4).unwrap());
    assert_eq!(flow.diagnostics().unwrap().parsed_ack, Some(4));
}

#[test]
fn parsed_progress_expiry_is_cancelled_and_rearmed_on_monotonic_ack() {
    let (flow, token) = attached_flow(4, 8);
    let (rx, worker) = waiter(&flow, 5);
    thread::sleep(Duration::from_millis(5));
    assert!(flow.acknowledge(&token, 1, 4).unwrap());
    rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
    worker.join().unwrap();
    assert_eq!(
        flow.diagnostics().unwrap().state,
        DesktopOutputState::Healthy
    );

    let (expired_rx, expired) = waiter(&flow, 6);
    let error = expired_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap_err();
    assert!(error.contains("ParsedProgressExpired"));
    expired.join().unwrap();
}

#[test]
fn retirement_wakes_a_blocked_waiter_without_fail_stop() {
    let (flow, _) = attached_flow(4, 8);
    let (rx, worker) = waiter(&flow, 5);
    thread::sleep(Duration::from_millis(5));
    flow.retire();
    rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
    worker.join().unwrap();
    assert!(flow.is_retired());
}

#[test]
fn stale_completion_does_not_mutate_current_grant() {
    let (flow, token) = attached_flow(4, 8);
    let current = request(2, "current", 2);
    flow.open_continuation(&token, &current, 2).unwrap();
    let before = flow.diagnostics().unwrap();

    assert_eq!(
        flow.close_continuation(
            "stale-token",
            &request(1, "old", 0),
            1,
            1,
            ContinuationCloseReason::Timeout,
        )
        .unwrap(),
        ContinuationCompletion::Stale
    );
    assert_eq!(flow.diagnostics().unwrap(), before);
    assert!(flow.wait_for_capacity(9).is_ok());
}

#[test]
fn same_close_identity_with_changed_frame_start_fail_stops() {
    let (flow, token) = attached_flow(4, 8);
    flow.open_continuation(&token, &request(4, "same", 2), 2)
        .unwrap();
    assert!(flow
        .close_continuation(
            &token,
            &request(4, "same", 3),
            4,
            4,
            ContinuationCloseReason::Malformed,
        )
        .is_err());
    assert_eq!(
        flow.diagnostics().unwrap().reason,
        Some(DesktopOutputFailureReason::IdentityConflict)
    );
}

#[test]
fn grant_retry_is_idempotent_but_same_operation_key_conflict_fail_stops() {
    let (flow, token) = attached_flow(4, 8);
    let original = request(3, "same", 2);
    let opened = flow.open_continuation(&token, &original, 2).unwrap();
    assert_eq!(
        flow.open_continuation(&token, &original, 2).unwrap(),
        match opened {
            ContinuationCompletion::Opened { effective_limit } => {
                ContinuationCompletion::Duplicate { effective_limit }
            }
            _ => unreachable!(),
        }
    );
    assert!(flow.acknowledge(&token, 3, 3).unwrap());
    assert!(matches!(
        flow.open_continuation(&token, &original, 3).unwrap(),
        ContinuationCompletion::Duplicate { .. }
    ));
    let conflicting = request(3, "same", 3);
    assert!(flow.open_continuation(&token, &conflicting, 3).is_err());
    assert_eq!(
        flow.diagnostics().unwrap().reason,
        Some(DesktopOutputFailureReason::IdentityConflict)
    );
}

#[test]
fn active_grant_blocks_attach_and_preserves_the_token() {
    let (flow, token) = attached_flow(4, 8);
    flow.open_continuation(&token, &request(1, "g1", 2), 2)
        .unwrap();
    let before = flow.diagnostics().unwrap();
    assert!(flow.attach(0, 4).is_err());
    assert_eq!(flow.diagnostics().unwrap(), before);
}

#[test]
fn attach_starts_with_the_first_envelope_identity() {
    let flow = DesktopOutputFlow::for_test(8, TEST_DEADLINE);
    let control = flow.attach(0, 4).unwrap();
    assert_eq!(control.next_envelope_id, 1);
}

#[test]
fn delivery_watchdog_fail_stops_only_while_the_grant_is_still_active() {
    let (flow, token) = attached_flow(4, 8);
    let grant = request(1, "g1", 2);
    flow.open_continuation(&token, &grant, 2).unwrap();
    assert!(flow.fail_stop_expired_continuation().unwrap());
    assert_eq!(
        flow.diagnostics().unwrap().reason,
        Some(DesktopOutputFailureReason::ContinuationExpired)
    );

    let (closed, token) = attached_flow(4, 8);
    let grant = request(1, "g1", 2);
    closed.open_continuation(&token, &grant, 2).unwrap();
    closed
        .close_continuation(&token, &grant, 3, 3, ContinuationCloseReason::Terminator)
        .unwrap();
    assert!(!closed.fail_stop_expired_continuation().unwrap());
    assert_eq!(
        closed.diagnostics().unwrap().state,
        DesktopOutputState::Healthy
    );
}
