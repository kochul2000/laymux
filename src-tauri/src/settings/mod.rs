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

/// Return the full map of memo `key → content` pairs.
/// Returns an empty map when the memo file does not exist or fails to parse.
pub fn load_all_memos() -> std::collections::HashMap<String, String> {
    let _guard = MEMO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_all_memos_from(&memo_path())
}

pub fn load_all_memos_from(path: &PathBuf) -> std::collections::HashMap<String, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<std::collections::HashMap<String, String>>(&content)
            .unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    }
}

fn load_memo_from(path: &PathBuf, key: &str) -> String {
    let map = load_all_memos_from(path);
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
    fn default_language_is_system() {
        let settings = Settings::default();
        assert_eq!(settings.language, "system");
    }

    #[test]
    fn language_round_trip_and_backcompat() {
        // Explicit value survives a round trip.
        let mut settings = Settings::default();
        settings.language = "en".into();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"language\":\"en\""));
        let parsed: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.language, "en");

        // 구버전 settings.json(language 없음)도 기본값("system")으로 채워진다.
        let legacy: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.language, "system");
    }

    #[test]
    fn default_issue_reporter_settings() {
        let settings = Settings::default();
        assert_eq!(settings.issue_reporter.shell, "");
    }

    #[test]
    fn paste_multi_file_defaults() {
        // issue #325: 다중 파일 붙여넣기 설정 기본값
        let paste = crate::settings::models::PasteSettings::default();
        assert_eq!(paste.path_separator, "space");
        assert!(!paste.path_quote);
        // 구버전 settings.json(필드 없음)도 기본값으로 채워진다
        let parsed: crate::settings::models::PasteSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.path_separator, "space");
        assert!(!parsed.path_quote);
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
    fn claude_session_limit_resume_defaults() {
        // Issue #312: missing fields in an existing settings.json must fall
        // back to auto-resume enabled, 60s delay, "go on" message.
        let json = r#"{ "claude": { "syncCwd": "skip" } }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.claude.session_limit_auto_resume);
        assert_eq!(settings.claude.session_limit_resume_delay_seconds, 60);
        assert_eq!(settings.claude.session_limit_resume_message, "go on");
    }

    #[test]
    fn claude_session_limit_resume_round_trip() {
        let json = r#"{
          "claude": {
            "sessionLimitAutoResume": false,
            "sessionLimitResumeDelaySeconds": 120,
            "sessionLimitResumeMessage": "continue"
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(!settings.claude.session_limit_auto_resume);
        assert_eq!(settings.claude.session_limit_resume_delay_seconds, 120);
        assert_eq!(settings.claude.session_limit_resume_message, "continue");

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"sessionLimitAutoResume\":false"));
        assert!(serialized.contains("\"sessionLimitResumeDelaySeconds\":120"));
        assert!(serialized.contains("\"sessionLimitResumeMessage\":\"continue\""));
    }

    #[test]
    fn workspace_selector_hidden_auto_close_default_is_disabled() {
        // Default must be 0 (disabled) so existing users see no behavior change.
        let settings = Settings::default();
        assert_eq!(settings.workspace_selector.hidden_auto_close_seconds, 0);
    }

    #[test]
    fn workspace_selector_hidden_auto_close_round_trip() {
        // The timeout must persist through a full save/load cycle in settings.json.
        let json = r#"{
          "workspaceSelector": {
            "hiddenAutoCloseSeconds": 600
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.workspace_selector.hidden_auto_close_seconds, 600);

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"hiddenAutoCloseSeconds\":600"));

        // Round-trip the serialized form back to ensure the field is not dropped.
        let reparsed: Settings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reparsed.workspace_selector.hidden_auto_close_seconds, 600);
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
    fn load_all_memos_returns_all_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        save_memo_to(&path, "pane-a", "alpha").unwrap();
        save_memo_to(&path, "pane-b", "beta").unwrap();
        save_memo_to(&path, "pane-c", "gamma").unwrap();

        let all = load_all_memos_from(&path);
        assert_eq!(all.len(), 3);
        assert_eq!(all.get("pane-a").map(String::as_str), Some("alpha"));
        assert_eq!(all.get("pane-b").map(String::as_str), Some("beta"));
        assert_eq!(all.get("pane-c").map(String::as_str), Some("gamma"));
    }

    #[test]
    fn load_all_memos_returns_empty_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        let all = load_all_memos_from(&path);
        assert!(all.is_empty());
    }

    #[test]
    fn load_all_memos_returns_empty_on_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        fs::write(&path, "not valid json {{{").unwrap();
        let all = load_all_memos_from(&path);
        assert!(all.is_empty());
    }

    #[test]
    fn load_all_memos_excludes_deleted_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.json");
        save_memo_to(&path, "pane-1", "one").unwrap();
        save_memo_to(&path, "pane-2", "two").unwrap();
        // Empty content removes the key.
        save_memo_to(&path, "pane-1", "").unwrap();

        let all = load_all_memos_from(&path);
        assert_eq!(all.len(), 1);
        assert!(!all.contains_key("pane-1"));
        assert_eq!(all.get("pane-2").map(String::as_str), Some("two"));
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
        let json =
            r#"{"viewOrder": ["TerminalView", "MemoView"], "appearance": {"themeId": "dracula"}}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.view_order, vec!["TerminalView", "MemoView"]);
        assert_eq!(settings.appearance.theme_id, "dracula");
    }
}
