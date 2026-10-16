/// Headless process spawning utilities.
///
/// On Windows, console applications (cmd.exe, powershell.exe, netstat.exe, etc.)
/// briefly flash a console window when spawned via `std::process::Command`.
/// This module provides a helper that applies `CREATE_NO_WINDOW` automatically
/// so all call sites get consistent headless behavior. `wsl.exe` runs use
/// [`headless_wsl_command`] instead, which creates no console at all.
use std::io::Read;
use std::process::{Command, ExitStatus, Output, Stdio};
use std::time::{Duration, Instant};

/// Create a [`Command`] that will not show a console window on Windows.
///
/// On non-Windows platforms this is identical to `Command::new(program)`.
pub fn headless_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)] // mut needed on Windows for creation_flags()
    let mut cmd = Command::new(program);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000): prevents a console window from flashing
        cmd.creation_flags(0x08000000);
    }

    cmd
}

/// Create a [`Command`] for a laymux-internal `wsl.exe` run that gets **no
/// console** (ADR-0334).
///
/// [`headless_command`] only hides the window: every spawn still gets a
/// console of its own, i.e. one `conhost.exe` holding window-manager objects
/// of the user's session. WSL's service keeps each client console referenced
/// until the client's exit callback releases it, and once that cleanup stops
/// every run leaks its console host. At laymux's probe cadence that exhausts
/// the session's USER handles within hours and takes every GUI app down.
///
/// The inbox `System32\wsl.exe` is only a launcher: started without a console
/// it hands the real client a new, *visible* console and the redirected output
/// is lost. So the lifted client is started directly with `DETACHED_PROCESS`,
/// which keeps the guest I/O on the pipes and creates no console at all.
/// Without a lifted install the inbox launcher keeps [`headless_command`].
///
/// Only for runs that talk over pipes. Interactive WSL (PTY panes) needs its
/// pseudoconsole and must not use this.
pub fn headless_wsl_command() -> Command {
    #[cfg(windows)]
    if let WslLauncher::Lifted(client) =
        wsl_launcher(lifted_wsl_install_dir().as_deref(), |path| path.is_file())
    {
        return console_less_command(client);
    }
    headless_command(crate::constants::WSL_EXE)
}

/// Whether laymux-internal WSL runs fall back to the inbox launcher, which
/// still gives every run a console of its own (ADR-0334). Always false off
/// Windows. True on a Windows install without WSL too, so callers must also
/// establish that WSL is in use.
pub fn wsl_client_is_inbox() -> bool {
    #[cfg(windows)]
    {
        wsl_launcher(lifted_wsl_install_dir().as_deref(), |path| path.is_file())
            == WslLauncher::Inbox
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Which binary a laymux-internal WSL run starts.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
enum WslLauncher {
    /// The lifted client, started directly and without a console.
    Lifted(std::path::PathBuf),
    /// The inbox launcher. It needs a console of its own to hand the
    /// redirected pipes on to the real client.
    Inbox,
}

/// The lifted client inside `install_dir` when it is still there.
#[cfg(any(windows, test))]
fn wsl_launcher(
    install_dir: Option<&std::path::Path>,
    is_file: impl Fn(&std::path::Path) -> bool,
) -> WslLauncher {
    install_dir
        .map(|dir| dir.join(crate::constants::WSL_EXE))
        .filter(|client| is_file(client))
        .map_or(WslLauncher::Inbox, WslLauncher::Lifted)
}

/// A process with no console at all: `DETACHED_PROCESS` creates no console
/// host. A console-subsystem child it starts without flags of its own would
/// get a new, visible console, so this is only for programs known not to.
#[cfg(windows)]
fn console_less_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.creation_flags(windows_sys::Win32::System::Threading::DETACHED_PROCESS);
    cmd
}

/// Where the lifted WSL package is installed, read once per process. The
/// location only changes with a reinstall, and a client that disappears is
/// caught by the per-run file check in [`headless_wsl_command`].
#[cfg(windows)]
fn lifted_wsl_install_dir() -> Option<std::path::PathBuf> {
    static DIR: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(read_lifted_wsl_install_dir).clone()
}

#[cfg(windows)]
fn read_lifted_wsl_install_dir() -> Option<std::path::PathBuf> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };

    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(crate::constants::WSL_MSI_REGISTRY_KEY);
    let value = wide(crate::constants::WSL_MSI_INSTALL_LOCATION_VALUE);
    let flags = RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY;
    let read = |data: *mut u16, size: &mut u32| {
        // SAFETY: `key` and `value` are NUL-terminated and outlive the call;
        // `data` is null (size query) or points to at least `*size` bytes.
        unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                flags,
                std::ptr::null_mut(),
                data.cast(),
                size,
            )
        }
    };
    let mut size = 0u32;
    if read(std::ptr::null_mut(), &mut size) != ERROR_SUCCESS {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    if read(buffer.as_mut_ptr(), &mut size) != ERROR_SUCCESS {
        return None;
    }
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    let dir = String::from_utf16(&buffer[..len]).ok()?;
    let dir = dir.trim();
    (!dir.is_empty()).then(|| std::path::PathBuf::from(dir))
}

/// How often a timed run re-checks whether the child has exited.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long the pipes are still collected after the child is done. A pipe
/// stays open as long as *any* process holds its write end, so a grandchild
/// that outlives the child would otherwise pin this thread indefinitely — the
/// exact stall the deadline exists to prevent.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Drain one of the child's pipes on its own thread. A child that fills a pipe
/// while nobody reads it blocks forever, which would outlast the deadline this
/// helper enforces. The thread is never joined: it is handed a channel and the
/// caller stops waiting on its own schedule.
fn drain<R: Read + Send + 'static>(source: Option<R>) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut reader) = source {
            let _ = reader.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Run `command` to completion, killing it once it outlives `timeout`.
///
/// `Command::output()` waits forever. For a process that talks to the network
/// a single stall would otherwise occupy its worker for the lifetime of the
/// app, so call sites that poll on a timer use this instead. `stdin` is null,
/// which is also what keeps CLIs that would otherwise prompt non-interactive.
///
/// Only the child itself is killed. A grandchild it left behind is not
/// tracked — the guarantee here is that the *caller* is released on time, not
/// that the whole process tree is gone.
pub fn output_with_timeout(command: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout_rx = drain(child.stdout.take());
    let stderr_rx = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let exited = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(EXIT_POLL_INTERVAL),
        }
    };

    let Some(status) = exited else {
        // Nothing waits on the pipes here: the run already failed, its output
        // is not reported, and the whole point of the deadline is that this
        // returns now.
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("process timed out after {}s", timeout.as_secs()),
        ));
    };
    // A grace window, not a join: when the write ends are all closed this
    // returns at once, and when they are not the output is reported as
    // whatever arrived rather than holding the caller hostage.
    Ok(Output {
        status,
        stdout: stdout_rx.recv_timeout(DRAIN_GRACE).unwrap_or_default(),
        stderr: stderr_rx.recv_timeout(DRAIN_GRACE).unwrap_or_default(),
    })
}

/// Run a command with all stdio detached and a hard caller-side deadline.
///
/// This is the status-only counterpart to [`output_with_timeout`]. It avoids
/// pipe-drain grace entirely, which is important when the caller holds a
/// global lifecycle fence and only needs the helper's exit status.
pub fn status_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> std::io::Result<ExitStatus> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(status),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("process timed out after {}ms", timeout.as_millis()),
                ));
            }
            None => std::thread::sleep(EXIT_POLL_INTERVAL),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A child that exits immediately, and one that outlives any test deadline.
    fn quick_command() -> Command {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = headless_command("cmd");
            cmd.args(["/c", "echo hi"]);
            cmd
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = headless_command("sh");
            cmd.args(["-c", "echo hi"]);
            cmd
        }
    }

    fn slow_command() -> Command {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = headless_command("cmd");
            cmd.args(["/c", "ping -n 30 127.0.0.1 > NUL"]);
            cmd
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut cmd = headless_command("sh");
            cmd.args(["-c", "sleep 30"]);
            cmd
        }
    }

    #[test]
    fn headless_command_returns_valid_command() {
        // Should not panic and produce a usable Command
        let cmd = headless_command("echo");
        // We can't inspect creation_flags, but we can verify the command is constructible
        let output = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(output, "echo");
    }

    #[test]
    fn headless_command_accepts_args() {
        let mut cmd = headless_command("echo");
        cmd.arg("hello");
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["hello"]);
    }

    #[test]
    fn a_command_that_finishes_returns_its_output() {
        let output = output_with_timeout(&mut quick_command(), Duration::from_secs(30))
            .expect("quick command runs");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hi"));
    }

    #[test]
    fn a_stalled_command_is_killed_at_the_deadline() {
        let started = Instant::now();
        let error = output_with_timeout(&mut slow_command(), Duration::from_millis(300))
            .expect_err("slow command must not be waited on forever");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        // The point of the helper: the caller is released at the deadline even
        // though `cmd.exe`'s own child keeps the pipes open long past it.
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_stalled_status_only_command_is_killed_at_the_deadline() {
        let started = Instant::now();
        let error = status_with_timeout(&mut slow_command(), Duration::from_millis(300))
            .expect_err("slow status-only command must not be waited on forever");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_lifted_wsl_install_is_started_directly() {
        let dir = std::path::Path::new("wsl-install");
        let client = dir.join(crate::constants::WSL_EXE);
        assert_eq!(
            wsl_launcher(Some(dir), |path| path == client),
            WslLauncher::Lifted(client.clone())
        );
    }

    #[test]
    fn without_a_lifted_wsl_client_the_inbox_launcher_is_kept() {
        assert_eq!(wsl_launcher(None, |_| true), WslLauncher::Inbox);
        // A recorded location whose client is gone (WSL uninstalled) is not started.
        assert_eq!(
            wsl_launcher(Some(std::path::Path::new("wsl-install")), |_| false),
            WslLauncher::Inbox
        );
    }

    /// Every laymux-internal `wsl.exe` run must go through
    /// [`headless_wsl_command`]: with a console of its own, each run is one
    /// `conhost.exe` that WSL can leak (ADR-0334).
    #[test]
    fn wsl_runs_never_get_a_console_of_their_own() {
        let needle = format!("headless_command({:?})", crate::constants::WSL_EXE);
        let mut pending = vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
        let mut offenders = Vec::new();
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).expect("source directory is readable") {
                let path = entry.expect("source entry is readable").path();
                if path.is_dir() {
                    pending.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && std::fs::read_to_string(&path)
                        .expect("source file is readable")
                        .contains(&needle)
                {
                    offenders.push(path.display().to_string());
                }
            }
        }
        offenders.sort();
        assert!(
            offenders.is_empty(),
            "spawn wsl.exe with crate::process::headless_wsl_command(): {offenders:#?}"
        );
    }

    /// The most `conhost.exe` children `pid` was seen with during `window`.
    /// Returns as soon as one appears: a console host is created with the
    /// process, so absence is only meaningful across the whole window.
    #[cfg(windows)]
    fn console_hosts_of(pid: u32, window: Duration) -> usize {
        let deadline = Instant::now() + window;
        loop {
            let hosts = crate::process_tree::try_snapshot_processes()
                .expect("process snapshot")
                .iter()
                .filter(|entry| entry.ppid == pid && entry.name.eq_ignore_ascii_case("conhost.exe"))
                .count();
            if hosts > 0 || Instant::now() >= deadline {
                return hosts;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_console_less_command_gets_no_console_host() {
        // `cmd.exe` parked on an open stdin pipe stays alive without starting
        // a child, so only its own console host can show up.
        let hosts = |mut command: Command| {
            let mut child = command
                .args(["/d", "/q"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("cmd.exe spawns");
            let hosts = console_hosts_of(child.id(), Duration::from_millis(500));
            drop(child.stdin.take());
            let _ = child.wait();
            hosts
        };
        // Control: a hidden window still means a console host of its own,
        // which is what proves the probe can see one.
        assert_eq!(hosts(headless_command("cmd.exe")), 1);
        assert_eq!(hosts(console_less_command("cmd.exe")), 0);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires WSL; set LAYMUX_TEST_WSL_DISTRO and run with --ignored"]
    fn a_wsl_run_keeps_its_pipes_and_owns_no_console_host_when_lifted() {
        let distro = std::env::var("LAYMUX_TEST_WSL_DISTRO").unwrap();
        // Without a lifted install the inbox launcher is the documented
        // fallback, and it owns a console host by design (ADR-0334).
        let expected_hosts =
            match wsl_launcher(lifted_wsl_install_dir().as_deref(), |path| path.is_file()) {
                WslLauncher::Lifted(_) => 0,
                WslLauncher::Inbox => 1,
            };
        let child = headless_wsl_command()
            .args(["-d", &distro, "--exec", "sh", "-c"])
            .arg("sleep 1; echo probe-out; echo probe-err >&2; exit 7")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("wsl.exe spawns");
        let hosts = console_hosts_of(child.id(), Duration::from_millis(700));
        let output = child.wait_with_output().expect("wsl.exe finishes");
        assert_eq!(
            hosts, expected_hosts,
            "a lifted WSL run must not own a console host"
        );
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "probe-out");
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "probe-err");
    }
}
