//! Bounded, per-terminal FIFO for PTY input and resize operations.
//!
//! The platform writer lives only on this worker thread. Human-control callers
//! wait in short intervals so an owner epoch change or deadline can target the
//! exact active Windows synchronous I/O without cancelling a subsequent job.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{MasterPty, PtySize};

use crate::constants::{
    ENTER_SUBMIT_CR_DELAY_MS, PTY_CONTROL_QUEUE_CAPACITY, PTY_CONTROL_WAIT_POLL_MS,
};
use crate::lock_ext::MutexExt;
use crate::pty::chunked_write_to_guarded;

type ControlResult = Result<(), String>;

enum ControlJob {
    Write {
        id: u64,
        data: Vec<u8>,
        /// Append a submit CR after the body, gapped by [`ENTER_SUBMIT_CR_DELAY_MS`],
        /// within this same job so the pair stays atomic on the FIFO (#490).
        submit: bool,
        cancelled: Arc<AtomicBool>,
        deadline: Instant,
        result: mpsc::Sender<ControlResult>,
    },
    Resize {
        id: u64,
        cols: u16,
        rows: u16,
        cancelled: Arc<AtomicBool>,
        deadline: Instant,
        result: mpsc::Sender<ControlResult>,
    },
}

pub(crate) struct PendingControlJob {
    pub id: u64,
    pub cancelled: Arc<AtomicBool>,
    pub result: Receiver<ControlResult>,
}

#[derive(Default)]
struct ActiveWorkerState {
    job_id: Option<u64>,
    #[cfg(windows)]
    thread_handle: Option<isize>,
}

struct WorkerState {
    active: Mutex<ActiveWorkerState>,
    closed: AtomicBool,
    exited: AtomicBool,
}

/// Completion acknowledgement for a worker that was faulted during bounded
/// cancellation. Owner transitions retain their permit barrier while this is
/// false, so a stuck platform call can never be mistaken for completed I/O.
#[derive(Clone)]
pub(crate) struct PtyControlCompletion {
    state: Arc<WorkerState>,
}

impl PtyControlCompletion {
    pub(crate) fn is_complete(&self) -> bool {
        self.state.exited.load(Ordering::Acquire)
    }
}

impl Default for WorkerState {
    fn default() -> Self {
        Self {
            active: Mutex::new(ActiveWorkerState::default()),
            closed: AtomicBool::new(false),
            exited: AtomicBool::new(false),
        }
    }
}

pub(crate) struct PtyControlWorker {
    sender: Mutex<Option<SyncSender<ControlJob>>>,
    next_job_id: AtomicU64,
    state: Arc<WorkerState>,
}

impl PtyControlWorker {
    pub(crate) fn spawn(
        writer: Box<dyn Write + Send>,
        master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    ) -> Result<Arc<Self>, String> {
        let (sender, receiver) = mpsc::sync_channel(PTY_CONTROL_QUEUE_CAPACITY);
        let state = Arc::new(WorkerState::default());
        let worker = Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            next_job_id: AtomicU64::new(0),
            state: Arc::clone(&state),
        });

        thread::Builder::new()
            .name("laymux-pty-control".into())
            .spawn(move || run_worker(receiver, writer, master, state))
            .map_err(|error| format!("failed to spawn PTY control worker: {error}"))?;
        Ok(worker)
    }

    pub(crate) fn submit_write(
        &self,
        data: &[u8],
        submit: bool,
        deadline: Instant,
    ) -> Result<PendingControlJob, String> {
        let id = self.next_id();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (result_tx, result_rx) = mpsc::channel();
        self.submit(ControlJob::Write {
            id,
            data: data.to_vec(),
            submit,
            cancelled: Arc::clone(&cancelled),
            deadline,
            result: result_tx,
        })?;
        Ok(PendingControlJob {
            id,
            cancelled,
            result: result_rx,
        })
    }

    pub(crate) fn submit_resize(
        &self,
        cols: u16,
        rows: u16,
        deadline: Instant,
    ) -> Result<PendingControlJob, String> {
        let id = self.next_id();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (result_tx, result_rx) = mpsc::channel();
        self.submit(ControlJob::Resize {
            id,
            cols,
            rows,
            cancelled: Arc::clone(&cancelled),
            deadline,
            result: result_tx,
        })?;
        Ok(PendingControlJob {
            id,
            cancelled,
            result: result_rx,
        })
    }

    fn next_id(&self) -> u64 {
        self.next_job_id
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1)
    }

    fn submit(&self, job: ControlJob) -> Result<(), String> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err("PTY writer already closed".into());
        }
        let sender = self.sender.lock_or_err()?;
        let Some(sender) = sender.as_ref() else {
            return Err("PTY writer already closed".into());
        };
        sender.try_send(job).map_err(|error| match error {
            TrySendError::Full(_) => "terminal control queue is busy".into(),
            TrySendError::Disconnected(_) => "PTY writer already closed".into(),
        })
    }

    /// Cancel only `job_id`. Holding `active` across the platform call prevents
    /// a completion/new-job race from cancelling the next job by mistake.
    pub(crate) fn cancel_job(&self, job_id: u64) -> bool {
        let Ok(active) = self.state.active.lock_or_err() else {
            return false;
        };
        if active.job_id != Some(job_id) {
            return false;
        }
        cancel_platform_io(&active);
        true
    }

    pub(crate) fn cancel_active(&self) {
        let Ok(active) = self.state.active.lock_or_err() else {
            return;
        };
        cancel_platform_io(&active);
    }

    pub(crate) fn close(&self) {
        self.state.closed.store(true, Ordering::Release);
        self.cancel_active();
        if let Ok(mut sender) = self.sender.lock_or_err() {
            sender.take();
        }
    }

    pub(crate) fn exited(&self) -> bool {
        self.state.exited.load(Ordering::Acquire)
    }

    pub(crate) fn completion(&self) -> PtyControlCompletion {
        PtyControlCompletion {
            state: Arc::clone(&self.state),
        }
    }
}

fn run_worker(
    receiver: Receiver<ControlJob>,
    mut writer: Box<dyn Write + Send>,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    state: Arc<WorkerState>,
) {
    install_platform_thread_handle(&state);
    while let Ok(job) = receiver.recv() {
        let (id, result_tx) = match &job {
            ControlJob::Write { id, result, .. } | ControlJob::Resize { id, result, .. } => {
                (*id, result.clone())
            }
        };
        if let Ok(mut active) = state.active.lock_or_err() {
            active.job_id = Some(id);
        }

        let result = if state.closed.load(Ordering::Acquire) {
            Err("PTY writer already closed".into())
        } else {
            execute_job(job, writer.as_mut(), &master)
        };

        if let Ok(mut active) = state.active.lock_or_err() {
            if active.job_id == Some(id) {
                active.job_id = None;
            }
        }
        let _ = result_tx.send(result);
    }
    uninstall_platform_thread_handle(&state);
    state.exited.store(true, Ordering::Release);
}

fn execute_job(
    job: ControlJob,
    writer: &mut dyn Write,
    master: &Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
) -> ControlResult {
    match job {
        ControlJob::Write {
            data,
            submit,
            cancelled,
            deadline,
            ..
        } => {
            if !data.is_empty() {
                chunked_write_to_guarded(writer, &data, || {
                    !cancelled.load(Ordering::Acquire) && Instant::now() < deadline
                })?;
            }
            if submit {
                // Emit the submit CR as its own write, gapped from the body, so
                // a TUI (Codex/Claude Code) or shell (PowerShell/PSReadLine,
                // WSL) registers a real Enter instead of folding the CR into the
                // body's bracketed paste (#490). Running the gap here on the
                // FIFO worker keeps body+CR atomic — no other write on this
                // terminal can slip between them. A lone Enter (empty body)
                // needs no gap.
                if !data.is_empty() {
                    wait_before_submit_cr(&cancelled, deadline)?;
                }
                chunked_write_to_guarded(writer, b"\r", || {
                    !cancelled.load(Ordering::Acquire) && Instant::now() < deadline
                })?;
            }
            Ok(())
        }
        ControlJob::Resize {
            cols,
            rows,
            cancelled,
            deadline,
            ..
        } => {
            ensure_job_current(&cancelled, deadline)?;
            let guard = master.lock_or_err()?;
            let master = guard
                .as_ref()
                .ok_or_else(|| "PTY master already closed".to_string())?;
            ensure_job_current(&cancelled, deadline)?;
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Resize error: {error}"))?;
            ensure_job_current(&cancelled, deadline)
        }
    }
}

/// Bounded, cancellation-aware pause before the submit CR. Splitting the CR
/// from the body lets a TUI/shell see a distinct Enter (#490); running it on the
/// FIFO worker keeps the pair atomic against other writes on this terminal.
/// Polled in small steps so an owner-epoch change or deadline aborts the CR
/// (leaving the body typed) instead of waiting out the full gap.
fn wait_before_submit_cr(cancelled: &AtomicBool, deadline: Instant) -> ControlResult {
    let poll = Duration::from_millis(PTY_CONTROL_WAIT_POLL_MS);
    let until = Instant::now() + Duration::from_millis(ENTER_SUBMIT_CR_DELAY_MS);
    while Instant::now() < until {
        ensure_job_current(cancelled, deadline)?;
        thread::sleep(poll.min(until.saturating_duration_since(Instant::now())));
    }
    ensure_job_current(cancelled, deadline)
}

fn ensure_job_current(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("terminal control operation cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("terminal control operation deadline exceeded".into());
    }
    Ok(())
}

#[cfg(windows)]
fn install_platform_thread_handle(state: &WorkerState) {
    use windows_sys::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentThread};

    let mut duplicated = std::ptr::null_mut();
    // SAFETY: all handles are owned by the current process. The duplicated
    // real handle is closed by `uninstall_platform_thread_handle`.
    let ok = unsafe {
        let process = GetCurrentProcess();
        DuplicateHandle(
            process,
            GetCurrentThread(),
            process,
            &mut duplicated,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok != 0 {
        if let Ok(mut active) = state.active.lock_or_err() {
            active.thread_handle = Some(duplicated as isize);
        }
    }
}

#[cfg(not(windows))]
fn install_platform_thread_handle(_state: &WorkerState) {}

#[cfg(windows)]
fn uninstall_platform_thread_handle(state: &WorkerState) {
    use windows_sys::Win32::Foundation::CloseHandle;
    let handle = state
        .active
        .lock_or_err()
        .ok()
        .and_then(|mut active| active.thread_handle.take());
    if let Some(handle) = handle {
        // SAFETY: this is the real handle created by DuplicateHandle above.
        unsafe {
            CloseHandle(handle as _);
        }
    }
}

#[cfg(not(windows))]
fn uninstall_platform_thread_handle(_state: &WorkerState) {}

#[cfg(windows)]
fn cancel_platform_io(active: &ActiveWorkerState) {
    use windows_sys::Win32::System::IO::CancelSynchronousIo;
    if let Some(handle) = active.thread_handle {
        // SAFETY: the handle is held stable by the `active` mutex and targets
        // only this worker thread. ERROR_NOT_FOUND means no I/O is pending.
        unsafe {
            CancelSynchronousIo(handle as _);
        }
    }
}

#[cfg(not(windows))]
fn cancel_platform_io(_active: &ActiveWorkerState) {}

#[cfg(test)]
mod tests;
