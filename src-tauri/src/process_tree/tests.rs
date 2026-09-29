use super::*;

fn entry(pid: u32, ppid: u32, name: &str) -> ProcessEntry {
    ProcessEntry {
        pid,
        ppid,
        name: name.to_string(),
        is_helper: false,
    }
}

#[test]
fn native_helper_is_not_a_conversation_but_preserves_descendants() {
    let mut server = entry(200, 100, "codex.exe");
    server.is_helper = true;
    let mut snapshot = vec![entry(100, 1, "powershell.exe"), server];
    assert_eq!(match_interactive_app_process(&snapshot, 100), None);
    assert_eq!(match_interactive_app_process(&snapshot, 200), None);
    assert!(descendant_pids(&snapshot, 100).contains(&200));
    snapshot.push(entry(300, 200, "codex.exe"));
    assert_eq!(
        match_interactive_app_process(&snapshot, 100),
        Some((300, "Codex"))
    );
    snapshot.push(entry(301, 200, "codex.exe"));
    assert_eq!(match_interactive_app_process(&snapshot, 100), None);
    assert_eq!(
        shallowest_interactive_app_processes(&snapshot, 100).len(),
        2
    );
}

/// A WSL pane's agent lives in the guest, so the Windows snapshot always
/// looks empty under `wsl.exe`. Taking that as `NoneAlive` is what
/// suppressed the title/buffer detectors for every WSL pane; the guest
/// oracle owns the verdict instead and says `Unknown` until it has one.
#[test]
fn wsl_backed_pane_never_takes_the_windows_snapshot_verdict() {
    let state = AppState::new();
    state.pty_handles.lock().unwrap().insert(
        "t-wsl".into(),
        crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
            .with_wsl_backed(true)
            // A PID the local snapshot can enumerate but find nothing under:
            // the native path would answer NoneAlive here.
            .with_child_pid(Some(std::process::id())),
    );

    assert_eq!(
        interactive_app_in_pty(&state, "t-wsl"),
        PtyAppLiveness::Unknown
    );
}

/// Control for the test above: a native pane with the same empty tree keeps
/// the authoritative negative, so the WSL branch is a domain carve-out and
/// not a blanket weakening of the oracle.
#[test]
fn native_pane_still_reports_the_authoritative_negative() {
    let state = AppState::new();
    state.pty_handles.lock().unwrap().insert(
        "t-native".into(),
        crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
            .with_child_pid(Some(std::process::id())),
    );

    assert_eq!(
        interactive_app_in_pty(&state, "t-native"),
        PtyAppLiveness::NoneAlive
    );
}

#[test]
fn known_agent_without_exact_session_remains_explicitly_unresolved() {
    let known = vec!["terminal-a".to_string(), "terminal-b".to_string()];
    let exact = HashMap::from([("terminal-a".to_string(), "session-a".to_string())]);

    let result = complete_agent_session_attributions(&known, exact);

    assert_eq!(
        result.get("terminal-a").and_then(|value| value.as_deref()),
        Some("session-a")
    );
    assert_eq!(result.get("terminal-b"), Some(&None));
}

#[test]
fn duplicate_sessions_are_rejected_after_host_results_are_merged() {
    let attributions = HashMap::from([
        ("native".to_string(), Some("shared".to_string())),
        ("wsl".to_string(), Some("shared".to_string())),
        ("unique".to_string(), Some("only-here".to_string())),
        ("unresolved".to_string(), None),
    ]);

    let result = reject_duplicate_session_attributions(attributions, "Codex");

    assert_eq!(result.get("native"), Some(&None));
    assert_eq!(result.get("wsl"), Some(&None));
    assert_eq!(
        result.get("unique").and_then(|value| value.as_deref()),
        Some("only-here")
    );
    assert_eq!(result.get("unresolved"), Some(&None));
}

// ── name_to_app ──

#[test]
fn name_to_app_matches_windows_exe() {
    assert_eq!(name_to_app("claude.exe"), Some("Claude"));
    assert_eq!(name_to_app("codex.exe"), Some("Codex"));
    assert_eq!(name_to_app("grok.exe"), Some("Grok"));
    assert_eq!(name_to_app("CLAUDE.EXE"), Some("Claude"));
    assert_eq!(name_to_app("GROK.EXE"), Some("Grok"));
}

#[test]
fn name_to_app_matches_bare_name() {
    assert_eq!(name_to_app("claude"), Some("Claude"));
    assert_eq!(name_to_app("codex"), Some("Codex"));
    assert_eq!(name_to_app("grok"), Some("Grok"));
}

#[test]
fn name_to_app_rejects_others() {
    assert_eq!(name_to_app("node.exe"), None);
    assert_eq!(name_to_app("pwsh.exe"), None);
    assert_eq!(name_to_app("bash"), None);
    // Must not substring-match: "claude-wrapper" is not Claude.
    assert_eq!(name_to_app("claude-wrapper"), None);
}

// ── descendant_pids ──

#[test]
fn descendant_pids_includes_root_even_if_absent() {
    let snapshot: Vec<ProcessEntry> = vec![];
    let set = descendant_pids(&snapshot, 42);
    assert!(set.contains(&42));
    assert_eq!(set.len(), 1);
}

#[test]
fn descendant_pids_walks_transitively() {
    // 100 -> 200 -> 300, and 100 -> 400; 999 unrelated.
    let snapshot = vec![
        entry(200, 100, "a"),
        entry(300, 200, "b"),
        entry(400, 100, "c"),
        entry(999, 1, "x"),
    ];
    let set = descendant_pids(&snapshot, 100);
    assert!(set.contains(&100));
    assert!(set.contains(&200));
    assert!(set.contains(&300));
    assert!(set.contains(&400));
    assert!(!set.contains(&999));
}

// ── match_interactive_app ──

#[test]
fn match_finds_claude_descendant() {
    // pwsh(100) -> claude.exe(200) -> bash(300)
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "claude.exe"),
        entry(300, 200, "bash.exe"),
    ];
    assert_eq!(match_interactive_app(&snapshot, 100), Some("Claude"));
}

#[test]
fn match_finds_codex_descendant() {
    // pwsh(100) -> node(200, codex.js) -> codex.exe(300)
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "node.exe"),
        entry(300, 200, "codex.exe"),
    ];
    assert_eq!(match_interactive_app(&snapshot, 100), Some("Codex"));
}

#[test]
fn match_returns_the_exact_shallowest_app_process_id() {
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "node.exe"),
        entry(300, 200, "codex.exe"),
        entry(400, 300, "codex.exe"),
    ];

    assert_eq!(
        match_interactive_app_process(&snapshot, 100),
        Some((300, "Codex"))
    );
}

#[test]
fn match_root_itself_is_the_app() {
    // PTY launched `claude` directly: root == claude.exe.
    let snapshot = vec![entry(200, 100, "claude.exe"), entry(300, 200, "bash.exe")];
    assert_eq!(match_interactive_app(&snapshot, 200), Some("Claude"));
}

#[test]
fn match_same_depth_grok_and_claude_is_ambiguous() {
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "claude.exe"),
        entry(300, 100, "grok.exe"),
    ];
    assert_eq!(match_interactive_app(&snapshot, 100), None);
    assert_eq!(match_interactive_app_process(&snapshot, 100), None);
}

#[test]
fn ambiguous_native_agents_are_never_authoritative_absence() {
    for left in ["claude.exe", "codex.exe", "grok.exe"] {
        for right in ["claude.exe", "codex.exe", "grok.exe"] {
            for wrapped in [false, true] {
                let parent = if wrapped { 150 } else { 100 };
                let mut snapshot = vec![
                    entry(100, 1, "pwsh.exe"),
                    entry(150, 100, "node.exe"),
                    entry(200, parent, left),
                    entry(300, parent, right),
                ];
                for _ in 0..2 {
                    assert_eq!(match_interactive_app_process(&snapshot, 100), None);
                    assert_eq!(
                        classify(Some(100), &snapshot),
                        PtyAppLiveness::Ambiguous,
                        "{left} + {right}, wrapped={wrapped}"
                    );
                    snapshot.reverse();
                }
            }
        }
    }
}

#[test]
fn match_shallowest_wins_when_both_present() {
    // Claude pane that spawned Codex as a subprocess: claude is nearer the
    // root, so the pane is reported as Claude, not Codex.
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "claude.exe"),
        entry(300, 200, "node.exe"),
        entry(400, 300, "codex.exe"),
    ];
    assert_eq!(match_interactive_app(&snapshot, 100), Some("Claude"));
}

#[test]
fn match_none_when_no_app_in_tree() {
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "node.exe"),
        entry(300, 200, "git.exe"),
    ];
    assert_eq!(match_interactive_app(&snapshot, 100), None);
}

#[test]
fn match_ignores_app_outside_subtree() {
    // codex.exe(900) belongs to an unrelated tree, not under root 100.
    let snapshot = vec![
        entry(100, 1, "pwsh.exe"),
        entry(200, 100, "node.exe"),
        entry(900, 1, "codex.exe"),
    ];
    assert_eq!(match_interactive_app(&snapshot, 100), None);
}

// ── classify: negative liveness vs unknown (PR #292 review P2) ──

#[test]
fn classify_unknown_without_pid() {
    // No PID to anchor the walk → no signal, even with a populated snapshot.
    let snapshot = vec![entry(100, 1, "pwsh.exe")];
    assert_eq!(classify(None, &snapshot), PtyAppLiveness::Unknown);
}

#[test]
fn classify_unknown_on_empty_snapshot() {
    // Enumeration failure (empty list) is "no signal", not a negative —
    // there is always at least the calling process in a real snapshot.
    assert_eq!(classify(Some(100), &[]), PtyAppLiveness::Unknown);
}

#[test]
fn classify_running_when_app_in_tree() {
    let snapshot = vec![entry(100, 1, "pwsh.exe"), entry(200, 100, "claude.exe")];
    assert_eq!(
        classify(Some(100), &snapshot),
        PtyAppLiveness::Running("Claude")
    );
}

#[test]
fn classify_none_alive_when_pid_and_snapshot_but_no_app() {
    // The crux of the P2 fix: a readable snapshot + known PID but no
    // claude/codex under it is an AUTHORITATIVE negative, not Unknown. This
    // is what lets a title-less native exit (SIGKILL) beat a stale
    // "Claude Code" banner still sitting in the recent buffer.
    let snapshot = vec![entry(100, 1, "pwsh.exe"), entry(200, 100, "git.exe")];
    assert_eq!(classify(Some(100), &snapshot), PtyAppLiveness::NoneAlive);
}

// ── suppresses_false_exit: the load-bearing #297 decision ──

#[test]
fn suppress_exit_when_same_app_still_alive() {
    // Codex's bare cwd-basename idle title ("kochul") makes
    // `process_codex_title` report `exited`, but the process tree still
    // sees codex — the exit must be suppressed so the pane stays Codex.
    // This is exactly what keeps #297 from regressing.
    assert!(suppresses_false_exit(
        "Codex",
        PtyAppLiveness::Running("Codex")
    ));
    assert!(suppresses_false_exit(
        "Claude",
        PtyAppLiveness::Running("Claude")
    ));
}

#[test]
fn no_suppress_when_different_app_alive() {
    // A different live app is not "this app still running" — let the
    // exit through so a Claude→Codex handover reclassifies correctly.
    assert!(!suppresses_false_exit(
        "Codex",
        PtyAppLiveness::Running("Claude")
    ));
}

#[test]
fn no_suppress_on_genuine_exit_or_unknown() {
    // NoneAlive = process genuinely gone → real exit flows through.
    // Unknown = no PID / snapshot miss → honor the title signal rather
    // than wrongly pinning a possibly-dead pane (#297 fallback path).
    assert!(!suppresses_false_exit("Codex", PtyAppLiveness::NoneAlive));
    assert!(!suppresses_false_exit("Claude", PtyAppLiveness::NoneAlive));
    assert!(!suppresses_false_exit("Codex", PtyAppLiveness::Unknown));
    assert!(!suppresses_false_exit("Claude", PtyAppLiveness::Unknown));
}

#[test]
fn classify_none_alive_when_pid_absent_from_snapshot() {
    // PTY child fully gone (reaped): its PID is not even in the snapshot.
    // Still authoritative negative — nothing of ours is alive.
    let snapshot = vec![entry(1, 0, "init"), entry(2, 1, "systemd")];
    assert_eq!(classify(Some(9999), &snapshot), PtyAppLiveness::NoneAlive);
}
