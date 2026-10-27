use super::state_detection::detect_terminal_state_with_liveness;
use super::*;
use crate::process_tree::PtyAppLiveness;

#[test]
fn live_process_is_identified_without_new_output_after_reattach() {
    for app in ["Claude", "Codex", "Grok"] {
        let state = AppState::new();
        let empty = TerminalOutputBuffer::new(4096);
        for buffer in [None, Some(&empty)] {
            assert_eq!(
                detect_terminal_state_with_liveness(
                    &state,
                    "pane",
                    buffer,
                    PtyAppLiveness::Running(app),
                )
                .activity,
                TerminalActivity::InteractiveApp { name: app.into() },
                "{app}: silence is not an exit",
            );
        }
    }
}

#[test]
fn current_process_outranks_a_competing_title_left_in_the_ring() {
    let state = AppState::new();
    let mut buffer = TerminalOutputBuffer::new(4096);
    buffer.push(b"\x1b]0;Claude Code\x07");
    assert_eq!(
        detect_terminal_state_with_liveness(
            &state,
            "pane",
            Some(&buffer),
            PtyAppLiveness::Running("Codex"),
        )
        .activity,
        TerminalActivity::InteractiveApp {
            name: "Codex".into()
        },
    );
}
