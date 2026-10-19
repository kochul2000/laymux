use std::ffi::OsString;
use std::path::{Path as FsPath, PathBuf};
use std::time::{Duration, Instant};

use serial_test::serial;
use tempfile::TempDir;

use super::*;
use crate::remote_server::RemoteControlLease;
use crate::terminal::{TerminalConfig, TerminalSession};

struct Environment(Vec<(&'static str, Option<OsString>)>);

impl Environment {
    fn isolated(path: &FsPath) -> Self {
        let mut keys = vec!["LAYMUX_PTY_DAEMON_DIR", "XDG_STATE_HOME"];
        if cfg!(windows) {
            keys.extend(["APPDATA", "LOCALAPPDATA"]);
        } else {
            keys.push("HOME");
        }
        Self(
            keys.into_iter()
                .map(|key| {
                    let previous = std::env::var_os(key);
                    std::env::set_var(key, path);
                    (key, previous)
                })
                .collect(),
        )
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn git(cwd: &FsPath, args: &[&str]) -> String {
    let output = crate::process::headless_command("git")
        .args(["-c", "core.hooksPath=", "-c", "commit.gpgSign=false"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

struct Fixture {
    state: AppState,
    main: PathBuf,
    linked: PathBuf,
    _environment: Environment,
    _temp: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let environment = Environment::isolated(temp.path());
        let main = temp.path().join("main repo");
        let linked = temp.path().join("linked tree");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        git(&main, &["config", "user.name", "Remote Worktree Test"]);
        git(&main, &["config", "user.email", "remote@example.invalid"]);
        std::fs::write(main.join("tracked.txt"), "initial\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-m", "initial"]);
        git(
            &main,
            &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
        );
        let state = AppState::new();
        state.remote_access.lock().unwrap().enabled = true;
        state.remote_control.lock().unwrap().install_remote_lease(
            RemoteControlLease {
                lease_id: "active".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: Instant::now(),
            },
            Duration::from_secs(120),
        );
        let mut terminal = TerminalSession::new("source".into(), TerminalConfig::default());
        terminal.cwd = Some(main.to_string_lossy().into());
        state
            .terminals
            .lock()
            .unwrap()
            .insert("source".into(), terminal);
        Self {
            state,
            main,
            linked,
            _environment: environment,
            _temp: temp,
        }
    }

    fn inspect_request(&self) -> WorktreeInspectRequest {
        WorktreeInspectRequest {
            lease_id: "active".into(),
            cwd: self.main.to_string_lossy().into(),
            path: self.linked.to_string_lossy().into(),
        }
    }

    fn remove_request(&self) -> WorktreeRemoveRequest {
        WorktreeRemoveRequest {
            lease_id: "active".into(),
            cwd: self.main.to_string_lossy().into(),
            path: self.linked.to_string_lossy().into(),
            expected_head: git(&self.linked, &["rev-parse", "HEAD"]),
        }
    }
}

#[test]
fn worktree_wire_rejects_missing_authority_and_extra_controls() {
    assert!(serde_json::from_value::<WorktreeListRequest>(serde_json::json!({})).is_err());
    for key in ["workingDir", "force", "path", "cwd"] {
        let mut value = serde_json::json!({"leaseId":"active"});
        value[key] = true.into();
        assert!(serde_json::from_value::<WorktreeListRequest>(value).is_err());
    }
    for key in ["workingDir", "force"] {
        let mut value = serde_json::json!({"leaseId":"active","cwd":"repo","path":"tree"});
        value[key] = true.into();
        assert!(serde_json::from_value::<WorktreeInspectRequest>(value.clone()).is_err());
        value["expectedHead"] = "abc".into();
        assert!(serde_json::from_value::<WorktreeRemoveRequest>(value).is_err());
    }
}

#[test]
#[serial]
fn worktree_operations_require_active_lease_before_looking_up_terminal() {
    let fixture = Fixture::new();
    for lease in ["", "stale"] {
        let list = WorktreeListRequest {
            lease_id: lease.into(),
        };
        assert_eq!(
            snapshot_for_state(&fixture.state, "missing", &list)
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        let mut inspect = fixture.inspect_request();
        inspect.lease_id = lease.into();
        assert_eq!(
            inspect_for_state(&fixture.state, "missing", &inspect)
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
        let mut remove = fixture.remove_request();
        remove.lease_id = lease.into();
        assert_eq!(
            remove_for_state(&fixture.state, "missing", &remove)
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
    }
    assert!(fixture.linked.exists());
}

#[test]
#[serial]
fn worktree_list_uses_source_and_returns_raw_cwd_with_shared_snapshot() {
    let fixture = Fixture::new();
    let result = snapshot_for_state(
        &fixture.state,
        "source",
        &WorktreeListRequest {
            lease_id: "active".into(),
        },
    )
    .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["cwd"], fixture.main.to_str().unwrap());
    assert_eq!(result["data"]["worktrees"].as_array().unwrap().len(), 2);
    assert!(result["data"]["workingDir"].is_string());
    assert!(result["data"]["worktrees"][0]["usage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|usage| usage["terminalId"] == "source"));
}

#[test]
#[serial]
fn worktree_actions_reject_changed_source_cwd() {
    let fixture = Fixture::new();
    let inspect = fixture.inspect_request();
    let remove = fixture.remove_request();
    fixture
        .state
        .terminals
        .lock()
        .unwrap()
        .get_mut("source")
        .unwrap()
        .cwd = Some(fixture.linked.to_string_lossy().into());
    assert_eq!(
        inspect_for_state(&fixture.state, "source", &inspect)
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        remove_for_state(&fixture.state, "source", &remove)
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    assert!(fixture.linked.exists());
}

#[test]
#[serial]
fn worktree_remove_rechecks_git_changes_and_preserves_branches() {
    let fixture = Fixture::new();
    let inspection =
        inspect_for_state(&fixture.state, "source", &fixture.inspect_request()).unwrap();
    assert_eq!(inspection["data"]["canRemove"], true, "{inspection}");
    let mut request = fixture.remove_request();
    std::fs::write(fixture.linked.join("new.txt"), "keep").unwrap();
    assert_eq!(
        remove_for_state(&fixture.state, "source", &request)
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    assert!(fixture.linked.join("new.txt").exists());
    git(&fixture.linked, &["add", "."]);
    git(&fixture.linked, &["commit", "-m", "after inspection"]);
    assert_eq!(
        remove_for_state(&fixture.state, "source", &request)
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    request.expected_head = git(&fixture.linked, &["rev-parse", "HEAD"]);
    let result = remove_for_state(&fixture.state, "source", &request).unwrap();
    assert_eq!(result["success"], true);
    assert!(!fixture.linked.exists());
    assert_eq!(
        git(&fixture.main, &["rev-parse", "topic"]),
        request.expected_head
    );
}

#[test]
#[serial]
fn worktree_remove_rechecks_new_live_usage_and_owner_transition() {
    let fixture = Fixture::new();
    let request = fixture.remove_request();
    let inspection =
        inspect_for_state(&fixture.state, "source", &fixture.inspect_request()).unwrap();
    assert_eq!(inspection["data"]["canRemove"], true);
    let mut user = TerminalSession::new("new-user".into(), TerminalConfig::default());
    user.cwd = Some(request.path.clone());
    fixture
        .state
        .terminals
        .lock()
        .unwrap()
        .insert("new-user".into(), user);
    assert_eq!(
        remove_for_state(&fixture.state, "source", &request)
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    fixture.state.terminals.lock().unwrap().remove("new-user");
    fixture
        .state
        .remote_control
        .lock()
        .unwrap()
        .begin_remote_owner_transition(Instant::now());
    assert_eq!(
        remove_for_state(&fixture.state, "source", &request)
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    assert!(fixture.linked.exists());
}

#[test]
#[serial]
fn worktree_removal_holds_owner_handoff_until_git_operation_finishes() {
    let fixture = Fixture::new();
    let request = fixture.remove_request();
    let mut transition = None;
    with_removal_authority(&fixture.state, "source", &request, |cwd| {
        {
            let mut control = fixture.state.remote_control.lock().unwrap();
            let pending = control
                .begin_remote_owner_transition(Instant::now())
                .unwrap();
            assert!(
                control.has_active_operations(),
                "accepted removal must remain an owner barrier"
            );
            assert!(!control.finalize_owner_transition_if_drained(pending));
            transition = Some(pending);
        }
        crate::commands::remove_worktree_inner(
            &fixture.state,
            cwd,
            &request.path,
            &request.expected_head,
        )
    })
    .unwrap();
    assert!(!fixture.linked.exists());
    let mut control = fixture.state.remote_control.lock().unwrap();
    assert!(control.finalize_owner_transition_if_drained(transition.unwrap()));
    assert!(control.lease.is_none());
}
