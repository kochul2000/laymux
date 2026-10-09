//! The user's view of the PTY daemon's sessions (ADR-0306): which ones this
//! GUI's panes use, which ones the saved layout will still re-adopt, and
//! which ones nothing will ever hold again — the only ones that may be ended.
//!
//! Destruction follows two rules learned the hard way by other terminal
//! hosts: a failed listing is an error, never "no sessions", and ending a
//! session carries the attach epoch seen in the listing, so a session that
//! was re-adopted in the meantime is left alone.

use std::collections::HashSet;

use serde::Serialize;

use super::control::{list_sessions, request_terminate};
use super::discovery::DaemonPaths;
use super::launcher::find_reachable;
use super::wire::SessionInfo;
use super::DaemonEndpoint;
use crate::constants::{PTY_DAEMON_METADATA_PROFILE, TERMINAL_ID_PREFIX};
use crate::local_state::{LocalSessionSnapshot, LocalStateStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PtySessionState {
    /// Attached by one of this GUI's panes.
    Pane,
    /// No client, but a pane of the saved layout (a workspace not opened yet,
    /// a dock) will adopt it when it mounts. Never ended from here.
    AwaitingPane,
    /// No client and no pane that will ever adopt it: left by a GUI that
    /// crashed before its layout was saved.
    Detached,
    /// Attached by a client that is not one of this GUI's panes.
    OtherClient,
    /// Its child exited or a terminate is in progress.
    Ending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionEntry {
    pub session_id: String,
    pub terminal_id: String,
    /// The profile the session was started with.
    pub profile: Option<String>,
    /// Daemon-wide creation order; larger is newer.
    pub created_seq: u64,
    pub child_pid: Option<u32>,
    pub attach_epoch: u64,
    pub state: PtySessionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInventory {
    pub daemon_running: bool,
    pub sessions: Vec<PtySessionEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminateOutcome {
    /// The session is ending.
    Terminated,
    /// It was attached again after it was listed and was left running.
    Superseded,
    /// It is not (or no longer) a detached session; nothing was done.
    NotDetached,
    /// It no longer exists.
    Gone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateDetachedResult {
    pub ended: usize,
    /// Per-session failures; the others were still ended.
    pub failed: Vec<String>,
}

/// Terminals this GUI owns: live panes, and every terminal the saved layout
/// will create (and so adopt) when its workspace or dock mounts.
pub struct KnownTerminals {
    pub panes: HashSet<String>,
    pub layout: HashSet<String>,
}

impl KnownTerminals {
    /// Live panes plus the saved layout. A layout that cannot be read is an
    /// error: without it a session waiting for its pane would look detached.
    pub fn load(panes: HashSet<String>) -> Result<Self, String> {
        let path = crate::local_state::state_path().map_err(String::from)?;
        let snapshot = LocalStateStore::new(path)
            .load_session()
            .map_err(|error| format!("cannot read the saved layout: {error}"))?;
        Ok(Self {
            panes,
            layout: snapshot
                .as_ref()
                .map(layout_terminal_ids)
                .unwrap_or_default(),
        })
    }
}

/// List the daemon's sessions. No daemon running is an empty inventory; a
/// daemon that does not answer is an error. Read-only: never starts a daemon,
/// and works whether or not this GUI uses the daemon for new terminals.
pub fn inventory(known: &KnownTerminals) -> Result<PtySessionInventory, String> {
    let Some(endpoint) = running_daemon()? else {
        return Ok(PtySessionInventory {
            daemon_running: false,
            sessions: Vec::new(),
        });
    };
    Ok(PtySessionInventory {
        daemon_running: true,
        sessions: classify(listed(&endpoint)?, known),
    })
}

/// End a session listed as detached with `attach_epoch`. The session is
/// classified again first, so a pane's session (or one the layout awaits)
/// cannot be ended through this path even with its current epoch.
pub fn terminate(
    session_id: &str,
    attach_epoch: u64,
    known: &KnownTerminals,
) -> Result<TerminateOutcome, String> {
    let endpoint = running_daemon()?.ok_or_else(|| "PTY daemon is not running".to_string())?;
    let entry = classify(listed(&endpoint)?, known)
        .into_iter()
        .find(|entry| entry.session_id == session_id);
    match entry {
        None => Ok(TerminateOutcome::Gone),
        Some(entry) if entry.state != PtySessionState::Detached => {
            Ok(TerminateOutcome::NotDetached)
        }
        // A re-adoption between this check and the request bumps the epoch,
        // which the daemon checks atomically.
        Some(_) => terminate_on(&endpoint, session_id, attach_epoch),
    }
}

/// End every detached session, each with the epoch it is listed with.
pub fn terminate_detached(known: &KnownTerminals) -> Result<TerminateDetachedResult, String> {
    let mut result = TerminateDetachedResult {
        ended: 0,
        failed: Vec::new(),
    };
    let Some(endpoint) = running_daemon()? else {
        return Ok(result);
    };
    for entry in classify(listed(&endpoint)?, known) {
        if entry.state != PtySessionState::Detached {
            continue;
        }
        match terminate_on(&endpoint, &entry.session_id, entry.attach_epoch) {
            Ok(TerminateOutcome::Terminated) => result.ended += 1,
            Ok(_) => {}
            Err(error) => result
                .failed
                .push(format!("{}: {error}", entry.terminal_id)),
        }
    }
    Ok(result)
}

fn listed(endpoint: &DaemonEndpoint) -> Result<Vec<SessionInfo>, String> {
    list_sessions(endpoint)
        .map_err(|error| format!("PTY daemon did not list its sessions: {error}"))
}

fn terminate_on(
    endpoint: &DaemonEndpoint,
    session_id: &str,
    attach_epoch: u64,
) -> Result<TerminateOutcome, String> {
    let reply = request_terminate(endpoint, session_id, Some(attach_epoch))
        .map_err(|error| format!("PTY daemon terminate request failed: {error}"))?;
    Ok(if !reply.found {
        TerminateOutcome::Gone
    } else if reply.superseded {
        TerminateOutcome::Superseded
    } else {
        TerminateOutcome::Terminated
    })
}

fn running_daemon() -> Result<Option<DaemonEndpoint>, String> {
    find_reachable(&DaemonPaths::for_current_build()?)
}

/// Terminal ids of every TerminalView the saved layout restores: workspace
/// slots (all layers of a stack, ADR-0297) and dock panes.
fn layout_terminal_ids(snapshot: &LocalSessionSnapshot) -> HashSet<String> {
    let workspaces = snapshot
        .workspaces
        .iter()
        .flat_map(|workspace| &workspace.panes)
        .flat_map(|pane| pane.content_views())
        .filter(|(_, view)| view.view_type == "TerminalView")
        .map(|(id, _)| id.to_string());
    let docks = snapshot
        .docks
        .iter()
        .flat_map(|dock| &dock.panes)
        .filter(|pane| pane.view["type"].as_str() == Some("TerminalView"))
        .map(|pane| pane.id.clone());
    workspaces
        .chain(docks)
        .filter(|id| !id.is_empty())
        .map(|id| format!("{TERMINAL_ID_PREFIX}{id}"))
        .collect()
}

fn classify(sessions: Vec<SessionInfo>, known: &KnownTerminals) -> Vec<PtySessionEntry> {
    let mut entries: Vec<_> = sessions
        .into_iter()
        .map(|session| {
            let state = if session.exited || session.terminating {
                PtySessionState::Ending
            } else if session.attached {
                if known.panes.contains(&session.terminal_id) {
                    PtySessionState::Pane
                } else {
                    PtySessionState::OtherClient
                }
            } else if known.layout.contains(&session.terminal_id)
                || known.panes.contains(&session.terminal_id)
            {
                PtySessionState::AwaitingPane
            } else {
                PtySessionState::Detached
            };
            PtySessionEntry {
                profile: session.metadata.get(PTY_DAEMON_METADATA_PROFILE).cloned(),
                session_id: session.session_id,
                terminal_id: session.terminal_id,
                created_seq: session.created_seq,
                child_pid: session.child_pid,
                attach_epoch: session.attach_epoch,
                state,
            }
        })
        .collect();
    entries.sort_by_key(|entry| (entry.state as u8, entry.terminal_id.clone()));
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn session(id: &str, terminal: &str, attached: bool, exited: bool) -> SessionInfo {
        SessionInfo {
            session_id: id.into(),
            terminal_id: terminal.into(),
            created_seq: 1,
            attach_epoch: 3,
            metadata: BTreeMap::from([(PTY_DAEMON_METADATA_PROFILE.into(), "PowerShell".into())]),
            child_pid: Some(42),
            attached,
            exited,
            terminating: false,
        }
    }

    fn known(panes: &[&str], layout: &[&str]) -> KnownTerminals {
        KnownTerminals {
            panes: panes.iter().map(|id| id.to_string()).collect(),
            layout: layout.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn sessions_are_classified_by_who_holds_or_will_hold_them() {
        let entries = classify(
            vec![
                session("c#1", "pane-c", false, false),
                session("a#1", "pane-a", true, false),
                session("b#1", "pane-b", true, false),
                session("d#1", "pane-d", false, true),
                // An unopened workspace's pane: the layout will adopt it.
                session("e#1", "pane-e", false, false),
            ],
            &known(&["pane-a"], &["pane-a", "pane-e"]),
        );
        let states: Vec<_> = entries
            .iter()
            .map(|entry| (entry.terminal_id.as_str(), entry.state))
            .collect();
        assert_eq!(
            states,
            vec![
                ("pane-a", PtySessionState::Pane),
                ("pane-e", PtySessionState::AwaitingPane),
                ("pane-c", PtySessionState::Detached),
                ("pane-b", PtySessionState::OtherClient),
                ("pane-d", PtySessionState::Ending),
            ]
        );
        assert_eq!(entries[2].attach_epoch, 3);
        assert_eq!(entries[2].profile.as_deref(), Some("PowerShell"));
    }

    #[test]
    fn the_saved_layout_names_every_terminal_it_restores() {
        let snapshot: LocalSessionSnapshot = serde_json::from_value(serde_json::json!({
            "workspaces": [{
                "id": "ws-a",
                "name": "A",
                "panes": [
                    {"id": "p1", "x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0,
                     "view": {"type": "TerminalView"}},
                    {"id": "slot", "x": 0.5, "y": 0.0, "w": 0.5, "h": 1.0,
                     "layers": [
                        {"id": "l1", "view": {"type": "TerminalView"}},
                        {"id": "l2", "view": {"type": "MemoView"}}
                     ]}
                ]
            }],
            "docks": [{
                "position": "right",
                "panes": [
                    {"id": "d1", "view": {"type": "TerminalView"}},
                    {"id": "d2", "view": {"type": "FileExplorerView"}}
                ]
            }]
        }))
        .unwrap();
        assert_eq!(
            layout_terminal_ids(&snapshot),
            HashSet::from([
                "terminal-p1".to_string(),
                "terminal-l1".to_string(),
                "terminal-d1".to_string(),
            ])
        );
    }
}

#[cfg(test)]
mod daemon_tests {
    use super::super::tests::{raw_spawn, sleeper, TestDaemon};
    use super::*;

    #[test]
    fn a_listed_detached_session_ends_with_its_epoch_and_a_stale_epoch_is_refused() {
        let daemon = TestDaemon::start();
        let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-v#1", sleeper());
        drop(writer);
        drop(reader);
        let deadline = std::time::Instant::now() + super::super::tests::TIMEOUT;
        let entry = loop {
            let sessions = list_sessions(&daemon.endpoint).unwrap();
            let entries = classify(
                sessions,
                &KnownTerminals {
                    panes: HashSet::new(),
                    layout: HashSet::new(),
                },
            );
            if let Some(entry) = entries
                .into_iter()
                .find(|entry| entry.state == PtySessionState::Detached)
            {
                break entry;
            }
            assert!(std::time::Instant::now() < deadline, "never detached");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };

        // An epoch other than the listed one belongs to some newer owner.
        assert_eq!(
            terminate_on(&daemon.endpoint, &entry.session_id, entry.attach_epoch + 1).unwrap(),
            TerminateOutcome::Superseded
        );
        assert_eq!(daemon.server.session_count(), 1);

        assert_eq!(
            terminate_on(&daemon.endpoint, &entry.session_id, entry.attach_epoch).unwrap(),
            TerminateOutcome::Terminated
        );
        daemon.wait_for_sessions(0);
        assert_eq!(
            terminate_on(&daemon.endpoint, &entry.session_id, entry.attach_epoch).unwrap(),
            TerminateOutcome::Gone
        );
    }
}
