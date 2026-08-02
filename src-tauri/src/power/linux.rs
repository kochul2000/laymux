use std::io::Read;
use std::process::{Child, ChildStderr, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::InhibitBackend;
use crate::error::AppError;
use crate::process::headless_command;

/// How long a freshly spawned `systemd-inhibit` is watched before its lock
/// is believed.
///
/// `systemd-inhibit` execs fine and *then* exits non-zero when the inhibit
/// call itself fails — no D-Bus session, no seat, a container, a polkit
/// denial. Without this window that failure is indistinguishable from
/// success, and the UI would claim the machine is being kept awake while it
/// sleeps through the user's build.
const SPAWN_GRACE: Duration = Duration::from_millis(300);
const SPAWN_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// How long the child is given to notice EOF on its stdin before it is killed.
const RELEASE_GRACE: Duration = Duration::from_millis(300);
/// Cap on captured stderr. Enough for a diagnostic, bounded so a chatty
/// child cannot grow this without limit.
const STDERR_CAPTURE_LIMIT: usize = 4096;

struct Inhibitor {
    child: Child,
    /// Filled by a reader thread. The pipe is drained continuously: leaving
    /// it unread would let a long-lived child block on a full pipe, and
    /// reading it only on failure would block this thread — inside the
    /// inhibitor mutex — until the writer closed it.
    stderr: Arc<Mutex<String>>,
}

impl Inhibitor {
    fn stderr_text(&self) -> String {
        self.stderr
            .lock()
            .map(|captured| captured.trim().to_string())
            .unwrap_or_default()
    }
}

/// Consume the child's stderr on its own thread, keeping the first
/// [`STDERR_CAPTURE_LIMIT`] bytes and discarding the rest.
fn drain_stderr(mut pipe: ChildStderr) -> Arc<Mutex<String>> {
    let captured = Arc::new(Mutex::new(String::new()));
    let sink = captured.clone();
    let spawned = std::thread::Builder::new()
        .name("systemd-inhibit-stderr".into())
        .spawn(move || {
            let mut chunk = [0u8; 512];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(read) => {
                        if let Ok(mut sink) = sink.lock() {
                            let room = STDERR_CAPTURE_LIMIT.saturating_sub(sink.len());
                            if room > 0 {
                                let text = String::from_utf8_lossy(&chunk[..read.min(room)]);
                                sink.push_str(&text);
                            }
                        }
                    }
                }
            }
        });
    if let Err(error) = spawned {
        // Without a reader the pipe could fill; the diagnostic is worth
        // less than the child staying unblocked.
        tracing::warn!(%error, "failed to capture systemd-inhibit stderr");
    }
    captured
}

pub struct PlatformBackend {
    inhibitor: Option<Inhibitor>,
}

impl PlatformBackend {
    pub fn new() -> Self {
        Self { inhibitor: None }
    }
}

impl InhibitBackend for PlatformBackend {
    fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
        if enabled {
            if self.inhibitor.is_some() {
                return Ok(());
            }
            // `cat` blocks on a pipe laymux holds the write end of, so the
            // lock outlives nothing: if this process dies for any reason,
            // the kernel closes the pipe, `cat` sees EOF, and systemd-inhibit
            // releases the lock. A detached `sleep infinity` would survive a
            // SIGKILL and keep the machine awake forever.
            //
            // stderr stays piped rather than nulled so a failure can be
            // reported verbatim; a reader thread keeps it drained.
            let mut child = headless_command("systemd-inhibit")
                .arg("--what=idle:sleep")
                .arg("--who=Laymux")
                .arg("--why=Terminal work in progress")
                .arg("--mode=block")
                .arg("cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| AppError::Other(format!("failed to start systemd-inhibit: {e}")))?;

            let stderr = match child.stderr.take() {
                Some(pipe) => drain_stderr(pipe),
                None => Arc::new(Mutex::new(String::new())),
            };
            let mut inhibitor = Inhibitor { child, stderr };

            let deadline = Instant::now() + SPAWN_GRACE;
            loop {
                match inhibitor.child.try_wait() {
                    Ok(Some(status)) => {
                        let detail = inhibitor.stderr_text();
                        return Err(AppError::Other(if detail.is_empty() {
                            format!("systemd-inhibit exited immediately ({status})")
                        } else {
                            format!("systemd-inhibit failed ({status}): {detail}")
                        }));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let _ = inhibitor.child.kill();
                        let _ = inhibitor.child.wait();
                        return Err(AppError::Other(format!(
                            "failed to check systemd-inhibit: {error}"
                        )));
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(SPAWN_POLL_INTERVAL);
            }

            self.inhibitor = Some(inhibitor);
            return Ok(());
        }

        let Some(mut inhibitor) = self.inhibitor.take() else {
            return Ok(());
        };
        // Closing the pipe is what releases the lock: `cat` sees EOF and
        // both processes exit.
        drop(inhibitor.child.stdin.take());

        let deadline = Instant::now() + RELEASE_GRACE;
        let exited = loop {
            match inhibitor.child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) => {}
                Err(error) => {
                    // Whether the lock is gone is unknown; keep the handle so
                    // a later attempt can try again rather than leaking it.
                    self.inhibitor = Some(inhibitor);
                    return Err(AppError::Other(format!(
                        "failed to check systemd-inhibit during release: {error}"
                    )));
                }
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(SPAWN_POLL_INTERVAL);
        };

        if !exited {
            // It ignored EOF. Killing it drops the lock just as well, but a
            // failure here means the lock may still be held — say so.
            if let Err(error) = inhibitor.child.kill() {
                self.inhibitor = Some(inhibitor);
                return Err(AppError::Other(format!(
                    "failed to kill systemd-inhibit: {error}"
                )));
            }
        }
        inhibitor
            .child
            .wait()
            .map_err(|error| AppError::Other(format!("failed to reap systemd-inhibit: {error}")))?;
        Ok(())
    }

    fn needs_reapply(&mut self) -> bool {
        let Some(inhibitor) = self.inhibitor.as_mut() else {
            return true;
        };
        match inhibitor.child.try_wait() {
            Ok(Some(status)) => {
                let detail = inhibitor.stderr_text();
                tracing::warn!(
                    %status,
                    detail = %detail,
                    "systemd-inhibit exited while the lock was held"
                );
                self.inhibitor = None;
                true
            }
            // Still running, or the check itself failed — in the latter case
            // respawning would leak the child we already have.
            _ => false,
        }
    }
}
