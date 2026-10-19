//! Explicit replacement of a failed output generation, retaining the daemon child.
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::lock_ext::MutexExt;
use crate::state::AppState;

#[tauri::command]
pub async fn reconnect_terminal_session(
    id: String,
    generation: u64,
    cols: u16,
    rows: u16,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<u64, String> {
    reconnect_terminal_session_inner(id, generation, cols, rows, &state, app).await
}

pub(crate) async fn reconnect_terminal_session_inner(
    id: String,
    generation: u64,
    cols: u16,
    rows: u16,
    state: &Arc<AppState>,
    app: AppHandle,
) -> Result<u64, String> {
    if cols == 0 || rows == 0 {
        return Err("terminal size must be positive".into());
    }
    let (config, cwd, cwd_send, cwd_receive) = {
        let terminals = state.terminals.lock_or_err()?;
        let session = terminals.get(&id).ok_or("Terminal no longer exists")?;
        (
            session.config.clone(),
            session.cwd.clone(),
            session.cwd_send,
            session.cwd_receive,
        )
    };
    super::terminal::create_terminal_session_inner(
        id.clone(),
        config.profile,
        cols,
        rows,
        config.sync_group,
        Some(cwd_send),
        Some(cwd_receive),
        cwd,
        None,
        None,
        state,
        app,
        Some(generation),
    )
    .await?;
    state
        .pty_handles
        .lock_or_err()?
        .get(&id)
        .map(|handle| handle.terminal_generation())
        .ok_or("Terminal closed during reconnect".into())
}
