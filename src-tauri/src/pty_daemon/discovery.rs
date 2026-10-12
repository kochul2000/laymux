//! Where a PTY daemon instance publishes itself and how clients trust it.
//!
//! The daemon root is per build kind (`laymux` / `laymux-dev`) under the
//! user's local state root, so a release GUI never adopts a dev daemon or vice
//! versa. Inside it each executable build has its own generation directory
//! and daemon (ADR-0308). A PID or socket file alone is never trusted: a client must present
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
    PTY_DAEMON_GENERATION_PREFIX, PTY_DAEMON_LOCK_FILE, PTY_DAEMON_LOG_FILE,
};

/// The per-build-kind directory that holds one subdirectory per daemon
/// generation (ADR-0308). Every executable build is its own generation, so an
/// update or a rebuild starts a new daemon for new terminals while the
/// previous generation keeps the sessions it already runs until they end.
#[derive(Debug, Clone)]
pub struct DaemonRoot {
    dir: PathBuf,
}

impl DaemonRoot {
    pub fn for_current_build() -> Result<Self, String> {
        if let Some(dir) = std::env::var_os(ENV_LAYMUX_PTY_DAEMON_DIR).filter(|dir| !dir.is_empty())
        {
            return Self::overridden(Path::new(&dir));
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

    /// A root named by `LAYMUX_PTY_DAEMON_DIR`, made absolute against this
    /// process: the daemon runs in its generation directory, where a relative
    /// path would mean somewhere else.
    fn overridden(dir: &Path) -> Result<Self, String> {
        std::path::absolute(dir)
            .map(Self::in_dir)
            .map_err(|error| format!("invalid {ENV_LAYMUX_PTY_DAEMON_DIR}: {error}"))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn generation(&self, key: &str) -> DaemonPaths {
        DaemonPaths::in_dir(self.dir.join(key))
    }

    /// The generation named by a caller, only if `key` is a well-formed
    /// generation key: it is joined to the root, so nothing else may pass.
    pub fn named_generation(&self, key: &str) -> Option<DaemonPaths> {
        is_generation_key(key).then(|| self.generation(key))
    }

    /// The generation of the running executable.
    ///
    /// Identified once per process: the executable may be replaced (a
    /// package upgrade) while this build keeps running.
    pub fn current(&self) -> Result<DaemonPaths, String> {
        static CURRENT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        if let Some(key) = CURRENT.get() {
            return Ok(self.generation(key));
        }
        let exe = std::env::current_exe()
            .map_err(|error| format!("cannot locate the laymux executable: {error}"))?;
        let key = generation_key(&exe)
            .map_err(|error| format!("cannot identify the laymux build: {error}"))?;
        Ok(self.generation(CURRENT.get_or_init(|| key)))
    }

    /// Every generation directory present, live or not.
    pub fn generations(&self) -> Vec<DaemonPaths> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut generations: Vec<_> = entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| is_generation_key(name))
            .map(|name| self.generation(&name))
            .collect();
        generations.sort_by(|left, right| left.dir.cmp(&right.dir));
        generations
    }
}

/// `g<protocol>-<build>`: the wire protocol and a digest of the executable's
/// size and modification time, the same identity staging uses (ADR-0301). A
/// digest keeps the directory, and the socket inside it, short.
pub fn generation_key(exe: &Path) -> io::Result<String> {
    let meta = std::fs::metadata(exe)?;
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let digest = <Sha256 as sha2::Digest>::digest(format!("{}:{modified}", meta.len()));
    let build: String = digest[..GENERATION_DIGEST_BYTES]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(format!(
        "{PTY_DAEMON_GENERATION_PREFIX}{}-{build}",
        super::wire::PROTOCOL_VERSION
    ))
}

const GENERATION_DIGEST_BYTES: usize = 6;

fn is_generation_key(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(PTY_DAEMON_GENERATION_PREFIX) else {
        return false;
    };
    let Some((protocol, build)) = rest.split_once('-') else {
        return false;
    };
    !protocol.is_empty()
        && protocol.bytes().all(|byte| byte.is_ascii_digit())
        && build.len() == GENERATION_DIGEST_BYTES * 2
        && build.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// One daemon generation's directory.
#[derive(Debug, Clone)]
pub struct DaemonPaths {
    dir: PathBuf,
}

impl DaemonPaths {
    /// The current build's generation.
    pub fn for_current_build() -> Result<Self, String> {
        DaemonRoot::for_current_build()?.current()
    }

    pub fn in_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The generation key: the directory's name.
    pub fn generation(&self) -> String {
        self.dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
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
    fn an_overridden_root_is_absolute_whatever_the_daemon_runs_in() {
        let root = DaemonRoot::overridden(Path::new("tmp/pd")).unwrap();
        assert!(root.dir().is_absolute());
        assert!(root.dir().ends_with(Path::new("tmp").join("pd")));
    }

    #[test]
    fn each_build_is_its_own_generation_of_this_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("laymux.exe");
        std::fs::write(&exe, b"first build").unwrap();
        let first = generation_key(&exe).unwrap();
        assert!(is_generation_key(&first), "{first}");
        assert!(first.starts_with(&format!("g{}-", super::super::wire::PROTOCOL_VERSION)));
        assert_eq!(generation_key(&exe).unwrap(), first);

        std::fs::write(&exe, b"second build, longer").unwrap();
        assert_ne!(generation_key(&exe).unwrap(), first);
    }

    #[test]
    fn only_generation_directories_are_generations_and_names_cannot_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = DaemonRoot::in_dir(dir.path());
        for name in ["g3-0123456789ab", "g4-ba9876543210", "runtime", "g3-xyz"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        std::fs::write(dir.path().join("g3-aaaaaaaaaaaa"), b"a file").unwrap();
        let names: Vec<_> = root
            .generations()
            .iter()
            .map(DaemonPaths::generation)
            .collect();
        assert_eq!(names, ["g3-0123456789ab", "g4-ba9876543210"]);

        assert!(root.named_generation("g3-0123456789ab").is_some());
        for bad in ["..", "g3-../../x", "g3-0123456789ab/..", "runtime", ""] {
            assert!(root.named_generation(bad).is_none(), "{bad}");
        }
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
