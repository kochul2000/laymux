use crate::error::AppError;
use crate::settings::Settings;
use serde_json::Value;
use std::collections::BTreeMap;

const MACHINE_PATHS: &[&str] = &[
    "/terminal/composerStarredEntries",
    "/remote",
    "/claude/command",
    "/codex/command",
    "/grok/command",
    "/paneClear/shellCommand",
    "/paste/imageDir",
    "/issueReporter/shell",
    "/usage/claude/configDirs",
    "/usage/codex/configDirs",
    "/usage/grok/configDirs",
    "/fileExplorer/extensionViewers",
];
pub type MachineConfiguration = BTreeMap<String, Value>;
pub fn split_configuration(settings: &Settings) -> Result<(Value, MachineConfiguration), AppError> {
    let mut value = serde_json::to_value(settings)?;
    let mut machine = BTreeMap::new();
    for path in MACHINE_PATHS {
        if let Some(v) = take_pointer(&mut value, path) {
            machine.insert((*path).into(), v);
        }
    }
    if let Some(profiles) = value["profiles"].as_array_mut() {
        let mut names = std::collections::HashSet::new();
        for profile in profiles {
            let name = profile["name"]
                .as_str()
                .ok_or_else(|| AppError::Other("Profile name missing".into()))?
                .to_owned();
            if !names.insert(name.clone()) {
                return Err(AppError::Other(format!(
                    "Duplicate local profile identity: {name}"
                )));
            }
            for field in ["commandLine", "startupCommand", "startingDirectory"] {
                if let Some(v) = profile.as_object_mut().and_then(|p| p.remove(field)) {
                    machine.insert(
                        format!("profile:{}:{field}", serde_json::to_string(&name)?),
                        v,
                    );
                }
            }
        }
    }
    for key in [
        "workspaces",
        "docks",
        "workspaceDisplayOrder",
        "localUiState",
    ] {
        value.as_object_mut().map(|o| o.remove(key));
    }
    if let Some(layouts) = value["layouts"].as_array_mut() {
        for layout in layouts {
            let id = layout["id"].as_str().unwrap_or_default().to_owned();
            if let Some(panes) = layout["panes"].as_array_mut() {
                for (index, pane) in panes.iter_mut().enumerate() {
                    let prefix = layout_prefix(&id, index, pane)?;
                    if let Some(config) = pane["viewConfig"].as_object_mut() {
                        for (key, v) in config.iter() {
                            if !portable_view_key(key) && !key.starts_with("last") {
                                machine.insert(format!("{prefix}{key}"), v.clone());
                            }
                        }
                        config.retain(|key, _| portable_view_key(key));
                    }
                }
            }
        }
    }
    Ok((value, machine))
}
pub fn portable_value(settings: &Settings) -> Result<Value, AppError> {
    Ok(split_configuration(settings)?.0)
}
pub(crate) fn apply_configuration(
    settings: &mut Settings,
    machine: MachineConfiguration,
) -> Result<(), AppError> {
    let mut value = portable_value(settings)?;
    for (path, v) in &machine {
        if MACHINE_PATHS.contains(&path.as_str()) {
            set_pointer(&mut value, path, v.clone())?;
        }
    }
    if let Some(profiles) = value["profiles"].as_array_mut() {
        for profile in profiles {
            let name = profile["name"]
                .as_str()
                .ok_or_else(|| AppError::Other("Profile name missing".into()))?
                .to_owned();
            for field in ["commandLine", "startupCommand", "startingDirectory"] {
                if let Some(v) = machine.get(&format!(
                    "profile:{}:{field}",
                    serde_json::to_string(&name)?
                )) {
                    profile[field] = v.clone();
                }
            }
        }
    }
    if let Some(layouts) = value["layouts"].as_array_mut() {
        for layout in layouts {
            let id = layout["id"].as_str().unwrap_or_default().to_owned();
            for (index, pane) in layout["panes"]
                .as_array_mut()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let prefix = layout_prefix(&id, index, pane)?;
                for (path, v) in &machine {
                    if let Some(field) = path.strip_prefix(&prefix) {
                        if !pane["viewConfig"].is_object() {
                            pane["viewConfig"] = serde_json::json!({});
                        }
                        pane["viewConfig"][field] = v.clone();
                    }
                }
            }
        }
    }
    *settings = serde_json::from_value(value)?;
    for profile in &mut settings.profiles {
        if profile.command_line.is_empty() {
            profile.command_line = if cfg!(windows) && profile.name == "WSL" {
                "wsl.exe".into()
            } else if cfg!(windows) {
                "powershell.exe -NoLogo".into()
            } else {
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
            };
        }
    }
    Ok(())
}
fn take_pointer(value: &mut Value, path: &str) -> Option<Value> {
    let (parent, key) = path.rsplit_once('/')?;
    value.pointer_mut(parent)?.as_object_mut()?.remove(key)
}
fn portable_view_key(key: &str) -> bool {
    matches!(key, "type" | "profile" | "cwdSend" | "cwdReceive")
}
fn layout_prefix(id: &str, index: usize, pane: &Value) -> Result<String, AppError> {
    use sha2::Digest;
    let mut portable = pane.clone();
    if let Some(config) = portable["viewConfig"].as_object_mut() {
        config.retain(|key, _| portable_view_key(key));
    }
    let digest = sha2::Sha256::digest(serde_json::to_vec(&portable)?);
    Ok(format!(
        "layout:{}:{index}:{digest:x}:",
        serde_json::to_string(id)?
    ))
}
fn set_pointer(value: &mut Value, path: &str, item: Value) -> Result<(), AppError> {
    let (parent, key) = path
        .rsplit_once('/')
        .ok_or_else(|| AppError::Other("Invalid local settings path".into()))?;
    let map = value
        .pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| AppError::Other(format!("Local settings parent missing: {parent}")))?;
    map.insert(key.into(), item);
    Ok(())
}
