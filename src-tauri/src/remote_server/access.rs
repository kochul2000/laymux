use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants::EVENT_REMOTE_CONTROL_CHANGED;
use crate::lock_ext::MutexExt;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

use super::lease::{
    effective_heartbeat_timeout_seconds, status_from_state, wait_for_remote_owner_transition,
    RemoteControlState, RemoteControlStatus, RemoteOwnerTransition,
};

/// Direct Remote Mode runtime override plus the persisted Remote settings
/// snapshot used by latency-sensitive owner checks.
#[derive(Debug, Clone)]
pub struct RemoteAccessRuntimeState {
    pub enabled: bool,
    pub auth_token: Option<String>,
    persistent: RemoteSettings,
}

impl RemoteAccessRuntimeState {
    pub(crate) fn new(persistent: RemoteSettings) -> Self {
        Self {
            enabled: false,
            auth_token: None,
            persistent,
        }
    }

    fn persistent(&self) -> &RemoteSettings {
        &self.persistent
    }

    fn replace_persistent(&mut self, persistent: RemoteSettings) {
        self.persistent = persistent;
    }
}

impl Default for RemoteAccessRuntimeState {
    fn default() -> Self {
        Self::new(RemoteSettings::default())
    }
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
    let runtime = app_state.remote_access.lock_or_err()?;
    Ok(status_from_settings(runtime.persistent(), &runtime))
}

pub fn set_remote_runtime_access(
    app_state: &AppState,
    app_handle: &AppHandle,
    enabled: bool,
    auth_token: Option<String>,
) -> Result<RemoteAccessStatus, String> {
    let token = auth_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let (status, remote_control_status, transition, timeout_seconds) = {
        let mut runtime = app_state.remote_access.lock_or_err()?;
        let persistent = runtime.persistent().clone();
        if enabled && persistent.auth_token.trim().is_empty() && token.is_none() {
            return Err("runtime remote access requires a token".into());
        }
        let mut next_runtime = runtime.clone();
        next_runtime.enabled = enabled;
        next_runtime.auth_token = if enabled { token } else { None };
        // `remote_access` precedes `remote_control` in AppState lock order.
        // Holding both for this short state-only transaction prevents a new
        // Remote permit from slipping between access disable and lease clear.
        let mut control = app_state.remote_control.lock_or_err()?;
        apply_runtime_access_change(&persistent, &mut runtime, &mut control, next_runtime)
    };

    complete_access_change(
        app_state,
        app_handle,
        remote_control_status,
        transition,
        timeout_seconds,
    )?;

    Ok(status)
}

pub(crate) fn effective_remote_settings(app_state: &AppState) -> Result<RemoteSettings, String> {
    let runtime = app_state.remote_access.lock_or_err()?;
    let mut settings = runtime.persistent().clone();
    apply_runtime_access(&mut settings, &runtime);
    Ok(settings)
}

pub(crate) fn update_persistent_remote_settings(
    app_state: &AppState,
    app_handle: &AppHandle,
    settings: RemoteSettings,
) -> Result<Option<bool>, String> {
    let (previous_enabled, status, remote_control_status, transition, timeout_seconds) = {
        let mut runtime = app_state.remote_access.lock_or_err()?;
        let previous_enabled =
            status_from_settings(runtime.persistent(), &runtime).effective_enabled;
        let mut control = app_state.remote_control.lock_or_err()?;
        let (status, remote_control_status, transition, timeout_seconds) =
            apply_persistent_access_change(&mut runtime, &mut control, settings);
        (
            previous_enabled,
            status,
            remote_control_status,
            transition,
            timeout_seconds,
        )
    };

    complete_access_change(
        app_state,
        app_handle,
        remote_control_status,
        transition,
        timeout_seconds,
    )?;
    Ok((previous_enabled != status.effective_enabled).then_some(status.effective_enabled))
}

/// Cloud pairing/disconnect only owns the persisted cloud fields. Keeping this
/// update field-scoped prevents those paths from bypassing the lifecycle-aware
/// owner transition if `enabled` changed elsewhere.
pub(crate) fn update_persistent_cloud_settings_snapshot(
    app_state: &AppState,
    settings: &RemoteSettings,
) -> Result<(), String> {
    let mut runtime = app_state.remote_access.lock_or_err()?;
    let persistent = &mut runtime.persistent;
    persistent.cloud_enabled = settings.cloud_enabled;
    persistent
        .relay_base_url
        .clone_from(&settings.relay_base_url);
    persistent
        .cloud_instance_id
        .clone_from(&settings.cloud_instance_id);
    persistent
        .cloud_tunnel_url
        .clone_from(&settings.cloud_tunnel_url);
    persistent
        .cloud_server_base_url
        .clone_from(&settings.cloud_server_base_url);
    persistent.cloud_auto_reconnect = settings.cloud_auto_reconnect;
    Ok(())
}

/// Run a short owner-state transaction against the same effective access
/// snapshot. Claim uses this gate so a completed access disable cannot be
/// overtaken by a request that authenticated against an older runtime state.
pub(crate) fn with_effective_remote_control_state<R>(
    app_state: &AppState,
    operation: impl FnOnce(&RemoteSettings, &mut RemoteControlState) -> R,
) -> Result<R, String> {
    let runtime = app_state.remote_access.lock_or_err()?;
    let mut settings = runtime.persistent().clone();
    apply_runtime_access(&mut settings, &runtime);
    let mut control = app_state.remote_control.lock_or_err()?;
    Ok(operation(&settings, &mut control))
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

fn apply_runtime_access_change(
    persistent: &RemoteSettings,
    runtime: &mut RemoteAccessRuntimeState,
    control: &mut RemoteControlState,
    next_runtime: RemoteAccessRuntimeState,
) -> (
    RemoteAccessStatus,
    Option<RemoteControlStatus>,
    Option<RemoteOwnerTransition>,
    u64,
) {
    let status = status_from_settings(persistent, &next_runtime);
    let mut effective = persistent.clone();
    apply_runtime_access(&mut effective, &next_runtime);
    let timeout_seconds = effective_heartbeat_timeout_seconds(&effective);
    let (remote_control_status, transition) =
        if !status.effective_enabled || !status.auth_token_configured {
            let transition = control.begin_remote_owner_transition(std::time::Instant::now());
            control.reclaim_lockout_until = None;
            (
                Some(status_from_state(control, timeout_seconds)),
                transition,
            )
        } else {
            (None, None)
        };

    // Disable becomes authoritative before the lock-free cancellation wait;
    // the old lease remains published as `transitioning` until acknowledgement.
    *runtime = next_runtime;
    (status, remote_control_status, transition, timeout_seconds)
}

fn apply_persistent_access_change(
    runtime: &mut RemoteAccessRuntimeState,
    control: &mut RemoteControlState,
    persistent: RemoteSettings,
) -> (
    RemoteAccessStatus,
    Option<RemoteControlStatus>,
    Option<RemoteOwnerTransition>,
    u64,
) {
    let mut next_runtime = runtime.clone();
    next_runtime.replace_persistent(persistent.clone());
    apply_runtime_access_change(&persistent, runtime, control, next_runtime)
}

fn complete_access_change(
    app_state: &AppState,
    app_handle: &AppHandle,
    remote_control_status: Option<RemoteControlStatus>,
    transition: Option<RemoteOwnerTransition>,
    timeout_seconds: u64,
) -> Result<(), String> {
    if let Some(remote_control_status) = &remote_control_status {
        if let Err(err) = app_handle.emit(EVENT_REMOTE_CONTROL_CHANGED, remote_control_status) {
            tracing::warn!(error = %err, "failed to emit remote-control-changed");
        }
    }
    if let Some(transition) = transition {
        wait_for_remote_owner_transition(app_state, transition)?;
        let mut control = app_state.remote_control.lock_or_err()?;
        let finalized = control.finalize_owner_transition_if_drained(transition);
        let final_status = status_from_state(&control, timeout_seconds);
        if finalized {
            if let Err(err) = app_handle.emit(EVENT_REMOTE_CONTROL_CHANGED, final_status) {
                tracing::warn!(error = %err, "failed to emit remote-control-changed");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn update_persistent_remote_settings_for_test(
    app_state: &AppState,
    settings: RemoteSettings,
) -> Result<(), String> {
    let mut runtime = app_state.remote_access.lock_or_err()?;
    let mut control = app_state.remote_control.lock_or_err()?;
    apply_persistent_access_change(&mut runtime, &mut control, settings);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock_ext::MutexExt;
    use crate::remote_server::{
        begin_human_control_operation, HumanControlOrigin, RemoteControlLease,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn runtime_access_enables_effective_remote_without_persisting_flag() {
        let persistent = RemoteSettings::default();
        let runtime = RemoteAccessRuntimeState {
            enabled: true,
            auth_token: Some("runtime-token".into()),
            ..RemoteAccessRuntimeState::default()
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
            ..RemoteAccessRuntimeState::default()
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

    #[test]
    fn disabling_runtime_access_is_atomic_with_the_remote_owner_gate() {
        let state = AppState::new();
        {
            let mut runtime = state.remote_access.lock_or_err().unwrap();
            runtime.enabled = true;
            runtime.auth_token = Some("runtime-token".into());
        }
        state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: "lease-1".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
        let permit = begin_human_control_operation(
            &state,
            HumanControlOrigin::Remote {
                lease_id: "lease-1".into(),
            },
            "t1",
        )
        .unwrap();
        let persistent = RemoteSettings::default();
        let disabled = RemoteAccessRuntimeState::default();

        let result = {
            let mut runtime = state.remote_access.lock_or_err().unwrap();
            let mut control = state.remote_control.lock_or_err().unwrap();
            apply_runtime_access_change(&persistent, &mut runtime, &mut control, disabled)
        };

        let transition = result.2.expect("busy Remote owner starts a barrier");
        assert!(!state.remote_access.lock_or_err().unwrap().enabled);
        let control = state.remote_control.lock_or_err().unwrap();
        assert!(control.lease.is_some());
        assert!(control.transitioning);
        drop(control);
        assert!(!permit.is_current());

        drop(permit);
        wait_for_remote_owner_transition(&state, transition).unwrap();
        state
            .remote_control
            .lock_or_err()
            .unwrap()
            .finalize_owner_transition_if_drained(transition);
        assert!(!state.remote_access.lock_or_err().unwrap().enabled);
        assert!(state.remote_control.lock_or_err().unwrap().lease.is_none());
    }

    #[test]
    fn disabling_runtime_access_cancels_a_pending_claim_reservation() {
        let persistent = RemoteSettings::default();
        let mut runtime = RemoteAccessRuntimeState {
            enabled: true,
            auth_token: Some("runtime-token".into()),
            ..RemoteAccessRuntimeState::default()
        };
        let mut control = RemoteControlState::default();
        control.create_claim_reservation(Instant::now(), Duration::from_secs(2));
        assert!(control.has_claim_reservation());

        let result = apply_runtime_access_change(
            &persistent,
            &mut runtime,
            &mut control,
            RemoteAccessRuntimeState::default(),
        );

        assert!(result.2.is_none());
        assert!(!control.has_claim_reservation());
        assert!(!runtime.enabled);
    }

    #[test]
    fn disabling_persistent_access_starts_the_remote_owner_transition() {
        let persistent = RemoteSettings {
            enabled: true,
            auth_token: "persistent-token".into(),
            ..RemoteSettings::default()
        };
        let mut runtime = RemoteAccessRuntimeState::new(persistent);
        let mut control = RemoteControlState::default();
        control.lease = Some(RemoteControlLease {
            lease_id: "lease-1".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });

        let result =
            apply_persistent_access_change(&mut runtime, &mut control, RemoteSettings::default());

        assert!(!result.0.effective_enabled);
        assert!(result.1.is_some(), "the disabled status must be emitted");
        assert!(result.2.is_some(), "an active lease needs a drain barrier");
        assert!(control.transitioning);
        assert!(!runtime.persistent().enabled);
    }

    #[test]
    fn remote_claim_gate_holds_access_and_owner_locks_together() {
        let state = AppState::new();
        {
            let mut runtime = state.remote_access.lock_or_err().unwrap();
            runtime.enabled = true;
            runtime.auth_token = Some("runtime-token".into());
        }

        let observed = with_effective_remote_control_state(&state, |settings, control| {
            assert!(state.remote_access.try_lock().is_err());
            assert!(state.remote_control.try_lock().is_err());
            (settings.enabled, control.lease.is_none())
        })
        .unwrap();

        assert_eq!(observed, (true, true));
    }
}
