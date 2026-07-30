#[test]
fn split_control_strings_and_dec2026_frame_fail_prepare_without_physical_call() {
    let cases = [
        vec![b"\x1b".to_vec(), b"]title".to_vec()],
        vec![b"\x1b".to_vec(), b"(".to_vec()],
        vec![b"\x1b#".to_vec()],
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
fn utf8_continuations_cannot_forge_c1_control_string_boundaries() {
    // Every byte in this list is both in the C1 range and a valid final byte
    // of the UTF-8 scalar E1 80 xx. xterm decodes the scalar before VT parsing,
    // so none of them is an 8-bit control introducer or ST terminator.
    let c1_continuations = [0x90, 0x98, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f];
    for introducer in *b"]P" {
        for continuation in c1_continuations {
            let mut open = vec![0x1b, introducer];
            // DCS needs a final byte before it enters passthrough. A decoded
            // non-ASCII scalar in DCS entry is an xterm parser error and would
            // correctly return to Ground instead.
            if introducer == b'P' {
                open.push(b'q');
            }
            open.extend_from_slice(&[0xe1, 0x80, continuation]);
            let mut adapter = FakeAdapter::proven();
            adapter.drains.push_back(vec![open]);
            let mut coordinator = PtyGeometryCoordinator::new(adapter);

            let status = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();

            assert_eq!(status.outcome, GeometryTransactionOutcome::NotApplied);
            assert_eq!(
                coordinator.adapter().calls,
                vec!["freeze_and_drain", "abort_prepared"]
            );
        }
    }

    // SOS/PM/APC have no NON_ASCII_PRINTABLE transition in xterm's parser;
    // the decoded scalar aborts these ignored strings to Ground. The same C1-
    // looking continuation therefore cannot forge an ST transition either.
    for introducer in *b"X^_" {
        let mut adapter = FakeAdapter::proven();
        adapter
            .drains
            .push_back(vec![vec![0x1b, introducer, 0xe1, 0x80, 0x9c]]);
        let mut coordinator = PtyGeometryCoordinator::new(adapter);
        assert_eq!(
            coordinator
                .prepare(local_request(0), |_| Ok(()))
                .unwrap()
                .outcome,
            GeometryTransactionOutcome::Prepared
        );
    }
}

#[test]
fn utf8_and_invalid_high_bytes_follow_xterm_utf8_mode_not_raw_c1_mode() {
    // U+D55C ("한") ends in 0x9c. It must remain OSC payload until BEL.
    let mut adapter = FakeAdapter::proven();
    adapter
        .drains
        .push_back(vec![b"\x1b]0;\xed\x95\x9c".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    assert_eq!(
        coordinator
            .prepare(local_request(0), |_| Ok(()))
            .unwrap()
            .outcome,
        GeometryTransactionOutcome::NotApplied
    );

    // xterm silently discards a standalone invalid UTF-8 C1 byte. It is not
    // passed to the VT parser as OSC ST, so the OSC remains open.
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![b"\x1b]0;bad\x9c".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    assert_eq!(
        coordinator
            .prepare(local_request(0), |_| Ok(()))
            .unwrap()
            .outcome,
        GeometryTransactionOutcome::NotApplied
    );

    // Conversely, valid UTF-8 ending in bytes that look like C1 introducers
    // must leave Ground neutral.
    for continuation in [0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f] {
        let mut adapter = FakeAdapter::proven();
        adapter
            .drains
            .push_back(vec![vec![0xe1, 0x80, continuation]]);
        let mut coordinator = PtyGeometryCoordinator::new(adapter);
        assert_eq!(
            coordinator
                .prepare(local_request(0), |_| Ok(()))
                .unwrap()
                .outcome,
            GeometryTransactionOutcome::Prepared
        );
    }
}

#[test]
fn decoded_non_ascii_scalar_aborts_csi_instead_of_forging_dec2026() {
    let mut adapter = FakeAdapter::proven();
    adapter
        .drains
        .push_back(vec![b"\x1b[?2026;\xe1\x80\x9bh".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);

    let status = coordinator.prepare(local_request(0), |_| Ok(())).unwrap();

    assert_eq!(status.outcome, GeometryTransactionOutcome::Prepared);
}

#[test]
fn encoded_c1_and_incomplete_utf8_match_xterm_streaming_semantics() {
    // C2 9C is a valid encoding of U+009C and therefore really is ST after
    // xterm's decoder. This is intentionally different from raw invalid 9C.
    let mut adapter = FakeAdapter::proven();
    adapter
        .drains
        .push_back(vec![b"\x1b]0;title\xc2\x9c".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    assert_eq!(
        coordinator
            .prepare(local_request(0), |_| Ok(()))
            .unwrap()
            .outcome,
        GeometryTransactionOutcome::Prepared
    );

    // C2 90 is the encoded DCS introducer and must remain non-neutral.
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![b"\xc2\x90qdata".to_vec()]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    assert_eq!(
        coordinator
            .prepare(local_request(0), |_| Ok(()))
            .unwrap()
            .outcome,
        GeometryTransactionOutcome::NotApplied
    );

    // A revision cannot split a scalar xterm is still buffering.
    let mut adapter = FakeAdapter::proven();
    adapter.drains.push_back(vec![vec![0xed, 0x95]]);
    let mut coordinator = PtyGeometryCoordinator::new(adapter);
    assert_eq!(
        coordinator
            .prepare(local_request(0), |_| Ok(()))
            .unwrap()
            .outcome,
        GeometryTransactionOutcome::NotApplied
    );
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
        b"\x1b".to_vec(),
        b"(B".to_vec(),
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
