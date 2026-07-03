use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants::EVENT_REMOTE_CONTROL_CHANGED;
use crate::lock_ext::MutexExt;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

use super::lease::{effective_heartbeat_timeout_seconds, status_from_state};

/// Runtime-only Direct Remote Mode gate. This is intentionally not persisted.
#[derive(Debug, Clone, Default)]
pub struct RemoteAccessRuntimeState {
    pub enabled: bool,
    pub auth_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub effective_enabled: bool,
    pub persistent_enabled: bool,
    pub runtime_enabled: bool,
    pub auth_token_configured: bool,
    pub effective_auth_token: String,
}

pub fn get_remote_access_status(app_state: &AppState) -> Result<RemoteAccessStatus, String> {
    let persistent = crate::settings::load_settings().remote;
    let runtime = app_state.remote_access.lock_or_err()?;
    Ok(status_from_settings(&persistent, &runtime))
}

pub fn set_remote_runtime_access(
    app_state: &AppState,
    app_handle: &AppHandle,
    enabled: bool,
    auth_token: Option<String>,
) -> Result<RemoteAccessStatus, String> {
    let persistent = crate::settings::load_settings().remote;
    let token = auth_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if enabled && persistent.auth_token.trim().is_empty() && token.is_none() {
        return Err("runtime remote access requires a token".into());
    }

    let status = {
        let mut runtime = app_state.remote_access.lock_or_err()?;
        runtime.enabled = enabled;
        runtime.auth_token = if enabled { token } else { None };
        status_from_settings(&persistent, &runtime)
    };

    if !status.effective_enabled || !status.auth_token_configured {
        clear_remote_control_lease(app_state, app_handle)?;
    }

    Ok(status)
}

pub(crate) fn effective_remote_settings(app_state: &AppState) -> Result<RemoteSettings, String> {
    let mut settings = crate::settings::load_settings().remote;
    let runtime = app_state.remote_access.lock_or_err()?;
    apply_runtime_access(&mut settings, &runtime);
    Ok(settings)
}

fn status_from_settings(
    persistent: &RemoteSettings,
    runtime: &RemoteAccessRuntimeState,
) -> RemoteAccessStatus {
    let mut effective = persistent.clone();
    apply_runtime_access(&mut effective, runtime);
    RemoteAccessStatus {
        effective_enabled: effective.enabled,
        persistent_enabled: persistent.enabled,
        runtime_enabled: runtime.enabled,
        auth_token_configured: !effective.auth_token.trim().is_empty(),
        effective_auth_token: effective.auth_token,
    }
}

fn apply_runtime_access(settings: &mut RemoteSettings, runtime: &RemoteAccessRuntimeState) {
    if !runtime.enabled {
        return;
    }

    settings.enabled = true;
    if settings.auth_token.trim().is_empty() {
        settings.auth_token = runtime.auth_token.clone().unwrap_or_default();
    }
}

fn clear_remote_control_lease(app_state: &AppState, app_handle: &AppHandle) -> Result<(), String> {
    let status = {
        let settings = crate::settings::load_settings().remote;
        let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
        let mut control = app_state.remote_control.lock_or_err()?;
        control.lease = None;
        status_from_state(&control, timeout_seconds)
    };

    if let Err(err) = app_handle.emit(EVENT_REMOTE_CONTROL_CHANGED, status) {
        tracing::warn!(error = %err, "failed to emit remote-control-changed");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_access_enables_effective_remote_without_persisting_flag() {
        let persistent = RemoteSettings::default();
        let runtime = RemoteAccessRuntimeState {
            enabled: true,
            auth_token: Some("runtime-token".into()),
        };

        let status = status_from_settings(&persistent, &runtime);

        assert!(status.effective_enabled);
        assert!(!status.persistent_enabled);
        assert!(status.runtime_enabled);
        assert_eq!(status.effective_auth_token, "runtime-token");
    }

    #[test]
    fn persistent_token_takes_precedence_over_runtime_token() {
        let persistent = RemoteSettings {
            enabled: true,
            auth_token: "persistent-token".into(),
            ..RemoteSettings::default()
        };
        let runtime = RemoteAccessRuntimeState {
            enabled: true,
            auth_token: Some("runtime-token".into()),
        };

        let status = status_from_settings(&persistent, &runtime);

        assert!(status.effective_enabled);
        assert!(status.persistent_enabled);
        assert!(status.runtime_enabled);
        assert_eq!(status.effective_auth_token, "persistent-token");
    }

    #[test]
    fn disabled_runtime_does_not_override_persistent_remote() {
        let persistent = RemoteSettings {
            enabled: true,
            auth_token: "persistent-token".into(),
            ..RemoteSettings::default()
        };
        let runtime = RemoteAccessRuntimeState::default();

        let status = status_from_settings(&persistent, &runtime);

        assert!(status.effective_enabled);
        assert!(status.persistent_enabled);
        assert!(!status.runtime_enabled);
    }
}
