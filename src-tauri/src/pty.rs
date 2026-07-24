use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::process::headless_command;
use crate::pty_control::{PendingControlJob, PtyControlCompletion, PtyControlWorker};
use crate::terminal::TerminalSession;
use crate::terminal_env::TerminalEnvPlan;

/// Expand Windows-style environment variable references (e.g. `%USERPROFILE%`)
/// in a path string. Also expands `~` as a shorthand for the user's home directory.
fn expand_env_in_path(path: &str) -> String {
    let mut result = path.to_string();

    // Expand ~ to home directory
    if result == "~" || result.starts_with("~/") || result.starts_with("~\\") {
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            result = format!("{}{}", home, &result[1..]);
        }
    }

    // Expand %VAR% style environment variables
    let mut search_from = 0;
    while let Some(rel_start) = result[search_from..].find('%') {
        let start = search_from + rel_start;
        if let Some(end) = result[start + 1..].find('%') {
            let var_name = &result[start + 1..start + 1 + end];
            if let Ok(val) = std::env::var(var_name) {
                result = format!("{}{}{}", &result[..start], val, &result[start + 2 + end..]);
                search_from = start + val.len();
            } else {
                // Variable not found — skip past it to avoid infinite loop
                break;
            }
        } else {
            break;
        }
    }

    result
}

/// Check if a path is a Unix-style path (starts with `/`).
fn is_unix_path(path: &str) -> bool {
    path.starts_with('/')
}

/// Check if the command executable is `wsl` or `wsl.exe`.
fn is_wsl_command(cmd_path: &str) -> bool {
    let lower = cmd_path.to_lowercase();
    let stem = std::path::Path::new(&lower)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    stem == "wsl"
}

/// Write `data` in [`PTY_WRITE_CHUNK_SIZE`]-byte chunks, flushing after each.
///
/// ConPTY on Windows can silently truncate a single oversized `write_all()`
/// call, so chunking prevents paste data loss. This is a free function so that
/// both [`PtyHandle::write`] and unit tests exercise the same code path.
#[cfg(test)]
fn chunked_write_to(writer: &mut dyn Write, data: &[u8]) -> Result<(), String> {
    chunked_write_to_guarded(writer, data, || true)
}

pub(crate) fn chunked_write_to_guarded(
    writer: &mut dyn Write,
    data: &[u8],
    mut is_current_owner: impl FnMut() -> bool,
) -> Result<(), String> {
    for chunk in data.chunks(PTY_WRITE_CHUNK_SIZE) {
        if !is_current_owner() {
            return Err("terminal controller ownership changed during input".into());
        }
        writer
            .write_all(chunk)
            .map_err(|e| format!("Write error: {e}"))?;
        writer.flush().map_err(|e| format!("Flush error: {e}"))?;
        // A synchronous OS write cannot recall an already accepted prefix.
        // Revalidate afterwards so the control worker reports that ambiguity
        // and never starts a later chunk for the obsolete owner.
        if !is_current_owner() {
            return Err("terminal controller ownership changed during input".into());
        }
    }
    Ok(())
}

/// Handle to a running PTY process, providing write and resize capabilities.
#[derive(Clone)]
pub struct PtyHandle {
    /// Owns the writer on one terminal-specific FIFO thread.
    control: Arc<PtyControlWorker>,
    /// Independent lifecycle handle: it is never protected by the writer
    /// worker, so cancellation can close the PTY even when stdin is blocked.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    child_killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    /// PID of the direct child process spawned by the PTY (`None` if the
    /// platform does not expose process IDs, e.g. serial connections).
    /// Used for Claude Code session matching via process tree traversal.
    /// Type matches `portable_pty::Child::process_id() -> Option<u32>`.
    child_pid: Option<u32>,
    /// Flipped to `true` by the wait thread *while it still holds the `Child`
    /// handle*, so any observer that sees `true` knows the OS has not yet
    /// recycled the PID (Windows keeps the PID reserved until the process
    /// handle is closed). Lets `terminate()` safely skip taskkill when the
    /// child has already exited on its own.
    child_exited: Arc<AtomicBool>,
    input_faulted: Arc<AtomicBool>,
}

impl PtyHandle {
    /// Time budget `terminate()` gives the shell to exit on its own after the
    /// PTY is closed before falling back to a forced kill. Polled in small
    /// steps so well-behaved shells return almost immediately.
    const GRACEFUL_SHUTDOWN_TOTAL: Duration = Duration::from_millis(150);
    const GRACEFUL_SHUTDOWN_STEP: Duration = Duration::from_millis(10);

    #[cfg(test)]
    pub(crate) fn from_test_writer(writer: Box<dyn Write + Send>) -> Self {
        let master = Arc::new(Mutex::new(None));
        Self {
            control: PtyControlWorker::spawn(writer, Arc::clone(&master))
                .expect("test PTY control worker"),
            master,
            child_killer: Arc::new(Mutex::new(None)),
            child_pid: None,
            child_exited: Arc::new(AtomicBool::new(true)),
            input_faulted: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Close the PTY master and terminate the direct child process tree if
    /// possible. Order of operations:
    ///
    /// 1. Close/cancel the input worker, then drop the independent master so
    ///    ConPTY/HUP shutdown does not need the writer mutex.
    /// 2. Poll `child_exited` briefly so a graceful exit short-circuits the
    ///    taskkill path entirely.
    /// 3. If the child is still alive, `taskkill /T /F` the whole tree. Safe
    ///    from PID recycling because the wait thread still holds the `Child`
    ///    handle (keeping the PID reserved) until `child_exited` flips, and
    ///    we re-check that flag immediately before killing.
    pub fn terminate(&self) -> Result<(), String> {
        self.control.close();
        self.wait_for_child(Self::GRACEFUL_SHUTDOWN_TOTAL);
        if self.child_exited.load(Ordering::Acquire) {
            return Ok(());
        }
        self.kill_child_tree()?;
        self.wait_for_child(Duration::from_millis(PTY_CONTROL_TERMINATE_GRACE_MS));
        Ok(())
    }

    /// Write data (user input) to the PTY.
    ///
    /// Large payloads are split into [`PTY_WRITE_CHUNK_SIZE`]-byte chunks and
    /// flushed individually — see [`chunked_write_to`] for details.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.write_guarded(data, || true)
    }

    /// Human-controller write with owner revalidation before and after every
    /// physical chunk. The caller must register an owner permit first.
    pub fn write_guarded(
        &self,
        data: &[u8],
        is_current_owner: impl FnMut() -> bool,
    ) -> Result<(), String> {
        self.write_guarded_until(
            data,
            Instant::now() + Duration::from_millis(PTY_CONTROL_JOB_TIMEOUT_MS),
            is_current_owner,
        )
    }

    pub fn write_guarded_until(
        &self,
        data: &[u8],
        deadline: Instant,
        is_current_owner: impl FnMut() -> bool,
    ) -> Result<(), String> {
        let pending = self.enqueue_write(data, false, deadline)?;
        self.await_enqueued_control_job(pending, deadline, is_current_owner)
    }

    /// Place a write on this terminal's FIFO without waiting for it. Human
    /// controller callers use this narrow operation while holding their owner
    /// gate, making FIFO submission atomic with an ownership transition.
    ///
    /// When `submit` is set, the worker appends a submit CR after the body,
    /// gapped so a TUI/shell registers a distinct Enter, all inside this one
    /// FIFO job so the body and CR stay atomic against other writes (#490).
    pub(crate) fn enqueue_write(
        &self,
        data: &[u8],
        submit: bool,
        deadline: Instant,
    ) -> Result<PendingControlJob, String> {
        self.ensure_input_healthy()?;
        self.control.submit_write(data, submit, deadline)
    }

    /// Get the child process ID.
    pub fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.resize_guarded(cols, rows, || true)
    }

    pub fn resize_guarded(
        &self,
        cols: u16,
        rows: u16,
        is_current_owner: impl FnMut() -> bool,
    ) -> Result<(), String> {
        self.resize_guarded_until(
            cols,
            rows,
            Instant::now() + Duration::from_millis(PTY_CONTROL_JOB_TIMEOUT_MS),
            is_current_owner,
        )
    }

    pub fn resize_guarded_until(
        &self,
        cols: u16,
        rows: u16,
        deadline: Instant,
        is_current_owner: impl FnMut() -> bool,
    ) -> Result<(), String> {
        let pending = self.enqueue_resize(cols, rows, deadline)?;
        self.await_enqueued_control_job(pending, deadline, is_current_owner)
    }

    /// Place a resize on this terminal's FIFO without waiting for it. See
    /// [`Self::enqueue_write`] for the owner-transition synchronization rule.
    pub(crate) fn enqueue_resize(
        &self,
        cols: u16,
        rows: u16,
        deadline: Instant,
    ) -> Result<PendingControlJob, String> {
        self.ensure_input_healthy()?;
        self.control.submit_resize(cols, rows, deadline)
    }

    pub(crate) fn await_enqueued_control_job(
        &self,
        pending: PendingControlJob,
        deadline: Instant,
        mut is_current_owner: impl FnMut() -> bool,
    ) -> Result<(), String> {
        let poll = Duration::from_millis(PTY_CONTROL_WAIT_POLL_MS);
        let cancel_grace = Duration::from_millis(PTY_CONTROL_CANCEL_GRACE_MS);
        let mut cancelled_at: Option<Instant> = None;
        let mut cancel_reason = "terminal control operation cancelled";

        loop {
            let now = Instant::now();
            if cancelled_at.is_none() {
                if !is_current_owner() {
                    cancel_reason = "terminal controller ownership changed during operation";
                    cancelled_at = Some(now);
                } else if now >= deadline {
                    cancel_reason = "terminal control operation deadline exceeded";
                    cancelled_at = Some(now);
                }
                if cancelled_at.is_some() {
                    pending.cancelled.store(true, Ordering::Release);
                    self.control.cancel_job(pending.id);
                }
            }

            match pending.result.recv_timeout(poll) {
                Ok(result) => {
                    if cancelled_at.is_some() {
                        return Err(cancel_reason.into());
                    }
                    return result;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("PTY control worker stopped unexpectedly".into());
                }
                Err(RecvTimeoutError::Timeout) => {}
            }

            if cancelled_at.is_some_and(|started| started.elapsed() >= cancel_grace) {
                self.force_input_fault()?;
                return Err(format!(
                    "{cancel_reason}; terminal input was faulted and terminated"
                ));
            }
        }
    }

    fn ensure_input_healthy(&self) -> Result<(), String> {
        if self.input_faulted.load(Ordering::Acquire) {
            Err("terminal input is faulted".into())
        } else {
            Ok(())
        }
    }

    /// Return a lifecycle acknowledgement when bounded cancellation had to
    /// fault this terminal but the platform worker has not exited yet.
    pub(crate) fn pending_control_completion(&self) -> Option<PtyControlCompletion> {
        (self.input_faulted.load(Ordering::Acquire) && !self.control.exited())
            .then(|| self.control.completion())
    }

    fn force_input_fault(&self) -> Result<(), String> {
        if self.input_faulted.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.control.close();
        self.close_master();
        let kill_result = self.kill_child_tree();
        let deadline = Instant::now() + Duration::from_millis(PTY_CONTROL_TERMINATE_GRACE_MS);
        while Instant::now() < deadline && !self.control.exited() {
            // Resize owns the master only for its platform call. If killing
            // the child released that call, retry the independent lifecycle
            // close instead of relying on the first best-effort try_lock.
            self.close_master();
            thread::sleep(Self::GRACEFUL_SHUTDOWN_STEP);
        }
        kill_result
    }

    fn close_master(&self) -> bool {
        match self.master.try_lock() {
            Ok(mut master) => {
                master.take();
                true
            }
            Err(_) => false,
        }
    }

    fn wait_for_child(&self, total: Duration) {
        wait_for_child_with_master_close_retry(
            total,
            Self::GRACEFUL_SHUTDOWN_STEP,
            || self.child_exited.load(Ordering::Acquire),
            || self.close_master(),
        );
    }

    fn kill_child_tree(&self) -> Result<(), String> {
        if self.child_exited.load(Ordering::Acquire) {
            return Ok(());
        }

        #[allow(unused_mut)]
        let mut platform_error: Option<String> = None;
        #[cfg(target_os = "windows")]
        if let Some(pid) = self.child_pid {
            match headless_command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
            {
                Ok(status) if status.success() => return Ok(()),
                Ok(status) => {
                    tracing::debug!(pid, status = ?status.code(), "taskkill returned non-zero during PTY cleanup");
                    platform_error = Some(format!(
                        "taskkill returned {:?} for PTY child {pid}",
                        status.code()
                    ));
                }
                Err(error) => {
                    platform_error = Some(format!(
                        "Failed to run taskkill for PTY child {pid}: {error}"
                    ));
                }
            }
        }

        let mut killer = self.child_killer.lock_or_err()?;
        let Some(killer) = killer.as_mut() else {
            return Err(
                platform_error.unwrap_or_else(|| "PTY child killer is unavailable".to_string())
            );
        };
        if let Err(error) = killer.kill() {
            let fallback_error = format!("Failed to terminate PTY child: {error}");
            return Err(match platform_error {
                Some(platform_error) => format!("{platform_error}; {fallback_error}"),
                None => fallback_error,
            });
        }
        Ok(())
    }
}

fn wait_for_child_with_master_close_retry(
    total: Duration,
    step: Duration,
    mut child_exited: impl FnMut() -> bool,
    mut close_master: impl FnMut() -> bool,
) {
    let deadline = Instant::now() + total;
    let mut master_close_observed = close_master();
    loop {
        if child_exited() || Instant::now() >= deadline {
            return;
        }
        thread::sleep(step.min(deadline.saturating_duration_since(Instant::now())));
        if !master_close_observed {
            master_close_observed = close_master();
        }
    }
}

/// Spawn a PTY process for the given terminal session.
/// Returns a PtyHandle and starts a reader thread that calls `on_output` with data chunks.
pub fn spawn_pty<F>(session: &TerminalSession, on_output: F) -> Result<PtyHandle, String>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    let pty_system = native_pty_system();

    let size = PtySize {
        rows: session.config.rows,
        cols: session.config.cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let (command_line, startup_command) = if session.config.command_line.is_empty() {
        // Fallback: legacy profile name-based resolution. Historically this
        // path did not consume startup_command, so preserve that behavior.
        (
            TerminalSession::profile_command_line(&session.config.profile),
            "",
        )
    } else {
        (
            session.config.command_line.as_str(),
            session.config.startup_command.as_str(),
        )
    };
    let executable = command_line
        .split_whitespace()
        .next()
        .unwrap_or("powershell.exe");
    let is_wsl = is_wsl_command(executable);
    let inherited_wslenv = is_wsl.then(|| std::env::var(ENV_WSLENV).ok()).flatten();
    let env_plan = TerminalEnvPlan::for_session(
        &session.config.env,
        &session.id,
        &session.config.sync_group,
        session.config.advertise_true_color,
        is_wsl,
        inherited_wslenv.as_deref(),
    );

    let (cmd_path, args) = TerminalSession::command_line_to_command_with_env_plan(
        command_line,
        &env_plan,
        startup_command,
    );
    let mut cmd = CommandBuilder::new(&cmd_path);
    for arg in &args {
        cmd.arg(arg);
    }
    env_plan.apply_to_command(&mut cmd);

    // Set starting directory if configured
    if !session.config.starting_directory.is_empty() {
        let dir = expand_env_in_path(&session.config.starting_directory);
        if is_unix_path(&dir) && is_wsl_command(&cmd_path) {
            // WSL terminal with Unix path: inject --cd flag before existing args
            cmd = CommandBuilder::new(&cmd_path);
            cmd.arg("--cd");
            cmd.arg(&dir);
            for arg in &args {
                cmd.arg(arg);
            }
            env_plan.apply_to_command(&mut cmd);
        } else {
            // For non-WSL commands, convert /mnt/X/... back to Windows path
            let effective_dir = if is_unix_path(&dir) {
                crate::path_utils::mnt_path_to_windows(&dir).unwrap_or(dir)
            } else {
                dir
            };
            let path = std::path::Path::new(&effective_dir);
            if path.is_dir() {
                cmd.cwd(path);
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    let child_pid = child.process_id();
    let child_killer = child.clone_killer();
    let child_exited = Arc::new(AtomicBool::new(false));
    let exited_signal = Arc::clone(&child_exited);

    // Spawn a background thread to wait for the child process.
    // This prevents zombie processes on Unix (where unwait-ed children
    // linger in the process table). On Windows, this closes the process
    // handle cleanly after exit. The thread exits naturally when the
    // shell terminates (e.g., via PTY master close → SIGHUP).
    //
    // The `child_exited` flip MUST happen before `child` drops: while the
    // `Box<dyn Child>` is alive the OS keeps the PID reserved to this
    // process (Windows won't recycle it), so any observer that sees
    // `child_exited == true` can safely conclude the PID belongs to the
    // now-dead shell and not an unrelated process.
    thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        exited_signal.store(true, Ordering::Release);
        // `child` drops here; Windows may recycle the PID after this point.
    });
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {e}"))?;

    let master = Arc::new(Mutex::new(Some(pair.master)));
    let control = PtyControlWorker::spawn(writer, Arc::clone(&master))?;
    let handle = PtyHandle {
        control,
        master,
        child_killer: Arc::new(Mutex::new(Some(child_killer))),
        child_pid,
        child_exited,
        input_faulted: Arc::new(AtomicBool::new(false)),
    };

    // Spawn reader thread
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    on_output(buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::TerminalConfig;
    use std::cell::Cell;
    use std::sync::{mpsc, Condvar};
    use std::time::Duration;

    fn make_test_session(profile: &str) -> TerminalSession {
        TerminalSession::new(
            "test-pty".into(),
            TerminalConfig {
                profile: profile.into(),
                command_line: String::new(),
                startup_command: String::new(),
                starting_directory: String::new(),
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![("TEST_VAR".into(), "hello".into())],
                advertise_true_color: true,
            },
        )
    }

    fn make_test_session_with_cwd(profile: &str, cwd: &str) -> TerminalSession {
        TerminalSession::new(
            "test-pty-cwd".into(),
            TerminalConfig {
                profile: profile.into(),
                command_line: String::new(),
                startup_command: String::new(),
                starting_directory: cwd.into(),
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![],
                advertise_true_color: true,
            },
        )
    }

    #[test]
    fn pty_handle_write_and_resize_types_exist() {
        // Verify PtyHandle has the expected interface
        fn _assert_write(handle: &PtyHandle) -> Result<(), String> {
            handle.write(b"echo hello\n")
        }
        fn _assert_resize(handle: &PtyHandle) -> Result<(), String> {
            handle.resize(120, 40)
        }
    }

    #[test]
    fn graceful_wait_retries_master_close_after_a_busy_lock() {
        let close_attempts = Cell::new(0usize);
        let master_closed = Cell::new(false);

        wait_for_child_with_master_close_retry(
            Duration::from_millis(100),
            Duration::from_millis(1),
            || master_closed.get(),
            || {
                let next = close_attempts.get() + 1;
                close_attempts.set(next);
                if next >= 3 {
                    master_closed.set(true);
                    true
                } else {
                    false
                }
            },
        );

        assert_eq!(close_attempts.get(), 3);
        assert!(master_closed.get());
    }

    #[test]
    #[cfg(windows)]
    fn terminate_drops_writer_and_master_handles() {
        // After terminate() runs, subsequent write()/resize() calls must
        // surface a "closed" error rather than trying to use handles that
        // were supposedly released. This proves the Option<Box<_>> take()
        // actually dropped the inner handles (the old `drop(guard)` bug
        // would have left the writer live and this test would have
        // returned Ok or a different I/O error).
        let session = make_test_session("PowerShell");
        let handle = spawn_pty(&session, |_| {}).expect("spawn");

        handle.terminate().expect("terminate should succeed");

        let write_err = handle.write(b"echo after close\r\n").unwrap_err();
        assert!(
            write_err.contains("already closed"),
            "write after terminate should report closed state, got: {write_err}"
        );
        let resize_err = handle.resize(80, 24).unwrap_err();
        assert!(
            resize_err.contains("already closed"),
            "resize after terminate should report closed state, got: {resize_err}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn terminate_short_circuits_when_child_already_exited() {
        // If the shell has already exited on its own, terminate() must
        // observe `child_exited` and return quickly *without* spending the
        // full graceful-shutdown budget. This also exercises the P1 fix:
        // in production, returning early here is what skips taskkill
        // against a PID that may have been recycled.
        let session = make_test_session("PowerShell");
        let (tx, rx) = mpsc::channel();
        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        })
        .expect("spawn");

        // Ask PowerShell to exit cleanly.
        handle.write(b"exit\r\n").expect("write exit");

        // Wait for the wait-thread to flip child_exited. Bail out if it
        // never does (avoid hanging the test on an unexpected hang).
        let exited = handle.child_exited.clone();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !exited.load(Ordering::Acquire) {
            if std::time::Instant::now() > deadline {
                panic!("shell never exited on its own after `exit` command");
            }
            // Drain any pending output so PowerShell isn't blocked on writes.
            let _ = rx.recv_timeout(Duration::from_millis(50));
        }

        let start = std::time::Instant::now();
        handle.terminate().expect("terminate should succeed");
        let elapsed = start.elapsed();
        // If terminate() short-circuited, it should return well under the
        // full 150ms graceful budget. Allow generous slack for CI jitter.
        assert!(
            elapsed < Duration::from_millis(100),
            "terminate should short-circuit when child already exited, took {elapsed:?}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_with_powershell_profile() {
        let session = make_test_session("PowerShell");
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        });

        assert!(handle.is_ok(), "PTY spawn should succeed for PowerShell");
        let handle = handle.unwrap();

        // Write a command and expect output
        let _ = handle.write(b"echo PTY_TEST_OK\r\n");

        // Wait for some output
        let mut got_output = false;
        for _ in 0..20 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                if !data.is_empty() {
                    got_output = true;
                    break;
                }
            }
        }
        assert!(got_output, "Should receive output from PTY");

        // Close by writing exit
        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_resize() {
        let session = make_test_session("PowerShell");
        let handle = spawn_pty(&session, |_| {}).unwrap();

        let result = handle.resize(120, 40);
        assert!(result.is_ok(), "Resize should succeed");

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_with_starting_directory() {
        // Use TEMP dir which always exists on Windows
        let temp_dir = std::env::temp_dir();
        let temp_str = temp_dir.to_string_lossy().to_string();
        let session = make_test_session_with_cwd("PowerShell", &temp_str);
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        });

        assert!(
            handle.is_ok(),
            "PTY spawn should succeed with starting_directory"
        );
        let handle = handle.unwrap();

        // Ask PowerShell for its current directory
        let _ = handle.write(b"(Get-Location).Path\r\n");

        let mut output = String::new();
        for _ in 0..30 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&String::from_utf8_lossy(&data));
                // temp dir path should appear (case-insensitive check)
                if output
                    .to_lowercase()
                    .contains(&temp_str.to_lowercase().replace('\\', "\\"))
                {
                    break;
                }
            }
        }
        // The output should contain the temp directory path
        assert!(
            output.to_lowercase().contains("temp"),
            "PowerShell should start in the specified directory. Got: {output}"
        );

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_sets_env_vars() {
        let session = make_test_session("PowerShell");
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        })
        .unwrap();

        // Check that LX_TERMINAL_ID is set
        let _ = handle.write(b"echo $env:LX_TERMINAL_ID\r\n");

        let mut output = String::new();
        for _ in 0..20 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("test-pty") {
                    break;
                }
            }
        }
        assert!(
            output.contains("test-pty"),
            "LX_TERMINAL_ID should be set. Got: {output}"
        );

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    #[cfg(windows)]
    fn expand_env_expands_percent_vars() {
        // %TEMP% should exist on Windows
        let result = expand_env_in_path("%TEMP%");
        assert!(!result.contains('%'), "Should expand %TEMP%. Got: {result}");
        assert!(!result.is_empty());
    }

    #[test]
    fn expand_env_expands_tilde() {
        let result = expand_env_in_path("~");
        assert!(!result.starts_with('~'), "Should expand ~. Got: {result}");
    }

    #[test]
    fn expand_env_preserves_plain_path() {
        let result = expand_env_in_path("C:\\Users\\test");
        assert_eq!(result, "C:\\Users\\test");
    }

    #[test]
    fn mnt_path_to_windows_converts_correctly() {
        assert_eq!(
            crate::path_utils::mnt_path_to_windows("/mnt/c/Users/test"),
            Some("C:\\Users\\test".into())
        );
        assert_eq!(
            crate::path_utils::mnt_path_to_windows("/mnt/d/Projects/app"),
            Some("D:\\Projects\\app".into())
        );
        assert_eq!(
            crate::path_utils::mnt_path_to_windows("/mnt/c/"),
            Some("C:\\".into())
        );
        assert_eq!(
            crate::path_utils::mnt_path_to_windows("/mnt/c"),
            Some("C:\\".into())
        );
        // Not a /mnt/ path
        assert_eq!(crate::path_utils::mnt_path_to_windows("/home/user"), None);
        assert_eq!(crate::path_utils::mnt_path_to_windows("/tmp"), None);
        assert_eq!(crate::path_utils::mnt_path_to_windows("C:\\Users"), None);
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_powershell_with_mnt_path_restores_cwd() {
        // PowerShell with a /mnt/c/... path should convert back to C:\...
        let temp_dir = std::env::temp_dir();
        let temp_str = temp_dir.to_string_lossy().to_string();
        // Convert Windows temp path to /mnt/ format
        let bytes = temp_str.as_bytes();
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let tail = temp_str[2..].replace('\\', "/");
        let mnt_path = format!("/mnt/{drive}{tail}");

        let session = TerminalSession::new(
            "test-ps-mnt".into(),
            TerminalConfig {
                profile: "PowerShell".into(),
                command_line: "powershell.exe -NoLogo".into(),
                startup_command: String::new(),
                starting_directory: mnt_path,
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![],
                advertise_true_color: true,
            },
        );
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        });

        assert!(
            handle.is_ok(),
            "PTY spawn should succeed with /mnt/ path for PowerShell"
        );
        let handle = handle.unwrap();

        let _ = handle.write(b"(Get-Location).Path\r\n");

        let mut output = String::new();
        for _ in 0..30 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.to_lowercase().contains(&temp_str.to_lowercase()) {
                    break;
                }
            }
        }
        assert!(
            output.to_lowercase().contains("temp"),
            "PowerShell should start in converted temp dir. Got: {output}"
        );

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    fn expand_env_handles_unknown_var() {
        let result = expand_env_in_path("%NONEXISTENT_VAR_12345%");
        // Should not panic, returns the original
        assert_eq!(result, "%NONEXISTENT_VAR_12345%");
    }

    /// In-memory writer that records all written bytes for verifying chunked writes.
    struct RecordingWriter {
        data: Vec<u8>,
        flush_count: usize,
    }

    impl RecordingWriter {
        fn new() -> Self {
            Self {
                data: Vec::new(),
                flush_count: 0,
            }
        }
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.data.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.flush_count += 1;
            Ok(())
        }
    }

    /// Proxy that delegates to a shared RecordingWriter.
    struct WriterProxy(Arc<Mutex<RecordingWriter>>);

    impl Write for WriterProxy {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.0.lock().unwrap().flush()
        }
    }

    fn make_recorder() -> (Box<dyn Write + Send>, Arc<Mutex<RecordingWriter>>) {
        let recorder = Arc::new(Mutex::new(RecordingWriter::new()));
        let writer: Box<dyn Write + Send> = Box::new(WriterProxy(Arc::clone(&recorder)));
        (writer, recorder)
    }

    struct StuckWriter {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for StuckWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (released, wake) = &*self.gate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn unacknowledged_platform_cancel_exposes_a_completion_barrier() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let handle = PtyHandle::from_test_writer(Box::new(StuckWriter {
            gate: Arc::clone(&gate),
        }));
        let started = Instant::now();

        let error = handle
            .write_guarded_until(
                b"blocked",
                Instant::now() + Duration::from_millis(20),
                || true,
            )
            .expect_err("deadline must fault a non-interruptible writer");
        assert!(error.contains("faulted and terminated"));
        assert!(started.elapsed() < Duration::from_secs(1));
        let completion = handle
            .pending_control_completion()
            .expect("worker acknowledgement must remain pending");
        assert!(!completion.is_complete());

        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !completion.is_complete() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(completion.is_complete());
    }

    #[test]
    fn chunked_write_to_empty_data() {
        let (mut writer, recorder) = make_recorder();
        chunked_write_to(&mut *writer, b"").unwrap();
        let rec = recorder.lock().unwrap();
        assert!(rec.data.is_empty());
        assert_eq!(rec.flush_count, 0);
    }

    #[test]
    fn chunked_write_to_smaller_than_chunk_size() {
        let (mut writer, recorder) = make_recorder();
        let data = b"hello";
        chunked_write_to(&mut *writer, data).unwrap();
        let rec = recorder.lock().unwrap();
        assert_eq!(rec.data, data);
        assert_eq!(rec.flush_count, 1);
    }

    #[test]
    fn chunked_write_to_exact_chunk_size() {
        let (mut writer, recorder) = make_recorder();
        let data = vec![0x41u8; PTY_WRITE_CHUNK_SIZE]; // exactly 1024 bytes
        chunked_write_to(&mut *writer, &data).unwrap();
        let rec = recorder.lock().unwrap();
        assert_eq!(rec.data, data);
        assert_eq!(rec.flush_count, 1);
    }

    #[test]
    fn chunked_write_to_larger_than_chunk_size() {
        let (mut writer, recorder) = make_recorder();
        let data = vec![0x42u8; PTY_WRITE_CHUNK_SIZE * 3 + 100]; // 3172 bytes
        chunked_write_to(&mut *writer, &data).unwrap();
        let rec = recorder.lock().unwrap();
        assert_eq!(rec.data, data);
        assert_eq!(rec.flush_count, 4); // 3 full chunks + 1 partial
    }

    #[test]
    fn guarded_write_reports_owner_change_after_the_last_physical_chunk() {
        let (mut writer, recorder) = make_recorder();
        let mut checks = 0;

        let result = chunked_write_to_guarded(&mut *writer, b"written-prefix", || {
            checks += 1;
            checks == 1
        });

        assert!(
            result.is_err(),
            "a stale final chunk must not be reported as success"
        );
        let rec = recorder.lock().unwrap();
        assert_eq!(rec.data, b"written-prefix");
        assert_eq!(rec.flush_count, 1);
    }

    #[test]
    fn guarded_write_stops_before_the_next_chunk_after_owner_change() {
        let (mut writer, recorder) = make_recorder();
        let data = vec![0x44; PTY_WRITE_CHUNK_SIZE * 2];
        let mut checks = 0;

        let result = chunked_write_to_guarded(&mut *writer, &data, || {
            checks += 1;
            checks <= 2
        });

        assert!(result.is_err());
        let rec = recorder.lock().unwrap();
        assert_eq!(rec.data.len(), PTY_WRITE_CHUNK_SIZE);
        assert_eq!(rec.flush_count, 1);
    }

    #[test]
    fn is_unix_path_detects_unix_paths() {
        assert!(is_unix_path("/home/user"));
        assert!(is_unix_path("/tmp"));
        assert!(!is_unix_path("C:\\Users\\test"));
        assert!(!is_unix_path(""));
        assert!(!is_unix_path("relative/path"));
    }

    #[test]
    fn is_wsl_command_detects_wsl() {
        assert!(is_wsl_command("wsl.exe"));
        assert!(is_wsl_command("wsl"));
        assert!(is_wsl_command("C:\\Windows\\System32\\wsl.exe"));
        assert!(is_wsl_command("WSL.EXE"));
        assert!(!is_wsl_command("powershell.exe"));
        assert!(!is_wsl_command("cmd.exe"));
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_wsl_with_unix_starting_directory() {
        // WSL with a Unix path should use --cd flag
        let session = TerminalSession::new(
            "test-wsl-cd".into(),
            TerminalConfig {
                profile: "WSL".into(),
                command_line: "wsl.exe".into(),
                startup_command: String::new(),
                starting_directory: "/tmp".into(),
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![],
                advertise_true_color: true,
            },
        );
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        });

        assert!(handle.is_ok(), "PTY spawn should succeed with WSL --cd");
        let handle = handle.unwrap();

        // Ask for current directory
        let _ = handle.write(b"pwd\n");

        let mut output = String::new();
        for _ in 0..30 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("/tmp") {
                    break;
                }
            }
        }
        assert!(
            output.contains("/tmp"),
            "WSL should start in /tmp. Got: {output}"
        );

        let _ = handle.write(b"exit\n");
    }
}
