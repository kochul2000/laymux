use super::*;

use std::collections::VecDeque;

#[derive(Default)]
struct FakeAdapter {
    capability: ProvenanceCapability,
    drains: VecDeque<Vec<Vec<u8>>>,
    outcomes: VecDeque<PhysicalResizeOutcome>,
    calls: Vec<&'static str>,
    release_count: usize,
    boundary_bias: u64,
    abort_fails: bool,
}

impl FakeAdapter {
    fn proven() -> Self {
        Self {
            capability: ProvenanceCapability::ProducerFreezeAndDrain,
            ..Self::default()
        }
    }
}

impl PtyGeometryProvenanceAdapter for FakeAdapter {
    fn capability(&self) -> ProvenanceCapability {
        self.capability
    }

    fn freeze_and_drain(
        &mut self,
        starting_seq: u64,
        on_old_output: &mut dyn FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<u64, String> {
        self.calls.push("freeze_and_drain");
        let mut boundary = starting_seq;
        for chunk in self.drains.pop_front().unwrap_or_default() {
            on_old_output(&chunk)?;
            boundary += chunk.len() as u64;
        }
        Ok(boundary + self.boundary_bias)
    }

    fn abort_prepared(&mut self) -> Result<(), String> {
        self.calls.push("abort_prepared");
        if self.abort_fails {
            Err("abort acknowledgement unavailable".into())
        } else {
            Ok(())
        }
    }

    fn apply_resize(&mut self, _geometry: TerminalGeometry) -> PhysicalResizeOutcome {
        self.calls.push("apply_resize");
        self.outcomes
            .pop_front()
            .unwrap_or(PhysicalResizeOutcome::Applied)
    }

    fn release(&mut self) -> Result<(), String> {
        self.calls.push("release");
        self.release_count += 1;
        Ok(())
    }

    fn teardown(&mut self) -> Result<(), String> {
        self.calls.push("teardown");
        Ok(())
    }
}

fn participant(id: &str, role: GeometryParticipantRole) -> GeometryParticipant {
    GeometryParticipant {
        id: id.into(),
        role,
    }
}

fn local_request(source_seq: u64) -> GeometryPrepareRequest {
    GeometryPrepareRequest {
        generation: 7,
        owner_kind: GeometryOwnerKind::Local,
        owner_epoch: 11,
        participants: vec![
            participant("pc-visible", GeometryParticipantRole::PcVisible),
            participant("checkpoint", GeometryParticipantRole::RendererCheckpoint),
        ],
        source_seq,
        old_geometry: TerminalGeometry::new(80, 24, 3).unwrap(),
        proposed_geometry: TerminalGeometry::new(120, 40, 4).unwrap(),
    }
}

fn remote_request(source_seq: u64) -> GeometryPrepareRequest {
    GeometryPrepareRequest {
        generation: 7,
        owner_kind: GeometryOwnerKind::Remote,
        owner_epoch: 12,
        participants: vec![
            participant("browser", GeometryParticipantRole::RemoteBrowser),
            participant("checkpoint", GeometryParticipantRole::RendererCheckpoint),
        ],
        source_seq,
        old_geometry: TerminalGeometry::new(80, 24, 3).unwrap(),
        proposed_geometry: TerminalGeometry::new(100, 30, 4).unwrap(),
    }
}

#[test]
fn production_capability_is_fail_closed_and_points_to_the_adapter_followup() {
    let capabilities = production_geometry_capabilities();
    assert!(!capabilities.exact_geometry_cutover);
    assert!(!capabilities.interruptible_read);
    assert_eq!(capabilities.follow_up_issue, 636);
    assert!(reject_unavailable_exact_geometry().is_err());
}

#[test]
fn unsupported_adapter_rejects_before_freeze_or_physical_resize() {
    let adapter = FakeAdapter::default();
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let err = coordinator
        .prepare(local_request(0), |_| Ok(()))
        .unwrap_err();
    assert_eq!(err, GeometryTransactionError::Unsupported);
    assert!(coordinator.adapter().calls.is_empty());
    assert_eq!(coordinator.phase(), GeometryTransactionPhase::Idle);
}

#[test]
fn adapter_cannot_claim_an_undelivered_source_boundary() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![b"old".to_vec()]);
    adapter.boundary_bias = 1;
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let error = coordinator
        .prepare(local_request(10), |_| Ok(()))
        .unwrap_err();
    assert!(matches!(
        error,
        GeometryTransactionError::AdapterFailure(message)
            if message.contains("delivered old prefix")
    ));
    assert_eq!(
        coordinator.adapter().calls,
        vec!["freeze_and_drain", "abort_prepared"]
    );
}

#[test]
fn queued_inflight_and_freeze_race_bytes_are_delivered_as_old_before_prepared() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![
        b"queued-old".to_vec(),
        b"inflight-before-callback".to_vec(),
        b"freeze-race-writer".to_vec(),
    ]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let mut delivered = Vec::new();
    let prepared = coordinator
        .prepare(local_request(10), |chunk| {
            delivered.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();

    assert_eq!(
        delivered,
        b"queued-oldinflight-before-callbackfreeze-race-writer"
    );
    assert_eq!(
        prepared.boundary_seq,
        Some(10 + u64::try_from(delivered.len()).unwrap())
    );
    assert_eq!(prepared.outcome, GeometryTransactionOutcome::Prepared);
    assert_eq!(coordinator.phase(), GeometryTransactionPhase::Prepared);
}

#[test]
fn split_control_strings_and_dec2026_frame_fail_prepare_without_physical_call() {
    let cases = [
        vec![b"\x1b".to_vec(), b"]title".to_vec()],
        vec![b"\x1b[31".to_vec()],
        vec![b"\x1bPpayload".to_vec()],
        vec![b"\x1b_payload".to_vec()],
        vec![b"\x1b^payload".to_vec()],
        vec![b"\x1bXpayload".to_vec()],
        vec![b"\x1b[?2026hframe".to_vec()],
    ];

    for chunks in cases {
        let mut adapter = FakeAdapter::proven();
        adapter.drains.push_back(chunks);
        let mut coordinator = PtyGeometryCoordinator::new(adapter);
        let status = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
        assert_eq!(status.outcome, GeometryTransactionOutcome::NotApplied);
        assert_eq!(
            coordinator.adapter().calls,
            vec!["freeze_and_drain", "abort_prepared"]
        );
    }
}

#[test]
fn failed_abort_keeps_the_transaction_quarantined_until_teardown() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![b"\x1b]open".to_vec()]);
    adapter.abort_fails = true;
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let status = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
    assert_eq!(status.outcome, GeometryTransactionOutcome::Indeterminate);
    assert_eq!(coordinator.phase(), GeometryTransactionPhase::Indeterminate);
    assert_eq!(coordinator.adapter().release_count, 0);

    let retired = coordinator.retire().unwrap();
    assert_eq!(retired.outcome, GeometryTransactionOutcome::Retired);
    assert_eq!(coordinator.adapter().calls.last(), Some(&"teardown"));
}

#[test]
fn complete_split_sequences_and_closed_dec2026_frame_can_prepare() {
    let chunks = vec![
        b"\x1b]title\x1b".to_vec(),
        b"\\\x1b[?2026hframe\x1b[?2026".to_vec(),
        b"l\x1bPdata\x1b\\".to_vec(),
    ];
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(chunks);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let status = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
    assert_eq!(status.outcome, GeometryTransactionOutcome::Prepared);
}

#[test]
fn terminal_resets_close_an_open_dec2026_frame() {
    for reset in [b"\x1bc".as_slice(), b"\x1b[!p".as_slice()] {
        let mut adapter = FakeAdapter::proven();
        adapter
            .drains
            .push_back(vec![b"\x1b[?2026hframe".to_vec(), reset.to_vec()]);
        let mut coordinator = PtyGeometryCoordinator::new(adapter);
        let status = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
        assert_eq!(status.outcome, GeometryTransactionOutcome::Prepared);
    }
}

#[test]
fn local_requires_visible_and_checkpoint_prefix_then_adoption_intersection() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![b"old".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let prepared = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
    let token = prepared.token.unwrap();
    let boundary = prepared.boundary_seq.unwrap();

    coordinator
        .ack_old_prefix(token, "pc-visible", boundary)
        .unwrap();
    assert_eq!(
        coordinator.apply(token).unwrap_err(),
        GeometryTransactionError::MissingParticipantAcknowledgement
    );
    coordinator
        .ack_old_prefix(token, "checkpoint", boundary)
        .unwrap();
    let applied = coordinator.apply(token).unwrap();
    assert_eq!(
        applied.outcome,
        GeometryTransactionOutcome::AppliedAwaitingAdoption
    );
    assert_eq!(coordinator.adapter().release_count, 0);

    coordinator
        .ack_adoption(token, "pc-visible", applied.geometry.unwrap().revision)
        .unwrap();
    assert_eq!(coordinator.adapter().release_count, 0);
    let released = coordinator
        .ack_adoption(token, "checkpoint", applied.geometry.unwrap().revision)
        .unwrap();
    assert_eq!(released.outcome, GeometryTransactionOutcome::Released);
    assert_eq!(coordinator.adapter().release_count, 1);
}

#[test]
fn remote_quorum_never_accepts_pc_visible_or_wire_offset_ack() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![b"old".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let prepared = coordinator.prepare(remote_request(50), |_| Ok(())).unwrap();
    let token = prepared.token.unwrap();
    let boundary = prepared.boundary_seq.unwrap();

    assert_eq!(
        coordinator
            .ack_old_prefix(token, "pc-visible", boundary)
            .unwrap_err(),
        GeometryTransactionError::UnknownParticipant
    );
    assert_eq!(
        coordinator
            .ack_old_prefix(token, "browser", boundary + 500)
            .unwrap_err(),
        GeometryTransactionError::SourceSequenceMismatch
    );
    coordinator
        .ack_old_prefix(token, "browser", boundary)
        .unwrap();
    coordinator
        .ack_old_prefix(token, "checkpoint", boundary)
        .unwrap();
    assert_eq!(
        coordinator.apply(token).unwrap().outcome,
        GeometryTransactionOutcome::AppliedAwaitingAdoption
    );
}

#[test]
fn apply_and_adoption_response_loss_are_idempotent_and_release_once() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let prepared = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
    let token = prepared.token.unwrap();
    for id in ["pc-visible", "checkpoint"] {
        coordinator.ack_old_prefix(token, id, 0).unwrap();
    }
    let first = coordinator.apply(token).unwrap();
    let replay = coordinator.apply(token).unwrap();
    assert_eq!(first, replay);
    assert_eq!(
        coordinator
            .adapter()
            .calls
            .iter()
            .filter(|call| **call == "apply_resize")
            .count(),
        1
    );

    let revision = first.geometry.unwrap().revision;
    coordinator
        .ack_adoption(token, "pc-visible", revision)
        .unwrap();
    let released = coordinator
        .ack_adoption(token, "checkpoint", revision)
        .unwrap();
    let replay = coordinator
        .ack_adoption(token, "checkpoint", revision)
        .unwrap();
    assert_eq!(released, replay);
    assert_eq!(coordinator.adapter().release_count, 1);
    assert_eq!(coordinator.status(token).unwrap(), released);
}

#[test]
fn physical_outcomes_never_guess_old_or_new_geometry() {
    for (physical, expected) in [
        (
            PhysicalResizeOutcome::NotApplied,
            GeometryTransactionOutcome::NotApplied,
        ),
        (
            PhysicalResizeOutcome::Indeterminate,
            GeometryTransactionOutcome::Indeterminate,
        ),
    ] {
        let mut adapter = FakeAdapter::proven();
        adapter.drains.push_back(vec![]);
        adapter.outcomes.push_back(physical);
        let mut coordinator = PtyGeometryCoordinator::new(adapter);
        let prepared = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
        let token = prepared.token.unwrap();
        for id in ["pc-visible", "checkpoint"] {
            coordinator.ack_old_prefix(token, id, 0).unwrap();
        }
        let status = coordinator.apply(token).unwrap();
        assert_eq!(status.outcome, expected);
        assert_eq!(coordinator.adapter().release_count, 0);
        if physical == PhysicalResizeOutcome::NotApplied {
            assert_eq!(coordinator.adapter().calls.last(), Some(&"abort_prepared"));
        }
    }
}

#[test]
fn not_applied_requires_old_geometry_release_acknowledgement() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![]);
    adapter
        .outcomes
        .push_back(PhysicalResizeOutcome::NotApplied);
    adapter.abort_fails = true;
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let prepared = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
    let token = prepared.token.unwrap();
    for id in ["pc-visible", "checkpoint"] {
        coordinator.ack_old_prefix(token, id, 0).unwrap();
    }

    let status = coordinator.apply(token).unwrap();
    assert_eq!(status.outcome, GeometryTransactionOutcome::Indeterminate);
    assert_eq!(coordinator.phase(), GeometryTransactionPhase::Indeterminate);
    assert_eq!(coordinator.adapter().release_count, 0);
}

#[test]
fn waiter_timeout_and_disconnect_do_not_shrink_or_release_the_barrier() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let prepared = coordinator.prepare(remote_request(0), |_| Ok(())).unwrap();
    let token = prepared.token.unwrap();
    coordinator.request_waiter_timed_out(token).unwrap();
    coordinator.ack_old_prefix(token, "browser", 0).unwrap();

    assert_eq!(
        coordinator.apply(token).unwrap_err(),
        GeometryTransactionError::MissingParticipantAcknowledgement
    );
    assert_eq!(coordinator.phase(), GeometryTransactionPhase::Prepared);
    assert_eq!(coordinator.adapter().release_count, 0);
}

#[test]
fn retire_is_the_only_escape_from_applied_without_adoption() {
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    let prepared = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();
    let token = prepared.token.unwrap();
    for id in ["pc-visible", "checkpoint"] {
        coordinator.ack_old_prefix(token, id, 0).unwrap();
    }
    coordinator.apply(token).unwrap();
    coordinator.request_waiter_timed_out(token).unwrap();
    assert_eq!(
        coordinator.phase(),
        GeometryTransactionPhase::AppliedAwaitingAdoption
    );
    assert_eq!(coordinator.adapter().release_count, 0);

    let retired = coordinator.retire().unwrap();
    assert_eq!(retired.outcome, GeometryTransactionOutcome::Retired);
    assert_eq!(coordinator.phase(), GeometryTransactionPhase::Retired);
    assert_eq!(coordinator.adapter().calls.last(), Some(&"teardown"));
}
