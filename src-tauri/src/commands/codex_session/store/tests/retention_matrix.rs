use super::*;

// Cross the retained evidence with the file states; neither CWD nor the older
// valid conversation is allowed to repair an inconclusive current selection.
#[test]
fn retention_lifecycle_rollout_matrix() {
    let mut checks = 0;
    for journal in ["DELETE", "WAL"] {
        for retention in ["intact", "initial", "partial", "all", "late_only"] {
            for state in [
                "fresh",
                "running",
                "completed",
                "failed",
                "interrupted",
                "clear",
                "clear_input",
                "resume",
                "resume_a",
            ] {
                for file in [
                    "absent",
                    "valid",
                    "partial",
                    "appending",
                    "duplicate",
                    "expired",
                    "wrong_id",
                ] {
                    let temp = tempfile::tempdir().unwrap();
                    let logs = create_logs_db(temp.path());
                    logs.pragma_update(None, "journal_mode", journal).unwrap();
                    let process = "pid:101:current";
                    insert_log(&logs, 1, "pid:101:previous", None);
                    insert_log(&logs, 2, process, None);
                    insert_log(&logs, 3, process, None);
                    insert_log(&logs, 4, process, Some(SESSION_A));
                    lifecycle_log(&logs, 4, "old", "start", SESSION_A);
                    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
                    insert_log(&logs, 5, process, None);
                    let selected = if state == "resume_a" {
                        SESSION_A
                    } else {
                        SESSION_B
                    };
                    let method = if state.starts_with("resume") {
                        "resume"
                    } else {
                        "start"
                    };
                    insert_log(&logs, 6, process, Some(selected));
                    lifecycle_log(&logs, 6, "new", method, selected);
                    let has_input = !matches!(state, "fresh" | "clear" | "resume" | "resume_a");
                    if has_input {
                        insert_log(&logs, 7, process, Some(selected));
                        logs.execute(
                            "UPDATE logs SET feedback_log_body=?1 WHERE id=7",
                            [format!("session_loop{{thread_id={selected}}}: {state}")],
                        )
                        .unwrap();
                    }
                    // Delayed old initialization and a newer temporary title request.
                    insert_log(&logs, 8, process, Some(SESSION_A));
                    lifecycle_log(&logs, 8, "old", "start", SESSION_A);
                    insert_log(&logs, 9, process, Some(SESSION_A));
                    lifecycle_log(&logs, 9, "temporary-structured-title", "start", SESSION_A);
                    insert_log(&logs, 10, process, None);
                    let predicate = match retention {
                        "intact" => "0",
                        "initial" => "id=2",
                        "partial" => "id IN (2,5)",
                        "all" => "thread_id IS NULL",
                        "late_only" => "thread_id IS NULL AND id<10",
                        _ => unreachable!(),
                    };
                    logs.execute(
                        &format!("DELETE FROM logs WHERE process_uuid=?1 AND ({predicate})"),
                        [process],
                    )
                    .unwrap();
                    let path = write_rollout(temp.path(), selected, ",\"source\":\"cli\"");
                    match file {
                        "absent" => std::fs::remove_file(&path).unwrap(),
                        "partial" => {
                            std::fs::write(&path, "{\"type\":\"session_meta\",\"payload\":")
                                .unwrap()
                        }
                        "appending" => {
                            use std::io::Write;
                            std::fs::OpenOptions::new()
                                .append(true)
                                .open(&path)
                                .unwrap()
                                .write_all(b"{\"type\":\"event_msg\"")
                                .unwrap();
                        }
                        "duplicate" => {
                            std::fs::copy(
                                &path,
                                temp.path()
                                    .join("sessions")
                                    .join(format!("rollout-duplicate-{selected}.jsonl")),
                            )
                            .unwrap();
                        }
                        "expired" => std::fs::File::options()
                            .write(true)
                            .open(&path)
                            .unwrap()
                            .set_modified(SystemTime::now() - Duration::from_secs(48 * 3600))
                            .unwrap(),
                        "wrong_id" => {
                            std::fs::write(&path, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong\",\"cwd\":\"/same\"}}\n").unwrap();
                        }
                        _ => {}
                    }
                    for guest in [false, true] {
                        let store = if guest {
                            CodexSessionStore::for_guest(temp.path().into())
                        } else {
                            CodexSessionStore::new(temp.path().into(), temp.path().into())
                        };
                        let result = if guest {
                            let rows = read_lifecycle_rows(&logs, process, 0).unwrap();
                            store.resolve_selection(
                                crate::commands::codex_session::lifecycle::select(&rows).unwrap(),
                                Some(24),
                            )
                        } else {
                            store.find_selection_for_pid_checked(101, Some(24))
                        };
                        let context = format!("{journal} {retention} {state} {file} guest={guest}");
                        if file == "partial" {
                            assert!(result.is_err(), "{context}");
                        } else {
                            let actual = result.unwrap().map(|s| (s.id, s.fresh));
                            let expected = match file {
                                "valid" | "appending" => Some((selected.to_owned(), false)),
                                "absent" if !has_input && method == "start" => {
                                    Some((selected.to_owned(), true))
                                }
                                _ => None,
                            };
                            assert_eq!(actual, expected, "{context}");
                        }
                        checks += 1;
                    }
                }
            }
        }
    }
    assert_eq!(checks, 1260);
    println!("retention_lifecycle_rollout_matrix: {checks} verified observations");
}

fn lifecycle_log(logs: &Connection, row: i64, request: &str, method: &str, id: &str) {
    logs.execute("UPDATE logs SET feedback_log_body=?1 WHERE id=?2", (format!("app_server.request{{rpc.method=\"thread/{method}\" rpc.request_id={request} app_server.client_name=\"codex-tui\"}}:thread_spawn{{}}:session_init:environments.resolve{{}}:shell_snapshot{{thread_id={id}}}: ready"), row)).unwrap();
}

#[test]
fn lookup_faults_recover_without_reopening_the_store() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    insert_log(&logs, 1, "pid:101:current", Some(SESSION_A));
    lifecycle_log(&logs, 1, "1", "start", SESSION_A);
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    logs.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(store.find_selection_for_pid_checked(101, None).is_err());
    logs.execute_batch("ROLLBACK").unwrap();
    assert!(
        store
            .find_selection_for_pid_checked(101, None)
            .unwrap()
            .unwrap()
            .fresh
    );
    let corrupt = temp.path().join("logs_99.sqlite");
    std::fs::write(&corrupt, "corrupt").unwrap();
    assert!(store.find_selection_for_pid_checked(101, None).is_err());
    std::fs::remove_file(corrupt).unwrap();
    assert!(
        store
            .find_selection_for_pid_checked(101, None)
            .unwrap()
            .unwrap()
            .fresh
    );
    let rollout = write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&rollout)
            .unwrap();
        assert!(store.find_selection_for_pid_checked(101, None).is_err());
        drop(lock);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&rollout, std::fs::Permissions::from_mode(0)).unwrap();
        assert!(store.find_selection_for_pid_checked(101, None).is_err());
        std::fs::set_permissions(&rollout, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(
        store
            .find_session_for_pid_checked(101, None)
            .unwrap()
            .as_deref(),
        Some(SESSION_A)
    );
    logs.execute("DELETE FROM logs", []).unwrap();
    assert!(store
        .find_selection_for_pid_checked(101, None)
        .unwrap()
        .is_none());
}
