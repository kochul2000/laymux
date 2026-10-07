use super::*;
use crate::session_checkpoint::codex_status::{CodexStatusCheckpoint, CodexStatusTarget};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn fixture() -> (
    AppState,
    ProviderSessionLookup,
    HashMap<String, CodexStatusProcess>,
) {
    let state = AppState::new();
    state
        .session_checkpoint
        .begin_finalization_for_test()
        .unwrap();
    let mut targets = HashMap::new();
    let mut processes = HashMap::new();
    let mut lookup = ProviderSessionLookup::default();
    for index in 0..8 {
        let terminal = format!("pane-{index}");
        let id = format!("01a0ec06-451a-7e61-ac51-bd98fab4ed8{index}");
        let process = CodexStatusProcess {
            pid: 10 + index,
            started_at: 20,
            distro: None,
            codex_home: if cfg!(windows) {
                "C:\\isolated-codex".into()
            } else {
                "/isolated-codex".into()
            },
            sqlite_home: "unused".into(),
        };
        state.pty_handles.lock().unwrap().insert(
            terminal.clone(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7),
        );
        processes.insert(terminal.clone(), process.clone());
        lookup
            .attributions
            .insert(terminal.clone(), Some(id.clone()));
        targets.insert(
            terminal,
            CodexStatusTarget {
                io: Arc::new(Mutex::new(())),
                generation: 7,
                process,
                original_cols: 80,
                original_rows: 24,
                resized: false,
                dismissed: false,
                clear_batches: 0,
                next_step: None,
                output_start: None,
                proof: Some((id, false)),
                hook_binding: Some(CodexHookBinding::Process(None)),
            },
        );
    }
    *state.session_checkpoint.codex_status.lock().unwrap() = Some(CodexStatusCheckpoint {
        token: "batch".into(),
        deadline: Instant::now() + Duration::from_secs(30),
        owns_fence: true,
        completed: false,
        update_request_id: None,
        targets,
    });
    (state, lookup, processes)
}

#[test]
fn eight_panes_share_process_discovery_and_the_already_collected_conversations() {
    let (state, lookup, processes) = fixture();
    let result = verified_with_processes(&state, &lookup, || Ok(processes)).unwrap();
    assert_eq!(result.len(), 8);
    for (terminal, (_, id, fresh)) in result {
        assert_eq!(lookup.attributions[&terminal].as_deref(), Some(id.as_str()));
        assert!(!fresh);
    }
}

#[test]
fn a_failed_lost_or_changed_selection_cannot_be_overwritten_by_the_earlier_proof() {
    for change in ["failed", "lost", "different"] {
        let (state, mut lookup, processes) = fixture();
        match change {
            "failed" => {
                lookup.failed_terminal_ids.insert("pane-0".into());
            }
            "lost" => {
                lookup.attributions.insert("pane-0".into(), None);
            }
            _ => {
                lookup.attributions.insert(
                    "pane-0".into(),
                    Some("01a0ec07-451a-7e61-ac51-bd98fab4ed83".into()),
                );
            }
        }
        assert!(
            verified_with_processes(&state, &lookup, || Ok(processes)).is_err(),
            "{change}"
        );
    }
}

#[test]
fn current_pid_incarnation_and_terminal_generation_are_still_required() {
    for change in ["pid-reuse", "removed", "generation"] {
        let (state, lookup, mut processes) = fixture();
        match change {
            "pid-reuse" => processes.get_mut("pane-0").unwrap().started_at += 1,
            "removed" => {
                processes.remove("pane-0");
            }
            _ => {
                state.pty_handles.lock().unwrap().insert(
                    "pane-0".into(),
                    crate::pty::PtyHandle::from_test_writer_for_generation(
                        Box::new(std::io::sink()),
                        8,
                    ),
                );
            }
        }
        assert!(
            verified_with_processes(&state, &lookup, || Ok(processes)).is_err(),
            "{change}"
        );
    }
}

#[test]
fn expiry_during_process_discovery_does_not_return_a_successful_proof() {
    let (state, lookup, processes) = fixture();
    let result = verified_with_processes(&state, &lookup, || {
        state
            .session_checkpoint
            .codex_status
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .deadline = Instant::now();
        Ok(processes)
    });
    assert!(result.is_err());
}
