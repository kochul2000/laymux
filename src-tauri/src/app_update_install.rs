//! Signed installation with an explicit, one-attempt preparation override.
use super::*;

/// Accept an install request and return before the HTTP/IPC caller is severed
/// by the installer and process restart.
pub fn schedule_install(
    app: AppHandle,
    manager: Arc<UpdateManager>,
    force: bool,
) -> Result<UpdateStatus, String> {
    let channel = current_channel();
    // Refuse before accepting: a candidate found before the channel or the
    // install format made it unreachable must not start a download that can only
    // end in a format error.
    if let Some(reason) = unsupported_channel_install(channel) {
        return Err(reason);
    }
    let accepted = if force {
        manager.begin_install_with_force(channel, true)?
    } else {
        manager.begin_install(channel)?
    };
    let expected_version = accepted
        .available_version
        .clone()
        .ok_or_else(|| "there is no pending update".to_string())?;
    publish(&app, &accepted);

    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            install_and_restart(&app, &manager, channel, &expected_version, force).await
        {
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
    force: bool,
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
    let updater = channel_updater_builder(app, channel)?
        .on_before_exit(move || match guard_app.try_state::<Arc<AppState>>() {
            Some(state) => crate::update_install_guard::release_installer_file_locks(&state),
            // Nothing to tear down without the state, and panicking inside the
            // hook would abort the process between the download and the
            // installer — the one moment where losing the update costs the most.
            None => tracing::warn!("app state is unavailable; installing without a teardown"),
        })
        .build()
        .map_err(|error| error.to_string())?;
    let update = retry::check(|| updater.check())
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the pending update is no longer available".to_string())?;
    validate_release_candidate(channel, &update.version, &update.download_url)?;
    validate_install_candidate(channel, expected_version, &update.version)?;

    let progress_manager = Arc::clone(manager);
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk_length, total_bytes| match progress_manager
                .update_download_progress(chunk_length, total_bytes)
            {
                Ok(status) => publish(&progress_app, &status),
                Err(error) => tracing::warn!(%error, "failed to publish update progress"),
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    // The verified package is now local, but no terminal has been torn down and
    // no installer has started. Establish the final durable restore point while
    // every live process is still observable. Freeze terminal mutations before
    // requesting it, then keep the gate through the updater's on_before_exit
    // child/file-lock release (ADR-0222).
    let state = app
        .try_state::<Arc<AppState>>()
        .ok_or_else(|| "app state is unavailable for the update checkpoint".to_string())?;
    publish(app, &manager.mark_preparing()?);
    prepare(&state, force, || {
        crate::session_checkpoint::request_frontend_checkpoint(app, &state, "update", true)
    })
    .await?;

    match manager.mark_installing() {
        Ok(status) => publish(app, &status),
        Err(error) => tracing::warn!(%error, "failed to publish installer transition"),
    }
    if let Err(error) = update.install(bytes) {
        // The Windows teardown may already have begun the daemon handoff;
        // this GUI stays, so closing it must end its work again.
        state.cancel_update_handoff();
        state.session_checkpoint.cancel_finalization();
        return Err(error.to_string());
    }

    // Restarting runs the app exit path, which would end the daemon
    // sessions; the updated GUI adopts them instead (ADR-0308).
    state.begin_update_handoff();
    app.restart();
}

/// Even a loss override must fence and drain input before installer teardown.
/// The checkpoint closure is never polled for a forced attempt.
pub(super) async fn prepare<F, Fut>(
    state: &AppState,
    force: bool,
    checkpoint: F,
) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<u64, String>>,
{
    state
        .session_checkpoint
        .begin_finalization_and_drain(state)
        .await?;
    if !force {
        if let Err(error) = checkpoint().await {
            state.session_checkpoint.cancel_finalization();
            return Err(error);
        }
    }
    Ok(())
}
