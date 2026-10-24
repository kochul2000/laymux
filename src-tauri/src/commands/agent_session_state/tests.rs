use super::*;

const SESSION_START: &str = r#"{"timestamp":1,"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"hook_execution","event_name":"session_start"}}}"#;
const USER_MESSAGE: &str = r#"{"timestamp":2,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#;
const TOOL_CALL: &str = r#"{"timestamp":3,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","title":"run_terminal_command"}}}"#;

fn completed(stop_reason: &str) -> String {
    format!(
        r#"{{"timestamp":4,"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"turn_completed","prompt_id":"p","stop_reason":"{stop_reason}"}}}}}}"#
    )
}

fn turn(lines: &[&str]) -> Option<GrokTurn> {
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    last_grok_turn(text.as_bytes(), false, "s")
}

#[test]
fn a_session_without_a_user_message_is_idle() {
    assert_eq!(
        turn(&[SESSION_START]),
        Some((AgentSessionStatus::Idle, None, None))
    );
    assert_eq!(turn(&[]), Some((AgentSessionStatus::Idle, None, None)));
}

#[test]
fn a_user_message_after_the_last_completion_is_running() {
    let done = completed("end_turn");
    assert_eq!(
        turn(&[SESSION_START, USER_MESSAGE, &done, USER_MESSAGE, TOOL_CALL]),
        Some((AgentSessionStatus::Running, None, None))
    );
}

#[test]
fn turn_completed_reports_how_the_turn_ended() {
    for (stop_reason, result) in [
        ("end_turn", Some(AgentTurnResult::Success)),
        ("cancelled", Some(AgentTurnResult::Interrupted)),
        ("max_tokens", None),
    ] {
        let done = completed(stop_reason);
        assert_eq!(
            turn(&[SESSION_START, USER_MESSAGE, TOOL_CALL, &done]),
            Some((AgentSessionStatus::Ended, result, Some("p".into()))),
            "{stop_reason}"
        );
    }
}

#[test]
fn a_line_still_being_written_is_ignored() {
    let done = completed("end_turn");
    let text = format!("{USER_MESSAGE}\n{done}\n{{\"timestamp\":5,\"params\":{{\"upd");
    assert_eq!(
        last_grok_turn(text.as_bytes(), false, "s"),
        Some((
            AgentSessionStatus::Ended,
            Some(AgentTurnResult::Success),
            Some("p".into())
        ))
    );
}

#[test]
fn an_unreadable_record_after_the_boundary_is_unknown() {
    let done = completed("end_turn");
    assert_eq!(turn(&[USER_MESSAGE, &done, "{not json"]), None);
}

#[test]
fn a_truncated_tail_skips_its_partial_first_line_and_never_infers_idle() {
    let done = completed("cancelled");
    let text = format!("ate\":{{}}}}\n{TOOL_CALL}\n{done}\n");
    assert_eq!(
        last_grok_turn(text.as_bytes(), true, "s"),
        Some((
            AgentSessionStatus::Ended,
            Some(AgentTurnResult::Interrupted),
            Some("p".into())
        ))
    );
    let text = format!("ate\":{{}}}}\n{TOOL_CALL}\n");
    assert_eq!(last_grok_turn(text.as_bytes(), true, "s"), None);
}

#[test]
fn read_grok_turn_reads_only_the_bounded_tail() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("updates.jsonl");
    let filler = format!("{TOOL_CALL}\n").repeat(GROK_UPDATES_READ_LIMIT as usize / 100);
    std::fs::write(&path, format!("{USER_MESSAGE}\n{filler}")).unwrap();
    assert_eq!(read_grok_turn(&path, "s").unwrap(), None);

    let done = completed("end_turn");
    std::fs::write(&path, format!("{USER_MESSAGE}\n{filler}{done}\n")).unwrap();
    assert_eq!(
        read_grok_turn(&path, "s").unwrap(),
        Some((
            AgentSessionStatus::Ended,
            Some(AgentTurnResult::Success),
            Some("p".into())
        ))
    );
}

#[test]
fn matching_prompt_id_from_another_recorded_session_is_not_completion() {
    let done = completed("end_turn");
    let text = format!("{done}\n");
    assert!(last_grok_turn(text.as_bytes(), false, "other-session").is_none());
}
