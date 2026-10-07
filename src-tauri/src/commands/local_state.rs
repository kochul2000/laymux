use crate::local_state::{CheckpointCommit, LocalSessionSnapshot, LocalStateStore};
use crate::session_checkpoint::CheckpointHints;
use crate::state::AppState;
use std::sync::Arc;

pub(crate) fn save_session_checkpoint_with_store(
    snapshot: &LocalSessionSnapshot,
    store: &LocalStateStore,
    hints: &CheckpointHints,
) -> Result<CheckpointCommit, String> {
    let commit = store.commit_session(snapshot).map_err(String::from)?;
    if commit.needs_retry {
        hints.request_retry();
    }
    Ok(commit)
}

#[tauri::command(async)]
pub fn save_session_checkpoint(
    snapshot: LocalSessionSnapshot,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CheckpointCommit, String> {
    save_session_checkpoint_with_store(
        &snapshot,
        &LocalStateStore::new(crate::local_state::state_path().map_err(String::from)?),
        &state.session_checkpoint.hints,
    )
}
#[tauri::command(async)]
pub fn load_session_checkpoint() -> Result<Option<LocalSessionSnapshot>, String> {
    LocalStateStore::new(crate::local_state::state_path().map_err(String::from)?)
        .load_session()
        .map_err(String::from)
}
#[tauri::command(async)]
pub fn export_portable_settings() -> Result<serde_json::Value, String> {
    crate::local_state::portable_value(&crate::settings::load_settings_checked()?)
        .map_err(String::from)
}
