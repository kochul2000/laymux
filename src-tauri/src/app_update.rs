//! Process-global desktop update coordinator.
//!
//! GitHub/Tauri is the transport and signature verifier; this module owns the
//! status machine shared by the desktop WebView, Automation API, and Remote UI
//! (ADR-0174).

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::constants::{
    EVENT_APP_UPDATE_STATUS_CHANGED, GITHUB_UPDATE_HOST, GITHUB_UPDATE_OWNER,
    GITHUB_UPDATE_REPOSITORY,
};
use crate::lock_ext::MutexExt;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const INITIAL_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateOperation {
    Idle,
    Checking,
    Downloading,
    Installing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub enabled: bool,
    pub current_version: String,
    pub available_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub operation: UpdateOperation,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub checked_at_ms: Option<u64>,
    pub last_error: Option<String>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            // A dev binary must never replace itself with a release artifact.
            enabled: !cfg!(debug_assertions),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            available_version: None,
            notes: None,
            published_at: None,
            operation: UpdateOperation::Idle,
            downloaded_bytes: 0,
            total_bytes: None,
            checked_at_ms: None,
            last_error: None,
        }
    }
}

pub struct UpdateManager {
    status: Mutex<UpdateStatus>,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self {
            status: Mutex::new(UpdateStatus::default()),
        }
    }
}

impl UpdateManager {
    pub fn snapshot(&self) -> Result<UpdateStatus, String> {
        Ok(self.status.lock_or_err()?.clone())
    }

    fn begin_check(&self) -> Result<bool, String> {
        let mut status = self.status.lock_or_err()?;
        if !status.enabled {
            return Err("updates are disabled in development builds".into());
        }
        if status.operation != UpdateOperation::Idle {
            return Ok(false);
        }
        status.operation = UpdateOperation::Checking;
        status.last_error = None;
        Ok(true)
    }

    fn finish_check(&self, update: Option<AvailableUpdate>) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        status.operation = UpdateOperation::Idle;
        status.checked_at_ms = unix_time_millis();
        status.last_error = None;
        match update {
            Some(update) => {
                status.available_version = Some(update.version);
                status.notes = update.notes;
                status.published_at = update.published_at;
            }
            None => {
                status.available_version = None;
                status.notes = None;
                status.published_at = None;
            }
        }
        Ok(status.clone())
    }

    fn fail_operation(&self, message: String) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        status.operation = UpdateOperation::Idle;
        status.last_error = Some(message);
        Ok(status.clone())
    }

    fn begin_install(&self) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        if !status.enabled {
            return Err("updates are disabled in development builds".into());
        }
        if status.operation != UpdateOperation::Idle {
            return Err("another update operation is already running".into());
        }
        if status.available_version.is_none() {
            return Err("there is no pending update".into());
        }
        status.operation = UpdateOperation::Downloading;
        status.downloaded_bytes = 0;
        status.total_bytes = None;
        status.last_error = None;
        Ok(status.clone())
    }

    fn update_download_progress(
        &self,
        chunk_length: usize,
        total_bytes: Option<u64>,
    ) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        if status.operation != UpdateOperation::Downloading {
            return Ok(status.clone());
        }
        status.downloaded_bytes = status.downloaded_bytes.saturating_add(chunk_length as u64);
        status.total_bytes = total_bytes;
        Ok(status.clone())
    }

    fn mark_installing(&self) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        if status.operation == UpdateOperation::Downloading {
            status.operation = UpdateOperation::Installing;
        }
        Ok(status.clone())
    }
}

struct AvailableUpdate {
    version: String,
    notes: Option<String>,
    published_at: Option<String>,
}

fn is_stable_release_version(version: &str) -> bool {
    let mut parts = version.split('.');
    for _ in 0..3 {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
    }
    parts.next().is_none()
}

fn github_release_version(download_url: &Url) -> Option<&str> {
    if download_url.scheme() != "https"
        || download_url.host_str() != Some(GITHUB_UPDATE_HOST)
        || download_url.port().is_some()
        || !download_url.username().is_empty()
        || download_url.password().is_some()
    {
        return None;
    }

    let mut segments = download_url.path_segments()?;
    if segments.next() != Some(GITHUB_UPDATE_OWNER)
        || segments.next() != Some(GITHUB_UPDATE_REPOSITORY)
        || segments.next() != Some("releases")
        || segments.next() != Some("download")
    {
        return None;
    }
    let tag = segments.next()?;
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let asset = segments.next()?;
    if asset.is_empty() || !is_stable_release_version(version) {
        return None;
    }
    Some(version)
}

fn validate_release_candidate(version: &str, download_url: &Url) -> Result<(), String> {
    if !is_stable_release_version(version) {
        return Err(format!("release version '{version}' is not stable x.y.z"));
    }
    let tag_version = github_release_version(download_url).ok_or_else(|| {
        "release download URL does not contain a stable Laymux version tag".to_string()
    })?;
    if tag_version != version {
        return Err(format!(
            "release tag version {tag_version} does not match manifest version {version}"
        ));
    }
    Ok(())
}

fn validate_install_candidate(expected: &str, candidate: &str) -> Result<(), String> {
    if !is_stable_release_version(candidate) {
        return Err(format!("release version '{candidate}' is not stable x.y.z"));
    }
    if candidate != expected {
        return Err(format!(
            "the available update changed from {expected} to {candidate}; check again"
        ));
    }
    Ok(())
}

pub async fn check_now(
    app: &AppHandle,
    manager: &Arc<UpdateManager>,
) -> Result<UpdateStatus, String> {
    if !manager.begin_check()? {
        return manager.snapshot();
    }
    publish_snapshot(app, manager);

    let result = async {
        let updater = app.updater().map_err(|error| error.to_string())?;
        updater.check().await.map_err(|error| error.to_string())
    }
    .await;

    let status = match result {
        Ok(update) => manager.finish_check(update.and_then(|update| {
            if let Err(error) = validate_release_candidate(&update.version, &update.download_url) {
                tracing::warn!(
                    version = %update.version,
                    %error,
                    "ignoring application update outside the stable release contract"
                );
                return None;
            }
            Some(AvailableUpdate {
                version: update.version,
                notes: update.body,
                published_at: update.date.map(|date| date.to_string()),
            })
        }))?,
        Err(error) => manager.fail_operation(error)?,
    };
    publish(app, &status);
    Ok(status)
}

/// Accept an install request and return before the HTTP/IPC caller is severed
/// by the installer and process restart.
pub fn schedule_install(
    app: AppHandle,
    manager: Arc<UpdateManager>,
) -> Result<UpdateStatus, String> {
    let accepted = manager.begin_install()?;
    let expected_version = accepted
        .available_version
        .clone()
        .ok_or_else(|| "there is no pending update".to_string())?;
    publish(&app, &accepted);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = install_and_restart(&app, &manager, &expected_version).await {
            tracing::error!(%error, "application update failed");
            match manager.fail_operation(error) {
                Ok(status) => publish(&app, &status),
                Err(lock_error) => tracing::error!(%lock_error, "failed to publish update error"),
            }
        }
    });
    Ok(accepted)
}

async fn install_and_restart(
    app: &AppHandle,
    manager: &Arc<UpdateManager>,
    expected_version: &str,
) -> Result<(), String> {
    // Re-check immediately before download so a withdrawn or superseded GitHub
    // release is never installed from stale in-memory metadata.
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the pending update is no longer available".to_string())?;
    validate_release_candidate(&update.version, &update.download_url)?;
    validate_install_candidate(expected_version, &update.version)?;

    let progress_manager = Arc::clone(manager);
    let progress_app = app.clone();
    let finish_manager = Arc::clone(manager);
    let finish_app = app.clone();
    update
        .download_and_install(
            move |chunk_length, total_bytes| match progress_manager
                .update_download_progress(chunk_length, total_bytes)
            {
                Ok(status) => publish(&progress_app, &status),
                Err(error) => tracing::warn!(%error, "failed to publish update progress"),
            },
            move || match finish_manager.mark_installing() {
                Ok(status) => publish(&finish_app, &status),
                Err(error) => tracing::warn!(%error, "failed to publish installer transition"),
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    app.restart();
}

pub fn start_periodic_checks(app: AppHandle, manager: Arc<UpdateManager>) {
    if !manager
        .snapshot()
        .map(|status| status.enabled)
        .unwrap_or(false)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_UPDATE_CHECK_DELAY).await;
        loop {
            if let Err(error) = check_now(&app, &manager).await {
                tracing::warn!(%error, "periodic application update check failed");
            }
            tokio::time::sleep(UPDATE_CHECK_INTERVAL).await;
        }
    });
}

fn publish_snapshot(app: &AppHandle, manager: &UpdateManager) {
    match manager.snapshot() {
        Ok(status) => publish(app, &status),
        Err(error) => tracing::warn!(%error, "failed to read application update status"),
    }
}

fn publish(app: &AppHandle, status: &UpdateStatus) {
    if let Err(error) = app.emit(EVENT_APP_UPDATE_STATUS_CHANGED, status) {
        tracing::warn!(%error, "failed to emit application update status");
    }
}

fn unix_time_millis() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_manager() -> UpdateManager {
        let manager = UpdateManager::default();
        manager.status.lock().unwrap().enabled = true;
        manager
    }

    #[test]
    fn available_update_survives_a_failed_refresh() {
        let manager = enabled_manager();
        assert!(manager.begin_check().unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0".into(),
                notes: Some("notes".into()),
                published_at: Some("2026-08-18T00:00:00Z".into()),
            }))
            .unwrap();

        assert!(manager.begin_check().unwrap());
        let failed = manager.fail_operation("offline".into()).unwrap();

        assert_eq!(failed.available_version.as_deref(), Some("0.11.0"));
        assert_eq!(failed.last_error.as_deref(), Some("offline"));
        assert_eq!(failed.operation, UpdateOperation::Idle);
    }

    #[test]
    fn install_requires_known_update_and_serializes_operations() {
        let manager = enabled_manager();
        assert_eq!(
            manager.begin_install().unwrap_err(),
            "there is no pending update"
        );

        assert!(manager.begin_check().unwrap());
        assert!(!manager.begin_check().unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0".into(),
                notes: None,
                published_at: None,
            }))
            .unwrap();

        let accepted = manager.begin_install().unwrap();
        assert_eq!(accepted.operation, UpdateOperation::Downloading);
        assert_eq!(
            manager.begin_install().unwrap_err(),
            "another update operation is already running"
        );
    }

    #[test]
    fn progress_is_saturating_and_download_finish_enters_installing() {
        let manager = enabled_manager();
        manager.status.lock().unwrap().available_version = Some("0.11.0".into());
        manager.begin_install().unwrap();

        let progress = manager.update_download_progress(25, Some(100)).unwrap();
        assert_eq!(progress.downloaded_bytes, 25);
        assert_eq!(progress.total_bytes, Some(100));
        assert_eq!(
            manager.mark_installing().unwrap().operation,
            UpdateOperation::Installing
        );
    }

    #[test]
    fn stable_release_versions_are_exactly_three_numeric_components() {
        for version in ["0.10.14", "1.2.3", "2026.8.18"] {
            assert!(
                is_stable_release_version(version),
                "{version} must be stable"
            );
        }
        for version in [
            "v1.2.3",
            "1.2",
            "1.2.3.4",
            "1.2.3-nightly",
            "1.2.3+build",
            "1.2.x",
            " 1.2.3",
            "1.2.3 ",
        ] {
            assert!(
                !is_stable_release_version(version),
                "{version} must be ignored"
            );
        }
    }

    #[test]
    fn install_recheck_requires_the_same_stable_version() {
        assert!(validate_install_candidate("1.2.3", "1.2.3").is_ok());
        assert_eq!(
            validate_install_candidate("1.2.3", "1.2.4").unwrap_err(),
            "the available update changed from 1.2.3 to 1.2.4; check again"
        );
        assert_eq!(
            validate_install_candidate("1.2.3", "1.2.4-nightly").unwrap_err(),
            "release version '1.2.4-nightly' is not stable x.y.z"
        );
    }

    #[test]
    fn stable_release_candidate_requires_a_matching_github_tag() {
        let stable = url::Url::parse(
            "https://github.com/kochul2000/laymux/releases/download/v1.2.3/Laymux.exe",
        )
        .unwrap();
        let nightly = url::Url::parse(
            "https://github.com/kochul2000/laymux/releases/download/nightly/Laymux.exe",
        )
        .unwrap();
        let mismatched = url::Url::parse(
            "https://github.com/kochul2000/laymux/releases/download/v1.2.4/Laymux.exe",
        )
        .unwrap();

        assert!(validate_release_candidate("1.2.3", &stable).is_ok());
        assert_eq!(
            validate_release_candidate("1.2.3", &nightly).unwrap_err(),
            "release download URL does not contain a stable Laymux version tag"
        );
        assert_eq!(
            validate_release_candidate("1.2.3", &mismatched).unwrap_err(),
            "release tag version 1.2.4 does not match manifest version 1.2.3"
        );
    }
}
