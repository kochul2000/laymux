use super::*;
use std::io::Write;

fn append(file: &mut File, kind: &str, id: &str) {
    writeln!(
        file,
        "{}",
        serde_json::json!({"type":"event_msg","payload":{"type":kind,"turn_id":id}})
    )
    .unwrap();
    file.flush().unwrap();
}

fn review_boundary(file: &mut File, paginated: bool, entering: bool, id: &str) {
    let payload = if paginated {
        serde_json::json!({
            "type": "item_completed", "turn_id": id,
            "item": {"type": if entering { "EnteredReviewMode" } else { "ExitedReviewMode" }}
        })
    } else {
        serde_json::json!({
            "type": if entering { "entered_review_mode" } else { "exited_review_mode" },
            "turn_id": id
        })
    };
    writeln!(
        file,
        "{}",
        serde_json::json!({"type": "event_msg", "payload": payload})
    )
    .unwrap();
    file.flush().unwrap();
}

#[test]
fn review_parent_completion_follows_forwarded_child_start_in_both_history_formats() {
    for paginated in [false, true] {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let mut reader = TurnReader::default();
        // Codex 0.154.0 /review writes the parent's boundary, the delegate's
        // start, then the parent's exit boundary and completion to one rollout.
        review_boundary(file.as_file_mut(), paginated, true, "parent");
        append(file.as_file_mut(), "task_started", "child");
        assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
        review_boundary(file.as_file_mut(), paginated, false, "parent");
        assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
        append(file.as_file_mut(), "task_complete", "parent");
        assert_eq!(
            reader.read(file.path()).unwrap(),
            Turn {
                state: TurnState::Completed,
                turn_id: Some("parent".into()),
            }
        );
        append(file.as_file_mut(), "task_started", "next");
        append(file.as_file_mut(), "task_complete", "parent");
        assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
        append(file.as_file_mut(), "task_complete", "next");
        assert_eq!(
            reader.read(file.path()).unwrap().state,
            TurnState::Completed
        );
    }
}

#[test]
fn review_exit_restores_parent_from_tail_without_claiming_success_before_abort() {
    for paginated in [false, true] {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let mut reader = TurnReader::default();
        append(file.as_file_mut(), "task_started", "child");
        // Initial tail may omit EnteredReviewMode. ExitedReviewMode is also
        // emitted on abort, so only a later parent terminal event can end work.
        review_boundary(file.as_file_mut(), paginated, false, "parent");
        assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
        append(file.as_file_mut(), "turn_aborted", "parent");
        assert_eq!(
            reader.read(file.path()).unwrap().state,
            TurnState::Interrupted
        );
    }
}

#[test]
fn follows_consecutive_turns_and_ignores_old_completions() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut reader = TurnReader::default();
    append(file.as_file_mut(), "task_started", "a");
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
    append(file.as_file_mut(), "task_complete", "a");
    assert_eq!(
        reader.read(file.path()).unwrap().state,
        TurnState::Completed
    );
    append(file.as_file_mut(), "task_started", "b");
    append(file.as_file_mut(), "task_complete", "a");
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
    append(file.as_file_mut(), "turn_aborted", "b");
    assert_eq!(
        reader.read(file.path()).unwrap().state,
        TurnState::Interrupted
    );
}

#[test]
fn quiet_turn_survives_large_tool_output_and_partial_lines_do_not_replay_success() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut reader = TurnReader::default();
    append(file.as_file_mut(), "task_started", "a");
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
    for _ in 0..12 {
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"response_item","payload":"x".repeat(100_000)})
        )
        .unwrap();
        assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
    }
    append(file.as_file_mut(), "task_complete", "a");
    assert_eq!(
        reader.read(file.path()).unwrap().state,
        TurnState::Completed
    );
    write!(file, "{{\"type\":\"event_msg\",\"payload\":").unwrap();
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Unknown);
    writeln!(file, "{{\"type\":\"task_started\",\"turn_id\":\"b\"}}}}").unwrap();
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
}

#[test]
fn errors_malformed_events_and_rewritten_files_never_inherit_success() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut reader = TurnReader::default();
    writeln!(file, "{}", serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"a","error":{"message":"failed"}}})).unwrap();
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Failed);
    file.as_file_mut().set_len(0).unwrap();
    file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
    append(file.as_file_mut(), "task_complete", "b");
    assert_eq!(
        reader.read(file.path()).unwrap().state,
        TurnState::Completed
    );
    writeln!(file, "{{bad json}}").unwrap();
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Unknown);
    append(file.as_file_mut(), "task_complete", "");
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Unknown);
}

#[test]
fn initial_tail_and_catchup_are_bounded_and_unknown_until_a_boundary() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    append(file.as_file_mut(), "task_complete", "old");
    file.write_all(&vec![b'x'; READ_LIMIT + 10]).unwrap();
    let mut reader = TurnReader::default();
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Unknown);
    writeln!(file).unwrap();
    append(file.as_file_mut(), "turn_started", "new");
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Running);
    append(file.as_file_mut(), "turn_complete", "new");
    assert_eq!(
        reader.read(file.path()).unwrap().state,
        TurnState::Completed
    );
}

#[test]
fn same_length_rewrite_with_unchanged_tail_does_not_keep_old_success() {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut reader = TurnReader::default();
    let record = |kind: &str| {
        format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"{kind}\",\"turn_id\":\"a\",\"last_agent_message\":\"{}\"}}}}\n", "x".repeat(256))
    };
    file.write_all(record("task_complete").as_bytes()).unwrap();
    file.as_file_mut()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(
        reader.read(file.path()).unwrap().state,
        TurnState::Completed
    );
    // Equal-length unknown lifecycle and the same final 64 bytes.
    file.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
    file.write_all(record("task_replaced").as_bytes()).unwrap();
    file.as_file_mut()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(20))
        .unwrap();
    assert_eq!(reader.read(file.path()).unwrap().state, TurnState::Unknown);
}
