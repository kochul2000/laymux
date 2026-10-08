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

#[tauri::command]
pub async fn save_session_checkpoint(
    snapshot: LocalSessionSnapshot,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CheckpointCommit, String> {
    save_session_checkpoint_impl(snapshot, state.inner().clone()).await
}
pub(crate) async fn save_session_checkpoint_impl(
    snapshot: LocalSessionSnapshot,
    state: Arc<AppState>,
) -> Result<CheckpointCommit, String> {
    if let Some(daemon) = state.daemon.get() {
        return daemon.save_session(snapshot).await;
    }
    tokio::task::spawn_blocking(move || {
        save_session_checkpoint_with_store(
            &snapshot,
            &LocalStateStore::new(crate::local_state::state_path().map_err(String::from)?),
            &state.session_checkpoint.hints,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn load_session_checkpoint(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<LocalSessionSnapshot>, String> {
    if let Some(daemon) = state.daemon.get() {
        return serde_json::from_value(
            daemon
                .read(crate::daemon_requests::ReadCommand::SessionState)
                .await?,
        )
        .map_err(|error| format!("daemon session snapshot rejected: {error}"));
    }
    tokio::task::spawn_blocking(|| {
        LocalStateStore::new(crate::local_state::state_path().map_err(String::from)?)
            .load_session()
            .map_err(String::from)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command(async)]
pub fn export_portable_settings() -> Result<serde_json::Value, String> {
    crate::local_state::portable_value(&crate::settings::load_settings_checked()?)
        .map_err(String::from)
}
