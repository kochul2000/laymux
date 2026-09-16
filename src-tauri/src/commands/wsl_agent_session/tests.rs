use super::*;

#[cfg(target_os = "linux")]
#[test]
fn shell_probe_preserves_ancestry_and_literal_environment_values() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    for pid in 1..=160 {
        let dir = root.path().join(pid.to_string());
        std::fs::create_dir_all(dir.join("fd")).unwrap();
        let marker = if pid <= 32 {
            format!("LX_TERMINAL_ID=terminal-matrix-{}\0", (pid - 1) / 2)
        } else {
            String::new()
        };
        std::fs::write(dir.join("environ"), format!("{marker}HOME=/home/test user\0CODEX_HOME=/tmp/with space=a\0GROK_HOME=/tmp/literal$(not-run)\0CODEX_HOME=/wrong-duplicate\0")).unwrap();
        std::fs::write(
            dir.join("comm"),
            if pid % 2 == 0 { "codex\n" } else { "bash\n" },
        )
        .unwrap();
        std::fs::write(
            dir.join("status"),
            format!(
                "Name:\ttest\nPPid:\t{}\n",
                if pid % 2 == 0 { pid - 1 } else { 0 }
            ),
        )
        .unwrap();
        symlink(
            "/tmp/with space=a/sessions/2026/rollout-test.jsonl",
            dir.join("fd/9"),
        )
        .unwrap();
    }
    let script = WSL_PROCESS_PROBE.replace(
        "/proc/[0-9]*",
        &format!("\"{}\"/[0-9]*", root.path().display()),
    );
    for _ in 0..20 {
        let mut command = crate::process::headless_command("sh");
        command.args(["-c", &script]);
        let output =
            crate::process::output_with_timeout(&mut command, std::time::Duration::from_secs(3))
                .unwrap();
        assert!(output.status.success());
        let entries = parse_probe_output(&output.stdout).unwrap();
        assert_eq!(entries.len(), 32);
        for entries in group_by_terminal(entries).values() {
            let selected = select_top_level_agent(entries, WslAgentProvider::Codex)
                .unwrap()
                .unwrap();
            assert_eq!(selected.home, "/home/test user");
            assert_eq!(selected.codex_home.as_deref(), Some("/tmp/with space=a"));
            assert_eq!(
                selected.grok_home.as_deref(),
                Some("/tmp/literal$(not-run)")
            );
            assert_eq!(
                selected.rollout_paths,
                ["/tmp/with space=a/sessions/2026/rollout-test.jsonl"]
            );
            assert_eq!(
                entries
                    .iter()
                    .find(|entry| entry.name == "bash")
                    .unwrap()
                    .rollout_paths
                    .len(),
                0
            );
        }
    }
}

fn process(pid: u32, ppid: u32, name: &str) -> WslProcessEntry {
    WslProcessEntry {
        terminal_id: "terminal-pane-a".into(),
        pid,
        ppid,
        name: name.into(),
        home: "/home/user".into(),
        codex_home: None,
        grok_home: None,
        rollout_paths: Vec::new(),
    }
}

#[test]
fn live_codex_without_rollout_is_not_mistaken_for_an_absent_agent() {
    let entries = parse_probe_output(
        concat!(
            "LAYMUX_WSL_AGENT_PROBE_V2\n",
            "P\tterminal-pane-a\t20\t10\tcodex\t/home/user\t\t\n",
            "LAYMUX_WSL_AGENT_PROBE_END\n",
        )
        .as_bytes(),
    )
    .unwrap();
    let selected = select_top_level_agent(&entries, WslAgentProvider::Codex)
        .unwrap()
        .unwrap();
    assert_eq!(selected.pid, 20);
    assert!(selected.rollout_paths.is_empty());
}

#[test]
fn parses_bounded_probe_rows_and_optional_roots() {
    let output = concat!(
        "LAYMUX_WSL_AGENT_PROBE_V2\n",
        "P\tterminal-pane-a\t10\t1\tbash\t/home/user\t\t\n",
        "P\tterminal-pane-a\t20\t10\tcodex\t/home/user\t/opt/codex\t\n",
        "R\tterminal-pane-a\t20\t/opt/codex/sessions/2026/08/02/rollout-a.jsonl\n",
        "LAYMUX_WSL_AGENT_PROBE_END\n",
    );
    let entries = parse_probe_output(output.as_bytes()).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].pid, 20);
    assert_eq!(entries[1].codex_home.as_deref(), Some("/opt/codex"));
    assert_eq!(
        entries[1].rollout_paths,
        ["/opt/codex/sessions/2026/08/02/rollout-a.jsonl"]
    );
}

#[test]
fn malformed_or_incomplete_probe_output_fails_closed() {
    assert!(parse_probe_output(b"terminal-pane-a\t20\t10\tcodex\n").is_err());
    assert!(parse_probe_output(
        b"LAYMUX_WSL_AGENT_PROBE_V2\nP\tterminal-pane-a\tbad\t10\tcodex\t/home/u\t\t\nLAYMUX_WSL_AGENT_PROBE_END\n"
    )
    .is_err());
    assert!(parse_probe_output(
        b"LAYMUX_WSL_AGENT_PROBE_V2\nR\tterminal-pane-a\t20\t/orphan.jsonl\nLAYMUX_WSL_AGENT_PROBE_END\n"
    )
    .is_err());
}

#[test]
fn selects_the_unique_shallowest_provider_process() {
    let entries = vec![
        process(10, 1, "bash"),
        process(20, 10, "codex"),
        process(30, 20, "codex"),
    ];
    let selected = select_top_level_agent(&entries, WslAgentProvider::Codex)
        .expect("provider should be active")
        .expect("attribution should be exact");
    assert_eq!(selected.pid, 20);
}

#[test]
fn equal_depth_provider_processes_are_explicitly_ambiguous() {
    let entries = vec![
        process(10, 1, "bash"),
        process(20, 10, "claude"),
        process(30, 10, "claude"),
    ];
    assert_eq!(
        select_top_level_agent(&entries, WslAgentProvider::Claude),
        Some(None)
    );
}

#[test]
fn nested_providers_select_only_the_global_top_level_agent() {
    let entries = vec![
        process(10, 1, "bash"),
        process(20, 10, "claude"),
        process(30, 20, "codex"),
    ];

    let claude = select_top_level_agent(&entries, WslAgentProvider::Claude)
        .expect("Claude should be the active provider")
        .expect("Claude attribution should be exact");
    assert_eq!(claude.pid, 20);
    assert_eq!(
        select_top_level_agent(&entries, WslAgentProvider::Codex),
        None
    );
}

#[test]
fn selects_the_unique_shallowest_grok_process() {
    let entries = vec![
        process(10, 1, "bash"),
        process(20, 10, "grok"),
        process(30, 20, "grok"),
    ];
    let selected = select_top_level_agent(&entries, WslAgentProvider::Grok)
        .expect("Grok should be active")
        .expect("Grok attribution should be exact");
    assert_eq!(selected.pid, 20);
}

#[test]
fn nested_claude_hides_deeper_grok() {
    let entries = vec![
        process(10, 1, "bash"),
        process(20, 10, "claude"),
        process(30, 20, "grok"),
    ];
    let claude = select_top_level_agent(&entries, WslAgentProvider::Claude)
        .expect("Claude should be the active provider")
        .expect("Claude attribution should be exact");
    assert_eq!(claude.pid, 20);
    assert_eq!(
        select_top_level_agent(&entries, WslAgentProvider::Grok),
        None
    );
}

#[test]
fn equal_depth_claude_and_grok_are_ambiguous() {
    let entries = vec![
        process(10, 1, "bash"),
        process(20, 10, "claude"),
        process(30, 10, "grok"),
    ];
    assert_eq!(
        select_top_level_agent(&entries, WslAgentProvider::Claude),
        Some(None)
    );
    assert_eq!(
        select_top_level_agent(&entries, WslAgentProvider::Grok),
        Some(None)
    );
}

#[test]
fn groups_processes_by_their_exact_terminal_marker() {
    let mut other = process(40, 1, "claude");
    other.terminal_id = "terminal-pane-b".into();
    let grouped = group_by_terminal(vec![process(20, 1, "codex"), other]);
    assert_eq!(grouped["terminal-pane-a"][0].pid, 20);
    assert_eq!(grouped["terminal-pane-b"][0].pid, 40);
}

#[test]
fn converts_only_rollouts_below_the_process_codex_home() {
    let process = WslAgentProcess {
        pid: 20,
        distro: "Ubuntu".into(),
        home: "/home/user".into(),
        codex_home: Some("/opt/codex".into()),
        grok_home: None,
        rollout_paths: vec![
            "/opt/codex/sessions/2026/08/02/rollout-a.jsonl".into(),
            "/elsewhere/rollout-b.jsonl".into(),
        ],
    };
    assert_eq!(
        process.claude_sessions_dir().unwrap(),
        PathBuf::from(r"\\wsl.localhost\Ubuntu\home\user\.claude\sessions")
    );
    assert_eq!(
        process.codex_rollout_paths(),
        [PathBuf::from(
            r"\\wsl.localhost\Ubuntu\opt\codex\sessions\2026\08\02\rollout-a.jsonl"
        )]
    );
}

#[test]
fn grok_home_dir_defaults_to_guest_home_dot_grok() {
    let process = WslAgentProcess {
        pid: 20,
        distro: "Ubuntu".into(),
        home: "/home/user".into(),
        codex_home: None,
        grok_home: None,
        rollout_paths: Vec::new(),
    };
    assert_eq!(
        process.grok_home_dir().unwrap(),
        PathBuf::from(r"\\wsl.localhost\Ubuntu\home\user\.grok")
    );
}

#[test]
fn grok_home_dir_uses_explicit_guest_grok_home() {
    let process = WslAgentProcess {
        pid: 20,
        distro: "Ubuntu".into(),
        home: "/home/user".into(),
        codex_home: None,
        grok_home: Some("/opt/grok".into()),
        rollout_paths: Vec::new(),
    };
    assert_eq!(
        process.grok_home_dir().unwrap(),
        PathBuf::from(r"\\wsl.localhost\Ubuntu\opt\grok")
    );
}
