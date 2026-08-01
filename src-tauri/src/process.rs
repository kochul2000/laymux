/// Headless process spawning utilities.
///
/// On Windows, console applications (cmd.exe, powershell.exe, netstat.exe, etc.)
/// briefly flash a console window when spawned via `std::process::Command`.
/// This module provides a helper that applies `CREATE_NO_WINDOW` automatically
/// so all call sites get consistent headless behavior.
use std::io::Read;
use std::process::{Command, Output, Stdio};
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
}
