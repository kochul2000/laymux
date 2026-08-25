//! Process-global desktop update coordinator.
//!
//! GitHub/Tauri is the transport and signature verifier; this module owns the
//! status machine shared by the desktop WebView, Automation API, and Remote UI
//! (ADR-0174).

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::constants::{
    EVENT_APP_UPDATE_STATUS_CHANGED, GITHUB_UPDATE_HOST, GITHUB_UPDATE_OWNER,
    GITHUB_UPDATE_REPOSITORY, UPDATE_CHANNEL_BETA, UPDATE_CHANNEL_MANIFEST_BRANCH,
    UPDATE_CHANNEL_MANIFEST_HOST, UPDATE_CHANNEL_STABLE,
};
use crate::lock_ext::MutexExt;
use crate::state::AppState;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const INITIAL_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(5);

/// A channel switch between check and install is a client-state conflict, not a
/// server fault. HTTP surfaces classify on this prefix so the caller gets the
/// same status code as "there is no pending update".
pub const UPDATE_CHANNEL_CHANGED_ERROR: &str = "the update channel changed";

/// Release channel this install follows (ADR-0190).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    /// Unknown values resolve to stable: a misread channel must never move a
    /// machine onto the less-verified series.
    pub fn from_settings_value(raw: &str) -> Self {
        if raw == UPDATE_CHANNEL_BETA {
            Self::Beta
        } else {
            Self::Stable
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => UPDATE_CHANNEL_STABLE,
            Self::Beta => UPDATE_CHANNEL_BETA,
        }
    }

    /// The channel manifest is the single source of truth for "what is newest
    /// here"; GitHub has no stable alias for the latest prerelease.
    fn manifest_url(self) -> String {
        format!(
            "https://{host}/{owner}/{repo}/{branch}/desktop-{channel}.json",
            host = UPDATE_CHANNEL_MANIFEST_HOST,
            owner = GITHUB_UPDATE_OWNER,
            repo = GITHUB_UPDATE_REPOSITORY,
            branch = UPDATE_CHANNEL_MANIFEST_BRANCH,
            channel = self.as_str(),
        )
    }
}

/// The channel the settings file currently names. Disk is the source of truth,
/// so an unsaved UI draft does not steer an update check.
pub fn current_channel() -> UpdateChannel {
    UpdateChannel::from_settings_value(&crate::settings::load_settings().update.channel)
}

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
    pub channel: UpdateChannel,
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
            channel: UpdateChannel::Stable,
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
    /// Seeded with the channel the settings file names so every surface reads
    /// the right channel before the first check completes.
    pub fn new(channel: UpdateChannel) -> Self {
        Self {
            status: Mutex::new(UpdateStatus {
                channel,
                ..UpdateStatus::default()
            }),
        }
    }

    pub fn snapshot(&self) -> Result<UpdateStatus, String> {
        Ok(self.status.lock_or_err()?.clone())
    }

    /// Adopt `channel` for this check. A candidate found on another channel is
    /// discarded here rather than left to be installed from the wrong series.
    fn begin_check(&self, channel: UpdateChannel) -> Result<bool, String> {
        let mut status = self.status.lock_or_err()?;
        if !status.enabled {
            return Err("updates are disabled in development builds".into());
        }
        if status.operation != UpdateOperation::Idle {
            return Ok(false);
        }
        if status.channel != channel {
            status.channel = channel;
            status.available_version = None;
            status.notes = None;
            status.published_at = None;
        }
        status.operation = UpdateOperation::Checking;
        // `last_error` is not cleared here. A check that ends up abandoned would
        // otherwise erase the record of the last real failure without replacing
        // it; `finish_check` clears it once there is an answer.
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

    /// End a check whose channel changed while it was in flight. That is neither
    /// an answer nor a failure, so no error is recorded — but the snapshot must
    /// already describe the channel the user switched to, and the candidate the
    /// old channel produced must be gone. Otherwise every surface keeps offering
    /// a build from the series the user just left, and installing it is refused.
    fn abandon_check(&self, channel: UpdateChannel) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        if status.operation == UpdateOperation::Checking {
            status.operation = UpdateOperation::Idle;
        }
        if status.channel != channel {
            status.channel = channel;
            status.available_version = None;
            status.notes = None;
            status.published_at = None;
        }
        Ok(status.clone())
    }

    fn fail_operation(&self, message: String) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        status.operation = UpdateOperation::Idle;
        status.last_error = Some(message);
        Ok(status.clone())
    }

    /// `channel` is the channel the settings file names right now. The pending
    /// candidate belongs to the channel recorded in the snapshot, so a channel
    /// switch between check and install must force a re-check instead of
    /// installing a build from the series the user just left.
    fn begin_install(&self, channel: UpdateChannel) -> Result<UpdateStatus, String> {
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
        if status.channel != channel {
            return Err(format!(
                "{UPDATE_CHANNEL_CHANGED_ERROR} to {}; check again",
                channel.as_str()
            ));
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

/// `x.y.z-beta.N` with `N >= 1` and no leading zero. Widening the channel must
/// not widen into arbitrary prerelease labels, so `alpha`/`rc`/build metadata
/// stay rejected (ADR-0190).
fn is_beta_release_version(version: &str) -> bool {
    let Some((core, suffix)) = version.split_once('-') else {
        return false;
    };
    if !is_stable_release_version(core) {
        return false;
    }
    let Some(slot) = suffix.strip_prefix("beta.") else {
        return false;
    };
    if slot.is_empty() || slot.starts_with('0') {
        return false;
    }
    slot.bytes().all(|byte| byte.is_ascii_digit())
}

/// Which manifest versions the given channel accepts.
fn is_channel_release_version(channel: UpdateChannel, version: &str) -> bool {
    match channel {
        UpdateChannel::Stable => is_stable_release_version(version),
        UpdateChannel::Beta => {
            is_stable_release_version(version) || is_beta_release_version(version)
        }
    }
}

fn channel_version_shape(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => "x.y.z",
        UpdateChannel::Beta => "x.y.z or x.y.z-beta.N",
    }
}

fn github_release_version(channel: UpdateChannel, download_url: &Url) -> Option<&str> {
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
    if asset.is_empty() || !is_channel_release_version(channel, version) {
        return None;
    }
    Some(version)
}

fn validate_release_candidate(
    channel: UpdateChannel,
    version: &str,
    download_url: &Url,
) -> Result<(), String> {
    if !is_channel_release_version(channel, version) {
        return Err(format!(
            "release version '{version}' is not {}",
            channel_version_shape(channel)
        ));
    }
    let tag_version = github_release_version(channel, download_url).ok_or_else(|| {
        "release download URL does not contain a Laymux version tag for this channel".to_string()
    })?;
    if tag_version != version {
        return Err(format!(
            "release tag version {tag_version} does not match manifest version {version}"
        ));
    }
    Ok(())
}

fn validate_install_candidate(
    channel: UpdateChannel,
    expected: &str,
    candidate: &str,
) -> Result<(), String> {
    if !is_channel_release_version(channel, candidate) {
        return Err(format!(
            "release version '{candidate}' is not {}",
            channel_version_shape(channel)
        ));
    }
    if candidate != expected {
        return Err(format!(
            "the available update changed from {expected} to {candidate}; check again"
        ));
    }
    Ok(())
}

/// A channel switch mid-flight costs one extra round trip, not the six-hour wait
/// until the next periodic check. The bound keeps a user flipping the setting
/// from spinning the network.
const CHANNEL_SWITCH_RETRIES: usize = 1;

/// Why this install cannot follow `channel`, if it cannot.
///
/// beta ships only NSIS and AppImage (ADR-0190), and the updater falls back from
/// `{os}-{arch}-{installer}` to the bare `{os}-{arch}` entry when the specific one
/// is missing. On a deb/rpm install that fallback hands AppImage bytes to the deb
/// or rpm installer, which fails at install time with an opaque format error. The
/// honest answer is to refuse the channel at check time and say why.
fn unsupported_channel_install(channel: UpdateChannel) -> Option<String> {
    use tauri::utils::config::BundleType;

    if channel != UpdateChannel::Beta {
        return None;
    }
    let installer = match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        _ => return None,
    };
    Some(format!(
        "the beta channel does not ship {installer} packages; use the AppImage build or switch back to the stable channel"
    ))
}

pub async fn check_now(
    app: &AppHandle,
    manager: &Arc<UpdateManager>,
) -> Result<UpdateStatus, String> {
    for attempt in 0..=CHANNEL_SWITCH_RETRIES {
        match check_channel_once(app, manager).await? {
            CheckOutcome::Settled(status) => return Ok(status),
            CheckOutcome::ChannelSwitched(status) => {
                if attempt == CHANNEL_SWITCH_RETRIES {
                    return Ok(status);
                }
            }
        }
    }
    manager.snapshot()
}

enum CheckOutcome {
    Settled(UpdateStatus),
    ChannelSwitched(UpdateStatus),
}

async fn check_channel_once(
    app: &AppHandle,
    manager: &Arc<UpdateManager>,
) -> Result<CheckOutcome, String> {
    let channel = current_channel();
    if !manager.begin_check(channel)? {
        return Ok(CheckOutcome::Settled(manager.snapshot()?));
    }
    publish_snapshot(app, manager);

    if let Some(reason) = unsupported_channel_install(channel) {
        let status = manager.fail_operation(reason)?;
        publish(app, &status);
        return Ok(CheckOutcome::Settled(status));
    }

    let result = match channel_updater(app, channel) {
        Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
        Err(error) => Err(error),
    };

    // The request left with the channel read above. If the user switched
    // channels while it was in flight, its answer describes a series this
    // install no longer follows, so it must not become a candidate.
    if current_channel() != channel {
        tracing::info!(
            channel = channel.as_str(),
            "discarding an update check whose channel changed while it was in flight"
        );
        let status = manager.abandon_check(current_channel())?;
        publish(app, &status);
        return Ok(CheckOutcome::ChannelSwitched(status));
    }

    let status = match result {
        Ok(update) => manager.finish_check(update.and_then(|update| {
            if let Err(error) =
                validate_release_candidate(channel, &update.version, &update.download_url)
            {
                tracing::warn!(
                    version = %update.version,
                    channel = channel.as_str(),
                    %error,
                    "ignoring application update outside this channel's release contract"
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
    Ok(CheckOutcome::Settled(status))
}

/// Build an updater pinned to this channel's manifest. The endpoint in
/// `tauri.conf.json` is only the stable default; the channel decides at runtime.
fn channel_updater_builder(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<tauri_plugin_updater::UpdaterBuilder, String> {
    let endpoint = Url::parse(&channel.manifest_url()).map_err(|error| error.to_string())?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())
}

fn channel_updater(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<tauri_plugin_updater::Updater, String> {
    channel_updater_builder(app, channel)?
        .build()
        .map_err(|error| error.to_string())
}

/// Accept an install request and return before the HTTP/IPC caller is severed
/// by the installer and process restart.
pub fn schedule_install(
    app: AppHandle,
    manager: Arc<UpdateManager>,
) -> Result<UpdateStatus, String> {
    let channel = current_channel();
    // Refuse before accepting: a candidate found before the channel or the
    // install format made it unreachable must not start a download that can only
    // end in a format error.
    if let Some(reason) = unsupported_channel_install(channel) {
        return Err(reason);
    }
    let accepted = manager.begin_install(channel)?;
    let expected_version = accepted
        .available_version
        .clone()
        .ok_or_else(|| "there is no pending update".to_string())?;
    publish(&app, &accepted);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = install_and_restart(&app, &manager, channel, &expected_version).await {
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
    channel: UpdateChannel,
    expected_version: &str,
) -> Result<(), String> {
    // Re-check immediately before download so a withdrawn or superseded GitHub
    // release is never installed from stale in-memory metadata. The channel is
    // the one accepted at request time: an accepted install completes on the
    // series the user approved even if the setting changes meanwhile (ADR-0174).
    //
    // `on_before_exit` is the last moment this process controls: the updater
    // starts the installer and calls `std::process::exit(0)`, which runs no
    // destructor, so the terminals this app spawned would otherwise survive it
    // and keep the files the installer must overwrite (ADR-0201). Blocking here
    // delays the installer by exactly as long as the teardown needs.
    let guard_app = app.clone();
    let update = channel_updater_builder(app, channel)?
        .on_before_exit(move || match guard_app.try_state::<Arc<AppState>>() {
            Some(state) => crate::update_install_guard::release_installer_file_locks(&state),
            // Nothing to tear down without the state, and panicking inside the
            // hook would abort the process between the download and the
            // installer — the one moment where losing the update costs the most.
            None => tracing::warn!("app state is unavailable; installing without a teardown"),
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the pending update is no longer available".to_string())?;
    validate_release_candidate(channel, &update.version, &update.download_url)?;
    validate_install_candidate(channel, expected_version, &update.version)?;

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

/// Re-read the channel from disk and check once, without waiting for the six-hour
/// cycle. Used by settings paths that rewrite `settings.json` behind the frontend
/// (settings reset), where the process-global manager would otherwise keep the
/// old channel and its candidate.
pub fn schedule_channel_recheck(app: AppHandle, manager: Arc<UpdateManager>) {
    if !manager
        .snapshot()
        .map(|status| status.enabled)
        .unwrap_or(false)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = check_now(&app, &manager).await {
            tracing::warn!(%error, "update check after a settings change failed");
        }
    });
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

    fn download_url(tag: &str) -> url::Url {
        url::Url::parse(&format!(
            "https://github.com/kochul2000/laymux/releases/download/{tag}/Laymux.exe"
        ))
        .unwrap()
    }

    #[test]
    fn available_update_survives_a_failed_refresh() {
        let manager = enabled_manager();
        assert!(manager.begin_check(UpdateChannel::Stable).unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0".into(),
                notes: Some("notes".into()),
                published_at: Some("2026-08-18T00:00:00Z".into()),
            }))
            .unwrap();

        assert!(manager.begin_check(UpdateChannel::Stable).unwrap());
        let failed = manager.fail_operation("offline".into()).unwrap();

        assert_eq!(failed.available_version.as_deref(), Some("0.11.0"));
        assert_eq!(failed.last_error.as_deref(), Some("offline"));
        assert_eq!(failed.operation, UpdateOperation::Idle);
    }

    #[test]
    fn install_requires_known_update_and_serializes_operations() {
        let manager = enabled_manager();
        assert_eq!(
            manager.begin_install(UpdateChannel::Stable).unwrap_err(),
            "there is no pending update"
        );

        assert!(manager.begin_check(UpdateChannel::Stable).unwrap());
        assert!(!manager.begin_check(UpdateChannel::Stable).unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0".into(),
                notes: None,
                published_at: None,
            }))
            .unwrap();

        let accepted = manager.begin_install(UpdateChannel::Stable).unwrap();
        assert_eq!(accepted.operation, UpdateOperation::Downloading);
        assert_eq!(
            manager.begin_install(UpdateChannel::Stable).unwrap_err(),
            "another update operation is already running"
        );
    }

    #[test]
    fn progress_is_saturating_and_download_finish_enters_installing() {
        let manager = enabled_manager();
        manager.status.lock().unwrap().available_version = Some("0.11.0".into());
        manager.begin_install(UpdateChannel::Stable).unwrap();

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
        assert!(validate_install_candidate(UpdateChannel::Stable, "1.2.3", "1.2.3").is_ok());
        assert_eq!(
            validate_install_candidate(UpdateChannel::Stable, "1.2.3", "1.2.4").unwrap_err(),
            "the available update changed from 1.2.3 to 1.2.4; check again"
        );
        assert_eq!(
            validate_install_candidate(UpdateChannel::Stable, "1.2.3", "1.2.4-nightly")
                .unwrap_err(),
            "release version '1.2.4-nightly' is not x.y.z"
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

        assert!(validate_release_candidate(UpdateChannel::Stable, "1.2.3", &stable).is_ok());
        assert_eq!(
            validate_release_candidate(UpdateChannel::Stable, "1.2.3", &nightly).unwrap_err(),
            "release download URL does not contain a Laymux version tag for this channel"
        );
        assert_eq!(
            validate_release_candidate(UpdateChannel::Stable, "1.2.3", &mismatched).unwrap_err(),
            "release tag version 1.2.4 does not match manifest version 1.2.3"
        );
    }

    #[test]
    fn beta_channel_accepts_only_beta_dot_n_prereleases() {
        for version in ["1.2.3", "1.2.3-beta.1", "1.2.3-beta.12"] {
            assert!(
                is_channel_release_version(UpdateChannel::Beta, version),
                "{version} must be accepted on beta"
            );
        }
        for version in [
            "1.2.3-alpha.1",
            "1.2.3-rc.1",
            "1.2.3-nightly",
            "1.2.3-beta",
            "1.2.3-beta.0",
            "1.2.3-beta.01",
            "1.2.3-beta.1.2",
            "1.2.3-beta.1+build",
            "1.2.3+build",
            "v1.2.3-beta.1",
        ] {
            assert!(
                !is_channel_release_version(UpdateChannel::Beta, version),
                "{version} must be ignored on beta"
            );
        }
    }

    #[test]
    fn stable_channel_never_accepts_a_prerelease() {
        assert!(!is_channel_release_version(
            UpdateChannel::Stable,
            "1.2.3-beta.1"
        ));
        assert_eq!(
            validate_release_candidate(
                UpdateChannel::Stable,
                "1.2.3-beta.1",
                &download_url("v1.2.3-beta.1")
            )
            .unwrap_err(),
            "release version '1.2.3-beta.1' is not x.y.z"
        );
    }

    #[test]
    fn beta_candidate_requires_a_matching_beta_tag() {
        assert!(validate_release_candidate(
            UpdateChannel::Beta,
            "1.2.3-beta.2",
            &download_url("v1.2.3-beta.2")
        )
        .is_ok());
        assert_eq!(
            validate_release_candidate(
                UpdateChannel::Beta,
                "1.2.3-beta.2",
                &download_url("v1.2.3-beta.3")
            )
            .unwrap_err(),
            "release tag version 1.2.3-beta.3 does not match manifest version 1.2.3-beta.2"
        );
        assert_eq!(
            validate_release_candidate(UpdateChannel::Beta, "1.2.3-beta.2", &download_url("beta"))
                .unwrap_err(),
            "release download URL does not contain a Laymux version tag for this channel"
        );
    }

    #[test]
    fn a_channel_switch_drops_the_pending_candidate() {
        let manager = enabled_manager();
        assert!(manager.begin_check(UpdateChannel::Stable).unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0".into(),
                notes: None,
                published_at: None,
            }))
            .unwrap();

        assert!(manager.begin_check(UpdateChannel::Beta).unwrap());
        let switched = manager.snapshot().unwrap();
        assert_eq!(switched.channel, UpdateChannel::Beta);
        assert_eq!(switched.available_version, None);
    }

    #[test]
    fn abandoning_a_check_keeps_the_previous_candidate() {
        let manager = enabled_manager();
        assert!(manager.begin_check(UpdateChannel::Stable).unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0".into(),
                notes: None,
                published_at: None,
            }))
            .unwrap();

        assert!(manager.begin_check(UpdateChannel::Stable).unwrap());
        let abandoned = manager.abandon_check(UpdateChannel::Stable).unwrap();
        assert_eq!(abandoned.operation, UpdateOperation::Idle);
        assert_eq!(abandoned.available_version.as_deref(), Some("0.11.0"));
        assert_eq!(abandoned.last_error, None);
    }

    #[test]
    fn install_is_refused_after_the_channel_changed() {
        let manager = enabled_manager();
        assert!(manager.begin_check(UpdateChannel::Beta).unwrap());
        manager
            .finish_check(Some(AvailableUpdate {
                version: "0.11.0-beta.1".into(),
                notes: None,
                published_at: None,
            }))
            .unwrap();

        assert_eq!(
            manager.begin_install(UpdateChannel::Stable).unwrap_err(),
            "the update channel changed to stable; check again"
        );
        assert_eq!(
            manager
                .begin_install(UpdateChannel::Beta)
                .unwrap()
                .operation,
            UpdateOperation::Downloading
        );
    }

    #[test]
    fn channel_manifest_urls_are_pinned_per_channel() {
        assert_eq!(
            UpdateChannel::Stable.manifest_url(),
            "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/desktop-stable.json"
        );
        assert_eq!(
            UpdateChannel::Beta.manifest_url(),
            "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/desktop-beta.json"
        );
    }

    #[test]
    fn beta_is_refused_on_install_formats_it_does_not_ship() {
        // The updater falls back from `{os}-{arch}-{installer}` to the bare
        // `{os}-{arch}` entry, so a deb/rpm install on beta would be handed the
        // AppImage and fail inside the installer. Stable ships every format, so
        // it is never refused (ADR-0190).
        assert_eq!(unsupported_channel_install(UpdateChannel::Stable), None);
        match tauri::utils::platform::bundle_type() {
            Some(tauri::utils::config::BundleType::Deb) => {
                assert!(unsupported_channel_install(UpdateChannel::Beta)
                    .is_some_and(|reason| reason.contains("deb")));
            }
            Some(tauri::utils::config::BundleType::Rpm) => {
                assert!(unsupported_channel_install(UpdateChannel::Beta)
                    .is_some_and(|reason| reason.contains("rpm")));
            }
            // NSIS, AppImage and the unbundled test binary all follow beta.
            _ => assert_eq!(unsupported_channel_install(UpdateChannel::Beta), None),
        }
    }

    #[test]
    fn unknown_channel_values_resolve_to_stable() {
        assert_eq!(
            UpdateChannel::from_settings_value("beta"),
            UpdateChannel::Beta
        );
        for raw in ["stable", "", "nightly", "Beta", "BETA"] {
            assert_eq!(
                UpdateChannel::from_settings_value(raw),
                UpdateChannel::Stable,
                "{raw} must resolve to stable"
            );
        }
    }
}
