//! Update preparation observed by desktop and Remote (ADR-0264).
use super::{UpdateManager, UpdateOperation, UpdateStatus};
use crate::{lock_ext::MutexExt, state::AppState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// An update never interrupts terminals: the PTY daemon keeps every session
/// across the restart (ADR-0308), so only an explicit close runs the Ctrl+C
/// cleanup (ADR-0314).
pub enum PreparationStage {
    Checkpoint,
    Caching,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitProgress {
    pub stage: PreparationStage,
    pub completed: u64,
    pub total: Option<u64>,
    pub warning: Option<String>,
}

impl UpdateManager {
    pub fn cancel_close(&self) -> bool {
        self.closing.swap(false, Ordering::AcqRel)
    }

    pub fn claim_close(&self) -> Result<(), String> {
        let status = self.status.lock_or_err()?;
        if matches!(
            status.operation,
            UpdateOperation::Downloading | UpdateOperation::Preparing | UpdateOperation::Installing
        ) {
            return Err("an update is already running".into());
        }
        self.closing.store(true, Ordering::Release);
        Ok(())
    }

    pub(super) fn mark_preparing(&self) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        status.operation = UpdateOperation::Preparing;
        status.preparation = Some(ExitProgress {
            stage: PreparationStage::Checkpoint,
            completed: 0,
            total: None,
            warning: None,
        });
        Ok(status.clone())
    }

    fn report_preparation(&self, mut progress: ExitProgress) -> Result<UpdateStatus, String> {
        let mut status = self.status.lock_or_err()?;
        if status.operation != UpdateOperation::Preparing {
            return Err("update preparation is not active".into());
        }
        if let Some(previous) = &status.preparation {
            if progress.stage < previous.stage {
                return Err("stale update preparation progress".into());
            }
            if progress.warning.is_none() {
                progress.warning = previous.warning.clone();
            }
        }
        status.preparation = Some(progress);
        Ok(status.clone())
    }
}

pub fn report(
    app: &AppHandle,
    state: &AppState,
    request_id: u64,
    progress: ExitProgress,
) -> Result<(), String> {
    if !state.session_checkpoint.has_pending_request(request_id)? {
        return Err("update preparation request expired".into());
    }
    let status = state.app_update.report_preparation(progress)?;
    super::publish(app, &status);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_reports_real_stage_and_survives_failure() {
        let manager = UpdateManager::default();
        manager.mark_preparing().unwrap();
        let progress = ExitProgress {
            stage: PreparationStage::Caching,
            completed: 300,
            total: Some(700),
            warning: None,
        };
        let status = manager.report_preparation(progress.clone()).unwrap();
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["operation"], "preparing");
        assert_eq!(json["preparation"]["completed"], 300);
        assert_eq!(json["preparation"]["total"], 700);
        assert!(manager.claim_close().is_err());
        manager.fail_operation("cache failed".into()).unwrap();
        assert_eq!(
            manager.snapshot().unwrap().preparation,
            Some(progress.clone())
        );
        assert!(manager.report_preparation(progress).is_err());
        assert!(manager.claim_close().is_ok());
    }
}
