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
    disabled_in_paths(paths)
}

fn disabled_in_paths(paths: Vec<PathBuf>) -> Result<bool, String> {
    for path in paths {
        let Some(bytes) = super::read_config(&path)? else {
            continue;
        };
        let config: toml::Value =
            toml::from_str(std::str::from_utf8(&bytes).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if config
            .get("allow_managed_hooks_only")
            .or_else(|| config.get("allowManagedHooksOnly"))
            .is_some_and(|pin| pin.as_bool() != Some(false))
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
