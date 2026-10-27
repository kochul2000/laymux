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

#[test]
fn absence_of_observation_is_not_a_shell_or_a_running_command() {
    let state = AppState::new();
    let mut plain = TerminalOutputBuffer::new(4096);
    plain.push(b"ordinary output without lifecycle evidence");
    let empty = TerminalOutputBuffer::new(4096);
    for buffer in [None, Some(&empty), Some(&plain)] {
        assert_eq!(
            detect_terminal_state_with_liveness(&state, "pane", buffer, PtyAppLiveness::Unknown)
                .activity,
            TerminalActivity::Unknown,
        );
        assert!(!is_terminal_at_prompt_from_buffer(buffer));
    }
}

#[test]
fn a_confirmed_exit_outranks_resident_agent_title_and_grace() {
    let state = AppState::new();
    let mut buffer = TerminalOutputBuffer::new(4096);
    for app in ["Claude", "Codex", "Grok"] {
        record_interactive_app_detection(&state, "pane", app);
        buffer.push(format!("\x1b]0;{app}\x07\x1b]133;C\x07").as_bytes());
        // Agent absence confirms exit, but does not prove the shell is idle.
        assert_eq!(
            detect_terminal_state_with_liveness(
                &state,
                "pane",
                Some(&buffer),
                PtyAppLiveness::NoneAlive,
            )
            .activity,
            TerminalActivity::Running,
        );
        buffer.push(b"\x1b]133;D;0\x07\x1b]133;A\x07");
        assert_eq!(
            detect_terminal_state_with_liveness(
                &state,
                "pane",
                Some(&buffer),
                PtyAppLiveness::NoneAlive,
            )
            .activity,
            TerminalActivity::Shell,
        );
    }
}

#[test]
fn shell_prompt_and_command_start_must_be_observed() {
    let state = AppState::new();
    let mut buffer = TerminalOutputBuffer::new(4096);
    for (bytes, expected) in [
        (b"\x1b]133;A\x07".as_slice(), TerminalActivity::Shell),
        (b"\x1b]133;C\x07".as_slice(), TerminalActivity::Running),
        (b"\x1b]133;D;0\x07".as_slice(), TerminalActivity::Shell),
    ] {
        buffer.push(bytes);
        assert_eq!(
            detect_terminal_state_with_liveness(
                &state,
                "pane",
                Some(&buffer),
                PtyAppLiveness::NoneAlive,
            )
            .activity,
            expected
        );
    }
}
