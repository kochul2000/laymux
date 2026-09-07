use super::*;

const SESSION_A: &str = "019fc0d8-a862-7241-a0f5-b6a66ef4ef6f";
const SESSION_B: &str = "019fc114-970b-7933-a31b-bbd53883b57e";

fn create_logs_db(dir: &Path) -> Connection {
    let connection = Connection::open(dir.join("logs_2.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE logs (
                id INTEGER PRIMARY KEY,
                ts INTEGER NOT NULL,
                ts_nanos INTEGER NOT NULL,
                process_uuid TEXT NOT NULL,
                    thread_id TEXT,
                    feedback_log_body TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX idx_logs_process_uuid_threadless_ts
             ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
             WHERE thread_id IS NULL;",
        )
        .unwrap();
    connection
}

fn insert_log(connection: &Connection, id: i64, process_uuid: &str, thread_id: Option<&str>) {
    connection
        .execute(
            "INSERT INTO logs(id, ts, ts_nanos, process_uuid, thread_id)
             VALUES (?1, ?1, 0, ?2, ?3)",
            (id, process_uuid, thread_id),
        )
        .unwrap();
}

fn write_rollout(dir: &Path, session_id: &str, extra_payload: &str) -> PathBuf {
    let nested = dir.join("sessions").join("2000").join("01").join("01");
    std::fs::create_dir_all(&nested).unwrap();
    let path = nested.join(format!("rollout-test-{session_id}.jsonl"));
    let content = format!(
        "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/work/shared\"{extra_payload}}}}}\n"
    );
    std::fs::write(&path, content).unwrap();
    path
}

fn create_state_db(dir: &Path, session_id: &str, rollout_path: &Path) {
    let connection = Connection::open(dir.join("state_5.sqlite")).unwrap();
    connection
        .execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);")
        .unwrap();
    connection
        .execute(
            "INSERT INTO threads(id, rollout_path) VALUES (?1, ?2)",
            (session_id, rollout_path.to_string_lossy().as_ref()),
        )
        .unwrap();
}

#[test]
fn pid_resolves_its_own_top_level_thread() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:101:uuid-a", None);
    insert_log(&logs, 2, "pid:101:uuid-a", Some(SESSION_A));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");

    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(101, None).as_deref(),
        Some(SESSION_A)
    );
}

#[test]
fn state_database_rollout_path_is_validated_before_filename_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:105:uuid", None);
    insert_log(&logs, 2, "pid:105:uuid", Some(SESSION_A));
    let rollout_path = temp.path().join("rollout-without-id.jsonl");
    std::fs::write(
        &rollout_path,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{SESSION_A}\",\"cwd\":\"/work/shared\",\"source\":\"cli\"}}}}\n"
        ),
    )
    .unwrap();
    create_state_db(temp.path(), SESSION_A, &rollout_path);

    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(105, None).as_deref(),
        Some(SESSION_A)
    );
}

#[test]
fn open_rollout_paths_select_the_unique_top_level_thread() {
    let temp = tempfile::tempdir().unwrap();
    let parent = write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    let subagent = write_rollout(
        temp.path(),
        SESSION_B,
        &format!(",\"parent_thread_id\":\"{SESSION_A}\",\"thread_source\":\"subagent\""),
    );
    assert_eq!(
        find_session_from_rollout_paths(&[subagent, parent], None).as_deref(),
        Some(SESSION_A)
    );
}

#[test]
fn multiple_open_top_level_rollouts_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let first = write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    let second = write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
    assert_eq!(
        find_session_from_rollout_paths(&[first, second], None),
        None
    );
}

#[test]
fn latest_process_uuid_wins_when_os_pid_was_reused() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:101:old", None);
    insert_log(&logs, 2, "pid:101:old", Some(SESSION_A));
    insert_log(&logs, 10, "pid:101:new", None);
    insert_log(&logs, 11, "pid:101:new", Some(SESSION_B));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");

    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(101, None).as_deref(),
        Some(SESSION_B)
    );
}

#[test]
fn temporary_title_thread_without_rollout_does_not_hide_the_interactive_thread() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:106:uuid", None);
    insert_log(&logs, 2, "pid:106:uuid", Some(SESSION_A));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    insert_log(&logs, 3, "pid:106:uuid", Some(SESSION_B));
    insert_log(&logs, 4, "pid:106:uuid", None);
    let body = format!(
        "app_server.request{{rpc.method=\"thread/start\" rpc.request_id=temporary-structured-title app_server.client_name=\"codex-tui\"}}:app_server.thread_start.create_thread{{}}:thread_spawn{{}}:session_init:startup_prewarm{{otel.name=\"startup_prewarm\" thread.id={SESSION_B}}}: warmup"
    );
    logs.execute("UPDATE logs SET feedback_log_body=?1 WHERE id=4", [&body])
        .unwrap();
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store
            .find_session_for_pid_checked(106, None)
            .unwrap()
            .as_deref(),
        Some(SESSION_A)
    );

    // A message merely quoting a diagnostic span is not lifecycle evidence.
    logs.execute(
        "UPDATE logs SET feedback_log_body=?1 WHERE id=4",
        [format!("session_loop{{}}: user quoted {body}")],
    )
    .unwrap();
    assert_eq!(store.find_session_for_pid_checked(106, None).unwrap(), None);
    logs.execute(
        "UPDATE logs SET feedback_log_body=?1,process_uuid='pid:107:other' WHERE id=4",
        [&body],
    )
    .unwrap();
    assert_eq!(store.find_session_for_pid_checked(106, None).unwrap(), None);
}

#[test]
fn clear_without_a_new_rollout_must_not_restore_the_previous_thread() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:106:uuid", None);
    insert_log(&logs, 2, "pid:106:uuid", Some(SESSION_A));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(106, None).as_deref(),
        Some(SESSION_A)
    );

    // /clear creates the thread before its first user turn creates a rollout.
    insert_log(&logs, 3, "pid:106:uuid", Some(SESSION_B));
    assert_eq!(store.find_session_for_pid(106, None), None);

    write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
    assert_eq!(
        store.find_session_for_pid(106, None).as_deref(),
        Some(SESSION_B)
    );
}

#[test]
fn rejected_newer_thread_must_not_restore_an_older_valid_thread() {
    for replacement in [
        r#"{"type":"event_msg","payload":{}}"#,
        r#"{"type":"session_meta","payload":{"id":"bad.id","cwd":"/work"}}"#,
        r#"{"type":"session_meta","payload":{"id":"019fc114-970b-7933-a31b-bbd53883b57e"}}"#,
        r#"{"type":"session_meta","payload":{"id":"019fc0d8-a862-7241-a0f5-b6a66ef4ef6f","cwd":"/work","source":"exec"}}"#,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:106:uuid", None);
        insert_log(&logs, 2, "pid:106:uuid", Some(SESSION_A));
        insert_log(&logs, 3, "pid:106:uuid", Some(SESSION_B));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        let new_path = write_rollout(temp.path(), SESSION_B, "");
        std::fs::write(new_path, replacement).unwrap();
        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(store.find_session_for_pid_checked(106, None).unwrap(), None);
    }
}

#[test]
fn expired_newer_thread_must_not_restore_an_older_recently_written_thread() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:106:uuid", None);
    insert_log(&logs, 2, "pid:106:uuid", Some(SESSION_A));
    insert_log(&logs, 3, "pid:106:uuid", Some(SESSION_B));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    let path = write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(48 * 3600))
        .unwrap();
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid_checked(106, Some(24)).unwrap(),
        None
    );
}

#[test]
fn same_process_can_switch_to_a_new_top_level_thread() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:106:uuid", None);
    insert_log(&logs, 2, "pid:106:uuid", Some(SESSION_A));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(106, None).as_deref(),
        Some(SESSION_A)
    );

    insert_log(&logs, 3, "pid:106:uuid", Some(SESSION_B));
    write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
    assert_eq!(
        store.find_session_for_pid(106, None).as_deref(),
        Some(SESSION_B)
    );
}

#[test]
fn newer_subagent_log_does_not_replace_parent_session() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:102:uuid", None);
    insert_log(&logs, 2, "pid:102:uuid", Some(SESSION_A));
    insert_log(&logs, 3, "pid:102:uuid", Some(SESSION_B));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    write_rollout(
        temp.path(),
        SESSION_B,
        &format!(",\"parent_thread_id\":\"{SESSION_A}\",\"thread_source\":\"subagent\""),
    );

    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(102, None).as_deref(),
        Some(SESSION_A)
    );
}

#[test]
fn recently_modified_rollout_in_old_date_directory_survives_age_filter() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:103:uuid", None);
    insert_log(&logs, 2, "pid:103:uuid", Some(SESSION_A));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");

    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(103, Some(6)).as_deref(),
        Some(SESSION_A)
    );
}

#[test]
fn non_interactive_exec_and_missing_diagnostics_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:104:uuid", None);
    insert_log(&logs, 2, "pid:104:uuid", Some(SESSION_A));
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"exec\"");

    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(store.find_session_for_pid(104, None), None);
    assert_eq!(store.find_session_for_pid(999, None), None);
}

#[test]
fn newest_numeric_database_version_is_selected() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("logs_2.sqlite"), "two").unwrap();
    std::fs::write(temp.path().join("logs_10.sqlite"), "ten").unwrap();
    std::fs::write(temp.path().join("logs_latest.sqlite"), "ignored").unwrap();
    assert_eq!(
        latest_versioned_db(temp.path(), "logs_"),
        Some(temp.path().join("logs_10.sqlite"))
    );
}

#[test]
fn corrupt_diagnostics_database_is_reported_as_lookup_failure() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("logs_1.sqlite"), "not sqlite").unwrap();
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());

    assert!(store.find_session_for_pid_checked(42, None).is_err());
}
