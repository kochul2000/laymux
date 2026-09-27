//! Explicit, fenced Codex status queries for close/update checkpoints.
mod output;
mod process_context;
mod targets;
#[cfg(test)]
mod tests;

use crate::lock_ext::MutexExt;
use crate::session_checkpoint::codex_status::{
    CodexStatusCheckpoint, CodexStatusStep, CodexStatusTarget,
};
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
const PROBE_COLS: u16 = 96;
const PROBE_ROWS: u16 = 40;
const CLEAR_ROUNDS: usize = 256;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusCheckpointStart {
    token: String,
    targets: Vec<CodexStatusCheckpointTerminal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusCheckpointTerminal {
    terminal_id: String,
    cols: u16,
    rows: u16,
}

#[tauri::command]
pub async fn begin_codex_status_checkpoint(
    update_request_id: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> Result<CodexStatusCheckpointStart, String> {
    let state = Arc::clone(&state);
    if state
        .session_checkpoint
        .codex_status
        .lock_or_err()?
        .is_some()
    {
        return Err("A Codex status checkpoint is already active".into());
    }
    let owns_fence = update_request_id.is_none();
    if let Some(id) = update_request_id {
        if !state.session_checkpoint.owns_update_checkpoint(id)? {
            return Err("Codex status query requires the active update checkpoint".into());
        }
    } else {
        state
            .session_checkpoint
            .begin_finalization_and_drain(&state)
            .await?;
    }
    let token = uuid::Uuid::new_v4().to_string();
    {
        let mut slot = state.session_checkpoint.codex_status.lock_or_err()?;
        if slot.is_some() {
            return Err("A Codex status checkpoint is already active".into());
        }
        *slot = Some(CodexStatusCheckpoint {
            token: token.clone(),
            deadline: Instant::now() + PROBE_TIMEOUT,
            owns_fence,
            completed: false,
            update_request_id,
            targets: HashMap::new(),
        });
    }
    let worker_state = Arc::clone(&state);
    let worker_token = token.clone();
    // Start the deadline before discovery: inaccessible guest config paths must
    // not leave an unbounded global input fence while begin() is still pending.
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let targets = targets::collect_targets(&worker_state)?;
        let terminals: Vec<_> = targets
            .iter()
            .map(|(id, target)| CodexStatusCheckpointTerminal {
                terminal_id: id.clone(),
                cols: target.original_cols.max(PROBE_COLS),
                rows: target.original_rows.max(PROBE_ROWS),
            })
            .collect();
        let mut slot = worker_state.session_checkpoint.codex_status.lock_or_err()?;
        let checkpoint = slot
            .as_mut()
            .ok_or("Codex status checkpoint was cancelled")?;
        checkpoint.check(&worker_token)?;
        checkpoint.targets = targets;
        Ok::<_, String>(terminals)
    });
    let result = tokio::time::timeout(PROBE_TIMEOUT, worker)
        .await
        .map_err(|_| "Codex status target discovery timed out".to_owned())
        .and_then(|result| result.map_err(|error| error.to_string()))
        .and_then(|result| result);
    let terminals = match result {
        Ok(ids) => ids,
        Err(error) => {
            finish_inner(&state, &token)?;
            return Err(error);
        }
    };
    Ok(CodexStatusCheckpointStart {
        token,
        targets: terminals,
    })
}

fn target_for(state: &AppState, token: &str, id: &str) -> Result<CodexStatusTarget, String> {
    let slot = state.session_checkpoint.codex_status.lock_or_err()?;
    let checkpoint = slot
        .as_ref()
        .ok_or("Codex status checkpoint was cancelled")?;
    checkpoint.check(token)?;
    if !state.session_checkpoint.is_finalizing()
        || checkpoint.update_request_id.is_some_and(|request| {
            !state
                .session_checkpoint
                .owns_update_checkpoint(request)
                .unwrap_or(false)
        })
    {
        return Err("Codex status checkpoint no longer owns its input fence".into());
    }
    checkpoint
        .targets
        .get(id)
        .cloned()
        .ok_or_else(|| "Terminal is not a Codex status target".into())
}

fn change_target(
    state: &AppState,
    token: &str,
    id: &str,
    change: impl FnOnce(&mut CodexStatusTarget) -> Result<(), String>,
) -> Result<(), String> {
    let mut slot = state.session_checkpoint.codex_status.lock_or_err()?;
    let checkpoint = slot
        .as_mut()
        .ok_or("Codex status checkpoint was cancelled")?;
    checkpoint.check(token)?;
    change(
        checkpoint
            .targets
            .get_mut(id)
            .ok_or("Codex status target disappeared")?,
    )
}

fn current_handle(
    state: &AppState,
    id: &str,
    target: &CodexStatusTarget,
) -> Result<crate::pty::PtyHandle, String> {
    let handle = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .cloned()
        .ok_or("Codex terminal disappeared")?;
    if handle.terminal_generation() != target.generation {
        return Err("Codex terminal generation changed".into());
    }
    targets::require_current_process(state, id, &target.process)?;
    Ok(handle)
}

fn resize_target(
    state: &AppState,
    id: &str,
    target: &CodexStatusTarget,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .cloned()
        .ok_or("Codex terminal disappeared")?;
    if handle.terminal_generation() != target.generation {
        return Err("Codex terminal generation changed".into());
    }
    {
        let mut terminals = state.terminals.lock_or_err()?;
        let terminal = terminals.get_mut(id).ok_or("Codex terminal disappeared")?;
        terminal.config.cols = cols;
        terminal.config.rows = rows;
    }
    crate::terminal_output::update_terminal_output_geometry(
        &state.terminal_protocol_states,
        id,
        cols,
        rows,
    )?;
    handle.resize(cols, rows)
}

#[tauri::command(async)]
pub fn codex_status_checkpoint_input(
    token: String,
    terminal_id: String,
    step: CodexStatusStep,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    input_inner(&state, &token, &terminal_id, step)
}

fn input_inner(
    state: &AppState,
    token: &str,
    id: &str,
    step: CodexStatusStep,
) -> Result<(), String> {
    let target = target_for(state, token, id)?;
    let _io = target.io.lock_or_err()?;
    target_for(state, token, id)?;
    let handle = current_handle(state, id, &target)?;
    // Consume the step before I/O: duplicate/retried IPC must never send a second Enter.
    change_target(state, token, id, |target| {
        if target.next_step != Some(step) {
            return Err("Unexpected Codex status query step".into());
        }
        target.next_step = None;
        Ok(())
    })?;
    let data = match step {
        CodexStatusStep::Clear => {
            change_target(state, token, id, |target| {
                target.resized = true;
                Ok(())
            })?;
            resize_target(
                state,
                id,
                &target,
                target.original_cols.max(PROBE_COLS),
                target.original_rows.max(PROBE_ROWS),
            )?;
            b"\x05\x15\x0b".repeat(CLEAR_ROUNDS)
        }
        CodexStatusStep::TypeStatus => b"\x1b[200~/status\x1b[201~".to_vec(),
        CodexStatusStep::Submit => {
            let output = crate::terminal_output::terminal_output_session_for(
                &state.terminal_protocol_states,
                id,
            )?
            .ok_or("Codex output session disappeared")?;
            let seq = output.output_buffer().snapshot(0)?.seq_end;
            change_target(state, token, id, |target| {
                target.output_start = Some(seq);
                Ok(())
            })?;
            b"\r".to_vec()
        }
    };
    handle.write_guarded(&data, || target_for(state, token, id).is_ok())?;
    change_target(state, token, id, |target| {
        target.next_step = match step {
            CodexStatusStep::Clear => Some(CodexStatusStep::TypeStatus),
            CodexStatusStep::TypeStatus => Some(CodexStatusStep::Submit),
            CodexStatusStep::Submit => None,
        };
        Ok(())
    })
}

#[tauri::command(async)]
pub fn read_codex_status_checkpoint(
    token: String,
    terminal_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let target = target_for(&state, &token, &terminal_id)?;
    current_handle(&state, &terminal_id, &target)?;
    let start = target
        .output_start
        .ok_or("Codex status command was not submitted")?;
    let output = crate::terminal_output::terminal_output_session_for(
        &state.terminal_protocol_states,
        &terminal_id,
    )?
    .ok_or("Codex output session disappeared")?;
    let bytes = output
        .output_buffer()
        .exact_snapshot_since(start, MAX_OUTPUT_BYTES)?
        .ok_or("Codex status output was lost")?;
    let Some(id) = output::parse_status_session(&bytes.data) else {
        return Ok(None);
    };
    let fresh = targets::verify_session(&target.process, &id)?;
    change_target(&state, &token, &terminal_id, |target| {
        target.proof = Some((id.clone(), fresh));
        Ok(())
    })?;
    Ok(Some(id))
}

pub(crate) fn verified_status_sessions(
    state: &AppState,
) -> Result<HashMap<String, (u64, String, bool)>, String> {
    let targets: Vec<_> = {
        let slot = state.session_checkpoint.codex_status.lock_or_err()?;
        let Some(checkpoint) = slot.as_ref() else {
            return Ok(HashMap::new());
        };
        if checkpoint.check(&checkpoint.token).is_err()
            || !state.session_checkpoint.is_finalizing()
            || checkpoint.update_request_id.is_some_and(|id| {
                !state
                    .session_checkpoint
                    .owns_update_checkpoint(id)
                    .unwrap_or(false)
            })
        {
            return Ok(HashMap::new());
        }
        checkpoint
            .targets
            .iter()
            .filter(|(_, target)| target.proof.is_some())
            .map(|(id, target)| (id.clone(), target.clone()))
            .collect()
    };
    let mut result = HashMap::new();
    for (terminal, target) in targets {
        current_handle(state, &terminal, &target)?;
        if let Some((id, _)) = target.proof {
            let fresh = targets::verify_session(&target.process, &id)?;
            result.insert(terminal, (target.generation, id, fresh));
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn complete_codex_status_checkpoint(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    complete_inner(&state, &token)
}

fn complete_inner(state: &AppState, token: &str) -> Result<(), String> {
    let mut slot = state.session_checkpoint.codex_status.lock_or_err()?;
    let checkpoint = slot
        .as_mut()
        .ok_or("Codex status checkpoint was cancelled")?;
    checkpoint.check(token)?;
    if !state.session_checkpoint.is_finalizing()
        || checkpoint.update_request_id.is_some_and(|id| {
            !state
                .session_checkpoint
                .owns_update_checkpoint(id)
                .unwrap_or(false)
        })
        || checkpoint
            .targets
            .values()
            .any(|target| target.proof.is_none())
    {
        return Err(
            "Codex status checkpoint cannot complete without its proof and input fence".into(),
        );
    }
    checkpoint.completed = true;
    if checkpoint.owns_fence {
        state.session_checkpoint.commit_close_checkpoint();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn finish_codex_status_checkpoint(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    finish_inner(&state, &token)
}

fn finish_inner(state: &AppState, token: &str) -> Result<(), String> {
    let checkpoint = {
        let mut slot = state.session_checkpoint.codex_status.lock_or_err()?;
        if slot
            .as_ref()
            .is_none_or(|checkpoint| checkpoint.token != token)
        {
            return Ok(());
        }
        slot.take().ok_or("Codex status checkpoint disappeared")?
    };
    let mut errors = Vec::new();
    for (id, target) in &checkpoint.targets {
        if !target.resized {
            continue;
        }
        match target.io.lock_or_err() {
            Ok(_io) => {
                if let Err(error) = resize_target(
                    state,
                    id,
                    target,
                    target.original_cols,
                    target.original_rows,
                ) {
                    errors.push(error);
                }
            }
            Err(error) => errors.push(error.to_string()),
        }
    }
    // A successful close retains admission through window destruction. TTL only
    // expires the proof: it must never silently reopen input while a save runs.
    if checkpoint.owns_fence && (!checkpoint.completed || !errors.is_empty()) {
        state.session_checkpoint.cancel_finalization();
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
