pub mod models;
pub mod validation;
pub use models::*;
pub use validation::{SettingsLoadResult, ValidationWarning};

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static MEMO_LOCK: Mutex<()> = Mutex::new(());

/// Get the settings file path.
pub fn settings_path() -> PathBuf {
    let base = dirs_config_path().unwrap_or_else(|| PathBuf::from("."));
    base.join("settings.json")
}

pub(crate) fn dirs_config_path() -> Option<PathBuf> {
    let dir_name = if cfg!(debug_assertions) {
        "laymux-dev"
    } else {
        "laymux"
    };
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join(dir_name))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(|p| PathBuf::from(p).join(".config").join(dir_name))
    }
}

/// Load settings from disk. Returns default settings if file doesn't exist.
pub fn load_settings() -> Settings {
    let result = load_settings_validated();
    match result {
        SettingsLoadResult::Ok { settings, .. } => settings,
        SettingsLoadResult::Repaired { settings, .. } => settings,
        SettingsLoadResult::ParseError { settings, .. } => settings,
    }
}

/// Load settings from disk with full validation result.
/// Returns a `SettingsLoadResult` that the frontend can use to show recovery UI.
pub fn load_settings_validated() -> SettingsLoadResult {
    let path = settings_path();
    let path_str = path.display().to_string();

    let raw_content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => {
            // File doesn't exist — return default (no error, no warnings)
            return SettingsLoadResult::Ok {
                settings: Settings::default(),
                warnings: vec![],
            };
        }
    };

    // Try to parse JSON
    let mut settings: Settings = match serde_json::from_str(&raw_content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, path = %path_str, "Settings JSON 파싱 실패, 기본 설정 사용");
            return SettingsLoadResult::ParseError {
                settings: Settings::default(),
                error: e.to_string(),
                settings_path: path_str,
            };
        }
    };

    // Apply migrations
    migrate_settings(&mut settings);

    // Validate and repair
    let warnings = validation::validate_and_repair(&mut settings);

    if warnings.is_empty() {
        SettingsLoadResult::Ok {
            settings,
            warnings: vec![],
        }
    } else {
        let has_repairs = warnings.iter().any(|w| w.repaired);
        if has_repairs {
            tracing::info!(
                warning_count = warnings.len(),
                "Settings 검증 완료: {}개 항목 자동 수정",
                warnings.iter().filter(|w| w.repaired).count()
            );
        }
        SettingsLoadResult::Repaired { settings, warnings }
    }
}

/// Apply settings migrations.
fn migrate_settings(settings: &mut Settings) {
    // Migrate CMD → PowerShell in workspace pane views
    for ws in &mut settings.workspaces {
        for pane in &mut ws.panes {
            if let Some(profile) = pane.view.extra.get("profile").and_then(|v| v.as_str()) {
                if profile.eq_ignore_ascii_case("cmd") {
                    if let Some(obj) = pane.view.extra.as_object_mut() {
                        obj.insert("profile".into(), serde_json::json!("PowerShell"));
                    }
                }
            }
        }
    }

    // Remove CMD from profiles list
    settings
        .profiles
        .retain(|p| !p.name.eq_ignore_ascii_case("cmd"));

    // Assign stable IDs to workspace panes that don't have one
    for ws in &mut settings.workspaces {
        for pane in &mut ws.panes {
            if pane.id.is_empty() {
                pane.id = format!("pane-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            }
        }
    }

    // Assign stable IDs to dock panes that don't have one
    for dock in &mut settings.docks {
        for pane in &mut dock.panes {
            if pane.id.is_empty() {
                pane.id = format!("pane-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            }
        }
    }

    // Deduplicate workspace names
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for ws in &mut settings.workspaces {
        let base = ws.name.clone();
        if !seen_names.insert(ws.name.clone()) {
            let mut n = 2;
            loop {
                let candidate = format!("{base} ({n})");
                if seen_names.insert(candidate.clone()) {
                    ws.name = candidate;
                    break;
                }
                n += 1;
            }
        }
    }
}

/// Get the cache directory path.
pub fn cache_dir_path() -> Option<PathBuf> {
    dirs_config_path().map(|p| p.join("cache"))
}

/// Get the memo file path (inside cache/ directory).
pub fn memo_path() -> PathBuf {
    cache_dir_path()
        .unwrap_or_else(|| PathBuf::from("cache"))
        .join("memo.json")
}

/// Load memo content for a specific key.
pub fn load_memo(key: &str) -> String {
    let _guard = MEMO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_memo_from(&memo_path(), key)
}

/// Save memo content for a specific key.
pub fn save_memo(key: &str, content: &str) -> Result<(), String> {
    let _guard = MEMO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_memo_to(&memo_path(), key, content)
}

fn load_memo_from(path: &PathBuf, key: &str) -> String {
    let map = match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<std::collections::HashMap<String, String>>(&content)
            .unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    };
    map.get(key).cloned().unwrap_or_default()
}

fn save_memo_to(path: &PathBuf, key: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let mut map = match fs::read_to_string(path) {
        Ok(data) => serde_json::from_str::<std::collections::HashMap<String, String>>(&data)
            .unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    };
    if content.is_empty() {
        map.remove(key);
    } else {
        map.insert(key.to_string(), content.to_string());
    }
    let json = serde_json::to_string_pretty(&map).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Write error: {e}"))
}

/// Save settings to disk.
pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_has_profiles() {
        let settings = Settings::default();
        assert_eq!(settings.profiles.len(), 2);
        assert_eq!(settings.profiles[0].name, "PowerShell");
        assert_eq!(settings.profiles[1].name, "WSL");
    }

    #[test]
    fn default_issue_reporter_settings() {
        let settings = Settings::default();
        assert_eq!(settings.issue_reporter.shell, "");
    }

    #[test]
    fn serialize_deserialize_round_trip() {
        let settings = Settings::default();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings, parsed);
    }

    #[test]
    fn save_and_load_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings::default();
        let json = serde_json::to_string_pretty(&settings).unwrap();
        fs::write(&path, &json).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let loaded: Settings = serde_json::from_str(&content).unwrap();
        assert_eq!(settings, loaded);
    }

    #[test]
    fn codex_settings_round_trip() {
        let json = r#"{
          "codex": {
            "statusMessageMode": "title-bullet",
            "statusMessageDelimiter": " | "
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.codex.status_message_mode,
            CodexStatusMessageMode::TitleBullet
        );
        assert_eq!(settings.codex.status_message_delimiter, " | ");

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"codex\""));
        assert!(serialized.contains("\"statusMessageMode\":\"title-bullet\""));
    }

    #[test]
    fn migrate_cmd_profile_to_powershell_in_workspace_panes() {
        let mut settings = Settings::default();
        settings.workspaces = vec![Workspace {
            id: "ws-1".into(),
            name: "Test".into(),
            layout_id: None,
            panes: vec![WorkspacePane {
                id: "pane-test1".into(),
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
                view: serde_json::from_value(serde_json::json!({
                    "type": "TerminalView",
                    "profile": "CMD"
                }))
                .unwrap(),
            }],
        }];
        migrate_settings(&mut settings);
        assert_eq!(
            settings.workspaces[0].panes[0].view.extra["profile"],
            "PowerShell"
        );
    }

    #[test]
    fn migrate_removes_cmd_from_profiles() {
        let mut settings = Settings::default();
        settings.profiles.push(Profile {
            name: "CMD".into(),
            command_line: "cmd.exe".into(),
            ..Profile::default()
        });
        assert_eq!(settings.profiles.len(), 3);
        migrate_settings(&mut settings);
        assert_eq!(settings.profiles.len(), 2);
    }

    #[test]
    fn migrate_deduplicates_workspace_names() {
        let mut settings = Settings::default();
        settings.workspaces = vec![
            Workspace {
                id: "ws-1".into(),
                name: "Dev".into(),
                layout_id: None,
                panes: vec![],
            },
            Workspace {
                id: "ws-2".into(),
                name: "Dev".into(),
                layout_id: None,
                panes: vec![],
            },
            Workspace {
                id: "ws-3".into(),
                name: "Dev".into(),
                layout_id: None,
                panes: vec![],
            },
        ];
        migrate_settings(&mut settings);
        let names: Vec<&str> = settings
            .workspaces
            .iter()
            .map(|w| w.name.as_str())
            .collect();
        assert_eq!(names, vec!["Dev", "Dev (2)", "Dev (3)"]);
    }

    #[test]
    fn memo_round_trip_via_functions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        save_memo_to(&path, "pane-1", "Hello").unwrap();
        save_memo_to(&path, "pane-2", "World").unwrap();
        assert_eq!(load_memo_from(&path, "pane-1"), "Hello");
        assert_eq!(load_memo_from(&path, "pane-2"), "World");
    }

    #[test]
    fn memo_missing_key_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        assert_eq!(load_memo_from(&path, "nonexistent"), "");
    }

    #[test]
    fn memo_empty_content_removes_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        save_memo_to(&path, "pane-1", "data").unwrap();
        save_memo_to(&path, "pane-1", "").unwrap();
        assert_eq!(load_memo_from(&path, "pane-1"), "");
    }

    #[test]
    fn cache_dir_path_is_under_config() {
        if let Some(cache) = cache_dir_path() {
            if let Some(config) = dirs_config_path() {
                assert_eq!(cache.parent(), Some(config.as_path()));
            }
        }
    }

    #[test]
    fn workspace_pane_id_round_trip() {
        let pane = WorkspacePane {
            id: "pane-abc12345".into(),
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            view: serde_json::from_value(serde_json::json!({"type": "TerminalView"})).unwrap(),
        };
        let json = serde_json::to_string(&pane).unwrap();
        let parsed: WorkspacePane = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "pane-abc12345");
    }

    #[test]
    fn workspace_pane_id_defaults_empty_when_missing() {
        let json = r#"{"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0, "view": {"type": "EmptyView"}}"#;
        let pane: WorkspacePane = serde_json::from_str(json).unwrap();
        assert_eq!(pane.id, "");
    }

    #[test]
    fn workspace_display_order_round_trip() {
        let mut settings = Settings::default();
        settings.workspace_display_order = vec!["ws-2".into(), "ws-1".into()];
        let json = serde_json::to_string_pretty(&settings).unwrap();
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.workspace_display_order, vec!["ws-2", "ws-1"]);
    }

    #[test]
    fn workspace_display_order_skipped_when_empty() {
        let settings = Settings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("workspaceDisplayOrder"));
    }

    #[test]
    fn view_order_and_app_theme_round_trip() {
        let json = r#"{"viewOrder": ["TerminalView", "MemoView"], "appThemeId": "dracula"}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.view_order, vec!["TerminalView", "MemoView"]);
        assert_eq!(settings.app_theme_id, "dracula");
    }
}
