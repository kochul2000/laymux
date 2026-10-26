//! Explicit Settings inspection; never used as live hook/installation evidence.
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::AppError;
use crate::process::{headless_command, headless_wsl_command, output_with_timeout};

// The marker is emitted only after a complete lookup, independently of helper
// availability. A failed shell/WSL launch must never establish absence.
const LOOKUP: &str = r#"
found=$(command -v "$1" 2>/dev/null)
if [ -n "$found" ] && [ -f "$found" ] && [ -x "$found" ]; then
  printf '\nLAYMUX_AGENT_INSTALLED\n'; exit 0
fi
for dir in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.bun/bin"; do
  if [ -f "$dir/$1" ] && [ -x "$dir/$1" ]; then
    printf '\nLAYMUX_AGENT_INSTALLED\n'; exit 0
  fi
done
old_ifs=$IFS; IFS=:
for dir in $PATH "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.bun/bin"; do
  if [ -z "$dir" ] || [ "${dir#/}" = "$dir" ]; then exit 2; fi
  if [ -e "$dir/$1" ] && [ ! -x "$dir/$1" ]; then exit 2; fi
  # Walk to an existing ancestor so an inaccessible parent is not mistaken
  # for a nonexistent search directory.
  parent=$dir
  while [ ! -e "$parent" ] && [ "$parent" != / ]; do
    parent=${parent%/*}; parent=${parent:-/}
  done
  if [ ! -d "$parent" ] || [ ! -r "$parent" ] || [ ! -x "$parent" ]; then exit 2; fi
done
IFS=$old_ifs
if [ -z "$PATH" ] || [ -z "$HOME" ]; then exit 2; fi
printf '\nLAYMUX_AGENT_MISSING\n'
"#;

pub(super) fn inspect(provider: &str, distro: Option<&str>) -> Result<Value, AppError> {
    laymux_agent_hook::install::config_name(provider).map_err(AppError::Other)?;
    if distro.is_some_and(|d| !cfg!(windows) || !crate::wsl_probe::is_safe_distro_name(d)) {
        return Err(AppError::Other("Invalid WSL distribution".into()));
    }
    let result = if cfg!(windows) && distro.is_none() {
        native_windows(provider)
    } else {
        let mut command = match distro {
            Some(distro) => {
                let mut command = headless_wsl_command();
                command.args(["-d", distro, "--exec", "sh"]);
                command
            }
            None => headless_command("sh"),
        };
        command.args(["-lc", LOOKUP, "laymux-agent-check", provider]);
        output_with_timeout(&mut command, Duration::from_secs(8))
            .map_err(|e| e.to_string())
            .and_then(|output| {
                parse_lookup(output.status.success(), &output.stdout).map_err(|_| {
                    format!(
                        "Agent installation lookup failed ({}): {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr).trim()
                    )
                })
            })
    };
    Ok(match result {
        Ok(true) => json!({"status":"installed"}),
        Ok(false) => json!({"status":"missing"}),
        Err(detail) => json!({"status":"unknown", "detail":detail}),
    })
}

fn parse_lookup(success: bool, stdout: &[u8]) -> Result<bool, ()> {
    if !success {
        return Err(());
    }
    match String::from_utf8_lossy(stdout).trim().lines().last() {
        Some("LAYMUX_AGENT_INSTALLED") => Ok(true),
        Some("LAYMUX_AGENT_MISSING") => Ok(false),
        _ => Err(()),
    }
}

fn native_windows(provider: &str) -> Result<bool, String> {
    let path = std::env::var_os("PATH").ok_or("PATH is unavailable")?;
    let mut directories: Vec<_> = std::env::split_paths(&path).collect();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        directories.push(PathBuf::from(&home).join(".local/bin"));
        directories.push(PathBuf::from(home).join(".bun/bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(local).join("Microsoft/WinGet/Links"));
    }
    lookup_paths(provider, &directories)
}

fn lookup_paths(provider: &str, directories: &[PathBuf]) -> Result<bool, String> {
    let mut failure = None;
    for directory in directories {
        if !directory.is_absolute() {
            failure = Some("Relative executable search path cannot be verified".into());
            continue;
        }
        for extension in ["exe", "cmd", "bat"] {
            match executable_file(&directory.join(format!("{provider}.{extension}"))) {
                Ok(true) => return Ok(true),
                Ok(false) => (),
                Err(error) => failure = Some(error),
            }
        }
    }
    match failure {
        Some(error) => Err(error),
        None if directories.is_empty() => Err("PATH is empty".into()),
        None => Ok(false),
    }
}

fn executable_file(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_successful_explicit_lookup_establishes_missing() {
        assert_eq!(parse_lookup(true, b"LAYMUX_AGENT_MISSING\n"), Ok(false));
        assert_eq!(
            parse_lookup(true, b"profile output\nLAYMUX_AGENT_INSTALLED\n"),
            Ok(true)
        );
        for output in [b"".as_slice(), b"error", b"{\"error\":\"helper failed\"}"] {
            assert!(parse_lookup(false, output).is_err());
            assert!(parse_lookup(true, output).is_err());
        }
        assert!(parse_lookup(false, b"LAYMUX_AGENT_MISSING\n").is_err());
    }

    #[test]
    fn windows_lookup_is_per_provider_and_accepts_native_and_npm_installations() {
        let root = tempfile::tempdir().unwrap();
        let dirs = vec![root.path().to_path_buf()];
        for provider in ["claude", "codex", "grok"] {
            assert!(!lookup_paths(provider, &dirs).unwrap());
            for extension in ["exe", "cmd", "bat"] {
                let path = root.path().join(format!("{provider}.{extension}"));
                std::fs::write(&path, "test fixture").unwrap();
                assert!(lookup_paths(provider, &dirs).unwrap());
                std::fs::remove_file(path).unwrap();
            }
        }
        assert!(lookup_paths("codex", &[]).is_err());
        assert!(lookup_paths("codex", &[PathBuf::from("relative")]).is_err());
        assert!(lookup_paths("codex", &[root.path().join("invalid\0path")]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn shell_lookup_distinguishes_missing_installed_and_nonexecutable() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let run = || {
            let output = headless_command("/bin/sh")
                .args(["-c", LOOKUP, "test", "codex"])
                .env("PATH", root.path())
                .env("HOME", root.path())
                .output()
                .unwrap();
            parse_lookup(output.status.success(), &output.stdout)
        };
        assert_eq!(run(), Ok(false));
        let binary = root.path().join("codex");
        std::fs::write(&binary, "CLI must never be executed").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(run().is_err());
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(run(), Ok(true));
    }
}
