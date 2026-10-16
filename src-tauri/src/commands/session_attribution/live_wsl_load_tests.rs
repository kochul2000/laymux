//! Read-only replay of the frontend's WSL attribution polling against a live
//! guest (issue #1214, ADR-0335). No PTY is spawned, written or closed; the
//! guest only needs processes carrying the listed `LX_TERMINAL_ID` markers.
//! Count the `wsl.exe` runs from outside (descendants of this test process,
//! grouped by the `laymux-wsl-*` tag on their command line).

use super::*;
use std::time::{Duration, Instant};

#[test]
#[ignore = "requires LAYMUX_TEST_WSL_DISTRO and LAYMUX_TEST_LOAD_PANES; replays polling against a live guest"]
fn replay_frontend_wsl_polling_load() {
    let distro = std::env::var("LAYMUX_TEST_WSL_DISTRO").unwrap();
    let panes: Vec<String> = std::env::var("LAYMUX_TEST_LOAD_PANES")
        .unwrap()
        .split(',')
        .map(str::to_owned)
        .collect();
    let seconds = std::env::var("LAYMUX_TEST_LOAD_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(60);
    let state = AppState::new();
    for terminal_id in &panes {
        let mut terminal = crate::terminal::TerminalSession::new(
            terminal_id.clone(),
            crate::terminal::TerminalConfig {
                profile: "WSL".into(),
                command_line: "wsl.exe".into(),
                ..Default::default()
            },
        );
        terminal.initial_execution_host = crate::terminal::InitialExecutionHost::Wsl;
        terminal.wsl_distro = Some(distro.clone());
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
    }
    let attributions =
        |observation| get_terminal_session_attributions_impl(None, None, None, &state, observation);
    let stop = Instant::now() + Duration::from_secs(seconds);
    // Each loop waits for its own answer before scheduling the next one, as the
    // frontend subscriptions do.
    let every = |pause: Duration, poll: &(dyn Fn() + Sync)| {
        let mut count = 0usize;
        while Instant::now() < stop {
            poll();
            count += 1;
            std::thread::sleep(pause);
        }
        count
    };
    let polls = std::thread::scope(|scope| {
        let turns = scope.spawn(|| {
            every(Duration::from_secs(1), &|| {
                let _ = super::super::codex_session::turns::get_codex_turn_states_impl(&state);
            })
        });
        let hooks = scope.spawn(|| {
            every(Duration::from_secs(2), &|| {
                let _ = attributions(GuestObservation::Reusable);
            })
        });
        let records = scope.spawn(|| {
            every(Duration::from_secs(1), &|| {
                let _ = super::super::agent_session_state::get_agent_session_states_impl(
                    &panes, &panes, &state,
                );
            })
        });
        let liveness = scope.spawn(|| {
            every(crate::constants::ACTIVITY_RECONCILE_INTERVAL, &|| {
                crate::wsl_liveness::refresh(&state);
            })
        });
        // A critical checkpoint: two observations 150 ms apart, every 20 s.
        let checkpoints = scope.spawn(|| {
            every(Duration::from_secs(20), &|| {
                let _ = attributions(GuestObservation::starting_now());
                std::thread::sleep(Duration::from_millis(150));
                let _ = attributions(GuestObservation::starting_now());
            })
        });
        [
            ("codex turns (1 s)", turns.join().unwrap()),
            ("hook states (2 s)", hooks.join().unwrap()),
            ("session records (1 s)", records.join().unwrap()),
            ("liveness (3 s)", liveness.join().unwrap()),
            ("critical checkpoints (20 s)", checkpoints.join().unwrap()),
        ]
    });
    for (name, count) in polls {
        println!("{name}: {count} polls in {seconds} s");
    }
    for probe in ["laymux-wsl-agent-probe", "laymux-wsl-codex-probe"] {
        println!(
            "{probe}: {} shared runs started",
            state.wsl_guest_snapshots.runs_started(probe)
        );
    }
}
