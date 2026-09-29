use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
pub const EVENTS: &[&str] = &["SessionStart", "SessionEnd"];
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

pub fn handler(root: &Path, provider: &str) -> Result<Value, String> {
    config_name(provider)?;
    let executable = helper_path(root);
    let path = executable.to_str().ok_or("Invalid helper path")?;
    #[cfg(windows)]
    let command = {
        use base64::Engine;
        let script = format!("& '{}' emit {provider}", path.replace('\'', "''"));
        let encoded: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!("powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(encoded))
    };
    #[cfg(not(windows))]
    let command = format!("'{}' emit {provider}", path.replace('\'', "'\\''"));
    Ok(json!({"type":"command", "command":command, "timeout":3}))
}

fn registered(value: &Value, owned: &Value) -> usize {
    EVENTS
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
                            .is_some_and(|hooks| hooks.iter().any(|h| is_owned(h, owned)))
                    })
                })
        })
        .count()
}

fn is_owned(handler: &Value, owned: &Value) -> bool {
    handler.get("type") == owned.get("type") && handler.get("command") == owned.get("command")
}

fn status(root: &Path, provider: &str, value: &Value, owned: &Value) -> Result<Value, String> {
    let count = registered(value, owned);
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
    Ok(
        json!({"configDir":root, "configPath":root.join(config_name(provider)?), "installed":count==EVENTS.len() && present,
        "registered":count, "expected":EVENTS.len(), "helperPresent":present,
        "disabled":disabled.unwrap_or(false), "warning":warning}),
    )
}

fn edit(value: &mut Value, owned: &Value, install: bool) -> Result<(), String> {
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
            handlers.retain(|h| !is_owned(h, owned));
            handlers.len() == before || !handlers.is_empty()
        });
    }
    if install {
        for event in EVENTS {
            let groups = hooks
                .entry(*event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Hook event must be an array")?;
            groups.push(json!({"hooks":[owned]}));
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
    if !root.is_absolute() || !matches!(operation, "status" | "install" | "remove") {
        return Err("Absolute config directory and valid operation required".into());
    }
    let path = root.join(name);
    let owned = handler(root, provider)?;
    if operation == "status" || (operation == "remove" && !root.exists()) {
        return status(
            root,
            provider,
            &parse_config(read_config(&path)?.as_deref())?,
            &owned,
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
    status(root, provider, &value, &owned)?;
    let before = value.clone();
    edit(&mut value, &owned, operation == "install")?;
    if operation == "install" {
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
    status(root, provider, &value, &owned)
}

#[cfg(test)]
mod tests;
