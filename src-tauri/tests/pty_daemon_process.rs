//! The PTY daemon as a real, separate `laymux --pty-daemon` process
//! (ADR-0300): single instance per directory, and terminal work that outlives
//! a client process which dies without terminating it.

use std::path::Path;
use std::time::{Duration, Instant};

use laymux_lib::constants::ENV_LAYMUX_PTY_DAEMON_DIR;
use laymux_lib::process::headless_command;
use laymux_lib::pty_daemon::{
    find_running, list_sessions, spawn_daemon, terminate_session, DaemonPaths, DaemonPtySystem,
};
use portable_pty::{CommandBuilder, PtySize, PtySystem};
use sysinfo::{Pid, ProcessesToUpdate, System};

const ROLE_ENV: &str = "LAYMUX_PTY_DAEMON_TEST_ROLE";
const CRASH_CLIENT_ROLE: &str = "crash-client";
const SESSION_ID: &str = "crashed-pane#1";
const TIMEOUT: Duration = Duration::from_secs(20);

/// Kills a process this test started, even when an assertion fails. Only a
/// process that is still alive is killed, so an exited PID that the OS may
/// already have reused is never targeted.
struct KillOnDrop(u32);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if !is_alive(self.0) {
            return;
        }
        let pid = self.0.to_string();
        #[cfg(windows)]
        let _ = headless_command("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .output();
        #[cfg(unix)]
        let _ = headless_command("kill").args(["-9", &pid]).output();
    }
}

fn launch(paths: &DaemonPaths) -> u32 {
    spawn_daemon(Path::new(env!("CARGO_BIN_EXE_laymux")), paths).expect("launch PTY daemon")
}

fn is_alive(pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

fn wait_until<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn sleeper() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "ping -n 120 127.0.0.1 >nul"]);
        command
    }
    #[cfg(unix)]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 120"]);
        command
    }
}

/// Child-process role: start a terminal in the daemon, then die abruptly
/// like a crashed GUI — no terminate, no destructors.
#[test]
fn crash_client_role() {
    if std::env::var(ROLE_ENV).as_deref() != Ok(CRASH_CLIENT_ROLE) {
        return;
    }
    let paths = DaemonPaths::for_current_build().unwrap();
    let endpoint = find_running(&paths).unwrap().expect("daemon is running");
    let pair = DaemonPtySystem::new(endpoint, SESSION_ID.into())
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let child = pair.slave.spawn_command(sleeper()).unwrap();
    println!("CHILD_PID={}", child.process_id().unwrap());
    std::process::abort();
}

#[test]
fn terminal_work_outlives_a_crashed_client_in_a_single_daemon_instance() {
    if std::env::var(ROLE_ENV).is_ok() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::in_dir(dir.path().join("pty-daemon"));
    let daemon = KillOnDrop(launch(&paths));
    let endpoint = wait_until("daemon discovery", || find_running(&paths).unwrap());

    // A second instance for the same directory yields to the live one.
    let second = KillOnDrop(launch(&paths));
    wait_until("second instance exit", || {
        (!is_alive(second.0)).then_some(())
    });
    assert!(is_alive(daemon.0));
    assert!(list_sessions(&endpoint).unwrap().is_empty());

    let output = headless_command(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "crash_client_role",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, CRASH_CLIENT_ROLE)
        .env(ENV_LAYMUX_PTY_DAEMON_DIR, paths.dir())
        .output()
        .unwrap();
    assert!(!output.status.success(), "the client role must abort");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let child_pid: u32 = stdout
        .split("CHILD_PID=")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("client printed no child PID: {stdout}"))
        .parse()
        .unwrap();

    // The client process is gone; its terminal is still running, detached.
    let session = wait_until("detached session", || {
        list_sessions(&endpoint)
            .unwrap()
            .into_iter()
            .find(|session| session.session_id == SESSION_ID && !session.attached)
    });
    let _child = KillOnDrop(child_pid);
    assert_eq!(session.child_pid, Some(child_pid));
    assert!(!session.exited);
    assert!(
        is_alive(child_pid),
        "the terminal child must survive the client"
    );

    // Only an explicit terminate ends it.
    terminate_session(&endpoint, SESSION_ID).unwrap();
    wait_until("session reaped", || {
        list_sessions(&endpoint).unwrap().is_empty().then_some(())
    });
    wait_until("terminal child exit", || {
        (!is_alive(child_pid)).then_some(())
    });
}
