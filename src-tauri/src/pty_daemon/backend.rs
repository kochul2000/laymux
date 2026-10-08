//! Backend selection for new terminals and the daemon endpoint identity.

use super::launcher;
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
