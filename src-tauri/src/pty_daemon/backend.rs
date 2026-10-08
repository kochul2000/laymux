//! Backend selection for new terminals and the daemon endpoint identity.

use super::client::list_sessions;
use super::launcher;
use super::wire::SessionInfo;
use super::DaemonPaths;
use crate::constants::ENV_LAYMUX_PTY_DAEMON;
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

/// The backend a user terminal should use. A live session an earlier GUI
/// left detached for this terminal id is adopted instead of spawning a new
/// child, so a crashed or killed GUI does not start the same work twice.
/// When the daemon is enabled but cannot be reached this is an error rather
/// than a silent local fallback, so a terminal never ends up with a lifetime
/// other than the one selected.
pub fn terminal_backend(terminal_id: &str) -> Result<PtyBackend, String> {
    if !is_enabled() {
        return Ok(PtyBackend::Local);
    }
    let paths = DaemonPaths::for_current_build()?;
    let endpoint = launcher::ensure_running(&paths)?;
    let adopt = match list_sessions(&endpoint) {
        Ok(sessions) => adoptable_session(&sessions, terminal_id),
        Err(error) => {
            // Without the catalog the safe choice is a new child: adopting
            // blindly could take over the wrong work.
            tracing::warn!(terminal_id, %error, "PTY daemon catalog unavailable; spawning new session");
            None
        }
    };
    Ok(PtyBackend::Daemon { endpoint, adopt })
}

/// A session is adoptable when it belongs to this terminal, no GUI holds it,
/// and it is neither exiting nor being terminated. With several candidates
/// (which a single GUI never creates) the newest key wins deterministically.
fn adoptable_session(sessions: &[SessionInfo], terminal_id: &str) -> Option<String> {
    sessions
        .iter()
        .filter(|session| {
            session.terminal_id == terminal_id
                && !session.attached
                && !session.exited
                && !session.terminating
        })
        .map(|session| session.session_id.clone())
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(session_id: &str, terminal_id: &str) -> SessionInfo {
        SessionInfo {
            session_id: session_id.into(),
            terminal_id: terminal_id.into(),
            child_pid: Some(1),
            attached: false,
            exited: false,
            terminating: false,
        }
    }

    #[test]
    fn only_a_detached_live_session_of_the_same_terminal_is_adopted() {
        let mut attached = info("pane-a#1-x", "pane-a");
        attached.attached = true;
        let mut exited = info("pane-a#2-x", "pane-a");
        exited.exited = true;
        let mut terminating = info("pane-a#3-x", "pane-a");
        terminating.terminating = true;
        let other = info("pane-b#1-x", "pane-b");
        assert_eq!(
            adoptable_session(&[attached, exited, terminating, other.clone()], "pane-a"),
            None
        );
        assert_eq!(
            adoptable_session(&[other, info("pane-a#4-x", "pane-a")], "pane-a"),
            Some("pane-a#4-x".into())
        );
    }

    #[test]
    fn the_daemon_is_on_unless_explicitly_disabled() {
        assert!(enabled_for(None));
        assert!(enabled_for(Some("1")));
        assert!(enabled_for(Some("")));
        assert!(!enabled_for(Some("0")));
    }
}
