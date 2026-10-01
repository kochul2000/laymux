use super::*;

fn fixture(provider: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("custom config '한글");
    let source = dir.path().join("bundle");
    fs::write(&source, b"current helper").unwrap();
    manage(&root, provider, "install", &source).unwrap();
    (dir, root, source)
}

#[test]
fn status_detects_changed_helper_without_modifying_installation() {
    for provider in ["claude", "codex"] {
        let (_dir, root, source) = fixture(provider);
        let fresh = manage(&root, provider, "status", &source).unwrap();
        assert_eq!(fresh["helperCurrent"], true);
        assert_eq!(fresh["updateRequired"], false);
        fs::write(&source, b"updated helper").unwrap();
        let before = fs::read(root.join(config_name(provider).unwrap())).unwrap();
        let stale = manage(&root, provider, "status", &source).unwrap();
        assert_eq!(stale["installed"], true);
        assert_eq!(stale["helperCurrent"], false);
        assert_eq!(stale["updateRequired"], true);
        assert_eq!(stale["updateReasons"], json!(["helper_outdated"]));
        assert_eq!(fs::read(helper_path(&root)).unwrap(), b"current helper");
        assert_eq!(
            fs::read(root.join(config_name(provider).unwrap())).unwrap(),
            before
        );
    }
}

#[test]
fn update_repairs_owned_installation_and_preserves_foreign_hooks_and_disabled_setting() {
    for provider in ["claude", "codex"] {
        let (_dir, root, source) = fixture(provider);
        let path = root.join(config_name(provider).unwrap());
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let foreign = json!({"type":"command","command":"echo user hook","timeout":17});
        config["hooks"]["Stop"] = json!([{"matcher":"user", "hooks":[foreign.clone()]}]);
        config["disableAllHooks"] = json!(true);
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::remove_file(helper_path(&root)).unwrap();
        fs::write(&source, b"new helper").unwrap();
        let stale = manage(&root, provider, "status", &source).unwrap();
        assert_eq!(stale["updateRequired"], true);
        assert!(stale["updateReasons"]
            .as_array()
            .unwrap()
            .contains(&json!("registrations")));
        assert!(stale["updateReasons"]
            .as_array()
            .unwrap()
            .contains(&json!("helper_missing")));
        let repaired = manage(&root, provider, "update", &source).unwrap();
        assert_eq!(repaired["updateRequired"], false);
        assert_eq!(repaired["currentRegistered"], events(provider).len());
        assert_eq!(fs::read(helper_path(&root)).unwrap(), b"new helper");
        let after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["hooks"]["Stop"][0], config["hooks"]["Stop"][0]);
        assert_eq!(after["disableAllHooks"], true);
    }
}

#[test]
fn never_installed_or_removed_targets_are_not_reinstalled_by_update() {
    for provider in ["claude", "codex"] {
        let (_dir, root, source) = fixture(provider);
        manage(&root, provider, "remove", &source).unwrap();
        let before = fs::read(root.join(config_name(provider).unwrap())).unwrap();
        let result = manage(&root, provider, "update", &source).unwrap();
        assert_eq!(result["updateRequired"], false);
        assert!(!helper_path(&root).exists());
        assert_eq!(
            fs::read(root.join(config_name(provider).unwrap())).unwrap(),
            before
        );
        let absent = root.join("absent");
        let result = manage(&absent, provider, "update", &source).unwrap();
        assert_eq!(result["updateRequired"], false);
        assert!(!absent.exists());
    }
}

#[test]
fn missing_bundle_is_unknown_and_does_not_claim_helper_is_current() {
    let (_dir, root, source) = fixture("codex");
    fs::remove_file(source.clone()).unwrap();
    let result = manage(&root, "codex", "status", &source).unwrap();
    assert_eq!(result["helperCurrent"], Value::Null);
    assert!(result["updateWarning"].as_str().unwrap().contains("helper"));
    assert_eq!(fs::read(helper_path(&root)).unwrap(), b"current helper");
}

#[test]
fn duplicate_owned_commands_need_update_even_when_all_events_are_registered() {
    let (_dir, root, source) = fixture("codex");
    let path = root.join("hooks.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let duplicate = handler(&root, "codex").unwrap();
    config["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(json!({"hooks":[duplicate]}));
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let result = manage(&root, "codex", "status", &source).unwrap();
    assert_eq!(result["currentRegistered"], events("codex").len());
    assert_eq!(result["updateRequired"], true);
    assert_eq!(result["updateReasons"], json!(["registrations"]));
    let repaired = manage(&root, "codex", "update", &source).unwrap();
    assert_eq!(repaired["updateRequired"], false);
}

#[test]
fn owned_handler_outside_supported_events_proves_installation_when_helper_is_missing() {
    let (_dir, root, source) = fixture("codex");
    let config = json!({"hooks":{"FutureEvent":[{"hooks":[handler(&root, "codex").unwrap()]}]}});
    fs::write(
        root.join("hooks.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    fs::remove_file(helper_path(&root)).unwrap();
    let result = manage(&root, "codex", "status", &source).unwrap();
    assert_eq!(result["registered"], 0);
    assert_eq!(result["updateRequired"], true);
    let repaired = manage(&root, "codex", "update", &source).unwrap();
    assert_eq!(repaired["helperCurrent"], true);
    assert_eq!(repaired["updateRequired"], false);
}
