//! Acquisition-to-save handoff and cleanup of the same fenced checkpoint.
use super::resize_target;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn seal_codex_status_checkpoint(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    seal_inner(&state, &token)
}

pub(super) fn seal_inner(state: &AppState, token: &str) -> Result<(), String> {
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
            .any(|target| target.proof.is_none() || target.next_step.is_some())
    {
        return Err(
            "Codex status checkpoint cannot seal without every proof and its input fence".into(),
        );
    }
    checkpoint.sealed = true;
    Ok(())
}

#[tauri::command]
pub fn complete_codex_status_checkpoint(
    token: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    complete_inner(&state, &token)
}

pub(super) fn complete_inner(state: &AppState, token: &str) -> Result<(), String> {
    let mut slot = state.session_checkpoint.codex_status.lock_or_err()?;
    let checkpoint = slot
        .as_mut()
        .ok_or("Codex status checkpoint was cancelled")?;
    checkpoint.check(token)?;
    if !checkpoint.sealed
        || !state.session_checkpoint.is_finalizing()
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

pub(super) fn finish_inner(state: &AppState, token: &str) -> Result<(), String> {
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
    // A successful close retains admission through window destruction. The
    // acquisition deadline never reopens input or discards a sealed save proof.
    if checkpoint.owns_fence && (!checkpoint.completed || !errors.is_empty()) {
        state.session_checkpoint.cancel_finalization();
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
