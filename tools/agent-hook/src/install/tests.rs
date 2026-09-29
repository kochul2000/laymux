use super::*;
use serde_json::json;

fn fixture(provider: &str, value: &Value) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("config space '한글");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join(if provider == "claude" {
            "settings.json"
        } else {
            "hooks.json"
        }),
        serde_json::to_vec(value).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.path().join("helper"), "executable fixture").unwrap();
    (dir, root)
}

#[test]
fn optional_install_round_trip_preserves_foreign_hooks_and_settings() {
    for provider in ["claude", "codex"] {
        let original = json!({"unknown": {"enabled": true}, "hooks": {"SessionStart": [{"matcher":"resume", "hooks":[{"type":"command", "command":"user-hook"}]}], "Stop": []}});
        let (dir, root) = fixture(provider, &original);
        let helper = dir.path().join("helper");
        assert_eq!(
            manage(&root, provider, "status", &helper).unwrap()["installed"],
            false
        );
        assert_eq!(
            manage(&root, provider, "install", &helper).unwrap()["installed"],
            true
        );
        let file = root.join(if provider == "claude" {
            "settings.json"
        } else {
            "hooks.json"
        });
        let first = std::fs::read(&file).unwrap();
        manage(&root, provider, "install", &helper).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), first);
        let mut edited: Value = serde_json::from_slice(&first).unwrap();
        edited["addedAfterInstall"] = json!(42);
        std::fs::write(&file, serde_json::to_vec(&edited).unwrap()).unwrap();
        assert_eq!(
            manage(&root, provider, "remove", &helper).unwrap()["installed"],
            false
        );
        let restored: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(restored["unknown"], original["unknown"]);
        assert_eq!(
            restored["hooks"]["SessionStart"],
            original["hooks"]["SessionStart"]
        );
        assert_eq!(restored["addedAfterInstall"], 42);
        manage(&root, provider, "remove", &helper).unwrap();
    }
}

#[test]
fn malformed_configs_are_never_overwritten() {
    for contents in [
        "{ broken",
        "[]",
        "{\"hooks\":[]}",
        "{\"hooks\":{\"SessionStart\":1}}",
    ] {
        let (dir, root) = fixture("claude", &json!({}));
        let file = root.join("settings.json");
        std::fs::write(&file, contents).unwrap();
        assert!(manage(&root, "claude", "install", &dir.path().join("helper")).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), contents);
    }
}

#[test]
fn status_and_remove_do_not_create_missing_config() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("missing");
    for operation in ["status", "remove"] {
        assert_eq!(
            manage(&root, "codex", operation, &dir.path().join("missing-exe")).unwrap()
                ["installed"],
            false
        );
        assert!(!root.exists());
    }
}

#[test]
fn disabled_hooks_are_not_enabled_by_installation() {
    let (dir, root) = fixture("claude", &json!({"disableAllHooks":true}));
    let status = manage(&root, "claude", "install", &dir.path().join("helper")).unwrap();
    assert_eq!(status["disabled"], true);
    let value: Value =
        serde_json::from_slice(&std::fs::read(root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(value["disableAllHooks"], true);
}

#[test]
fn respects_codex_disabled_feature_and_repairs_missing_helper() {
    let (dir, root) = fixture("codex", &json!({}));
    std::fs::write(root.join("config.toml"), "[features]\nhooks = false\n").unwrap();
    let source = dir.path().join("helper");
    let status = manage(&root, "codex", "install", &source).unwrap();
    assert_eq!(status["disabled"], true);
    std::fs::remove_file(helper_path(&root)).unwrap();
    assert_eq!(
        manage(&root, "codex", "status", &source).unwrap()["installed"],
        false
    );
    assert_eq!(
        manage(&root, "codex", "install", &source).unwrap()["installed"],
        true
    );
    assert_eq!(
        std::fs::read_to_string(root.join("config.toml")).unwrap(),
        "[features]\nhooks = false\n"
    );
}

#[test]
fn serialized_installation_and_shared_matcher_removal() {
    let (dir, root) = fixture("claude", &json!({}));
    let source = dir.path().join("helper");
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(".laymux-hooks.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    assert!(manage(&root, "claude", "install", &source)
        .unwrap_err()
        .contains("in progress"));
    drop(lock);
    manage(&root, "claude", "install", &source).unwrap();
    let file = root.join("settings.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let foreign = json!({"type":"command","command":"user-hook"});
    value["hooks"]["SessionStart"][0]["hooks"]
        .as_array_mut()
        .unwrap()
        .push(foreign.clone());
    std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    manage(&root, "claude", "remove", &source).unwrap();
    let value: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(value["hooks"]["SessionStart"][0]["hooks"], json!([foreign]));
    assert!(!helper_path(&root).exists());
}

#[test]
fn removal_recognizes_owned_command_after_user_changes_timeout_or_event() {
    let (dir, root) = fixture("codex", &json!({}));
    let source = dir.path().join("helper");
    manage(&root, "codex", "install", &source).unwrap();
    let file = root.join("hooks.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    value["hooks"]["SessionStart"][0]["hooks"][0]["timeout"] = json!(5);
    value["hooks"]["Stop"] = value["hooks"]["SessionStart"].clone();
    std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    manage(&root, "codex", "remove", &source).unwrap();
    let value: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    for event in ["SessionStart", "SessionEnd", "Stop"] {
        assert_eq!(value["hooks"][event], json!([]));
    }
    assert!(!helper_path(&root).exists());
}

#[test]
fn malformed_codex_preferences_do_not_prevent_hook_cleanup() {
    let (dir, root) = fixture("codex", &json!({}));
    let source = dir.path().join("helper");
    manage(&root, "codex", "install", &source).unwrap();
    std::fs::write(root.join("config.toml"), "[broken").unwrap();
    let status = manage(&root, "codex", "status", &source).unwrap();
    assert!(status["warning"].as_str().unwrap().contains("config.toml"));
    let status = manage(&root, "codex", "remove", &source).unwrap();
    assert_eq!(status["registered"], 0);
    assert!(!helper_path(&root).exists());
    assert_eq!(
        std::fs::read_to_string(root.join("config.toml")).unwrap(),
        "[broken"
    );
}

#[cfg(windows)]
#[test]
fn windows_path_separators_keep_the_same_installation_identity() {
    for provider in ["claude", "codex"] {
        let (dir, root) = fixture(provider, &json!({}));
        let slashed = PathBuf::from(root.to_str().unwrap().replace('\\', "/"));
        let source = dir.path().join("helper");
        manage(&slashed, provider, "install", &source).unwrap();
        assert_eq!(
            manage(&root, provider, "status", &source).unwrap()["installed"],
            true
        );
        manage(&root, provider, "install", &source).unwrap();
        let value: Value =
            serde_json::from_slice(&fs::read(root.join(config_name(provider).unwrap())).unwrap())
                .unwrap();
        assert_eq!(value["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(
            manage(&slashed, provider, "remove", &source).unwrap()["registered"],
            0
        );
        assert!(!helper_path(&root).exists());
    }
}
