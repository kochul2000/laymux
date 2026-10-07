use super::*;
use crate::terminal::{TerminalConfig, TerminalSession};
const ID: &str = "01a0ec06-451a-7e61-ac51-bd98fab4ed82";
struct Fixture {
    state: AppState,
    temp: tempfile::TempDir,
    settings: PathBuf,
    rollout: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let state = AppState::new();
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("settings.json");
        let rollout = temp.path().join("rollout.jsonl");
        let mut terminal = TerminalSession::new("terminal-pane".into(), TerminalConfig::default());
        terminal.codex_hook_title = TitleBinding {
            generation: 7,
            revision: 1,
            identity: Some(ID[..29].into()),
        };
        state
            .terminals
            .lock()
            .unwrap()
            .insert("terminal-pane".into(), terminal);
        state.pty_handles.lock().unwrap().insert(
            "terminal-pane".into(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7),
        );
        std::fs::write(&settings, "{}").unwrap();
        std::fs::write(&rollout, "proven history").unwrap();
        remember_codex_file(&state, "terminal-pane", 7, ID, &rollout);
        let fixture = Self {
            state,
            temp,
            settings,
            rollout,
        };
        fixture.write_session(serde_json::json!({"workspaces":[{"panes":[{"id":"pane","view":{"type":"TerminalView","lastCodexSession":ID}}]}],"docks":[]}));
        fixture
    }
    fn write_session(&self, mut value: serde_json::Value) {
        for kind in ["workspaces", "docks"] {
            if value.get(kind).is_none() {
                value[kind] = serde_json::json!([]);
            }
            for group in value[kind].as_array_mut().into_iter().flatten() {
                if kind == "workspaces" {
                    group["id"] = "fixture".into();
                    group["name"] = "fixture".into();
                }
                for pane in group["panes"].as_array_mut().into_iter().flatten() {
                    for (key, default) in [("x", 0.0), ("y", 0.0), ("w", 1.0), ("h", 1.0)] {
                        if pane.get(key).is_none() {
                            pane[key] = serde_json::json!(default);
                        }
                    }
                }
            }
        }
        let snapshot = serde_json::from_value(value).unwrap();
        crate::settings::persistence::store_for_settings(&self.settings)
            .unwrap()
            .commit_session(&snapshot)
            .unwrap();
    }
    fn coverage(&self) -> Vec<ReceiptCoverage> {
        vec![ReceiptCoverage {
            terminal_id: "terminal-pane".into(),
            generation: Some(7),
            state: "identified".into(),
            provider: Some("codex".into()),
            session_id: Some(ID.into()),
        }]
    }
    fn committed(&self) -> String {
        let token = capture(&self.state).unwrap().unwrap();
        remember_codex_file(&self.state, "terminal-pane", 7, ID, &self.rollout);
        commit_to(&self.state, &token, &self.coverage(), &self.settings)
            .unwrap()
            .expect("unchanged successful save must issue a receipt")
    }
}
#[test]
fn an_unchanged_committed_checkpoint_is_reusable_with_only_local_database_revision_io() {
    let f = Fixture::new();
    let token = f.committed();
    assert!(reusable(&f.state, &token).unwrap());
    assert!(!reusable(&f.state, "foreign-token").unwrap());
    assert!(f.temp.path().exists());
}
#[test]
fn every_observed_change_invalidates_the_committed_receipt() {
    for change in [
        "input",
        "title",
        "hint",
        "cwd",
        "generation",
        "closed",
        "settings",
        "database",
        "rollout",
    ] {
        let f = Fixture::new();
        let token = f.committed();
        match change {
            "input" => f.state.pty_handles.lock().unwrap()["terminal-pane"]
                .write(b"/new\r")
                .unwrap(),
            "title" => {
                f.state
                    .terminals
                    .lock()
                    .unwrap()
                    .get_mut("terminal-pane")
                    .unwrap()
                    .codex_hook_title
                    .revision += 1
            }
            "hint" => f.state.session_checkpoint.hints.request(),
            "cwd" => {
                f.state
                    .terminals
                    .lock()
                    .unwrap()
                    .get_mut("terminal-pane")
                    .unwrap()
                    .cwd = Some("/different".into())
            }
            "generation" => {
                f.state.pty_handles.lock().unwrap().insert(
                    "terminal-pane".into(),
                    crate::pty::PtyHandle::from_test_writer_for_generation(
                        Box::new(std::io::sink()),
                        8,
                    ),
                );
            }
            "closed" => {
                f.state.pty_handles.lock().unwrap().remove("terminal-pane");
            }
            "settings" => std::fs::write(&f.settings, "changed settings").unwrap(),
            "database" => {
                let store = crate::settings::persistence::store_for_settings(&f.settings).unwrap();
                let session = store.load_session().unwrap().unwrap();
                store.commit_session(&session).unwrap();
            }
            _ => std::fs::remove_file(&f.rollout).unwrap(),
        }
        assert!(!reusable(&f.state, &token).unwrap(), "{change}");
    }
}
#[test]
fn failed_partial_stale_and_changed_saves_cannot_issue_a_receipt() {
    for change in [
        "during-save",
        "unknown",
        "unverified-file",
        "wrong-id",
        "wrong-generation",
        "duplicate",
        "not-saved",
        "restart",
    ] {
        let f = Fixture::new();
        let token = capture(&f.state).unwrap().unwrap();
        let mut coverage = f.coverage();
        remember_codex_file(&f.state, "terminal-pane", 7, ID, &f.rollout);
        match change {
            "during-save" => f.state.session_checkpoint.hints.request(),
            "unknown" => coverage[0].state = "unknown".into(),
            "unverified-file" => f
                .state
                .session_checkpoint
                .receipts
                .lock()
                .unwrap()
                .proofs
                .clear(),
            "wrong-id" => {
                coverage[0].session_id = Some("01a0ec07-451a-7e61-ac51-bd98fab4ed83".into())
            }
            "wrong-generation" => coverage[0].generation = Some(8),
            "duplicate" => coverage.push(coverage[0].clone()),
            "not-saved" => f.write_session(serde_json::json!({"workspaces":[],"docks":[]})),
            _ => *f.state.session_checkpoint.receipts.lock().unwrap() = ReceiptRegistry::default(),
        }
        assert!(
            commit_to(&f.state, &token, &coverage, &f.settings)
                .unwrap()
                .is_none(),
            "{change}"
        );
    }
}

#[test]
fn evidence_from_before_capture_cannot_license_a_new_commit() {
    let f = Fixture::new();
    let token = capture(&f.state).unwrap().unwrap();
    assert!(commit_to(&f.state, &token, &f.coverage(), &f.settings)
        .unwrap()
        .is_none());
}

#[test]
fn a_receipt_requires_the_exact_durable_checkpoint_revision() {
    let f = Fixture::new();
    let token = capture(&f.state).unwrap().unwrap();
    remember_codex_file(&f.state, "terminal-pane", 7, ID, &f.rollout);
    let store = crate::settings::persistence::store_for_settings(&f.settings).unwrap();
    let revision = store.revision().unwrap().0;
    assert!(commit_to_revision(
        &f.state,
        &token,
        &f.coverage(),
        &f.settings,
        Some(revision + 1),
        &store
    )
    .unwrap()
    .is_none());
    assert!(commit_to_revision(
        &f.state,
        &token,
        &f.coverage(),
        &f.settings,
        Some(revision),
        &store
    )
    .unwrap()
    .is_some());
}

#[test]
fn protocol_replies_do_not_invalidate_an_unchanged_conversation() {
    let f = Fixture::new();
    let token = f.committed();
    f.state.pty_handles.lock().unwrap()["terminal-pane"]
        .write_protocol_reply(b"\x1b[?1c")
        .unwrap();
    assert!(reusable(&f.state, &token).unwrap());
}

#[test]
fn saved_codex_and_an_idle_shell_share_the_fast_path_but_running_commands_do_not() {
    for running in [false, true] {
        let f = Fixture::new();
        let mut shell = TerminalSession::new("terminal-shell".into(), TerminalConfig::default());
        shell.codex_hook_title.generation = 9;
        shell.title = "PS C:\\project>".into();
        shell.command_running = running;
        f.state
            .terminals
            .lock()
            .unwrap()
            .insert("terminal-shell".into(), shell);
        f.state.pty_handles.lock().unwrap().insert(
            "terminal-shell".into(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 9),
        );
        f.write_session(serde_json::json!({"workspaces":[{"panes":[
            {"id":"pane","view":{"type":"TerminalView","lastCodexSession":ID}},
            {"id":"shell","view":{"type":"TerminalView"}}
        ]}],"docks":[]}));
        let token = capture(&f.state)
            .unwrap()
            .expect("shell metadata is observable");
        remember_codex_file(&f.state, "terminal-pane", 7, ID, &f.rollout);
        let mut coverage = f.coverage();
        coverage.push(ReceiptCoverage {
            terminal_id: "terminal-shell".into(),
            generation: Some(9),
            state: "noAgent".into(),
            provider: None,
            session_id: None,
        });
        remember_no_agent(&f.state, &token, "terminal-shell", 9);
        let result = commit_to(&f.state, &token, &coverage, &f.settings).unwrap();
        assert_eq!(result.is_some(), !running);
        if let Some(receipt) = result {
            assert!(reusable(&f.state, &receipt).unwrap());
        }
    }
}

#[test]
fn stacked_slot_layers_are_saved_views_for_their_terminals() {
    // ADR-0297: a stacked slot persists its terminals under `layers`, not the
    // compact `id`/`view`. Every layer must still license the receipt.
    let f = Fixture::new();
    let mut shell = TerminalSession::new("terminal-shell".into(), TerminalConfig::default());
    shell.codex_hook_title.generation = 9;
    shell.title = "PS C:\\project>".into();
    f.state
        .terminals
        .lock()
        .unwrap()
        .insert("terminal-shell".into(), shell);
    f.state.pty_handles.lock().unwrap().insert(
        "terminal-shell".into(),
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 9),
    );
    f.write_session(serde_json::json!({"workspaces":[{"panes":[{
            "id":"slot","x":0.0,"y":0.0,"w":1.0,"h":1.0,
            "layers":[
                {"id":"pane","view":{"type":"TerminalView","lastCodexSession":ID}},
                {"id":"shell","view":{"type":"TerminalView"}}
            ],
            "activeLayerId":"shell"
        }]}],"docks":[]}));
    let token = capture(&f.state)
        .unwrap()
        .expect("terminals are observable");
    remember_codex_file(&f.state, "terminal-pane", 7, ID, &f.rollout);
    remember_no_agent(&f.state, &token, "terminal-shell", 9);
    let mut coverage = f.coverage();
    coverage.push(ReceiptCoverage {
        terminal_id: "terminal-shell".into(),
        generation: Some(9),
        state: "noAgent".into(),
        provider: None,
        session_id: None,
    });
    let receipt = commit_to(&f.state, &token, &coverage, &f.settings)
        .unwrap()
        .expect("stacked layers must count as saved terminal views");
    assert!(reusable(&f.state, &receipt).unwrap());
}

#[test]
fn a_layer_and_a_compact_pane_claiming_one_terminal_invalidate_the_receipt() {
    let f = Fixture::new();
    let value = serde_json::json!({"workspaces":[{"id":"fixture","name":"fixture","panes":[
        {"id":"pane","view":{"type":"TerminalView","lastCodexSession":ID}},
        {"id":"slot","layers":[{"id":"pane","view":{"type":"TerminalView"}}]}
    ]}],"docks":[]});
    assert!(
        saved_views(&value).is_none(),
        "ambiguous content cannot license a receipt"
    );
    let store = crate::settings::persistence::store_for_settings(&f.settings).unwrap();
    let revision = store.revision().unwrap();
    let snapshot = serde_json::from_value(value).unwrap();
    assert!(store.commit_session(&snapshot).is_err());
    assert_eq!(
        store.revision().unwrap(),
        revision,
        "rejected duplicate must preserve the last commit"
    );
}
