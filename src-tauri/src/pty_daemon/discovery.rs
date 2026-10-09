//! Where a PTY daemon instance publishes itself and how clients trust it.
//!
//! The daemon directory is per build kind (`laymux` / `laymux-dev`) under the
//! user's local state root, so a release GUI never adopts a dev daemon or vice
//! versa. A PID or socket file alone is never trusted: a client must present
//! the per-instance random token from `daemon.json` and receive a matching
//! protocol version in the handshake. The trust is mutual: the daemon must
//! answer the client's fresh nonce with a proof only the token holder can
//! compute, so a program squatting on a stale endpoint never receives a
//! terminal's command, environment or input.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::constants::{
    ENV_LAYMUX_PTY_DAEMON_DIR, PTY_DAEMON_DIR_NAME, PTY_DAEMON_DISCOVERY_FILE,
    PTY_DAEMON_LOCK_FILE, PTY_DAEMON_LOG_FILE,
};

#[derive(Debug, Clone)]
pub struct DaemonPaths {
    dir: PathBuf,
}

impl DaemonPaths {
    pub fn for_current_build() -> Result<Self, String> {
        if let Some(dir) = std::env::var_os(ENV_LAYMUX_PTY_DAEMON_DIR).filter(|dir| !dir.is_empty())
        {
            return Ok(Self::in_dir(PathBuf::from(dir)));
        }
        let state_db = crate::local_state::state_path().map_err(|error| error.to_string())?;
        let base = state_db
            .parent()
            .ok_or_else(|| "local state path has no parent directory".to_string())?;
        Ok(Self::in_dir(base.join(PTY_DAEMON_DIR_NAME)))
    }

    pub fn in_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn discovery_file(&self) -> PathBuf {
        self.dir.join(PTY_DAEMON_DISCOVERY_FILE)
    }

    pub fn lock_file(&self) -> PathBuf {
        self.dir.join(PTY_DAEMON_LOCK_FILE)
    }

    pub fn log_file(&self) -> PathBuf {
        self.dir.join(PTY_DAEMON_LOG_FILE)
    }

    /// Create the directory private to the current user (ADR-0305), so the
    /// token, lock and socket inside are too, wherever the directory is.
    pub fn ensure_dir(&self) -> io::Result<()> {
        crate::local_socket::ensure_private_dir(&self.dir)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub pid: u32,
    pub endpoint: String,
    pub token: String,
    pub protocol_version: u32,
}

/// Publish atomically (temp file + rename) so a reader never sees a torn file.
pub fn write_discovery(paths: &DaemonPaths, discovery: &Discovery) -> io::Result<()> {
    paths.ensure_dir()?;
    let target = paths.discovery_file();
    let temp = paths
        .dir()
        .join(format!("daemon.json.{}.tmp", discovery.pid));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(discovery).map_err(io::Error::other)?)?;
        file.sync_all()?;
    }
    std::fs::rename(&temp, &target)
}

pub fn read_discovery(paths: &DaemonPaths) -> Option<Discovery> {
    let bytes = std::fs::read(paths.discovery_file()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Remove discovery only if it still names this daemon, so an exiting daemon
/// never unpublishes a successor.
pub fn remove_discovery_if_owned(paths: &DaemonPaths, pid: u32) {
    if read_discovery(paths).is_some_and(|discovery| discovery.pid == pid) {
        let _ = std::fs::remove_file(paths.discovery_file());
    }
}

pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("PTY daemon token generation failed: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn tokens_match(presented: &str, expected: &str) -> bool {
    let (presented, expected) = (presented.as_bytes(), expected.as_bytes());
    if presented.len() != expected.len() {
        return false;
    }
    presented
        .iter()
        .zip(expected)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// The daemon's answer to a client nonce: HMAC-SHA256 keyed by the instance
/// token, hex encoded. Compare with [`tokens_match`].
pub fn handshake_proof(token: &str, nonce: &str) -> io::Result<String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .map_err(|_| io::Error::other("PTY daemon proof key is invalid"))?;
    mac.update(nonce.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_proof_depends_on_both_token_and_nonce() {
        let token = generate_token().unwrap();
        let nonce = generate_token().unwrap();
        let proof_of = |token: &str, nonce: &str| handshake_proof(token, nonce).unwrap();
        let proof = proof_of(&token, &nonce);
        assert_eq!(proof.len(), 64);
        assert!(tokens_match(&proof, &proof_of(&token, &nonce)));
        assert!(!tokens_match(&proof, &proof_of(&nonce, &token)));
        assert!(!tokens_match(
            &proof,
            &proof_of(&generate_token().unwrap(), &nonce)
        ));
        assert!(!tokens_match(
            &proof,
            &proof_of(&token, &generate_token().unwrap())
        ));
    }

    #[test]
    fn discovery_round_trips_and_only_its_owner_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = DaemonPaths::in_dir(dir.path().join("pty-daemon"));
        let discovery = Discovery {
            pid: 4242,
            endpoint: "endpoint".into(),
            token: generate_token().unwrap(),
            protocol_version: 1,
        };
        write_discovery(&paths, &discovery).unwrap();
        assert_eq!(read_discovery(&paths), Some(discovery.clone()));

        remove_discovery_if_owned(&paths, 1);
        assert_eq!(read_discovery(&paths), Some(discovery));
        remove_discovery_if_owned(&paths, 4242);
        assert_eq!(read_discovery(&paths), None);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_and_directory_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let paths = DaemonPaths::in_dir(dir.path().join("pty-daemon"));
        write_discovery(
            &paths,
            &Discovery {
                pid: 1,
                endpoint: String::new(),
                token: String::new(),
                protocol_version: 1,
            },
        )
        .unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(paths.dir()), 0o700);
        assert_eq!(mode(&paths.discovery_file()), 0o600);
    }

    #[test]
    fn tokens_are_random_and_compared_exactly() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(tokens_match(&a, &a.clone()));
        assert!(!tokens_match(&a, &b));
        assert!(!tokens_match(&a, &a[..63]));
        assert!(!tokens_match("", &a));
    }
}
