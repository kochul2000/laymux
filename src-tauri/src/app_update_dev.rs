//! Exercise the real update preparation without downloading/installing a package.
use super::{progress::ExitProgress, UpdateOperation, UpdateStatus};
use crate::{lock_ext::MutexExt, state::AppState};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::AppHandle;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevPreparationResult {
    checkpoint_commit_id: u64,
    preparation: Option<ExitProgress>,
}

struct PreparationGuard {
    app: AppHandle,
    state: Arc<AppState>,
    previous: UpdateStatus,
    owns_fence: bool,
}

impl Drop for PreparationGuard {
    fn drop(&mut self) {
        if self.owns_fence {
            self.state.session_checkpoint.cancel_finalization();
        }
        match self.state.app_update.status.lock_or_err() {
            Ok(mut status) => {
                *status = self.previous.clone();
                super::publish(&self.app, &status);
            }
            Err(error) => tracing::error!(%error, "failed to restore dev update status"),
        }
    }
}

pub(crate) async fn prepare(
    app: AppHandle,
    state: Arc<AppState>,
) -> Result<DevPreparationResult, String> {
    let previous = begin_preparation(&state)?;
    let mut guard = PreparationGuard {
        app,
        state,
        previous,
        owns_fence: false,
    };
    super::publish(&guard.app, &guard.state.app_update.snapshot()?);
    let mut checkpoint_commit_id = 0;
    let app = guard.app.clone();
    let state = Arc::clone(&guard.state);
    // Same fence/drain, backend scope, frontend listener, durable save, output
    // cache and ACK as installation. No synthetic event or successful IPC mock.
    super::install::prepare(&state, false, || async {
        guard.owns_fence = true;
        checkpoint_commit_id =
            crate::session_checkpoint::request_frontend_checkpoint(&app, &state, "update", true)
                .await?;
        Ok(checkpoint_commit_id)
    })
    .await?;
    Ok(DevPreparationResult {
        checkpoint_commit_id,
        preparation: guard.state.app_update.snapshot()?.preparation,
    })
}

fn begin_preparation(state: &AppState) -> Result<UpdateStatus, String> {
    let mut status = state.app_update.status.lock_or_err()?;
    if status.operation != UpdateOperation::Idle
        || state.app_update.closing.load(Ordering::Acquire)
        || state.session_checkpoint.is_finalizing()
    {
        return Err("another lifecycle operation is already active".into());
    }
    let previous = status.clone();
    status.operation = UpdateOperation::Preparing;
    status.preparation = Some(ExitProgress {
        stage: super::progress::PreparationStage::Checkpoint,
        completed: 0,
        total: None,
        warning: None,
    });
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_preparation_never_enables_release_installation_and_blocks_close() {
        let state = AppState::new();
        let previous = begin_preparation(&state).unwrap();
        assert!(!previous.enabled);
        assert!(!state.app_update.snapshot().unwrap().enabled);
        assert!(state.app_update.claim_close().is_err());
        let preparing = state.app_update.snapshot().unwrap();
        assert!(begin_preparation(&state).is_err());
        assert_eq!(state.app_update.snapshot().unwrap(), preparing);
    }

    #[test]
    fn dev_preparation_cannot_steal_an_explicit_close() {
        let state = AppState::new();
        state.app_update.claim_close().unwrap();
        let previous = state.app_update.snapshot().unwrap();
        assert!(begin_preparation(&state).is_err());
        assert_eq!(state.app_update.snapshot().unwrap(), previous);
        assert!(state.app_update.cancel_close());
    }

    #[tokio::test]
    async fn dev_preparation_cannot_steal_an_existing_input_fence() {
        let state = AppState::new();
        state
            .session_checkpoint
            .begin_finalization_and_drain(&state)
            .await
            .unwrap();
        let previous = state.app_update.snapshot().unwrap();
        assert!(begin_preparation(&state).is_err());
        assert!(state.session_checkpoint.is_finalizing());
        assert_eq!(state.app_update.snapshot().unwrap(), previous);
        state.session_checkpoint.cancel_finalization();
    }
}
