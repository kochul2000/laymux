//! Read-only diagnostics against explicitly selected existing native PTY roots.
//! The test owns sink writers only: it never attaches to, writes, or kills a PTY.

use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LivePane {
    terminal_id: String,
    root_pid: u32,
    session_id: String,
}

#[test]
#[ignore = "requires LAYMUX_TEST_NATIVE_PANES JSON with terminalId, rootPid and sessionId"]
fn live_native_codex_panes_keep_their_distinct_current_sessions() {
    let panes: Vec<LivePane> =
        serde_json::from_str(&std::env::var("LAYMUX_TEST_NATIVE_PANES").unwrap()).unwrap();
    assert!(!panes.is_empty());
    let state = AppState::new();
    for pane in &panes {
        state.pty_handles.lock().unwrap().insert(
            pane.terminal_id.clone(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
                .with_child_pid(Some(pane.root_pid)),
        );
    }
    for _ in 0..2 {
        let (claude, codex, grok) = collect_provider_session_lookups(
            || super::super::claude_session::get_claude_session_lookup_impl(Some(72), &state),
            || {
                super::super::codex_session::get_codex_session_lookup_impl(Some(72), &state)
                    .map_err(|error| error.to_string())
            },
            || super::super::grok_session::get_grok_session_lookup_impl(Some(72), &state),
        )
        .unwrap();
        for pane in &panes {
            let attribution = classify_attribution(
                7,
                &pane.terminal_id,
                &claude.attributions,
                &codex.attributions,
                &grok.attributions,
                crate::process_tree::interactive_app_in_pty_fresh(&state, &pane.terminal_id),
                provider_lookup_failed_for_terminal(&pane.terminal_id, &[&claude, &codex, &grok]),
            );
            println!(
                "{} {}",
                pane.terminal_id,
                serde_json::to_string(&attribution).unwrap()
            );
            assert_eq!(attribution.state, SessionAttributionState::Identified);
            assert_eq!(attribution.provider, Some("codex"));
            assert_eq!(
                attribution.session_id.as_deref(),
                Some(pane.session_id.as_str())
            );
        }
    }
}
