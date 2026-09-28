use super::*;
use crate::session_checkpoint::codex_status::CodexStatusProcess;
use std::sync::Mutex;

fn install_probe(state: &AppState, owns_fence: bool, expired: bool) {
    state
        .session_checkpoint
        .begin_finalization_for_test()
        .unwrap();
    let target = CodexStatusTarget {
        io: Arc::new(Mutex::new(())),
        generation: 3,
        process: CodexStatusProcess {
            pid: 1,
            started_at: 7,
            distro: None,
            codex_home: "test-home".into(),
            sqlite_home: "test-home".into(),
        },
        original_cols: 60,
        original_rows: 20,
        resized: false,
        dismissed: false,
        clear_batches: 0,
        next_step: Some(CodexStatusStep::Submit),
        output_start: Some(40),
        proof: Some(("01a0e103-7bcb-7a20-89c0-2dc0472f2957".into(), false)),
    };
    *state.session_checkpoint.codex_status.lock().unwrap() = Some(CodexStatusCheckpoint {
        token: "test-token".into(),
        deadline: if expired {
            Instant::now() - Duration::from_secs(1)
        } else {
            Instant::now() + Duration::from_secs(5)
        },
        owns_fence,
        completed: false,
        update_request_id: None,
        targets: HashMap::from([("terminal-test".into(), target)]),
    });
}

#[test]
fn expiration_rejects_late_enter_before_process_or_pty_access() {
    let state = AppState::new();
    install_probe(&state, true, true);
    let error = input_inner(
        &state,
        "test-token",
        "terminal-test",
        CodexStatusStep::Submit,
    )
    .unwrap_err();
    assert!(error.contains("expired"));
    assert!(verified_status_sessions(&state).unwrap().is_empty());
    finish_inner(&state, "test-token").unwrap();
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_ok());
}

#[test]
fn stale_tokens_cannot_release_a_new_checkpoint_fence() {
    let state = AppState::new();
    install_probe(&state, true, false);
    assert!(target_for(&state, "older-token", "terminal-test").is_err());
    finish_inner(&state, "older-token").unwrap();
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_err());
    finish_inner(&state, "test-token").unwrap();
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_ok());
    assert!(verified_status_sessions(&state).unwrap().is_empty());
}

#[test]
fn finishing_an_update_probe_preserves_the_updater_owned_fence() {
    let state = AppState::new();
    install_probe(&state, false, false);
    finish_inner(&state, "test-token").unwrap();
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_err());
}

#[test]
fn native_update_request_must_still_own_the_fence() {
    let state = AppState::new();
    install_probe(&state, false, false);
    state
        .session_checkpoint
        .codex_status
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .update_request_id = Some(777);
    assert!(target_for(&state, "test-token", "terminal-test")
        .unwrap_err()
        .contains("fence"));
}

#[test]
fn expired_save_cannot_commit_or_release_a_fence_until_cleanup() {
    let state = AppState::new();
    install_probe(&state, true, true);
    assert!(complete_inner(&state, "test-token").is_err());
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_err());
    finish_inner(&state, "test-token").unwrap();
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_ok());
}

#[test]
fn successful_close_keeps_input_fenced_until_window_destruction() {
    let state = AppState::new();
    install_probe(&state, true, false);
    assert!(!state.session_checkpoint.close_cleanup_allowed());
    complete_inner(&state, "test-token").unwrap();
    finish_inner(&state, "test-token").unwrap();
    assert!(state.session_checkpoint.ensure_mutations_allowed().is_err());
    assert!(state.session_checkpoint.close_cleanup_allowed());
    state.session_checkpoint.cancel_finalization();
    assert!(!state.session_checkpoint.close_cleanup_allowed());
}

#[test]
fn status_id_is_validated_in_the_target_home_and_never_accepts_auxiliary_or_broken_rollouts() {
    let temp = tempfile::tempdir().unwrap();
    let process = CodexStatusProcess {
        pid: 1,
        started_at: 1,
        distro: None,
        codex_home: temp.path().join("actual-codex-home"),
        sqlite_home: temp.path().join("separate-sqlite-home"),
    };
    let id = "01a0e103-7bcb-7a20-89c0-2dc0472f2957";
    assert!(targets::verify_session(&process, id).unwrap());
    let sessions = process.codex_home.join("sessions/2026/09/27");
    std::fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join(format!("rollout-{id}.jsonl"));
    let header = |source| {
        serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/project","source":source}}).to_string()
    };
    std::fs::write(&path, header("cli")).unwrap();
    assert!(!targets::verify_session(&process, id).unwrap());
    std::fs::write(&path, header("exec")).unwrap();
    assert!(targets::verify_session(&process, id).is_err());
    std::fs::write(&path, "broken header").unwrap();
    assert!(targets::verify_session(&process, id).is_err());
    std::fs::create_dir_all(&process.sqlite_home).unwrap();
    let db = rusqlite::Connection::open(process.sqlite_home.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)")
        .unwrap();
    db.execute(
        "INSERT INTO threads VALUES (?1, ?2)",
        (
            id,
            temp.path().join("missing-rollout.jsonl").to_str().unwrap(),
        ),
    )
    .unwrap();
    assert!(
        targets::verify_session(&process, id).is_err(),
        "a state row with missing history must not become Fresh"
    );
}
