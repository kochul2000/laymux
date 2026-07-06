use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants::EVENT_REMOTE_CONTROL_CHANGED;
use crate::lock_ext::MutexExt;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

use super::access::effective_remote_settings;
use super::{internal_error, json_error};

const MIN_HEARTBEAT_TIMEOUT_SECONDS: u64 = 5;

/// Internal controller lease for Direct Remote Mode.
#[derive(Debug, Clone)]
pub struct RemoteControlLease {
    pub lease_id: String,
    pub remote_addr: String,
    pub client_name: Option<String>,
    pub last_heartbeat: Instant,
}

#[derive(Debug, Default)]
pub struct RemoteControlState {
    pub lease: Option<RemoteControlLease>,
    pub reclaim_lockout_until: Option<Instant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub active: bool,
    pub lease_id: Option<String>,
    pub remote_addr: Option<String>,
    pub client_name: Option<String>,
    pub heartbeat_timeout_seconds: u64,
}

pub fn get_remote_control_status(app_state: &AppState) -> Result<RemoteControlStatus, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let mut current = app_state.remote_control.lock_or_err()?;
    if !settings.enabled {
        current.lease = None;
        current.reclaim_lockout_until = None;
        return Ok(status_from_state(&current, timeout_seconds));
    }
    prune_expired_lease(&mut current.lease, Duration::from_secs(timeout_seconds));
    prune_expired_reclaim_lockout(&mut current, Instant::now());
    Ok(status_from_state(&current, timeout_seconds))
}

pub fn reclaim_remote_control(
    app_state: &AppState,
    app_handle: &AppHandle,
) -> Result<RemoteControlStatus, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let status = {
        let mut current = app_state.remote_control.lock_or_err()?;
        current.lease = None;
        start_reclaim_lockout(
            &mut current,
            Duration::from_secs(timeout_seconds),
            Instant::now(),
        );
        status_from_state(&current, timeout_seconds)
    };
    emit_remote_control_status(app_handle, &status);
    Ok(status)
}

pub(crate) fn effective_heartbeat_timeout_seconds(settings: &RemoteSettings) -> u64 {
    settings
        .heartbeat_timeout_seconds
        .max(MIN_HEARTBEAT_TIMEOUT_SECONDS)
}

pub(crate) fn status_from_lease(
    lease: &Option<RemoteControlLease>,
    heartbeat_timeout_seconds: u64,
) -> RemoteControlStatus {
    match lease {
        Some(lease) => RemoteControlStatus {
            active: true,
            lease_id: Some(lease.lease_id.clone()),
            remote_addr: Some(lease.remote_addr.clone()),
            client_name: lease.client_name.clone(),
            heartbeat_timeout_seconds,
        },
        None => RemoteControlStatus {
            active: false,
            lease_id: None,
            remote_addr: None,
            client_name: None,
            heartbeat_timeout_seconds,
        },
    }
}

pub(crate) fn status_from_state(
    state: &RemoteControlState,
    heartbeat_timeout_seconds: u64,
) -> RemoteControlStatus {
    status_from_lease(&state.lease, heartbeat_timeout_seconds)
}

pub(crate) fn prune_expired_lease(lease: &mut Option<RemoteControlLease>, timeout: Duration) {
    if lease
        .as_ref()
        .is_some_and(|current| current.last_heartbeat.elapsed() > timeout)
    {
        *lease = None;
    }
}

pub(crate) fn start_reclaim_lockout(
    state: &mut RemoteControlState,
    duration: Duration,
    now: Instant,
) {
    state.reclaim_lockout_until = Some(now + duration);
}

pub(crate) fn reclaim_lockout_active(state: &mut RemoteControlState, now: Instant) -> bool {
    match state.reclaim_lockout_until {
        Some(until) if until > now => true,
        Some(_) => {
            state.reclaim_lockout_until = None;
            false
        }
        None => false,
    }
}

pub(crate) fn prune_expired_reclaim_lockout(state: &mut RemoteControlState, now: Instant) {
    if state
        .reclaim_lockout_until
        .is_some_and(|until| until <= now)
    {
        state.reclaim_lockout_until = None;
    }
}

pub(crate) fn emit_remote_control_status(app_handle: &AppHandle, status: &RemoteControlStatus) {
    if let Err(err) = app_handle.emit(EVENT_REMOTE_CONTROL_CHANGED, status) {
        tracing::warn!(error = %err, "failed to emit remote-control-changed");
    }
}

pub(crate) fn require_active_lease(
    app_state: &AppState,
    lease_id: Option<&str>,
) -> Result<(), Response> {
    let Some(lease_id) = lease_id.filter(|value| !value.is_empty()) else {
        return Err(json_error(
            StatusCode::CONFLICT,
            "remote controller lease is required",
        ));
    };

    match active_lease_matches(app_state, lease_id) {
        Ok(true) => Ok(()),
        Ok(false) => Err(json_error(
            StatusCode::CONFLICT,
            "remote controller lease is not active",
        )),
        Err(err) => Err(internal_error(err)),
    }
}

pub(crate) fn active_lease_matches(app_state: &AppState, lease_id: &str) -> Result<bool, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    active_lease_matches_with_timeout(app_state, lease_id, Duration::from_secs(timeout_seconds))
}

pub(crate) fn active_lease_matches_with_timeout(
    app_state: &AppState,
    lease_id: &str,
    timeout: Duration,
) -> Result<bool, String> {
    let mut current = app_state.remote_control.lock_or_err()?;
    prune_expired_lease(&mut current.lease, timeout);
    Ok(current
        .lease
        .as_ref()
        .is_some_and(|current| current.lease_id == lease_id))
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::Path;

    use super::*;
    use serial_test::serial;

    use crate::settings::{save_settings, Settings};

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = env::var(key).ok();
            env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("APPDATA", dir)
    }

    #[cfg(not(target_os = "windows"))]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("HOME", dir)
    }

    fn save_remote_settings(enabled: bool, auth_token: &str) {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = auth_token.into();
        save_settings(&settings).unwrap();
    }

    fn state_with_active_lease(lease_id: &str) -> AppState {
        let state = AppState::new();
        {
            let mut control = state.remote_control.lock_or_err().unwrap();
            control.lease = Some(RemoteControlLease {
                lease_id: lease_id.into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: Instant::now(),
            });
        }
        state
    }

    #[test]
    fn expired_lease_is_pruned() {
        let mut lease = Some(RemoteControlLease {
            lease_id: "lease".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now() - Duration::from_secs(20),
        });
        prune_expired_lease(&mut lease, Duration::from_secs(5));
        assert!(lease.is_none());
    }

    #[test]
    fn reclaim_lockout_expires_after_duration() {
        let now = Instant::now();
        let mut state = RemoteControlState::default();
        start_reclaim_lockout(&mut state, Duration::from_secs(5), now);

        assert!(reclaim_lockout_active(
            &mut state,
            now + Duration::from_secs(4)
        ));
        assert!(!reclaim_lockout_active(
            &mut state,
            now + Duration::from_secs(5)
        ));
        assert!(state.reclaim_lockout_until.is_none());
    }

    #[test]
    #[serial]
    fn remote_status_keeps_active_lease_when_enabled_with_empty_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "");
        let state = state_with_active_lease("lease-1");

        let status = get_remote_control_status(&state).unwrap();

        assert!(status.active);
        assert_eq!(status.lease_id.as_deref(), Some("lease-1"));
        assert!(state.remote_control.lock_or_err().unwrap().lease.is_some());
    }

    #[test]
    #[serial]
    fn remote_status_clears_active_lease_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(false, "");
        let state = state_with_active_lease("lease-1");

        let status = get_remote_control_status(&state).unwrap();

        assert!(!status.active);
        assert!(status.lease_id.is_none());
        assert!(state.remote_control.lock_or_err().unwrap().lease.is_none());
    }
}
