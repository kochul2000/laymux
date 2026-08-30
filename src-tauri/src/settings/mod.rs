pub mod agent_command;
pub mod contract;
mod lenient;
pub mod models;
mod schema;
mod semantic_validation;
pub mod validation;
pub use models::*;
pub use validation::{SettingsLoadResult, ValidationWarning};

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::lock_ext::MutexExt;
use sha2::{Digest, Sha256};

static MEMO_LOCK: Mutex<()> = Mutex::new(());

/// Serializes every settings.json writer.
///
/// Writers are not all on one thread: the cloud pairing/tunnel tasks save from
/// their own runtime threads, and `save_settings`/`reset_settings` now run on
/// the Tauri sync threadpool instead of the main thread (ADR-0202). Two
/// interleaved writers to the same path can leave a torn file, so the write
/// itself is gated here rather than relying on the main thread to serialize it.
///
/// This is a leaf lock: nothing else is acquired while it is held, so it takes
/// no place in the `AppState` lock order (api-contracts.md §14.3). Holding it
/// across an `AppState` lock is what would break that — do not.
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock_memo_gate(lock: &Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    Ok(lock.lock_or_err()?)
}

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
        SettingsLoadResult::Recovered { settings, .. } => settings,
        SettingsLoadResult::ParseError { settings, .. } => settings,
    }
}

/// Load settings from disk with full validation result.
/// Returns a `SettingsLoadResult` that the frontend can use to show recovery UI.
pub fn load_settings_validated() -> SettingsLoadResult {
    load_settings_validated_from(&settings_path())
}

/// Path-injectable core of [`load_settings_validated`].
fn load_settings_validated_from(path: &std::path::Path) -> SettingsLoadResult {
    let path_str = path.display().to_string();

    let raw_content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => {
            // File doesn't exist — return default (no error, no warnings)
            return SettingsLoadResult::Ok {
                settings: Settings::default(),
                warnings: vec![],
            };
        }
    };

    // Parse JSON, dropping individual type-error paths so one bad value does
    // not cost the whole file (ADR-0119). Only an unsalvageable document —
    // syntax error or root-level type error — falls through to ParseError.
    let (mut settings, dropped) = match lenient::deserialize_lenient(&raw_content) {
        Ok(recovered) => (recovered.settings, recovered.dropped),
        Err(e) => {
            tracing::warn!(error = %e, path = %path_str, "Settings JSON 파싱 실패, 기본 설정 사용");
            return SettingsLoadResult::ParseError {
                settings: Settings::default(),
                error: e,
                settings_path: path_str,
            };
        }
    };

    // Apply migrations
    migrate_settings(&mut settings);

    // Validate and repair
    let warnings = validation::validate_and_repair(&mut settings);

    // Dropped paths mean user-authored values are gone. That is a stronger
    // signal than a structural repair: the frontend must block writes until the
    // user has seen which paths were lost, so the original file stays intact.
    if !dropped.is_empty() {
        tracing::warn!(
            dropped_count = dropped.len(),
            path = %path_str,
            "Settings 타입 오류 항목을 제거하고 기본값으로 복구"
        );
        return SettingsLoadResult::Recovered {
            settings,
            dropped,
            warnings,
            settings_path: path_str,
            recovery_revision: recovery_revision(&raw_content),
        };
    }

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

    // Heal stale cloud relay placeholder → build default.
    // Older builds persisted `https://cloud.laymux.example` (a dead placeholder)
    // as the relay base URL default. serde's `default` only fills an absent
    // field, so upgraded installs keep the placeholder and cloud connect opens
    // the dead host. Rewrite it to the current build default.
    if settings.remote.relay_base_url.trim().trim_end_matches('/') == LEGACY_CLOUD_RELAY_PLACEHOLDER
    {
        settings.remote.relay_base_url = default_cloud_relay_base_url();
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
pub fn load_memo(key: &str) -> Result<String, String> {
    let _guard = lock_memo_gate(&MEMO_LOCK)?;
    Ok(load_memo_from(&memo_path(), key))
}

/// Save memo content for a specific key.
pub fn save_memo(key: &str, content: &str) -> Result<(), String> {
    let _guard = lock_memo_gate(&MEMO_LOCK)?;
    save_memo_to(&memo_path(), key, content)
}

/// Return the full map of memo `key → content` pairs.
/// Returns an empty map when the memo file does not exist or fails to parse.
pub fn load_all_memos() -> Result<std::collections::HashMap<String, String>, String> {
    let _guard = lock_memo_gate(&MEMO_LOCK)?;
    Ok(load_all_memos_from(&memo_path()))
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
///
/// The write is serialized against every other writer and lands through a
/// temporary file, so a concurrent save cannot interleave bytes and a reader
/// never observes a half-written settings.json (ADR-0202).
pub fn save_settings(settings: &Settings) -> Result<(), String> {
    save_settings_to(&settings_path(), settings)
}

/// Commit a frontend-owned checkpoint without overwriting cloud identity that
/// a backend worker may have refreshed after the WebView collected its snapshot.
pub fn save_frontend_settings(settings: &Settings) -> Result<Settings, String> {
    save_frontend_settings_to(&settings_path(), settings)
}

/// Atomically load the latest document, mutate only caller-owned fields, and
/// replace it while holding the settings transaction gate.
pub fn update_settings(
    mutate: impl FnOnce(&mut Settings) -> Result<(), String>,
) -> Result<Settings, String> {
    update_settings_at(&settings_path(), mutate)
}

/// Commit the leniently recovered document only after the user has reviewed
/// the dropped paths. Background writers cannot implicitly acknowledge loss.
pub fn acknowledge_settings_recovery(expected_recovery_revision: &str) -> Result<Settings, String> {
    acknowledge_settings_recovery_at(&settings_path(), expected_recovery_revision)
}

fn recovery_revision(raw_content: &str) -> String {
    Sha256::digest(raw_content.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn unacknowledged_recovery_error() -> String {
    "Refusing to overwrite recovered settings before recovery is acknowledged".into()
}

fn update_settings_at(
    path: &std::path::Path,
    mutate: impl FnOnce(&mut Settings) -> Result<(), String>,
) -> Result<Settings, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let _guard = SETTINGS_WRITE_LOCK.lock_or_err()?;
    let mut settings = if path.exists() {
        match load_settings_validated_from(path) {
            SettingsLoadResult::Ok { settings, .. }
            | SettingsLoadResult::Repaired { settings, .. } => settings,
            SettingsLoadResult::Recovered { .. } => {
                return Err(unacknowledged_recovery_error());
            }
            SettingsLoadResult::ParseError { error, .. } => {
                return Err(format!(
                    "Refusing to overwrite an unparseable settings file: {error}"
                ));
            }
        }
    } else {
        Settings::default()
    };
    mutate(&mut settings)?;
    let json =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("Serialize error: {e}"))?;
    write_file_atomically(path, json.as_bytes())?;
    Ok(settings)
}

fn save_frontend_settings_to(
    path: &std::path::Path,
    settings: &Settings,
) -> Result<Settings, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let _guard = SETTINGS_WRITE_LOCK.lock_or_err()?;
    let mut candidate = settings.clone();
    if path.exists() {
        match load_settings_validated_from(path) {
            SettingsLoadResult::Ok {
                settings: latest, ..
            }
            | SettingsLoadResult::Repaired {
                settings: latest, ..
            } => {
                candidate.remote.cloud_enabled = latest.remote.cloud_enabled;
                candidate
                    .remote
                    .cloud_instance_id
                    .clone_from(&latest.remote.cloud_instance_id);
                candidate
                    .remote
                    .cloud_tunnel_url
                    .clone_from(&latest.remote.cloud_tunnel_url);
                candidate
                    .remote
                    .cloud_server_base_url
                    .clone_from(&latest.remote.cloud_server_base_url);
            }
            SettingsLoadResult::Recovered { .. } => {
                return Err(unacknowledged_recovery_error());
            }
            SettingsLoadResult::ParseError { error, .. } => {
                return Err(format!(
                    "Refusing to overwrite an unparseable settings file: {error}"
                ));
            }
        }
    }
    let json =
        serde_json::to_string_pretty(&candidate).map_err(|e| format!("Serialize error: {e}"))?;
    write_file_atomically(path, json.as_bytes())?;
    Ok(candidate)
}

fn acknowledge_settings_recovery_at(
    path: &std::path::Path,
    expected_recovery_revision: &str,
) -> Result<Settings, String> {
    let _guard = SETTINGS_WRITE_LOCK.lock_or_err()?;
    match load_settings_validated_from(path) {
        SettingsLoadResult::Recovered {
            settings,
            recovery_revision,
            ..
        } => {
            if recovery_revision != expected_recovery_revision {
                return Err(
                    "Settings recovery changed; review the latest dropped paths before acknowledging"
                        .into(),
                );
            }
            let json = serde_json::to_string_pretty(&settings)
                .map_err(|error| format!("Serialize error: {error}"))?;
            write_file_atomically(path, json.as_bytes())?;
            Ok(settings)
        }
        SettingsLoadResult::Ok { settings, .. } | SettingsLoadResult::Repaired { settings, .. } => {
            Ok(settings)
        }
        SettingsLoadResult::ParseError { error, .. } => Err(format!(
            "Refusing to acknowledge an unparseable settings file: {error}"
        )),
    }
}

/// `save_settings` against an explicit path, so the write contract is testable
/// without reaching for the real config directory.
pub(crate) fn save_settings_to(path: &std::path::Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let _guard = SETTINGS_WRITE_LOCK.lock_or_err()?;
    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Serialize error: {e}"))?;
    write_file_atomically(path, json.as_bytes())
}

/// Write `bytes` to `path` by way of a sibling temporary file.
///
/// `fs::rename` replaces an existing destination on both Windows (MoveFileEx
/// with MOVEFILE_REPLACE_EXISTING) and POSIX, so the destination is either the
/// old file or the new one — never a truncated prefix of the new one.
fn write_file_atomically(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Write error: {e}"))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("Write error: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── settings.json 쓰기 (ADR-0202) ──

    /// `save_settings` no longer runs only on the main thread, so the write has
    /// to survive concurrent writers on its own: whole content, no debris.
    #[test]
    fn saving_settings_replaces_the_file_without_leaving_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "stale contents that are longer than the new file").unwrap();

        let settings = Settings::default();
        save_settings_to(&path, &settings).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        serde_json::from_str::<serde_json::Value>(&written).expect("a whole JSON document");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn frontend_checkpoint_preserves_backend_owned_cloud_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut latest = Settings::default();
        latest.remote.cloud_enabled = true;
        latest.remote.cloud_instance_id = Some("new-instance".into());
        latest.remote.cloud_tunnel_url = Some("wss://new.example.test".into());
        latest.remote.cloud_server_base_url = Some("https://new.example.test".into());
        save_settings_to(&path, &latest).unwrap();

        let mut stale_frontend = latest.clone();
        stale_frontend.remote.cloud_enabled = false;
        stale_frontend.remote.cloud_instance_id = Some("old-instance".into());
        stale_frontend.remote.cloud_tunnel_url = None;
        stale_frontend.remote.cloud_server_base_url = None;
        stale_frontend.workspaces[0].name = "new workspace checkpoint".into();
        save_frontend_settings_to(&path, &stale_frontend).unwrap();

        let saved = match load_settings_validated_from(&path) {
            SettingsLoadResult::Ok { settings, .. }
            | SettingsLoadResult::Repaired { settings, .. }
            | SettingsLoadResult::Recovered { settings, .. } => settings,
            SettingsLoadResult::ParseError { error, .. } => panic!("{error}"),
        };
        assert!(saved.remote.cloud_enabled);
        assert_eq!(
            saved.remote.cloud_instance_id.as_deref(),
            Some("new-instance")
        );
        assert_eq!(saved.workspaces[0].name, "new workspace checkpoint");
    }

    #[test]
    fn path_owned_backend_update_preserves_the_latest_session_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut checkpoint = Settings::default();
        checkpoint.workspaces[0].name = "latest session checkpoint".into();
        save_settings_to(&path, &checkpoint).unwrap();

        let updated = update_settings_at(&path, |settings| {
            settings.remote.cloud_enabled = true;
            settings.remote.cloud_instance_id = Some("instance-2".into());
            Ok(())
        })
        .unwrap();

        assert_eq!(updated.workspaces[0].name, "latest session checkpoint");
        assert_eq!(
            updated.remote.cloud_instance_id.as_deref(),
            Some("instance-2")
        );
    }

    #[test]
    fn backend_update_refuses_unacknowledged_recovered_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = r#"{
          "language": "en",
          "terminal": { "parserAdmission": { "hiddenShare": "invalid" } }
        }"#;
        std::fs::write(&path, original).unwrap();

        let error = update_settings_at(&path, |settings| {
            settings.remote.cloud_enabled = true;
            Ok(())
        })
        .unwrap_err();

        assert!(error.contains("recovery is acknowledged"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        let frontend_error = save_frontend_settings_to(&path, &Settings::default()).unwrap_err();
        assert!(
            frontend_error.contains("recovery is acknowledged"),
            "{frontend_error}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn recovery_acknowledgement_is_the_only_non_reset_path_that_unlocks_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{
              "language": "en",
              "terminal": { "parserAdmission": { "hiddenShare": "invalid" } }
            }"#,
        )
        .unwrap();

        let recovery_revision = match load_settings_validated_from(&path) {
            SettingsLoadResult::Recovered {
                recovery_revision, ..
            } => recovery_revision,
            result => panic!("expected recovered settings, got {result:?}"),
        };
        let acknowledged = acknowledge_settings_recovery_at(&path, &recovery_revision).unwrap();
        assert_eq!(acknowledged.language, "en");
        assert!(matches!(
            load_settings_validated_from(&path),
            SettingsLoadResult::Ok { .. } | SettingsLoadResult::Repaired { .. }
        ));

        let updated = update_settings_at(&path, |settings| {
            settings.remote.cloud_enabled = true;
            Ok(())
        })
        .unwrap();
        assert!(updated.remote.cloud_enabled);
    }

    #[test]
    fn recovery_acknowledgement_rejects_unreviewed_new_dropped_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{ "language": 42, "defaultProfile": "WSL" }"#).unwrap();
        let original_revision = match load_settings_validated_from(&path) {
            SettingsLoadResult::Recovered {
                recovery_revision, ..
            } => recovery_revision,
            result => panic!("expected recovered settings, got {result:?}"),
        };

        let manually_edited = r#"{
          "language": "en",
          "terminal": { "parserAdmission": { "hiddenShare": "invalid" } }
        }"#;
        fs::write(&path, manually_edited).unwrap();
        let error = acknowledge_settings_recovery_at(&path, &original_revision).unwrap_err();

        assert!(error.contains("review the latest dropped paths"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), manually_edited);
        let latest = load_settings_validated_from(&path);
        let SettingsLoadResult::Recovered {
            dropped,
            recovery_revision,
            ..
        } = latest
        else {
            panic!("expected latest recovered settings, got {latest:?}");
        };
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].path, "terminal.parserAdmission.hiddenShare");
        acknowledge_settings_recovery_at(&path, &recovery_revision).unwrap();
    }

    /// Two writers racing on one path may not interleave into a torn document —
    /// every observer sees one save or the other, never a prefix of both.
    #[test]
    fn concurrent_saves_never_leave_a_torn_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let small = Settings {
            language: "ko".into(),
            ..Settings::default()
        };
        let defaults = Settings::default();
        let large = Settings {
            language: "en".into(),
            profiles: std::iter::repeat_with(|| defaults.profiles[0].clone())
                .take(200)
                .collect(),
            ..defaults.clone()
        };

        std::thread::scope(|scope| {
            for settings in [&small, &large] {
                scope.spawn(|| {
                    for _ in 0..20 {
                        save_settings_to(&path, settings).unwrap();
                        let read = std::fs::read_to_string(&path).unwrap();
                        serde_json::from_str::<serde_json::Value>(&read)
                            .expect("a whole JSON document");
                    }
                });
            }
        });
    }

    #[test]
    fn memo_serialization_gate_fails_closed_after_poison() {
        let gate = Mutex::new(());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = gate.lock().unwrap();
            panic!("poison memo serialization gate");
        }))
        .is_err());

        assert!(lock_memo_gate(&gate).is_err());
    }

    // ── 업데이트 채널 (ADR-0190) ──

    #[test]
    fn unknown_update_channel_loads_without_recovery_and_resolves_to_stable() {
        // The channel is a String, not an enum, so a hand-edited value does not
        // drop the whole settings tree into partial recovery. The runtime folds
        // it to stable instead (ADR-0190).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{
              "language": "en",
              "defaultProfile": "WSL",
              "update": { "channel": "nightly" }
            }"#,
        )
        .unwrap();

        let result = load_settings_validated_from(&path);
        let settings = match &result {
            SettingsLoadResult::Ok { settings, .. } => settings,
            SettingsLoadResult::Repaired { settings, .. } => settings,
            other => panic!("expected Ok or Repaired, got {other:?}"),
        };
        assert_eq!(settings.update.channel, "nightly");
        assert_eq!(
            crate::app_update::UpdateChannel::from_settings_value(&settings.update.channel),
            crate::app_update::UpdateChannel::Stable
        );
    }

    // ── 타입 오류 부분 복구 (issue #701, ADR-0119) ──

    #[test]
    fn type_error_recovers_instead_of_resetting_everything() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{
              "language": "en",
              "defaultProfile": "WSL",
              "terminal": { "parserAdmission": { "hiddenShare": "2" } }
            }"#,
        )
        .unwrap();

        let result = load_settings_validated_from(&path);
        let SettingsLoadResult::Recovered {
            settings,
            dropped,
            warnings,
            settings_path,
            recovery_revision,
        } = result
        else {
            panic!("expected Recovered, got {result:?}");
        };

        // The rest of the file survived — this is the whole point of #701.
        assert_eq!(settings.language, "en");
        assert_eq!(settings.default_profile, "WSL");
        // The mistyped knob fell back to its own default.
        assert_eq!(
            settings.terminal.parser_admission.hidden_share,
            Settings::default().terminal.parser_admission.hidden_share
        );
        assert_eq!(settings_path, path.display().to_string());
        assert_eq!(recovery_revision.len(), 64);

        // Exactly one value was lost. Structural repairs (this file has no
        // workspaces, so the loader synthesizes one) stay out of that count.
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].path, "terminal.parserAdmission.hiddenShare");
        assert!(
            !warnings.iter().any(|w| w.path.starts_with("terminal.")),
            "repair warnings must not restate dropped paths: {warnings:?}"
        );
    }

    #[test]
    fn recovery_does_not_rewrite_the_file() {
        // The loader must never heal the file on disk — the user has to see the
        // dropped paths first (ADR-0119 손실 정책).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = r#"{ "language": 42, "defaultProfile": "WSL" }"#;
        fs::write(&path, original).unwrap();

        let _ = load_settings_validated_from(&path);

        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn syntax_error_still_reports_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ \"language\": \"en\"").unwrap();

        let result = load_settings_validated_from(&path);
        assert!(
            matches!(result, SettingsLoadResult::ParseError { .. }),
            "got {result:?}"
        );
    }

    #[test]
    fn clean_file_reports_ok_without_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            serde_json::to_string_pretty(&Settings::default()).unwrap(),
        )
        .unwrap();

        let result = load_settings_validated_from(&path);
        assert!(
            matches!(result, SettingsLoadResult::Ok { .. }),
            "got {result:?}"
        );
    }

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
    fn remote_settings_default_off_and_round_trip() {
        let legacy: Settings = serde_json::from_str("{}").unwrap();
        assert!(!legacy.remote.enabled);
        assert_eq!(legacy.remote.allowed_ips, vec!["127.0.0.1/32", "::1/128"]);
        assert!(!legacy.remote.tailscale_only);
        assert_eq!(legacy.remote.heartbeat_timeout_seconds, 45);
        assert_eq!(legacy.remote.auto_mobile_mode_min_width, 720);
        assert!(!legacy.remote.cloud_enabled);
        assert_eq!(
            legacy.remote.relay_base_url,
            models::default_cloud_relay_base_url()
        );
        assert_eq!(legacy.remote.cloud_instance_id, None);
        assert_eq!(legacy.remote.cloud_tunnel_url, None);
        assert_eq!(legacy.remote.cloud_server_base_url, None);
        assert!(legacy.remote.cloud_auto_reconnect);
        assert_eq!(
            legacy.remote.cloud_access_mode,
            models::CloudAccessMode::BrowserAndE2e
        );
        let json = r#"{
          "remote": {
            "enabled": true,
            "allowedIps": ["100.64.0.0/10"],
            "tailscaleOnly": true,
            "authToken": "secret",
            "heartbeatTimeoutSeconds": 30,
            "autoMobileModeMinWidth": 640,
            "cloudEnabled": true,
            "relayBaseUrl": "https://relay.example.test",
            "cloudInstanceId": "instance-123",
            "cloudTunnelUrl": "wss://relay.example.test/tunnel/instance-123",
            "cloudServerBaseUrl": "https://relay.example.test",
            "cloudAutoReconnect": false,
            "cloudAccessMode": "androidE2eOnly"
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.remote.enabled);
        assert_eq!(settings.remote.allowed_ips, vec!["100.64.0.0/10"]);
        assert!(settings.remote.tailscale_only);
        assert_eq!(settings.remote.auth_token, "secret");
        assert_eq!(settings.remote.heartbeat_timeout_seconds, 30);
        assert_eq!(settings.remote.auto_mobile_mode_min_width, 640);
        assert!(settings.remote.cloud_enabled);
        assert_eq!(settings.remote.relay_base_url, "https://relay.example.test");
        assert_eq!(
            settings.remote.cloud_instance_id.as_deref(),
            Some("instance-123")
        );
        assert_eq!(
            settings.remote.cloud_tunnel_url.as_deref(),
            Some("wss://relay.example.test/tunnel/instance-123")
        );
        assert_eq!(
            settings.remote.cloud_server_base_url.as_deref(),
            Some("https://relay.example.test")
        );
        assert!(!settings.remote.cloud_auto_reconnect);
        assert_eq!(
            settings.remote.cloud_access_mode,
            models::CloudAccessMode::AndroidE2eOnly
        );

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"remote\""));
        assert!(serialized.contains("\"allowedIps\":[\"100.64.0.0/10\"]"));
        assert!(serialized.contains("\"tailscaleOnly\":true"));
        assert!(serialized.contains("\"authToken\":\"secret\""));
        assert!(serialized.contains("\"autoMobileModeMinWidth\":640"));
        assert!(serialized.contains("\"cloudEnabled\":true"));
        assert!(serialized.contains("\"relayBaseUrl\":\"https://relay.example.test\""));
        assert!(serialized.contains("\"cloudInstanceId\":\"instance-123\""));
        assert!(serialized
            .contains("\"cloudTunnelUrl\":\"wss://relay.example.test/tunnel/instance-123\""));
        assert!(serialized.contains("\"cloudServerBaseUrl\":\"https://relay.example.test\""));
        assert!(serialized.contains("\"cloudAutoReconnect\":false"));
        assert!(serialized.contains("\"cloudAccessMode\":\"androidE2eOnly\""));
    }

    #[test]
    fn language_round_trip_and_backcompat() {
        // Explicit value survives a round trip.
        let settings = Settings {
            language: "en".into(),
            ..Settings::default()
        };
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
            "restoreSession": false,
            "sessionMaxAgeHours": 72,
            "transcriptScrollEnabled": false,
            "statusMessageMode": "title-bullet",
            "statusMessageDelimiter": " | "
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.codex.status_message_mode,
            CodexStatusMessageMode::TitleBullet
        );
        assert!(!settings.codex.restore_session);
        assert_eq!(settings.codex.session_max_age_hours, 72);
        assert!(!settings.codex.transcript_scroll_enabled);
        assert_eq!(settings.codex.status_message_delimiter, " | ");

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"codex\""));
        assert!(serialized.contains("\"restoreSession\":false"));
        assert!(serialized.contains("\"sessionMaxAgeHours\":72"));
        assert!(serialized.contains("\"transcriptScrollEnabled\":false"));
        assert!(serialized.contains("\"statusMessageMode\":\"title-bullet\""));
    }

    #[test]
    fn codex_session_restore_defaults_for_existing_settings() {
        let settings: Settings = serde_json::from_str(r#"{ "codex": {} }"#).unwrap();
        assert!(settings.codex.restore_session);
        assert_eq!(settings.codex.session_max_age_hours, 24);
        assert!(settings.codex.transcript_scroll_enabled);
    }

    #[test]
    fn codex_metadata_distinguishes_live_display_from_next_use_restore() {
        assert_eq!(
            contract::metadata_for_path("/codex/statusMessageMode").apply_mode,
            contract::ApplyMode::Live
        );
        assert_eq!(
            contract::metadata_for_path("/codex/restoreSession").apply_mode,
            contract::ApplyMode::NextUse
        );
        assert_eq!(
            contract::metadata_for_path("/codex/sessionMaxAgeHours").apply_mode,
            contract::ApplyMode::NextUse
        );
        assert_eq!(
            contract::metadata_for_path("/codex/transcriptScrollEnabled").apply_mode,
            contract::ApplyMode::Live
        );
    }

    #[test]
    fn agent_launch_commands_default_and_round_trip() {
        let existing: Settings = serde_json::from_str(r#"{ "claude": {}, "codex": {} }"#).unwrap();
        assert_eq!(existing.claude.command, "claude");
        assert_eq!(existing.codex.command, "codex");

        let configured: Settings = serde_json::from_str(
            r#"{
              "claude": { "command": "claude --dangerously-skip-permissions" },
              "codex": { "command": "codex --yolo" }
            }"#,
        )
        .unwrap();
        assert_eq!(
            configured.claude.command,
            "claude --dangerously-skip-permissions"
        );
        assert_eq!(configured.codex.command, "codex --yolo");

        let serialized = serde_json::to_string(&configured).unwrap();
        assert!(serialized.contains("\"command\":\"claude --dangerously-skip-permissions\""));
        assert!(serialized.contains("\"command\":\"codex --yolo\""));
    }

    #[test]
    fn agent_launch_command_metadata_applies_on_next_use() {
        assert_eq!(
            contract::metadata_for_path("/claude/command").apply_mode,
            contract::ApplyMode::NextUse
        );
        assert_eq!(
            contract::metadata_for_path("/codex/command").apply_mode,
            contract::ApplyMode::NextUse
        );
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
    fn sleep_prevention_axes_default_to_off() {
        // The app must not change the machine's power behavior until asked.
        let settings = Settings::default();
        assert!(!settings.power.keep_awake);
        assert!(!settings.power.keep_awake_when_busy);
    }

    #[test]
    fn sleep_prevention_axes_round_trip_independently() {
        let json = r#"{ "power": { "keepAwakeWhenBusy": true } }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(settings.power.keep_awake_when_busy);
        // The policy must not drag the manual switch along with it (ADR-0116).
        assert!(!settings.power.keep_awake);

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"keepAwakeWhenBusy\":true"));
        assert!(serialized.contains("\"keepAwake\":false"));

        let reparsed: Settings = serde_json::from_str(&serialized).unwrap();
        assert!(reparsed.power.keep_awake_when_busy);
        assert!(!reparsed.power.keep_awake);
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
    fn workspace_selector_last_input_mode_defaults_to_per_pane() {
        let settings: Settings = serde_json::from_str(r#"{ "workspaceSelector": {} }"#).unwrap();
        assert_eq!(settings.workspace_selector.last_input_mode, "perPane");
    }

    #[test]
    fn workspace_selector_last_input_mode_round_trip() {
        let json = r#"{
          "workspaceSelector": {
            "lastInputMode": "workspaceLatest"
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.workspace_selector.last_input_mode,
            "workspaceLatest"
        );

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"lastInputMode\":\"workspaceLatest\""));
    }

    #[test]
    fn workspace_selector_destructive_confirmation_defaults_on() {
        let settings: Settings = serde_json::from_str(r#"{ "workspaceSelector": {} }"#).unwrap();
        assert!(settings.workspace_selector.confirm_destructive_actions);
    }

    #[test]
    fn workspace_selector_destructive_confirmation_round_trip() {
        let json = r#"{
          "workspaceSelector": {
            "confirmDestructiveActions": false
          }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert!(!settings.workspace_selector.confirm_destructive_actions);

        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("\"confirmDestructiveActions\":false"));
    }

    #[test]
    fn migrate_cmd_profile_to_powershell_in_workspace_panes() {
        let mut settings = Settings {
            workspaces: vec![Workspace {
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
            }],
            ..Settings::default()
        };
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
        let mut settings = Settings {
            workspaces: vec![
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
            ],
            ..Settings::default()
        };
        migrate_settings(&mut settings);
        let names: Vec<&str> = settings
            .workspaces
            .iter()
            .map(|w| w.name.as_str())
            .collect();
        assert_eq!(names, vec!["Dev", "Dev (2)", "Dev (3)"]);
    }

    #[test]
    fn migrate_heals_stale_cloud_relay_placeholder() {
        let mut settings = Settings::default();
        settings.remote.relay_base_url = LEGACY_CLOUD_RELAY_PLACEHOLDER.into();
        migrate_settings(&mut settings);
        assert_eq!(
            settings.remote.relay_base_url,
            default_cloud_relay_base_url()
        );

        // Trailing slash variant is also healed.
        settings.remote.relay_base_url = format!("{LEGACY_CLOUD_RELAY_PLACEHOLDER}/");
        migrate_settings(&mut settings);
        assert_eq!(
            settings.remote.relay_base_url,
            default_cloud_relay_base_url()
        );
    }

    #[test]
    fn migrate_keeps_custom_relay_url() {
        let mut settings = Settings::default();
        settings.remote.relay_base_url = "http://127.0.0.1:8000".into();
        migrate_settings(&mut settings);
        assert_eq!(settings.remote.relay_base_url, "http://127.0.0.1:8000");
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
        let settings = Settings {
            workspace_display_order: vec!["ws-2".into(), "ws-1".into()],
            ..Settings::default()
        };
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
