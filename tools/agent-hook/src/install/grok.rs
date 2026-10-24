use std::path::{Path, PathBuf};

/// Grok policy pins are additive and non-boolean values also engage the pin.
pub(super) fn disabled(root: &Path) -> Result<bool, String> {
    let mut paths: Vec<_> = ["config.toml", "managed_config.toml", "requirements.toml"]
        .into_iter()
        .map(|name| root.join(name))
        .collect();
    if cfg!(unix) {
        paths.extend(
            ["managed_config.toml", "requirements.toml"]
                .into_iter()
                .map(|name| Path::new("/etc/grok").join(name)),
        );
    }
    // Grok also imports Claude's machine-managed policy on these platforms.
    if cfg!(target_os = "linux") {
        paths.push("/etc/claude-code/managed-settings.json".into());
    } else if cfg!(target_os = "macos") {
        paths.push("/Library/Application Support/ClaudeCode/managed-settings.json".into());
    }
    disabled_in_paths(paths)
}

fn disabled_in_paths(paths: Vec<PathBuf>) -> Result<bool, String> {
    for path in paths {
        let Some(bytes) = super::read_config(&path)? else {
            continue;
        };
        let config: serde_json::Value = if path.extension().is_some_and(|ext| ext == "json") {
            serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))
                .map_err(|e| e.to_string())?
        } else {
            let config: toml::Value =
                toml::from_str(std::str::from_utf8(&bytes).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            serde_json::to_value(config).map_err(|e| e.to_string())?
        };
        if !config.is_object() {
            return Err("Hook policy must be an object".into());
        }
        if ["allow_managed_hooks_only", "allowManagedHooksOnly"]
            .iter()
            .any(|key| {
                config
                    .get(*key)
                    .is_some_and(|pin| pin.as_bool() != Some(false))
            })
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_managed_hook_pin_is_additive_and_policy_files_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        let managed = dir.path().join("managed-settings.json");
        std::fs::write(&user, "allow_managed_hooks_only = false\n").unwrap();
        for pin in [
            serde_json::json!(true),
            serde_json::json!("invalid"),
            serde_json::json!(null),
        ] {
            let contents = serde_json::to_vec(
                &serde_json::json!({"allowManagedHooksOnly":pin,"unrelated":"preserved"}),
            )
            .unwrap();
            std::fs::write(&managed, &contents).unwrap();
            assert!(disabled_in_paths(vec![user.clone(), managed.clone()]).unwrap());
            assert!(disabled_in_paths(vec![managed.clone(), user.clone()]).unwrap());
            assert_eq!(std::fs::read(&managed).unwrap(), contents);
        }
        std::fs::write(&managed, r#"{"allowManagedHooksOnly":false}"#).unwrap();
        assert!(!disabled_in_paths(vec![user, managed]).unwrap());
    }
    #[test]
    fn grok_managed_policy_is_not_released_by_a_user_false_or_an_invalid_pin() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        let managed = dir.path().join("requirements.toml");
        std::fs::write(&user, "allow_managed_hooks_only = false\n").unwrap();
        for value in ["true", "\"invalid\""] {
            std::fs::write(&managed, format!("allowManagedHooksOnly = {value}\n")).unwrap();
            assert!(disabled_in_paths(vec![user.clone(), managed.clone()]).unwrap());
        }
        std::fs::write(&managed, "allow_managed_hooks_only = false\n").unwrap();
        assert!(!disabled_in_paths(vec![user, managed]).unwrap());
    }
}
