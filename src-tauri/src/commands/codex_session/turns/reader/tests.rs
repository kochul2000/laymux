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
