use super::*;

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
