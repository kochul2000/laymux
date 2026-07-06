use std::sync::Arc;

use tauri::State;

use super::{keyring_store, pairing, CloudStatus};
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

#[tauri::command]
pub fn get_cloud_status(state: State<Arc<AppState>>) -> Result<CloudStatus, String> {
    get_cloud_status_inner(&state).map_err(Into::into)
}

pub fn get_cloud_status_inner(state: &AppState) -> Result<CloudStatus, AppError> {
    Ok(state.cloud.lock_or_err()?.clone())
}

#[tauri::command]
pub async fn cloud_connect_start(state: State<'_, Arc<AppState>>) -> Result<CloudStatus, String> {
    pairing::cloud_connect_start_inner(state.inner().clone())
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn cloud_disconnect(state: State<'_, Arc<AppState>>) -> Result<CloudStatus, String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || cloud_disconnect_inner(&state))
        .await
        .map_err(|e| format!("Cloud disconnect task failed: {e}"))?
        .map_err(Into::into)
}

pub fn cloud_disconnect_inner(state: &AppState) -> Result<CloudStatus, AppError> {
    Ok(cloud_disconnect_best_effort(state))
}

fn cloud_disconnect_best_effort(state: &AppState) -> CloudStatus {
    let mut errors = Vec::new();

    if let Err(error) = keyring_store::delete_device_token() {
        errors.push(format!("keyring delete failed: {error}"));
    }

    let mut settings = crate::settings::load_settings();
    settings.remote.cloud_enabled = false;
    settings.remote.cloud_instance_id = None;
    settings.remote.cloud_tunnel_url = None;
    settings.remote.cloud_server_base_url = None;
    if let Err(error) = crate::settings::save_settings(&settings).map_err(AppError::Other) {
        errors.push(format!("settings save failed: {error}"));
    }

    let mut next_status = disconnected_status(&errors);
    match state.cloud.lock_or_err() {
        Ok(mut cloud) => {
            *cloud = next_status.clone();
        }
        Err(error) => {
            errors.push(format!("state reset failed: {error}"));
            next_status = disconnected_status(&errors);
        }
    }

    next_status
}

fn disconnected_status(errors: &[String]) -> CloudStatus {
    CloudStatus {
        connected: false,
        instance_id: None,
        last_error: if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::Path;

    use serial_test::serial;

    use super::*;
    use crate::settings::{load_settings, save_settings, Settings};

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

    #[test]
    fn get_cloud_status_reads_app_state() {
        let state = AppState::new();
        *state.cloud.lock_or_err().unwrap() = CloudStatus {
            connected: true,
            instance_id: Some("instance-1".into()),
            last_error: Some("transient".into()),
        };

        let status = get_cloud_status_inner(&state).unwrap();

        assert!(status.connected);
        assert_eq!(status.instance_id.as_deref(), Some("instance-1"));
        assert_eq!(status.last_error.as_deref(), Some("transient"));
    }

    #[test]
    #[serial]
    fn cloud_disconnect_deletes_token_saves_settings_and_resets_state() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        keyring_store::reset_mock_store().unwrap();

        let mut settings = Settings::default();
        settings.remote.cloud_enabled = true;
        settings.remote.cloud_instance_id = Some("instance-1".into());
        settings.remote.cloud_tunnel_url =
            Some("wss://relay.example.test/tunnel/instance-1".into());
        settings.remote.cloud_server_base_url = Some("https://relay.example.test".into());
        settings.remote.relay_base_url = "https://relay.example.test".into();
        save_settings(&settings).unwrap();
        keyring_store::set_device_token("device-token").unwrap();

        let state = AppState::new();
        *state.cloud.lock_or_err().unwrap() = CloudStatus {
            connected: true,
            instance_id: Some("instance-1".into()),
            last_error: Some("old error".into()),
        };

        let status = cloud_disconnect_inner(&state).unwrap();

        assert_eq!(status, CloudStatus::default());
        assert_eq!(keyring_store::get_device_token().unwrap(), None);
        let loaded = load_settings();
        assert!(!loaded.remote.cloud_enabled);
        assert_eq!(loaded.remote.cloud_instance_id, None);
        assert_eq!(loaded.remote.cloud_tunnel_url, None);
        assert_eq!(loaded.remote.cloud_server_base_url, None);
        assert_eq!(loaded.remote.relay_base_url, "https://relay.example.test");
        assert_eq!(*state.cloud.lock_or_err().unwrap(), CloudStatus::default());
    }

    #[test]
    #[serial]
    fn cloud_disconnect_cleans_settings_and_state_when_keyring_delete_fails() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        keyring_store::reset_mock_store().unwrap();

        let mut settings = Settings::default();
        settings.remote.cloud_enabled = true;
        settings.remote.cloud_instance_id = Some("instance-1".into());
        settings.remote.cloud_tunnel_url =
            Some("wss://relay.example.test/tunnel/instance-1".into());
        settings.remote.cloud_server_base_url = Some("https://relay.example.test".into());
        save_settings(&settings).unwrap();
        keyring_store::set_device_token("device-token").unwrap();
        keyring_store::set_mock_error(keyring::Error::Invalid(
            "delete".into(),
            "forced failure".into(),
        ))
        .unwrap();

        let state = AppState::new();
        *state.cloud.lock_or_err().unwrap() = CloudStatus {
            connected: true,
            instance_id: Some("instance-1".into()),
            last_error: Some("old error".into()),
        };

        let status = cloud_disconnect_inner(&state).unwrap();

        assert!(!status.connected);
        assert_eq!(status.instance_id, None);
        assert!(status
            .last_error
            .as_deref()
            .unwrap()
            .contains("keyring delete failed"));
        let loaded = load_settings();
        assert!(!loaded.remote.cloud_enabled);
        assert_eq!(loaded.remote.cloud_instance_id, None);
        assert_eq!(loaded.remote.cloud_tunnel_url, None);
        assert_eq!(loaded.remote.cloud_server_base_url, None);
        let state_status = state.cloud.lock_or_err().unwrap().clone();
        assert!(!state_status.connected);
        assert_eq!(state_status.instance_id, None);
        assert!(state_status
            .last_error
            .as_deref()
            .unwrap()
            .contains("keyring delete failed"));
        assert_eq!(
            keyring_store::get_device_token().unwrap().as_deref(),
            Some("device-token")
        );
    }
}
