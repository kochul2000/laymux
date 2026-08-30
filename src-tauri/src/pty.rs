use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::constants::*;
use crate::lock_ext::MutexExt;
#[cfg(target_os = "windows")]
use crate::process::{headless_command, status_with_timeout};
use crate::pty_control::{PendingControlJob, PtyControlCompletion, PtyControlWorker};
use crate::pty_reader::{run_interruptible_reader_loop, PtyReaderLifecycle};
use crate::terminal::{
    InitialExecutionHost, NativeWindowsCodexColorProbeGuard, TerminalBootstrapDaReplyGuard,
    TerminalSession,
};
use crate::terminal_env::TerminalEnvPlan;

/// One maximum native reader Data event. Desktop output credit may exceed its
/// window by at most this amount because backpressure is applied after a
/// complete callback chunk.
pub(crate) const PTY_READ_BUFFER_BYTES: usize = 4096;

/// Reader-loop decision returned by every PTY output callback.
///
/// `Stop` is a synchronous fail-stop boundary: after it is returned, the
/// reader must not perform another master read or dispatch another chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub enum PtyOutputControl {
    Continue,
    Stop,
}

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
    let executable = cmd_path.rsplit(['/', '\\']).next().unwrap_or("");
    executable.eq_ignore_ascii_case("wsl") || executable.eq_ignore_ascii_case("wsl.exe")
}

/// How a configured starting directory reaches the spawned command.
///
/// The plan is computed once so the directory the child really starts in is
/// known to the caller as well: [`SpawnedPty::resolved_cwd`] seeds
/// `TerminalSession::cwd`, which otherwise stays `None` until an accepted
/// OSC 7 arrives.
#[derive(Debug, PartialEq, Eq)]
enum StartDirPlan {
    /// WSL command with a Unix path: passed as `wsl --cd <dir>`.
    WslCd(String),
    /// Everything else: the child process's OS working directory.
    ChildCwd(String),
    /// Nothing configured, or the resolved directory does not exist.
    None,
}

/// Resolve `starting_directory` against the command that will run it.
fn plan_start_dir(starting_directory: &str, cmd_path: &str) -> StartDirPlan {
    if starting_directory.is_empty() {
        return StartDirPlan::None;
    }
    let dir = expand_env_in_path(starting_directory);
    if is_unix_path(&dir) && is_wsl_command(cmd_path) {
        // Not existence-checked: the path lives inside the distro and the distro
        // is not resolved here. It needs no guard either — `wsl --cd <missing>`
        // fails the launch outright (`Wsl/ERROR_FILE_NOT_FOUND`) instead of
        // starting the shell somewhere else, so a seed can never disagree with
        // where a running child actually is.
        return StartDirPlan::WslCd(dir);
    }
    // For non-WSL commands, convert /mnt/X/... back to Windows path
    let effective_dir = if is_unix_path(&dir) {
        crate::path_utils::mnt_path_to_windows(&dir).unwrap_or(dir)
    } else {
        dir
    };
    if std::path::Path::new(&effective_dir).is_dir() {
        StartDirPlan::ChildCwd(effective_dir)
    } else {
        StartDirPlan::None
    }
}

impl StartDirPlan {
    /// The canonical CWD the child starts in, in the same form OSC 7 CWDs are
    /// stored in, so `filter_targets_needing_cd` can compare the two.
    fn resolved_cwd(&self) -> Option<String> {
        match self {
            StartDirPlan::WslCd(dir) | StartDirPlan::ChildCwd(dir) => {
                Some(crate::path_utils::normalize_wsl_path(dir))
            }
            StartDirPlan::None => None,
        }
    }
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
    /// Serializes publishing child exit with claiming PID-based tree kill.
    /// The wait thread retains its OS child handle while waiting for this
    /// mutex, so Windows cannot recycle the PID during a claimed taskkill.
    child_exit_handshake: Arc<Mutex<()>>,
    input_faulted: Arc<AtomicBool>,
    /// Generation-bound reader wake and teardown completion. This is separate
    /// from the master so a blocking cloned output pipe can be interrupted.
    reader_lifecycle: Arc<PtyReaderLifecycle>,
    /// Generation-local filter for the native Windows Codex startup probe.
    /// It lives on the exact writer handle so a stale frontend reply can never
    /// consume a replacement session's one-shot state.
    codex_startup_color_probe: Option<Arc<NativeWindowsCodexColorProbeGuard>>,
    /// Current-generation authorization for the one ConPTY bootstrap Primary
    /// DA reply that may be regenerated from the first attach snapshot.
    bootstrap_da_reply: Option<Arc<TerminalBootstrapDaReplyGuard>>,
    /// True when the spawned command is `wsl.exe`, so `child_pid` anchors a
    /// Windows relay process and every interesting descendant lives inside the
    /// guest. The liveness oracle needs this to know that a Windows process
    /// snapshot has no standing over this pane at all (ADR-0134).
    wsl_backed: bool,
}

impl PtyHandle {
    /// Time budget `terminate()` gives the shell to exit on its own after the
    /// PTY is closed before falling back to a forced kill. Polled in small
    /// steps so well-behaved shells return almost immediately.
    const GRACEFUL_SHUTDOWN_TOTAL: Duration = Duration::from_millis(150);
    const GRACEFUL_SHUTDOWN_STEP: Duration = Duration::from_millis(10);

    #[cfg(test)]
    pub(crate) fn from_test_writer(writer: Box<dyn Write + Send>) -> Self {
        Self::from_test_writer_for_generation(writer, 0)
    }

    #[cfg(test)]
    pub(crate) fn from_test_writer_for_generation(
        writer: Box<dyn Write + Send>,
        terminal_generation: u64,
    ) -> Self {
        let master = Arc::new(Mutex::new(None));
        Self {
            control: PtyControlWorker::spawn(writer, Arc::clone(&master))
                .expect("test PTY control worker"),
            master,
            child_killer: Arc::new(Mutex::new(None)),
            child_pid: None,
            child_exited: Arc::new(AtomicBool::new(true)),
            child_exit_handshake: Arc::new(Mutex::new(())),
            input_faulted: Arc::new(AtomicBool::new(false)),
            reader_lifecycle: PtyReaderLifecycle::completed_for_test(terminal_generation),
            codex_startup_color_probe: None,
            bootstrap_da_reply: None,
            wsl_backed: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_wsl_backed(mut self, wsl_backed: bool) -> Self {
        self.wsl_backed = wsl_backed;
        self
    }

    #[cfg(test)]
    pub(crate) fn with_child_pid(mut self, child_pid: Option<u32>) -> Self {
        self.child_pid = child_pid;
        self
    }

    pub(crate) fn with_codex_startup_color_probe(
        mut self,
        guard: Option<Arc<NativeWindowsCodexColorProbeGuard>>,
    ) -> Self {
        self.codex_startup_color_probe = guard;
        self
    }

    pub(crate) fn with_bootstrap_da_reply(
        mut self,
        guard: Option<Arc<TerminalBootstrapDaReplyGuard>>,
    ) -> Self {
        self.bootstrap_da_reply = guard;
        self
    }

    pub(crate) fn terminal_generation(&self) -> u64 {
        self.reader_lifecycle.terminal_generation()
    }

    pub(crate) fn codex_startup_color_probe(&self) -> Option<&NativeWindowsCodexColorProbeGuard> {
        self.codex_startup_color_probe.as_deref()
    }

    pub(crate) fn bootstrap_da_reply(&self) -> Option<&TerminalBootstrapDaReplyGuard> {
        self.bootstrap_da_reply.as_deref()
    }

    #[cfg(test)]
    pub(crate) fn child_exited_for_test(&self) -> bool {
        self.child_exited.load(Ordering::Acquire)
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
        // Stop the exact reader generation before closing writer/master state.
        // A wake failure is not success: cleanup continues and the lifecycle
        // completion below is the authoritative fallback acknowledgement.
        let wake_result = self
            .reader_lifecycle
            .request_stop(Duration::from_millis(PTY_READER_WAKE_TIMEOUT_MS));
        self.control.close();
        self.wait_for_child(Self::GRACEFUL_SHUTDOWN_TOTAL);
        let kill_result = if self.child_exited.load(Ordering::Acquire) {
            Ok(())
        } else {
            let result = self.kill_child_tree();
            self.wait_for_child(Duration::from_millis(PTY_CONTROL_TERMINATE_GRACE_MS));
            result
        };
        let reader_result = self
            .reader_lifecycle
            .wait_for_exit(Duration::from_millis(PTY_READER_EXIT_TIMEOUT_MS));
        match (kill_result, reader_result) {
            (Err(kill), Err(reader)) => Err(format!("{kill}; {reader}")),
            (Err(kill), Ok(())) => Err(kill),
            (Ok(()), Err(reader)) => Err(match wake_result {
                Err(wake) => format!("{wake}; {reader}"),
                Ok(()) => reader,
            }),
            (Ok(()), Ok(())) => Ok(()),
        }
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

    /// True when the PTY child is `wsl.exe`. See [`PtyHandle::wsl_backed`].
    pub fn is_wsl_backed(&self) -> bool {
        self.wsl_backed
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

    /// Return the worker lifecycle acknowledgement unconditionally. Handle
    /// retirement uses this before the worker can fault so a concurrent write
    /// cannot become invisible after the handle leaves the live registry.
    pub(crate) fn control_completion(&self) -> PtyControlCompletion {
        self.control.completion()
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
        run_with_live_child_kill_claim(&self.child_exit_handshake, &self.child_exited, || {
            self.kill_child_tree_claimed()
        })?
        .unwrap_or(Ok(()))
    }

    /// Kill implementation entered only while the child-exit handshake is
    /// held and the wait thread therefore still reserves the Windows PID.
    fn kill_child_tree_claimed(&self) -> Result<(), String> {
        #[allow(unused_mut)]
        let mut platform_error: Option<String> = None;
        #[cfg(target_os = "windows")]
        if let Some(pid) = self.child_pid {
            let mut taskkill = headless_command("taskkill");
            taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
            match status_with_timeout(
                &mut taskkill,
                Duration::from_millis(PTY_PROCESS_TREE_KILL_TIMEOUT_MS),
            ) {
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

fn run_with_live_child_kill_claim<T>(
    handshake: &Mutex<()>,
    child_exited: &AtomicBool,
    action: impl FnOnce() -> T,
) -> Result<Option<T>, String> {
    let _claim = handshake.lock_or_err()?;
    if child_exited.load(Ordering::Acquire) {
        return Ok(None);
    }
    Ok(Some(action()))
}

fn publish_child_exit(handshake: &Mutex<()>, child_exited: &AtomicBool) -> Result<(), String> {
    let _claim = handshake.lock_or_err()?;
    child_exited.store(true, Ordering::Release);
    Ok(())
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
pub struct SpawnedPty {
    pub handle: PtyHandle,
    pub initial_execution_host: InitialExecutionHost,
    /// The directory the child was actually started in, canonicalized like an
    /// OSC 7 CWD, or `None` when no starting directory could be applied.
    pub resolved_cwd: Option<String>,
}

pub fn spawn_pty<F>(session: &TerminalSession, on_output: F) -> Result<PtyHandle, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    spawn_pty_for_generation(session, 1, on_output).map(|spawned| spawned.handle)
}

pub fn spawn_pty_with_metadata<F>(
    session: &TerminalSession,
    on_output: F,
) -> Result<SpawnedPty, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    spawn_pty_for_generation(session, 1, on_output)
}

pub fn spawn_pty_for_generation<F>(
    session: &TerminalSession,
    terminal_generation: u64,
    on_output: F,
) -> Result<SpawnedPty, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
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
    let initial_execution_host = InitialExecutionHost::for_current_platform(Some(&cmd_path));
    let mut cmd = CommandBuilder::new(&cmd_path);
    for arg in &args {
        cmd.arg(arg);
    }
    env_plan.apply_to_command(&mut cmd);

    // Set starting directory if configured
    let start_dir = plan_start_dir(&session.config.starting_directory, &cmd_path);
    match &start_dir {
        StartDirPlan::WslCd(dir) => {
            // WSL terminal with Unix path: inject --cd flag before existing args
            cmd = CommandBuilder::new(&cmd_path);
            cmd.arg("--cd");
            cmd.arg(dir);
            for arg in &args {
                cmd.arg(arg);
            }
            env_plan.apply_to_command(&mut cmd);
        }
        StartDirPlan::ChildCwd(dir) => cmd.cwd(std::path::Path::new(dir)),
        StartDirPlan::None => {}
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    let child_pid = child.process_id();
    let child_killer = child.clone_killer();
    let child_exited = Arc::new(AtomicBool::new(false));
    let exited_signal = Arc::clone(&child_exited);
    let child_exit_handshake = Arc::new(Mutex::new(()));
    let exited_handshake = Arc::clone(&child_exit_handshake);

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
        if let Err(error) = publish_child_exit(&exited_handshake, &exited_signal) {
            // Dropping the process handle after a poisoned handshake could
            // make a concurrent PID-based kill unsafe. Leak it instead; this
            // is a terminal-local fail-safe on an already-corrupted path.
            tracing::error!(%error, "child exit handshake failed; retaining process handle");
            std::mem::forget(child);
        }
        // `child` drops here; Windows may recycle the PID after this point.
    });
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {e}"))?;

    let reader_pair = pair
        .master
        .try_clone_interruptible_reader(terminal_generation)
        .map_err(|e| format!("Failed to clone interruptible reader: {e}"))?
        .ok_or_else(|| "Native PTY does not provide an interruptible reader".to_string())?;
    let reader_lifecycle = PtyReaderLifecycle::new(terminal_generation, reader_pair.control)?;

    let master = Arc::new(Mutex::new(Some(pair.master)));
    let control = PtyControlWorker::spawn(writer, Arc::clone(&master))?;
    let handle = PtyHandle {
        control,
        master,
        child_killer: Arc::new(Mutex::new(Some(child_killer))),
        child_pid,
        child_exited,
        child_exit_handshake,
        input_faulted: Arc::new(AtomicBool::new(false)),
        reader_lifecycle: Arc::clone(&reader_lifecycle),
        codex_startup_color_probe: None,
        bootstrap_da_reply: None,
        wsl_backed: is_wsl,
    };

    // Spawn reader thread
    thread::spawn(move || {
        run_interruptible_reader_loop(reader_pair.reader, reader_lifecycle, on_output);
    });

    Ok(SpawnedPty {
        handle,
        initial_execution_host,
        resolved_cwd: start_dir.resolved_cwd(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::InitialExecutionHost;
    #[cfg(any(windows, target_os = "linux"))]
    use crate::terminal::TerminalConfig;
    use std::cell::Cell;
    use std::sync::mpsc;
    use std::sync::Condvar;
    use std::time::{Duration, Instant};

    #[test]
    fn output_reader_stops_before_reading_or_dispatching_another_chunk() {
        struct ChunkReader {
            chunks: std::collections::VecDeque<Vec<u8>>,
            reads: Arc<std::sync::atomic::AtomicUsize>,
        }

        impl portable_pty::InterruptiblePtyReader for ChunkReader {
            fn read_event(&mut self) -> portable_pty::PtyReadEvent {
                self.reads.fetch_add(1, Ordering::Relaxed);
                let Some(chunk) = self.chunks.pop_front() else {
                    return portable_pty::PtyReadEvent::Eof;
                };
                portable_pty::PtyReadEvent::Data(chunk)
            }
        }

        struct TestControl;
        impl portable_pty::InterruptiblePtyReaderControl for TestControl {
            fn terminal_generation(&self) -> u64 {
                99
            }

            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<portable_pty::PtyWakeOutcome> {
                Ok(portable_pty::PtyWakeOutcome::Terminal)
            }
        }

        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader = ChunkReader {
            chunks: [b"fatal".to_vec(), b"must-not-run".to_vec()].into(),
            reads: Arc::clone(&reads),
        };
        let callbacks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let callback_count = Arc::clone(&callbacks);

        let lifecycle = PtyReaderLifecycle::new(99, Box::new(TestControl)).unwrap();
        run_interruptible_reader_loop(Box::new(reader), lifecycle, move |_| {
            callback_count.fetch_add(1, Ordering::Relaxed);
            PtyOutputControl::Stop
        });

        assert_eq!(callbacks.load(Ordering::Relaxed), 1);
        assert_eq!(reads.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn output_reader_does_not_prefetch_while_callback_is_blocked() {
        struct CountingReader {
            chunks: std::collections::VecDeque<Vec<u8>>,
            reads: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl portable_pty::InterruptiblePtyReader for CountingReader {
            fn read_event(&mut self) -> portable_pty::PtyReadEvent {
                self.reads.fetch_add(1, Ordering::AcqRel);
                self.chunks
                    .pop_front()
                    .map(portable_pty::PtyReadEvent::Data)
                    .unwrap_or(portable_pty::PtyReadEvent::Eof)
            }
        }
        struct TestControl;
        impl portable_pty::InterruptiblePtyReaderControl for TestControl {
            fn terminal_generation(&self) -> u64 {
                100
            }
            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<portable_pty::PtyWakeOutcome> {
                Ok(portable_pty::PtyWakeOutcome::Terminal)
            }
        }

        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader = CountingReader {
            chunks: [
                b"first".to_vec(),
                b"second".to_vec(),
                b"must-not-read".to_vec(),
            ]
            .into(),
            reads: Arc::clone(&reads),
        };
        let lifecycle = PtyReaderLifecycle::new(100, Box::new(TestControl)).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let callbacks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let callback_count = Arc::clone(&callbacks);
        let worker = thread::spawn(move || {
            run_interruptible_reader_loop(Box::new(reader), lifecycle, move |_| {
                let call = callback_count.fetch_add(1, Ordering::AcqRel);
                if call == 0 {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    PtyOutputControl::Continue
                } else {
                    PtyOutputControl::Stop
                }
            });
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        thread::sleep(Duration::from_millis(20));
        assert_eq!(reads.load(Ordering::Acquire), 1);
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(callbacks.load(Ordering::Acquire), 2);
        assert_eq!(reads.load(Ordering::Acquire), 2);
    }

    #[test]
    fn external_stop_during_a_blocked_callback_joins_the_reader_generation() {
        struct CountingReader {
            chunks: std::collections::VecDeque<Vec<u8>>,
            reads: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl portable_pty::InterruptiblePtyReader for CountingReader {
            fn read_event(&mut self) -> portable_pty::PtyReadEvent {
                self.reads.fetch_add(1, Ordering::AcqRel);
                self.chunks
                    .pop_front()
                    .map(portable_pty::PtyReadEvent::Data)
                    .unwrap_or(portable_pty::PtyReadEvent::Eof)
            }
        }
        struct TimedOutControl;
        impl portable_pty::InterruptiblePtyReaderControl for TimedOutControl {
            fn terminal_generation(&self) -> u64 {
                102
            }
            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<portable_pty::PtyWakeOutcome> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "injected cancellation deadline",
                ))
            }
        }

        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reader = CountingReader {
            chunks: [b"first".to_vec(), b"must-not-read".to_vec()].into(),
            reads: Arc::clone(&reads),
        };
        let lifecycle = PtyReaderLifecycle::new(102, Box::new(TimedOutControl)).unwrap();
        let worker_lifecycle = Arc::clone(&lifecycle);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            run_interruptible_reader_loop(Box::new(reader), worker_lifecycle, move |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                PtyOutputControl::Continue
            });
            done_tx.send(()).unwrap();
        });

        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(reads.load(Ordering::Acquire), 1);
        assert!(lifecycle.request_stop(Duration::from_millis(1)).is_err());
        assert_eq!(reads.load(Ordering::Acquire), 1);
        release_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        lifecycle.wait_for_exit(Duration::from_millis(1)).unwrap();
        assert_eq!(reads.load(Ordering::Acquire), 1);
    }

    #[test]
    fn malformed_empty_data_stops_without_waiting_forever_for_a_decision() {
        struct EmptyReader(bool);
        impl portable_pty::InterruptiblePtyReader for EmptyReader {
            fn read_event(&mut self) -> portable_pty::PtyReadEvent {
                if std::mem::replace(&mut self.0, false) {
                    portable_pty::PtyReadEvent::Data(Vec::new())
                } else {
                    portable_pty::PtyReadEvent::Eof
                }
            }
        }
        struct TestControl;
        impl portable_pty::InterruptiblePtyReaderControl for TestControl {
            fn terminal_generation(&self) -> u64 {
                101
            }
            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<portable_pty::PtyWakeOutcome> {
                Ok(portable_pty::PtyWakeOutcome::Terminal)
            }
        }
        let lifecycle = PtyReaderLifecycle::new(101, Box::new(TestControl)).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            run_interruptible_reader_loop(Box::new(EmptyReader(true)), lifecycle, |_| {
                panic!("empty Data must not reach the output callback")
            });
            done_tx.send(()).unwrap();
        });
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn oversized_data_stops_without_waiting_forever_for_a_decision() {
        struct OversizedReader(bool);
        impl portable_pty::InterruptiblePtyReader for OversizedReader {
            fn read_event(&mut self) -> portable_pty::PtyReadEvent {
                if std::mem::replace(&mut self.0, false) {
                    portable_pty::PtyReadEvent::Data(vec![0; PTY_READ_BUFFER_BYTES + 1])
                } else {
                    portable_pty::PtyReadEvent::Eof
                }
            }
        }
        struct TestControl;
        impl portable_pty::InterruptiblePtyReaderControl for TestControl {
            fn terminal_generation(&self) -> u64 {
                103
            }
            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<portable_pty::PtyWakeOutcome> {
                Ok(portable_pty::PtyWakeOutcome::Terminal)
            }
        }
        let lifecycle = PtyReaderLifecycle::new(103, Box::new(TestControl)).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            run_interruptible_reader_loop(Box::new(OversizedReader(true)), lifecycle, |_| {
                panic!("oversized Data must not reach the output callback")
            });
            done_tx.send(()).unwrap();
        });
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    /// PTY 출력을 `needle` 이 보일 때까지(또는 `timeout` 까지) 모은다.
    ///
    /// 청크 **개수**로 예산을 잡으면 콘솔 호스트가 시작 시퀀스를 잘게 쪼개 보낼 때
    /// 정작 기다리던 본문이 오기 전에 예산이 소진된다 — 번들 ConPTY 로 바꾸면서
    /// 실제로 겪었다([ADR-0067](../../docs/adr/0067-bundled-conpty-output-and-staging-contract.md)).
    /// 예산은 시간으로만 잡는다. 비교는 대소문자를 구분하지 않는다.
    #[cfg(any(windows, target_os = "linux"))]
    fn collect_pty_output_until(
        rx: &mpsc::Receiver<Vec<u8>>,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let deadline = Instant::now() + timeout;
        let needle = needle.to_lowercase();
        let mut output = String::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return output;
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(500))) {
                Ok(data) => {
                    output.push_str(&String::from_utf8_lossy(&data));
                    if output.to_lowercase().contains(&needle) {
                        return output;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return output,
            }
        }
    }

    #[cfg(any(windows, target_os = "linux"))]
    const PTY_OUTPUT_TIMEOUT: Duration = Duration::from_secs(15);

    #[cfg(windows)]
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

    #[cfg(windows)]
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

    #[cfg(any(windows, target_os = "linux"))]
    fn make_native_idle_session() -> TerminalSession {
        #[cfg(windows)]
        let command_line = "powershell.exe -NoLogo";
        #[cfg(target_os = "linux")]
        let command_line = "/bin/sh";
        TerminalSession::new(
            "interruptible-reader-test".into(),
            TerminalConfig {
                profile: "native-test".into(),
                command_line: command_line.into(),
                startup_command: String::new(),
                starting_directory: String::new(),
                cols: 80,
                rows: 24,
                sync_group: "reader-test".into(),
                env: vec![],
                advertise_true_color: true,
            },
        )
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn make_native_binary_probe_session(
        command_line: String,
        startup_command: String,
    ) -> TerminalSession {
        TerminalSession::new(
            "binary-input-probe".into(),
            TerminalConfig {
                profile: "native-binary-probe".into(),
                command_line,
                startup_command,
                starting_directory: String::new(),
                cols: 80,
                rows: 24,
                sync_group: "binary-input-probe".into(),
                env: vec![],
                advertise_true_color: true,
            },
        )
    }

    #[cfg(windows)]
    fn native_binary_probe_command(
        directory: &std::path::Path,
    ) -> Result<(String, String), Box<dyn std::error::Error>> {
        let script_path = directory.join("binary-input-probe.ps1");
        std::fs::write(
            &script_path,
            r#"Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LaymuxRawConsoleInput {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleMode(IntPtr handle, uint mode);
}
'@
$handle = [LaymuxRawConsoleInput]::GetStdHandle(-10)
if (-not [LaymuxRawConsoleInput]::SetConsoleMode($handle, 0x0200)) {
    throw "failed to enable virtual terminal input"
}
[Console]::WriteLine("RAW_READY")
$stream = [Console]::OpenStandardInput()
$bytes = New-Object byte[] 6
$offset = 0
while ($offset -lt $bytes.Length) {
    $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($read -le 0) { throw "stdin closed before the binary report completed" }
    $offset += $read
}
$hex = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
[Console]::WriteLine("RAW_BYTES:" + $hex)
"#,
        )?;
        let escaped_path = script_path.display().to_string().replace('\'', "''");
        Ok(("powershell.exe".into(), format!("& '{escaped_path}'; exit")))
    }

    #[cfg(target_os = "linux")]
    fn native_binary_probe_command(
        directory: &std::path::Path,
    ) -> Result<(String, String), Box<dyn std::error::Error>> {
        let script_path = directory.join("binary-input-probe.sh");
        std::fs::write(
            &script_path,
            r#"stty raw -echo
printf 'RAW_READY\r\n'
hex="$(dd bs=1 count=6 2>/dev/null | od -An -tx1 | tr -d ' \r\n')"
printf 'RAW_BYTES:%s\r\n' "$hex"
"#,
        )?;
        Ok((format!("/bin/sh {}", script_path.display()), String::new()))
    }

    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn native_pty_input_obeys_platform_binary_mouse_boundary() {
        let directory = tempfile::tempdir().expect("binary probe tempdir");
        let (command_line, startup_command) =
            native_binary_probe_command(directory.path()).expect("binary probe script");
        let session = make_native_binary_probe_session(command_line, startup_command);
        let (tx, rx) = mpsc::channel();
        let handle = spawn_pty_for_generation(&session, 79, move |data| {
            let _ = tx.send(data);
            PtyOutputControl::Continue
        })
        .expect("spawn native binary probe")
        .handle;

        let ready = collect_pty_output_until(&rx, "RAW_READY", PTY_OUTPUT_TIMEOUT);
        #[cfg(windows)]
        let report = [0x1b, b'[', b'M', 0x20, 0x7e, 0x7f];
        #[cfg(target_os = "linux")]
        let report = [0x1b, b'[', b'M', 0x20, 0x80, 0xff];
        let write_result = handle.write(&report);
        let output = collect_pty_output_until(&rx, "RAW_BYTES:", PTY_OUTPUT_TIMEOUT);
        let _ = handle.terminate();

        assert!(
            ready.contains("RAW_READY"),
            "probe did not become ready: {ready:?}"
        );
        write_result.expect("write binary report to native PTY");
        let report_hex = report
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expected = format!("raw_bytes:{report_hex}");
        assert!(
            output.to_lowercase().contains(&expected),
            "native PTY changed binary input bytes: {output:?}"
        );
    }

    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn native_interruptible_reader_preserves_data_and_stops_while_idle() {
        let session = make_native_idle_session();
        let (tx, rx) = mpsc::channel();
        let handle = spawn_pty_for_generation(&session, 73, move |data| {
            let _ = tx.send(data);
            PtyOutputControl::Continue
        })
        .expect("spawn native PTY")
        .handle;

        handle
            .write(b"echo INTERRUPTIBLE_READER_DATA_OK\r\n")
            .expect("write marker");
        let output =
            collect_pty_output_until(&rx, "INTERRUPTIBLE_READER_DATA_OK", PTY_OUTPUT_TIMEOUT);
        assert!(output.contains("INTERRUPTIBLE_READER_DATA_OK"));

        // Make the next native read idle, then require a bounded generation
        // wake rather than relying on child output or cloned-reader close.
        thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        handle.terminate().expect("idle generation teardown");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "idle PTY reader did not stop within the bounded teardown window"
        );
        handle
            .reader_lifecycle
            .wait_for_exit(Duration::from_millis(1))
            .expect("reader generation completion");
    }

    #[test]
    fn initial_execution_host_uses_the_actual_spawn_target_basename() {
        assert_eq!(
            InitialExecutionHost::classify_spawn_target(Some(r"C:\Windows\System32\wsl.EXE"), true,),
            InitialExecutionHost::Wsl,
        );
        assert_eq!(
            InitialExecutionHost::classify_spawn_target(Some("/usr/bin/ssh"), true),
            InitialExecutionHost::DirectSsh,
        );
        assert_eq!(
            InitialExecutionHost::classify_spawn_target(Some("pwsh.exe"), true),
            InitialExecutionHost::NativeWindows,
        );
        assert_eq!(
            InitialExecutionHost::classify_spawn_target(Some("bash"), false),
            InitialExecutionHost::NonWindows,
        );
        assert_eq!(
            InitialExecutionHost::classify_spawn_target(None, true),
            InitialExecutionHost::Unknown,
        );
        assert_eq!(
            InitialExecutionHost::classify_spawn_target(Some("  "), true),
            InitialExecutionHost::Unknown,
        );
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
    fn child_exit_publication_waits_for_an_in_flight_kill_claim() {
        let handshake = Arc::new(Mutex::new(()));
        let child_exited = Arc::new(AtomicBool::new(false));
        let (kill_started_tx, kill_started_rx) = mpsc::channel();
        let (release_kill_tx, release_kill_rx) = mpsc::channel();
        let kill_handshake = Arc::clone(&handshake);
        let kill_exited = Arc::clone(&child_exited);
        let killer = thread::spawn(move || {
            run_with_live_child_kill_claim(&kill_handshake, &kill_exited, || {
                kill_started_tx.send(()).unwrap();
                release_kill_rx.recv().unwrap();
            })
            .unwrap()
        });
        kill_started_rx.recv().unwrap();

        let (wait_started_tx, wait_started_rx) = mpsc::channel();
        let (wait_done_tx, wait_done_rx) = mpsc::channel();
        let wait_handshake = Arc::clone(&handshake);
        let wait_exited = Arc::clone(&child_exited);
        let waiter = thread::spawn(move || {
            wait_started_tx.send(()).unwrap();
            publish_child_exit(&wait_handshake, &wait_exited).unwrap();
            wait_done_tx.send(()).unwrap();
        });
        wait_started_rx.recv().unwrap();

        assert!(wait_done_rx.try_recv().is_err());
        assert!(!child_exited.load(Ordering::Acquire));
        release_kill_tx.send(()).unwrap();

        assert!(killer.join().unwrap().is_some());
        waiter.join().unwrap();
        assert!(child_exited.load(Ordering::Acquire));
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
        let handle = spawn_pty(&session, |_| PtyOutputControl::Continue).expect("spawn");

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
            PtyOutputControl::Continue
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
            PtyOutputControl::Continue
        });

        assert!(handle.is_ok(), "PTY spawn should succeed for PowerShell");
        let handle = handle.unwrap();

        // Write a command and expect output
        let _ = handle.write(b"echo PTY_TEST_OK\r\n");

        // Wait for some output
        let output = collect_pty_output_until(&rx, "PTY_TEST_OK", PTY_OUTPUT_TIMEOUT);
        assert!(!output.is_empty(), "Should receive output from PTY");

        // Close by writing exit
        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    #[cfg(windows)]
    fn spawn_pty_resize() {
        let session = make_test_session("PowerShell");
        let handle = spawn_pty(&session, |_| PtyOutputControl::Continue).unwrap();

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
            PtyOutputControl::Continue
        });

        assert!(
            handle.is_ok(),
            "PTY spawn should succeed with starting_directory"
        );
        let handle = handle.unwrap();

        // Ask PowerShell for its current directory
        let _ = handle.write(b"(Get-Location).Path\r\n");

        let output = collect_pty_output_until(&rx, &temp_str, PTY_OUTPUT_TIMEOUT);
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
            PtyOutputControl::Continue
        })
        .unwrap();

        // Check that LX_TERMINAL_ID is set
        let _ = handle.write(b"echo $env:LX_TERMINAL_ID\r\n");

        let output = collect_pty_output_until(&rx, "test-pty", PTY_OUTPUT_TIMEOUT);
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
            PtyOutputControl::Continue
        });

        assert!(
            handle.is_ok(),
            "PTY spawn should succeed with /mnt/ path for PowerShell"
        );
        let handle = handle.unwrap();

        let _ = handle.write(b"(Get-Location).Path\r\n");

        let output = collect_pty_output_until(&rx, &temp_str, PTY_OUTPUT_TIMEOUT);
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
    fn plan_start_dir_has_no_plan_without_a_starting_directory() {
        let plan = plan_start_dir("", "powershell.exe");
        assert_eq!(plan, StartDirPlan::None);
        assert_eq!(plan.resolved_cwd(), None);
    }

    #[test]
    fn plan_start_dir_keeps_a_unix_path_for_wsl() {
        let plan = plan_start_dir("/home/user/project", "wsl.exe");
        assert_eq!(plan, StartDirPlan::WslCd("/home/user/project".into()));
        assert_eq!(plan.resolved_cwd().as_deref(), Some("/home/user/project"));
    }

    #[test]
    fn plan_start_dir_resolves_an_existing_directory_to_the_canonical_cwd() {
        let temp = std::env::temp_dir();
        let plan = plan_start_dir(&temp.to_string_lossy(), "powershell.exe");
        let StartDirPlan::ChildCwd(dir) = &plan else {
            panic!("an existing directory should become the child CWD, got {plan:?}");
        };
        assert_eq!(std::path::Path::new(dir), temp.as_path());
        // The seed must be shaped like an OSC 7 CWD, or `filter_targets_needing_cd`
        // cannot compare the two.
        assert_eq!(
            plan.resolved_cwd(),
            Some(crate::path_utils::normalize_wsl_path(
                &temp.to_string_lossy()
            ))
        );
    }

    #[test]
    fn plan_start_dir_has_no_plan_for_a_missing_directory() {
        let missing = std::env::temp_dir().join("laymux-no-such-start-dir-9c1f");
        let plan = plan_start_dir(&missing.to_string_lossy(), "powershell.exe");
        // The PTY starts in the inherited CWD here, so seeding the requested one
        // would claim a directory the child is not in.
        assert_eq!(plan, StartDirPlan::None);
        assert_eq!(plan.resolved_cwd(), None);
    }

    #[test]
    fn is_wsl_command_detects_wsl() {
        assert!(is_wsl_command("wsl.exe"));
        assert!(is_wsl_command("wsl"));
        assert!(is_wsl_command("C:\\Windows\\System32\\wsl.exe"));
        assert!(is_wsl_command("C:\\Windows/System32\\wsl.exe"));
        assert!(is_wsl_command("/mnt/c/Windows\\System32/wsl.EXE"));
        assert!(is_wsl_command("WSL.EXE"));
        assert!(!is_wsl_command("powershell.exe"));
        assert!(!is_wsl_command("cmd.exe"));
        assert!(!is_wsl_command("not-wsl.exe"));
        assert!(!is_wsl_command("wsl.cmd"));
        assert!(!is_wsl_command("wsl.exe.backup"));
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
            PtyOutputControl::Continue
        });

        assert!(handle.is_ok(), "PTY spawn should succeed with WSL --cd");
        let handle = handle.unwrap();

        // Ask for current directory
        let _ = handle.write(b"pwd\n");

        let output = collect_pty_output_until(&rx, "/tmp", PTY_OUTPUT_TIMEOUT);
        assert!(
            output.contains("/tmp"),
            "WSL should start in /tmp. Got: {output}"
        );

        let _ = handle.write(b"exit\n");
    }
}
