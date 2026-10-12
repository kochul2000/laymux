//! Backend selection for new terminals and the daemon endpoint identity.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::client::MissedOutput;
use super::control::{list_sessions, terminate_by_id};
use super::discovery::DaemonRoot;
use super::launcher;
use super::wire::SessionInfo;
use crate::constants::{
    ENV_LAYMUX_PTY_DAEMON, PTY_DAEMON_GENERATION_GC_MIN_AGE_MS, PTY_DAEMON_METADATA_PROFILE,
    PTY_DAEMON_OTHER_GENERATIONS_TTL_MS,
};
use crate::lock_ext::MutexExt;
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

/// A live session of an earlier GUI to take over, and the daemon (of
/// whichever generation) that runs it.
#[derive(Debug, Clone)]
pub struct DaemonAdoption {
    pub endpoint: DaemonEndpoint,
    pub session_id: String,
    /// What of the terminal's first output is the backlog it missed
    /// (ADR-0309).
    pub missed_output: Arc<MissedOutput>,
}

/// The backend a user terminal should use.
///
/// New sessions always go to the current build's daemon generation
/// (ADR-0308). With `allow_adopt` (the first create of this terminal id in
/// this GUI process), a live session an earlier GUI left detached for the
/// same terminal and profile is adopted instead of spawning a new child, from
/// any live generation that speaks this protocol, so a crashed, killed or
/// updated GUI does not start the same work twice. Later creates of the id
/// (restart, profile change, StrictMode remount) always start fresh.
///
/// When the daemon cannot be started or reached, the terminal falls back to
/// an in-process PTY: with the daemon on by default, failing every terminal
/// would be worse than losing crash survival for this one (ADR-0301).
pub fn terminal_backend(terminal_id: &str, profile: &str, allow_adopt: bool) -> PtyBackend {
    if !is_enabled() {
        return PtyBackend::Local;
    }
    let started = DaemonRoot::for_current_build().and_then(|root| {
        let paths = root.current()?;
        let endpoint = launcher::ensure_running(&paths)?;
        Ok((root, paths.generation(), endpoint))
    });
    let (root, current, endpoint) = match started {
        Ok(started) => started,
        Err(error) => {
            tracing::warn!(terminal_id, %error, "PTY daemon unavailable; using an in-process PTY");
            return PtyBackend::Local;
        }
    };
    // Its sessions must not end while this GUI runs (ADR-0312).
    super::presence::keep(&endpoint);
    collect_unused_generations_once(&root, &current);
    let adopt = if allow_adopt {
        match catalogs(&root, &current, &endpoint) {
            Ok(catalogs) => {
                let listings: Vec<&[SessionInfo]> = catalogs
                    .iter()
                    .map(|(_, sessions)| sessions.as_slice())
                    .collect();
                let choice = choose_adoption(&listings, terminal_id, profile);
                end_stale_sessions(&catalogs, choice.stale);
                choice.adopt.map(|(catalog, session_id)| {
                    super::presence::keep(&catalogs[catalog].0);
                    DaemonAdoption {
                        endpoint: catalogs[catalog].0.clone(),
                        session_id,
                        missed_output: Arc::default(),
                    }
                })
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

/// The current generation's sessions first, then those of every other live
/// generation of this protocol. A current catalog that cannot be read is an
/// error; another generation that cannot be read is skipped, since none of
/// its sessions could be adopted anyway.
fn catalogs(
    root: &DaemonRoot,
    current: &str,
    endpoint: &DaemonEndpoint,
) -> Result<Vec<(DaemonEndpoint, Vec<SessionInfo>)>, String> {
    let mut catalogs = vec![(
        endpoint.clone(),
        list_sessions(endpoint).map_err(|error| error.to_string())?,
    )];
    catalogs.extend(other_generations(root, current)?);
    Ok(catalogs)
}

type Catalog = (DaemonEndpoint, Vec<SessionInfo>);

/// The other live generations' sessions, newest generation first, listed
/// at most once per `PTY_DAEMON_OTHER_GENERATIONS_TTL_MS`. A restored layout
/// creates its panes one after another, and a generation that holds its lock
/// without answering would otherwise cost every pane the handshake timeout.
/// A listing that went stale is safe: adoption is claimed atomically, and a
/// stale session is ended only with the epoch it was listed with.
fn other_generations(root: &DaemonRoot, current: &str) -> Result<Vec<Catalog>, String> {
    static LISTED: Mutex<Option<(Instant, Vec<Catalog>)>> = Mutex::new(None);
    let mut listed = LISTED.lock_or_err()?;
    if let Some((at, catalogs)) = listed.as_ref() {
        if at.elapsed() < Duration::from_millis(PTY_DAEMON_OTHER_GENERATIONS_TTL_MS) {
            return Ok(catalogs.clone());
        }
    }
    let mut catalogs = Vec::new();
    for live in launcher::live_generations(root, |generation| generation != current)? {
        let launcher::GenerationState::Ready(endpoint) = live.state else {
            continue;
        };
        // Its sessions may wait for a pane this GUI has not mounted yet.
        super::presence::keep(&endpoint);
        match list_sessions(&endpoint) {
            Ok(sessions) => catalogs.push((endpoint, sessions)),
            Err(error) => {
                tracing::warn!(generation = %live.generation, %error, "PTY daemon generation did not list its sessions");
            }
        }
    }
    *listed = Some((Instant::now(), catalogs.clone()));
    Ok(catalogs)
}

/// Collect generations no daemon uses, once per GUI process and off the
/// terminal-creation path.
fn collect_unused_generations_once(root: &DaemonRoot, current: &str) {
    static COLLECTED: AtomicBool = AtomicBool::new(false);
    if COLLECTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let (root, current) = (root.clone(), current.to_owned());
    std::thread::spawn(move || {
        launcher::collect_unused_generations(
            &root,
            &current,
            Duration::from_millis(PTY_DAEMON_GENERATION_GC_MIN_AGE_MS),
        );
    });
}

#[derive(Debug, PartialEq, Eq)]
struct AdoptionChoice {
    /// (catalog index, session id)
    adopt: Option<(usize, String)>,
    /// Other detached sessions of this terminal. A pane shows one session,
    /// so these could never be adopted and would only keep running unseen.
    /// (catalog index, session id, attach epoch when listed)
    stale: Vec<(usize, String, u64)>,
}

/// A session is a candidate when it belongs to this terminal, no GUI holds
/// it, and it is neither exiting nor being terminated. The first candidate
/// wins: catalogs are in preference order (the current generation first),
/// and within one the newest by that daemon's creation order. It is adopted
/// if it was started with the same profile; every other candidate is stale.
fn choose_adoption(
    catalogs: &[&[SessionInfo]],
    terminal_id: &str,
    profile: &str,
) -> AdoptionChoice {
    let mut candidates: Vec<(usize, &SessionInfo)> = catalogs
        .iter()
        .enumerate()
        .flat_map(|(catalog, sessions)| sessions.iter().map(move |session| (catalog, session)))
        .filter(|(_, session)| {
            session.terminal_id == terminal_id
                && !session.attached
                && !session.exited
                && !session.terminating
        })
        .collect();
    candidates.sort_by_key(|(catalog, session)| (*catalog, std::cmp::Reverse(session.created_seq)));
    let adopt = candidates
        .first()
        .filter(|(_, first)| {
            first
                .metadata
                .get(PTY_DAEMON_METADATA_PROFILE)
                .is_some_and(|started_with| started_with == profile)
        })
        .map(|(catalog, first)| (*catalog, first.session_id.clone()));
    let stale = candidates
        .iter()
        .filter(|(catalog, session)| {
            adopt.as_ref() != Some(&(*catalog, session.session_id.clone()))
        })
        .map(|(catalog, session)| (*catalog, session.session_id.clone(), session.attach_epoch))
        .collect();
    AdoptionChoice { adopt, stale }
}

/// Each request carries the epoch the session was listed with, so one that
/// was adopted in the meantime is left to its new owner.
fn end_stale_sessions(
    catalogs: &[(DaemonEndpoint, Vec<SessionInfo>)],
    stale: Vec<(usize, String, u64)>,
) {
    if stale.is_empty() {
        return;
    }
    let stale: Vec<_> = stale
        .into_iter()
        .map(|(catalog, session_id, epoch)| (catalogs[catalog].0.clone(), session_id, epoch))
        .collect();
    std::thread::spawn(move || {
        for (endpoint, session_id, attach_epoch) in stale {
            if let Err(error) = terminate_by_id(&endpoint, &session_id, Some(attach_epoch)) {
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
            attach_epoch: 1,
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

    fn choose(sessions: &[SessionInfo], terminal_id: &str, profile: &str) -> AdoptionChoice {
        choose_adoption(&[sessions], terminal_id, profile)
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
            choose(
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
            choose(&[other, info("a4", "pane-a", 5, "PS")], "pane-a", "PS").adopt,
            Some((0, "a4".into()))
        );
    }

    #[test]
    fn the_newest_candidate_wins_by_creation_order_and_the_rest_are_stale() {
        // Keys sort opposite to creation order on purpose.
        let choice = choose(
            &[
                info("z-old", "pane-a", 1, "PS"),
                info("a-new", "pane-a", 9, "PS"),
            ],
            "pane-a",
            "PS",
        );
        assert_eq!(choice.adopt, Some((0, "a-new".into())));
        assert_eq!(choice.stale, vec![(0, "z-old".to_owned(), 1)]);
    }

    #[test]
    fn a_session_started_with_another_profile_is_not_adopted() {
        let choice = choose(&[info("a1", "pane-a", 1, "WSL")], "pane-a", "PS");
        assert_eq!(choice.adopt, None);
        assert_eq!(choice.stale, vec![(0, "a1".to_owned(), 1)]);
    }

    #[test]
    fn a_session_of_an_earlier_generation_is_adopted_from_its_own_daemon() {
        let current = [info("b1", "pane-b", 1, "PS")];
        let earlier = [info("a1", "pane-a", 7, "PS")];
        let choice = choose_adoption(&[&current, &earlier], "pane-a", "PS");
        assert_eq!(choice.adopt, Some((1, "a1".into())));
        assert!(choice.stale.is_empty());
    }

    #[test]
    fn the_current_generation_is_preferred_whatever_the_creation_order() {
        // Creation order is per daemon and says nothing across generations.
        let current = [info("new", "pane-a", 1, "PS")];
        let earlier = [info("old", "pane-a", 50, "PS")];
        let choice = choose_adoption(&[&current, &earlier], "pane-a", "PS");
        assert_eq!(choice.adopt, Some((0, "new".into())));
        assert_eq!(choice.stale, vec![(1, "old".to_owned(), 1)]);
    }

    #[test]
    fn the_daemon_is_on_unless_explicitly_disabled() {
        assert!(enabled_for(None));
        assert!(enabled_for(Some("1")));
        assert!(enabled_for(Some("")));
        assert!(!enabled_for(Some("0")));
    }
}
