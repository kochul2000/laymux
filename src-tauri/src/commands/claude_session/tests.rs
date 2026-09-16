use super::*;

#[test]
fn native_claude_candidates_only_include_the_top_level_provider() {
    let process = |pid, ppid, name: &str| crate::process_tree::ProcessEntry {
        pid,
        ppid,
        name: name.into(),
    };
    let snapshot = vec![
        process(100, 0, "shell"),
        process(101, 100, "claude"),
        process(102, 101, "claude"),
        process(200, 0, "shell"),
        process(201, 200, "codex"),
        process(202, 201, "claude"),
        process(300, 0, "shell"),
        process(301, 300, "grok"),
        process(302, 301, "claude"),
        process(400, 0, "shell"),
    ];
    let roots = [100, 200, 300, 400]
        .map(|pid| (format!("terminal-{pid}"), pid))
        .to_vec();
    assert_eq!(
        native_claude_candidates(&snapshot, roots),
        vec![("terminal-100".into(), HashSet::from([101]))]
    );
}

// -- Claude session file parsing tests --

#[test]
fn read_claude_session_files_empty_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = read_claude_session_files(tmp.path(), None);
    assert!(sessions.is_empty());
}

#[test]
fn read_claude_session_files_valid_json() {
    let tmp = tempfile::tempdir().unwrap();
    let content = r#"{"pid":12345,"sessionId":"abc-123","cwd":"/home/user","startedAt":1000}"#;
    std::fs::write(tmp.path().join("12345.json"), content).unwrap();
    let sessions = read_claude_session_files(tmp.path(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].pid, 12345);
    assert_eq!(sessions[0].session_id, "abc-123");
    assert_eq!(sessions[0].started_at, 1000);
}

#[test]
fn read_claude_session_files_ignores_non_json() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("readme.txt"), "not json").unwrap();
    let sessions = read_claude_session_files(tmp.path(), None);
    assert!(sessions.is_empty());
}

#[test]
fn read_claude_session_files_ignores_invalid_json() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("bad.json"), "not valid json!").unwrap();
    let sessions = read_claude_session_files(tmp.path(), None);
    assert!(sessions.is_empty());
    assert!(read_claude_session_files_checked(tmp.path(), None).1);
}

#[test]
fn pid_scoped_read_ignores_an_unrelated_malformed_session_file() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("999.json"), "not valid json!").unwrap();
    std::fs::write(
        tmp.path().join("123.json"),
        r#"{"pid":123,"sessionId":"session-123","startedAt":1000}"#,
    )
    .unwrap();

    let (sessions, lookup_failed) =
        read_claude_session_files_for_pids_checked(tmp.path(), None, Some(&HashSet::from([123])));

    assert!(!lookup_failed);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "session-123");
}

#[test]
fn pid_scoped_read_reports_a_malformed_relevant_session_file() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("123.json"), "not valid json!").unwrap();

    let (_, lookup_failed) =
        read_claude_session_files_for_pids_checked(tmp.path(), None, Some(&HashSet::from([123])));

    assert!(lookup_failed);
}

#[test]
fn malformed_live_pid_only_fails_its_own_terminal() {
    let lookup = ClaudeSessionFileLookup {
        sessions: Vec::new(),
        failed_pids: HashSet::from([123]),
        scope_failed: false,
    };
    let affected = affected_native_terminal_ids(
        &[
            ("terminal-a".into(), HashSet::from([100, 123])),
            ("terminal-b".into(), HashSet::from([200, 201])),
        ],
        &lookup,
    );

    assert_eq!(affected, HashSet::from(["terminal-a".into()]));
}

#[test]
fn find_session_by_pids_matches() {
    let sessions = vec![
        ClaudeSessionFile {
            pid: 100,
            session_id: "s1".into(),
            started_at: 1,
        },
        ClaudeSessionFile {
            pid: 200,
            session_id: "s2".into(),
            started_at: 2,
        },
    ];
    assert_eq!(
        find_session_by_pids(&sessions, &HashSet::from([200])),
        Some("s2".into())
    );
    assert_eq!(find_session_by_pids(&sessions, &HashSet::from([300])), None);
}

// -- Session ID validation tests --

#[test]
fn is_valid_session_id_accepts_safe_ids() {
    assert!(is_valid_session_id("abc-123"));
    assert!(is_valid_session_id("session_id_v2"));
    assert!(is_valid_session_id("a1b2c3"));
    assert!(is_valid_session_id("ABC-def_012"));
}

#[test]
fn is_valid_session_id_rejects_dangerous_ids() {
    assert!(!is_valid_session_id(""));
    assert!(!is_valid_session_id("id; rm -rf /"));
    assert!(!is_valid_session_id("id && echo pwned"));
    assert!(!is_valid_session_id("id | cat /etc/passwd"));
    assert!(!is_valid_session_id("$(whoami)"));
    assert!(!is_valid_session_id("id`whoami`"));
    assert!(!is_valid_session_id("hello world"));
    assert!(!is_valid_session_id("id\nnewline"));
    assert!(!is_valid_session_id("--last"));
}

// -- Startup command override validation tests --

#[test]
fn startup_command_override_accepts_valid_resume() {
    assert!(is_valid_claude_startup_command_override(
        "claude --resume abc-123",
        "claude"
    ));
    assert!(is_valid_claude_startup_command_override(
        "claude --resume session_v2",
        "claude"
    ));
    assert!(is_valid_claude_startup_command_override(
        "claude --resume A1B2",
        "claude"
    ));
}

#[test]
fn startup_command_override_rejects_arbitrary_commands() {
    assert!(!is_valid_claude_startup_command_override(
        "rm -rf /", "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "echo pwned",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "claude --resume bad; rm -rf /",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "claude --resume $(whoami)",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "claude --resume id && echo x",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override("", "claude"));
    assert!(!is_valid_claude_startup_command_override(
        "claude --resume ",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "claude --resume",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "not-claude --resume abc",
        "claude"
    ));
}

#[test]
fn startup_command_override_follows_the_configured_launch_command() {
    assert!(is_valid_claude_startup_command_override(
        "claude --dangerously-skip-permissions --resume abc-123",
        "claude --dangerously-skip-permissions"
    ));
    // Whitespace in the setting is normalized before comparison.
    assert!(is_valid_claude_startup_command_override(
        "claude --yolo --resume abc-123",
        "  claude   --yolo  "
    ));
    // A caller cannot add flags the user did not configure.
    assert!(!is_valid_claude_startup_command_override(
        "claude --dangerously-skip-permissions --resume abc-123",
        "claude"
    ));
    // An unsafe setting falls back to the bare default, not to itself.
    assert!(!is_valid_claude_startup_command_override(
        "claude; rm -rf / --resume abc-123",
        "claude; rm -rf /"
    ));
    assert!(is_valid_claude_startup_command_override(
        "claude --resume abc-123",
        "claude; rm -rf /"
    ));
}

#[test]
fn startup_command_override_rejects_raw_viewer_commands() {
    assert!(!is_valid_claude_startup_command_override(
        "vi '/home/user/file.txt'",
        "claude"
    ));
    assert!(!is_valid_claude_startup_command_override(
        "notepad 'C:\\Users\\me\\README.md'",
        "claude"
    ));
}

#[test]
fn read_claude_session_files_rejects_invalid_session_id() {
    let tmp = tempfile::tempdir().unwrap();
    let content = r#"{"pid":1,"sessionId":"bad; rm -rf /","cwd":"/home","startedAt":1}"#;
    std::fs::write(tmp.path().join("1.json"), content).unwrap();
    let sessions = read_claude_session_files(tmp.path(), None);
    assert!(sessions.is_empty());
}

#[test]
fn find_session_by_pids_picks_most_recent_on_multiple_matches() {
    let sessions = vec![
        ClaudeSessionFile {
            pid: 100,
            session_id: "old-session".into(),
            started_at: 1,
        },
        ClaudeSessionFile {
            pid: 200,
            session_id: "new-session".into(),
            started_at: 10,
        },
    ];
    // Both PIDs match — should pick the most recent (started_at=10)
    assert_eq!(
        find_session_by_pids(&sessions, &HashSet::from([100, 200])),
        Some("new-session".into())
    );
}

#[test]
fn duplicate_claude_session_attribution_fails_closed() {
    let candidates = vec![
        ("pane-a".into(), "same-session".into()),
        ("pane-b".into(), "same-session".into()),
    ];
    assert!(remove_duplicate_attributions(candidates).is_empty());
}

// -- Stale session filtering tests --

#[test]
fn read_claude_session_files_filters_stale_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Recent session (1 hour ago)
    let recent = format!(
        r#"{{"pid":1,"sessionId":"recent","cwd":"/a","startedAt":{}}}"#,
        now - 3600
    );
    std::fs::write(tmp.path().join("1.json"), recent).unwrap();

    // Stale session (48 hours ago)
    let stale = format!(
        r#"{{"pid":2,"sessionId":"stale","cwd":"/b","startedAt":{}}}"#,
        now - 48 * 3600
    );
    std::fs::write(tmp.path().join("2.json"), stale).unwrap();

    // With 24h max age, only the recent session should pass
    let sessions = read_claude_session_files(tmp.path(), Some(24));
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "recent");
}

#[test]
fn read_claude_session_files_no_filter_when_none() {
    let tmp = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Old session (72 hours ago)
    let old = format!(
        r#"{{"pid":1,"sessionId":"old","cwd":"/a","startedAt":{}}}"#,
        now - 72 * 3600
    );
    std::fs::write(tmp.path().join("1.json"), old).unwrap();

    // No max age filter — session should be included
    let sessions = read_claude_session_files(tmp.path(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "old");
}

#[test]
fn read_claude_session_files_zero_hours_disables_filter() {
    let tmp = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Very old session (30 days ago)
    let old = format!(
        r#"{{"pid":1,"sessionId":"ancient","cwd":"/a","startedAt":{}}}"#,
        now - 30 * 24 * 3600
    );
    std::fs::write(tmp.path().join("1.json"), old).unwrap();

    // 0 hours = disabled, but saturating_sub means cutoff = now,
    // so we actually need to handle 0 as a special case.
    // Let's verify current behavior: 0 * 3600 = 0, cutoff = now - 0 = now.
    // startedAt < now → filtered out. That's NOT what we want.
    // We should treat 0 as "no filter".
    let sessions = read_claude_session_files(tmp.path(), Some(0));
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "ancient");
}
