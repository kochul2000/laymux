use crate::{
    InterruptiblePtyReader, InterruptiblePtyReaderControl, InterruptiblePtyReaderPair,
    PtyReadEvent, PtyWakeOutcome,
};
use filedescriptor::FileDescriptor;
use std::io::{self, Read};
#[cfg(test)]
use std::os::windows::io::AsRawHandle;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use winapi::shared::minwindef::{FALSE, TRUE};
use winapi::shared::winerror::{ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED};
use winapi::um::handleapi::CloseHandle;
use winapi::um::ioapiset::CancelSynchronousIo;
#[cfg(test)]
use winapi::um::namedpipeapi::PeekNamedPipe;
use winapi::um::processthreadsapi::{GetCurrentThreadId, OpenThread};
use winapi::um::winnt::{HANDLE, THREAD_TERMINATE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakePhase {
    Pending,
    Acked,
    Released,
}

struct WakeRequest {
    generation: u64,
    target_read_epoch: u64,
    phase: WakePhase,
    cancellation_started: bool,
    cancellation_returned: bool,
    abort: bool,
}

struct State {
    reader_handle: Option<ThreadHandle>,
    reader_thread_id: Option<u32>,
    read_epoch: u64,
    reading: bool,
    terminal: bool,
    highest_requested: u64,
    completed_through: u64,
    active: Option<WakeRequest>,
}

struct Shared {
    terminal_generation: u64,
    state: Mutex<State>,
    changed: Condvar,
}

pub(super) fn new_pair(
    readable: FileDescriptor,
    terminal_generation: u64,
) -> InterruptiblePtyReaderPair {
    new_pair_with_cancel(readable, terminal_generation, Arc::new(SystemCancelIo))
}

fn new_pair_with_cancel(
    readable: FileDescriptor,
    terminal_generation: u64,
    cancel_io: Arc<dyn CancelIo>,
) -> InterruptiblePtyReaderPair {
    new_pair_with_cancel_and_shared(readable, terminal_generation, cancel_io).0
}

fn new_pair_with_cancel_and_shared(
    readable: FileDescriptor,
    terminal_generation: u64,
    cancel_io: Arc<dyn CancelIo>,
) -> (InterruptiblePtyReaderPair, Arc<Shared>) {
    #[cfg(test)]
    let output_probe = readable.try_clone().ok();
    let shared = Arc::new(Shared {
        terminal_generation,
        state: Mutex::new(State {
            reader_handle: None,
            reader_thread_id: None,
            read_epoch: 0,
            reading: false,
            terminal: false,
            highest_requested: 0,
            completed_through: 0,
            active: None,
        }),
        changed: Condvar::new(),
    });
    let pair = InterruptiblePtyReaderPair {
        reader: Box::new(WindowsReader {
            readable,
            shared: Arc::clone(&shared),
            fused: false,
        }),
        control: Box::new(WindowsControl {
            shared: Arc::clone(&shared),
            cancel_io,
            #[cfg(test)]
            output_probe: Mutex::new(output_probe),
        }),
    };
    (pair, shared)
}

struct ThreadHandle(HANDLE);

// SAFETY: this is a real process handle from `OpenThread`, not a pseudo
// handle. Windows kernel handles may be used from other threads; access and
// close ownership remain synchronized by `Shared::state` and this wrapper.
unsafe impl Send for ThreadHandle {}
// SAFETY: concurrent access is restricted to read-only API use while the
// owning wrapper stays alive under `Shared::state`.
unsafe impl Sync for ThreadHandle {}

impl Drop for ThreadHandle {
    fn drop(&mut self) {
        // SAFETY: `ThreadHandle` exclusively owns the non-null handle returned
        // by `OpenThread`, and Drop runs exactly once for that ownership.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct WindowsControl {
    shared: Arc<Shared>,
    cancel_io: Arc<dyn CancelIo>,
    #[cfg(test)]
    output_probe: Mutex<Option<FileDescriptor>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancelAttempt {
    Issued,
    NotFound,
}

trait CancelIo: Send + Sync {
    fn cancel(&self, thread_handle: HANDLE) -> io::Result<CancelAttempt>;
}

struct SystemCancelIo;

impl CancelIo for SystemCancelIo {
    fn cancel(&self, thread_handle: HANDLE) -> io::Result<CancelAttempt> {
        // SAFETY: callers copy this real handle while holding `Shared::state`;
        // the owning `ThreadHandle` cannot be removed or dropped until after
        // this call returns. It identifies the dedicated PTY reader thread.
        let cancelled = unsafe { CancelSynchronousIo(thread_handle) };
        if cancelled == TRUE {
            return Ok(CancelAttempt::Issued);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
            Ok(CancelAttempt::NotFound)
        } else {
            Err(error)
        }
    }
}

impl InterruptiblePtyReaderControl for WindowsControl {
    fn terminal_generation(&self) -> u64 {
        self.shared.terminal_generation
    }

    fn wake(
        &self,
        terminal_generation: u64,
        wake_generation: u64,
        timeout: Duration,
    ) -> io::Result<PtyWakeOutcome> {
        if terminal_generation != self.shared.terminal_generation {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "stale PTY terminal generation",
            ));
        }
        let deadline = Instant::now() + timeout;
        let (thread_handle, should_cancel, owns_request) = loop {
            let mut state = lock_state(&self.shared)?;
            if state.terminal {
                return Ok(PtyWakeOutcome::Terminal);
            }
            if wake_generation == 0 || wake_generation < state.highest_requested {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "stale PTY wake generation",
                ));
            }
            if wake_generation == state.completed_through {
                return Ok(PtyWakeOutcome::Acked);
            }
            if let Some(active) = state.active.as_ref() {
                if active.generation == wake_generation {
                    break (None, false, false);
                }
                state = wait_changed(&self.shared, state, deadline)?;
                drop(state);
                continue;
            }

            state.highest_requested = wake_generation;
            let should_cancel = state.reading;
            let target_read_epoch = state.read_epoch + u64::from(!state.reading);
            let thread_handle = state.reader_handle.as_ref().map(|handle| handle.0);
            state.active = Some(WakeRequest {
                generation: wake_generation,
                target_read_epoch,
                phase: WakePhase::Pending,
                cancellation_started: should_cancel,
                cancellation_returned: !should_cancel,
                abort: false,
            });
            self.shared.changed.notify_all();
            break (thread_handle, should_cancel, true);
        };

        if owns_request && should_cancel {
            let handle = thread_handle.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotConnected,
                    "PTY reader thread is not registered",
                )
            })?;
            loop {
                if Instant::now() >= deadline {
                    abort_active_wake(&self.shared, wake_generation);
                    return Err(wake_timeout());
                }
                let mut state = lock_state(&self.shared)?;
                let reader_parked = state.terminal
                    || wake_generation <= state.completed_through
                    || state.active.as_ref().is_some_and(|active| {
                        active.generation == wake_generation && active.phase == WakePhase::Acked
                    });
                if reader_parked || !state.reading {
                    if let Some(active) = state.active.as_mut() {
                        if active.generation == wake_generation {
                            active.cancellation_returned = true;
                        }
                    }
                    self.shared.changed.notify_all();
                    break;
                }

                // Hold the adapter state mutex across the cancellation call.
                // The reader cannot publish reading=false (and proceed to any
                // non-read work) between our last admission check and this
                // thread-wide API. CancelSynchronousIo itself does not wait for
                // I/O completion, so this does not deadlock the reader.
                match self.cancel_io.cancel(handle) {
                    Ok(CancelAttempt::Issued) => {
                        if let Some(active) = state.active.as_mut() {
                            if active.generation == wake_generation {
                                active.cancellation_returned = true;
                            }
                        }
                        self.shared.changed.notify_all();
                        break;
                    }
                    Ok(CancelAttempt::NotFound) => {}
                    Err(error) => {
                        if let Some(active) = state.active.as_mut() {
                            if active.generation == wake_generation {
                                active.cancellation_returned = true;
                                active.abort = true;
                            }
                        }
                        self.shared.changed.notify_all();
                        return Err(error);
                    }
                }

                // ERROR_NOT_FOUND is not acknowledgement. It can occur in the
                // published-reading -> actual ReadFile admission gap. Retry
                // until the reader parks/data/terminal wins or the deadline
                // forces generation teardown.
                drop(state);
                thread::sleep(Duration::from_millis(1));
            }
        }

        wait_for_accepted_resolution(&self.shared, wake_generation, deadline)
    }

    #[cfg(test)]
    fn output_empty_for_test(&self) -> io::Result<bool> {
        let probe = self
            .output_probe
            .lock()
            .map_err(|_| poisoned("interruptible PTY output probe"))?;
        let probe = probe.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "interruptible PTY output probe is unavailable",
            )
        })?;
        let mut available = 0u32;
        // SAFETY: the mutex keeps the cloned pipe handle alive. No output
        // buffer is requested; `available` is valid writable storage for the
        // byte count and all optional pointers are null as documented.
        let peeked = unsafe {
            PeekNamedPipe(
                probe.as_raw_handle().cast(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if peeked == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(available == 0)
        }
    }

    #[cfg(test)]
    fn inject_failure_for_test(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(wake_timeout());
            }
            let state = lock_state(&self.shared)?;
            if state.terminal {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "PTY reader terminated before fault injection",
                ));
            }
            let handle = if state.reading {
                state.reader_handle.as_ref().map(|handle| handle.0)
            } else {
                None
            };
            if let Some(handle) = handle {
                match self.cancel_io.cancel(handle)? {
                    CancelAttempt::Issued => return Ok(()),
                    CancelAttempt::NotFound => {
                        drop(state);
                        thread::sleep(Duration::from_millis(1));
                    }
                }
            } else {
                let state = wait_changed(&self.shared, state, deadline)?;
                drop(state);
            }
        }
    }
}

/// Resolve a wake call that has already passed the admission check. A later
/// generation may complete before this waiter is scheduled again, so this
/// path deliberately uses the monotonic completion ledger (`<=`). Fresh
/// admissions still reject generations below `highest_requested` in `wake`.
fn wait_for_accepted_resolution(
    shared: &Shared,
    wake_generation: u64,
    deadline: Instant,
) -> io::Result<PtyWakeOutcome> {
    let mut state = lock_state(shared)?;
    loop {
        if state.terminal {
            return Ok(PtyWakeOutcome::Terminal);
        }
        if wake_generation <= state.completed_through {
            return Ok(PtyWakeOutcome::Acked);
        }
        let Some(active) = state.active.as_mut() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "PTY wake disappeared before completion",
            ));
        };
        if active.generation != wake_generation {
            state = wait_changed(shared, state, deadline)?;
            continue;
        }
        if active.phase == WakePhase::Acked && active.cancellation_returned {
            // Every already-started cancel call has returned. Posting
            // Release now is what prevents a late cancel from hitting the
            // next read epoch.
            active.phase = WakePhase::Released;
            shared.changed.notify_all();
        }
        match wait_changed(shared, state, deadline) {
            Ok(next) => state = next,
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                let mut state = lock_state(shared)?;
                if let Some(active) = state.active.as_mut() {
                    if active.generation == wake_generation {
                        active.abort = true;
                    }
                }
                shared.changed.notify_all();
                return Err(error);
            }
            Err(error) => return Err(error),
        }
    }
}

struct WindowsReader {
    readable: FileDescriptor,
    shared: Arc<Shared>,
    fused: bool,
}

impl InterruptiblePtyReader for WindowsReader {
    fn read_event(&mut self) -> PtyReadEvent {
        if self.fused {
            return PtyReadEvent::Eof;
        }
        let read_epoch = match self.prepare_read() {
            Ok(PrepareRead::Wake(generation)) => return PtyReadEvent::Wake(generation),
            Ok(PrepareRead::Read(epoch)) => epoch,
            Err(error) => return self.failure(error),
        };
        let mut bytes = vec![0u8; 4096];
        match self.readable.read(&mut bytes) {
            Ok(0) => self.eof(),
            Ok(count) => {
                if let Err(error) = self.finish_data_read(read_epoch) {
                    return self.failure(error);
                }
                bytes.truncate(count);
                PtyReadEvent::Data(bytes)
            }
            Err(error) if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) => {
                match self.finish_cancelled_read(read_epoch) {
                    Ok(Some(generation)) => PtyReadEvent::Wake(generation),
                    Ok(None) => self.failure(io::Error::other(
                        "unowned ERROR_OPERATION_ABORTED from PTY reader",
                    )),
                    Err(error) => self.failure(error),
                }
            }
            Err(error) => self.failure(error),
        }
    }
}

enum PrepareRead {
    Read(u64),
    Wake(u64),
}

impl WindowsReader {
    fn prepare_read(&mut self) -> io::Result<PrepareRead> {
        let mut state = lock_state(&self.shared)?;
        // SAFETY: this takes no arguments and returns the caller's thread id.
        let current_thread_id = unsafe { GetCurrentThreadId() };
        if state
            .reader_thread_id
            .is_some_and(|registered| registered != current_thread_id)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "interruptible PTY reader moved to another OS thread",
            ));
        }
        if state.reader_handle.is_none() {
            // OpenThread yields a real HANDLE to this exact dedicated reader
            // thread; a GetCurrentThread pseudo handle is never shared.
            // SAFETY: `current_thread_id` came from this live thread. Null is
            // checked before ownership is transferred to `ThreadHandle`.
            let handle = unsafe { OpenThread(THREAD_TERMINATE, FALSE, current_thread_id) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            state.reader_handle = Some(ThreadHandle(handle));
            state.reader_thread_id = Some(current_thread_id);
            self.shared.changed.notify_all();
        }
        let (mut state, wake) = park_and_release(&self.shared, state, None)?;
        if let Some(generation) = wake {
            return Ok(PrepareRead::Wake(generation));
        }
        if state.terminal {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "PTY reader terminated",
            ));
        }
        state.read_epoch += 1;
        state.reading = true;
        Ok(PrepareRead::Read(state.read_epoch))
    }

    fn finish_data_read(&self, read_epoch: u64) -> io::Result<()> {
        let mut state = lock_state(&self.shared)?;
        if state.read_epoch != read_epoch {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "PTY read epoch changed",
            ));
        }
        state.reading = false;
        self.shared.changed.notify_all();
        Ok(())
    }

    fn finish_cancelled_read(&self, read_epoch: u64) -> io::Result<Option<u64>> {
        let mut state = lock_state(&self.shared)?;
        state.reading = false;
        let (_state, wake) = park_and_release(&self.shared, state, Some(read_epoch))?;
        Ok(wake)
    }

    fn eof(&mut self) -> PtyReadEvent {
        self.mark_terminal();
        PtyReadEvent::Eof
    }

    fn failure(&mut self, error: io::Error) -> PtyReadEvent {
        self.mark_terminal();
        PtyReadEvent::Failure(error)
    }

    fn mark_terminal(&mut self) {
        self.fused = true;
        if let Ok(mut state) = self.shared.state.lock() {
            state.reading = false;
            state.terminal = true;
            state.active = None;
        }
        self.shared.changed.notify_all();
    }
}

impl Drop for WindowsReader {
    fn drop(&mut self) {
        self.mark_terminal();
    }
}

fn park_and_release<'a>(
    shared: &'a Shared,
    mut state: MutexGuard<'a, State>,
    completed_epoch: Option<u64>,
) -> io::Result<(MutexGuard<'a, State>, Option<u64>)> {
    let Some(active) = state.active.as_mut() else {
        return Ok((state, None));
    };
    if let Some(epoch) = completed_epoch {
        if !active.cancellation_started || active.target_read_epoch != epoch {
            return Ok((state, None));
        }
    }
    if active.abort {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "interruptible PTY wake aborted; teardown required",
        ));
    }
    active.phase = WakePhase::Acked;
    shared.changed.notify_all();
    while state
        .active
        .as_ref()
        .is_some_and(|request| request.phase != WakePhase::Released && !request.abort)
        && !state.terminal
    {
        state = shared
            .changed
            .wait(state)
            .map_err(|_| poisoned("interruptible PTY reader state"))?;
    }
    if state.terminal {
        return Ok((state, None));
    }
    if state.active.as_ref().is_some_and(|request| request.abort) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "interruptible PTY wake aborted; teardown required",
        ));
    }
    let generation = state
        .active
        .take()
        .map(|request| request.generation)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "PTY wake state disappeared"))?;
    state.completed_through = generation;
    shared.changed.notify_all();
    Ok((state, Some(generation)))
}

fn lock_state(shared: &Shared) -> io::Result<MutexGuard<'_, State>> {
    shared
        .state
        .lock()
        .map_err(|_| poisoned("interruptible PTY reader state"))
}

fn abort_active_wake(shared: &Shared, wake_generation: u64) {
    if let Ok(mut state) = shared.state.lock() {
        if let Some(active) = state.active.as_mut() {
            if active.generation == wake_generation {
                active.abort = true;
            }
        }
    }
    shared.changed.notify_all();
}

fn wait_changed<'a>(
    shared: &'a Shared,
    state: MutexGuard<'a, State>,
    deadline: Instant,
) -> io::Result<MutexGuard<'a, State>> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(wake_timeout());
    }
    let (state, result) = shared
        .changed
        .wait_timeout(state, remaining)
        .map_err(|_| poisoned("interruptible PTY reader state"))?;
    if result.timed_out() {
        Err(wake_timeout())
    } else {
        Ok(state)
    }
}

fn wake_timeout() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "interruptible PTY wake acknowledgement timed out",
    )
}

fn poisoned(name: &str) -> io::Error {
    io::Error::other(format!("{name} is poisoned"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NotFoundThenIssued {
        calls: AtomicUsize,
    }

    struct BlockingNotFound {
        entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl CancelIo for BlockingNotFound {
        fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
            }
            self.release.lock().unwrap().recv().unwrap();
            Ok(CancelAttempt::NotFound)
        }
    }

    impl CancelIo for NotFoundThenIssued {
        fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            Ok(if call == 0 {
                CancelAttempt::NotFound
            } else {
                CancelAttempt::Issued
            })
        }
    }

    struct WriteDataThenIssued(Mutex<Option<FileDescriptor>>);

    impl CancelIo for WriteDataThenIssued {
        fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
            self.0
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .write_all(b"data-wins")?;
            // This deterministic seam models CancelSynchronousIo returning
            // after the read has already completed with data.
            Ok(CancelAttempt::Issued)
        }
    }

    #[test]
    fn completed_native_data_is_delivered_before_the_racing_wake() {
        let pipe = filedescriptor::Pipe::new().unwrap();
        let cancel = Arc::new(WriteDataThenIssued(Mutex::new(Some(pipe.write))));
        let (pair, shared) = new_pair_with_cancel_and_shared(pipe.read, 31, cancel);
        let InterruptiblePtyReaderPair { reader, control } = pair;
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(control);
        let (events_tx, events_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut reader = reader;
            events_tx
                .send([reader.read_event(), reader.read_event()])
                .unwrap();
            release_rx.recv().unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !shared.state.lock().unwrap().reading {
            assert!(Instant::now() < deadline, "reader did not enter ReadFile");
            thread::yield_now();
        }

        assert_eq!(
            control.wake(31, 1, Duration::from_secs(1)).unwrap(),
            PtyWakeOutcome::Acked
        );
        let events = events_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(&events[0], PtyReadEvent::Data(bytes) if bytes == b"data-wins"));
        assert!(matches!(events[1], PtyReadEvent::Wake(1)));
        release_tx.send(()).unwrap();
        reader_thread.join().unwrap();
    }

    #[test]
    fn wake_before_read_and_consecutive_generations_use_the_real_state_machine() {
        let pipe = filedescriptor::Pipe::new().unwrap();
        let (pair, shared) =
            new_pair_with_cancel_and_shared(pipe.read, 32, Arc::new(MustNeverCancel));
        let InterruptiblePtyReaderPair {
            mut reader,
            control,
        } = pair;
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(control);

        for generation in [1, 2] {
            let waiter_control = Arc::clone(&control);
            let waiter =
                thread::spawn(move || waiter_control.wake(32, generation, Duration::from_secs(1)));
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let admitted = shared
                    .state
                    .lock()
                    .unwrap()
                    .active
                    .as_ref()
                    .is_some_and(|active| active.generation == generation);
                if admitted {
                    break;
                }
                assert!(Instant::now() < deadline, "wake was not admitted");
                thread::yield_now();
            }
            assert!(
                matches!(reader.read_event(), PtyReadEvent::Wake(observed) if observed == generation)
            );
            assert_eq!(waiter.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        }
        drop(pipe.write);
    }

    #[test]
    fn not_found_is_retried_and_release_waits_for_reader_ack() {
        // SAFETY: the current test thread is live; null is checked and the
        // returned real handle is immediately transferred to `ThreadHandle`.
        let thread_handle = unsafe { OpenThread(THREAD_TERMINATE, FALSE, GetCurrentThreadId()) };
        assert!(!thread_handle.is_null());
        let shared = Arc::new(Shared {
            terminal_generation: 41,
            state: Mutex::new(State {
                reader_handle: Some(ThreadHandle(thread_handle)),
                // SAFETY: no arguments; records this live test thread's id.
                reader_thread_id: Some(unsafe { GetCurrentThreadId() }),
                read_epoch: 7,
                reading: true,
                terminal: false,
                highest_requested: 0,
                completed_through: 0,
                active: None,
            }),
            changed: Condvar::new(),
        });
        let cancel = Arc::new(NotFoundThenIssued {
            calls: AtomicUsize::new(0),
        });
        let control = Arc::new(WindowsControl {
            shared: Arc::clone(&shared),
            cancel_io: cancel.clone(),
            output_probe: Mutex::new(None),
        });
        let worker = {
            let control = Arc::clone(&control);
            thread::spawn(move || control.wake(41, 1, Duration::from_secs(1)))
        };

        let deadline = Instant::now() + Duration::from_secs(1);
        while cancel.calls.load(Ordering::Acquire) < 2 {
            assert!(Instant::now() < deadline, "cancel retry was not observed");
            thread::yield_now();
        }
        let mut state = shared.state.lock().unwrap();
        assert_eq!(state.active.as_ref().unwrap().phase, WakePhase::Pending);
        state.reading = false;
        state.active.as_mut().unwrap().phase = WakePhase::Acked;
        shared.changed.notify_all();
        while state.active.as_ref().unwrap().phase != WakePhase::Released {
            state = shared.changed.wait(state).unwrap();
        }
        let generation = state.active.take().unwrap().generation;
        state.completed_through = generation;
        shared.changed.notify_all();
        drop(state);

        assert_eq!(worker.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        assert_eq!(cancel.calls.load(Ordering::Acquire), 2);
        // A duplicate after completion shares the ledger and never starts a
        // fresh thread-wide cancellation.
        assert_eq!(
            control.wake(41, 1, Duration::from_millis(1)).unwrap(),
            PtyWakeOutcome::Acked
        );
        assert_eq!(cancel.calls.load(Ordering::Acquire), 2);
    }

    #[test]
    fn terminal_event_discards_pending_wake_and_fuses_reader() {
        let pipe = filedescriptor::Pipe::new().unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (pair, shared) = new_pair_with_cancel_and_shared(
            pipe.read,
            52,
            Arc::new(BlockingNotFound {
                entered: Mutex::new(Some(entered_tx)),
                release: Mutex::new(release_rx),
            }),
        );
        let InterruptiblePtyReaderPair { reader, control } = pair;
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(control);
        let reader_thread = thread::spawn(move || {
            let mut reader = reader;
            let terminal = reader.read_event();
            let fused = reader.read_event();
            (terminal, fused)
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !shared.state.lock().unwrap().reading {
            assert!(Instant::now() < deadline, "reader did not enter ReadFile");
            thread::yield_now();
        }
        let wake_thread = {
            let control = Arc::clone(&control);
            thread::spawn(move || control.wake(52, 1, Duration::from_secs(1)))
        };

        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        // The wake is pending while the real pipe read becomes terminal.
        drop(pipe.write);
        release_tx.send(()).unwrap();

        let (terminal, fused) = reader_thread.join().unwrap();
        assert!(matches!(
            terminal,
            PtyReadEvent::Eof | PtyReadEvent::Failure(_)
        ));
        assert!(matches!(fused, PtyReadEvent::Eof));
        assert_eq!(
            wake_thread.join().unwrap().unwrap(),
            PtyWakeOutcome::Terminal
        );
    }

    #[test]
    fn next_read_is_not_admitted_until_cancel_is_quiesced_and_release_is_posted() {
        struct MustNotCancel;
        impl CancelIo for MustNotCancel {
            fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
                panic!("duplicate waiter must not start another cancel call")
            }
        }

        let pipe = filedescriptor::Pipe::new().unwrap();
        let filedescriptor::Pipe {
            read: pipe_read,
            write: pipe_write,
        } = pipe;
        let shared = Arc::new(Shared {
            terminal_generation: 61,
            state: Mutex::new(State {
                reader_handle: None,
                reader_thread_id: None,
                read_epoch: 0,
                reading: false,
                terminal: false,
                highest_requested: 1,
                completed_through: 0,
                active: Some(WakeRequest {
                    generation: 1,
                    target_read_epoch: 1,
                    phase: WakePhase::Acked,
                    cancellation_started: true,
                    cancellation_returned: false,
                    abort: false,
                }),
            }),
            changed: Condvar::new(),
        });
        let control = Arc::new(WindowsControl {
            shared: Arc::clone(&shared),
            cancel_io: Arc::new(MustNotCancel),
            output_probe: Mutex::new(None),
        });
        let reader_shared = Arc::clone(&shared);
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let (reader_release_tx, reader_release_rx) = std::sync::mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut reader = WindowsReader {
                readable: pipe_read,
                shared: reader_shared,
                fused: false,
            };
            let wake = reader.prepare_read().unwrap();
            let next = reader.prepare_read().unwrap();
            result_tx.send((wake, next)).unwrap();
            reader_release_rx.recv().unwrap();
        });
        let waiter = {
            let control = Arc::clone(&control);
            thread::spawn(move || control.wake(61, 1, Duration::from_secs(1)))
        };

        thread::sleep(Duration::from_millis(20));
        {
            let state = shared.state.lock().unwrap();
            assert_eq!(state.read_epoch, 0, "next read admitted before Release");
            assert_eq!(state.active.as_ref().unwrap().phase, WakePhase::Acked);
        }
        {
            let mut state = shared.state.lock().unwrap();
            state.active.as_mut().unwrap().cancellation_returned = true;
            shared.changed.notify_all();
        }

        let (wake, next) = result_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(wake, PrepareRead::Wake(1)));
        assert!(matches!(next, PrepareRead::Read(1)));
        assert_eq!(waiter.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        reader_release_tx.send(()).unwrap();
        reader_thread.join().unwrap();
        drop(pipe_write);
    }

    #[test]
    fn zero_and_lower_completed_generations_are_rejected() {
        let shared = Arc::new(Shared {
            terminal_generation: 71,
            state: Mutex::new(State {
                reader_handle: None,
                reader_thread_id: None,
                read_epoch: 0,
                reading: false,
                terminal: false,
                highest_requested: 2,
                completed_through: 2,
                active: None,
            }),
            changed: Condvar::new(),
        });
        let control = WindowsControl {
            shared,
            cancel_io: Arc::new(MustNeverCancel),
            output_probe: Mutex::new(None),
        };
        assert_eq!(
            control
                .wake(71, 0, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            control
                .wake(71, 1, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            control.wake(71, 2, Duration::from_millis(1)).unwrap(),
            PtyWakeOutcome::Acked
        );
    }

    #[test]
    fn accepted_waiter_observes_ack_after_a_higher_generation_completes() {
        let shared = Arc::new(Shared {
            terminal_generation: 72,
            state: Mutex::new(State {
                reader_handle: None,
                reader_thread_id: None,
                read_epoch: 2,
                reading: false,
                terminal: false,
                highest_requested: 2,
                completed_through: 2,
                active: None,
            }),
            changed: Condvar::new(),
        });

        // This helper is only entered after admission. It models generation 1
        // being descheduled until the reader has completed generations 1 and
        // 2, and therefore must consult the monotonic completion ledger.
        assert_eq!(
            wait_for_accepted_resolution(&shared, 1, Instant::now() + Duration::from_millis(1),)
                .unwrap(),
            PtyWakeOutcome::Acked
        );

        // The same number presented as a fresh admission remains stale.
        let control = WindowsControl {
            shared,
            cancel_io: Arc::new(MustNeverCancel),
            output_probe: Mutex::new(None),
        };
        assert_eq!(
            control
                .wake(72, 1, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    struct MustNeverCancel;
    impl CancelIo for MustNeverCancel {
        fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
            panic!("cancel must not be called")
        }
    }

    struct ErrorCancel;
    impl CancelIo for ErrorCancel {
        fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected cancel failure",
            ))
        }
    }

    struct AlwaysNotFound;
    impl CancelIo for AlwaysNotFound {
        fn cancel(&self, _thread_handle: HANDLE) -> io::Result<CancelAttempt> {
            Ok(CancelAttempt::NotFound)
        }
    }

    fn reading_shared(generation: u64) -> Arc<Shared> {
        // SAFETY: the current test thread is live; null is checked and the
        // returned real handle is immediately transferred to `ThreadHandle`.
        let handle = unsafe { OpenThread(THREAD_TERMINATE, FALSE, GetCurrentThreadId()) };
        assert!(!handle.is_null());
        Arc::new(Shared {
            terminal_generation: generation,
            state: Mutex::new(State {
                reader_handle: Some(ThreadHandle(handle)),
                // SAFETY: no arguments; records this live test thread's id.
                reader_thread_id: Some(unsafe { GetCurrentThreadId() }),
                read_epoch: 1,
                reading: true,
                terminal: false,
                highest_requested: 0,
                completed_through: 0,
                active: None,
            }),
            changed: Condvar::new(),
        })
    }

    fn assert_aborted_wake_becomes_one_fused_reader_failure(shared: Arc<Shared>) {
        let pipe = filedescriptor::Pipe::new().unwrap();
        let mut reader = WindowsReader {
            readable: pipe.read,
            shared: Arc::clone(&shared),
            fused: false,
        };
        assert!(matches!(reader.read_event(), PtyReadEvent::Failure(_)));
        assert!(matches!(reader.read_event(), PtyReadEvent::Eof));
        let state = shared.state.lock().unwrap();
        assert!(state.terminal);
        assert!(state.active.is_none());
        drop(pipe.write);
    }

    #[test]
    fn cancel_failure_and_ack_deadline_abort_without_release() {
        let failed_shared = reading_shared(81);
        let failed = WindowsControl {
            shared: Arc::clone(&failed_shared),
            cancel_io: Arc::new(ErrorCancel),
            output_probe: Mutex::new(None),
        };
        assert_eq!(
            failed
                .wake(81, 1, Duration::from_millis(50))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        let state = failed_shared.state.lock().unwrap();
        assert!(state.active.as_ref().unwrap().abort);
        assert_ne!(state.active.as_ref().unwrap().phase, WakePhase::Released);
        drop(state);
        assert_aborted_wake_becomes_one_fused_reader_failure(failed_shared);

        let timeout_shared = reading_shared(82);
        let timed_out = WindowsControl {
            shared: Arc::clone(&timeout_shared),
            cancel_io: Arc::new(AlwaysNotFound),
            output_probe: Mutex::new(None),
        };
        assert_eq!(
            timed_out
                .wake(82, 1, Duration::from_millis(20))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        let state = timeout_shared.state.lock().unwrap();
        assert!(state.active.as_ref().unwrap().abort);
        assert_ne!(state.active.as_ref().unwrap().phase, WakePhase::Released);
        drop(state);
        assert_aborted_wake_becomes_one_fused_reader_failure(timeout_shared);
    }
}
