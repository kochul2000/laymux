use serde::Serialize;

use crate::lock_ext::MutexExt;
use crate::settings::models::Settings;
use crate::state::AppState;

use super::appearance::{resolve_remote_terminal_appearance, RemoteTerminalAppearance};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTerminalInfo {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) profile: String,
    pub(super) cwd: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) sync_group: String,
    pub(super) command_running: bool,
    pub(super) appearance: RemoteTerminalAppearance,
}

pub(super) fn remote_terminal_infos(
    app_state: &AppState,
    settings: &Settings,
) -> Result<Vec<RemoteTerminalInfo>, String> {
    let terminals = app_state.terminals.lock_or_err()?;

    Ok(terminals
        .values()
        .map(|session| RemoteTerminalInfo {
            id: session.id.clone(),
            title: session.title.clone(),
            profile: session.config.profile.clone(),
            cwd: session.cwd.clone(),
            branch: session.branch.clone(),
            cols: session.config.cols,
            rows: session.config.rows,
            sync_group: session.config.sync_group.clone(),
            command_running: session.command_running,
            appearance: resolve_remote_terminal_appearance(&session.config.profile, settings),
        })
        .collect())
}
