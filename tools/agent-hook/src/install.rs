use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
mod command;
mod title;
#[cfg(test)]
mod update_tests;
mod updates;
pub use command::handler;
use command::OwnedHandlers;

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
pub const EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "PreCompact",
    "PostCompact",
];
pub fn events(provider: &str) -> Vec<&'static str> {
    EVENTS
        .iter()
        .copied()
        .chain(if provider == "codex" {
            vec!["Interrupt"]
        } else {
            vec![
                "PostToolUseFailure",
                "StopFailure",
                "Notification",
                "Elicitation",
                "ElicitationResult",
            ]
        })
        .collect()
}
const OWNED_DIRECTORY: &str = "laymux-hooks";

pub fn config_name(provider: &str) -> Result<&'static str, String> {
    match provider {
        "claude" => Ok("settings.json"),
        "codex" => Ok("hooks.json"),
        _ => Err("Unsupported agent hook provider".into()),
    }
}

pub fn default_root(provider: &str) -> Result<PathBuf, String> {
    config_name(provider)?;
    let key = if provider == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    };
    if let Some(root) = std::env::var_os(key).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or("User home unavailable")?;
    Ok(PathBuf::from(home).join(if provider == "codex" {
        ".codex"
    } else {
        ".claude"
    }))
}

fn read_config(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            return Err("Hook settings must be a regular file (symlink is not modified)".into());
        }
        Ok(_) => {}
    }
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_CONFIG_BYTES {
        return Err("Hook settings are too large".into());
    }
    Ok(Some(data))
}

fn parse_config(raw: Option<&[u8]>) -> Result<Value, String> {
    let value: Value = match raw {
        Some(raw) => serde_json::from_slice(raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw))
            .map_err(|e| format!("Invalid hook settings: {e}"))?,
        None => json!({}),
    };
    if !value.is_object() {
        return Err("Hook settings must be an object".into());
    }
    if let Some(hooks) = value.get("hooks") {
        let hooks = hooks.as_object().ok_or("hooks must be an object")?;
        for groups in hooks.values() {
            for group in groups.as_array().ok_or("Hook event must be an array")? {
                let handlers = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .ok_or("Hook group must contain a hooks array")?;
                if handlers.iter().any(|handler| !handler.is_object()) {
                    return Err("Hook handler must be an object".into());
                }
            }
        }
    }
    Ok(value)
}

fn helper_path(root: &Path) -> PathBuf {
    root.join(OWNED_DIRECTORY).join(if cfg!(windows) {
        "laymux-agent-hook.exe"
    } else {
        "laymux-agent-hook"
    })
}

fn registered(value: &Value, owned: &OwnedHandlers, provider: &str, current_only: bool) -> usize {
    events(provider)
        .iter()
        .filter(|event| {
            value
                .get("hooks")
                .and_then(|v| v.get(**event))
                .and_then(Value::as_array)
                .is_some_and(|groups| {
                    groups.iter().any(|group| {
                        group
                            .get("hooks")
                            .and_then(Value::as_array)
                            .is_some_and(|hooks| {
                                hooks.iter().any(|h| {
                                    if current_only {
                                        owned.matches_current(h)
                                    } else {
                                        owned.matches(h)
                                    }
                                })
                            })
                    })
                })
        })
        .count()
}

fn status(
    root: &Path,
    provider: &str,
    value: &Value,
    owned: &OwnedHandlers,
    executable: &Path,
) -> Result<Value, String> {
    let count = registered(value, owned, provider, false);
    let present = helper_path(root).is_file();
    let disabled: Result<bool, String> = if provider == "claude" {
        Ok(value
            .get("disableAllHooks")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    } else {
        (|| match read_config(&root.join("config.toml"))? {
            None => Ok(false),
            Some(bytes) => {
                let config: toml::Value =
                    toml::from_str(std::str::from_utf8(&bytes).map_err(|e| e.to_string())?)
                        .map_err(|e| format!("Invalid Codex config.toml: {e}"))?;
                let features = config.get("features");
                Ok(features
                    .and_then(|v| v.get("hooks").or_else(|| v.get("codex_hooks")))
                    .and_then(toml::Value::as_bool)
                    == Some(false))
            }
        })()
    };
    let warning = disabled
        .as_ref()
        .err()
        .map(|e| format!("Could not inspect config.toml: {e}"));
    let mut result = json!({"configDir":root, "configPath":root.join(config_name(provider)?), "installed":count==events(provider).len() && present,
        "registered":count, "expected":events(provider).len(), "helperPresent":present,
        "disabled":disabled.unwrap_or(false), "warning":warning,
        "titleBinding":if provider == "codex" { Some(title::status(root)) } else { None }});
    let current_count = registered(value, owned, provider, true);
    let owned_count = value
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(|group| group.get("hooks").and_then(Value::as_array))
                .flatten()
                .filter(|handler| owned.matches(handler))
                .count()
        })
        .unwrap_or(0);
    result["ownedCommands"] = json!(owned_count);
    updates::append_status(
        &mut result,
        root,
        executable,
        current_count,
        current_count == events(provider).len() && owned_count == events(provider).len(),
    );
    Ok(result)
}

fn edit(
    value: &mut Value,
    owned: &OwnedHandlers,
    install: bool,
    provider: &str,
) -> Result<(), String> {
    if !install && value.get("hooks").is_none() {
        return Ok(());
    }
    if value.get("hooks").is_none() {
        value["hooks"] = json!({});
    }
    let hooks = value["hooks"]
        .as_object_mut()
        .ok_or("hooks must be an object")?;
    for groups in hooks.values_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        // Command identity is stable when users adjust timeouts or move events.
        groups.retain_mut(|group| {
            let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = handlers.len();
            handlers.retain(|h| !owned.matches(h));
            handlers.len() == before || !handlers.is_empty()
        });
    }
    if install {
        for event in events(provider) {
            let groups = hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Hook event must be an array")?;
            groups.push(json!({"hooks":[owned.current]}));
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing settings parent")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    if let Ok(meta) = fs::metadata(path) {
        temp.as_file()
            .set_permissions(meta.permissions())
            .map_err(|e| e.to_string())?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn manage(
    root: &Path,
    provider: &str,
    operation: &str,
    executable: &Path,
) -> Result<Value, String> {
    let name = config_name(provider)?;
    if !root.is_absolute() || !matches!(operation, "status" | "install" | "remove" | "update") {
        return Err("Absolute config directory and valid operation required".into());
    }
    let path = root.join(name);
    let owned = OwnedHandlers::new(root, provider)?;
    if operation == "status" || (matches!(operation, "remove" | "update") && !root.exists()) {
        return status(
            root,
            provider,
            &parse_config(read_config(&path)?.as_deref())?,
            &owned,
            executable,
        );
    }
    // Validate before creating artifacts or touching the existing configuration.
    parse_config(read_config(&path)?.as_deref())?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join(".laymux-hooks.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|e| format!("Another Laymux hook change is in progress: {e}"))?;
    let original = read_config(&path)?;
    let mut value = parse_config(original.as_deref())?;
    let title_change = if provider == "codex" && operation == "install" {
        Some(title::prepare(root)?)
    } else {
        None
    };
    let current = status(root, provider, &value, &owned, executable)?;
    // A notification can be stale after a user removes hooks. Never install anew.
    if operation == "update" && current["ownedCommands"] == 0 && current["helperPresent"] == false {
        return Ok(current);
    }
    let installing = matches!(operation, "install" | "update");
    let before = value.clone();
    edit(&mut value, &owned, installing, provider)?;
    if installing {
        let destination = helper_path(root);
        if destination
            .parent()
            .and_then(|p| fs::symlink_metadata(p).ok())
            .is_some_and(|m| m.file_type().is_symlink())
        {
            return Err("Laymux hook helper directory must not be a symlink".into());
        }
        let bytes = fs::read(executable).map_err(|e| format!("Hook helper unavailable: {e}"))?;
        fs::create_dir_all(destination.parent().ok_or("Missing helper parent")?)
            .map_err(|e| e.to_string())?;
        if fs::read(&destination).ok().as_deref() != Some(bytes.as_slice()) {
            atomic_write(&destination, &bytes)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    if value != before {
        if read_config(&path)? != original {
            return Err("Hook settings changed concurrently; retry".into());
        }
        if let Some(original) = &original {
            let mut backup = tempfile::Builder::new()
                .prefix(&format!("{name}.laymux-backup-"))
                .tempfile_in(root)
                .map_err(|e| e.to_string())?;
            backup.write_all(original).map_err(|e| e.to_string())?;
            backup.as_file().sync_all().map_err(|e| e.to_string())?;
            backup.keep().map_err(|e| e.to_string())?;
        }
        let mut bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        atomic_write(&path, &bytes)?;
    }
    if let Some(change) = title_change {
        change.apply(root)?;
    }
    let title_warning = if provider == "codex" && operation == "remove" {
        title::remove(root).err()
    } else {
        None
    };
    if operation == "remove" {
        // No recursive delete: retain backups and any files added by the user.
        let helper = helper_path(root);
        if helper
            .parent()
            .and_then(|p| fs::symlink_metadata(p).ok())
            .is_some_and(|m| m.file_type().is_symlink())
        {
            return Err("Hooks removed; helper directory is a symlink and was retained".into());
        }
        match fs::remove_file(&helper) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Hooks removed; helper cleanup failed: {e}")),
        }
    }
    let mut result = status(root, provider, &value, &owned, executable)?;
    if let Some(warning) = title_warning {
        result["titleBinding"]["warning"] = json!(warning);
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
