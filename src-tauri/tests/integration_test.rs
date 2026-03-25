use laymux_lib::state::AppState;
use laymux_lib::terminal::{TerminalConfig, TerminalSession, SyncGroup};

#[test]
fn state_manages_terminal_sessions() {
    let state = AppState::new();
    let mut terminals = state.terminals.lock().unwrap();

    let config = TerminalConfig::default();
    let session = TerminalSession::new("t1".into(), config);
    terminals.insert("t1".into(), session);

    assert_eq!(terminals.len(), 1);
    assert!(terminals.contains_key("t1"));

    terminals.remove("t1");
    assert!(terminals.is_empty());
}

#[test]
fn multiple_sessions_coexist() {
    let state = AppState::new();
    let mut terminals = state.terminals.lock().unwrap();

    for i in 0..5 {
        let id = format!("term-{i}");
        terminals.insert(id.clone(), TerminalSession::new(id, TerminalConfig::default()));
    }

    assert_eq!(terminals.len(), 5);
}

#[test]
fn sync_groups_track_terminals() {
    let state = AppState::new();

    // Add terminals to sync group
    let mut groups = state.sync_groups.lock().unwrap();
    let mut group = SyncGroup::new("project-a".into());
    group.add_terminal("t1".into());
    group.add_terminal("t2".into());
    groups.insert("project-a".into(), group);

    let group = groups.get("project-a").unwrap();
    assert_eq!(group.terminal_ids.len(), 2);
}

#[test]
fn sync_group_removal() {
    let mut group = SyncGroup::new("test".into());
    group.add_terminal("t1".into());
    group.add_terminal("t2".into());
    group.add_terminal("t3".into());

    group.remove_terminal("t2");
    assert_eq!(group.terminal_ids, vec!["t1", "t3"]);
}
