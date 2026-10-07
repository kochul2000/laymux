//! Read-only audit of existing hooks in distributions enumerated as running.
use super::{connections, manage_with_timeout, ManageRequest, MANAGE_TIMEOUT};
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

fn target_key(request: &ManageRequest, path: &str) -> (String, Option<String>, String) {
    let mut path = path.trim_end_matches(['/', '\\']).to_owned();
    if request.distro.is_none() && cfg!(windows) {
        path = path.replace('\\', "/").to_lowercase();
    }
    (request.provider.clone(), request.distro.clone(), path)
}

fn scan_with_budget(
    requests: &[ManageRequest],
    mut remaining: impl FnMut() -> Duration,
    mut inspect: impl FnMut(&ManageRequest, Duration) -> Result<Value, AppError>,
) -> Value {
    let mut targets = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    for request in requests {
        // A default root may also be reported by a live CLI observation. Skip
        // that alias before launching WSL, rather than deduplicating only output.
        if request
            .config_dir
            .as_deref()
            .is_some_and(|path| seen.contains(&target_key(request, path)))
        {
            continue;
        }
        let timeout = remaining().min(MANAGE_TIMEOUT);
        if timeout.is_zero() {
            errors.push(json!({"provider":null,"distro":null,"configDir":null,"message":"Hook update check exceeded its time budget; remaining targets were not checked"}));
            break;
        }
        let mut result = inspect(request, timeout);
        // Only a read-only WSL status timeout can be transient. Do not retry
        // configuration errors or any mutation, and share the audit deadline.
        if request.distro.is_some()
            && request.operation == "status"
            && matches!(&result, Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::TimedOut)
        {
            let timeout = remaining().min(MANAGE_TIMEOUT);
            if !timeout.is_zero() {
                result = inspect(request, timeout);
            }
        }
        match result {
            Ok(status) => {
                let path = status["configDir"].as_str().unwrap_or_default();
                if seen.insert(target_key(request, path)) {
                    targets.push(json!({"provider":request.provider,"distro":request.distro,"status":status}));
                }
            }
            Err(error) => errors.push(json!({"provider":request.provider,"distro":request.distro,"configDir":request.config_dir,"message":error.to_string()})),
        }
    }
    json!({"targets":targets,"errors":errors})
}

pub fn audit(state: &AppState, app: &tauri::AppHandle) -> Result<Value, AppError> {
    let deadline = Instant::now() + AUDIT_BUDGET;
    #[cfg(windows)]
    let (running, environment_error) = match running_distros() {
        Ok(running) => (running, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    #[cfg(not(windows))]
    let (running, environment_error): (Vec<String>, Option<String>) = (Vec::new(), None);
    // Release the observation lock before any file I/O or child process call.
    let requests = requests(&running, &connections(state)?);
    let mut result = scan_with_budget(
        &requests,
        || deadline.saturating_duration_since(Instant::now()),
        |request, timeout| manage_with_timeout(request, app, timeout),
    );
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
        let result = scan_with_budget(
            &values,
            || AUDIT_BUDGET,
            |r, _| {
                if r.provider == "claude" && r.distro.is_none() {
                    return Err(AppError::Other("invalid config".into()));
                }
                Ok(json!({"configDir":"/config", "updateRequired":r.distro.is_some()}))
            },
        );
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert_eq!(result["targets"].as_array().unwrap().len(), 3);
        assert!(result["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["status"]["updateRequired"] == true));
    }

    fn timed_out() -> AppError {
        std::io::Error::new(std::io::ErrorKind::TimedOut, "WSL stalled").into()
    }

    #[test]
    fn a_transient_wsl_timeout_is_retried_without_reporting_a_false_failure() {
        let values = requests(&["Ubuntu".into()], &[]);
        let mut attempts = 0;
        let result = scan_with_budget(
            &values,
            || AUDIT_BUDGET,
            |r, _| {
                if r.distro.is_some() && r.provider == "claude" {
                    attempts += 1;
                    if attempts == 1 {
                        return Err(timed_out());
                    }
                }
                Ok(json!({"configDir":format!("/{}", r.provider)}))
            },
        );
        assert_eq!(attempts, 2);
        assert!(result["errors"].as_array().unwrap().is_empty());
        assert_eq!(result["targets"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn persistent_timeouts_are_retried_once_and_other_errors_are_not_retried() {
        let values = requests(&["Ubuntu".into()], &[]);
        let mut attempts = Vec::new();
        let result = scan_with_budget(
            &values,
            || AUDIT_BUDGET,
            |r, _| {
                attempts.push((r.provider.clone(), r.distro.clone()));
                if r.distro.is_some() && r.provider == "claude" {
                    Err(timed_out())
                } else {
                    Err(AppError::Other("invalid config".into()))
                }
            },
        );
        assert_eq!(attempts.len(), 5);
        assert_eq!(result["errors"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn retries_and_later_targets_share_the_remaining_audit_budget() {
        use std::cell::Cell;
        let remaining = Cell::new(AUDIT_BUDGET);
        let values = requests(&["Ubuntu".into()], &[]);
        let mut wsl_limits = Vec::new();
        let result = scan_with_budget(
            &values,
            || remaining.get(),
            |r, timeout| {
                if r.distro.is_some() {
                    wsl_limits.push(timeout);
                    remaining.set(remaining.get().saturating_sub(timeout));
                    return Err(timed_out());
                }
                Ok(json!({"configDir":format!("/{}", r.provider)}))
            },
        );
        assert_eq!(
            wsl_limits,
            vec![
                Duration::from_secs(8),
                Duration::from_secs(8),
                Duration::from_secs(4)
            ]
        );
        assert_eq!(remaining.get(), Duration::ZERO);
        assert_eq!(result["targets"].as_array().unwrap().len(), 2);
        assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn an_observed_default_root_is_not_inspected_twice() {
        let observations =
            vec![json!({"provider":"claude","distro":"Ubuntu","configDir":"/home/user/.claude/"})];
        let values = requests(&["Ubuntu".into()], &observations);
        let mut calls = 0;
        let result = scan_with_budget(
            &values,
            || AUDIT_BUDGET,
            |r, _| {
                if r.provider == "claude" && r.distro.is_some() {
                    calls += 1;
                    if r.config_dir.is_some() {
                        return Err(timed_out());
                    }
                }
                Ok(json!({"configDir":format!("/home/user/.{}", r.provider)}))
            },
        );
        assert_eq!(calls, 1);
        assert!(result["errors"].as_array().unwrap().is_empty());
        assert_eq!(result["targets"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn no_process_is_started_after_the_audit_budget_is_exhausted() {
        let values = requests(&["Ubuntu".into()], &[]);
        let result = scan_with_budget(
            &values,
            || Duration::ZERO,
            |_, _| panic!("exhausted audit must not inspect another target"),
        );
        assert!(result["targets"].as_array().unwrap().is_empty());
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn native_timeouts_and_mutations_are_not_retried() {
        let values = vec![
            ManageRequest {
                provider: "claude".into(),
                operation: "status".into(),
                distro: None,
                config_dir: None,
            },
            ManageRequest {
                provider: "codex".into(),
                operation: "update".into(),
                distro: Some("Ubuntu".into()),
                config_dir: None,
            },
        ];
        let mut attempts = 0;
        let result = scan_with_budget(
            &values,
            || AUDIT_BUDGET,
            |_, _| {
                attempts += 1;
                Err(timed_out())
            },
        );
        assert_eq!(attempts, 2);
        assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_timeout_that_exhausts_the_budget_is_not_retried() {
        use std::cell::Cell;
        let remaining = Cell::new(Duration::from_secs(1));
        let values = requests(&["Ubuntu".into()], &[]);
        let mut attempts = 0;
        let result = scan_with_budget(
            &values[2..],
            || remaining.get(),
            |_, timeout| {
                assert_eq!(timeout, Duration::from_secs(1));
                attempts += 1;
                remaining.set(Duration::ZERO);
                Err(timed_out())
            },
        );
        assert_eq!(attempts, 1);
        assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn distinct_wsl_roots_and_providers_are_still_inspected() {
        let observations = vec![
            json!({"provider":"claude","distro":"Ubuntu","configDir":"/home/user/.Claude"}),
            json!({"provider":"codex","distro":"Ubuntu","configDir":"/home/user/.claude"}),
        ];
        let values = requests(&["Ubuntu".into()], &observations);
        let mut attempts = 0;
        let result = scan_with_budget(
            &values,
            || AUDIT_BUDGET,
            |r, _| {
                attempts += 1;
                Ok(
                    json!({"configDir":r.config_dir.clone().unwrap_or_else(|| format!("/home/user/.{}", r.provider))}),
                )
            },
        );
        assert_eq!(attempts, 6);
        assert_eq!(result["targets"].as_array().unwrap().len(), 6);
    }

    #[cfg(windows)]
    #[test]
    fn live_wsl_status_timeout_recovers_with_one_read_only_retry() {
        let Ok(distro) = std::env::var("LAYMUX_TEST_WSL_DISTRO") else {
            return;
        };
        // The timeout marker stays in this fixture; no real CLI settings or
        // discovery file is modified, and no running CLI is restarted.
        let fixture = tempfile::tempdir().unwrap();
        let executable = fixture.path().join("laymux-agent-hook-wsl");
        std::fs::write(&executable, b"#!/bin/sh\nmarker=\"${0}.attempt\"\nif [ ! -f \"$marker\" ]; then\n  printf first > \"$marker\"\n  exec sleep 3\nfi\nprintf '{\"configDir\":\"/fixture\",\"updateRequired\":false}\\n'\n").unwrap();
        let request = ManageRequest {
            provider: "claude".into(),
            operation: "status".into(),
            distro: Some(distro),
            config_dir: Some("/fixture".into()),
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut attempts = 0;
        let result = scan_with_budget(
            &[request],
            || deadline.saturating_duration_since(Instant::now()),
            |request, timeout| {
                attempts += 1;
                super::super::manage_in_directory_with_timeout(
                    request,
                    fixture.path(),
                    timeout.min(Duration::from_secs(1)),
                )
            },
        );
        assert_eq!(attempts, 2);
        assert!(result["errors"].as_array().unwrap().is_empty(), "{result}");
        assert_eq!(result["targets"][0]["status"]["configDir"], "/fixture");
    }
}
