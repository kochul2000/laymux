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
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenTerminalEvictionResult {
    closed_terminal_ids: Vec<String>,
    failed_terminal_ids: Vec<String>,
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
            Err("destructive session finalization is in progress".into())
        } else {
            Ok(())
        }
    }

    fn begin_finalization(&self) -> Result<(), String> {
        self.finalizing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "destructive session finalization is already in progress".into())
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
            return Err("destructive session finalization is in progress".into());
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
            return Err("destructive session finalization is in progress".into());
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
                let pty_drained = pty_control_operations_drained(state)?;
                if local_drained && terminal_drained && pty_drained {
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
                Err("destructive session mutation drain timed out".into())
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

/// A direct PTY caller may have timed out after faulting the input while its
/// platform worker is still unwinding. Such a caller has already dropped its
/// lexical mutation permit, so finalization must also inspect every live PTY's
/// lifecycle completion before declaring the app quiescent.
fn pty_control_operations_drained(state: &AppState) -> Result<bool, String> {
    let handles: Vec<_> = state.pty_handles.lock_or_err()?.values().cloned().collect();
    Ok(handles.iter().all(|handle| {
        handle
            .pending_control_completion()
            .is_none_or(|completion| completion.is_complete())
    }))
}

pub async fn request_frontend_checkpoint(
    app: &AppHandle,
    state: &AppState,
    reason: &'static str,
    require_conclusive: bool,
) -> Result<u64, String> {
    request_frontend_checkpoint_for_terminals(app, state, reason, require_conclusive, None).await
}

async fn request_frontend_checkpoint_for_terminals(
    app: &AppHandle,
    state: &AppState,
    reason: &'static str,
    require_conclusive: bool,
    terminal_ids: Option<Vec<String>>,
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
            terminal_ids,
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

/// Atomically protect hidden-terminal eviction with the same conservative
/// global mutation fence used by update finalization. The backend owns the
/// complete drain -> critical checkpoint -> PTY close sequence, so a frontend
/// unmount cannot open a write race between the checkpoint and destruction.
#[tauri::command]
pub async fn checkpoint_and_close_hidden_terminals(
    terminal_ids: Vec<String>,
    app: AppHandle,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<HiddenTerminalEvictionResult, String> {
    let mut requested = terminal_ids;
    requested.sort();
    requested.dedup();
    if requested.is_empty() {
        return Ok(HiddenTerminalEvictionResult {
            closed_terminal_ids: Vec::new(),
            failed_terminal_ids: Vec::new(),
        });
    }

    state
        .session_checkpoint
        .begin_finalization_and_drain(&state)
        .await?;

    let live_targets = match state.pty_handles.lock_or_err() {
        Ok(handles) => requested
            .iter()
            .filter(|terminal_id| handles.contains_key(*terminal_id))
            .cloned()
            .collect::<Vec<_>>(),
        Err(error) => {
            state.session_checkpoint.cancel_finalization();
            return Err(error.to_string());
        }
    };

    if live_targets.is_empty() {
        state.session_checkpoint.cancel_finalization();
        return Ok(HiddenTerminalEvictionResult {
            closed_terminal_ids: Vec::new(),
            failed_terminal_ids: requested,
        });
    }

    if let Err(error) = request_frontend_checkpoint_for_terminals(
        &app,
        &state,
        "eviction",
        true,
        Some(live_targets.clone()),
    )
    .await
    {
        state.session_checkpoint.cancel_finalization();
        return Err(error);
    }

    let mut closed_terminal_ids = Vec::new();
    let mut failed_terminal_ids: Vec<_> = requested
        .into_iter()
        .filter(|terminal_id| !live_targets.contains(terminal_id))
        .collect();
    for terminal_id in live_targets {
        let close_result =
            crate::commands::close_terminal_session_inner(&terminal_id, &state, &app);
        let still_present = state
            .terminals
            .lock_or_recover_for_discard("checking hidden terminal eviction result")
            .contains_key(&terminal_id);
        if close_result.is_ok() || !still_present {
            if let Err(error) = close_result {
                tracing::warn!(%terminal_id, %error, "hidden terminal closed with teardown warning");
            }
            closed_terminal_ids.push(terminal_id);
        } else {
            failed_terminal_ids.push(terminal_id);
        }
    }
    state.session_checkpoint.cancel_finalization();

    Ok(HiddenTerminalEvictionResult {
        closed_terminal_ids,
        failed_terminal_ids,
    })
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
    use std::io::Write;
    use std::sync::{Arc, Condvar};
    use std::time::Instant;

    struct StuckWriter {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for StuckWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let (released, wake) = &*self.gate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn finalization_gate_can_be_cancelled_after_an_install_failure() {
        let runtime = SessionCheckpointRuntime::default();
        assert!(runtime.ensure_mutations_allowed().is_ok());
        runtime.begin_finalization().unwrap();
        assert!(runtime.ensure_mutations_allowed().is_err());
        runtime.cancel_finalization();
        assert!(runtime.ensure_mutations_allowed().is_ok());
    }

    #[test]
    fn eviction_checkpoint_request_serializes_its_exact_targets() {
        let request = SessionCheckpointRequest {
            request_id: 7,
            reason: "eviction",
            require_conclusive: true,
            terminal_ids: Some(vec!["terminal-p1".into()]),
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "requestId": 7,
                "reason": "eviction",
                "requireConclusive": true,
                "terminalIds": ["terminal-p1"],
            })
        );
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

    #[tokio::test]
    async fn finalization_waits_for_a_faulted_direct_pty_worker_completion() {
        let state = std::sync::Arc::new(AppState::new());
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let handle = crate::pty::PtyHandle::from_test_writer(Box::new(StuckWriter {
            gate: Arc::clone(&gate),
        }));
        state
            .pty_handles
            .lock_or_err()
            .unwrap()
            .insert("terminal-1".into(), handle.clone());

        let writer = std::thread::spawn(move || {
            handle.write_guarded_until(
                b"blocked",
                Instant::now() + Duration::from_millis(20),
                || true,
            )
        });
        let pending_deadline = Instant::now() + Duration::from_secs(1);
        while pty_control_operations_drained(&state).unwrap() && Instant::now() < pending_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!pty_control_operations_drained(&state).unwrap());

        let task_state = state.clone();
        let drain = tokio::spawn(async move {
            task_state
                .session_checkpoint
                .begin_finalization_and_drain(&task_state)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        assert!(writer.join().unwrap().is_err());
        assert!(drain.await.unwrap().is_ok());
    }
}
