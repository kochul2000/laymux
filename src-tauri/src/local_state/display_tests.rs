use super::*;

#[test]
fn display_history_survives_database_restart_and_stays_out_of_portable_settings() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.db");
    let mut snapshot = LocalSessionSnapshot::default();
    let mut settings = crate::settings::Settings::default();
    snapshot.workspaces = settings.workspaces.clone();
    let context = serde_json::json!({
        "version":1,"profile":"PowerShell",
        "lastUserInput":"saved private question","lastUserInputAt":123,
        "activity":{"type":"interactiveApp","name":"Codex"},
        "task":{"state":"ended","result":"success","observation":"stale"}
    });
    snapshot
        .ui_state
        .terminal_display_contexts
        .insert("terminal-saved".into(), context.clone());
    LocalStateStore::new(&path)
        .commit_session(&snapshot)
        .unwrap();
    let loaded = LocalStateStore::new(&path).load_session().unwrap().unwrap();
    assert_eq!(
        loaded.ui_state.terminal_display_contexts["terminal-saved"],
        context
    );
    settings.local_ui_state = Some(loaded.ui_state);
    let portable = portable_value(&settings).unwrap().to_string();
    assert!(!portable.contains("saved private question"));
    assert!(!portable.contains("terminalDisplayContexts"));
    assert!(!portable.contains("localUiState"));
}

#[test]
fn checkpoints_written_before_display_history_remain_readable() {
    let state: LocalUiState = serde_json::from_value(serde_json::json!({
        "activeWorkspaceId":"workspace","fileViewer":null
    }))
    .unwrap();
    assert!(state.terminal_display_contexts.is_empty());
}
