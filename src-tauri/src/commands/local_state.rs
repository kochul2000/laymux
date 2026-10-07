use crate::local_state::{CheckpointCommit, LocalSessionSnapshot, LocalStateStore};

#[tauri::command(async)]
pub fn save_session_checkpoint(snapshot: LocalSessionSnapshot) -> Result<CheckpointCommit, String> {
    LocalStateStore::new(crate::local_state::state_path().map_err(String::from)?)
        .commit_session(&snapshot)
        .map_err(String::from)
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
