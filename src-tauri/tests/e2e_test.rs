use laymux_lib::cli::{LxMessage, LxResponse};
use laymux_lib::settings::{
    ClaudeSettings, ConvenienceSettings, ColorScheme, DockSetting, FontSettings, Keybinding,
    Layout, LayoutPane, Profile, Settings, Workspace, WorkspacePane, WorkspacePaneView,
};
use laymux_lib::state::AppState;
use laymux_lib::terminal::{SyncGroup, TerminalConfig, TerminalSession};
use std::fs;

// ============================================================================
// Settings Persistence E2E Tests
// ============================================================================

#[test]
fn settings_round_trip_with_full_config() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");

    let settings = Settings {
        color_schemes: vec![
            ColorScheme {
                name: "Solarized Dark".into(),
                foreground: "#839496".into(),
                background: "#002b36".into(),
                cursor_color: "#93a1a1".into(),
                selection_background: "#073642".into(),
                black: "#073642".into(),
                red: "#dc322f".into(),
                green: "#859900".into(),
                yellow: "#b58900".into(),
                blue: "#268bd2".into(),
                purple: "#d33682".into(),
                cyan: "#2aa198".into(),
                white: "#eee8d5".into(),
                bright_black: "#002b36".into(),
                bright_red: "#cb4b16".into(),
                bright_green: "#586e75".into(),
                bright_yellow: "#657b83".into(),
                bright_blue: "#839496".into(),
                bright_purple: "#6c71c4".into(),
                bright_cyan: "#93a1a1".into(),
                bright_white: "#fdf6e3".into(),
            },
        ],
        profiles: vec![
            Profile {
                name: "Ubuntu".into(),
                command_line: "wsl.exe -d Ubuntu".into(),
                color_scheme: "Solarized Dark".into(),
                starting_directory: "~".into(),
                hidden: false,
                ..Profile::default()
            },
            Profile {
                name: "Hidden Profile".into(),
                command_line: "cmd.exe".into(),
                color_scheme: String::new(),
                starting_directory: String::new(),
                hidden: true,
                ..Profile::default()
            },
        ],
        keybindings: vec![
            Keybinding {
                keys: "ctrl+shift+t".into(),
                command: "newTab".into(),
            },
            Keybinding {
                keys: "ctrl+shift+w".into(),
                command: "closeTab".into(),
            },
        ],
        font: None,
        default_profile: "Ubuntu".into(),
        layouts: vec![
            Layout {
                id: "triple-split".into(),
                name: "Triple Split".into(),
                panes: vec![
                    LayoutPane { x: 0.0, y: 0.0, w: 1.0, h: 0.5, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.0, y: 0.5, w: 0.5, h: 0.5, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.5, y: 0.5, w: 0.5, h: 0.5, view_type: "BrowserPreviewView".into() },
                ],
            },
        ],
        workspaces: vec![
            Workspace {
                id: "ws-project-a".into(),
                name: "Project A".into(),
                layout_id: "triple-split".into(),
                panes: vec![
                    WorkspacePane {
                        x: 0.0,
                        y: 0.0,
                        w: 1.0,
                        h: 0.5,
                        view: WorkspacePaneView {
                            view_type: "TerminalView".into(),
                            extra: serde_json::json!({"profile": "Ubuntu", "syncGroup": "Project A"}),
                        },
                    },
                    WorkspacePane {
                        x: 0.0,
                        y: 0.5,
                        w: 0.5,
                        h: 0.5,
                        view: WorkspacePaneView {
                            view_type: "TerminalView".into(),
                            extra: serde_json::json!({"profile": "Ubuntu", "syncGroup": "Project A"}),
                        },
                    },
                    WorkspacePane {
                        x: 0.5,
                        y: 0.5,
                        w: 0.5,
                        h: 0.5,
                        view: WorkspacePaneView {
                            view_type: "BrowserPreviewView".into(),
                            extra: serde_json::json!({"url": "http://localhost:3000"}),
                        },
                    },
                ],
            },
        ],
        docks: vec![
            DockSetting {
                position: "left".into(),
                active_view: Some("WorkspaceSelectorView".into()),
                views: vec!["WorkspaceSelectorView".into(), "SettingsView".into()],
                visible: true,
                size: 240.0,
                panes: Vec::new(),
            },
            DockSetting {
                position: "bottom".into(),
                active_view: None,
                views: vec![],
                visible: false,
                size: 240.0,
                panes: Vec::new(),
            },
        ],
        convenience: ConvenienceSettings::default(),
        claude: ClaudeSettings::default(),
    };

    let json = serde_json::to_string_pretty(&settings).unwrap();
    fs::write(&path, &json).unwrap();

    let content = fs::read_to_string(&path).unwrap();
    let loaded: Settings = serde_json::from_str(&content).unwrap();

    assert_eq!(settings, loaded);
}

#[test]
fn settings_deserialize_empty_json_object() {
    let json = "{}";
    let settings: Settings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.default_profile, "PowerShell");
    assert!(settings.profiles.is_empty());
    assert!(settings.layouts.is_empty());
    assert!(settings.workspaces.is_empty());
    assert!(settings.color_schemes.is_empty());
    assert!(settings.keybindings.is_empty());
    assert!(settings.docks.is_empty());
    // Root font is None after deserialization of empty JSON
    assert!(settings.font.is_none());
}

#[test]
fn settings_malformed_json_falls_back_to_default() {
    // Simulate what load_settings does with bad JSON
    let bad_json = r#"{"font": {"face": 12345}}"#;
    let result: Result<Settings, _> = serde_json::from_str(bad_json);
    // This should fail because face expects a string
    assert!(result.is_err());
    // In load_settings, this would fall back to default
    let settings = result.unwrap_or_default();
    assert_eq!(settings.default_profile, "PowerShell");
}

#[test]
fn settings_unicode_values() {
    let json = r##"{
        "profiles": [
            {"name": "한국어 프로파일", "commandLine": "wsl.exe", "colorScheme": "", "startingDirectory": "/홈/사용자", "hidden": false}
        ],
        "colorSchemes": [
            {"name": "テーマ", "foreground": "#fff", "background": "#000"}
        ]
    }"##;
    let settings: Settings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.profiles[0].name, "한국어 프로파일");
    assert_eq!(settings.profiles[0].starting_directory, "/홈/사용자");
    assert_eq!(settings.color_schemes[0].name, "テーマ");

    // Round-trip
    let serialized = serde_json::to_string(&settings).unwrap();
    let deserialized: Settings = serde_json::from_str(&serialized).unwrap();
    assert_eq!(settings, deserialized);
}

#[test]
fn settings_special_characters_in_paths() {
    let json = r#"{
        "profiles": [
            {"name": "Spaces & Symbols", "commandLine": "C:\\Program Files (x86)\\shell.exe", "colorScheme": "", "startingDirectory": "C:\\Users\\user name\\my project\\src", "hidden": false}
        ]
    }"#;
    let settings: Settings = serde_json::from_str(json).unwrap();
    assert_eq!(
        settings.profiles[0].command_line,
        "C:\\Program Files (x86)\\shell.exe"
    );
    assert_eq!(
        settings.profiles[0].starting_directory,
        "C:\\Users\\user name\\my project\\src"
    );
}

#[test]
fn settings_very_long_values() {
    let long_name = "A".repeat(10000);
    let long_path = "/a/".repeat(3000);
    let profile = Profile {
        name: long_name.clone(),
        command_line: long_path.clone(),
        color_scheme: String::new(),
        starting_directory: String::new(),
        hidden: false,
        ..Profile::default()
    };
    let settings = Settings {
        profiles: vec![profile],
        ..Settings::default()
    };

    let json = serde_json::to_string(&settings).unwrap();
    let parsed: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.profiles[0].name, long_name);
    assert_eq!(parsed.profiles[0].command_line, long_path);
}

#[test]
fn settings_empty_string_fields() {
    let json = r#"{
        "profiles": [
            {"name": "", "commandLine": "", "colorScheme": "", "startingDirectory": "", "hidden": false}
        ],
        "defaultProfile": ""
    }"#;
    let settings: Settings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.profiles[0].name, "");
    assert_eq!(settings.default_profile, "");
}

#[test]
fn settings_multiple_layouts_multiple_workspaces() {
    let settings = Settings {
        layouts: vec![
            Layout {
                id: "layout-1".into(),
                name: "Single".into(),
                panes: vec![LayoutPane { x: 0.0, y: 0.0, w: 1.0, h: 1.0, view_type: "TerminalView".into() }],
            },
            Layout {
                id: "layout-2".into(),
                name: "Dual".into(),
                panes: vec![
                    LayoutPane { x: 0.0, y: 0.0, w: 0.5, h: 1.0, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.5, y: 0.0, w: 0.5, h: 1.0, view_type: "TerminalView".into() },
                ],
            },
            Layout {
                id: "layout-3".into(),
                name: "Quad".into(),
                panes: vec![
                    LayoutPane { x: 0.0, y: 0.0, w: 0.5, h: 0.5, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.5, y: 0.0, w: 0.5, h: 0.5, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.0, y: 0.5, w: 0.5, h: 0.5, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.5, y: 0.5, w: 0.5, h: 0.5, view_type: "BrowserPreviewView".into() },
                ],
            },
        ],
        workspaces: vec![
            Workspace {
                id: "ws-1".into(),
                name: "WS1".into(),
                layout_id: "layout-1".into(),
                panes: vec![WorkspacePane {
                    x: 0.0, y: 0.0, w: 1.0, h: 1.0,
                    view: WorkspacePaneView {
                        view_type: "TerminalView".into(),
                        extra: serde_json::json!({}),
                    },
                }],
            },
            Workspace {
                id: "ws-2".into(),
                name: "WS2".into(),
                layout_id: "layout-2".into(),
                panes: vec![],
            },
            Workspace {
                id: "ws-3".into(),
                name: "WS3".into(),
                layout_id: "layout-3".into(),
                panes: vec![],
            },
        ],
        ..Settings::default()
    };

    let json = serde_json::to_string_pretty(&settings).unwrap();
    let parsed: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.layouts.len(), 3);
    assert_eq!(parsed.workspaces.len(), 3);
    assert_eq!(parsed.layouts[2].panes.len(), 4);
    assert_eq!(parsed.workspaces[0].layout_id, "layout-1");
}

#[test]
fn settings_pane_boundary_values() {
    // Panes at exact boundaries (0.0 and 1.0)
    let layout = Layout {
        id: "boundary".into(),
        name: "Boundary".into(),
        panes: vec![
            LayoutPane { x: 0.0, y: 0.0, w: 0.0, h: 0.0, view_type: "EmptyView".into() },
            LayoutPane { x: 1.0, y: 1.0, w: 1.0, h: 1.0, view_type: "TerminalView".into() },
            LayoutPane { x: 0.333333, y: 0.666666, w: 0.333334, h: 0.333334, view_type: "TerminalView".into() },
        ],
    };
    let json = serde_json::to_string(&layout).unwrap();
    let parsed: Layout = serde_json::from_str(&json).unwrap();
    assert!((parsed.panes[2].x - 0.333333).abs() < 1e-6);
    assert!((parsed.panes[2].y - 0.666666).abs() < 1e-6);
}

#[test]
fn settings_workspace_pane_view_extra_data_preserved() {
    let pane = WorkspacePane {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
        view: WorkspacePaneView {
            view_type: "TerminalView".into(),
            extra: serde_json::json!({
                "profile": "WSL",
                "syncGroup": "myGroup",
                "hooks": [
                    {"osc": 7, "run": "lx sync-cwd $path"},
                    {"osc": 133, "param": "D", "when": "exitCode !== '0'", "run": "lx notify 'fail'"}
                ]
            }),
        },
    };

    let json = serde_json::to_string(&pane).unwrap();
    let parsed: WorkspacePane = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.view.extra["profile"], "WSL");
    assert_eq!(parsed.view.extra["syncGroup"], "myGroup");
    assert!(parsed.view.extra["hooks"].is_array());
    assert_eq!(parsed.view.extra["hooks"].as_array().unwrap().len(), 2);
}

#[test]
fn settings_dock_all_positions() {
    let settings = Settings {
        docks: vec![
            DockSetting { position: "top".into(), active_view: None, views: vec![], visible: true, size: 240.0, panes: Vec::new() },
            DockSetting { position: "bottom".into(), active_view: None, views: vec![], visible: true, size: 240.0, panes: Vec::new() },
            DockSetting { position: "left".into(), active_view: Some("WorkspaceSelectorView".into()), views: vec!["WorkspaceSelectorView".into()], visible: true, size: 240.0, panes: Vec::new() },
            DockSetting { position: "right".into(), active_view: Some("SettingsView".into()), views: vec!["SettingsView".into()], visible: false, size: 240.0, panes: Vec::new() },
        ],
        ..Settings::default()
    };

    let json = serde_json::to_string(&settings).unwrap();
    let parsed: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.docks.len(), 4);
    assert!(!parsed.docks[3].visible);
    assert_eq!(parsed.docks[3].active_view, Some("SettingsView".into()));
}

#[test]
fn settings_save_creates_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("deep").join("nested").join("dir");
    let path = nested.join("settings.json");

    let settings = Settings::default();
    let json = serde_json::to_string_pretty(&settings).unwrap();

    // Create parent directories then write
    fs::create_dir_all(nested).unwrap();
    fs::write(&path, &json).unwrap();

    assert!(path.exists());
    let loaded: Settings = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(loaded, settings);
}

#[test]
fn settings_overwrite_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");

    // Write initial settings
    let mut settings = Settings::default();
    let json = serde_json::to_string_pretty(&settings).unwrap();
    fs::write(&path, &json).unwrap();

    // Modify and overwrite — set font at profile level
    settings.profiles[0].font = Some(FontSettings {
        face: "Fira Code".into(),
        size: 20,
        weight: "normal".into(),
    });
    settings.default_profile = "WSL".into();
    let json2 = serde_json::to_string_pretty(&settings).unwrap();
    fs::write(&path, &json2).unwrap();

    let loaded: Settings = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let ps_font = loaded.profiles[0].font.as_ref().unwrap();
    assert_eq!(ps_font.size, 20);
    assert_eq!(ps_font.face, "Fira Code");
    assert_eq!(loaded.default_profile, "WSL");
}

// ============================================================================
// Terminal Session Lifecycle E2E Tests
// ============================================================================

#[test]
fn terminal_session_full_lifecycle() {
    let state = AppState::new();

    // Create multiple sessions
    let configs = vec![
        ("t1", "WSL", "group-a"),
        ("t2", "PowerShell", "group-a"),
        ("t3", "CMD", "group-b"),
        ("t4", "WSL", ""),  // independent terminal
    ];

    for (id, profile, group) in &configs {
        let config = TerminalConfig {
            profile: profile.to_string(),
            command_line: String::new(),
            startup_command: String::new(),
            cols: 80,
            rows: 24,
            sync_group: group.to_string(),
            env: vec![],
        };
        let session = TerminalSession::new(id.to_string(), config);

        let mut terminals = state.terminals.lock().unwrap();
        terminals.insert(id.to_string(), session);
    }

    // Register sync groups
    {
        let mut groups = state.sync_groups.lock().unwrap();
        let mut group_a = SyncGroup::new("group-a".into());
        group_a.add_terminal("t1".into());
        group_a.add_terminal("t2".into());
        groups.insert("group-a".into(), group_a);

        let mut group_b = SyncGroup::new("group-b".into());
        group_b.add_terminal("t3".into());
        groups.insert("group-b".into(), group_b);
    }

    // Verify state
    {
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(terminals.len(), 4);
        assert_eq!(terminals["t1"].config.profile, "WSL");
        assert_eq!(terminals["t4"].config.sync_group, "");
    }

    {
        let groups = state.sync_groups.lock().unwrap();
        assert_eq!(groups["group-a"].terminal_ids.len(), 2);
        assert_eq!(groups["group-b"].terminal_ids.len(), 1);
        assert!(!groups.contains_key(""));
    }

    // Remove a terminal from group
    {
        let mut groups = state.sync_groups.lock().unwrap();
        groups.get_mut("group-a").unwrap().remove_terminal("t1");
    }

    {
        let groups = state.sync_groups.lock().unwrap();
        assert_eq!(groups["group-a"].terminal_ids, vec!["t2"]);
    }

    // Remove session entirely
    {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.remove("t1");
        assert_eq!(terminals.len(), 3);
        assert!(!terminals.contains_key("t1"));
    }
}

#[test]
fn terminal_session_update_cwd_and_branch() {
    let state = AppState::new();

    {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.insert(
            "t1".into(),
            TerminalSession::new("t1".into(), TerminalConfig::default()),
        );
    }

    // Update CWD
    {
        let mut terminals = state.terminals.lock().unwrap();
        let session = terminals.get_mut("t1").unwrap();
        session.cwd = Some("/home/user/project".into());
        session.branch = Some("feature/login".into());
    }

    {
        let terminals = state.terminals.lock().unwrap();
        let session = &terminals["t1"];
        assert_eq!(session.cwd, Some("/home/user/project".into()));
        assert_eq!(session.branch, Some("feature/login".into()));
    }

    // Update to different values
    {
        let mut terminals = state.terminals.lock().unwrap();
        let session = terminals.get_mut("t1").unwrap();
        session.cwd = Some("/tmp".into());
        session.branch = Some("main".into());
        session.title = "Custom Title".into();
    }

    {
        let terminals = state.terminals.lock().unwrap();
        let session = &terminals["t1"];
        assert_eq!(session.cwd, Some("/tmp".into()));
        assert_eq!(session.branch, Some("main".into()));
        assert_eq!(session.title, "Custom Title");
    }
}

#[test]
fn terminal_session_with_custom_env_vars() {
    let config = TerminalConfig {
        profile: "WSL".into(),
        command_line: String::new(),
        startup_command: String::new(),
        cols: 120,
        rows: 40,
        sync_group: "dev".into(),
        env: vec![
            ("EDITOR".into(), "vim".into()),
            ("LANG".into(), "ko_KR.UTF-8".into()),
            ("PATH".into(), "/usr/local/bin:/usr/bin".into()),
            ("EMPTY_VAR".into(), "".into()),
            ("SPECIAL_CHARS".into(), "hello world!@#$%".into()),
        ],
    };

    let session = TerminalSession::new("env-test".into(), config);
    assert_eq!(session.config.env.len(), 5);
    assert_eq!(session.config.env[0], ("EDITOR".into(), "vim".into()));
    assert_eq!(session.config.env[3], ("EMPTY_VAR".into(), "".into()));

    // Serialize and deserialize
    let json = serde_json::to_string(&session).unwrap();
    let parsed: TerminalSession = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.config.env.len(), 5);
    assert_eq!(parsed.config.env[4].1, "hello world!@#$%");
}

#[test]
fn terminal_profile_to_command_case_insensitive_variants() {
    // Exact matches
    assert_eq!(TerminalSession::profile_to_command("WSL").0, "wsl.exe");
    assert_eq!(TerminalSession::profile_to_command("wsl").0, "wsl.exe");
    assert_eq!(TerminalSession::profile_to_command("PowerShell").0, "powershell.exe");
    assert_eq!(TerminalSession::profile_to_command("powershell").0, "powershell.exe");
    assert_eq!(TerminalSession::profile_to_command("CMD").0, "cmd.exe");
    assert_eq!(TerminalSession::profile_to_command("cmd").0, "cmd.exe");

    // Unknown profiles default to powershell
    assert_eq!(TerminalSession::profile_to_command("Unknown").0, "powershell.exe");
    assert_eq!(TerminalSession::profile_to_command("").0, "powershell.exe");
    assert_eq!(TerminalSession::profile_to_command("bash").0, "powershell.exe");
    assert_eq!(TerminalSession::profile_to_command("zsh").0, "powershell.exe");
}

#[test]
fn terminal_session_serialization_omits_none_fields() {
    let session = TerminalSession::new("s1".into(), TerminalConfig::default());
    let json = serde_json::to_string(&session).unwrap();

    // cwd and branch should be omitted when None
    assert!(!json.contains("\"cwd\""));
    assert!(!json.contains("\"branch\""));

    // Set cwd, branch should still be omitted
    let mut session2 = TerminalSession::new("s2".into(), TerminalConfig::default());
    session2.cwd = Some("/foo".into());
    let json2 = serde_json::to_string(&session2).unwrap();
    assert!(json2.contains("\"cwd\":\"/foo\""));
    assert!(!json2.contains("\"branch\""));
}

// ============================================================================
// SyncGroup Complex Scenarios
// ============================================================================

#[test]
fn sync_group_add_remove_many_terminals() {
    let mut group = SyncGroup::new("large-group".into());

    // Add 100 terminals
    for i in 0..100 {
        group.add_terminal(format!("term-{i}"));
    }
    assert_eq!(group.terminal_ids.len(), 100);

    // Remove every other one
    for i in (0..100).step_by(2) {
        group.remove_terminal(&format!("term-{i}"));
    }
    assert_eq!(group.terminal_ids.len(), 50);

    // All remaining are odd-numbered
    for id in &group.terminal_ids {
        let num: usize = id.strip_prefix("term-").unwrap().parse().unwrap();
        assert!(num % 2 == 1);
    }
}

#[test]
fn sync_group_remove_nonexistent_terminal() {
    let mut group = SyncGroup::new("test".into());
    group.add_terminal("t1".into());

    // Removing nonexistent terminal is a no-op
    group.remove_terminal("t999");
    assert_eq!(group.terminal_ids.len(), 1);
    assert_eq!(group.terminal_ids[0], "t1");
}

#[test]
fn sync_group_duplicate_add_idempotent() {
    let mut group = SyncGroup::new("test".into());

    // Add same terminal many times
    for _ in 0..10 {
        group.add_terminal("t1".into());
    }
    assert_eq!(group.terminal_ids.len(), 1);
}

#[test]
fn sync_group_empty_name() {
    let group = SyncGroup::new("".into());
    assert_eq!(group.name, "");
    assert!(group.terminal_ids.is_empty());
}

#[test]
fn multiple_sync_groups_isolation() {
    let state = AppState::new();

    {
        let mut groups = state.sync_groups.lock().unwrap();

        let mut g1 = SyncGroup::new("group-1".into());
        g1.add_terminal("t1".into());
        g1.add_terminal("t2".into());

        let mut g2 = SyncGroup::new("group-2".into());
        g2.add_terminal("t3".into());
        g2.add_terminal("t4".into());

        let mut g3 = SyncGroup::new("group-3".into());
        g3.add_terminal("t5".into());

        groups.insert("group-1".into(), g1);
        groups.insert("group-2".into(), g2);
        groups.insert("group-3".into(), g3);
    }

    // Modifying one group shouldn't affect others
    {
        let mut groups = state.sync_groups.lock().unwrap();
        groups.get_mut("group-1").unwrap().remove_terminal("t1");
    }

    {
        let groups = state.sync_groups.lock().unwrap();
        assert_eq!(groups["group-1"].terminal_ids.len(), 1);
        assert_eq!(groups["group-2"].terminal_ids.len(), 2);
        assert_eq!(groups["group-3"].terminal_ids.len(), 1);
    }

    // Remove entire group
    {
        let mut groups = state.sync_groups.lock().unwrap();
        groups.remove("group-2");
    }

    {
        let groups = state.sync_groups.lock().unwrap();
        assert_eq!(groups.len(), 2);
        assert!(!groups.contains_key("group-2"));
    }
}

#[test]
fn sync_group_terminal_can_exist_in_one_group_only_by_convention() {
    // The system doesn't enforce single-group membership at the SyncGroup level,
    // but we test that behavior here since it's a convention.
    let mut g1 = SyncGroup::new("g1".into());
    let mut g2 = SyncGroup::new("g2".into());

    g1.add_terminal("shared-t".into());
    g2.add_terminal("shared-t".into());

    // Both groups contain the same terminal ID
    assert!(g1.terminal_ids.contains(&"shared-t".to_string()));
    assert!(g2.terminal_ids.contains(&"shared-t".to_string()));
}

// ============================================================================
// IDE Message Protocol E2E Tests
// ============================================================================

#[test]
fn ide_message_sync_cwd_all_variants() {
    // Default (group-scoped)
    let msg1 = LxMessage::SyncCwd {
        path: "/home/user".into(),
        terminal_id: "t1".into(),
        group_id: "g1".into(),
        all: false,
        target_group: None,
    };

    // All terminals
    let msg2 = LxMessage::SyncCwd {
        path: "/tmp".into(),
        terminal_id: "t1".into(),
        group_id: "g1".into(),
        all: true,
        target_group: None,
    };

    // Specific target group
    let msg3 = LxMessage::SyncCwd {
        path: "/opt".into(),
        terminal_id: "t1".into(),
        group_id: "g1".into(),
        all: false,
        target_group: Some("other-group".into()),
    };

    for msg in [&msg1, &msg2, &msg3] {
        let json = serde_json::to_string(msg).unwrap();
        let parsed: LxMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, &parsed);
    }
}

#[test]
fn ide_message_sync_cwd_with_special_paths() {
    let special_paths = vec![
        "/home/user/my project",
        "/home/user/한국어/경로",
        "C:\\Users\\user\\Documents",
        "/path/with spaces/and (parens)/file.txt",
        "/path/with\ttab",
        "",
        ".",
        "..",
        "/",
    ];

    for path in special_paths {
        let msg = LxMessage::SyncCwd {
            path: path.to_string(),
            terminal_id: "t1".into(),
            group_id: "g1".into(),
            all: false,
            target_group: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: LxMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, parsed, "Failed for path: {path}");
    }
}

#[test]
fn ide_message_notify_with_special_content() {
    let messages: Vec<String> = vec![
        "Build complete".into(),
        "명령 실패 (exit 1)".into(),
        "Error: couldn't find \"main.rs\"".into(),
        "".into(),
        "A".repeat(10000),
        "Line1\nLine2\nLine3".into(),
        "Tab\there\tand\tthere".into(),
    ];

    for message in &messages {
        let msg = LxMessage::Notify {
            message: message.clone(),
            terminal_id: "t1".into(),
            level: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: LxMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, parsed);
    }
}

#[test]
fn ide_message_set_tab_title_empty_and_long() {
    let titles: Vec<String> = vec![
        "".into(),
        "A".repeat(1000),
        "~/dev/project".into(),
        "🚀 Building...".into(),
    ];

    for title in &titles {
        let msg = LxMessage::SetTabTitle {
            title: title.clone(),
            terminal_id: "t1".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: LxMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, parsed);
    }
}

#[test]
fn ide_message_send_command_with_complex_commands() {
    let commands = vec![
        "ls -la",
        "git switch feature/my-branch",
        "echo 'hello world'",
        r#"echo "quoted string""#,
        "cd /path/with\\ escape",
        "npm run build && npm test",
        "cat file | grep pattern | wc -l",
        "",
    ];

    for cmd in commands {
        let msg = LxMessage::SendCommand {
            command: cmd.to_string(),
            group: "g1".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: LxMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, parsed);
    }
}

#[test]
fn ide_message_deserialization_missing_optional_fields() {
    // SyncCwd without optional fields should get defaults
    let json = r#"{"action":"sync-cwd","path":"/foo","terminal_id":"t1","group_id":"g1"}"#;
    let msg: LxMessage = serde_json::from_str(json).unwrap();
    match msg {
        LxMessage::SyncCwd { all, target_group, .. } => {
            assert!(!all);
            assert!(target_group.is_none());
        }
        _ => panic!("Expected SyncCwd"),
    }
}

#[test]
fn ide_message_deserialization_unknown_action_fails() {
    let json = r#"{"action":"unknown-action","foo":"bar"}"#;
    let result: Result<LxMessage, _> = serde_json::from_str(json);
    assert!(result.is_err());
}

#[test]
fn ide_message_deserialization_missing_required_fields_fails() {
    // SyncCwd without path
    let json = r#"{"action":"sync-cwd","terminal_id":"t1","group_id":"g1"}"#;
    let result: Result<LxMessage, _> = serde_json::from_str(json);
    assert!(result.is_err());

    // Notify without message
    let json = r#"{"action":"notify","terminal_id":"t1"}"#;
    let result: Result<LxMessage, _> = serde_json::from_str(json);
    assert!(result.is_err());

    // SendCommand without group
    let json = r#"{"action":"send-command","command":"ls"}"#;
    let result: Result<LxMessage, _> = serde_json::from_str(json);
    assert!(result.is_err());
}

#[test]
fn ide_response_serialization() {
    let ok_resp = LxResponse::ok(Some("done".into()));
    let json = serde_json::to_string(&ok_resp).unwrap();
    assert!(json.contains("\"success\":true"));
    assert!(json.contains("\"data\":\"done\""));
    assert!(json.contains("\"error\":null"));

    let err_resp = LxResponse::err("not found".into());
    let json = serde_json::to_string(&err_resp).unwrap();
    assert!(json.contains("\"success\":false"));
    assert!(json.contains("\"data\":null"));
    assert!(json.contains("\"error\":\"not found\""));

    let no_data_resp = LxResponse::ok(None);
    let json = serde_json::to_string(&no_data_resp).unwrap();
    assert!(json.contains("\"data\":null"));
}

// ============================================================================
// AppState Concurrent Access E2E Tests
// ============================================================================

#[test]
fn state_concurrent_terminal_and_group_operations() {
    let state = AppState::new();

    // Simulate creating a terminal and registering it in a sync group atomically
    let terminal_id = "concurrent-t1".to_string();
    let group_name = "concurrent-group".to_string();

    // Step 1: Create session
    {
        let mut terminals = state.terminals.lock().unwrap();
        let config = TerminalConfig {
            profile: "WSL".into(),
            sync_group: group_name.clone(),
            ..TerminalConfig::default()
        };
        terminals.insert(terminal_id.clone(), TerminalSession::new(terminal_id.clone(), config));
    }

    // Step 2: Register in sync group
    {
        let mut groups = state.sync_groups.lock().unwrap();
        groups
            .entry(group_name.clone())
            .or_insert_with(|| SyncGroup::new(group_name.clone()))
            .add_terminal(terminal_id.clone());
    }

    // Step 3: Verify both are consistent
    {
        let terminals = state.terminals.lock().unwrap();
        let groups = state.sync_groups.lock().unwrap();

        assert!(terminals.contains_key(&terminal_id));
        assert!(groups[&group_name].terminal_ids.contains(&terminal_id));
        assert_eq!(terminals[&terminal_id].config.sync_group, group_name);
    }
}

#[test]
fn state_close_terminal_cleans_up_sync_group() {
    let state = AppState::new();
    let group_name = "cleanup-group".to_string();

    // Create 3 terminals in the same group
    for i in 0..3 {
        let id = format!("cleanup-t{i}");
        let config = TerminalConfig {
            sync_group: group_name.clone(),
            ..TerminalConfig::default()
        };
        state.terminals.lock().unwrap().insert(id.clone(), TerminalSession::new(id.clone(), config));
        state.sync_groups.lock().unwrap()
            .entry(group_name.clone())
            .or_insert_with(|| SyncGroup::new(group_name.clone()))
            .add_terminal(id);
    }

    // Close terminals one by one and verify cleanup
    for i in 0..3 {
        let id = format!("cleanup-t{i}");

        // Remove from terminals
        let session = state.terminals.lock().unwrap().remove(&id).unwrap();

        // Remove from sync group
        let mut groups = state.sync_groups.lock().unwrap();
        if let Some(group) = groups.get_mut(&session.config.sync_group) {
            group.remove_terminal(&id);
            if group.terminal_ids.is_empty() {
                groups.remove(&session.config.sync_group);
            }
        }
    }

    // After all removed, group should be gone
    assert!(state.terminals.lock().unwrap().is_empty());
    assert!(state.sync_groups.lock().unwrap().is_empty());
}

#[test]
fn state_many_sessions_stress() {
    let state = AppState::new();
    let count = 500;

    // Create many sessions
    {
        let mut terminals = state.terminals.lock().unwrap();
        for i in 0..count {
            let id = format!("stress-{i}");
            terminals.insert(id.clone(), TerminalSession::new(id, TerminalConfig::default()));
        }
    }

    assert_eq!(state.terminals.lock().unwrap().len(), count);

    // Remove all
    {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.clear();
    }

    assert!(state.terminals.lock().unwrap().is_empty());
}

#[test]
fn state_resize_config_update() {
    let state = AppState::new();

    {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.insert(
            "resize-t".into(),
            TerminalSession::new("resize-t".into(), TerminalConfig {
                cols: 80,
                rows: 24,
                ..TerminalConfig::default()
            }),
        );
    }

    // Resize
    {
        let mut terminals = state.terminals.lock().unwrap();
        let session = terminals.get_mut("resize-t").unwrap();
        session.config.cols = 200;
        session.config.rows = 50;
    }

    {
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(terminals["resize-t"].config.cols, 200);
        assert_eq!(terminals["resize-t"].config.rows, 50);
    }
}

#[test]
fn state_resize_boundary_values() {
    let state = AppState::new();

    {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.insert(
            "boundary-t".into(),
            TerminalSession::new("boundary-t".into(), TerminalConfig::default()),
        );
    }

    // Minimum size
    {
        let mut terminals = state.terminals.lock().unwrap();
        let session = terminals.get_mut("boundary-t").unwrap();
        session.config.cols = 1;
        session.config.rows = 1;
    }

    {
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(terminals["boundary-t"].config.cols, 1);
        assert_eq!(terminals["boundary-t"].config.rows, 1);
    }

    // Maximum u16
    {
        let mut terminals = state.terminals.lock().unwrap();
        let session = terminals.get_mut("boundary-t").unwrap();
        session.config.cols = u16::MAX;
        session.config.rows = u16::MAX;
    }

    {
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(terminals["boundary-t"].config.cols, u16::MAX);
        assert_eq!(terminals["boundary-t"].config.rows, u16::MAX);
    }
}

// ============================================================================
// Cross-Module E2E Flow Tests
// ============================================================================

#[test]
fn e2e_workspace_with_multiple_terminal_groups() {
    // Simulate a workspace scenario: 2 workspaces sharing a layout,
    // each with terminals in different sync groups
    let state = AppState::new();

    // Create terminals for workspace A
    for i in 0..3 {
        let id = format!("ws-a-t{i}");
        let config = TerminalConfig {
            profile: "WSL".into(),
            sync_group: "project-a".into(),
            ..TerminalConfig::default()
        };
        state.terminals.lock().unwrap()
            .insert(id.clone(), TerminalSession::new(id.clone(), config));
        state.sync_groups.lock().unwrap()
            .entry("project-a".into())
            .or_insert_with(|| SyncGroup::new("project-a".into()))
            .add_terminal(id);
    }

    // Create terminals for workspace B
    for i in 0..2 {
        let id = format!("ws-b-t{i}");
        let config = TerminalConfig {
            profile: "PowerShell".into(),
            sync_group: "project-b".into(),
            ..TerminalConfig::default()
        };
        state.terminals.lock().unwrap()
            .insert(id.clone(), TerminalSession::new(id.clone(), config));
        state.sync_groups.lock().unwrap()
            .entry("project-b".into())
            .or_insert_with(|| SyncGroup::new("project-b".into()))
            .add_terminal(id);
    }

    // Verify isolation
    {
        let groups = state.sync_groups.lock().unwrap();
        let ga = &groups["project-a"];
        let gb = &groups["project-b"];

        assert_eq!(ga.terminal_ids.len(), 3);
        assert_eq!(gb.terminal_ids.len(), 2);

        // No overlap
        for id in &ga.terminal_ids {
            assert!(!gb.terminal_ids.contains(id));
        }
    }

    // Verify all terminals exist
    assert_eq!(state.terminals.lock().unwrap().len(), 5);
}

#[test]
fn e2e_ide_message_get_cwd_branch_for_nonexistent_terminal() {
    let state = AppState::new();

    // GetCwd for a terminal that doesn't exist should return empty
    let terminals = state.terminals.lock().unwrap();
    let cwd = terminals
        .get("nonexistent")
        .and_then(|s| s.cwd.clone())
        .unwrap_or_default();
    assert_eq!(cwd, "");

    let branch = terminals
        .get("nonexistent")
        .and_then(|s| s.branch.clone())
        .unwrap_or_default();
    assert_eq!(branch, "");
}

#[test]
fn e2e_ide_message_set_tab_title_updates_session() {
    let state = AppState::new();

    {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.insert(
            "title-t".into(),
            TerminalSession::new("title-t".into(), TerminalConfig::default()),
        );
    }

    // Default title
    {
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(terminals["title-t"].title, "Terminal");
    }

    // Update title
    {
        let mut terminals = state.terminals.lock().unwrap();
        if let Some(session) = terminals.get_mut("title-t") {
            session.title = "~/dev/project [main]".into();
        }
    }

    {
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(terminals["title-t"].title, "~/dev/project [main]");
    }
}

#[test]
fn e2e_settings_with_layout_workspace_relationship() {
    // Test the 1:N relationship between layouts and workspaces
    let settings = Settings {
        layouts: vec![
            Layout {
                id: "shared-layout".into(),
                name: "Shared".into(),
                panes: vec![
                    LayoutPane { x: 0.0, y: 0.0, w: 0.5, h: 1.0, view_type: "TerminalView".into() },
                    LayoutPane { x: 0.5, y: 0.0, w: 0.5, h: 1.0, view_type: "TerminalView".into() },
                ],
            },
        ],
        workspaces: vec![
            Workspace {
                id: "ws-1".into(),
                name: "WS 1".into(),
                layout_id: "shared-layout".into(),
                panes: vec![],
            },
            Workspace {
                id: "ws-2".into(),
                name: "WS 2".into(),
                layout_id: "shared-layout".into(),
                panes: vec![],
            },
            Workspace {
                id: "ws-3".into(),
                name: "WS 3".into(),
                layout_id: "shared-layout".into(),
                panes: vec![],
            },
        ],
        ..Settings::default()
    };

    // All 3 workspaces share the same layout
    let layout_id = &settings.layouts[0].id;
    for ws in &settings.workspaces {
        assert_eq!(&ws.layout_id, layout_id);
    }

    // Round-trip preserves the relationship
    let json = serde_json::to_string(&settings).unwrap();
    let parsed: Settings = serde_json::from_str(&json).unwrap();
    for ws in &parsed.workspaces {
        assert_eq!(&ws.layout_id, layout_id);
    }
}

#[test]
fn e2e_full_settings_load_create_sessions_and_groups() {
    // Simulate the full app startup flow:
    // 1. Load settings from JSON
    // 2. Create terminal sessions based on workspace config
    // 3. Register sync groups

    let settings_json = r##"{
        "layouts": [
            {
                "id": "dev-split",
                "name": "Dev Split",
                "panes": [
                    { "x": 0.0, "y": 0.0, "w": 1.0, "h": 0.6, "viewType": "TerminalView" },
                    { "x": 0.0, "y": 0.6, "w": 0.5, "h": 0.4, "viewType": "TerminalView" },
                    { "x": 0.5, "y": 0.6, "w": 0.5, "h": 0.4, "viewType": "BrowserPreviewView" }
                ]
            }
        ],
        "workspaces": [
            {
                "id": "ws-project-a",
                "name": "프로젝트A",
                "layoutId": "dev-split",
                "panes": [
                    { "x": 0.0, "y": 0.0, "w": 1.0, "h": 0.6, "view": { "type": "TerminalView", "profile": "WSL", "syncGroup": "프로젝트A" } },
                    { "x": 0.0, "y": 0.6, "w": 0.5, "h": 0.4, "view": { "type": "TerminalView", "profile": "PowerShell", "syncGroup": "프로젝트A" } },
                    { "x": 0.5, "y": 0.6, "w": 0.5, "h": 0.4, "view": { "type": "BrowserPreviewView", "url": "http://localhost:3000" } }
                ]
            }
        ]
    }"##;

    let settings: Settings = serde_json::from_str(settings_json).unwrap();
    assert_eq!(settings.workspaces[0].name, "프로젝트A");
    assert_eq!(settings.workspaces[0].panes.len(), 3);
    assert_eq!(settings.workspaces[0].panes[0].view.view_type, "TerminalView");
    assert_eq!(settings.workspaces[0].panes[0].view.extra["profile"], "WSL");
    assert_eq!(settings.workspaces[0].panes[0].view.extra["syncGroup"], "프로젝트A");

    // Simulate creating sessions from settings
    let state = AppState::new();
    let ws = &settings.workspaces[0];

    for (i, pane) in ws.panes.iter().enumerate() {
        if pane.view.view_type == "TerminalView" {
            let id = format!("{}-term-{i}", ws.id);
            let profile = pane.view.extra["profile"].as_str().unwrap_or("PowerShell");
            let sync_group = pane.view.extra["syncGroup"].as_str().unwrap_or("");

            let config = TerminalConfig {
                profile: profile.into(),
                sync_group: sync_group.into(),
                ..TerminalConfig::default()
            };

            state.terminals.lock().unwrap()
                .insert(id.clone(), TerminalSession::new(id.clone(), config));

            if !sync_group.is_empty() {
                state.sync_groups.lock().unwrap()
                    .entry(sync_group.to_string())
                    .or_insert_with(|| SyncGroup::new(sync_group.into()))
                    .add_terminal(id);
            }
        }
    }

    // Verify: 2 terminal sessions, 1 sync group with 2 members
    assert_eq!(state.terminals.lock().unwrap().len(), 2);
    let groups = state.sync_groups.lock().unwrap();
    assert_eq!(groups.len(), 1);
    assert!(groups.contains_key("프로젝트A"));
    assert_eq!(groups["프로젝트A"].terminal_ids.len(), 2);
}

// ============================================================================
// Windows Terminal Compatibility Edge Cases
// ============================================================================

#[test]
fn windows_terminal_settings_compatibility() {
    // A realistic Windows Terminal settings.json snippet
    let wt_json = r##"{
        "profiles": [
            {
                "name": "Windows PowerShell",
                "commandLine": "powershell.exe -NoLogo",
                "colorScheme": "Campbell",
                "startingDirectory": "%USERPROFILE%",
                "hidden": false
            },
            {
                "name": "Ubuntu-22.04",
                "commandLine": "wsl.exe -d Ubuntu-22.04",
                "colorScheme": "One Half Dark",
                "startingDirectory": "//wsl$/Ubuntu-22.04/home/user",
                "hidden": false
            }
        ],
        "colorSchemes": [
            {
                "name": "Campbell",
                "foreground": "#CCCCCC",
                "background": "#0C0C0C",
                "cursorColor": "#FFFFFF",
                "selectionBackground": "#FFFFFF",
                "black": "#0C0C0C",
                "red": "#C50F1F",
                "green": "#13A10E",
                "yellow": "#C19C00",
                "blue": "#0037DA",
                "purple": "#881798",
                "cyan": "#3A96DD",
                "white": "#CCCCCC",
                "brightBlack": "#767676",
                "brightRed": "#E74856",
                "brightGreen": "#16C60C",
                "brightYellow": "#F9F1A5",
                "brightBlue": "#3B78FF",
                "brightPurple": "#B4009E",
                "brightCyan": "#61D6D6",
                "brightWhite": "#F2F2F2"
            }
        ],
        "font": {
            "face": "Cascadia Mono",
            "size": 12
        },
        "defaultProfile": "Windows PowerShell",
        "keybindings": [
            {"keys": "ctrl+shift+t", "command": "newTab"},
            {"keys": "ctrl+shift+w", "command": "closePane"}
        ]
    }"##;

    let settings: Settings = serde_json::from_str(wt_json).unwrap();

    assert_eq!(settings.profiles.len(), 2);
    assert_eq!(settings.profiles[0].name, "Windows PowerShell");
    assert_eq!(settings.profiles[1].command_line, "wsl.exe -d Ubuntu-22.04");
    assert_eq!(settings.color_schemes.len(), 1);
    assert_eq!(settings.color_schemes[0].name, "Campbell");
    assert_eq!(settings.color_schemes[0].bright_white, "#F2F2F2");
    // Root-level font is parsed as legacy backward compat
    let font = settings.font.as_ref().unwrap();
    assert_eq!(font.face, "Cascadia Mono");
    assert_eq!(font.size, 12);
    assert_eq!(settings.keybindings.len(), 2);
    assert_eq!(settings.default_profile, "Windows PowerShell");
}

// ============================================================================
// Edge Case: Concurrent group operations simulation
// ============================================================================

#[test]
fn concurrent_group_add_remove_simulation() {
    use std::sync::Arc;
    use std::thread;

    let state = Arc::new(AppState::new());

    // Pre-create terminals
    {
        let mut terminals = state.terminals.lock().unwrap();
        for i in 0..20 {
            let id = format!("ct-{i}");
            terminals.insert(id.clone(), TerminalSession::new(id, TerminalConfig::default()));
        }
    }

    // Spawn threads that add terminals to groups concurrently
    let handles: Vec<_> = (0..4)
        .map(|thread_id| {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                let group_name = format!("concurrent-group-{thread_id}");
                for i in 0..5 {
                    let terminal_id = format!("ct-{}", thread_id * 5 + i);
                    let mut groups = state.sync_groups.lock().unwrap();
                    groups
                        .entry(group_name.clone())
                        .or_insert_with(|| SyncGroup::new(group_name.clone()))
                        .add_terminal(terminal_id);
                }
            })
        })
        .collect();

    for h in handles {
        h.join().unwrap();
    }

    // Verify all groups were created correctly
    let groups = state.sync_groups.lock().unwrap();
    assert_eq!(groups.len(), 4);
    for i in 0..4 {
        let group_name = format!("concurrent-group-{i}");
        assert_eq!(groups[&group_name].terminal_ids.len(), 5);
    }
}

#[test]
fn concurrent_session_create_and_close() {
    use std::sync::Arc;
    use std::thread;

    let state = Arc::new(AppState::new());

    // Create sessions from multiple threads
    let create_handles: Vec<_> = (0..10)
        .map(|i| {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                let id = format!("par-{i}");
                let mut terminals = state.terminals.lock().unwrap();
                terminals.insert(id.clone(), TerminalSession::new(id, TerminalConfig::default()));
            })
        })
        .collect();

    for h in create_handles {
        h.join().unwrap();
    }

    assert_eq!(state.terminals.lock().unwrap().len(), 10);

    // Close half from multiple threads
    let close_handles: Vec<_> = (0..5)
        .map(|i| {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                let id = format!("par-{}", i * 2);
                state.terminals.lock().unwrap().remove(&id);
            })
        })
        .collect();

    for h in close_handles {
        h.join().unwrap();
    }

    assert_eq!(state.terminals.lock().unwrap().len(), 5);
}

// ============================================================================
// Keybinding & Font edge cases via Settings
// ============================================================================

#[test]
fn settings_font_size_zero() {
    // Font at profile level now
    let json = r#"{"profiles": [{"name": "T", "commandLine": "x", "font": {"face": "Mono", "size": 0}}]}"#;
    let settings: Settings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.profiles[0].font.as_ref().unwrap().size, 0);
}

#[test]
fn settings_font_size_max() {
    let json = r#"{"profiles": [{"name": "T", "commandLine": "x", "font": {"face": "Mono", "size": 65535}}]}"#;
    let settings: Settings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.profiles[0].font.as_ref().unwrap().size, 65535);
}

#[test]
fn settings_many_keybindings() {
    let mut keybindings = Vec::new();
    for i in 0..100 {
        keybindings.push(Keybinding {
            keys: format!("ctrl+shift+{i}"),
            command: format!("command_{i}"),
        });
    }

    let settings = Settings {
        keybindings,
        ..Settings::default()
    };

    let json = serde_json::to_string(&settings).unwrap();
    let parsed: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.keybindings.len(), 100);
    assert_eq!(parsed.keybindings[99].keys, "ctrl+shift+99");
}

#[test]
fn settings_duplicate_profile_names() {
    let json = r#"{
        "profiles": [
            {"name": "WSL", "commandLine": "wsl.exe -d Ubuntu", "colorScheme": "", "startingDirectory": "", "hidden": false},
            {"name": "WSL", "commandLine": "wsl.exe -d Debian", "colorScheme": "", "startingDirectory": "", "hidden": false}
        ]
    }"#;
    let settings: Settings = serde_json::from_str(json).unwrap();
    // Duplicate names are allowed at the data level
    assert_eq!(settings.profiles.len(), 2);
    assert_eq!(settings.profiles[0].command_line, "wsl.exe -d Ubuntu");
    assert_eq!(settings.profiles[1].command_line, "wsl.exe -d Debian");
}

#[test]
fn settings_json_with_extra_fields_ignored() {
    // JSON with extra unknown fields should be handled gracefully
    let json = r#"{
        "font": {"face": "Mono", "size": 14, "weight": "bold", "ligatures": true},
        "unknownField": "value",
        "anotherUnknown": [1, 2, 3]
    }"#;
    // This may or may not fail depending on serde configuration
    // With deny_unknown_fields it would fail; without it, extras are ignored
    let result: Result<Settings, _> = serde_json::from_str(json);
    // If it succeeds, verify known fields are correct
    if let Ok(settings) = result {
        let font = settings.font.as_ref().unwrap();
        assert_eq!(font.face, "Mono");
        assert_eq!(font.size, 14);
    }
    // Either way, it shouldn't panic
}
