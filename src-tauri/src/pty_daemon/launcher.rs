//! GUI side: find the current daemon instance, starting one if needed.

use std::path::Path;
#[cfg(unix)]
use std::process::Stdio;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use super::client::connect_authenticated;
use super::discovery::{read_discovery, DaemonPaths};
use super::wire::PROTOCOL_VERSION;
use super::DaemonEndpoint;
#[cfg(unix)]
use crate::constants::PTY_DAEMON_CLI_FLAG;
use crate::constants::{PTY_DAEMON_LAUNCH_POLL_MS, PTY_DAEMON_LAUNCH_TIMEOUT_MS};
use crate::lock_ext::MutexExt;

/// Serializes launches inside one GUI so parallel terminal creation starts at
/// most one daemon. Across processes the daemon's own instance lock decides.
static LAUNCH: Mutex<()> = Mutex::new(());

pub fn ensure_running(paths: &DaemonPaths) -> Result<DaemonEndpoint, String> {
    if let Some(endpoint) = probe(paths)? {
        return Ok(endpoint);
    }
    let _launch = LAUNCH.lock_or_err()?;
    if let Some(endpoint) = probe(paths)? {
        return Ok(endpoint);
    }
    spawn_daemon_process(paths)?;
    let deadline = Instant::now() + Duration::from_millis(PTY_DAEMON_LAUNCH_TIMEOUT_MS);
    loop {
        if let Some(endpoint) = probe(paths)? {
            return Ok(endpoint);
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

/// Find a live, authenticated daemon without starting one.
pub fn find_running(paths: &DaemonPaths) -> Result<Option<DaemonEndpoint>, String> {
    probe(paths)
}

/// `Ok(None)` means no live daemon answered. A live daemon that speaks
/// another protocol is an error: it may own running work, so it is neither
/// replaced nor killed here.
///
/// Liveness is the instance lock, never a successful connect alone: the
/// discovery of a daemon that died uncleanly names an endpoint some other
/// program may since have taken.
fn probe(paths: &DaemonPaths) -> Result<Option<DaemonEndpoint>, String> {
    let Some(discovery) = read_discovery(paths) else {
        return Ok(None);
    };
    if !daemon_instance_alive(paths) {
        return Ok(None);
    }
    let endpoint = DaemonEndpoint {
        endpoint: discovery.endpoint,
        token: discovery.token,
    };
    if discovery.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "an incompatible PTY daemon (protocol {}, expected {PROTOCOL_VERSION}) is running",
            discovery.protocol_version
        ));
    }
    Ok(connect_authenticated(&endpoint).ok().map(|_| endpoint))
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
        windows_spawn::spawn_detached(exe, paths.dir())
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
