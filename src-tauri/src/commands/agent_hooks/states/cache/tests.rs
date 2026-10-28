use super::*;
use crate::agent_hooks::observations::{HookPhase, HookRegistry};
use laymux_agent_hook::runtime::HookEvent;

fn fixture() -> (Binding, Observation) {
    let mut event: HookEvent = laymux_agent_hook::runtime::parse_event(
        "codex",
        &serde_json::json!({
            "session_id": "session", "hook_event_name": "SessionStart", "source": "startup"
        }),
        "pane".into(),
        "token".into(),
    )
    .unwrap();
    event.config_dir = Some("/config".into());
    event.emitted_at_ms = 1000;
    event.ancestors = vec![ProcessIdentity {
        pid: 42,
        parent_pid: Some(2),
        start_time: 10,
        start_ticks: None,
        name: "codex".into(),
        helper: false,
    }];
    let mut registry = HookRegistry::default();
    registry.observe(event.clone());
    let observation = registry.binding("codex", "session", None).unwrap().clone();
    let binding = Binding {
        snapshot: HookStateSnapshot {
            generation: 7,
            provider: "codex".into(),
            session_id: "session".into(),
            state: HookPhase::Idle,
            result: None,
            task_id: "0".into(),
            turn_id: None,
            sequence: observation.sequence,
            observed_at_ms: 1000,
            verified_at_ms: 1000,
            config_dir: event.config_dir.clone(),
            distro: None,
            binding_source: "process",
        },
        root: event.ancestors[0].clone(),
        owner: event.ancestors[0].clone(),
        callback: Arc::new(PtyCallbackState::new(100, 1, 100, 100, 1)),
        epoch: 0,
        title: None,
        event_at: 1000,
        live: true,
    };
    (binding, observation)
}

#[test]
fn cached_reads_and_duplicate_event_times_do_not_renew_a_proof() {
    let (mut binding, mut observation) = fixture();
    for now in [2000, 7000, 61_000, 151_000] {
        assert!(advance(&mut binding, &observation, now));
        assert_eq!(binding.snapshot.verified_at_ms, 1000);
    }
    observation.sequence += 1;
    assert!(advance(&mut binding, &observation, 151_000));
    assert_eq!(binding.snapshot.verified_at_ms, 1000);
    observation.sequence += 1;
    observation.event.emitted_at_ms = 151_000;
    observation.phase_at_ms = 151_000;
    observation.phase = Some(HookPhase::Running);
    assert!(advance(&mut binding, &observation, 151_010));
    assert_eq!(binding.snapshot.verified_at_ms, 151_000);
    assert_eq!(binding.snapshot.state, HookPhase::Running);
}

#[test]
fn polling_one_provider_does_not_invalidate_another_verified_provider() {
    let state = AppState::new();
    let (mut binding, mut observation) = fixture();
    observation.event.emitted_at_ms = now_ms().unwrap();
    binding.snapshot.verified_at_ms = observation.event.emitted_at_ms;
    binding.event_at = observation.event.emitted_at_ms;
    let mut session = crate::terminal::TerminalSession::new("pane".into(), Default::default());
    session.agent_hook = Some(observation.event.clone());
    state
        .terminals
        .lock_or_err()
        .unwrap()
        .insert("pane".into(), session);
    state.pty_handles.lock_or_err().unwrap().insert(
        "pane".into(),
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7),
    );
    state
        .agent_hook_observations
        .lock_or_err()
        .unwrap()
        .observe(observation.event);
    let request = crate::agent_hooks::ManageRequest {
        provider: "codex".into(),
        operation: "status".into(),
        distro: None,
        config_dir: Some("/config".into()),
    };
    state.agent_hook_inspections.begin(&request).unwrap();
    state
        .agent_hook_inspections
        .record(
            &request,
            &Ok(serde_json::json!({
                "configDir": "/config", "installed": true, "disabled": false,
            })),
        )
        .unwrap();
    state
        .agent_hook_bindings
        .lock_or_err()
        .unwrap()
        .bindings
        .insert("pane".into(), binding);
    assert_eq!(cached_liveness(&state, "pane", 7), Some("Codex"));
    for _ in 0..3 {
        assert!(read(&state, &["claude".into()]).unwrap().is_empty());
        assert_eq!(cached_liveness(&state, "pane", 7), Some("Codex"));
    }
    assert!(read(&state, &["codex".into()])
        .unwrap()
        .contains_key("pane"));
}

#[test]
fn changed_root_birth_pid_config_and_session_end_need_new_ownership() {
    for mutate in [
        |o: &mut Observation| o.event.ancestors[0].pid += 1,
        |o: &mut Observation| o.event.ancestors[0].start_time += 1,
        |o: &mut Observation| o.event.ancestors[0].helper = true,
        |o: &mut Observation| o.event.config_dir = Some("/other".into()),
        |o: &mut Observation| o.event.event = "SessionEnd".into(),
    ] {
        let (mut binding, mut observation) = fixture();
        mutate(&mut observation);
        assert!(!advance(&mut binding, &observation, 2000));
    }
}

#[test]
fn cached_positive_cannot_cross_epoch_generation_or_proof_expiry() {
    let state = AppState::new();
    let (mut binding, _) = fixture();
    binding.snapshot.verified_at_ms = now_ms().unwrap();
    let callback = binding.callback.clone();
    state
        .agent_hook_bindings
        .lock_or_err()
        .unwrap()
        .bindings
        .insert("pane".into(), binding);
    assert_eq!(cached_liveness(&state, "pane", 7), Some("Codex"));
    assert_eq!(cached_liveness(&state, "pane", 8), None);
    callback.detection_epoch.store(1, Ordering::Release);
    assert_eq!(cached_liveness(&state, "pane", 7), None);
    callback.detection_epoch.store(0, Ordering::Release);
    state
        .agent_hook_bindings
        .lock_or_err()
        .unwrap()
        .bindings
        .get_mut("pane")
        .unwrap()
        .snapshot
        .verified_at_ms = now_ms().unwrap() - 61_000;
    assert_eq!(cached_liveness(&state, "pane", 7), None);
}

#[test]
fn root_selection_stops_at_the_nearest_agent_before_an_outer_ide_agent() {
    let (_, observation) = fixture();
    let mut event = observation.event;
    let mut outer = event.ancestors[0].clone();
    outer.pid = 999;
    outer.start_time = 1;
    event.ancestors.push(outer);
    assert_eq!(root::identity(&event).unwrap().pid, 42);
}

#[test]
fn wsl_clock_correction_does_not_change_process_identity_or_force_a_scan() {
    let (mut binding, mut observation) = fixture();
    binding.root.start_ticks = Some(123456);
    binding.owner.start_ticks = Some(123456);
    observation.event.ancestors[0].start_ticks = Some(123456);
    observation.event.ancestors[0].start_time += 22;
    observation.event.emitted_at_ms += 1000;
    observation.sequence += 1;
    assert!(advance(&mut binding, &observation, 2000));
    assert_eq!(binding.snapshot.verified_at_ms, 2000);
    observation.event.ancestors[0].start_ticks = Some(123457);
    assert!(!advance(&mut binding, &observation, 3000));
}

#[test]
fn a_verified_root_event_refreshes_activity_without_a_display_poll() {
    let state = AppState::new();
    let (mut binding, observation) = fixture();
    state
        .agent_hook_observations
        .lock_or_err()
        .unwrap()
        .observe(observation.event.clone());
    binding.snapshot.verified_at_ms = now_ms().unwrap() - 61_000;
    state
        .agent_hook_bindings
        .lock_or_err()
        .unwrap()
        .bindings
        .insert("pane".into(), binding);
    assert_eq!(cached_liveness(&state, "pane", 7), None);
    let mut event = observation.event;
    event.event = "PostToolUse".into();
    event.emitted_at_ms = now_ms().unwrap();
    crate::agent_hooks::accept(&state, event.clone()).unwrap();
    assert_eq!(cached_liveness(&state, "pane", 7), Some("Codex"));
    assert_eq!(
        state.agent_hook_bindings.lock_or_err().unwrap().bindings["pane"]
            .snapshot
            .verified_at_ms,
        event.emitted_at_ms
    );
}

#[test]
fn shared_server_events_update_the_task_without_renewing_the_tuis_presence() {
    let (mut binding, mut observation) = fixture();
    binding.root.pid = 900;
    binding.root.helper = true;
    observation.event.ancestors = vec![binding.root.clone()];
    observation.event.event = "PostToolUse".into();
    observation.event.emitted_at_ms = 2000;
    observation.sequence += 1;
    observation.phase = Some(HookPhase::Running);
    assert!(advance(&mut binding, &observation, 2000));
    assert_eq!(binding.snapshot.state, HookPhase::Running);
    assert_eq!(binding.snapshot.verified_at_ms, 1000);
    assert_eq!(binding.owner.pid, 42);
    // A private server still below the TUI can prove the same TUI ancestor.
    observation.event.ancestors.push(binding.owner.clone());
    observation.event.emitted_at_ms = 3000;
    observation.sequence += 1;
    assert!(advance(&mut binding, &observation, 3000));
    assert_eq!(binding.snapshot.verified_at_ms, 3000);
}
