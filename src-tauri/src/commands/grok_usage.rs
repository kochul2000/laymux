//! Tauri commands for the Grok usage probe (ADR-0154).
//!
//! Thin entry points: they resolve settings into a [`WorkerSpec`] and delegate
//! to [`GrokUsageProbe`]. Reads never start a worker.

use std::sync::Arc;

use tauri::State;

use crate::grok_usage_probe::{GrokUsageSnapshot, WorkerSpec};
use crate::state::AppState;

fn resolve_spec(config_dir: String) -> Result<WorkerSpec, String> {
    let settings = crate::settings::load_settings();
    let usage = &settings.usage.grok;
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

#[tauri::command]
pub fn subscribe_grok_usage_probe(
    subscriber_id: String,
    config_dir: String,
    state: State<Arc<AppState>>,
) -> Result<GrokUsageSnapshot, String> {
    let spec = resolve_spec(config_dir)?;
    state
        .grok_usage_probe
        .subscribe(&subscriber_id, spec)
        .map_err(Into::into)
}

#[tauri::command]
pub fn unsubscribe_grok_usage_probe(
    subscriber_id: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    state
        .grok_usage_probe
        .unsubscribe(&subscriber_id)
        .map_err(Into::into)
}

#[tauri::command]
pub fn get_grok_usage_snapshot(
    config_dir: String,
    state: State<Arc<AppState>>,
) -> Result<GrokUsageSnapshot, String> {
    state
        .grok_usage_probe
        .snapshot(&config_dir)
        .map_err(Into::into)
}

#[tauri::command]
pub fn refresh_grok_usage_probe(
    config_dir: String,
    state: State<Arc<AppState>>,
) -> Result<bool, String> {
    state
        .grok_usage_probe
        .request_refresh(&config_dir)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_carries_the_requested_config_dir() {
        if let Ok(spec) = resolve_spec("/home/me/.grok-work".into()) {
            assert_eq!(spec.config_dir, "/home/me/.grok-work");
        }
    }
}
