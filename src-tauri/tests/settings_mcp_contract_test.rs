use laymux_lib::settings::contract::{
    describe_settings, prepare_settings_update, redact_settings, select_settings_paths,
    settings_revision, REDACTED_SETTING_VALUE,
};
use laymux_lib::settings::Settings;
use serde_json::json;

#[test]
fn nested_object_patch_preserves_unmentioned_values() {
    let current = Settings::default();
    let prepared = prepare_settings_update(
        &current,
        &json!({ "appearance": { "font": { "size": 20 } } }),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared
        .candidate
        .expect("valid update must have candidate");
    assert_eq!(candidate.appearance.font.size, 20);
    assert_eq!(candidate.appearance.font.face, current.appearance.font.face);
    assert_eq!(candidate.appearance.theme_id, current.appearance.theme_id);
    assert_ne!(
        prepared.current_revision,
        prepared.candidate_revision.unwrap()
    );
}

#[test]
fn array_patch_replaces_the_whole_array() {
    let current = Settings::default();
    let prepared = prepare_settings_update(
        &current,
        &json!({
            "profiles": [{ "name": "PowerShell", "commandLine": "pwsh.exe" }],
            "defaultProfile": "PowerShell"
        }),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared.candidate.unwrap();
    assert_eq!(candidate.profiles.len(), 1);
    assert_eq!(candidate.profiles[0].name, "PowerShell");
}

#[test]
fn unknown_key_is_rejected_instead_of_silently_ignored() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "appearance": { "themId": "typo" } }),
    );

    assert!(!prepared.valid);
    assert!(prepared.candidate.is_none());
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.code == "unknown_key" && issue.path.contains("themId")));
}

#[test]
fn wrong_type_is_rejected() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "controlBar": { "hoverIdleSeconds": "soon" } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.code == "type_error"));
}

#[test]
fn structural_session_keys_are_read_only() {
    for key in ["workspaces", "layouts", "docks", "workspaceDisplayOrder"] {
        let mut patch = serde_json::Map::new();
        patch.insert(key.to_string(), json!([]));
        let prepared = prepare_settings_update(&Settings::default(), &patch.into());
        assert!(!prepared.valid, "{key} must be read-only");
        assert!(prepared
            .errors
            .iter()
            .any(|issue| issue.code == "read_only"));
    }
}

#[test]
fn cloud_pairing_owned_fields_are_read_only() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "remote": { "cloudInstanceId": "manual" } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.code == "read_only" && issue.path == "/remote/cloudInstanceId"));
}

#[test]
fn remote_enable_requires_token_and_valid_allowlist() {
    let missing_token = prepare_settings_update(
        &Settings::default(),
        &json!({ "remote": { "enabled": true } }),
    );
    assert!(!missing_token.valid);
    assert!(missing_token
        .errors
        .iter()
        .any(|issue| issue.path == "/remote/authToken"));

    let bad_cidr = prepare_settings_update(
        &Settings::default(),
        &json!({
            "remote": {
                "enabled": true,
                "authToken": "secret",
                "allowedIps": ["127.0.0.1/999"]
            }
        }),
    );
    assert!(!bad_cidr.valid);
    assert!(bad_cidr
        .errors
        .iter()
        .any(|issue| issue.path == "/remote/allowedIps/0"));
}

#[test]
fn semantic_enum_and_range_errors_are_rejected() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({
            "language": "xx",
            "terminal": { "scrollbarStyle": "floating" },
            "profileDefaults": { "opacity": 9, "font": { "size": 100 } }
        }),
    );

    assert!(!prepared.valid);
    for path in [
        "/language",
        "/terminal/scrollbarStyle",
        "/profileDefaults/opacity",
        "/profileDefaults/font/size",
    ] {
        assert!(
            prepared.errors.iter().any(|issue| issue.path == path),
            "{path}"
        );
    }
}

#[test]
fn unknown_app_theme_is_rejected_instead_of_silently_falling_back() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "appearance": { "themeId": "not-a-theme" } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.path == "/appearance/themeId"));
}

#[test]
fn preexisting_semantic_issues_do_not_block_an_unrelated_patch() {
    let mut current = Settings::default();
    current.remote.heartbeat_timeout_seconds = 5;
    current
        .file_explorer
        .extension_viewers
        .push(laymux_lib::settings::ExtensionViewer {
            extensions: vec![".txt".into()],
            command: "vi".into(),
            profile: String::new(),
        });

    let prepared = prepare_settings_update(
        &current,
        &json!({ "appearance": { "themeId": "github-light" } }),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    assert!(prepared.errors.is_empty());
    assert!(prepared
        .existing_issues
        .iter()
        .any(|issue| issue.path == "/remote/heartbeatTimeoutSeconds"));
    assert!(prepared
        .existing_issues
        .iter()
        .any(|issue| issue.path == "/fileExplorer/extensionViewers/0/profile"));
}

#[test]
fn changing_a_preexisting_invalid_value_to_another_invalid_value_is_rejected() {
    let mut current = Settings::default();
    current.remote.heartbeat_timeout_seconds = 5;

    let prepared = prepare_settings_update(
        &current,
        &json!({ "remote": { "heartbeatTimeoutSeconds": 10 } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.path == "/remote/heartbeatTimeoutSeconds"));
}

#[test]
fn duplicate_profiles_and_bad_extension_viewer_reference_are_rejected() {
    let duplicate = prepare_settings_update(
        &Settings::default(),
        &json!({
            "profiles": [
                { "name": "Same", "commandLine": "a" },
                { "name": "Same", "commandLine": "b" }
            ],
            "defaultProfile": "Same"
        }),
    );
    assert!(!duplicate.valid);
    assert!(duplicate
        .errors
        .iter()
        .any(|issue| issue.code == "duplicate"));

    let bad_viewer = prepare_settings_update(
        &Settings::default(),
        &json!({
            "fileExplorer": {
                "extensionViewers": [
                    { "extensions": [".md"], "command": "vi", "profile": "Missing" }
                ]
            }
        }),
    );
    assert!(!bad_viewer.valid);
    assert!(bad_viewer
        .errors
        .iter()
        .any(|issue| issue.path == "/fileExplorer/extensionViewers/0/profile"));
}

#[test]
fn sensitive_value_is_redacted_from_reads_and_diffs() {
    let mut current = Settings::default();
    current.remote.auth_token = "old-secret".into();
    let redacted = redact_settings(&current);
    assert_eq!(
        redacted
            .pointer("/remote/authToken")
            .and_then(|v| v.as_str()),
        Some(REDACTED_SETTING_VALUE)
    );

    let prepared = prepare_settings_update(
        &current,
        &json!({ "remote": { "authToken": "new-secret" } }),
    );
    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let change = prepared
        .changes
        .iter()
        .find(|change| change.path == "/remote/authToken")
        .unwrap();
    assert_eq!(change.before, json!(REDACTED_SETTING_VALUE));
    assert_eq!(change.after, json!(REDACTED_SETTING_VALUE));
}

#[test]
fn redacted_token_sentinel_preserves_the_existing_secret() {
    let mut current = Settings::default();
    current.remote.auth_token = "existing-secret".into();

    let prepared = prepare_settings_update(
        &current,
        &json!({
            "remote": {
                "authToken": REDACTED_SETTING_VALUE,
                "heartbeatTimeoutSeconds": 60
            }
        }),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared.candidate.unwrap();
    assert_eq!(candidate.remote.auth_token, "existing-secret");
    assert!(!prepared
        .changes
        .iter()
        .any(|change| change.path == "/remote/authToken"));
}

#[test]
fn json_pointer_selection_returns_only_requested_values() {
    let mut settings = Settings::default();
    settings.remote.auth_token = "secret".into();
    let selected = select_settings_paths(
        &settings,
        &["/appearance/themeId".into(), "/remote/authToken".into()],
    )
    .unwrap();

    assert_eq!(selected["/appearance/themeId"], json!("catppuccin-mocha"));
    assert_eq!(selected["/remote/authToken"], json!(REDACTED_SETTING_VALUE));
    assert_eq!(selected.as_object().unwrap().len(), 2);
}

#[test]
fn describe_settings_exposes_schema_defaults_and_runtime_metadata() {
    let description =
        describe_settings(&["/remote/authToken".into(), "/appearance/themeId".into()])
            .expect("known paths");

    assert!(description.get("schema").is_some());
    assert_eq!(
        description["metadata"]["/remote/authToken"]["sensitive"],
        json!(true)
    );
    assert_eq!(
        description["metadata"]["/appearance/themeId"]["applyMode"],
        json!("live")
    );
    assert_eq!(
        description["defaults"]["/appearance/themeId"],
        json!("catppuccin-mocha")
    );
}

#[test]
fn describe_settings_supports_known_fields_omitted_from_serialized_defaults() {
    let description =
        describe_settings(&["/syncCwdDefaults".into(), "/workspaceDisplayOrder".into()])
            .expect("schema-known optional paths");

    assert_eq!(description["defaults"]["/syncCwdDefaults"], json!(null));
    assert_eq!(
        description["defaults"]["/workspaceDisplayOrder"],
        json!(null)
    );
    assert_eq!(
        description["metadata"]["/workspaceDisplayOrder"]["writable"],
        json!(false)
    );
}

#[test]
fn describe_settings_rejects_unknown_schema_paths() {
    let error = describe_settings(&["/appearance/notASetting".into()]).unwrap_err();
    assert!(error.contains("/appearance/notASetting"));
}

#[test]
fn revision_is_stable_and_changes_with_settings() {
    let first = Settings::default();
    let mut second = first.clone();
    second.appearance.theme_id = "github-light".into();

    assert_eq!(settings_revision(&first), settings_revision(&first));
    assert_ne!(settings_revision(&first), settings_revision(&second));
}

#[test]
fn revision_ignores_read_only_structural_and_cloud_runtime_state() {
    let first = Settings::default();
    let mut second = first.clone();
    second.workspaces[0].name = "Changed Structure".into();
    second.workspace_display_order = vec!["other".into()];
    second.remote.cloud_instance_id = Some("runtime-instance".into());

    assert_eq!(settings_revision(&first), settings_revision(&second));
}

#[test]
fn rust_settings_model_preserves_frontend_owned_fields() {
    let settings: Settings = serde_json::from_value(json!({
        "profileDefaults": {
            "cursorBlink": false,
            "stabilizeInteractiveCursor": false,
            "maxOutputCacheKB": 512
        },
        "profiles": [{
            "name": "Test",
            "commandLine": "pwsh.exe",
            "cursorBlink": false,
            "stabilizeInteractiveCursor": false
        }],
        "terminal": {
            "pathLinkEnabled": false,
            "pathLinkMaxLength": 1024,
            "showScrollToBottomButton": false
        }
    }))
    .unwrap();

    assert!(!settings.profile_defaults.cursor_blink);
    assert!(!settings.profile_defaults.stabilize_interactive_cursor);
    assert_eq!(settings.profile_defaults.max_output_cache_kb, 512);
    assert!(!settings.profiles[0].cursor_blink);
    assert!(!settings.profiles[0].stabilize_interactive_cursor);
    assert!(!settings.terminal.path_link_enabled);
    assert_eq!(settings.terminal.path_link_max_length, 1024);
    assert!(!settings.terminal.show_scroll_to_bottom_button);

    let serialized = serde_json::to_value(settings).unwrap();
    assert_eq!(serialized["profileDefaults"]["maxOutputCacheKB"], 512);
    assert_eq!(serialized["terminal"]["pathLinkMaxLength"], 1024);
}
