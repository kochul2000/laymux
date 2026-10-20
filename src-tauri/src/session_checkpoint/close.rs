use super::{request_frontend_checkpoint_for_terminals, HiddenTerminalEvictionResult};
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use tauri::{AppHandle, State};

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
    checkpoint_and_close_terminals(terminal_ids, "eviction", None, &app, state.inner()).await
}

/// Explicit Restart View uses the same target fence, checkpoint and teardown.
#[tauri::command]
pub async fn checkpoint_and_close_terminal_for_restart(
    id: String,
    generation: Option<u64>,
    app: AppHandle,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    let result = checkpoint_and_close_terminals(
        vec![id.clone()],
        crate::constants::SESSION_CHECKPOINT_REASON_RESTART,
        generation,
        &app,
        state.inner(),
    )
    .await?;
    if result.closed_terminal_ids.contains(&id) {
        Ok(())
    } else {
        Err(crate::error::AppError::SessionNotFound(id).into())
    }
}

async fn checkpoint_and_close_terminals(
    terminal_ids: Vec<String>,
    reason: &'static str,
    expected_generation: Option<u64>,
    app: &AppHandle,
    state: &std::sync::Arc<AppState>,
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
        .begin_eviction_and_drain(state, &live_targets)
        .await?;

    if let Some(expected) = expected_generation {
        let handles = state.pty_handles.lock_or_err()?;
        if live_targets.iter().any(|id| {
            handles
                .get(id)
                .is_none_or(|handle| handle.terminal_generation() != expected)
        }) {
            return Err(
                crate::error::AppError::Other("restart target generation changed".into()).into(),
            );
        }
    }

    request_frontend_checkpoint_for_terminals(app, state, reason, true, Some(live_targets.clone()))
        .await?;

    let close_state = std::sync::Arc::clone(state);
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

pub(super) fn run_hidden_close_batch(
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
