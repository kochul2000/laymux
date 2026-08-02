use laymux_lib::settings::contract::{
    describe_settings, metadata_for_path, prepare_settings_update, redact_settings,
    select_settings_paths, sensitive_settings_paths, settings_revision, ApplyMode,
    READ_ONLY_SETTINGS_PATHS, REDACTED_SETTING_VALUE,
};
use laymux_lib::settings::{Settings, WorkspaceClearBusyPolicy};
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
            "terminal": { "scrollbarStyle": "floating", "composerHistoryScope": "everything" },
            "profileDefaults": { "opacity": 9, "font": { "size": 100 } }
        }),
    );

    assert!(!prepared.valid);
    for path in [
        "/language",
        "/terminal/scrollbarStyle",
        // ADR-0055: an unknown sharing scope must be rejected, not silently
        // widened to a shared bucket.
        "/terminal/composerHistoryScope",
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
fn unknown_sleep_prevention_mode_is_rejected() {
    // A typo must not silently degrade to "off" — the user would believe the
    // machine is being kept awake while it sleeps through their build.
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "power": { "sleepPrevention": "sometimes" } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.path == "/power/sleepPrevention"));
}

#[test]
fn sleep_prevention_mode_is_a_live_change() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "power": { "sleepPrevention": "whenBusy" } }),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let change = prepared
        .changes
        .iter()
        .find(|change| change.path == "/power/sleepPrevention")
        .expect("sleepPrevention change");
    assert_eq!(change.apply_mode, ApplyMode::Live);
    assert!(!prepared.restart_required);
    assert!(!prepared.next_use_required);
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
fn remote_snapshot_max_kib_outside_range_is_rejected() {
    let too_small = prepare_settings_update(
        &Settings::default(),
        &json!({ "remote": { "snapshotMaxKib": 0 } }),
    );
    assert!(!too_small.valid);
    assert!(too_small
        .errors
        .iter()
        .any(|issue| issue.path == "/remote/snapshotMaxKib"));

    let too_large = prepare_settings_update(
        &Settings::default(),
        &json!({ "remote": { "snapshotMaxKib": 2048 } }),
    );
    assert!(!too_large.valid);
    assert!(too_large
        .errors
        .iter()
        .any(|issue| issue.path == "/remote/snapshotMaxKib"));

    let in_range = prepare_settings_update(
        &Settings::default(),
        &json!({ "remote": { "snapshotMaxKib": 64 } }),
    );
    assert!(in_range.valid, "errors: {:?}", in_range.errors);
}

#[test]
fn remote_snapshot_max_kib_defaults_to_four() {
    assert_eq!(Settings::default().remote.snapshot_max_kib, 4);
}

#[test]
fn exit_interrupt_defaults_are_off_and_conservative() {
    let defaults = Settings::default();
    assert!(
        !defaults.exit.interrupt_terminals,
        "kill-on-exit must be opt-in (default off)"
    );
    assert_eq!(defaults.exit.interrupt_rounds, 3);
    assert_eq!(defaults.exit.settle_ms, 700);
}

#[test]
fn exit_section_round_trips_through_patch() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "exit": { "interruptTerminals": true, "interruptRounds": 5, "settleMs": 1200 } }),
    );
    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared.candidate.unwrap();
    assert!(candidate.exit.interrupt_terminals);
    assert_eq!(candidate.exit.interrupt_rounds, 5);
    assert_eq!(candidate.exit.settle_ms, 1200);
}

#[test]
fn exit_out_of_range_values_are_rejected() {
    let too_many_rounds = prepare_settings_update(
        &Settings::default(),
        &json!({ "exit": { "interruptRounds": 0 } }),
    );
    assert!(!too_many_rounds.valid);
    assert!(too_many_rounds
        .errors
        .iter()
        .any(|issue| issue.path == "/exit/interruptRounds"));

    let settle_too_large = prepare_settings_update(
        &Settings::default(),
        &json!({ "exit": { "settleMs": 999999 } }),
    );
    assert!(!settle_too_large.valid);
    assert!(settle_too_large
        .errors
        .iter()
        .any(|issue| issue.path == "/exit/settleMs"));
}

#[test]
fn workspace_clear_accepts_a_valid_patch() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({
            "workspaceClear": {
                "shellCommand": "cls",
                "busyPolicy": "interrupt",
                "interruptRounds": 4,
                "settleMs": 900
            }
        }),
    );
    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared.candidate.unwrap();
    assert_eq!(candidate.workspace_clear.shell_command, "cls");
    assert_eq!(
        candidate.workspace_clear.busy_policy,
        WorkspaceClearBusyPolicy::Interrupt
    );
    assert_eq!(candidate.workspace_clear.interrupt_rounds, 4);
    assert_eq!(candidate.workspace_clear.settle_ms, 900);
}

/// Same ranges as `/exit`, which is the contract this reuses (ADR-0113). Before
/// `validate_workspace_clear` existed these patches were reported as valid and
/// the frontend quietly clamped them.
#[test]
fn workspace_clear_out_of_range_values_are_rejected() {
    let too_many_rounds = prepare_settings_update(
        &Settings::default(),
        &json!({ "workspaceClear": { "interruptRounds": 999 } }),
    );
    assert!(!too_many_rounds.valid);
    assert!(too_many_rounds
        .errors
        .iter()
        .any(|issue| issue.path == "/workspaceClear/interruptRounds"));

    let settle_too_large = prepare_settings_update(
        &Settings::default(),
        &json!({ "workspaceClear": { "settleMs": 999999 } }),
    );
    assert!(!settle_too_large.valid);
    assert!(settle_too_large
        .errors
        .iter()
        .any(|issue| issue.path == "/workspaceClear/settleMs"));
}

/// `busyPolicy` is an enum, so an unknown value fails at deserialization rather
/// than reaching the semantic pass — and the schema advertises the three names.
#[test]
fn workspace_clear_rejects_an_unknown_busy_policy() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "workspaceClear": { "busyPolicy": "nuke" } }),
    );
    assert!(!prepared.valid, "an unknown policy must not be accepted");

    let description = describe_settings(&["/workspaceClear".into()]).expect("known path");
    let schema = description.to_string();
    for policy in ["skip", "interrupt", "restart"] {
        assert!(
            schema.contains(policy),
            "schema must advertise '{policy}': {schema}"
        );
    }
}

#[test]
fn workspace_clear_metadata_is_live_applied() {
    let description = describe_settings(&["/workspaceClear".into()]).expect("known path");
    assert_eq!(
        description["metadata"]["/workspaceClear"]["applyMode"],
        json!("live")
    );
    assert_eq!(
        description["metadata"]["/workspaceClear"]["writable"],
        json!(true)
    );
}

#[test]
fn exit_metadata_is_live_applied() {
    let description = describe_settings(&["/exit".into()]).expect("known path");
    assert_eq!(description["metadata"]["/exit"]["applyMode"], json!("live"));
    assert_eq!(description["metadata"]["/exit"]["writable"], json!(true));
}

#[test]
fn truecolor_advertising_metadata_is_next_use() {
    let path = "/terminal/advertiseTrueColor";
    let description = describe_settings(&[path.into()]).expect("known path");
    assert_eq!(description["defaults"][path], json!(true));
    assert_eq!(description["metadata"][path]["applyMode"], json!("nextUse"));

    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "terminal": { "advertiseTrueColor": false } }),
    );
    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    assert!(prepared.next_use_required);
    assert!(!prepared.restart_required);
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
fn every_sensitive_metadata_path_is_redacted_from_settings_reads() {
    let sensitive_paths: Vec<_> = sensitive_settings_paths().collect();
    assert!(!sensitive_paths.is_empty());

    for path in sensitive_paths {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        *value
            .pointer_mut(path)
            .unwrap_or_else(|| panic!("sensitive path must exist in Settings: {path}")) =
            json!("secret");
        let settings: Settings = serde_json::from_value(value).unwrap();

        assert_eq!(
            redact_settings(&settings).pointer(path),
            Some(&json!(REDACTED_SETTING_VALUE)),
            "{path} must be redacted from full settings responses"
        );
    }
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
fn read_only_metadata_uses_the_revision_ignored_contract_paths() {
    for path in READ_ONLY_SETTINGS_PATHS {
        assert!(
            !metadata_for_path(path).writable,
            "{path} must be read-only in metadata"
        );
    }
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
            "showScrollToBottomButton": false,
            "composerAutocomplete": false,
            "pathLinkOsOpenConfirm": false
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
    // Issue #505: the autocomplete toggle round-trips like the other terminal leaves.
    assert!(!settings.terminal.composer_autocomplete);
    // ADR-0099: the OS-open confirmation can be relaxed explicitly, but the
    // feature toggle defaults on when omitted — neither may flip silently.
    assert!(!settings.terminal.path_link_os_open_confirm);
    assert!(settings.terminal.path_link_os_open_enabled);
    // Both composer recall toggles default on when omitted from the JSON above.
    assert!(settings.terminal.composer_history_popup);
    // ADR-0055: history sharing defaults to the whole app when omitted.
    assert_eq!(settings.terminal.composer_history_scope, "global");

    let serialized = serde_json::to_value(settings).unwrap();
    assert_eq!(serialized["profileDefaults"]["maxOutputCacheKB"], 512);
    assert_eq!(serialized["terminal"]["pathLinkMaxLength"], 1024);
    assert_eq!(serialized["terminal"]["pathLinkOsOpenConfirm"], false);
    assert_eq!(serialized["terminal"]["pathLinkOsOpenEnabled"], true);
}

#[test]
fn parser_admission_shares_default_to_five_three_two() {
    let defaults = Settings::default().terminal.parser_admission;
    assert_eq!(defaults.focused_share, 5);
    assert_eq!(defaults.visible_share, 3);
    assert_eq!(defaults.hidden_share, 2);

    // A file predating the knob keeps the defaults instead of pausing a class.
    let legacy: Settings = serde_json::from_str(r#"{ "terminal": {} }"#).unwrap();
    assert_eq!(legacy.terminal.parser_admission, defaults);
}

#[test]
fn parser_admission_shares_outside_range_are_rejected() {
    for (path, patch) in [
        (
            "/terminal/parserAdmission/focusedShare",
            json!({ "terminal": { "parserAdmission": { "focusedShare": 0 } } }),
        ),
        (
            "/terminal/parserAdmission/visibleShare",
            json!({ "terminal": { "parserAdmission": { "visibleShare": 1001 } } }),
        ),
        (
            // Zero would pause every hidden pane's parser, which the lossless
            // contract forbids (ADR-0101).
            "/terminal/parserAdmission/hiddenShare",
            json!({ "terminal": { "parserAdmission": { "hiddenShare": 0 } } }),
        ),
    ] {
        let prepared = prepare_settings_update(&Settings::default(), &patch);
        assert!(!prepared.valid, "{path} must be rejected");
        assert!(prepared.errors.iter().any(|issue| issue.path == path));
    }

    let in_range = prepare_settings_update(
        &Settings::default(),
        &json!({ "terminal": { "parserAdmission": { "focusedShare": 9, "visibleShare": 4, "hiddenShare": 1 } } }),
    );
    assert!(in_range.valid, "errors: {:?}", in_range.errors);
    let candidate = in_range
        .candidate
        .expect("valid update must have candidate");
    assert_eq!(candidate.terminal.parser_admission.focused_share, 9);
    assert_eq!(candidate.terminal.parser_admission.hidden_share, 1);
}

#[test]
fn parser_admission_sanitize_clamps_a_hand_edited_file() {
    let edited: Settings = serde_json::from_str(
        r#"{ "terminal": { "parserAdmission": { "focusedShare": 0, "visibleShare": 5000, "hiddenShare": 2 } } }"#,
    )
    .unwrap();
    let sanitized = edited.terminal.parser_admission.sanitized();

    assert_eq!(sanitized.focused_share, 1);
    assert_eq!(sanitized.visible_share, 1000);
    assert_eq!(sanitized.hidden_share, 2);
}

// --- Widget placement contract (ADR-0105) ---

fn widget_patch(instances: serde_json::Value) -> serde_json::Value {
    json!({ "widgets": { "topBar": { "left": instances } } })
}

#[test]
fn widget_placement_round_trips_with_its_options() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &widget_patch(json!([
            { "id": "w1", "type": "claudeUsage", "options": { "configDir": "", "display": "bar" } },
            { "id": "w2", "type": "cwd" }
        ])),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared.candidate.unwrap();
    let left = &candidate.widgets.top_bar.left;
    assert_eq!(left.len(), 2);
    assert_eq!(left[0].widget_type, "claudeUsage");
    assert_eq!(left[0].options["display"], json!("bar"));
    // An omitted `options` must arrive as an empty object, not null — the
    // frontend reads keys off it without a null guard.
    assert_eq!(left[1].options, json!({}));
}

#[test]
fn unknown_widget_type_is_rejected_on_write() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &widget_patch(json!([{ "id": "w1", "type": "notAWidget" }])),
    );

    assert!(!prepared.valid);
    assert!(prepared.errors.iter().any(|issue| {
        issue.code == "invalid_value" && issue.path == "/widgets/topBar/left/0/type"
    }));
}

#[test]
fn unknown_widget_type_already_on_disk_does_not_block_an_unrelated_patch() {
    // Loading must preserve a placement this build does not know: the write
    // path refuses new ones, but an existing one is the user's, not a defect
    // to repair away.
    let current: Settings = serde_json::from_str(
        r#"{ "widgets": { "topBar": { "left": [{ "id": "w1", "type": "fromTheFuture" }] } } }"#,
    )
    .unwrap();
    assert_eq!(current.widgets.top_bar.left.len(), 1);

    let prepared = prepare_settings_update(
        &current,
        &json!({ "appearance": { "font": { "size": 20 } } }),
    );

    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    assert!(prepared
        .existing_issues
        .iter()
        .any(|issue| issue.path == "/widgets/topBar/left/0/type"));
    assert_eq!(
        prepared.candidate.unwrap().widgets.top_bar.left[0].widget_type,
        "fromTheFuture"
    );
}

#[test]
fn duplicate_widget_id_across_slots_is_rejected() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "widgets": {
            "topBar": { "left": [{ "id": "dup", "type": "cwd" }] },
            "statusLine": { "right": [{ "id": "dup", "type": "notifications" }] }
        }}),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.code == "duplicate_value"
            && issue.path == "/widgets/statusLine/right/0/id"));
}

#[test]
fn widget_option_domains_are_validated() {
    let bad_display = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "codexUsage", "options": { "display": "sparkline" } }]),
        ),
    );
    assert!(!bad_display.valid);
    assert!(bad_display
        .errors
        .iter()
        .any(|issue| { issue.path == "/widgets/topBar/left/0/options/display" }));

    let bad_scope = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "terminalActivity", "options": { "scope": "galaxy" } }]),
        ),
    );
    assert!(!bad_scope.valid);
    assert!(bad_scope
        .errors
        .iter()
        .any(|issue| { issue.path == "/widgets/topBar/left/0/options/scope" }));
}

#[test]
fn widget_overflow_mode_is_validated() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "widgets": { "overflow": "hide" } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.path == "/widgets/overflow"));
}

#[test]
fn widgets_apply_live_and_are_writable() {
    let metadata = metadata_for_path("/widgets");
    assert!(metadata.writable);
    assert!(!metadata.sensitive);
    assert_eq!(
        metadata.apply_mode,
        laymux_lib::settings::contract::ApplyMode::Live
    );
}

#[test]
fn status_line_starts_off_with_empty_slots() {
    let widgets = Settings::default().widgets;
    assert!(!widgets.status_line.enabled);
    assert!(widgets.top_bar.left.is_empty());
    assert!(widgets.top_bar.right.is_empty());
    assert!(widgets.status_line.left.is_empty());
    assert!(widgets.status_line.right.is_empty());
    assert_eq!(widgets.overflow, "collapse");
    assert_eq!(widgets.font_family, "");
    assert_eq!(widgets.font_size, 9);
}

#[test]
fn widget_font_size_is_bounded() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &json!({ "widgets": { "fontFamily": "JetBrains Mono", "fontSize": 99 } }),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| { issue.code == "out_of_range" && issue.path == "/widgets/fontSize" }));
}

#[test]
fn widget_option_of_the_wrong_type_is_rejected_not_defaulted() {
    // Letting a non-string through would leave the frontend silently
    // substituting a default the caller never asked for.
    let prepared = prepare_settings_update(
        &Settings::default(),
        &widget_patch(json!([{ "id": "w1", "type": "codexUsage", "options": { "display": 3 } }])),
    );

    assert!(!prepared.valid);
    assert!(prepared.errors.iter().any(|issue| {
        issue.code == "type_error" && issue.path == "/widgets/topBar/left/0/options/display"
    }));
}

#[test]
fn widget_options_must_be_an_object() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &widget_patch(json!([{ "id": "w1", "type": "cwd", "options": 7 }])),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.path == "/widgets/topBar/left/0/options"));
}

#[test]
fn claude_usage_widget_may_only_name_a_registered_config_dir() {
    let unknown = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "claudeUsage", "options": { "configDir": "/nope" } }]),
        ),
    );
    assert!(!unknown.valid);
    assert!(unknown.errors.iter().any(|issue| {
        issue.code == "invalid_value" && issue.path == "/widgets/topBar/left/0/options/configDir"
    }));

    let registered = prepare_settings_update(
        &Settings::default(),
        &json!({
            "usage": { "claude": { "configDirs": ["/alt"] } },
            "widgets": { "topBar": { "left": [
                { "id": "w1", "type": "claudeUsage", "options": { "configDir": "/alt" } }
            ]}}
        }),
    );
    assert!(registered.valid, "errors: {:?}", registered.errors);
}

#[test]
fn empty_widget_id_is_rejected() {
    let prepared = prepare_settings_update(
        &Settings::default(),
        &widget_patch(json!([{ "id": "", "type": "cwd" }])),
    );

    assert!(!prepared.valid);
    assert!(prepared
        .errors
        .iter()
        .any(|issue| issue.code == "invalid_value" && issue.path == "/widgets/topBar/left/0/id"));
}

#[test]
fn usage_colors_are_owned_per_agent() {
    // Two providers on one status line are told apart by colour, so one agent's
    // palette must never follow the other's.
    let defaults = Settings::default();
    assert_eq!(defaults.usage.claude.colors.used, "#d97757");
    assert_eq!(defaults.usage.codex.colors.used, "#10a37f");
    assert_eq!(
        defaults.usage.claude.colors.pace,
        defaults.usage.codex.colors.pace
    );

    let prepared = prepare_settings_update(
        &defaults,
        &json!({ "usage": { "codex": { "colors": { "used": "#112233" } } } }),
    );
    assert!(prepared.valid, "errors: {:?}", prepared.errors);
    let candidate = prepared.candidate.unwrap();
    assert_eq!(candidate.usage.codex.colors.used, "#112233");
    assert_eq!(candidate.usage.claude.colors.used, "#d97757");
}

#[test]
fn usage_widget_bar_thickness_is_bounded() {
    let too_thick = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "claudeUsage", "options": { "barHeight": 99 } }]),
        ),
    );
    assert!(!too_thick.valid);
    assert!(too_thick.errors.iter().any(|issue| {
        issue.code == "out_of_range" && issue.path == "/widgets/topBar/left/0/options/barHeight"
    }));

    let not_a_number = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "codexUsage", "options": { "elapsedHeight": "thin" } }]),
        ),
    );
    assert!(!not_a_number.valid);
    assert!(not_a_number.errors.iter().any(|issue| {
        issue.code == "type_error" && issue.path == "/widgets/topBar/left/0/options/elapsedHeight"
    }));

    let ok = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "claudeUsage", "options": { "barHeight": 6, "elapsedHeight": 1 } }]),
        ),
    );
    assert!(ok.valid, "errors: {:?}", ok.errors);
}

#[test]
fn usage_widget_bar_width_is_bounded() {
    let too_wide = prepare_settings_update(
        &Settings::default(),
        &widget_patch(
            json!([{ "id": "w1", "type": "claudeUsage", "options": { "barWidth": 999 } }]),
        ),
    );
    assert!(!too_wide.valid);
    assert!(too_wide.errors.iter().any(|issue| {
        issue.code == "out_of_range" && issue.path == "/widgets/topBar/left/0/options/barWidth"
    }));

    let ok = prepare_settings_update(
        &Settings::default(),
        &widget_patch(json!([{ "id": "w1", "type": "codexUsage", "options": { "barWidth": 64 } }])),
    );
    assert!(ok.valid, "errors: {:?}", ok.errors);
}
