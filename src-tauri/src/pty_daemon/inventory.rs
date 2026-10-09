//! The user's view of the PTY daemon's sessions (ADR-0306): which ones this
//! GUI's panes use, which ones nobody holds any more, and ending the latter.
//!
//! Destruction follows two rules learned the hard way by other terminal
//! hosts: a failed listing is an error, never "no sessions", and ending a
//! session carries the attach epoch seen in the listing, so a session that
//! was re-adopted in the meantime is left alone.

use std::collections::HashSet;

use serde::Serialize;

use super::control::{list_sessions, request_terminate};
use super::discovery::DaemonPaths;
use super::launcher::find_running;
use super::wire::SessionInfo;
use super::DaemonEndpoint;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PtySessionState {
    /// Attached by one of this GUI's panes.
    Pane,
    /// Running with no client: left by a crashed GUI and not re-adopted.
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
    /// It no longer exists.
    Gone,
}

/// List the daemon's sessions. `pane_terminal_ids` are the terminals this GUI
/// owns; no daemon running is an empty inventory, a daemon that does not
/// answer is an error.
pub fn inventory(pane_terminal_ids: &HashSet<String>) -> Result<PtySessionInventory, String> {
    let Some(endpoint) = running_daemon()? else {
        return Ok(PtySessionInventory {
            daemon_running: false,
            sessions: Vec::new(),
        });
    };
    let sessions = list_sessions(&endpoint)
        .map_err(|error| format!("PTY daemon did not list its sessions: {error}"))?;
    Ok(PtySessionInventory {
        daemon_running: true,
        sessions: classify(sessions, pane_terminal_ids),
    })
}

/// End a session as listed with `attach_epoch`.
pub fn terminate(session_id: &str, attach_epoch: u64) -> Result<TerminateOutcome, String> {
    let endpoint = running_daemon()?.ok_or_else(|| "PTY daemon is not running".to_string())?;
    terminate_on(&endpoint, session_id, attach_epoch)
}

/// End every listed session that nobody holds, each with its listed epoch.
/// Returns how many were ended.
pub fn terminate_detached(pane_terminal_ids: &HashSet<String>) -> Result<usize, String> {
    let Some(endpoint) = running_daemon()? else {
        return Ok(0);
    };
    let sessions = list_sessions(&endpoint)
        .map_err(|error| format!("PTY daemon did not list its sessions: {error}"))?;
    let mut ended = 0;
    for entry in classify(sessions, pane_terminal_ids) {
        if entry.state == PtySessionState::Detached
            && terminate_on(&endpoint, &entry.session_id, entry.attach_epoch)?
                == TerminateOutcome::Terminated
        {
            ended += 1;
        }
    }
    Ok(ended)
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
    if !super::is_enabled() {
        return Ok(None);
    }
    find_running(&DaemonPaths::for_current_build()?)
}

fn classify(
    sessions: Vec<SessionInfo>,
    pane_terminal_ids: &HashSet<String>,
) -> Vec<PtySessionEntry> {
    let mut entries: Vec<_> = sessions
        .into_iter()
        .map(|session| {
            let state = if session.exited || session.terminating {
                PtySessionState::Ending
            } else if !session.attached {
                PtySessionState::Detached
            } else if pane_terminal_ids.contains(&session.terminal_id) {
                PtySessionState::Pane
            } else {
                PtySessionState::OtherClient
            };
            PtySessionEntry {
                session_id: session.session_id,
                terminal_id: session.terminal_id,
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
            metadata: BTreeMap::new(),
            child_pid: Some(42),
            attached,
            exited,
            terminating: false,
        }
    }

    #[test]
    fn sessions_are_classified_by_who_holds_them() {
        let panes = HashSet::from(["pane-a".to_string()]);
        let entries = classify(
            vec![
                session("pane-c#1-x", "pane-c", false, false),
                session("pane-a#1-x", "pane-a", true, false),
                session("pane-b#1-x", "pane-b", true, false),
                session("pane-d#1-x", "pane-d", false, true),
            ],
            &panes,
        );
        let states: Vec<_> = entries
            .iter()
            .map(|entry| (entry.terminal_id.as_str(), entry.state))
            .collect();
        assert_eq!(
            states,
            vec![
                ("pane-a", PtySessionState::Pane),
                ("pane-c", PtySessionState::Detached),
                ("pane-b", PtySessionState::OtherClient),
                ("pane-d", PtySessionState::Ending),
            ]
        );
        assert_eq!(entries[1].attach_epoch, 3);
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
            let entries = classify(sessions, &HashSet::new());
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
