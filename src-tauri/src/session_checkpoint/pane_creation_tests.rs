use super::*;
use crate::automation_server::helpers;
use std::future::{pending, Future};

#[tokio::test]
async fn review_pane_creation_does_not_wait_for_an_unrelated_hidden_terminal() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let _eviction = runtime
        .begin_eviction_and_drain(&state, &["other-workspace".into()])
        .await
        .unwrap();
    let mut create = std::pin::pin!(admit(
        &state,
        "review",
        "action",
        "panes",
        "stack",
        pending()
    ));
    assert_eq!(
        futures_util::poll!(&mut create),
        std::task::Poll::Ready(Ok(true))
    );
    assert!(runtime.finish_detached_mutation("review").unwrap());
}

#[tokio::test]
async fn terminal_start_and_prepare_overlap_only_unrelated_eviction() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();

    let mut new_terminal = std::pin::pin!(runtime.begin_terminal_creation("new"));
    let std::task::Poll::Ready(created) = futures_util::poll!(&mut new_terminal) else {
        panic!("unrelated PTY startup was queued behind hidden eviction");
    };
    let mut hidden_terminal = std::pin::pin!(runtime.begin_terminal_creation("hidden"));
    assert!(futures_util::poll!(&mut hidden_terminal).is_pending());
    for (id, expected) in [("hidden", false), ("another", true)] {
        assert_eq!(
            helpers::admit_bridge_mutation(
                runtime,
                id,
                ("action", "terminals", "prepareForAutomation"),
                None,
                Some(id),
                pending(),
            )
            .await
            .is_ok(),
            expected,
        );
    }
    drop(eviction);
    drop(hidden_terminal.await);
    let mut drain = std::pin::pin!(runtime.begin_finalization_and_drain(&state));
    assert!(futures_util::poll!(&mut drain).is_pending());
    drop(created);
    assert!(futures_util::poll!(&mut drain).is_pending());
    assert!(runtime.finish_detached_mutation("another").unwrap());
    tokio::time::timeout(Duration::from_secs(1), drain)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn eviction_drains_only_bridge_actions_with_overlapping_target_ids() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    admit(
        &state,
        "unrelated-slot",
        "action",
        "panes",
        "stack",
        pending(),
    )
    .await
    .unwrap();
    runtime
        .begin_detached_terminal_mutation("pending-prepare", "target")
        .unwrap();
    let targets = ["target".into()];
    let mut eviction = std::pin::pin!(runtime.begin_eviction_and_drain(&state, &targets));
    assert!(futures_util::poll!(&mut eviction).is_pending());
    assert!(runtime.finish_detached_mutation("pending-prepare").unwrap());
    drop(
        tokio::time::timeout(Duration::from_secs(1), eviction)
            .await
            .unwrap()
            .unwrap(),
    );
    assert!(runtime.finish_detached_mutation("unrelated-slot").unwrap());
}

pub(super) async fn admit(
    state: &AppState,
    request_id: &str,
    category: &str,
    target: &str,
    method: &str,
    cancelled: impl Future<Output = ()>,
) -> Result<bool, String> {
    let interrupted = helpers::bridge_interruption(state, category, target, method, cancelled);
    helpers::admit_bridge_mutation(
        &state.session_checkpoint,
        request_id,
        (category, target, method),
        (target == "panes" && matches!(method, "stack" | "split")).then_some((
            &["hidden".into()][..],
            helpers::PANE_CREATION_ADMISSION_TIMEOUT,
        )),
        None,
        interrupted,
    )
    .await
}

#[tokio::test]
async fn pane_creation_rejects_window_close_even_without_a_codex_checkpoint() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let mut create = std::pin::pin!(admit(
        &state,
        "close",
        "action",
        "panes",
        "stack",
        pending()
    ));
    assert!(futures_util::poll!(&mut create).is_pending());
    state.claim_app_close(false).unwrap();
    let result_during_close = futures_util::poll!(&mut create);
    assert!(matches!(
        result_during_close,
        std::task::Poll::Ready(Err(_))
    ));
    assert!(state.app_update.cancel_close());
    drop(eviction);
    assert!(!runtime.finish_detached_mutation("close").unwrap());
    assert!(admit(&state, "new", "action", "panes", "stack", pending())
        .await
        .unwrap());
    assert!(runtime.finish_detached_mutation("new").unwrap());
}

#[tokio::test]
async fn pane_creation_waiting_before_a_cancelled_finalization_stays_rejected() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let mut create = std::pin::pin!(admit(&state, "old", "action", "panes", "stack", pending()));
    assert!(futures_util::poll!(&mut create).is_pending());
    runtime.begin_finalization().unwrap();
    runtime.cancel_finalization();
    drop(eviction);
    assert_eq!(
        create.await.unwrap_err(),
        "destructive session finalization is in progress"
    );
    assert!(!runtime.finish_detached_mutation("old").unwrap());
}

#[tokio::test(start_paused = true)]
async fn pane_creation_cannot_register_after_its_deadline_even_if_the_gate_is_open() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let result = runtime
        .begin_pane_creation_after_eviction("late", &[], Duration::ZERO)
        .await;
    assert!(result.unwrap_err().contains("timed out"));
    assert!(!runtime.finish_detached_mutation("late").unwrap());
}

#[tokio::test]
async fn pane_creation_waits_for_hidden_eviction_before_dispatch() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let targets = ["hidden".into()];
    let eviction = runtime
        .begin_eviction_and_drain(&state, &targets)
        .await
        .unwrap();
    let admit = |method| admit(&state, method, "action", "panes", method, pending());
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
    let mut create = std::pin::pin!(admit(
        &state,
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
    let mut create = std::pin::pin!(admit(
        &state,
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

#[tokio::test(start_paused = true)]
async fn pane_creation_expires_after_ten_seconds_without_registering_a_late_action() {
    let state = AppState::new();
    let runtime = &state.session_checkpoint;
    let eviction = runtime
        .begin_eviction_and_drain(&state, &["hidden".into()])
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut split = std::pin::pin!(admit(
        &state,
        "split-at-deadline",
        "action",
        "panes",
        "split",
        pending()
    ));
    assert!(futures_util::poll!(&mut split).is_pending());
    let mut create = std::pin::pin!(admit(
        &state,
        "expired",
        "action",
        "panes",
        "stack",
        pending()
    ));
    assert!(
        tokio::time::timeout_at(deadline - Duration::from_millis(1), &mut create)
            .await
            .is_err()
    );
    let error = tokio::time::timeout_at(deadline, create)
        .await
        .expect("10초가 지나면 pane 생성 승인 대기가 끝나야 한다")
        .unwrap_err();
    assert!(error.contains("timed out"), "{error}");
    drop(eviction);
    assert!(split.await.unwrap_err().contains("timed out"));
    assert!(!runtime
        .finish_detached_mutation("split-at-deadline")
        .unwrap());
    assert!(!runtime.finish_detached_mutation("expired").unwrap());
    assert!(runtime.begin_detached_mutation("expired").is_ok());
    assert!(runtime.finish_detached_mutation("expired").unwrap());
}
