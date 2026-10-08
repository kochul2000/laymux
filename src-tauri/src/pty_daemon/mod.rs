//! Detached PTY daemon (ADR-0300).
//!
//! With [`ENV_LAYMUX_PTY_DAEMON`]` = 1`, terminal PTYs and their child
//! processes are owned by a separate `laymux --pty-daemon` process instead of
//! the GUI. The GUI talks to it through [`DaemonPtySystem`], a
//! `portable_pty::PtySystem` implementation, so the output pipeline above the
//! PTY is unchanged. A GUI that disappears without terminating its terminals
//! only detaches: the sessions keep running in the daemon and can be
//! re-attached. Re-adopting them in a new GUI and update handoff build on this
//! core in later steps.
//!
//! [`ENV_LAYMUX_PTY_DAEMON`]: crate::constants::ENV_LAYMUX_PTY_DAEMON

mod client;
mod client_queue;
mod discovery;
mod entry;
mod launcher;
mod server;
mod session;
mod transport;
mod wire;

#[cfg(test)]
mod tests;

pub use client::{list_sessions, terminate_session, DaemonPtySystem};
pub use discovery::DaemonPaths;
pub use entry::run_daemon_main;
pub use launcher::{ensure_running, find_running, spawn_daemon};
pub use wire::SessionInfo;

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

/// Daemon session identity for one terminal generation. A restarted terminal
/// gets a new key, so it can never be confused with a predecessor that is
/// still shutting down.
pub fn session_key(terminal_id: &str, terminal_generation: u64) -> String {
    format!("{terminal_id}#{terminal_generation}")
}

pub fn is_enabled() -> bool {
    std::env::var(ENV_LAYMUX_PTY_DAEMON).is_ok_and(|value| value == "1")
}

/// The backend new user terminals should spawn on. When the daemon is enabled
/// but cannot be reached this is an error rather than a silent local fallback,
/// so a terminal never ends up with a lifetime other than the one selected.
pub fn terminal_backend() -> Result<PtyBackend, String> {
    if !is_enabled() {
        return Ok(PtyBackend::Local);
    }
    let paths = DaemonPaths::for_current_build()?;
    launcher::ensure_running(&paths).map(PtyBackend::Daemon)
}
