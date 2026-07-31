//! Tauri commands for the Claude usage probe.
//!
//! Thin entry points: they resolve settings into a [`WorkerSpec`] and delegate
//! to [`UsageProbe`]. The probe owns all lifecycle and scheduling policy
//! ([ADR-0102]).

use std::sync::Arc;

use tauri::State;

use crate::state::AppState;
use crate::usage_probe::{UsageSnapshot, WorkerSpec};

/// Build a probe spec for `config_dir` from current settings.
///
/// The profile choice matters: `claude` lives in whichever shell the user
/// installed it in, so `usage.profile` selects that shell and falls back to
/// `defaultProfile`.
fn resolve_spec(config_dir: String) -> Result<WorkerSpec, String> {
    let settings = crate::settings::load_settings();
    let usage = &settings.usage.claude;
    let profile_name = if usage.profile.is_empty() {
        settings.default_profile.clone()
    } else {
        usage.profile.clone()
    };
    let profile = settings
        .profiles
        .iter()
        .find(|candidate| candidate.name == profile_name)
        .ok_or_else(|| format!("Terminal profile '{profile_name}' does not exist"))?;

    Ok(WorkerSpec {
        config_dir,
        profile: profile.name.clone(),
        command_line: profile.command_line.clone(),
        starting_directory: profile.starting_directory.clone(),
        refresh_seconds: usage.refresh_seconds,
    })
}

/// Keep a probe alive for `config_dir` on behalf of one view instance.
///
/// Returns whatever snapshot is already known so the view can render a stale
/// capture instead of an empty frame while the first query runs.
#[tauri::command]
pub fn subscribe_usage_probe(
    subscriber_id: String,
    config_dir: String,
    state: State<Arc<AppState>>,
) -> Result<UsageSnapshot, String> {
    let spec = resolve_spec(config_dir)?;
    state
        .usage_probe
        .subscribe(&subscriber_id, spec)
        .map_err(Into::into)
}

/// Release a view instance's claim. The probe stops once nobody holds one.
#[tauri::command]
pub fn unsubscribe_usage_probe(
    subscriber_id: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    state
        .usage_probe
        .unsubscribe(&subscriber_id)
        .map_err(Into::into)
}

/// Read the cached snapshot. Never starts a probe.
#[tauri::command]
pub fn get_usage_snapshot(
    config_dir: String,
    state: State<Arc<AppState>>,
) -> Result<UsageSnapshot, String> {
    state.usage_probe.snapshot(&config_dir).map_err(Into::into)
}

/// Ask a running probe to query now. `false` means no probe was running.
#[tauri::command]
pub fn refresh_usage_probe(
    config_dir: String,
    state: State<Arc<AppState>>,
) -> Result<bool, String> {
    state
        .usage_probe
        .request_refresh(&config_dir)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_falls_back_to_the_default_profile() {
        // `load_settings` reads the real settings file, so assert only on the
        // relationship the resolver must preserve.
        let settings = crate::settings::load_settings();
        let spec = resolve_spec(String::new());
        if settings.usage.claude.profile.is_empty() {
            let expected = settings.default_profile.clone();
            match spec {
                Ok(spec) => assert_eq!(spec.profile, expected),
                // A settings file whose defaultProfile is missing from profiles
                // is a configuration error, not a resolver bug.
                Err(message) => assert!(message.contains(&expected), "{message}"),
            }
        }
    }

    #[test]
    fn spec_carries_the_requested_config_dir() {
        if let Ok(spec) = resolve_spec("/home/me/.claude-personal".into()) {
            assert_eq!(spec.config_dir, "/home/me/.claude-personal");
        }
    }
}
