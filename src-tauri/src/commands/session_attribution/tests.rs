use super::*;

#[test]
fn unidentified_is_not_itself_evidence_of_a_missing_rollout() {
    let handle =
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_session_restore(Some(("codex", "saved-session".into())));
    let unresolved = classify_attribution(
        7,
        "t",
        &HashMap::new(),
        &HashMap::from([("t".into(), None)]),
        &HashMap::new(),
        PtyAppLiveness::Running("Codex"),
        false,
    );
    assert_eq!(
        apply_unconsumed_restore(unresolved, &handle, false).state,
        SessionAttributionState::ActiveButUnidentified
    );
    assert!(handle.unconsumed_session_restore().is_none());
}

#[test]
fn pending_resume_cannot_claim_another_panes_session() {
    for other_state in [
        SessionAttributionState::Identified,
        SessionAttributionState::RestorePending,
    ] {
        let handles: HashMap<_, _> = ["a", "b"]
            .into_iter()
            .map(|id| {
                (
                    id.to_string(),
                    crate::pty::PtyHandle::from_test_writer_for_generation(
                        Box::new(std::io::sink()),
                        7,
                    )
                    .with_session_restore(Some(("codex", "same-session".into()))),
                )
            })
            .collect();
        let mut attributions = HashMap::from([
            (
                "a".into(),
                TerminalSessionAttribution {
                    generation: 7,
                    state: SessionAttributionState::RestorePending,
                    provider: Some("codex"),
                    session_id: Some("same-session".into()),
                },
            ),
            (
                "b".into(),
                TerminalSessionAttribution {
                    generation: 7,
                    state: other_state.clone(),
                    provider: Some("codex"),
                    session_id: Some("same-session".into()),
                },
            ),
        ]);
        reject_duplicate_restore_checkpoints(&mut attributions, &handles);
        assert_eq!(
            attributions["a"].state,
            SessionAttributionState::ActiveButUnidentified
        );
        assert_eq!(attributions["a"].session_id, None);
        assert!(handles["a"].unconsumed_session_restore().is_none());
        if other_state == SessionAttributionState::Identified {
            assert_eq!(attributions["b"].state, SessionAttributionState::Identified);
        } else {
            assert_eq!(
                attributions["b"].state,
                SessionAttributionState::ActiveButUnidentified
            );
            assert!(handles["b"].unconsumed_session_restore().is_none());
        }
    }
}

#[test]
fn unconsumed_resume_survives_missing_attribution_but_not_input() {
    let handle =
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_session_restore(Some(("codex", "saved-session".into())));
    let pending = || {
        classify_attribution(
            7,
            "t",
            &HashMap::new(),
            &HashMap::from([("t".into(), None)]),
            &HashMap::new(),
            PtyAppLiveness::Running("Codex"),
            false,
        )
    };
    let verdict = apply_unconsumed_restore(pending(), &handle, true);
    assert_eq!(verdict.state, SessionAttributionState::RestorePending);
    assert_eq!(verdict.session_id.as_deref(), Some("saved-session"));
    handle.write_protocol_reply(b"\x1b[0n").unwrap();
    assert_eq!(
        apply_unconsumed_restore(pending(), &handle, true).state,
        SessionAttributionState::RestorePending
    );
    // Same writer used by local, Remote and Automation; no focus involved.
    handle.clone().write(b"new work\r").unwrap();
    assert_eq!(
        apply_unconsumed_restore(pending(), &handle, true).state,
        SessionAttributionState::ActiveButUnidentified
    );
}

#[test]
fn observed_session_consumes_resume_and_never_falls_back_afterwards() {
    let handle =
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_session_restore(Some(("codex", "saved-session".into())));
    let identified = classify_attribution(
        7,
        "t",
        &HashMap::new(),
        &HashMap::from([("t".into(), Some("current-session".into()))]),
        &HashMap::new(),
        PtyAppLiveness::Running("Codex"),
        false,
    );
    assert_eq!(
        apply_unconsumed_restore(identified, &handle, true)
            .session_id
            .as_deref(),
        Some("current-session")
    );
    let missing = classify_attribution(
        7,
        "t",
        &HashMap::new(),
        &HashMap::from([("t".into(), None)]),
        &HashMap::new(),
        PtyAppLiveness::Running("Codex"),
        false,
    );
    assert_eq!(
        apply_unconsumed_restore(missing, &handle, true).state,
        SessionAttributionState::ActiveButUnidentified
    );
}

#[test]
fn exact_claim_wins_and_is_bound_to_generation() {
    let attribution = classify_attribution(
        7,
        "terminal-a",
        &HashMap::new(),
        &HashMap::from([("terminal-a".into(), Some("session-2".into()))]),
        &HashMap::new(),
        PtyAppLiveness::Running("Codex"),
        false,
    );
    assert_eq!(attribution.generation, 7);
    assert_eq!(attribution.state, SessionAttributionState::Identified);
    assert_eq!(attribution.session_id.as_deref(), Some("session-2"));
}

#[test]
fn resume_does_not_bypass_unknown_conflict_or_replacement_generation() {
    let handle =
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_session_restore(Some(("codex", "saved-session".into())));
    assert_eq!(
        apply_unconsumed_restore(unknown_attribution(7), &handle, true).state,
        SessionAttributionState::Unknown
    );
    assert!(handle.unconsumed_session_restore().is_some());
    let shell = classify_attribution(
        7,
        "t",
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
        PtyAppLiveness::NoneAlive,
        false,
    );
    assert_eq!(
        apply_unconsumed_restore(shell.clone(), &handle, true).state,
        SessionAttributionState::RestorePending
    );
    let replacement =
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 8)
            .with_session_restore(Some(("codex", "replacement".into())));
    assert_eq!(
        apply_unconsumed_restore(shell, &replacement, true).state,
        SessionAttributionState::Unknown
    );
    assert!(replacement.unconsumed_session_restore().is_some());
    let conflicting = classify_attribution(
        7,
        "t",
        &HashMap::from([("t".into(), None)]),
        &HashMap::from([("t".into(), None)]),
        &HashMap::new(),
        PtyAppLiveness::Running("Codex"),
        false,
    );
    assert_eq!(
        apply_unconsumed_restore(conflicting, &handle, true).state,
        SessionAttributionState::ActiveButUnidentified
    );
    assert!(handle.unconsumed_session_restore().is_none());
}

#[test]
fn unknown_process_snapshot_is_not_collapsed_to_no_agent() {
    let attribution = classify_attribution(
        3,
        "terminal-a",
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
        PtyAppLiveness::Unknown,
        false,
    );
    assert_eq!(attribution.state, SessionAttributionState::Unknown);
}

#[test]
fn provider_lookup_failure_is_not_collapsed_to_destructive_absence() {
    let attribution = classify_attribution(
        4,
        "terminal-a",
        &HashMap::from([("terminal-a".into(), None)]),
        &HashMap::new(),
        &HashMap::new(),
        PtyAppLiveness::Running("Claude"),
        true,
    );

    assert_eq!(attribution.state, SessionAttributionState::Unknown);
    assert_eq!(attribution.session_id, None);
}

#[test]
fn provider_lookup_failure_is_scoped_to_the_affected_terminal() {
    let failed = ProviderSessionLookup {
        attributions: HashMap::from([("terminal-b".into(), None)]),
        failed_terminal_ids: HashSet::from(["terminal-b".into()]),
        missing_rollout_terminal_ids: HashSet::new(),
    };
    let healthy = ProviderSessionLookup {
        attributions: HashMap::from([("terminal-a".into(), Some("session-a".into()))]),
        failed_terminal_ids: HashSet::new(),
        missing_rollout_terminal_ids: HashSet::new(),
    };

    assert!(!provider_lookup_failed_for_terminal(
        "terminal-a",
        &[&failed, &healthy]
    ));
    assert!(provider_lookup_failed_for_terminal(
        "terminal-b",
        &[&failed, &healthy]
    ));
}

#[test]
fn provider_domains_keep_wsl_terminals_out_of_native_snapshot_failures() {
    let state = AppState::new();
    state.pty_handles.lock().unwrap().extend([
        (
            "terminal-native".into(),
            crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
                .with_child_pid(Some(101)),
        ),
        (
            "terminal-wsl".into(),
            crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
                .with_child_pid(Some(202))
                .with_wsl_backed(true),
        ),
    ]);

    let domains =
        provider_terminal_domains(&["terminal-native".into(), "terminal-wsl".into()], &state)
            .unwrap();

    assert_eq!(domains.native_roots, vec![("terminal-native".into(), 101)]);
    assert_eq!(
        domains.wsl_terminal_ids,
        HashSet::from(["terminal-wsl".into()])
    );
}

#[test]
fn generation_change_degrades_to_unknown() {
    let attribution = require_current_generation(
        TerminalSessionAttribution {
            generation: 8,
            state: SessionAttributionState::Identified,
            provider: Some("codex"),
            session_id: Some("session-before-restart".into()),
        },
        Some(9),
    );
    assert_eq!(attribution.generation, 8);
    assert_eq!(attribution.state, SessionAttributionState::Unknown);
    assert_eq!(attribution.session_id, None);
}

#[test]
fn provider_lookups_start_concurrently_within_one_close_budget() {
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let lookup = |started: std::sync::mpsc::Sender<()>,
                  gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>| {
        move || {
            started.send(()).unwrap();
            let (released, wake) = &*gate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(ProviderSessionLookup {
                attributions: HashMap::new(),
                failed_terminal_ids: HashSet::new(),
                missing_rollout_terminal_ids: HashSet::new(),
            })
        }
    };
    let worker_gate = Arc::clone(&gate);
    let worker = std::thread::spawn(move || {
        collect_provider_session_lookups(
            lookup(started_tx.clone(), Arc::clone(&worker_gate)),
            lookup(started_tx.clone(), Arc::clone(&worker_gate)),
            lookup(started_tx, worker_gate),
        )
    });

    let mut started = 0;
    for _ in 0..3 {
        if started_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .is_ok()
        {
            started += 1;
        } else {
            break;
        }
    }
    let (released, wake) = &*gate;
    *released.lock().unwrap() = true;
    wake.notify_all();

    assert!(worker.join().unwrap().is_ok());
    assert_eq!(
        started, 3,
        "all provider lookups must share the time budget"
    );
}
