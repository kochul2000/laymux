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
    // Appearance resolution can hit the font system and read font files
    // (ADR-0077), so snapshot the sessions first and release the lock before
    // resolving.
    let snapshots: Vec<SessionSnapshot> = {
        let terminals = app_state.terminals.lock_or_err()?;
        terminals
            .values()
            .map(|session| SessionSnapshot {
                id: session.id.clone(),
                title: session.title.clone(),
                profile: session.config.profile.clone(),
                cwd: session.cwd.clone(),
                branch: session.branch.clone(),
                cols: session.config.cols,
                rows: session.config.rows,
                sync_group: session.config.sync_group.clone(),
                command_running: session.command_running,
            })
            .collect()
    };

    Ok(snapshots
        .into_iter()
        .map(|snapshot| RemoteTerminalInfo {
            appearance: resolve_remote_terminal_appearance(&snapshot.profile, settings),
            id: snapshot.id,
            title: snapshot.title,
            profile: snapshot.profile,
            cwd: snapshot.cwd,
            branch: snapshot.branch,
            cols: snapshot.cols,
            rows: snapshot.rows,
            sync_group: snapshot.sync_group,
            command_running: snapshot.command_running,
        })
        .collect())
}

/// Session fields copied out under the `terminals` lock, before appearance
/// resolution runs outside it.
struct SessionSnapshot {
    id: String,
    title: String,
    profile: String,
    cwd: Option<String>,
    branch: Option<String>,
    cols: u16,
    rows: u16,
    sync_group: String,
    command_running: bool,
}
