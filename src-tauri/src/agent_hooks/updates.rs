//! Read-only audit of existing hooks in distributions enumerated as running.
use super::{connections, manage, ManageRequest};
use crate::{error::AppError, state::AppState};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

const AUDIT_BUDGET: Duration = Duration::from_secs(20);

#[cfg(any(windows, test))]
fn is_audit_distro(name: &str) -> bool {
    crate::wsl_probe::is_safe_distro_name(name)
        && !matches!(name, "docker-desktop" | "docker-desktop-data")
}

#[cfg(windows)]
fn running_distros() -> Result<Vec<String>, AppError> {
    let mut command = crate::process::headless_command("wsl.exe");
    command.args(["--list", "--running", "--quiet"]);
    let output =
        crate::process::output_with_timeout(&mut command, std::time::Duration::from_secs(3))?;
    if !output.status.success() {
        return Err(AppError::Other(
            "Could not list running WSL distributions".into(),
        ));
    }
    let words: Vec<_> = output
        .stdout
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    Ok(String::from_utf16_lossy(&words)
        .lines()
        .map(str::trim)
        .filter(|s| is_audit_distro(s))
        .map(String::from)
        .collect())
}

fn requests(running: &[String], observations: &[Value]) -> Vec<ManageRequest> {
    let mut requests = Vec::new();
    for distro in std::iter::once(None).chain(running.iter().cloned().map(Some)) {
        for provider in ["claude", "codex"] {
            requests.push(ManageRequest {
                provider: provider.into(),
                operation: "status".into(),
                distro: distro.clone(),
                config_dir: None,
            });
        }
    }
    for entry in observations {
        let distro = entry["distro"].as_str().map(String::from);
        if distro.as_ref().is_some_and(|d| !running.contains(d)) {
            continue;
        }
        let (Some(provider @ ("claude" | "codex")), Some(root)) =
            (entry["provider"].as_str(), entry["configDir"].as_str())
        else {
            continue;
        };
        if root.is_empty() {
            continue;
        }
        let request = ManageRequest {
            provider: provider.into(),
            operation: "status".into(),
            distro,
            config_dir: Some(root.into()),
        };
        if !requests.iter().any(|r| {
            r.provider == request.provider
                && r.distro == request.distro
                && r.config_dir == request.config_dir
        }) {
            requests.push(request);
        }
    }
    requests
}

fn scan(
    requests: &[ManageRequest],
    mut inspect: impl FnMut(&ManageRequest) -> Result<Value, AppError>,
) -> Value {
    let mut targets = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    let started = Instant::now();
    for request in requests {
        if started.elapsed() >= AUDIT_BUDGET {
            errors.push(json!({"provider":null,"distro":null,"configDir":null,"message":"Hook update check exceeded its time budget; remaining targets were not checked"}));
            break;
        }
        match inspect(request) {
            Ok(status) => {
                let mut path = status["configDir"].as_str().unwrap_or_default().trim_end_matches(['/', '\\']).to_owned();
                if request.distro.is_none() && cfg!(windows) { path = path.replace('\\', "/").to_lowercase(); }
                if seen.insert((request.provider.clone(), request.distro.clone(), path)) {
                    targets.push(json!({"provider":request.provider,"distro":request.distro,"status":status}));
                }
            }
            Err(error) => errors.push(json!({"provider":request.provider,"distro":request.distro,"configDir":request.config_dir,"message":error.to_string()})),
        }
    }
    json!({"targets":targets,"errors":errors})
}

pub fn audit(state: &AppState, app: &tauri::AppHandle) -> Result<Value, AppError> {
    #[cfg(windows)]
    let (running, environment_error) = match running_distros() {
        Ok(running) => (running, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    #[cfg(not(windows))]
    let (running, environment_error): (Vec<String>, Option<String>) = (Vec::new(), None);
    // Release the observation lock before any file I/O or child process call.
    let requests = requests(&running, &connections(state)?);
    let mut result = scan(&requests, |request| manage(request, app));
    if let Some(message) = environment_error {
        if let Some(errors) = result["errors"].as_array_mut() {
            errors.push(json!({"provider":null,"distro":null,"configDir":null,"message":message}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn infrastructure_distributions_are_left_for_explicit_management() {
        assert!(!is_audit_distro("docker-desktop"));
        assert!(!is_audit_distro("docker-desktop-data"));
        assert!(is_audit_distro("Ubuntu-22.04"));
        assert!(!is_audit_distro("bad/distro"));
    }
    #[test]
    fn audit_only_checks_native_running_wsl_and_observed_custom_roots() {
        let observations = vec![
            json!({"provider":"codex","distro":"Stopped","configDir":"/custom"}),
            json!({"provider":"codex","distro":"Ubuntu","configDir":"/custom"}),
            json!({"provider":"codex","distro":"Ubuntu","configDir":"/custom"}),
            json!({"provider":"claude","distro":null,"configDir":"/native-custom"}),
        ];
        let values = requests(&["Ubuntu".into()], &observations);
        assert_eq!(values.len(), 6);
        assert!(values
            .iter()
            .all(|r| r.operation == "status" && r.distro.as_deref() != Some("Stopped")));
        assert!(values
            .iter()
            .any(|r| r.config_dir.as_deref() == Some("/native-custom")));
    }
    #[test]
    fn one_failed_target_does_not_hide_updates_in_other_environments() {
        let values = requests(&["Ubuntu".into()], &[]);
        let result = scan(&values, |r| {
            if r.provider == "claude" && r.distro.is_none() {
                return Err(AppError::Other("invalid config".into()));
            }
            Ok(json!({"configDir":"/config", "updateRequired":r.distro.is_some()}))
        });
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert_eq!(result["targets"].as_array().unwrap().len(), 3);
        assert!(result["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["status"]["updateRequired"] == true));
    }
}
