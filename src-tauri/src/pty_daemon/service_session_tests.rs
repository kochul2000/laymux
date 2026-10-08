use super::*;
use crate::local_state::{LocalSessionSnapshot, LocalStateStore};
use crate::settings::{Workspace, WorkspacePane, WorkspacePaneView};

fn snapshot(generation: u64, name: &str) -> LocalSessionSnapshot {
    let mut value = LocalSessionSnapshot {
        workspaces: vec![Workspace {
            id: "saved-workspace".into(),
            name: name.into(),
            panes: vec![WorkspacePane::single(
                "owned-content".into(),
                0.0,
                0.0,
                1.0,
                1.0,
                WorkspacePaneView {
                    view_type: "TerminalView".into(),
                    extra: json!({"profile":"PowerShell","lastCwd":"forged-cwd","lastCodexSession":"forged-session"}),
                },
            )],
            layout_id: Some("legacy-layout".into()),
        }],
        ..Default::default()
    };
    value.coverage = serde_json::from_value(json!([{
        "terminalId":"terminal-owned-content", "generation":generation,
        "state":"identified", "provider":"codex", "sessionId":"forged-session"
    }]))
    .unwrap();
    value
}

async fn setup(
    fixture: &Fixture,
) -> (
    DaemonClient<DuplexStream>,
    tokio::task::JoinHandle<Result<(), AppError>>,
    DaemonReader<DuplexStream>,
    tokio::task::JoinHandle<Result<(), AppError>>,
    u64,
) {
    let (mut control, controller_task) = fixture.attach().await;
    let mut spec = fixture.spec();
    spec.id = "terminal-owned-content".into();
    let created = control.call(Command::Create { spec }).await.unwrap();
    let generation = created["generation"].as_u64().unwrap();
    let (stream, server) = tokio::io::duplex(64 * 1024);
    let observer_task = tokio::spawn(fixture.service.clone().serve_connection(server));
    let reader = DaemonReader::authenticate(
        stream,
        &fixture.key,
        "fixture-scope",
        "fixture-runtime",
        control.stamp.clone(),
    )
    .await
    .unwrap();
    (control, controller_task, reader, observer_task, generation)
}

#[tokio::test]
async fn session_commit_uses_native_source_verdict_and_cwd_instead_of_gui_claims() {
    let fixture = Fixture::new();
    let (control, controller_task, mut reader, observer_task, generation) = setup(&fixture).await;
    let mut submitted = snapshot(generation, "source-observed");
    submitted.workspaces[0].panes[0]
        .view
        .as_mut()
        .unwrap()
        .extra["profile"] = json!(fixture.spec().profile);
    let commit = reader.commit_session(submitted, 1).await.unwrap();
    let view = &commit.snapshot.workspaces[0].panes[0]
        .view
        .as_ref()
        .unwrap()
        .extra;
    assert_eq!(
        view["lastCwd"],
        fixture.directory.path().to_string_lossy().as_ref()
    );
    assert!(view.get("lastCodexSession").is_none());
    assert_eq!(commit.snapshot.coverage[0].state, "noAgent");
    assert_eq!(commit.snapshot.coverage[0].generation, Some(generation));
    assert!(!commit.needs_retry);
    assert_eq!(
        commit.snapshot.workspaces[0].layout_id.as_deref(),
        Some("legacy-layout")
    );
    drop(reader);
    drop(control);
    assert!(observer_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

#[tokio::test]
async fn stale_structure_revision_cannot_replace_a_newer_committed_workspace() {
    let fixture = Fixture::new();
    let (control, controller_task, mut reader, observer_task, generation) = setup(&fixture).await;
    let newest = reader
        .commit_session(snapshot(generation, "newest"), 2)
        .await
        .unwrap();
    assert!(reader
        .commit_session(snapshot(generation, "stale"), 1)
        .await
        .is_err());
    let store = LocalStateStore::new(fixture.directory.path().join("state.db"));
    assert_eq!(store.revision().unwrap().0, newest.revision);
    assert_eq!(
        store.load_session().unwrap().unwrap().workspaces[0].name,
        "newest"
    );
    drop(reader);
    drop(control);
    assert!(observer_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

#[tokio::test]
async fn stale_source_generation_cannot_commit_a_gui_restore_claim() {
    let fixture = Fixture::new();
    let (control, controller_task, mut reader, observer_task, generation) = setup(&fixture).await;
    assert!(reader
        .commit_session(snapshot(generation + 1, "stale-generation"), 1)
        .await
        .is_err());
    let store = LocalStateStore::new(fixture.directory.path().join("state.db"));
    assert!(store.load_session().unwrap().is_none());
    drop(reader);
    drop(control);
    assert!(observer_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

async fn reader_for(
    fixture: &Fixture,
    stamp: crate::daemon_protocol::AttachmentStamp,
) -> (
    DaemonReader<DuplexStream>,
    tokio::task::JoinHandle<Result<(), AppError>>,
) {
    let (stream, server) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(fixture.service.clone().serve_connection(server));
    let reader = DaemonReader::authenticate(
        stream,
        &fixture.key,
        "fixture-scope",
        "fixture-runtime",
        stamp,
    )
    .await
    .unwrap();
    (reader, task)
}

#[tokio::test]
async fn a_slow_session_observation_does_not_block_input_and_cannot_commit_after_detach() {
    let fixture = Fixture::new();
    let (mut control, controller_task, mut reader, observer_task, generation) =
        setup(&fixture).await;
    fixture
        .service
        .session_read_delay
        .store(500, Ordering::Release);
    let save = tokio::spawn(async move {
        reader
            .commit_session(snapshot(generation, "retired"), 1)
            .await
    });
    fixture.service.read_started.notified().await;
    tokio::time::timeout(
        std::time::Duration::from_millis(150),
        control.call(Command::Write {
            terminal_id: "terminal-owned-content".into(),
            generation,
            data: b"echo INPUT_DURING_SAVE\r".to_vec(),
        }),
    )
    .await
    .unwrap()
    .unwrap();
    control.call(Command::Detach).await.unwrap();
    assert!(save.await.unwrap().is_err());
    assert!(fixture.service.writer.load().unwrap().is_none());
    drop(control);
    assert!(observer_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

#[tokio::test]
async fn an_older_observation_finishing_late_cannot_replace_the_newest_structure() {
    let fixture = Fixture::new();
    let (control, controller_task, mut first, first_task, generation) = setup(&fixture).await;
    fixture
        .service
        .session_read_delay
        .store(500, Ordering::Release);
    let old = tokio::spawn(async move {
        first
            .commit_session(snapshot(generation, "late-old"), 1)
            .await
    });
    fixture.service.read_started.notified().await;
    fixture
        .service
        .session_read_delay
        .store(0, Ordering::Release);
    let (mut newest, newest_task) = reader_for(&fixture, control.stamp.clone()).await;
    let commit = newest
        .commit_session(snapshot(generation, "newest"), 2)
        .await
        .unwrap();
    assert!(old.await.unwrap().is_err());
    assert_eq!(
        fixture.service.writer.load().unwrap().unwrap().workspaces[0].name,
        "newest"
    );
    assert_eq!(
        fixture.service.writer.diagnostics().unwrap()["databaseRevision"],
        commit.revision
    );
    drop(newest);
    drop(control);
    assert!(first_task.await.unwrap().is_err());
    assert!(newest_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

#[tokio::test]
async fn the_background_writer_commits_cwd_changes_with_no_gui_attached() {
    let fixture = Fixture::new();
    let (mut control, controller_task, mut reader, observer_task, generation) =
        setup(&fixture).await;
    let first = reader
        .commit_session(snapshot(generation, "saved"), 1)
        .await
        .unwrap();
    drop(reader);
    control.call(Command::Detach).await.unwrap();
    drop(control);
    assert!(observer_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
    // The source's own OSC pipeline mutates this state while detached. Trigger
    // that same source-owned hint; never create a GUI-local PTY or snapshot.
    let cwd = fixture.directory.path().join("next-cwd");
    std::fs::create_dir(&cwd).unwrap();
    fixture
        .service
        .state
        .terminals
        .lock_or_err()
        .unwrap()
        .get_mut("terminal-owned-content")
        .unwrap()
        .cwd = Some(cwd.to_string_lossy().into_owned());
    fixture.service.state.session_checkpoint.hints.request();
    let store = LocalStateStore::new(fixture.directory.path().join("state.db"));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let saved = store.load_session().unwrap().unwrap();
            if saved.workspaces[0].panes[0].view.as_ref().unwrap().extra["lastCwd"]
                == cwd.to_string_lossy().as_ref()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    assert!(store.revision().unwrap().0 > first.revision);
    let stable_revision = store.revision().unwrap().0;
    assert!(fixture.service.refresh_session().await.unwrap());
    assert_eq!(store.revision().unwrap().0, stable_revision);
}

#[tokio::test]
async fn database_busy_preserves_the_last_commit_without_blocking_input() {
    let fixture = Fixture::new();
    let (mut control, controller_task, mut reader, observer_task, generation) =
        setup(&fixture).await;
    let first = reader
        .commit_session(snapshot(generation, "durable"), 1)
        .await
        .unwrap();
    let connection = rusqlite::Connection::open(fixture.directory.path().join("state.db")).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    let save = tokio::spawn(async move {
        reader
            .commit_session(snapshot(generation, "must-not-publish"), 2)
            .await
    });
    fixture.service.session_commit_started.notified().await;
    tokio::time::timeout(
        std::time::Duration::from_millis(150),
        control.call(Command::Ping),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(save.await.unwrap().is_err());
    connection.execute_batch("ROLLBACK").unwrap();
    let store = LocalStateStore::new(fixture.directory.path().join("state.db"));
    assert_eq!(store.revision().unwrap().0, first.revision);
    assert_eq!(
        store.load_session().unwrap().unwrap().workspaces[0].name,
        "durable"
    );
    assert!(fixture.service.writer.diagnostics().unwrap()["error"].is_string());
    drop(control);
    assert!(observer_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

#[tokio::test]
async fn an_unknown_cold_source_preserves_the_verified_disk_restore_point() {
    let mut previous = snapshot(44, "previous");
    previous.workspaces[0].panes[0].view.as_mut().unwrap().extra = json!({"profile":"PowerShell","lastCwd":"/verified-cwd","lastCodexSession":"verified-before-reboot"});
    previous.coverage[0].session_id = Some("verified-before-reboot".into());
    let fixture = Fixture::with_session(Some(previous));
    let (control, control_task) = fixture.attach().await;
    let (mut reader, reader_task) = reader_for(&fixture, control.stamp.clone()).await;
    let mut incoming = snapshot(0, "new-structure");
    incoming.coverage.clear();
    let saved = reader.commit_session(incoming, 1).await.unwrap();
    let view = &saved.snapshot.workspaces[0].panes[0]
        .view
        .as_ref()
        .unwrap()
        .extra;
    assert_eq!(view["lastCodexSession"], "verified-before-reboot");
    assert_eq!(view["lastCwd"], "/verified-cwd");
    assert_eq!(saved.snapshot.workspaces[0].name, "new-structure");
    assert!(saved.needs_retry);
    assert_eq!(saved.unresolved_terminal_ids, ["terminal-owned-content"]);
    drop(reader);
    drop(control);
    assert!(reader_task.await.unwrap().is_err());
    assert!(control_task.await.unwrap().is_err());
}

#[tokio::test]
async fn a_profile_transition_does_not_adopt_the_old_native_profiles_cwd_or_verdict() {
    let fixture = Fixture::new();
    let (control, controller_task, mut reader, reader_task, generation) = setup(&fixture).await;
    let mut incoming = snapshot(generation, "switching-profile");
    incoming.workspaces[0].panes[0].view.as_mut().unwrap().extra["profile"] =
        json!("different-profile");
    let saved = reader.commit_session(incoming, 1).await.unwrap();
    let view = &saved.snapshot.workspaces[0].panes[0]
        .view
        .as_ref()
        .unwrap()
        .extra;
    assert!(view.get("lastCwd").is_none());
    assert!(view.get("lastCodexSession").is_none());
    assert!(saved.needs_retry);
    assert_eq!(saved.snapshot.coverage[0].state, "unknown");
    drop(reader);
    drop(control);
    assert!(reader_task.await.unwrap().is_err());
    assert!(controller_task.await.unwrap().is_err());
}

#[path = "service_checkpoint_tests.rs"]
mod checkpoints;
