//! Update barriers follow the live PTY's teardown ownership (ADR-0323).
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use tauri::AppHandle;

pub(super) async fn request(app: &AppHandle, state: &AppState) -> Result<u64, String> {
    // The caller has fenced and drained mutations before this snapshot.
    let targets = restore_targets(state)?;
    super::request_frontend_checkpoint_for_terminals(
        app,
        state,
        "update",
        // Empty terminalIds mean "all" to critical validation, so an empty
        // local scope must explicitly select the ordinary persistence path.
        !targets.is_empty(),
        Some(targets),
    )
    .await
}

/// Only GUI-owned PTYs are destroyed by installation (ADR-0308, ADR-0323).
/// Scope critical validation, never the layout/session snapshot being saved.
pub(crate) fn restore_targets(state: &AppState) -> Result<Vec<String>, String> {
    let handles = state.pty_handles.lock_or_err()?;
    let mut targets: Vec<_> = handles
        .iter()
        .filter(|(_, handle)| !handle.is_backend_owned())
        .map(|(id, _)| id.clone())
        .collect();
    targets.sort();
    Ok(targets)
}
