use serde::Serialize;

use crate::lock_ext::MutexExt;
use crate::pty_geometry::{production_geometry_capabilities, TerminalGeometryCapabilities};
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
    pub(super) geometry_capabilities: TerminalGeometryCapabilities,
    pub(super) appearance: RemoteTerminalAppearance,
}

/// Appearance resolution can query the OS font system and read multi-megabyte
/// font files on a cache miss (ADR-0077), so it runs on the blocking pool and
/// outside the `terminals` lock. Only the session snapshot happens inline.
pub(super) async fn remote_terminal_infos(
    app_state: &AppState,
    settings: &Settings,
) -> Result<Vec<RemoteTerminalInfo>, String> {
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

    let settings = settings.clone();
    tokio::task::spawn_blocking(move || resolve_appearances(snapshots, &settings))
        .await
        .map_err(|err| format!("terminal appearance resolution failed: {err}"))
}

fn resolve_appearances(
    snapshots: Vec<SessionSnapshot>,
    settings: &Settings,
) -> Vec<RemoteTerminalInfo> {
    snapshots
        .into_iter()
        .map(|snapshot| RemoteTerminalInfo {
            appearance: resolve_remote_terminal_appearance(&snapshot.profile, settings),
            geometry_capabilities: production_geometry_capabilities(),
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
        .collect()
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
