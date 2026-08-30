use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::lock_ext::MutexExt;
use crate::state::AppState;

pub const EVENT_SESSION_CHECKPOINT_REQUESTED: &str = "session-checkpoint-requested";
const CHECKPOINT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);
const CHECKPOINT_WATCHDOG_INTERVAL: Duration = Duration::from_secs(5 * 60);
const FINALIZATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(16);
const FINALIZATION_DRAIN_POLL: Duration = Duration::from_millis(10);

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
    active_mutations: AtomicUsize,
    detached_mutations: Mutex<HashSet<String>>,
}

/// Admission token held until an app-approved mutation has fully settled.
pub struct SessionMutationPermit<'a> {
    runtime: &'a SessionCheckpointRuntime,
}

impl Default for SessionCheckpointRuntime {
    fn default() -> Self {
        Self {
            next_request_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            finalizing: AtomicBool::new(false),
            active_mutations: AtomicUsize::new(0),
            detached_mutations: Mutex::new(HashSet::new()),
        }
    }
}

impl Drop for SessionMutationPermit<'_> {
    fn drop(&mut self) {
        self.runtime.active_mutations.fetch_sub(1, Ordering::AcqRel);
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

    fn begin_finalization(&self) -> Result<(), String> {
        self.finalizing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "application update finalization is already in progress".into())
    }

    #[cfg(test)]
    pub(crate) fn begin_finalization_for_test(&self) -> Result<(), String> {
        self.begin_finalization()
    }

    pub fn cancel_finalization(&self) {
        self.finalizing.store(false, Ordering::Release);
    }

    pub fn begin_mutation(&self) -> Result<SessionMutationPermit<'_>, String> {
        self.ensure_mutations_allowed()?;
        self.active_mutations.fetch_add(1, Ordering::AcqRel);
        if self.finalizing.load(Ordering::Acquire) {
            self.active_mutations.fetch_sub(1, Ordering::AcqRel);
            return Err("application update finalization is in progress".into());
        }
        Ok(SessionMutationPermit { runtime: self })
    }

    /// Admit a frontend action whose work can outlive the backend HTTP waiter.
    /// It remains active until `automation_response` explicitly completes the
    /// same request id, including responses that arrive after HTTP timeout.
    pub fn begin_detached_mutation(&self, request_id: &str) -> Result<(), String> {
        self.ensure_mutations_allowed()?;
        self.active_mutations.fetch_add(1, Ordering::AcqRel);
        if self.finalizing.load(Ordering::Acquire) {
            self.active_mutations.fetch_sub(1, Ordering::AcqRel);
            return Err("application update finalization is in progress".into());
        }
        let mut detached = match self.detached_mutations.lock_or_err() {
            Ok(detached) => detached,
            Err(error) => {
                self.active_mutations.fetch_sub(1, Ordering::AcqRel);
                return Err(error.to_string());
            }
        };
        if !detached.insert(request_id.to_owned()) {
            self.active_mutations.fetch_sub(1, Ordering::AcqRel);
            return Err(format!(
                "session checkpoint mutation {request_id} is already active"
            ));
        }
        Ok(())
    }

    pub fn finish_detached_mutation(&self, request_id: &str) -> Result<bool, String> {
        let removed = self.detached_mutations.lock_or_err()?.remove(request_id);
        if removed {
            self.active_mutations.fetch_sub(1, Ordering::AcqRel);
        }
        Ok(removed)
    }

    pub async fn begin_finalization_and_drain(&self, state: &AppState) -> Result<(), String> {
        self.begin_finalization()?;
        let drained = tokio::time::timeout(FINALIZATION_DRAIN_TIMEOUT, async {
            loop {
                let local_drained = self.active_mutations.load(Ordering::Acquire) == 0;
                let terminal_drained =
                    crate::remote_server::human_control_operations_drained(state)?;
                if local_drained && terminal_drained {
                    return Ok::<(), String>(());
                }
                tokio::time::sleep(FINALIZATION_DRAIN_POLL).await;
            }
        })
        .await;
        match drained {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                self.cancel_finalization();
                Err(error)
            }
            Err(_) => {
                self.cancel_finalization();
                Err("application update mutation drain timed out".into())
            }
        }
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
    use crate::lock_ext::MutexExt;

    #[test]
    fn finalization_gate_can_be_cancelled_after_an_install_failure() {
        let runtime = SessionCheckpointRuntime::default();
        assert!(runtime.ensure_mutations_allowed().is_ok());
        runtime.begin_finalization().unwrap();
        assert!(runtime.ensure_mutations_allowed().is_err());
        runtime.cancel_finalization();
        assert!(runtime.ensure_mutations_allowed().is_ok());
    }

    #[tokio::test]
    async fn finalization_waits_for_an_admitted_mutation_to_finish() {
        let state = std::sync::Arc::new(AppState::new());
        let permit = state.session_checkpoint.begin_mutation().unwrap();
        let task_state = state.clone();
        let drain = tokio::spawn(async move {
            task_state
                .session_checkpoint
                .begin_finalization_and_drain(&task_state)
                .await
        });

        tokio::task::yield_now().await;
        assert!(state.session_checkpoint.ensure_mutations_allowed().is_err());
        assert!(!drain.is_finished());
        drop(permit);

        assert!(drain.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn finalization_waits_for_a_quarantined_pty_completion() {
        let state = std::sync::Arc::new(AppState::new());
        state
            .remote_control
            .lock_or_err()
            .unwrap()
            .register_enqueued_remote_operation_for_test("lease-1", "terminal-1");
        let task_state = state.clone();
        let drain = tokio::spawn(async move {
            task_state
                .session_checkpoint
                .begin_finalization_and_drain(&task_state)
                .await
        });

        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        state
            .remote_control
            .lock_or_err()
            .unwrap()
            .clear_active_operations_for_test();

        assert!(drain.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn finalization_waits_for_a_frontend_action_past_http_timeout() {
        let state = std::sync::Arc::new(AppState::new());
        state
            .session_checkpoint
            .begin_detached_mutation("action-1")
            .unwrap();
        let task_state = state.clone();
        let drain = tokio::spawn(async move {
            task_state
                .session_checkpoint
                .begin_finalization_and_drain(&task_state)
                .await
        });

        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        assert!(state
            .session_checkpoint
            .finish_detached_mutation("action-1")
            .unwrap());

        assert!(drain.await.unwrap().is_ok());
    }
}
