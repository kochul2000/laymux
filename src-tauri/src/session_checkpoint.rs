use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::lock_ext::MutexExt;
use crate::state::AppState;

pub const EVENT_SESSION_CHECKPOINT_REQUESTED: &str = "session-checkpoint-requested";
const CHECKPOINT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);
const CHECKPOINT_WATCHDOG_INTERVAL: Duration = Duration::from_secs(5 * 60);

type CheckpointResponse = Result<u64, String>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionCheckpointRequest {
    request_id: u64,
    reason: &'static str,
    require_conclusive: bool,
}

/// Backend-owned request/ack rendezvous and destructive-finalization gate.
pub struct SessionCheckpointRuntime {
    next_request_id: AtomicU64,
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<CheckpointResponse>>>,
    finalizing: AtomicBool,
}

impl Default for SessionCheckpointRuntime {
    fn default() -> Self {
        Self {
            next_request_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            finalizing: AtomicBool::new(false),
        }
    }
}

impl SessionCheckpointRuntime {
    pub fn ensure_mutations_allowed(&self) -> Result<(), String> {
        if self.finalizing.load(Ordering::Acquire) {
            Err("application update finalization is in progress".into())
        } else {
            Ok(())
        }
    }

    pub fn begin_finalization(&self) -> Result<(), String> {
        self.finalizing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "application update finalization is already in progress".into())
    }

    pub fn cancel_finalization(&self) {
        self.finalizing.store(false, Ordering::Release);
    }

    fn complete(&self, request_id: u64, response: CheckpointResponse) -> Result<(), String> {
        let sender = self
            .pending
            .lock_or_err()?
            .remove(&request_id)
            .ok_or_else(|| format!("session checkpoint request {request_id} is not pending"))?;
        sender
            .send(response)
            .map_err(|_| format!("session checkpoint request {request_id} is no longer waiting"))
    }
}

pub async fn request_frontend_checkpoint(
    app: &AppHandle,
    state: &AppState,
    reason: &'static str,
    require_conclusive: bool,
) -> Result<u64, String> {
    let request_id = state
        .session_checkpoint
        .next_request_id
        .fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    state
        .session_checkpoint
        .pending
        .lock_or_err()?
        .insert(request_id, sender);

    if let Err(error) = app.emit(
        EVENT_SESSION_CHECKPOINT_REQUESTED,
        SessionCheckpointRequest {
            request_id,
            reason,
            require_conclusive,
        },
    ) {
        let _ = state
            .session_checkpoint
            .pending
            .lock_or_err()?
            .remove(&request_id);
        return Err(format!(
            "failed to request a frontend session checkpoint: {error}"
        ));
    }

    match tokio::time::timeout(CHECKPOINT_RESPONSE_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("frontend session checkpoint responder stopped".into()),
        Err(_) => {
            let _ = state
                .session_checkpoint
                .pending
                .lock_or_err()?
                .remove(&request_id);
            Err("frontend session checkpoint timed out".into())
        }
    }
}

#[tauri::command(async)]
pub fn acknowledge_session_checkpoint(
    request_id: u64,
    checkpoint_commit_id: Option<u64>,
    error: Option<String>,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    let response = match (checkpoint_commit_id, error) {
        (Some(commit_id), None) => Ok(commit_id),
        (_, Some(error)) => Err(error),
        _ => Err("frontend did not provide a session checkpoint result".into()),
    };
    state.session_checkpoint.complete(request_id, response)
}

pub fn start_watchdog(app: AppHandle, state: std::sync::Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CHECKPOINT_WATCHDOG_INTERVAL).await;
            if let Err(error) = request_frontend_checkpoint(&app, &state, "watchdog", false).await {
                tracing::warn!(%error, "periodic session checkpoint failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalization_gate_can_be_cancelled_after_an_install_failure() {
        let runtime = SessionCheckpointRuntime::default();
        assert!(runtime.ensure_mutations_allowed().is_ok());
        runtime.begin_finalization().unwrap();
        assert!(runtime.ensure_mutations_allowed().is_err());
        runtime.cancel_finalization();
        assert!(runtime.ensure_mutations_allowed().is_ok());
    }
}
