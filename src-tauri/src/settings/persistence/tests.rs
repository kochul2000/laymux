use super::*;
use crate::settings::{load_settings_validated_from, save_settings_to};
fn loaded(path: &Path) -> Settings {
    match load_settings_validated_from(path) {
        SettingsLoadResult::Ok { settings, .. } | SettingsLoadResult::Repaired { settings, .. } => {
            settings
        }
        error => panic!("unexpected load result: {error:?}"),
    }
}

#[test]
fn configuration_core_uses_the_explicit_database_instead_of_inferred_os_paths() {
    let temp = tempfile::tempdir().unwrap();
    let json = temp.path().join("config/settings.json");
    let store = LocalStateStore::new(temp.path().join("local/state.db"));
    let mut settings = Settings::default();
    settings.profiles[0].starting_directory = "D:/injected-host/project".into();
    crate::settings::save_settings_with_store(&json, &settings, &store).unwrap();
    let result = hydrate(
        &json,
        crate::settings::load_settings_document_from(&json),
        Ok(store.clone()),
    );
    assert!(
        matches!(result,SettingsLoadResult::Ok {settings,..} | SettingsLoadResult::Repaired {settings,..} if settings.profiles[0].starting_directory=="D:/injected-host/project")
    );
    assert!(store.path().exists());
    assert!(!json.with_file_name("state.db").exists());
}
#[test]
fn copying_only_settings_to_another_pc_does_not_transfer_local_state_or_machine_bindings() {
    let pc_a = tempfile::tempdir().unwrap();
    let pc_b = tempfile::tempdir().unwrap();
    let path_a = pc_a.path().join("settings.json");
    let path_b = pc_b.path().join("settings.json");
    let mut settings = Settings {
        language: "ko".into(),
        ..Settings::default()
    };
    settings.profiles[0].command_line = "D:/host-a/pwsh.exe".into();
    settings.profiles[0].starting_directory = "D:/host-a/project".into();
    settings.workspaces[0].panes[0].view.extra["lastCodexSession"] = "host-a-conversation".into();
    settings.workspaces[0].panes[0].view.extra["lastCwd"] = "D:/host-a/project".into();
    save_settings_to(&path_a, &settings).unwrap();
    store_for_settings(&path_a)
        .unwrap()
        .commit_session(&LocalSessionSnapshot {
            workspaces: settings.workspaces,
            docks: settings.docks,
            ..Default::default()
        })
        .unwrap();
    std::fs::copy(&path_a, &path_b).unwrap();
    let a = loaded(&path_a);
    let b = loaded(&path_b);
    assert_eq!(
        a.workspaces[0].panes[0].view.extra["lastCodexSession"],
        "host-a-conversation"
    );
    assert_eq!(b.language, "ko");
    assert!(!serde_json::to_string(&b).unwrap().contains("host-a"));
    assert!(!pc_b.path().join("state.db").exists());
}
#[test]
fn session_only_commit_does_not_touch_json_and_config_reset_preserves_session_rows() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    let settings = Settings::default();
    save_settings_to(&path, &settings).unwrap();
    let before = std::fs::read(&path).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let mut session = LocalSessionSnapshot {
        workspaces: settings.workspaces,
        docks: settings.docks,
        ..Default::default()
    };
    session.workspaces[0].name = "local-restored".into();
    let store = store_for_settings(&path).unwrap();
    store.commit_session(&session).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    save_settings_to(&path, &Settings::default()).unwrap();
    assert_eq!(loaded(&path).workspaces[0].name, "local-restored");
}
#[test]
fn state_corruption_is_reported_as_local_state_error_without_overwriting_anything() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    save_settings_to(&path, &Settings::default()).unwrap();
    let store = store_for_settings(&path).unwrap();
    std::fs::write(store.path(), b"broken database").unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(
        matches!(load_settings_validated_from(&path),SettingsLoadResult::ParseError {storage_kind:Some(kind),..} if kind=="localState")
    );
    assert!(save_settings_to(&path, &Settings::default()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read(store.path()).unwrap(), b"broken database");
}
#[test]
fn layout_environment_stays_local_and_is_not_rebound_to_another_template_slot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    let mut settings = Settings::default();
    settings.layouts[0].panes[0].view_type = "UsageView".into();
    settings.layouts[0].panes[0].view_config = Some(
        serde_json::json!({"type":"UsageView","configDir":"D:/private-account","lastCodexSession":"must-never-reuse"}),
    );
    save_settings_to(&path, &settings).unwrap();
    let same_pc = loaded(&path);
    assert_eq!(
        same_pc.layouts[0].panes[0].view_config.as_ref().unwrap()["configDir"],
        "D:/private-account"
    );
    assert!(same_pc.layouts[0].panes[0]
        .view_config
        .as_ref()
        .unwrap()
        .get("lastCodexSession")
        .is_none());
    let mut portable: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(!serde_json::to_string(&portable)
        .unwrap()
        .contains("private-account"));
    portable["layouts"][0]["panes"][0]["viewType"] = "TerminalView".into();
    portable["layouts"][0]["panes"][0]["viewConfig"]["type"] = "TerminalView".into();
    std::fs::write(&path, serde_json::to_vec(&portable).unwrap()).unwrap();
    assert!(loaded(&path).layouts[0].panes[0]
        .view_config
        .as_ref()
        .unwrap()
        .get("configDir")
        .is_none());
}
#[test]
fn a_first_import_uses_the_configured_logical_profile_without_foreign_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    std::fs::write(
        &path,
        r#"{"profiles":[{"name":"Imported shell"}],"defaultProfile":"Imported shell"}"#,
    )
    .unwrap();
    let settings = loaded(&path);
    assert_eq!(
        settings.workspaces[0].panes[0].view.extra["profile"],
        "Imported shell"
    );
    assert!(!settings.profiles[0].command_line.is_empty());
}
