use super::*;

#[tokio::test]
async fn source_receipt_reuses_only_a_native_committed_unchanged_shell() {
    let fixture = Fixture::new();
    let (mut control, controller_task, mut reader, observer_task, generation) =
        setup(&fixture).await;
    #[cfg(windows)]
    let data = b"echo \x1b]0;verified-shell\x07\r".to_vec();
    #[cfg(not(windows))]
    let data = b"printf '\\033]0;verified-shell\\007'\r".to_vec();
    control
        .call(Command::Write {
            terminal_id: "terminal-owned-content".into(),
            generation,
            data,
        })
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if fixture.service.state.terminals.lock_or_err().unwrap()["terminal-owned-content"].title
            == "verified-shell"
        {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let token = reader
        .call(ReadCommand::CaptureReceipt)
        .await
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let mut submitted = snapshot(generation, "receipt");
    submitted.workspaces[0].panes[0]
        .view
        .as_mut()
        .unwrap()
        .extra["profile"] = json!(fixture.spec().profile);
    let commit = reader.commit_session(submitted, 1).await.unwrap();
    let receipt = reader
        .call(ReadCommand::CommitReceipt {
            token,
            checkpoint_revision: commit.revision,
            coverage: serde_json::from_value(
                serde_json::to_value(commit.snapshot.coverage).unwrap(),
            )
            .unwrap(),
        })
        .await
        .unwrap();
    let receipt = receipt
        .as_str()
        .expect("source receipt requires native proof and its own DB revision");
    assert!(crate::session_checkpoint::receipt::reusable(&fixture.service.state, receipt).unwrap());
    fixture.service.state.session_checkpoint.hints.request();
    assert!(
        !crate::session_checkpoint::receipt::reusable(&fixture.service.state, receipt).unwrap()
    );
    drop(reader);
    drop(control);
    let _ = controller_task.await.unwrap();
    let _ = observer_task.await.unwrap();
}

#[tokio::test]
async fn omitted_view_profile_uses_the_source_default_profile() {
    let fixture = Fixture::new();
    let (control, controller_task, mut reader, observer_task, generation) = setup(&fixture).await;
    let default_profile = fixture.spec().profile;
    fixture
        .service
        .settings
        .lock_or_err()
        .unwrap()
        .default_profile = default_profile;
    let mut submitted = snapshot(generation, "default-profile");
    submitted.workspaces[0].panes[0]
        .view
        .as_mut()
        .unwrap()
        .extra
        .as_object_mut()
        .unwrap()
        .remove("profile");
    let committed = reader.commit_session(submitted, 1).await.unwrap();
    assert_eq!(
        committed.snapshot.workspaces[0].panes[0]
            .view
            .as_ref()
            .unwrap()
            .extra["lastCwd"],
        fixture.directory.path().to_string_lossy().as_ref()
    );
    assert_eq!(committed.snapshot.coverage[0].state, "noAgent");
    drop(reader);
    drop(control);
    let _ = controller_task.await.unwrap();
    let _ = observer_task.await.unwrap();
}

#[tokio::test]
async fn source_business_events_are_generation_bound_and_not_replayed_on_new_attach() {
    let fixture = Fixture::new();
    let (control, controller_task, mut reader, observer_task, generation) = setup(&fixture).await;
    let initial = reader
        .call(ReadCommand::BusinessEvents { since: None })
        .await
        .unwrap();
    assert_eq!(initial["reset"], true);
    let since = initial["sequence"].as_u64().unwrap();
    fixture
        .service
        .events
        .emit(
            crate::constants::EVENT_TERMINAL_CWD_CHANGED,
            json!({"terminalId":"terminal-owned-content","cwd":"/observed","cwdSend":true}),
        )
        .unwrap();
    let live = reader
        .call(ReadCommand::BusinessEvents { since: Some(since) })
        .await
        .unwrap();
    let event = live["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["event"] == crate::constants::EVENT_TERMINAL_CWD_CHANGED)
        .unwrap();
    assert_eq!(event["generation"], generation);
    assert_eq!(event["payload"]["cwd"], "/observed");
    let new_attach = reader
        .call(ReadCommand::BusinessEvents { since: None })
        .await
        .unwrap();
    assert!(new_attach["events"].as_array().unwrap().is_empty());
    assert_eq!(new_attach["catalog"][0]["generation"], generation);
    drop(reader);
    drop(control);
    let _ = controller_task.await.unwrap();
    let _ = observer_task.await.unwrap();
}

#[tokio::test]
async fn moved_content_options_change_only_the_current_source_generation() {
    let fixture = Fixture::new();
    let (mut control, controller_task, reader, observer_task, generation) = setup(&fixture).await;
    control
        .call(Command::TerminalOptions {
            terminal_id: "terminal-owned-content".into(),
            generation,
            sync_group: Some("moved-workspace".into()),
            cwd_send: Some(true),
            cwd_receive: Some(true),
        })
        .await
        .unwrap();
    assert!(control
        .call(Command::TerminalOptions {
            terminal_id: "terminal-owned-content".into(),
            generation: generation + 1,
            sync_group: Some("stale-group".into()),
            cwd_send: Some(false),
            cwd_receive: Some(false)
        })
        .await
        .is_err());
    let catalog = control.call(Command::Catalog).await.unwrap();
    assert_eq!(
        catalog[0]["session"]["config"]["sync_group"],
        "moved-workspace"
    );
    assert_eq!(catalog[0]["session"]["cwd_send"], true);
    assert_eq!(catalog[0]["session"]["cwd_receive"], true);
    {
        let groups = fixture.service.state.sync_groups.lock_or_err().unwrap();
        assert!(groups["moved-workspace"]
            .terminal_ids
            .iter()
            .any(|id| id == "terminal-owned-content"));
        assert!(!groups.contains_key("stale-group"));
    }
    drop(reader);
    drop(control);
    let _ = controller_task.await.unwrap();
    let _ = observer_task.await.unwrap();
}

#[tokio::test]
async fn same_generation_identity_change_invalidates_a_slow_observation() {
    let fixture = Fixture::new();
    let (control, controller_task, reader, observer_task, _) = setup(&fixture).await;
    let observed = crate::pty_daemon::session_projection::Observation::collect(
        &fixture.service.state,
        fixture.spec().profile,
    )
    .unwrap();
    assert!(observed.validate(&fixture.service.state, None).is_ok());
    fixture.service.state.session_checkpoint.hints.request();
    assert!(observed.validate(&fixture.service.state, None).is_err());
    assert!(fixture.service.writer.load().unwrap().is_none());
    drop(reader);
    drop(control);
    let _ = controller_task.await.unwrap();
    let _ = observer_task.await.unwrap();
}
