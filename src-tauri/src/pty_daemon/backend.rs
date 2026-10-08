//! Backend selection for new terminals and the daemon endpoint identity.

use super::client::{list_sessions, terminate_by_id};
use super::launcher;
use super::wire::SessionInfo;
use super::DaemonPaths;
use crate::constants::{ENV_LAYMUX_PTY_DAEMON, PTY_DAEMON_METADATA_PROFILE};
use crate::pty::PtyBackend;

/// Address and credential of one live daemon instance.
#[derive(Clone)]
pub struct DaemonEndpoint {
    pub(crate) endpoint: String,
    pub(crate) token: String,
}

impl std::fmt::Debug for DaemonEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonEndpoint")
            .field("endpoint", &self.endpoint)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// Daemon session identity for one terminal generation. Generations restart
/// at 1 in every GUI process, so a random suffix keeps a new GUI's key from
/// colliding with a session an earlier GUI left running, and a restarted
/// terminal from colliding with a predecessor that is still shutting down.
pub fn session_key(terminal_id: &str, terminal_generation: u64) -> String {
    format!(
        "{terminal_id}#{terminal_generation}-{}",
        uuid::Uuid::new_v4().simple()
    )
}

/// On by default (ADR-0301). `LAYMUX_PTY_DAEMON=0` keeps PTYs in the GUI
/// process as a rollback switch.
pub fn is_enabled() -> bool {
    enabled_for(std::env::var(ENV_LAYMUX_PTY_DAEMON).ok().as_deref())
}

fn enabled_for(value: Option<&str>) -> bool {
    value != Some("0")
}

/// The backend a user terminal should use.
///
/// With `allow_adopt` (the first create of this terminal id in this GUI
/// process), a live session an earlier GUI left detached for the same
/// terminal and profile is adopted instead of spawning a new child, so a
/// crashed or killed GUI does not start the same work twice. Later creates of
/// the id (restart, profile change, StrictMode remount) always start fresh.
///
/// When the daemon cannot be started or reached, the terminal falls back to
/// an in-process PTY: with the daemon on by default, failing every terminal
/// would be worse than losing crash survival for this one (ADR-0301).
pub fn terminal_backend(terminal_id: &str, profile: &str, allow_adopt: bool) -> PtyBackend {
    if !is_enabled() {
        return PtyBackend::Local;
    }
    let endpoint = match DaemonPaths::for_current_build()
        .and_then(|paths| launcher::ensure_running(&paths))
    {
        Ok(endpoint) => endpoint,
        Err(error) => {
            tracing::warn!(terminal_id, %error, "PTY daemon unavailable; using an in-process PTY");
            return PtyBackend::Local;
        }
    };
    let adopt = if allow_adopt {
        match list_sessions(&endpoint) {
            Ok(sessions) => {
                let choice = choose_adoption(&sessions, terminal_id, profile);
                end_stale_sessions(&endpoint, choice.stale);
                choice.adopt
            }
            Err(error) => {
                // Without the catalog the safe choice is a new child:
                // adopting blindly could take over the wrong work.
                tracing::warn!(terminal_id, %error, "PTY daemon catalog unavailable; spawning new session");
                None
            }
        }
    } else {
        None
    };
    PtyBackend::Daemon { endpoint, adopt }
}

#[derive(Debug, PartialEq, Eq)]
struct AdoptionChoice {
    adopt: Option<String>,
    /// Other detached sessions of this terminal. A pane shows one session,
    /// so these could never be adopted and would only keep running unseen.
    stale: Vec<String>,
}

/// A session is a candidate when it belongs to this terminal, no GUI holds
/// it, and it is neither exiting nor being terminated. The newest candidate
/// (by daemon creation order) is adopted if it was started with the same
/// profile; every other candidate is stale.
fn choose_adoption(sessions: &[SessionInfo], terminal_id: &str, profile: &str) -> AdoptionChoice {
    let mut candidates: Vec<&SessionInfo> = sessions
        .iter()
        .filter(|session| {
            session.terminal_id == terminal_id
                && !session.attached
                && !session.exited
                && !session.terminating
        })
        .collect();
    candidates.sort_by_key(|session| std::cmp::Reverse(session.created_seq));
    let mut candidates = candidates.into_iter();
    let adopt = candidates
        .next()
        .filter(|newest| {
            newest
                .metadata
                .get(PTY_DAEMON_METADATA_PROFILE)
                .is_some_and(|started_with| started_with == profile)
        })
        .map(|newest| newest.session_id.clone());
    let stale = sessions
        .iter()
        .filter(|session| {
            session.terminal_id == terminal_id
                && !session.attached
                && !session.exited
                && !session.terminating
                && Some(&session.session_id) != adopt.as_ref()
        })
        .map(|session| session.session_id.clone())
        .collect();
    AdoptionChoice { adopt, stale }
}

fn end_stale_sessions(endpoint: &DaemonEndpoint, stale: Vec<String>) {
    if stale.is_empty() {
        return;
    }
    let endpoint = endpoint.clone();
    std::thread::spawn(move || {
        for session_id in stale {
            if let Err(error) = terminate_by_id(&endpoint, &session_id, None) {
                tracing::warn!(%session_id, %error, "failed to end a stale PTY daemon session");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn info(session_id: &str, terminal_id: &str, created_seq: u64, profile: &str) -> SessionInfo {
        SessionInfo {
            session_id: session_id.into(),
            terminal_id: terminal_id.into(),
            created_seq,
            metadata: BTreeMap::from([(
                PTY_DAEMON_METADATA_PROFILE.to_owned(),
                profile.to_owned(),
            )]),
            child_pid: Some(1),
            attached: false,
            exited: false,
            terminating: false,
        }
    }

    #[test]
    fn only_a_detached_live_session_of_the_same_terminal_is_a_candidate() {
        let mut attached = info("a1", "pane-a", 1, "PS");
        attached.attached = true;
        let mut exited = info("a2", "pane-a", 2, "PS");
        exited.exited = true;
        let mut terminating = info("a3", "pane-a", 3, "PS");
        terminating.terminating = true;
        let other = info("b1", "pane-b", 4, "PS");
        assert_eq!(
            choose_adoption(
                &[attached, exited, terminating, other.clone()],
                "pane-a",
                "PS"
            ),
            AdoptionChoice {
                adopt: None,
                stale: vec![]
            }
        );
        assert_eq!(
            choose_adoption(&[other, info("a4", "pane-a", 5, "PS")], "pane-a", "PS").adopt,
            Some("a4".into())
        );
    }

    #[test]
    fn the_newest_candidate_wins_by_creation_order_and_the_rest_are_stale() {
        // Keys sort opposite to creation order on purpose.
        let choice = choose_adoption(
            &[
                info("z-old", "pane-a", 1, "PS"),
                info("a-new", "pane-a", 9, "PS"),
            ],
            "pane-a",
            "PS",
        );
        assert_eq!(choice.adopt, Some("a-new".into()));
        assert_eq!(choice.stale, vec!["z-old".to_owned()]);
    }

    #[test]
    fn a_session_started_with_another_profile_is_not_adopted() {
        let choice = choose_adoption(&[info("a1", "pane-a", 1, "WSL")], "pane-a", "PS");
        assert_eq!(choice.adopt, None);
        assert_eq!(choice.stale, vec!["a1".to_owned()]);
    }

    #[test]
    fn the_daemon_is_on_unless_explicitly_disabled() {
        assert!(enabled_for(None));
        assert!(enabled_for(Some("1")));
        assert!(enabled_for(Some("")));
        assert!(!enabled_for(Some("0")));
    }
}
