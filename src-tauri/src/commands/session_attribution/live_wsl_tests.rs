//! Explicit, read-only diagnostic against an already running WSL pane.
//! No PTY is spawned, written, closed, or attached to the user's application.

use super::*;

#[test]
#[ignore = "requires LAYMUX_TEST_WSL_DISTRO, LAYMUX_TEST_TERMINAL_ID and LAYMUX_TEST_SESSION_ID"]
fn live_wsl_claude_attribution_matches_its_session_file() {
    let distro = std::env::var("LAYMUX_TEST_WSL_DISTRO").unwrap();
    let terminal_id = std::env::var("LAYMUX_TEST_TERMINAL_ID").unwrap();
    let expected = std::env::var("LAYMUX_TEST_SESSION_ID").unwrap();
    let state = AppState::new();
    let mut terminal = crate::terminal::TerminalSession::new(
        terminal_id.clone(),
        crate::terminal::TerminalConfig {
            profile: "WSL".into(),
            command_line: "wsl.exe".into(),
            ..Default::default()
        },
    );
    terminal.initial_execution_host = crate::terminal::InitialExecutionHost::Wsl;
    terminal.wsl_distro = Some(distro);
    state
        .terminals
        .lock()
        .unwrap()
        .insert(terminal_id.clone(), terminal);
    state.pty_handles.lock().unwrap().insert(
        terminal_id.clone(),
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_wsl_backed(true),
    );
    // Two independent observations exercise the same stability requirement as
    // the critical checkpoint, without writing the user's settings or PTY.
    for _ in 0..2 {
        let (claude, codex, grok) = collect_provider_session_lookups(
            || super::super::claude_session::get_claude_session_lookup_impl(Some(24), &state),
            || {
                super::super::codex_session::get_codex_session_lookup_impl(Some(24), &state)
                    .map_err(|error| error.to_string())
            },
            || super::super::grok_session::get_grok_session_lookup_impl(Some(24), &state),
        )
        .unwrap();
        crate::wsl_liveness::refresh(&state);
        let attribution = classify_attribution(
            7,
            &terminal_id,
            &claude.attributions,
            &codex.attributions,
            &grok.attributions,
            crate::wsl_liveness::liveness(&terminal_id, 7),
            provider_lookup_failed_for_terminal(&terminal_id, &[&claude, &codex, &grok]),
        );
        println!("{}", serde_json::to_string(&attribution).unwrap());
        assert_eq!(attribution.state, SessionAttributionState::Identified);
        assert_eq!(attribution.provider, Some("claude"));
        assert_eq!(attribution.session_id.as_deref(), Some(expected.as_str()));
    }
}
