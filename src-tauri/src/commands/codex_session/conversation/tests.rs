use super::*;
use crate::agent_hooks::title::TitleBinding;
use crate::terminal::{TerminalConfig, TerminalSession};
use laymux_agent_hook::runtime::HookEvent;

const ID: &str = "01a0ec06-451a-7e61-ac51-bd98fab4ed82";
const OTHER: &str = "01a0ec07-451a-7e61-ac51-bd98fab4ed83";

struct Fixture {
    state: AppState,
    home: tempfile::TempDir,
    event: HookEvent,
}

impl Fixture {
    fn new() -> Self {
        let state = AppState::new();
        let home = tempfile::tempdir().unwrap();
        let mut terminal = TerminalSession::new("pane".into(), TerminalConfig::default());
        terminal.codex_hook_title = TitleBinding {
            generation: 7,
            revision: 1,
            identity: Some(ID[..29].into()),
        };
        state
            .terminals
            .lock()
            .unwrap()
            .insert("pane".into(), terminal);
        state.pty_handles.lock().unwrap().insert(
            "pane".into(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7),
        );
        let mut event = laymux_agent_hook::runtime::parse_event(
            "codex",
            &serde_json::json!({"session_id":ID,"hook_event_name":"Stop"}),
            "original-server-pane".into(),
            "original-server-token".into(),
        )
        .unwrap();
        event.config_dir = Some(home.path().to_string_lossy().into_owned());
        event.emitted_at_ms = 1;
        state
            .agent_hook_observations
            .lock()
            .unwrap()
            .observe(event.clone());
        Self { state, home, event }
    }

    fn store(&self) -> CodexSessionStore {
        CodexSessionStore::new(self.home.path().into(), self.home.path().into())
    }

    fn rollout(&self, id: &str, source: serde_json::Value) -> std::path::PathBuf {
        let directory = self.home.path().join("sessions/2026/10/06");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("rollout-test-{id}.jsonl"));
        std::fs::write(
            &path,
            serde_json::json!({"type":"session_meta", "payload":{
                "id":id, "cwd":"/same/project", "source":source
            }})
            .to_string()
                + "\n",
        )
        .unwrap();
        path
    }
}

fn selected(id: &str, fresh: bool) -> Option<ResolvedSession> {
    Some(ResolvedSession {
        id: id.into(),
        fresh,
        selection_key: Some("process-selection".into()),
    })
}

fn resume_fixture() -> Fixture {
    let f = Fixture::new();
    *f.state.agent_hook_observations.lock().unwrap() = Default::default();
    let handle =
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_session_restore(Some(("codex", ID.into())));
    f.state
        .pty_handles
        .lock()
        .unwrap()
        .insert("pane".into(), handle);
    f
}

#[test]
fn resumed_current_title_and_rollout_recover_without_new_hooks_even_after_input() {
    for consumed in [false, true] {
        let f = resume_fixture();
        f.rollout(ID, "cli".into());
        if consumed {
            f.state.pty_handles.lock().unwrap()["pane"].consume_session_restore();
        }
        let lookup = ConversationLookup::new(&f.state, true).unwrap();
        let resumed = lookup
            .resolve("pane", &f.store(), None, None)
            .unwrap()
            .expect("live restored conversation");
        assert_eq!(resumed.id, ID);
        assert!(!resumed.fresh);
        if consumed {
            assert!(f.state.pty_handles.lock().unwrap()["pane"]
                .unconsumed_session_restore()
                .is_none());
        }
    }
}

#[test]
fn resume_request_alone_cannot_prove_missing_title_rollout_or_a_different_conversation() {
    for change in [
        "no-title",
        "no-rollout",
        "new-conversation",
        "different-provider",
    ] {
        let f = resume_fixture();
        if change != "no-rollout" {
            f.rollout(ID, "cli".into());
        }
        match change {
            "no-title" => f
                .state
                .terminals
                .lock()
                .unwrap()
                .get_mut("pane")
                .unwrap()
                .codex_hook_title
                .clear(),
            "new-conversation" => {
                f.state
                    .terminals
                    .lock()
                    .unwrap()
                    .get_mut("pane")
                    .unwrap()
                    .codex_hook_title
                    .identity = Some(OTHER[..29].into())
            }
            "different-provider" => {
                f.state.pty_handles.lock().unwrap().insert(
                    "pane".into(),
                    crate::pty::PtyHandle::from_test_writer_for_generation(
                        Box::new(std::io::sink()),
                        7,
                    )
                    .with_session_restore(Some(("claude", ID.into()))),
                );
            }
            _ => {}
        }
        let lookup = ConversationLookup::new(&f.state, true).unwrap();
        let result = lookup.resolve("pane", &f.store(), None, None);
        if ["no-title", "no-rollout"].contains(&change) {
            assert!(
                result.is_err(),
                "{change}: uncertainty must preserve the last checkpoint"
            );
        } else {
            assert!(result.unwrap().is_none(), "{change}");
        }
    }
}

#[test]
fn ordinary_checkpoint_uses_retained_shared_server_hook_without_an_exit_token_or_install_probe() {
    let f = Fixture::new();
    f.rollout(ID, "cli".into());
    assert!(f
        .state
        .session_checkpoint
        .codex_status
        .lock()
        .unwrap()
        .is_none());
    // No managed installation files, no current task phase, and no trustworthy
    // emitting pane/token: only current title + domain + rollout prove the ID.
    let lookup = ConversationLookup::new(&f.state, true).unwrap();
    let session = lookup
        .resolve("pane", &f.store(), None, None)
        .unwrap()
        .unwrap();
    assert_eq!(session.id, ID);
    assert!(!session.fresh);
}

#[test]
fn missing_hook_rollout_is_never_a_fresh_conversation() {
    let f = Fixture::new();
    let lookup = ConversationLookup::new(&f.state, true).unwrap();
    assert!(lookup.resolve("pane", &f.store(), None, None).is_err());
    let fresh = lookup
        .resolve("pane", &f.store(), None, selected(ID, true))
        .unwrap()
        .unwrap();
    assert!(
        fresh.fresh,
        "only the process lifecycle can prove a fresh thread"
    );
}

#[test]
fn heuristic_mode_and_missing_hook_do_not_synthesize_identity() {
    let f = Fixture::new();
    f.rollout(ID, "cli".into());
    let lookup = ConversationLookup::new(&f.state, false).unwrap();
    assert!(lookup
        .resolve("pane", &f.store(), None, None)
        .unwrap()
        .is_none());
    assert_eq!(
        lookup
            .resolve("pane", &f.store(), None, selected(OTHER, false))
            .unwrap()
            .unwrap()
            .id,
        OTHER
    );
    *f.state.agent_hook_observations.lock().unwrap() = Default::default();
    let lookup = ConversationLookup::new(&f.state, true).unwrap();
    assert!(lookup
        .resolve("pane", &f.store(), None, None)
        .unwrap()
        .is_none());
}

#[test]
fn current_title_conflict_rejects_even_an_exact_process_selection() {
    let f = Fixture::new();
    let lookup = ConversationLookup::new(&f.state, true).unwrap();
    assert!(lookup
        .resolve("pane", &f.store(), None, selected(OTHER, false))
        .is_err());
}

#[test]
fn title_aba_pty_replacement_and_disappearance_invalidate_a_lookup() {
    for change in ["title", "aba", "generation", "disappear"] {
        let f = Fixture::new();
        f.rollout(ID, "cli".into());
        let lookup = ConversationLookup::new(&f.state, true).unwrap();
        match change {
            "title" => {
                f.state
                    .terminals
                    .lock()
                    .unwrap()
                    .get_mut("pane")
                    .unwrap()
                    .codex_hook_title
                    .identity = Some(OTHER[..29].into())
            }
            "aba" => {
                f.state
                    .terminals
                    .lock()
                    .unwrap()
                    .get_mut("pane")
                    .unwrap()
                    .codex_hook_title
                    .revision += 2
            }
            "generation" => {
                f.state.pty_handles.lock().unwrap().insert(
                    "pane".into(),
                    crate::pty::PtyHandle::from_test_writer_for_generation(
                        Box::new(std::io::sink()),
                        8,
                    ),
                );
            }
            _ => {
                f.state.pty_handles.lock().unwrap().remove("pane");
            }
        }
        assert!(
            lookup
                .resolve("pane", &f.store(), None, selected(ID, false))
                .is_err(),
            "{change}"
        );
    }
}

#[test]
fn ended_auxiliary_wrong_root_wrong_distro_and_prefix_collision_are_not_candidates() {
    for change in ["end", "auxiliary", "root", "distro", "collision"] {
        let f = Fixture::new();
        f.rollout(ID, "cli".into());
        let mut event = f.event.clone();
        match change {
            "end" => event.event = "SessionEnd".into(),
            "auxiliary" => event.agent_id = Some("child".into()),
            "root" => {
                event.config_dir = Some(f.home.path().join("other").to_string_lossy().into_owned())
            }
            "distro" => event.distro = Some("other-distro".into()),
            _ => event.session_id = format!("{}0000000", &ID[..29]),
        }
        let mut registry = f.state.agent_hook_observations.lock().unwrap();
        if change != "collision" {
            *registry = Default::default();
        }
        registry.observe(event);
        drop(registry);
        let lookup = ConversationLookup::new(&f.state, true).unwrap();
        assert!(
            lookup
                .resolve("pane", &f.store(), None, None)
                .unwrap()
                .is_none(),
            "{change}"
        );
    }
}

#[test]
fn corrupt_auxiliary_and_duplicate_rollouts_cannot_prove_a_hook_conversation() {
    for change in ["corrupt", "auxiliary", "duplicate"] {
        let f = Fixture::new();
        let path = f.rollout(
            ID,
            if change == "auxiliary" {
                serde_json::json!({"subagent":"review"})
            } else {
                "cli".into()
            },
        );
        if change == "corrupt" {
            std::fs::write(path, "broken\n").unwrap();
        } else if change == "duplicate" {
            std::fs::copy(
                &path,
                path.with_file_name(format!("rollout-duplicate-{ID}.jsonl")),
            )
            .unwrap();
        }
        let lookup = ConversationLookup::new(&f.state, true).unwrap();
        assert!(
            lookup.resolve("pane", &f.store(), None, None).is_err(),
            "{change}"
        );
    }
}
