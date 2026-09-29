use super::*;
use crate::terminal::{TerminalConfig, TerminalSession};

fn fixture() -> (AppState, HookEvent) {
    let state = AppState::new();
    let session = TerminalSession::new("pane".into(), TerminalConfig::default());
    let mut event = laymux_agent_hook::runtime::parse_event(
        "codex",
        &json!({"session_id":"session-a","hook_event_name":"SessionStart","source":"resume"}),
        "pane".into(),
        session.agent_hook_token.clone(),
    )
    .unwrap();
    event.emitted_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    state
        .terminals
        .lock_or_err()
        .unwrap()
        .insert("pane".into(), session);
    (state, event)
}

#[test]
fn accepts_current_generation_and_redacts_token_from_status() {
    let (state, event) = fixture();
    let token = event.token.clone();
    accept(&state, event).unwrap();
    let status = connections(&state).unwrap();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0]["sessionId"], "session-a");
    assert!(!serde_json::to_string(&status).unwrap().contains(&token));
}

#[test]
fn restart_and_late_previous_session_end_cannot_replace_current_session() {
    let (state, old) = fixture();
    accept(&state, old.clone()).unwrap();
    let mut new = old.clone();
    new.session_id = "session-b".into();
    accept(&state, new).unwrap();
    let mut end = old.clone();
    end.event = "SessionEnd".into();
    accept(&state, end).unwrap();
    assert_eq!(connections(&state).unwrap()[0]["sessionId"], "session-b");
    state.terminals.lock_or_err().unwrap().insert(
        "pane".into(),
        TerminalSession::new("pane".into(), TerminalConfig::default()),
    );
    assert!(accept(&state, old).is_err());
    assert!(connections(&state).unwrap().is_empty());
}

#[test]
fn subagents_and_expired_observations_do_not_bind_a_pane() {
    let (state, mut event) = fixture();
    event.agent_id = Some("child".into());
    accept(&state, event.clone()).unwrap();
    assert!(connections(&state).unwrap().is_empty());
    event.agent_id = None;
    event.emitted_at_ms = 0;
    assert!(accept(&state, event).is_err());
}
