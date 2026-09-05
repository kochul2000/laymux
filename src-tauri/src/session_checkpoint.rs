use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::lock_ext::MutexExt;
use crate::state::AppState;

mod eviction;
pub use eviction::TerminalMutationPermit;
#[cfg(test)]
mod eviction_tests;

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
    eviction: Mutex<eviction::EvictionAdmission>,
    active_mutations: AtomicUsize,
    detached_mutations: Mutex<HashSet<String>>,
    retired_pty_completions: Mutex<Vec<crate::pty_control::PtyControlCompletion>>,
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
            eviction: Mutex::new(eviction::EvictionAdmission::default()),
            active_mutations: AtomicUsize::new(0),
            detached_mutations: Mutex::new(HashSet::new()),
            retired_pty_completions: Mutex::new(Vec::new()),
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
        } else if !self.eviction.lock_or_err()?.targets.is_empty() {
            Err("hidden terminal eviction is in progress".into())
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
        if let Err(error) = self.ensure_mutations_allowed() {
            self.active_mutations.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
        Ok(SessionMutationPermit { runtime: self })
    }

    /// TerminalView cleanup cannot remain mounted to retry a close rejected by
    /// a transient destructive fence. Keep that close outside the admitted set
    /// until finalization is cancelled, then acquire the normal race-safe
    /// permit. A successful updater exits the process with the waiter still
    /// parked, while a failed checkpoint releases it to dispose the orphaned
    /// backend PTY.
    pub async fn begin_mutation_after_finalization(&self) -> SessionMutationPermit<'_> {
        loop {
            if let Ok(permit) = self.begin_mutation() {
                return permit;
            }
            tokio::time::sleep(FINALIZATION_DRAIN_POLL).await;
        }
    }

    /// Admit a frontend action whose work can outlive the backend HTTP waiter.
    /// It remains active until `automation_response` explicitly completes the
    /// same request id, including responses that arrive after HTTP timeout.
    pub fn begin_detached_mutation(&self, request_id: &str) -> Result<(), String> {
        self.ensure_mutations_allowed()?;
        self.active_mutations.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = self.ensure_mutations_allowed() {
            self.active_mutations.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
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

    /// Preserve a faulted worker acknowledgement after its handle leaves the
    /// live registry. The close mutation permit is still held while this is
    /// registered, so finalization cannot observe a gap between the two.
    pub(crate) fn quarantine_retired_pty_completion(
        &self,
        completion: crate::pty_control::PtyControlCompletion,
    ) -> Result<(), String> {
        if completion.is_complete() {
            return Ok(());
        }
        let mut completions = self.retired_pty_completions.lock_or_err()?;
        completions.retain(|pending| !pending.is_complete());
        completions.push(completion);
        Ok(())
    }

    pub async fn begin_finalization_and_drain(&self, state: &AppState) -> Result<(), String> {
        self.begin_finalization()?;
        let drained = tokio::time::timeout(FINALIZATION_DRAIN_TIMEOUT, async {
            loop {
                let local_drained = self.active_mutations.load(Ordering::Acquire) == 0
                    && self.terminal_mutations_drained()?;
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
    let live_drained = handles.iter().all(|handle| {
        handle
            .pending_control_completion()
            .is_none_or(|completion| completion.is_complete())
    });
    if !live_drained {
        return Ok(false);
    }
    let mut retired = state
        .session_checkpoint
        .retired_pty_completions
        .lock_or_err()?;
    retired.retain(|completion| !completion.is_complete());
    Ok(retired.is_empty())
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

/// Protect hidden-terminal eviction with target-scoped input admission.
/// Unrelated terminals remain writable. The backend owns the
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

    let live_targets = match state.pty_handles.lock_or_err() {
        Ok(handles) => requested
            .iter()
            .filter(|terminal_id| handles.contains_key(*terminal_id))
            .cloned()
            .collect::<Vec<_>>(),
        Err(error) => return Err(error.to_string()),
    };

    if live_targets.is_empty() {
        return Ok(HiddenTerminalEvictionResult {
            closed_terminal_ids: Vec::new(),
            failed_terminal_ids: requested,
        });
    }

    let _eviction = state
        .session_checkpoint
        .begin_eviction_and_drain(&state, &live_targets)
        .await?;

    request_frontend_checkpoint_for_terminals(
        &app,
        &state,
        "eviction",
        true,
        Some(live_targets.clone()),
    )
    .await?;

    let close_state = std::sync::Arc::clone(state.inner());
    let close_app = app.clone();
    let close_results = tauri::async_runtime::spawn_blocking(move || {
        run_hidden_close_batch(live_targets, |terminal_id| {
            crate::commands::close_terminal_session_inner(terminal_id, &close_state, &close_app)
        })
    })
    .await
    .map_err(|error| format!("hidden terminal close worker failed: {error}"))?;

    let mut closed_terminal_ids = Vec::new();
    let mut failed_terminal_ids: Vec<_> = requested
        .into_iter()
        .filter(|terminal_id| {
            !close_results
                .iter()
                .any(|(live_terminal_id, _)| live_terminal_id == terminal_id)
        })
        .collect();
    for (terminal_id, close_result) in close_results {
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

    Ok(HiddenTerminalEvictionResult {
        closed_terminal_ids,
        failed_terminal_ids,
    })
}

fn run_hidden_close_batch(
    terminal_ids: Vec<String>,
    close: impl Fn(&str) -> Result<(), String> + Sync,
) -> Vec<(String, Result<(), String>)> {
    std::thread::scope(|scope| {
        let close = &close;
        terminal_ids
            .into_iter()
            .map(|terminal_id| {
                let panic_terminal_id = terminal_id.clone();
                let worker = scope.spawn(move || {
                    let result = close(&terminal_id);
                    (terminal_id, result)
                });
                (panic_terminal_id, worker)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|(terminal_id, worker)| {
                worker.join().unwrap_or_else(|_| {
                    (
                        terminal_id,
                        Err("hidden terminal close worker panicked".into()),
                    )
                })
            })
            .collect()
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
mod tests;
