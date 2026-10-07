use super::models::AttributionCoverage;
use super::*;
use crate::settings::Settings;
fn fixture() -> (tempfile::TempDir, LocalStateStore, LocalSessionSnapshot) {
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStateStore::new(temp.path().join("state.db"));
    let mut settings = Settings::default();
    settings.workspaces[0].panes[0].id = "native".into();
    settings.workspaces[0].panes[0].content_views_mut()[0].extra["lastCodexSession"] =
        "conversation-a".into();
    settings.workspaces[0].panes[0].content_views_mut()[0].extra["lastCwd"] =
        "D:/host-a/project".into();
    let snapshot = LocalSessionSnapshot {
        workspaces: settings.workspaces,
        docks: settings.docks,
        coverage: vec![AttributionCoverage {
            terminal_id: "terminal-native".into(),
            state: "identified".into(),
            generation: Some(2),
            provider: Some("codex".into()),
            session_id: Some("conversation-a".into()),
        }],
        ..Default::default()
    };
    (temp, store, snapshot)
}

#[test]
fn stacked_pane_round_trip_preserves_hidden_layer_conversations_and_active_layer() {
    let (_temp, store, mut snapshot) = fixture();
    snapshot.workspaces[0].panes[0] = serde_json::from_value(serde_json::json!({
        "id":"slot","x":0,"y":0,"w":1,"h":1,"activeLayerId":"hidden",
        "layers":[
            {"id":"native","view":{"type":"TerminalView","profile":"PowerShell","lastCodexSession":"conversation-a"}},
            {"id":"hidden","view":{"type":"TerminalView","profile":"PowerShell","lastClaudeSession":"conversation-c"}}
        ]
    })).unwrap();
    store.commit_session(&snapshot).unwrap();
    let restarted = LocalStateStore::new(store.path());
    let loaded = restarted.load_session().unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&loaded.workspaces).unwrap(),
        serde_json::to_value(&snapshot.workspaces).unwrap()
    );
    snapshot.coverage[0].state = "unknown".into();
    snapshot.workspaces[0].panes[0].layers[0].view.extra["lastCodexSession"] = "unproven".into();
    let partial = store.commit_session(&snapshot).unwrap();
    assert_eq!(
        partial.snapshot.workspaces[0].panes[0].layers[0].view.extra["lastCodexSession"],
        "conversation-a"
    );
}

#[test]
fn portable_stacked_templates_do_not_export_layer_paths_or_conversation_ids() {
    let mut settings = Settings::default();
    settings.layouts[0].panes[0].layers = serde_json::from_value(serde_json::json!([
        {"viewType":"TerminalView","viewConfig":{"profile":"PowerShell","lastCodexSession":"private-layer-id","configDir":"D:/host-a/codex"}},
        {"viewType":"MemoView","viewConfig":{"path":"D:/host-a/memo.txt"}}
    ])).unwrap();
    let encoded = portable_value(&settings).unwrap().to_string();
    assert!(!encoded.contains("private-layer-id"));
    assert!(!encoded.contains("host-a"));
    assert!(encoded.contains("MemoView"));
}
#[test]
fn portable_settings_do_not_export_host_commands_or_runtime_or_template_restore_fields() {
    let mut settings = Settings::default();
    settings.profiles[0].command_line = "D:/private/pwsh.exe".into();
    settings.profiles[0].starting_directory = "D:/host-a/project".into();
    settings.paste.image_dir = "D:/host-a/pasted-images".into();
    settings.issue_reporter.shell = "wsl.exe -d host-a --".into();
    settings.layouts[0].panes[0].view_config = Some(
        serde_json::json!({"type":"TerminalView","profile":"PowerShell","lastCodexSession":"private-id","lastCwd":"D:/private","configDir":"/tmp/host-a"}),
    );
    let value = portable_value(&settings).unwrap();
    let encoded = serde_json::to_string(&value).unwrap();
    for forbidden in [
        "workspaces",
        "docks",
        "private-id",
        "D:/private",
        "host-a",
        "commandLine",
        "cloudInstanceId",
    ] {
        assert!(!encoded.contains(forbidden), "{forbidden}");
    }
    assert_eq!(value["profiles"][0]["name"], "PowerShell");
}
#[test]
fn session_commit_is_durable_and_does_not_create_or_write_user_settings() {
    let (temp, store, snapshot) = fixture();
    let commit = store.commit_session(&snapshot).unwrap();
    assert_eq!(commit.revision, 1);
    let restarted = LocalStateStore::new(store.path());
    let loaded = restarted.load_session().unwrap().unwrap();
    assert_eq!(
        loaded.workspaces[0].panes[0].content_views()[0].1.extra["lastCodexSession"],
        "conversation-a"
    );
    assert!(!temp.path().join("settings.json").exists());
}
#[test]
fn unknown_preserves_previous_proof_and_reports_retry_then_converges_without_new_event() {
    let (_temp, store, mut snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    snapshot.coverage[0].state = "unknown".into();
    snapshot.workspaces[0].panes[0].content_views_mut()[0].extra["lastCodexSession"] =
        "unproven-id".into();
    let partial = store.commit_session(&snapshot).unwrap();
    assert!(partial.needs_retry);
    assert_eq!(partial.unresolved_terminal_ids, ["terminal-native"]);
    assert_eq!(
        store.load_session().unwrap().unwrap().workspaces[0].panes[0].content_views()[0]
            .1
            .extra["lastCodexSession"],
        "conversation-a"
    );
    snapshot.coverage[0].state = "identified".into();
    snapshot.coverage[0].session_id = Some("conversation-b".into());
    snapshot.workspaces[0].panes[0].content_views_mut()[0].extra["lastCodexSession"] =
        "conversation-b".into();
    assert!(!store.commit_session(&snapshot).unwrap().needs_retry);
    assert_eq!(
        store.load_session().unwrap().unwrap().workspaces[0].panes[0].content_views()[0]
            .1
            .extra["lastCodexSession"],
        "conversation-b"
    );
}
#[test]
fn invalid_duplicate_pane_rolls_back_the_entire_transaction() {
    let (_temp, store, mut snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    let old = store.revision().unwrap();
    let duplicate = snapshot.workspaces[0].panes[0].clone();
    snapshot.workspaces[0].panes.push(duplicate);
    assert!(store.commit_session(&snapshot).is_err());
    assert_eq!(store.revision().unwrap(), old);
    assert_eq!(
        store.load_session().unwrap().unwrap().workspaces[0]
            .panes
            .len(),
        1
    );
}
#[test]
fn configuration_is_bound_by_profile_name_and_does_not_replace_local_session() {
    let (_temp, store, snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    let mut settings = Settings::default();
    settings.profiles[0].command_line = "D:/tools/pwsh.exe".into();
    let (_, machine) = split_configuration(&settings).unwrap();
    store.save_configuration(&machine).unwrap();
    settings.profiles.reverse();
    apply_configuration(&mut settings, store.load_configuration().unwrap()).unwrap();
    assert_eq!(
        settings
            .profiles
            .iter()
            .find(|p| p.name == "PowerShell")
            .unwrap()
            .command_line,
        "D:/tools/pwsh.exe"
    );
    assert!(store.load_session().unwrap().is_some());
}
#[test]
fn corrupt_database_is_an_error_and_is_not_deleted_or_overwritten() {
    let (temp, store, snapshot) = fixture();
    std::fs::write(store.path(), "corrupt local state").unwrap();
    assert!(store.load_session().is_err());
    assert!(store.commit_session(&snapshot).is_err());
    assert_eq!(
        std::fs::read(temp.path().join("state.db")).unwrap(),
        b"corrupt local state"
    );
}
#[test]
fn an_unknown_terminal_does_not_restore_agent_fields_into_a_replaced_memo_view() {
    let (_temp, store, mut snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    snapshot.coverage[0].state = "unknown".into();
    snapshot.workspaces[0].panes[0].view =
        serde_json::from_value(serde_json::json!({"type":"MemoView"})).unwrap();
    store.commit_session(&snapshot).unwrap();
    assert!(
        store.load_session().unwrap().unwrap().workspaces[0].panes[0].content_views()[0]
            .1
            .extra
            .get("lastCodexSession")
            .is_none()
    );
}
#[test]
fn failed_cwd_observation_preserves_the_last_committed_directory() {
    let (_temp, store, mut snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    snapshot.cwd_lookup_failed = true;
    snapshot.workspaces[0].panes[0].content_views_mut()[0].extra["lastCwd"] =
        "stale-directory".into();
    assert!(store.commit_session(&snapshot).unwrap().needs_retry);
    assert_eq!(
        store.load_session().unwrap().unwrap().workspaces[0].panes[0].content_views()[0]
            .1
            .extra["lastCwd"],
        "D:/host-a/project"
    );
}
#[test]
fn a_locked_writer_fails_boundedly_and_wal_readers_keep_the_previous_commit() {
    let (_temp, store, snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    let lock = rusqlite::Connection::open(store.path()).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = store.revision().unwrap();
    assert!(store.load_session().unwrap().is_some());
    assert!(store.commit_session(&snapshot).is_err());
    lock.execute_batch("ROLLBACK").unwrap();
    assert_eq!(store.revision().unwrap(), before);
    assert!(store.commit_session(&snapshot).is_ok());
}
#[test]
fn concurrent_commits_never_mix_groups_and_panes_and_have_monotonic_revisions() {
    let (_temp, store, snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    let mut other = snapshot.clone();
    other.workspaces[0].name = "other".into();
    other.workspaces[0].panes[0].id = "other-pane".into();
    std::thread::scope(|scope| {
        let one = scope.spawn(|| store.commit_session(&snapshot).unwrap().revision);
        let two = scope.spawn(|| store.commit_session(&other).unwrap().revision);
        let mut revisions = [one.join().unwrap(), two.join().unwrap()];
        revisions.sort();
        assert_eq!(revisions, [2, 3]);
    });
    let final_state = store.load_session().unwrap().unwrap();
    assert_eq!(
        final_state.workspaces[0].panes[0].id,
        if final_state.workspaces[0].name == "other" {
            "other-pane"
        } else {
            "native"
        }
    );
}
#[test]
fn duplicate_profile_names_cannot_alias_a_machine_binding() {
    let mut settings = Settings::default();
    settings.profiles.push(settings.profiles[0].clone());
    assert!(split_configuration(&settings).is_err());
}
#[test]
fn unknown_does_not_resurrect_a_previous_conversation_over_an_explicit_fresh_launch() {
    let (_temp, store, mut snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    snapshot.coverage[0].state = "unknown".into();
    snapshot.workspaces[0].panes[0].view =
        serde_json::from_value(serde_json::json!({"type":"TerminalView","lastAgentFresh":"codex"}))
            .unwrap();
    store.commit_session(&snapshot).unwrap();
    let view = store.load_session().unwrap().unwrap().workspaces[0].panes[0]
        .view
        .clone()
        .unwrap();
    assert!(view.extra.get("lastCodexSession").is_none());
    assert_eq!(view.extra["lastAgentFresh"], "codex");
}
#[test]
fn sqlite_full_does_not_publish_a_revision_or_lose_the_previous_checkpoint() {
    let (_temp, store, mut snapshot) = fixture();
    store.commit_session(&snapshot).unwrap();
    let before = store.revision().unwrap();
    let mut connection = rusqlite::Connection::open(store.path()).unwrap();
    let pages: i64 = connection
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .unwrap();
    connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    snapshot.workspaces[0].panes[0].content_views_mut()[0].extra["largeTestMetadata"] =
        "x".repeat(512 * 1024).into();
    let error = LocalStateStore::commit_session_connection(&mut connection, &snapshot).unwrap_err();
    assert!(
        matches!(error,crate::error::AppError::Sqlite(rusqlite::Error::SqliteFailure(code,_)) if code.code==rusqlite::ErrorCode::DiskFull)
    );
    assert_eq!(store.revision().unwrap(), before);
    assert!(
        store.load_session().unwrap().unwrap().workspaces[0].panes[0].content_views()[0]
            .1
            .extra
            .get("largeTestMetadata")
            .is_none()
    );
}
