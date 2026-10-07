use super::{Settings, SettingsLoadResult};
use crate::local_state::{LocalSessionSnapshot, LocalStateStore};
use std::path::Path;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn store_for_settings(path: &Path) -> Result<LocalStateStore, String> {
    Ok(LocalStateStore::new(path.with_file_name("state.db")))
}
pub(crate) fn production_store() -> Result<LocalStateStore, String> {
    Ok(LocalStateStore::new(
        crate::local_state::state_path().map_err(String::from)?,
    ))
}
pub(super) fn hydrate(
    path: &Path,
    mut result: SettingsLoadResult,
    store: Result<LocalStateStore, String>,
) -> SettingsLoadResult {
    let settings = match &mut result {
        SettingsLoadResult::Ok { settings, .. }
        | SettingsLoadResult::Repaired { settings, .. }
        | SettingsLoadResult::Recovered { settings, .. } => settings,
        SettingsLoadResult::ParseError { .. } => return result,
    };
    let loaded = (|| {
        let store = store.as_ref().map_err(Clone::clone)?;
        crate::local_state::apply_configuration(
            settings,
            store.load_configuration().map_err(String::from)?,
        )
        .map_err(String::from)?;
        if let Some(session) = store.load_session().map_err(String::from)? {
            apply_session(settings, session);
        } else {
            let defaults = Settings::default();
            settings.workspaces = defaults.workspaces;
            for workspace in &mut settings.workspaces {
                for pane in &mut workspace.panes {
                    pane.view.extra["profile"] = settings.default_profile.clone().into();
                }
            }
            settings.docks = defaults.docks;
            settings.workspace_display_order.clear();
        }
        Ok::<_, String>(())
    })();
    match loaded {
        Ok(()) => result,
        Err(error) => SettingsLoadResult::ParseError {
            settings: Settings::default(),
            error: format!(
                "Local state could not be loaded; original database is preserved: {error}"
            ),
            storage_kind: Some("localState".into()),
            settings_path: store
                .as_ref()
                .map(|s| s.path().display().to_string())
                .unwrap_or_else(|_| path.display().to_string()),
        },
    }
}
pub(crate) fn apply_session(settings: &mut Settings, session: LocalSessionSnapshot) {
    settings.workspaces = session.workspaces;
    settings.docks = session.docks;
    settings.workspace_display_order = session.workspace_display_order;
    settings.local_ui_state = Some(session.ui_state);
}
/// Called only under the settings write gate; never holds AppState locks.
pub(super) fn write_configuration(
    path: &Path,
    settings: &Settings,
    store: &LocalStateStore,
) -> Result<(), String> {
    let (portable, machine) =
        crate::local_state::split_configuration(settings).map_err(String::from)?;
    store.save_configuration(&machine).map_err(String::from)?;
    let bytes = serde_json::to_vec_pretty(&portable).map_err(|e| e.to_string())?;
    if std::fs::read(path).is_ok_and(|old| old == bytes) {
        return Ok(());
    }
    super::write_file_atomically(path, &bytes)
}
