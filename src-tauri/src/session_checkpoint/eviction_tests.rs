use super::*;
use crate::remote_server::HumanControlOrigin;

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
