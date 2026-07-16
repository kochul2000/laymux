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

    let next_runtime = RemoteAccessRuntimeState {
        enabled,
        auth_token: if enabled { token } else { None },
    };
    let (status, remote_control_status, transition, timeout_seconds) = {
        let mut runtime = app_state.remote_access.lock_or_err()?;
        // `remote_access` precedes `remote_control` in AppState lock order.
        // Holding both for this short state-only transaction prevents a new
        // Remote permit from slipping between access disable and lease clear.
        let mut control = app_state.remote_control.lock_or_err()?;
        apply_runtime_access_change(&persistent, &mut runtime, &mut control, next_runtime)
    };

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

    Ok(status)
}

pub(crate) fn effective_remote_settings(app_state: &AppState) -> Result<RemoteSettings, String> {
    let mut settings = crate::settings::load_settings().remote;
    let runtime = app_state.remote_access.lock_or_err()?;
    apply_runtime_access(&mut settings, &runtime);
    Ok(settings)
}

/// Run a short owner-state transaction against the same effective access
/// snapshot. Claim uses this gate so a completed access disable cannot be
/// overtaken by a request that authenticated against an older runtime state.
pub(crate) fn with_effective_remote_control_state<R>(
    app_state: &AppState,
    operation: impl FnOnce(&RemoteSettings, &mut RemoteControlState) -> R,
) -> Result<R, String> {
    let mut settings = crate::settings::load_settings().remote;
    let runtime = app_state.remote_access.lock_or_err()?;
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
