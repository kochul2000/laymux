use super::*;

fn append(db: &Connection, n: i64, process: &str, id: &str, body: String) {
    insert_log(db, n, process, Some(id));
    db.execute(
        "UPDATE logs SET feedback_log_body=?1 WHERE id=?2",
        (body, n),
    )
    .unwrap();
}

fn start(db: &Connection, n: i64, process: &str, id: &str) {
    append(db, n, process, id, format!("app_server.request{{rpc.method=\"thread/resume\" rpc.request_id={n} app_server.client_name=\"codex-tui\"}}:thread_spawn{{}}:session_init:startup_prewarm{{otel.name=\"startup_prewarm\" thread.id={id}}}: ready"));
}

fn activity(db: &Connection, n: i64, process: &str, id: &str, operation: &str) {
    append(db, n, process, id, format!("session_loop{{thread_id={id}}}: Submission sub=Submission {{ id: \"submission-{n}\", op: {operation}, trace: None, parent_turn_id: None, root_turn_id: None }}"));
}

#[test]
fn live_lifecycle_keeps_a_session_older_than_the_configured_age_limit() {
    for retained_only in [false, true] {
        for guest in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let logs = create_logs_db(temp.path());
            let process = "pid:101:current";
            start(&logs, 1, process, SESSION_A);
            activity(&logs, 2, process, SESSION_A, "Shutdown");
            start(&logs, 3, process, SESSION_B);
            activity(&logs, 4, process, SESSION_B, "TurnInput {}");
            if retained_only {
                logs.execute("DELETE FROM logs WHERE id=3", []).unwrap();
            }
            write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
            let current = write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
            let old_mtime = SystemTime::now() - Duration::from_secs(73 * 3600);
            std::fs::File::options()
                .write(true)
                .open(&current)
                .unwrap()
                .set_modified(old_mtime)
                .unwrap();
            let store = if guest {
                CodexSessionStore::for_guest(temp.path().into())
            } else {
                CodexSessionStore::new(temp.path().into(), temp.path().into())
            };
            let rows = super::super::super::lifecycle::ProcessRows {
                process_uuid: process.into(),
                rows: read_lifecycle_rows(&logs, process, 0).unwrap(),
            };
            // Exercise both observations used by the critical checkpoint.
            for _ in 0..2 {
                let selected = if guest {
                    store.resolve_process_rows(&rows)
                } else {
                    store.find_selection_for_pid_checked(101, Some(72))
                }
                .unwrap()
                .unwrap_or_else(|| {
                    panic!("live session lost: guest={guest}, retained={retained_only}")
                });
                assert_eq!(selected.id, SESSION_B);
                assert!(!selected.fresh);
                assert!(selected.selection_key.is_some());
            }
            assert_eq!(
                std::fs::metadata(current).unwrap().modified().unwrap(),
                old_mtime
            );
        }
    }
}

#[test]
fn per_thread_pruning_does_not_resurrect_a_closed_conversation_in_two_panes() {
    for journal in ["WAL", "DELETE"] {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        logs.pragma_update(None, "journal_mode", journal).unwrap();
        let process = "pid:101:current";
        start(&logs, 1, process, SESSION_A);
        activity(&logs, 2, process, SESSION_A, "Shutdown");
        start(&logs, 3, process, SESSION_B);
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
        for n in 4..1005 {
            activity(
                &logs,
                n,
                process,
                SESSION_B,
                "InterAgentCommunication { message: \"tick\" }",
            );
        }
        // Codex caps each thread independently, even across process UUIDs.
        logs.execute("DELETE FROM logs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id DESC) AS position FROM logs WHERE thread_id IS NOT NULL) WHERE position>1000)", []).unwrap();
        activity(&logs, 1005, process, "title", "Shutdown");
        activity(&logs, 1006, process, "child", "TurnInput {}");
        write_rollout(
            temp.path(),
            "child",
            ",\"source\":{\"subagent\":{\"thread_spawn\":{}}}",
        );
        start(&logs, 1007, "pid:202:current", SESSION_A);
        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(101, Some(72)).as_deref(),
            Some(SESSION_B),
            "{journal}"
        );
        assert_eq!(
            store.find_session_for_pid(202, Some(72)).as_deref(),
            Some(SESSION_A)
        );
        let rows = super::super::super::lifecycle::ProcessRows {
            process_uuid: process.into(),
            rows: read_lifecycle_rows(&logs, process, 0).unwrap(),
        };
        let guest = CodexSessionStore::for_guest(temp.path().into());
        assert_eq!(
            guest.resolve_process_rows(&rows).unwrap().unwrap().id,
            SESSION_B
        );
    }
}

#[test]
fn retained_loop_recovery_is_unique_and_stable_across_pruning_but_not_process_reuse() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
    for n in 1..4 {
        activity(&logs, n, "pid:101:first", SESSION_B, "TurnInput {}");
    }
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    let first = store
        .find_selection_for_pid_checked(101, None)
        .unwrap()
        .unwrap();
    assert!(!first.fresh);
    assert!(first.selection_key.is_some());
    logs.execute("DELETE FROM logs WHERE id=1", []).unwrap();
    let pruned = store
        .find_selection_for_pid_checked(101, None)
        .unwrap()
        .unwrap();
    assert_eq!(first.selection_key, pruned.selection_key);
    activity(&logs, 4, "pid:101:second", SESSION_B, "TurnInput {}");
    let restarted = store
        .find_selection_for_pid_checked(101, None)
        .unwrap()
        .unwrap();
    assert_ne!(first.selection_key, restarted.selection_key);
    // A second live top-level candidate defeats recovery, regardless of recency.
    activity(&logs, 5, "pid:101:second", SESSION_A, "TurnInput {}");
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    assert!(store
        .find_selection_for_pid_checked(101, None)
        .unwrap()
        .is_none());
}

#[test]
fn retained_loop_file_faults_pending_transitions_and_untrusted_shutdowns_block_recovery() {
    for fault in [
        "missing",
        "corrupt",
        "duplicate",
        "wrong_id",
        "pending",
        "mismatched",
        "quoted",
        "nested",
    ] {
        for guest in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let logs = create_logs_db(temp.path());
            let process = "pid:101:current";
            activity(&logs, 1, process, SESSION_B, "TurnInput {}");
            let path = write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
            match fault {
                "missing" => std::fs::remove_file(path).unwrap(),
                "corrupt" => std::fs::write(path, "{").unwrap(),
                "duplicate" => { std::fs::copy(path, temp.path().join("sessions").join(format!("rollout-copy-{SESSION_B}.jsonl"))).unwrap(); },
                "wrong_id" => std::fs::write(path, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"other\",\"cwd\":\"/same\"}}").unwrap(),
                "pending" => append(&logs, 2, process, SESSION_A, "app_server.request{rpc.method=\"thread/start\" rpc.request_id=next app_server.client_name=\"codex-tui\"}: preparing".into()),
                "mismatched" => { logs.execute("UPDATE logs SET thread_id=?1", [SESSION_A]).unwrap(); },
                "quoted" | "nested" => {
                    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
                    let message = if fault == "quoted" {"user quoted Submission sub=Submission"} else {"nested{}: Submission sub=Submission"};
                    append(&logs, 2, process, SESSION_A, format!("session_loop{{thread_id={SESSION_A}}}: {message} {{ id: \"operation-2\", op: Shutdown, trace: None }}"));
                }
                _ => unreachable!(),
            }
            let store = if guest {
                CodexSessionStore::for_guest(temp.path().into())
            } else {
                CodexSessionStore::new(temp.path().into(), temp.path().into())
            };
            let rows = super::super::super::lifecycle::ProcessRows {
                process_uuid: process.into(),
                rows: read_lifecycle_rows(&logs, process, 0).unwrap(),
            };
            let result = if guest {
                store.resolve_process_rows(&rows)
            } else {
                store.find_selection_for_pid_checked(101, Some(24))
            };
            if matches!(fault, "corrupt" | "mismatched") {
                assert!(result.is_err(), "{fault} guest={guest}");
            } else {
                assert!(result.unwrap().is_none(), "{fault} guest={guest}");
            }
        }
    }
}

#[test]
fn shutdown_requires_an_exact_operation_and_a_later_resume_reopens_the_id() {
    for operation in [
        "Shutdown",
        "ShutdownExtra",
        "TurnInput { text: \"Shutdown\" }",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        start(&logs, 1, "pid:101:current", SESSION_A);
        activity(&logs, 2, "pid:101:current", SESSION_A, operation);
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(101, None).as_deref(),
            (operation != "Shutdown").then_some(SESSION_A),
            "{operation}"
        );
        start(&logs, 3, "pid:101:current", SESSION_A);
        assert_eq!(
            store.find_session_for_pid(101, None).as_deref(),
            Some(SESSION_A)
        );
    }
}

#[test]
fn loop_exit_survives_pruned_shutdown_and_late_prewarm_without_reviving_closed_owner() {
    for late_prewarm in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        let process = "pid:101:current";
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
        if late_prewarm {
            start(&logs, 3, process, SESSION_A);
        }
        append(
            &logs,
            4,
            process,
            SESSION_A,
            format!("session_loop{{thread_id={SESSION_A}}}: Agent loop exited"),
        );
        for guest in [false, true] {
            let store = if guest {
                CodexSessionStore::for_guest(temp.path().into())
            } else {
                CodexSessionStore::new(temp.path().into(), temp.path().into())
            };
            let snapshot = || super::super::super::lifecycle::ProcessRows {
                process_uuid: process.into(),
                rows: read_lifecycle_rows(&logs, process, 0).unwrap(),
            };
            assert!(store.resolve_process_rows(&snapshot()).unwrap().is_none());
            activity(&logs, 5, process, SESSION_B, "TurnInput {}");
            assert_eq!(
                store.resolve_process_rows(&snapshot()).unwrap().unwrap().id,
                SESSION_B
            );
            logs.execute("DELETE FROM logs WHERE id=5", []).unwrap();
        }
    }
}

#[test]
fn previous_thread_can_finish_shutdown_after_the_new_threads_quiet_completed_turn() {
    let temp = tempfile::tempdir().unwrap();
    let logs = create_logs_db(temp.path());
    let process = "pid:101:current";
    start(&logs, 1, process, SESSION_A);
    activity(&logs, 2, process, SESSION_B, "TurnInput {}");
    activity(&logs, 3, process, SESSION_A, "Shutdown");
    write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
    write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
    let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
    assert_eq!(
        store.find_session_for_pid(101, None).as_deref(),
        Some(SESSION_B)
    );
}

#[test]
fn nested_subagent_initialization_does_not_poison_the_parent_loop() {
    for explicit in [true, false] {
        for guest in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let logs = create_logs_db(temp.path());
            let process = "pid:101:current";
            if explicit {
                start(&logs, 1, process, SESSION_A);
            }
            activity(&logs, 2, process, SESSION_A, "TurnInput {}");
            write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
            let child = write_rollout(
                temp.path(),
                SESSION_B,
                ",\"source\":{\"subagent\":{\"thread_spawn\":{}}}",
            );
            append(&logs, 3, process, SESSION_B, format!("session_loop{{thread_id={SESSION_A}}}:submission_dispatch{{}}:turn{{thread.id={SESSION_A}}}:thread_spawn{{}}:session_init:apply_rollout_reconstruction{{thread_id={SESSION_B}}}: reconstructed"));
            let store = if guest {
                CodexSessionStore::for_guest(temp.path().into())
            } else {
                CodexSessionStore::new(temp.path().into(), temp.path().into())
            };
            let rows = super::super::super::lifecycle::ProcessRows {
                process_uuid: process.into(),
                rows: read_lifecycle_rows(&logs, process, 0).unwrap(),
            };
            assert_eq!(
                store.resolve_process_rows(&rows).unwrap().unwrap().id,
                SESSION_A,
                "explicit={explicit} guest={guest}"
            );
            std::fs::File::options()
                .write(true)
                .open(&child)
                .unwrap()
                .set_modified(SystemTime::now() - Duration::from_secs(48 * 3600))
                .unwrap();
            assert_eq!(
                store.resolve_process_rows(&rows).unwrap().unwrap().id,
                SESSION_A
            );
            std::fs::remove_file(child).unwrap();
            assert!(store.resolve_process_rows(&rows).is_err());
            write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
            assert!(store.resolve_process_rows(&rows).is_err());
        }
    }
}

#[test]
fn expired_auxiliary_loops_do_not_block_a_current_top_level_conversation() {
    for guest in [false, true] {
        for source in [
            ",\"source\":{\"subagent\":{\"thread_spawn\":{}}}",
            ",\"source\":\"exec\"",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let logs = create_logs_db(temp.path());
            let process = "pid:101:current";
            activity(&logs, 1, process, SESSION_A, "TurnInput {}");
            activity(&logs, 2, process, SESSION_B, "TurnInput {}");
            let current = write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
            let auxiliary = write_rollout(temp.path(), SESSION_B, source);
            let expire = |path| {
                std::fs::File::options()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_modified(SystemTime::now() - Duration::from_secs(48 * 3600))
                    .unwrap();
            };
            expire(&auxiliary);
            let store = if guest {
                CodexSessionStore::for_guest(temp.path().into())
            } else {
                CodexSessionStore::new(temp.path().into(), temp.path().into())
            };
            let rows = super::super::super::lifecycle::ProcessRows {
                process_uuid: process.into(),
                rows: read_lifecycle_rows(&logs, process, 0).unwrap(),
            };
            let resolve = || {
                if guest {
                    store.resolve_process_rows(&rows)
                } else {
                    store.find_selection_for_pid_checked(101, Some(24))
                }
                .unwrap()
            };
            assert_eq!(resolve().unwrap().id, SESSION_A, "guest={guest} {source}");
            expire(&current);
            assert_eq!(
                resolve().unwrap().id,
                SESSION_A,
                "old top-level guest={guest}"
            );
        }
    }
}
