use super::*;

fn candidate() -> UpdateManager {
    let manager = UpdateManager::default();
    let mut status = manager.status.lock().unwrap();
    status.enabled = true;
    status.available_version = Some("1.2.3".into());
    drop(status);
    manager
}

#[test]
fn only_a_failed_preparation_authorizes_one_forced_install() {
    let manager = candidate();
    assert!(manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .is_err());
    manager.begin_install(UpdateChannel::Stable).unwrap();
    manager.fail_operation("download failed".into()).unwrap();
    assert!(manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .is_err());
    manager.begin_install(UpdateChannel::Stable).unwrap();
    manager.mark_preparing().unwrap();
    let failed = manager
        .fail_operation("pane status unknown".into())
        .unwrap();
    assert!(failed.can_force_install);
    let accepted = manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .unwrap();
    assert!(!accepted.can_force_install);
    assert!(accepted.force_install);
    assert!(manager.mark_preparing().unwrap().force_install);
    assert!(manager.mark_installing().unwrap().force_install);
    assert_eq!(accepted.operation, UpdateOperation::Downloading);
    assert!(manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .is_err());
    manager.fail_operation("signature failed".into()).unwrap();
    assert!(!manager.snapshot().unwrap().can_force_install);
    assert!(
        !manager
            .begin_install(UpdateChannel::Stable)
            .unwrap()
            .force_install
    );
}

#[test]
fn a_new_check_revokes_the_loss_override_even_for_the_same_version() {
    let manager = candidate();
    manager.mark_preparing().unwrap();
    manager
        .fail_operation("checkpoint timed out".into())
        .unwrap();
    manager.begin_check(UpdateChannel::Stable).unwrap();
    manager
        .finish_check(Some(AvailableUpdate {
            version: "1.2.3".into(),
            notes: None,
            published_at: None,
        }))
        .unwrap();
    assert!(manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .is_err());
}

#[test]
fn force_preserves_dev_channel_and_close_guards() {
    let manager = candidate();
    manager.mark_preparing().unwrap();
    manager
        .fail_operation("pane status unknown".into())
        .unwrap();
    assert!(manager
        .begin_install_with_force(UpdateChannel::Beta, true)
        .is_err());
    manager.claim_close().unwrap();
    assert!(manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .is_err());
    manager.cancel_close();
    manager.status.lock().unwrap().enabled = false;
    assert!(manager
        .begin_install_with_force(UpdateChannel::Stable, true)
        .is_err());
}

#[tokio::test]
async fn forced_preparation_skips_the_failing_probe_but_keeps_the_input_fence() {
    let state = AppState::new();
    let failed = install::prepare(&state, false, || async {
        Err("pane status unknown".into())
    })
    .await;
    assert!(failed.is_err());
    assert!(!state.session_checkpoint.is_finalizing());
    install::prepare(&state, true, || async {
        panic!("forced update must not probe panes")
    })
    .await
    .unwrap();
    assert!(state.session_checkpoint.is_finalizing());
    assert!(state.session_checkpoint.begin_mutation().is_err());
    state.session_checkpoint.cancel_finalization();
}

#[tokio::test]
async fn force_never_steals_an_existing_finalization() {
    let state = AppState::new();
    state
        .session_checkpoint
        .begin_finalization_for_test()
        .unwrap();
    assert!(install::prepare(&state, true, || async { Ok(0) })
        .await
        .is_err());
    assert!(state.session_checkpoint.is_finalizing());
}
