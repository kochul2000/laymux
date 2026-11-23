use super::*;
use crate::automation_server::helpers::admit_bridge_mutation;
use crate::remote_server::HumanControlOrigin;
use std::future::pending;

#[tokio::test]
async fn pane_creation_waits_for_hidden_eviction_before_dispatch() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let targets = ["old-hidden-terminal".into()];
    let eviction = runtime
        .begin_eviction_and_drain(&state, &targets)
        .await
        .unwrap();
    let admit =
        |method| admit_bridge_mutation(runtime, method, "action", "panes", method, pending());
    let mut stack = std::pin::pin!(admit("stack"));
    let mut split = std::pin::pin!(admit("split"));
    assert_eq!(futures_util::poll!(&mut stack), std::task::Poll::Pending);
    assert_eq!(futures_util::poll!(&mut split), std::task::Poll::Pending);
    assert_eq!(runtime.active_mutations.load(Ordering::Acquire), 0);

    drop(eviction);
    // 대기자가 깨어나기 전에 다음 회수가 시작되면 그 대상도 보호한다.
    let retry = runtime
        .begin_eviction_and_drain(&state, &targets)
        .await
        .unwrap();
    assert!(futures_util::poll!(&mut stack).is_pending());
    assert!(futures_util::poll!(&mut split).is_pending());
    drop(retry);
    let (stacked, split_off) =
        tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(stack, split) })
            .await
            .unwrap();
    assert!(stacked.unwrap());
    assert!(split_off.unwrap());

    // 승인 뒤에는 두 프런트엔드 응답이 모두 도착해야 다음 회수가 진행된다.
    let mut next_eviction = std::pin::pin!(runtime.begin_eviction_and_drain(&state, &targets));
    assert!(futures_util::poll!(&mut next_eviction).is_pending());
    assert!(runtime.finish_detached_mutation("stack").unwrap());
    assert!(!runtime.finish_detached_mutation("stack").unwrap());
    assert!(futures_util::poll!(&mut next_eviction).is_pending());
    assert!(runtime.finish_detached_mutation("split").unwrap());
    tokio::time::timeout(Duration::from_secs(1), next_eviction)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn pane_creation_waiting_for_eviction_rejects_finalization() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let mut create = std::pin::pin!(admit_bridge_mutation(
        runtime,
        "review",
        "action",
        "panes",
        "stack",
        pending()
    ));
    assert_eq!(futures_util::poll!(&mut create), std::task::Poll::Pending);
    runtime.begin_finalization().unwrap();
    let error = tokio::time::timeout(Duration::from_secs(1), create)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error, "destructive session finalization is in progress");
    drop(eviction);
    assert!(!runtime.finish_detached_mutation("review").unwrap());
}

#[tokio::test]
async fn cancelled_pane_creation_is_not_dispatched_when_eviction_ends() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let mut create = std::pin::pin!(admit_bridge_mutation(
        runtime,
        "cancelled",
        "action",
        "panes",
        "stack",
        async { cancelled.await.unwrap() },
    ));
    assert!(futures_util::poll!(&mut create).is_pending());
    cancel.send(()).unwrap();
    drop(eviction);
    assert_eq!(
        create.await.unwrap_err(),
        "Pane creation cancelled before dispatch"
    );
    assert!(!runtime.finish_detached_mutation("cancelled").unwrap());
}

#[tokio::test]
async fn expired_pane_creation_does_not_register_a_late_action() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let error = runtime
        .begin_pane_creation_after_eviction("expired", Duration::ZERO)
        .await
        .unwrap_err();
    assert!(error.contains("timed out"), "{error}");
    drop(eviction);
    assert!(!runtime.finish_detached_mutation("expired").unwrap());
    assert!(runtime.begin_detached_mutation("expired").is_ok());
    assert!(runtime.finish_detached_mutation("expired").unwrap());
}

#[tokio::test]
async fn hidden_eviction_does_not_reject_remote_navigation() {
    let state = AppState::new();
    let eviction = state
        .session_checkpoint
        .begin_eviction_and_drain(&state, &["old-hidden-terminal".into()])
        .await
        .unwrap();
    for (index, (target, method)) in [
        ("terminals", "setFocus"),
        ("workspaces", "switchActive"),
        ("grid", "focusPane"),
        ("navigation", "spatialStep"),
        ("navigation", "directionStep"),
        ("navigation", "notificationStep"),
        ("notifications", "markRead"),
        ("notifications", "markTerminalRead"),
    ]
    .into_iter()
    .enumerate()
    {
        let request_id = format!("remote-navigation-{index}");
        assert!(
            admit_bridge_mutation(
                &state.session_checkpoint,
                &request_id,
                "action",
                target,
                method,
                pending(),
            )
            .await
            .unwrap(),
            "{target}.{method}"
        );
        assert!(state
            .session_checkpoint
            .finish_detached_mutation(&request_id)
            .unwrap());
    }
    for (target, method) in [
        ("terminals", "write"),
        ("workspaces", "create"),
        ("workspaces", "close"),
        ("panes", "activateLayer"),
        ("ui", "setPaneHidden"),
        ("navigation", "unknownFutureMutation"),
    ] {
        assert!(
            admit_bridge_mutation(
                &state.session_checkpoint,
                "structural-action",
                "action",
                target,
                method,
                pending(),
            )
            .await
            .is_err(),
            "{target}.{method}"
        );
    }
    drop(eviction);
}

#[tokio::test]
async fn remote_navigation_remains_tracked_for_update_but_does_not_delay_eviction() {
    let state = std::sync::Arc::new(AppState::new());
    admit_bridge_mutation(
        &state.session_checkpoint,
        "pending-focus",
        "action",
        "terminals",
        "setFocus",
        pending(),
    )
    .await
    .unwrap();
    assert!(state
        .session_checkpoint
        .begin_detached_mutation("pending-focus")
        .is_err());
    assert!(state
        .session_checkpoint
        .begin_detached_navigation("pending-focus")
        .is_err());
    // A delivered focus may still be waiting for readiness after HTTP timeout.
    let eviction = tokio::time::timeout(
        Duration::from_millis(200),
        state
            .session_checkpoint
            .begin_eviction_and_drain(&state, &["hidden".into()]),
    )
    .await
    .expect("navigation must not hold background retirement")
    .unwrap();
    drop(eviction);
    let task_state = state.clone();
    let drain = tokio::spawn(async move {
        task_state
            .session_checkpoint
            .begin_finalization_and_drain(&task_state)
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !state.session_checkpoint.is_finalizing() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!drain.is_finished());
    assert!(admit_bridge_mutation(
        &state.session_checkpoint,
        "late-focus",
        "action",
        "terminals",
        "setFocus",
        pending(),
    )
    .await
    .is_err());
    assert!(state
        .session_checkpoint
        .finish_detached_mutation("pending-focus")
        .unwrap());
    assert!(!state
        .session_checkpoint
        .finish_detached_mutation("pending-focus")
        .unwrap());
    drain.await.unwrap().unwrap();
    state.session_checkpoint.cancel_finalization();
}

#[tokio::test]
async fn restart_checkpoint_fence_blocks_target_input_through_teardown() {
    let state = AppState::new();
    for id in ["restarting", "unrelated"] {
        state.pty_handles.lock_or_err().unwrap().insert(
            id.into(),
            crate::pty::PtyHandle::from_test_writer(Box::new(Vec::<u8>::new())),
        );
        state
            .terminal_protocol_states
            .lock_or_err()
            .unwrap()
            .insert(id.into(), crate::terminal_output::new_protocol_gate());
    }
    // This is the same admission guard held by the shared native close
    // transaction while it waits for the checkpoint and the close worker.
    let fence = state
        .session_checkpoint
        .begin_eviction_and_drain(&state, &["restarting".into()])
        .await
        .unwrap();
    for phase in ["checkpoint pending", "teardown pending"] {
        for origin in [
            HumanControlOrigin::Local,
            HumanControlOrigin::Remote {
                lease_id: "remote-test".into(),
            },
        ] {
            let raw = crate::commands::write_to_terminal_inner(
                &state,
                "restarting",
                b"change conversation",
                origin.clone(),
            )
            .unwrap_err();
            assert!(raw.contains("eviction"), "{phase}: {raw}");
            let structured = crate::commands::write_terminal_input_inner(
                &state,
                "restarting",
                "change conversation",
                true,
                origin,
            )
            .unwrap_err();
            assert!(structured.contains("eviction"), "{phase}: {structured}");
        }
        crate::commands::write_to_terminal_inner(
            &state,
            "unrelated",
            b"continue work",
            HumanControlOrigin::Local,
        )
        .unwrap();
    }
    drop(fence);
    crate::commands::write_to_terminal_inner(
        &state,
        "restarting",
        b"retry after failure",
        HumanControlOrigin::Local,
    )
    .unwrap();
}

#[tokio::test]
async fn hidden_eviction_preserves_unrelated_raw_input_and_whole_paste() {
    let state = AppState::new();
    state.pty_handles.lock_or_err().unwrap().insert(
        "visible".into(),
        crate::pty::PtyHandle::from_test_writer(Box::new(Vec::<u8>::new())),
    );
    state
        .terminal_protocol_states
        .lock_or_err()
        .unwrap()
        .insert(
            "visible".into(),
            crate::terminal_output::new_protocol_gate(),
        );
    for _ in 0..3 {
        let eviction = state
            .session_checkpoint
            .begin_eviction_and_drain(&state, &["hidden".into()])
            .await
            .unwrap();
        crate::commands::write_to_terminal_inner(
            &state,
            "visible",
            b"a",
            HumanControlOrigin::Local,
        )
        .unwrap();
        crate::commands::write_terminal_input_inner(
            &state,
            "visible",
            "whole pasted sentence",
            false,
            HumanControlOrigin::Local,
        )
        .unwrap();
        assert!(state
            .session_checkpoint
            .begin_terminal_mutation("hidden")
            .is_err());
        assert!(state.session_checkpoint.begin_mutation().is_err());
        drop(eviction);
        assert!(state
            .session_checkpoint
            .begin_terminal_mutation("hidden")
            .is_ok());
    }
}

#[tokio::test]
async fn eviction_drains_target_input_but_not_unrelated_input() {
    let state = AppState::new();
    let visible = state
        .session_checkpoint
        .begin_terminal_mutation("visible")
        .unwrap();
    let hidden = state
        .session_checkpoint
        .begin_terminal_mutation("hidden")
        .unwrap();
    let targets = ["hidden".into()];
    let eviction = state
        .session_checkpoint
        .begin_eviction_and_drain(&state, &targets);
    tokio::pin!(eviction);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), &mut eviction)
            .await
            .is_err()
    );
    assert!(state
        .session_checkpoint
        .begin_terminal_mutation("hidden")
        .is_err());
    drop(hidden);
    let guard = tokio::time::timeout(Duration::from_secs(1), eviction)
        .await
        .unwrap()
        .unwrap();
    drop(guard);
    drop(visible);
}

#[tokio::test]
async fn update_waits_for_eviction_and_then_keeps_its_global_input_fence() {
    let state = AppState::new();
    let eviction = state
        .session_checkpoint
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let update = state
        .session_checkpoint
        .begin_finalization_and_drain(&state);
    tokio::pin!(update);
    assert!(tokio::time::timeout(Duration::from_millis(25), &mut update)
        .await
        .is_err());
    assert!(state
        .session_checkpoint
        .begin_terminal_mutation("visible")
        .is_err());
    drop(eviction);
    tokio::time::timeout(Duration::from_secs(1), update)
        .await
        .unwrap()
        .unwrap();
    assert!(state
        .session_checkpoint
        .begin_terminal_mutation("visible")
        .is_err());
    state.session_checkpoint.cancel_finalization();
    assert!(state
        .session_checkpoint
        .begin_terminal_mutation("visible")
        .is_ok());
}

#[tokio::test]
async fn dropping_an_eviction_during_drain_releases_its_targets() {
    let state = AppState::new();
    let pending = state
        .session_checkpoint
        .begin_terminal_mutation("hidden")
        .unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(25),
        state
            .session_checkpoint
            .begin_eviction_and_drain(&state, &["hidden".into()])
    )
    .await
    .is_err());
    drop(pending);
    assert!(state
        .session_checkpoint
        .begin_terminal_mutation("hidden")
        .is_ok());
    assert!(state.session_checkpoint.begin_mutation().is_ok());
}
