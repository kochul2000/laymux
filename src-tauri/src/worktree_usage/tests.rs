use super::*;
use crate::pty_daemon::{PtySessionEntry, PtySessionState};
use serde_json::json;

fn settings() -> Settings {
    Settings {
        workspaces: vec![serde_json::from_value(json!({
        "id": "hidden", "name": "숨은 작업", "panes": [{
            "id": "slot", "layers": [
                {"id": "one", "view": {"type": "TerminalView", "profile": "PowerShell", "lastCwd": "D:/old"}},
                {"id": "two", "view": {"type": "TerminalView", "profile": "PowerShell", "lastCwd": "D:/other"}}
            ], "activeLayerId": "two"
        }]
    })).unwrap()],
        docks: vec![serde_json::from_value(json!({
        "position": "left", "visible": false, "panes": [{
            "id": "dock", "view": {"type": "TerminalView", "profile": "PowerShell", "lastCwd": "D:/dock"}
        }]
    })).unwrap()],
        ..Settings::default()
    }
}

fn inventory(ids: &[&str]) -> PtySessionInventory {
    PtySessionInventory {
        daemon_running: !ids.is_empty(),
        current_daemon: None,
        unavailable_daemons: vec![],
        sessions: ids
            .iter()
            .map(|id| PtySessionEntry {
                daemon: "test".into(),
                session_id: format!("{id}#1"),
                terminal_id: (*id).into(),
                profile: Some("PowerShell".into()),
                created_seq: 1,
                child_pid: Some(1),
                attach_epoch: 1,
                state: PtySessionState::AwaitingPane,
            })
            .collect(),
    }
}

fn live(id: &str, cwd: Option<&str>) -> LiveTerminal {
    LiveTerminal {
        id: id.into(),
        cwd: cwd.map(str::to_owned),
        distro: None,
        command_line: "powershell.exe".into(),
        host: InitialExecutionHost::NativeWindows,
        agent_type: Some("codex".into()),
    }
}

fn attached_inventory(ids: &[&str]) -> PtySessionInventory {
    let mut result = inventory(ids);
    for entry in &mut result.sessions {
        entry.state = PtySessionState::Pane;
    }
    result
}

#[test]
fn live_cwd_supersedes_saved_cwd_and_keeps_workspace_attribution() {
    let snapshot = assemble_usage(
        vec![live("terminal-one", Some("D:/current/sub"))],
        &settings(),
        &attached_inventory(&["terminal-one"]),
        true,
    );
    assert!(snapshot.complete);
    assert_eq!(snapshot.usage.len(), 3);
    let live = snapshot
        .usage
        .iter()
        .find(|u| u.kind == UsageKind::Live)
        .unwrap();
    assert_eq!(live.cwd, "D:/current/sub");
    assert_eq!(live.workspace_name.as_deref(), Some("숨은 작업"));
    assert_eq!(live.pane_id.as_deref(), Some("one"));
    assert_eq!(live.agent_type.as_deref(), Some("codex"));
    assert!(usage_for_path(&snapshot.usage, "D:/old").is_empty());
}

#[test]
fn saved_snapshot_includes_every_stack_layer_and_hidden_dock() {
    let snapshot = assemble_usage(vec![], &settings(), &inventory(&[]), true);
    assert!(snapshot.complete);
    assert_eq!(snapshot.usage.len(), 3);
    assert!(snapshot.usage.iter().all(|u| u.kind == UsageKind::Saved));
    assert!(snapshot
        .usage
        .iter()
        .any(|u| u.pane_id.as_deref() == Some("dock")));
}

#[test]
fn saved_daemon_path_is_a_protected_reference_not_current_cwd_evidence() {
    let snapshot = assemble_usage(vec![], &settings(), &inventory(&["terminal-one"]), true);
    assert!(!snapshot.complete);
    assert!(!snapshot.warnings.is_empty());
    assert_eq!(
        snapshot
            .usage
            .iter()
            .find(|u| u.terminal_id.as_deref() == Some("terminal-one"))
            .unwrap()
            .kind,
        UsageKind::Daemon
    );
}

#[test]
fn unknown_daemon_or_live_cwd_prevents_complete_coverage() {
    let orphan = assemble_usage(vec![], &settings(), &inventory(&["orphan"]), true);
    assert!(!orphan.complete);
    let unknown = assemble_usage(
        vec![live("terminal-one", None)],
        &settings(),
        &inventory(&[]),
        true,
    );
    assert!(!unknown.complete);
    assert!(!unknown
        .usage
        .iter()
        .any(|u| u.terminal_id.as_deref() == Some("terminal-one")));
}

#[test]
fn direct_ssh_cwd_does_not_claim_a_local_worktree() {
    let mut remote = live("terminal-one", Some("D:/old"));
    remote.host = InitialExecutionHost::DirectSsh;
    let snapshot = assemble_usage(
        vec![remote],
        &settings(),
        &attached_inventory(&["terminal-one"]),
        true,
    );
    assert!(snapshot.complete);
    assert_eq!(snapshot.usage.len(), 2);
}

#[test]
fn path_matching_obeys_boundaries_and_windows_drive_aliases() {
    assert!(path_is_within(
        "/mnt/d/Work/repo/sub",
        "D:\\work\\repo",
        true
    ));
    assert!(path_is_within("D:/work/repo", "D:/WORK/repo/", true));
    assert!(!path_is_within("D:/work/repository", "D:/work/repo", true));
    assert!(!path_is_within("/work/Repo", "/work/repo", false));
    assert!(path_is_within("/work/repo/sub", "/work/repo", false));
    assert!(!path_is_within("/work/repo\\sub", "/work/repo", false));
}

#[test]
fn wsl_distributions_and_case_sensitive_suffixes_stay_distinct() {
    assert!(path_is_within(
        "\\\\wsl$\\Ubuntu\\home\\repo\\sub",
        "//wsl.localhost/ubuntu/home/repo",
        true
    ));
    assert!(!path_is_within(
        "//wsl.localhost/Debian/home/repo",
        "//wsl.localhost/Ubuntu/home/repo",
        true
    ));
    assert!(!path_is_within(
        "//wsl.localhost/Ubuntu/home/Repo",
        "//wsl.localhost/Ubuntu/home/repo",
        true
    ));
    let mut terminal = live("terminal-one", Some("/home/repo"));
    terminal.host = InitialExecutionHost::Wsl;
    terminal.distro = Some("Debian".into());
    let snapshot = assemble_usage(vec![terminal], &settings(), &inventory(&[]), true);
    assert!(snapshot.complete);
    assert_eq!(snapshot.usage[0].cwd, "//wsl.localhost/Debian/home/repo");
}

#[test]
fn unknown_wsl_distribution_does_not_fall_back_to_another_guest() {
    let mut terminal = live("terminal-one", Some("/home/repo"));
    terminal.host = InitialExecutionHost::Wsl;
    terminal.command_line = "wsl.exe".into();
    let snapshot = assemble_usage(vec![terminal], &settings(), &inventory(&[]), true);
    assert!(!snapshot.complete);
    assert!(!snapshot
        .usage
        .iter()
        .any(|u| u.terminal_id.as_deref() == Some("terminal-one")));
}

#[test]
fn an_old_detached_child_with_a_live_terminal_id_is_still_unknown() {
    let mut daemons = attached_inventory(&["terminal-one", "terminal-one"]);
    daemons.sessions[1].state = PtySessionState::Detached;
    daemons.sessions[1].daemon = "older".into();
    let snapshot = assemble_usage(
        vec![live("terminal-one", Some("D:/current"))],
        &settings(),
        &daemons,
        true,
    );
    assert!(!snapshot.complete);
}

#[test]
fn ending_daemon_does_not_prove_the_child_has_exited() {
    // Inventory's Ending covers both an exited child and an asynchronous
    // terminate request, including a request whose process teardown failed.
    for terminal_id in ["terminal-one", "orphan"] {
        let mut daemons = inventory(&[terminal_id]);
        daemons.sessions[0].state = PtySessionState::Ending;
        let snapshot = assemble_usage(vec![], &settings(), &daemons, true);
        assert!(
            !snapshot.complete,
            "Ending must retain uncertainty for {terminal_id}"
        );
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.contains(terminal_id)));
    }
    let mut daemons = attached_inventory(&["terminal-one", "terminal-one"]);
    daemons.sessions[1].state = PtySessionState::Ending;
    daemons.sessions[1].daemon = "older".into();
    let snapshot = assemble_usage(
        vec![live("terminal-one", Some("D:/current"))],
        &settings(),
        &daemons,
        true,
    );
    assert!(
        !snapshot.complete,
        "A current pane cannot certify the old child has exited"
    );
}

#[test]
fn unsaved_live_pane_has_navigation_id_but_file_viewer_does_not() {
    let snapshot = assemble_usage(
        vec![
            live("terminal-new-pane", Some("D:/current")),
            live("terminal-global-file-viewer:D:/readme.md", Some("D:/")),
        ],
        &settings(),
        &inventory(&[]),
        true,
    );
    assert_eq!(
        snapshot
            .usage
            .iter()
            .find(|entry| entry.terminal_id.as_deref() == Some("terminal-new-pane"))
            .unwrap()
            .pane_id
            .as_deref(),
        Some("new-pane")
    );
    assert_eq!(
        snapshot
            .usage
            .iter()
            .find(|entry| entry.terminal_id.as_deref()
                == Some("terminal-global-file-viewer:D:/readme.md"))
            .unwrap()
            .pane_id,
        None
    );
}

#[test]
fn missing_or_empty_saved_profile_uses_default_profile_starting_directory() {
    let mut settings = settings();
    settings.default_profile = "Fallback".into();
    settings.profiles.push(crate::settings::Profile {
        name: "Fallback".into(),
        command_line: "powershell.exe".into(),
        starting_directory: "D:/guarded".into(),
        ..Default::default()
    });
    settings.workspaces[0].panes[0].layers[0].view.extra = json!({});
    settings.workspaces[0].panes[0].layers[1].view.extra = json!({"profile": ""});
    let snapshot = assemble_usage(vec![], &settings, &inventory(&[]), true);
    assert!(snapshot.complete);
    assert_eq!(
        snapshot
            .usage
            .iter()
            .filter(|entry| entry.cwd == "D:/guarded")
            .count(),
        2
    );
}

#[test]
fn symlinked_usage_is_matched_to_the_real_worktree_path() {
    let mut terminal = live("terminal-one", Some("/home/link/src"));
    terminal.distro = Some("Ubuntu".into());
    terminal.host = InitialExecutionHost::Wsl;
    let snapshot = assemble_usage(vec![terminal], &settings(), &inventory(&[]), true);
    let resolved = resolve_usage_paths(snapshot, |path| {
        Ok(if path == "//wsl.localhost/Ubuntu/home/link/src" {
            "//wsl.localhost/Ubuntu/home/worktree/src".into()
        } else {
            path.into()
        })
    });
    assert!(resolved.complete);
    assert_eq!(
        resolved
            .usage
            .iter()
            .filter(|usage| path_is_within(
                &usage.cwd,
                "//wsl.localhost/Ubuntu/home/worktree",
                true
            ))
            .count(),
        1
    );
}

#[test]
fn unresolved_usage_path_is_preserved_and_blocks_removal() {
    let snapshot = assemble_usage(
        vec![live("terminal-one", Some("D:/unknown"))],
        &settings(),
        &inventory(&[]),
        true,
    );
    let resolved = resolve_usage_paths(snapshot, |path| {
        if path == "D:/unknown" {
            Err(AppError::Other("경로 조회 실패".into()))
        } else {
            Ok(path.into())
        }
    });
    assert!(!resolved.complete);
    assert!(resolved
        .warnings
        .iter()
        .any(|warning| warning.contains("경로 조회 실패")));
    assert!(resolved.usage.iter().any(|entry| entry.cwd == "D:/unknown"));
}

#[test]
fn forward_wsl_paths_keep_literal_backslashes_and_guest_case() {
    let literal = "//wsl.localhost/Ubuntu/home/Repo\\name";
    assert_eq!(local_path(literal, None, "wsl.exe", true).unwrap(), literal);
    assert_eq!(
        local_path("/home/Repo\\name", Some("Ubuntu"), "wsl.exe", true).unwrap(),
        literal
    );
    assert!(path_is_within(&format!("{literal}/src"), literal, true));
    assert!(!path_is_within(
        literal,
        "//wsl.localhost/Ubuntu/home/Repo/name",
        true
    ));
    assert!(!path_is_within(
        literal,
        "//wsl.localhost/Ubuntu/home/repo\\name",
        true
    ));
    assert!(!path_is_within(
        "//wsl.localhost/Ubuntu/mnt/d/Repo\\name",
        "D:/Repo/name",
        true
    ));
    assert!(!path_is_within("/mnt/d/Repo\\name", "D:/Repo/name", true));
    assert_eq!(canonical_or_original(literal), literal);
    assert_eq!(
        local_path("\\\\wsl$\\Ubuntu\\home\\Repo\\name", None, "", true).unwrap(),
        "//wsl$/Ubuntu/home/Repo/name"
    );
    assert!(path_is_within(
        "\\\\wsl$\\Ubuntu\\home\\Repo\\name",
        "//wsl.localhost/Ubuntu/home/Repo/name",
        true
    ));
}
