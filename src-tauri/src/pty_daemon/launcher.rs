//! GUI side: find the current daemon instance, starting one if needed.

use std::path::Path;
#[cfg(unix)]
use std::process::Stdio;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use super::control::connect_authenticated;
use super::discovery::{read_discovery, DaemonPaths, DaemonRoot};
use super::wire::PROTOCOL_VERSION;
use super::DaemonEndpoint;
#[cfg(unix)]
use crate::constants::PTY_DAEMON_CLI_FLAG;
use crate::constants::{
    PTY_DAEMON_LAUNCH_POLL_MS, PTY_DAEMON_LAUNCH_TIMEOUT_MS, PTY_DAEMON_UNAVAILABLE_RETRY_MS,
};
use crate::lock_ext::MutexExt;

/// Serializes launches inside one GUI so parallel terminal creation starts at
/// most one daemon. Across processes the daemon's own instance lock decides.
static LAUNCH: Mutex<()> = Mutex::new(());

/// Until when this GUI treats the daemon as unavailable after a failed
/// launch. Terminal creation falls back to an in-process PTY; without this
/// every terminal (and a restored layout's panes one after another behind
/// `LAUNCH`) would pay the full launch timeout again.
static UNAVAILABLE_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

enum Probe {
    Ready(DaemonEndpoint),
    /// No daemon holds the instance lock.
    Absent,
    /// A daemon holds the lock but did not complete an authenticated
    /// handshake: still starting, or stuck. Launching another is pointless.
    Unreachable,
    /// A live daemon that speaks another protocol. It may own running work,
    /// so it is neither replaced nor killed.
    Incompatible(u32),
}

pub fn ensure_running(paths: &DaemonPaths) -> Result<DaemonEndpoint, String> {
    ensure_unavailability_expired()?;
    if let Probe::Ready(endpoint) = probe(paths)? {
        return Ok(endpoint);
    }
    let _launch = LAUNCH.lock_or_err()?;
    ensure_unavailability_expired()?;
    let launched = launch_and_wait(paths);
    if launched.is_err() {
        *UNAVAILABLE_UNTIL.lock_or_err()? =
            Some(Instant::now() + Duration::from_millis(PTY_DAEMON_UNAVAILABLE_RETRY_MS));
    }
    launched
}

fn ensure_unavailability_expired() -> Result<(), String> {
    match *UNAVAILABLE_UNTIL.lock_or_err()? {
        Some(until) if Instant::now() < until => Err(format!(
            "PTY daemon was unavailable recently; retrying after {PTY_DAEMON_UNAVAILABLE_RETRY_MS} ms"
        )),
        _ => Ok(()),
    }
}

/// Wait for a daemon to become ready, starting one only when no daemon holds
/// the instance lock. Caller holds `LAUNCH`.
fn launch_and_wait(paths: &DaemonPaths) -> Result<DaemonEndpoint, String> {
    match probe(paths)? {
        Probe::Ready(endpoint) => return Ok(endpoint),
        Probe::Absent => spawn_daemon_process(paths)?,
        // Maybe another GUI's daemon that is still starting: wait for it,
        // but a second instance would only exit on the lock.
        Probe::Unreachable => {}
        Probe::Incompatible(protocol) => return Err(incompatible(protocol)),
    }
    let deadline = Instant::now() + Duration::from_millis(PTY_DAEMON_LAUNCH_TIMEOUT_MS);
    loop {
        match probe(paths)? {
            Probe::Ready(endpoint) => return Ok(endpoint),
            Probe::Incompatible(protocol) => return Err(incompatible(protocol)),
            Probe::Absent | Probe::Unreachable => {}
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "PTY daemon did not become ready within {PTY_DAEMON_LAUNCH_TIMEOUT_MS} ms (see {})",
                paths.log_file().display()
            ));
        }
        thread::sleep(Duration::from_millis(PTY_DAEMON_LAUNCH_POLL_MS));
    }
}

fn incompatible(protocol: u32) -> String {
    format!(
        "an incompatible PTY daemon (protocol {protocol}, expected {PROTOCOL_VERSION}) is running"
    )
}

/// Find a live, authenticated daemon without starting one.
pub fn find_running(paths: &DaemonPaths) -> Result<Option<DaemonEndpoint>, String> {
    match probe(paths)? {
        Probe::Ready(endpoint) => Ok(Some(endpoint)),
        Probe::Absent | Probe::Unreachable => Ok(None),
        Probe::Incompatible(protocol) => Err(incompatible(protocol)),
    }
}

/// Like [`find_running`], but a daemon that holds its instance lock without
/// answering is an error rather than "no daemon": reporting it as absent
/// would hide sessions that are still running.
pub fn find_reachable(paths: &DaemonPaths) -> Result<Option<DaemonEndpoint>, String> {
    match probe(paths)? {
        Probe::Ready(endpoint) => Ok(Some(endpoint)),
        Probe::Absent => Ok(None),
        Probe::Unreachable => Err("PTY daemon is running but does not answer".to_string()),
        Probe::Incompatible(protocol) => Err(incompatible(protocol)),
    }
}

/// A live daemon generation as a client sees it.
#[derive(Debug, Clone)]
pub struct LiveGeneration {
    /// The generation key (ADR-0308).
    pub generation: String,
    pub state: GenerationState,
    /// When its daemon published itself; the key itself says nothing about
    /// which build came later.
    pub started: Option<std::time::SystemTime>,
}

#[derive(Debug, Clone)]
pub enum GenerationState {
    Ready(DaemonEndpoint),
    /// Holds its instance lock without answering. Reporting it as absent
    /// would hide sessions that are still running.
    Unreachable,
    /// Speaks another protocol: its sessions can be neither listed nor
    /// adopted, and it ends by itself once they are gone.
    Incompatible(u32),
}

/// Every generation `include` accepts whose daemon is alive, without starting
/// one. Read-only.
pub fn live_generations(
    root: &DaemonRoot,
    include: impl Fn(&str) -> bool,
) -> Result<Vec<LiveGeneration>, String> {
    let mut live = Vec::new();
    for paths in root.generations() {
        if !include(&paths.generation()) {
            continue;
        }
        let state = match probe(&paths)? {
            Probe::Absent => continue,
            Probe::Ready(endpoint) => GenerationState::Ready(endpoint),
            Probe::Unreachable => GenerationState::Unreachable,
            Probe::Incompatible(protocol) => GenerationState::Incompatible(protocol),
        };
        live.push(LiveGeneration {
            generation: paths.generation(),
            state,
            started: std::fs::metadata(paths.discovery_file())
                .and_then(|meta| meta.modified())
                .ok(),
        });
    }
    // Newest first.
    live.sort_by(|left, right| right.started.cmp(&left.started));
    Ok(live)
}

/// Remove generation directories no daemon uses, other than `current`, and
/// what the single-directory layout before generations left in the root.
/// A directory touched within `min_age` is kept: a GUI of that build may be
/// about to start its daemon there.
pub fn collect_unused_generations(root: &DaemonRoot, current: &str, min_age: Duration) {
    let young = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .map(|modified| modified.elapsed().unwrap_or_default() < min_age)
            .unwrap_or(true)
    };
    for paths in root.generations() {
        if paths.generation() == current || young(&paths.lock_file()) || young(paths.dir()) {
            continue;
        }
        if let Err(error) = remove_unused_generation(&paths) {
            tracing::debug!(dir = %paths.dir().display(), %error, "unused PTY daemon generation not removed");
        }
    }
    let legacy = DaemonPaths::in_dir(root.dir());
    if legacy.lock_file().is_file() && !daemon_instance_alive(&legacy) {
        for name in LEGACY_ROOT_ENTRIES {
            let path = root.dir().join(name);
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

/// Remove a generation directory while holding its instance lock, so a daemon
/// of that build starting meanwhile either finds the lock taken and gives up,
/// or starts after the directory is gone and makes a new one. The lock file
/// goes last.
fn remove_unused_generation(paths: &DaemonPaths) -> std::io::Result<()> {
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .open(paths.lock_file())?;
    lock.try_lock().map_err(std::io::Error::other)?;
    for entry in std::fs::read_dir(paths.dir())? {
        let path = entry?.path();
        if path == paths.lock_file() {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    drop(lock);
    std::fs::remove_file(paths.lock_file())?;
    std::fs::remove_dir(paths.dir())
}

/// What a daemon kept directly in the root before generations (ADR-0301).
const LEGACY_ROOT_ENTRIES: [&str; 5] = [
    crate::constants::PTY_DAEMON_DISCOVERY_FILE,
    crate::constants::PTY_DAEMON_LOG_FILE,
    crate::constants::PTY_DAEMON_SOCKET_FILE,
    "runtime",
    // Last: while it exists, a GUI can still tell that the rest is stale.
    crate::constants::PTY_DAEMON_LOCK_FILE,
];

/// Liveness is the instance lock, never a successful connect alone: the
/// discovery of a daemon that died uncleanly names an endpoint some other
/// program may since have taken.
fn probe(paths: &DaemonPaths) -> Result<Probe, String> {
    if !daemon_instance_alive(paths) {
        return Ok(Probe::Absent);
    }
    // A starting daemon holds the lock before it publishes discovery.
    let Some(discovery) = read_discovery(paths) else {
        return Ok(Probe::Unreachable);
    };
    let endpoint = DaemonEndpoint {
        endpoint: discovery.endpoint,
        token: discovery.token,
    };
    if discovery.protocol_version != PROTOCOL_VERSION {
        return Ok(Probe::Incompatible(discovery.protocol_version));
    }
    Ok(match connect_authenticated(&endpoint) {
        Ok(_) => Probe::Ready(endpoint),
        Err(_) => Probe::Unreachable,
    })
}

/// Whether some daemon process holds this directory's instance lock. Unlike
/// a connect probe this cannot be fooled by another program reusing a stale
/// endpoint, and the kernel releases the lock when a daemon dies.
fn daemon_instance_alive(paths: &DaemonPaths) -> bool {
    let Ok(lock) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock_file())
    else {
        return false;
    };
    matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

fn spawn_daemon_process(paths: &DaemonPaths) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot locate the laymux executable: {error}"))?;
    spawn_daemon(&exe, paths).map(|_| ())
}

/// Launch `exe --pty-daemon <dir>` detached from the caller and return its
/// PID. The directory travels as an argument rather than an environment
/// variable so nothing daemon-specific leaks into the caller's environment,
/// which terminals inherit.
pub fn spawn_daemon(exe: &Path, paths: &DaemonPaths) -> Result<u32, String> {
    paths
        .ensure_dir()
        .map_err(|error| format!("cannot create PTY daemon directory: {error}"))?;
    #[cfg(windows)]
    {
        // Run a private copy so the original can be replaced by an update or
        // a rebuild while the daemon lives.
        let staged = super::staging::stage(exe, paths.dir())
            .map_err(|error| format!("cannot stage the PTY daemon runtime: {error}"))?;
        windows_spawn::spawn_detached(&staged, paths.dir())
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: job-control signals aimed at the GUI's group
        // never reach the daemon. std opens descriptors close-on-exec, so the
        // daemon inherits nothing but these null stdio handles.
        let child = crate::process::headless_command(exe)
            .arg(PTY_DAEMON_CLI_FLAG)
            .arg(paths.dir())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|error| format!("failed to launch PTY daemon: {error}"))?;
        let pid = child.id();
        // Reap it if it exits while this GUI is alive (no zombie).
        thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
        Ok(pid)
    }
}

/// `std::process::Command` on Windows always passes `bInheritHandles = TRUE`,
/// which hands the daemon every inheritable handle of the GUI: console pipes,
/// and pipe ends of PTYs the GUI still owns in-process (usage probes). A
/// long-lived daemon holding those would keep them from ever reaching EOF.
/// The daemon is therefore created directly with inheritance disabled.
/// `CREATE_NO_WINDOW` keeps the `headless_command` no-console-flash rule.
#[cfg(windows)]
mod windows_spawn {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    use crate::constants::PTY_DAEMON_CLI_FLAG;

    pub(super) fn spawn_detached(exe: &Path, dir: &Path) -> Result<u32, String> {
        let detached = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        // Leave a job the GUI may run in (IDE, `cargo tauri dev`) so closing
        // that job does not take the daemon with it. A job that forbids
        // breakaway rejects the flag; the daemon then still outlives a GUI
        // crash, just not the job.
        match create(exe, dir, detached | CREATE_BREAKAWAY_FROM_JOB) {
            Err(code) if code == ERROR_ACCESS_DENIED => {
                tracing::warn!("PTY daemon job breakaway refused; launching inside the job");
                create(exe, dir, detached)
            }
            other => other,
        }
        .map_err(|code| format!("failed to launch PTY daemon (Windows error {code})"))
    }

    fn create(exe: &Path, dir: &Path, flags: u32) -> Result<u32, u32> {
        let mut command_line: Vec<u16> = quote(exe.as_os_str());
        command_line.push(u16::from(b' '));
        command_line.extend(PTY_DAEMON_CLI_FLAG.encode_utf16());
        command_line.push(u16::from(b' '));
        command_line.extend(quote(dir.as_os_str()));
        command_line.push(0);
        let application: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();

        // SAFETY: zeroed STARTUPINFOW/PROCESS_INFORMATION are valid initial
        // values; `cb` is set before use.
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: both strings are NUL-terminated and outlive the call; the
        // command line buffer is mutable as CreateProcessW requires; null
        // attributes/environment/directory select the documented defaults.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut info,
            )
        };
        if created == 0 {
            // SAFETY: reads the calling thread's last-error value.
            return Err(unsafe { GetLastError() });
        }
        // SAFETY: both handles were just returned to us and are closed once.
        unsafe {
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
        }
        Ok(info.dwProcessId)
    }

    /// Quote one argument for the MSVC command-line parser. Paths cannot
    /// contain `"`, so only backslashes before the closing quote need doubling.
    const BACKSLASH: u16 = b'\\' as u16;

    fn quote(arg: &std::ffi::OsStr) -> Vec<u16> {
        let wide: Vec<u16> = arg.encode_wide().collect();
        let trailing = wide.iter().rev().take_while(|&&c| c == BACKSLASH).count();
        let mut quoted = Vec::with_capacity(wide.len() + trailing + 2);
        quoted.push(u16::from(b'"'));
        quoted.extend_from_slice(&wide);
        quoted.extend(std::iter::repeat_n(BACKSLASH, trailing));
        quoted.push(u16::from(b'"'));
        quoted
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn quoting_keeps_spaces_and_a_trailing_backslash_inside_one_argument() {
            let quoted =
                String::from_utf16(&super::quote(r"C:\Program Files\x\".as_ref())).unwrap();
            assert_eq!(quoted, r#""C:\Program Files\x\\""#);
        }
    }
}

#[cfg(test)]
mod generation_tests {
    use super::*;
    use crate::pty_daemon::discovery::{write_discovery, Discovery};
    use std::fs::{self, File};

    /// What a running daemon holds: its directory's instance lock.
    fn hold_lock(paths: &DaemonPaths) -> File {
        fs::create_dir_all(paths.dir()).unwrap();
        let lock = File::create(paths.lock_file()).unwrap();
        lock.try_lock().unwrap();
        lock
    }

    fn generation(root: &DaemonRoot, key: &str) -> DaemonPaths {
        root.named_generation(key).unwrap()
    }

    #[test]
    fn unused_generations_and_the_old_layout_go_while_live_and_current_ones_stay() {
        let dir = tempfile::tempdir().unwrap();
        let root = DaemonRoot::in_dir(dir.path());
        let current = generation(&root, "g3-000000000001");
        let dead = generation(&root, "g3-000000000002");
        let live = generation(&root, "g2-000000000003");
        for paths in [&current, &dead, &live] {
            fs::create_dir_all(paths.dir().join("runtime")).unwrap();
            fs::write(paths.lock_file(), b"").unwrap();
        }
        let _live = hold_lock(&live);
        // The single-directory layout from before generations.
        fs::write(root.dir().join("daemon.lock"), b"").unwrap();
        fs::write(root.dir().join("daemon.json"), b"{}").unwrap();
        fs::create_dir_all(root.dir().join("runtime").join("old")).unwrap();

        // A recently touched directory may be about to start its daemon.
        collect_unused_generations(&root, "g3-000000000001", Duration::from_secs(3600));
        assert!(dead.dir().exists());

        collect_unused_generations(&root, "g3-000000000001", Duration::ZERO);
        assert!(current.dir().exists());
        assert!(live.dir().exists());
        assert!(!dead.dir().exists());
        for legacy in ["daemon.lock", "daemon.json", "runtime"] {
            assert!(!root.dir().join(legacy).exists(), "{legacy}");
        }
    }

    #[test]
    fn a_live_generation_that_cannot_be_listed_is_reported_not_hidden() {
        let dir = tempfile::tempdir().unwrap();
        let root = DaemonRoot::in_dir(dir.path());
        let other_protocol = generation(&root, "g999-000000000001");
        let starting = generation(&root, "g3-000000000002");
        let gone = generation(&root, "g3-000000000003");
        fs::create_dir_all(gone.dir()).unwrap();
        let _other = hold_lock(&other_protocol);
        write_discovery(
            &other_protocol,
            &Discovery {
                pid: 1,
                endpoint: "unused".into(),
                token: "unused".into(),
                protocol_version: 999,
            },
        )
        .unwrap();
        // Holds its lock but has not published discovery yet.
        let _starting = hold_lock(&starting);

        let live = live_generations(&root, |_| true).unwrap();
        let states: Vec<_> = live
            .iter()
            .map(|live| (live.generation.as_str(), live.state.clone()))
            .collect();
        // Newest published first; one that has not published yet is last.
        assert!(matches!(
            states.as_slice(),
            [
                ("g999-000000000001", GenerationState::Incompatible(999)),
                ("g3-000000000002", GenerationState::Unreachable),
            ]
        ));
        assert!(live_generations(&root, |key| key != "g3-000000000002")
            .unwrap()
            .iter()
            .all(|live| live.generation != "g3-000000000002"));
    }
}
