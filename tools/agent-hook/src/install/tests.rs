use super::*;
use serde_json::json;

#[cfg(windows)]
#[test]
fn windows_hook_commands_are_readable_and_old_owned_commands_are_replaced() {
    use base64::Engine;
    for provider in ["claude", "codex"] {
        let (dir, root) = fixture(provider, &json!({}));
        let source = dir.path().join("helper");
        let path = helper_path(&root).to_str().unwrap().replace('/', "\\");
        let script = format!("& '{}' emit {provider}", path.replace('\'', "''"));
        let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let legacy = json!({"type":"command", "command":format!("powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(bytes)), "timeout":3});
        let mut original = json!({"hooks":{}});
        for event in events(provider) {
            original["hooks"][event] = json!([{"hooks":[legacy.clone()]}]);
        }
        let mut foreign = legacy.clone();
        foreign["command"] = json!(format!(
            "{} ; Write-Output user",
            legacy["command"].as_str().unwrap()
        ));
        original["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(json!({"hooks":[foreign.clone()]}));
        let file = root.join(config_name(provider).unwrap());
        fs::write(&file, serde_json::to_vec(&original).unwrap()).unwrap();
        let current = handler(&root, provider).unwrap();
        let command = current["command"].as_str().unwrap();
        assert!(!command.contains("EncodedCommand"));
        assert!(
            command.contains("laymux-agent-hook.exe")
                && command.contains(&format!("emit {provider}"))
        );
        manage(&root, provider, "install", &source).unwrap();
        manage(&root, provider, "install", &source).unwrap();
        let after: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        for event in events(provider) {
            let handlers: Vec<_> = after["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|g| g["hooks"].as_array().unwrap())
                .collect();
            assert_eq!(
                handlers
                    .iter()
                    .filter(|h| h["command"] == current["command"])
                    .count(),
                1
            );
            assert!(!handlers.contains(&&legacy));
        }
        manage(&root, provider, "remove", &source).unwrap();
        let after: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(after["hooks"]["Stop"], json!([{"hooks":[foreign]}]));
        fs::write(&file, serde_json::to_vec(&original).unwrap()).unwrap();
        manage(&root, provider, "remove", &source).unwrap();
        let after: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(after["hooks"]["SessionStart"], json!([]));
    }
}

#[test]
fn custom_execution_fields_are_not_treated_as_owned_handlers() {
    let (dir, root) = fixture("codex", &json!({}));
    let source = dir.path().join("helper");
    manage(&root, "codex", "install", &source).unwrap();
    let file = root.join("hooks.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    let mut custom = handler(&root, "codex").unwrap();
    custom["args"] = json!(["user-argument"]);
    value["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(json!({"hooks":[custom.clone()]}));
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    manage(&root, "codex", "remove", &source).unwrap();
    let after: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(after["hooks"]["Stop"], json!([{"hooks":[custom]}]));
}

#[test]
fn codex_title_keeps_comments_inside_the_array_and_does_not_restore_over_new_comments() {
    let (dir, root) = fixture("codex", &json!({}));
    let helper = dir.path().join("helper");
    let config = root.join("config.toml");
    let original = "[tui]\nterminal_title = [\n  # project context\n  'project',\n  # model context\n  'model',\n]\n";
    fs::write(&config, original).unwrap();
    manage(&root, "codex", "install", &helper).unwrap();
    let installed = fs::read_to_string(&config).unwrap();
    assert!(installed.contains("# project context"));
    assert!(installed.contains("# model context"));
    manage(&root, "codex", "remove", &helper).unwrap();
    assert_eq!(fs::read_to_string(&config).unwrap(), original);
    manage(&root, "codex", "install", &helper).unwrap();
    let edited = fs::read_to_string(&config)
        .unwrap()
        .replace("project context", "user updated comment");
    fs::write(&config, &edited).unwrap();
    manage(&root, "codex", "remove", &helper).unwrap();
    assert_eq!(fs::read_to_string(&config).unwrap(), edited);
}

#[test]
fn codex_title_install_preserves_user_fields_and_restores_only_owned_value() {
    let (dir, root) = fixture("codex", &json!({}));
    let helper = dir.path().join("helper");
    let config = root.join("config.toml");
    let original = "# user comment\nmodel = 'gpt-6-sol'\n[tui]\nterminal_title = ['project', 'model'] # keep\nanimations = false\n";
    fs::write(&config, original).unwrap();
    let status = manage(&root, "codex", "install", &helper).unwrap();
    assert_eq!(status["titleBinding"]["configured"], true);
    let installed = fs::read_to_string(&config).unwrap();
    let parsed: toml::Value = toml::from_str(&installed).unwrap();
    assert_eq!(
        parsed["tui"]["terminal_title"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["app-name", "thread-id", "project", "model"]
    );
    assert!(installed.contains("# user comment"));
    manage(&root, "codex", "install", &helper).unwrap();
    fs::write(
        &config,
        installed.replace("animations = false", "animations = true"),
    )
    .unwrap();
    manage(&root, "codex", "remove", &helper).unwrap();
    let restored = fs::read_to_string(&config).unwrap();
    let parsed: toml::Value = toml::from_str(&restored).unwrap();
    assert_eq!(parsed["tui"]["terminal_title"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["tui"]["animations"].as_bool(), Some(true));
    assert!(restored.contains("# keep"));
    manage(&root, "codex", "install", &helper).unwrap();
    fs::write(&config, "[tui]\nterminal_title = ['model']\n").unwrap();
    let removed = manage(&root, "codex", "remove", &helper).unwrap();
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "[tui]\nterminal_title = ['model']\n"
    );
    assert!(removed["titleBinding"]["warning"].as_str().is_some());
}

#[test]
fn codex_title_missing_default_empty_and_malformed_are_not_silently_overwritten() {
    for previous in [None, Some("[tui]\nterminal_title = []\n")] {
        let (dir, root) = fixture("codex", &json!({}));
        let config = root.join("config.toml");
        if let Some(text) = previous {
            fs::write(&config, text).unwrap();
        }
        let helper = dir.path().join("helper");
        manage(&root, "codex", "install", &helper).unwrap();
        assert_eq!(
            manage(&root, "codex", "status", &helper).unwrap()["titleBinding"]["configured"],
            true
        );
        manage(&root, "codex", "remove", &helper).unwrap();
        let parsed: toml::Value = toml::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
        let title = parsed.get("tui").and_then(|v| v.get("terminal_title"));
        if previous.is_none() {
            assert!(title.is_none());
        } else {
            assert!(title.unwrap().as_array().unwrap().is_empty());
        }
    }
    let (dir, root) = fixture("codex", &json!({}));
    let config = root.join("config.toml");
    fs::write(&config, "broken [").unwrap();
    assert!(manage(&root, "codex", "install", &dir.path().join("helper")).is_err());
    assert_eq!(fs::read_to_string(&config).unwrap(), "broken [");
}

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
        toml::from_str::<toml::Value>(&std::fs::read_to_string(root.join("config.toml")).unwrap())
            .unwrap()["features"]["hooks"]
            .as_bool(),
        Some(false)
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
