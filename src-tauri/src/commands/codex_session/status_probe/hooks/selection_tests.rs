use super::*;
use crate::agent_hooks::observations::HookRegistry;

const ID: &str = "01a0ec06-451a-7e61-ac51-bd98fab4ed82";

#[test]
fn resumed_process_without_a_start_hook_can_prove_identity_with_or_without_a_title() {
    for distro in [None, Some("Ubuntu-22.04")] {
        let root = if distro.is_some() {
            "/tmp/codex"
        } else if cfg!(windows) {
            "C:\\codex"
        } else {
            "/tmp/codex"
        };
        let process = CodexStatusProcess {
            pid: 1,
            started_at: 2,
            distro: distro.map(str::to_owned),
            codex_home: crate::path_utils::resolve_path_for_windows(root, distro).into(),
            sqlite_home: "unused".into(),
        };
        let title = TitleBinding {
            generation: 3,
            revision: 1,
            identity: Some(ID[..29].into()),
        };
        let cleared = TitleBinding {
            identity: None,
            ..title.clone()
        };
        let registry = HookRegistry::default();
        for snapshot in [None, Some(&title), Some(&cleared)] {
            let found = candidate(&registry, snapshot, 3, &process, Some(ID), None)
                .expect("exact resumed process must not need a deferred SessionStart hook");
            assert!(matches!(found.binding, CodexHookBinding::Process(_)));
            assert_eq!(found.id, ID);
            assert_eq!(
                Path::new(&crate::path_utils::resolve_path_for_windows(
                    &found.root,
                    distro
                )),
                process.codex_home
            );
            assert!(
                candidate(&registry, snapshot, 3, &process, None, Some(&found.binding)).is_none(),
                "process proof must not survive lost current selection"
            );
        }
        assert!(candidate(
            &registry,
            Some(&title),
            3,
            &process,
            Some("01a0ec07-451a-7e61-ac51-bd98fab4ed83"),
            None
        )
        .is_none());
        assert!(candidate(&registry, None, 3, &process, None, None).is_none());
        assert!(candidate(&registry, None, 3, &process, Some("malformed"), None).is_none());
    }
}

#[test]
fn checkpoint_binding_kind_never_downgrades_when_a_hook_arrives_or_ends() {
    let root = if cfg!(windows) {
        "C:\\codex"
    } else {
        "/tmp/codex"
    };
    let process = CodexStatusProcess {
        pid: 1,
        started_at: 2,
        distro: None,
        codex_home: root.into(),
        sqlite_home: root.into(),
    };
    let title = TitleBinding {
        generation: 3,
        revision: 1,
        identity: Some(ID[..29].into()),
    };
    let mut registry = HookRegistry::default();
    let process_proof = candidate(&registry, Some(&title), 3, &process, Some(ID), None).unwrap();
    let mut event = laymux_agent_hook::runtime::parse_event(
        "codex",
        &serde_json::json!({"session_id":ID,"hook_event_name":"Stop"}),
        "unrelated-pane".into(),
        "unrelated-token".into(),
    )
    .unwrap();
    event.config_dir = Some(root.into());
    registry.observe(event.clone());
    let title_proof = candidate(&registry, Some(&title), 3, &process, None, None).unwrap();
    assert!(matches!(title_proof.binding, CodexHookBinding::Title(_)));
    assert!(matches!(
        candidate(
            &registry,
            Some(&title),
            3,
            &process,
            Some(ID),
            Some(&process_proof.binding)
        )
        .unwrap()
        .binding,
        CodexHookBinding::Process(_)
    ));
    assert!(
        candidate(
            &registry,
            Some(&title),
            3,
            &process,
            None,
            Some(&process_proof.binding)
        )
        .is_none(),
        "a received hook cannot replace a lost process selection"
    );
    event.event = "SessionEnd".into();
    registry.observe(event);
    assert!(candidate(
        &registry,
        Some(&title),
        3,
        &process,
        None,
        Some(&title_proof.binding)
    )
    .is_none());
    assert!(
        candidate(
            &registry,
            Some(&title),
            3,
            &process,
            Some(ID),
            Some(&title_proof.binding)
        )
        .is_none(),
        "title proof does not silently switch evidence after SessionEnd"
    );
    assert!(
        matches!(
            candidate(&registry, Some(&title), 3, &process, Some(ID), None)
                .unwrap()
                .binding,
            CodexHookBinding::Process(_)
        ),
        "a new resume uses its exact process selection, not the ended hook"
    );
    let foreign = CodexStatusProcess {
        distro: Some("Other".into()),
        codex_home: crate::path_utils::resolve_path_for_windows("/tmp/codex", Some("Ubuntu"))
            .into(),
        ..process
    };
    assert!(
        candidate(&registry, None, 3, &foreign, Some(ID), None).is_none(),
        "root conversion cannot cross distros"
    );
}
