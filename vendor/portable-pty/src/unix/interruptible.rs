use crate::{
    InterruptiblePtyReader, InterruptiblePtyReaderControl, InterruptiblePtyReaderPair,
    PtyReadEvent, PtyWakeOutcome,
};
use filedescriptor::FileDescriptor;
use std::collections::VecDeque;
use std::io;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

struct State {
    queue: VecDeque<u64>,
    highest_requested: u64,
    completed_through: u64,
    terminal: bool,
}

struct Shared {
    terminal_generation: u64,
    state: Mutex<State>,
    changed: Condvar,
}

pub(super) fn new_pair(
    pty: FileDescriptor,
    terminal_generation: u64,
) -> io::Result<InterruptiblePtyReaderPair> {
    new_pair_with_shared(pty, terminal_generation).map(|(pair, _)| pair)
}

fn new_pair_with_shared(
    pty: FileDescriptor,
    terminal_generation: u64,
) -> io::Result<(InterruptiblePtyReaderPair, Arc<Shared>)> {
    #[cfg(test)]
    let output_probe = pty.try_clone().map_err(io::Error::other)?;
    let mut fds = [-1; 2];
    // SAFETY: `fds` points to storage for exactly two descriptors. On success
    // both are immediately transferred to owning `FileDescriptor` values.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful pipe2 returned two newly-owned descriptors.
    let wake_read = unsafe { FileDescriptor::from_raw_fd(fds[0]) };
    let wake_write = unsafe { FileDescriptor::from_raw_fd(fds[1]) };
    let shared = Arc::new(Shared {
        terminal_generation,
        state: Mutex::new(State {
            queue: VecDeque::new(),
            highest_requested: 0,
            completed_through: 0,
            terminal: false,
        }),
        changed: Condvar::new(),
    });
    let pair = InterruptiblePtyReaderPair {
        reader: Box::new(UnixReader {
            pty,
            wake_read,
            shared: Arc::clone(&shared),
            fused: false,
            wake_batch_ready: false,
        }),
        control: Box::new(UnixControl {
            wake_write: Mutex::new(Some(wake_write)),
            shared: Arc::clone(&shared),
            #[cfg(test)]
            output_probe: Mutex::new(output_probe),
        }),
    };
    Ok((pair, shared))
}

struct UnixControl {
    wake_write: Mutex<Option<FileDescriptor>>,
    shared: Arc<Shared>,
    #[cfg(test)]
    output_probe: Mutex<FileDescriptor>,
}

impl InterruptiblePtyReaderControl for UnixControl {
    fn terminal_generation(&self) -> u64 {
        self.shared.terminal_generation
    }

    fn wake(
        &self,
        terminal_generation: u64,
        wake_generation: u64,
        timeout: Duration,
    ) -> io::Result<PtyWakeOutcome> {
        validate_terminal_generation(&self.shared, terminal_generation)?;
        let should_signal = {
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
            if wake_generation == state.highest_requested {
                false
            } else {
                state.highest_requested = wake_generation;
                state.queue.push_back(wake_generation);
                true
            }
        };
        if should_signal {
            if let Err(error) = signal_wake(&self.wake_write) {
                mark_terminal(&self.shared);
                return Err(error);
            }
        }
        wait_for_resolution(&self.shared, wake_generation, timeout)
    }

    #[cfg(test)]
    fn output_empty_for_test(&self) -> io::Result<bool> {
        let probe = self
            .output_probe
            .lock()
            .map_err(|_| poisoned("interruptible PTY output probe"))?;
        let mut poll_fd = libc::pollfd {
            fd: probe.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
            revents: 0,
        };
        // SAFETY: `poll_fd` is live mutable storage for one entry and the
        // mutex keeps its owned descriptor alive for the duration of poll.
        let result = unsafe { libc::poll(&mut poll_fd, 1, 0) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result == 0)
        }
    }

    #[cfg(test)]
    fn inject_failure_for_test(&self, _timeout: Duration) -> io::Result<()> {
        let writer = self
            .wake_write
            .lock()
            .map_err(|_| poisoned("interruptible PTY wake descriptor"))?
            .take()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "interruptible PTY fault already injected",
                )
            })?;
        drop(writer);
        Ok(())
    }
}

fn wait_for_resolution(
    shared: &Shared,
    wake_generation: u64,
    timeout: Duration,
) -> io::Result<PtyWakeOutcome> {
    let deadline = Instant::now() + timeout;
    let mut state = lock_state(shared)?;
    loop {
        if state.terminal {
            return Ok(PtyWakeOutcome::Terminal);
        }
        if wake_generation <= state.completed_through {
            return Ok(PtyWakeOutcome::Acked);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(wake_timeout());
        }
        let (next, result) = shared
            .changed
            .wait_timeout(state, remaining)
            .map_err(|_| poisoned("interruptible PTY wake state"))?;
        state = next;
        if result.timed_out() && !state.terminal && wake_generation > state.completed_through {
            return Err(wake_timeout());
        }
    }
}

fn signal_wake(wake_write: &Mutex<Option<FileDescriptor>>) -> io::Result<()> {
    let writer = wake_write
        .lock()
        .map_err(|_| poisoned("interruptible PTY wake descriptor"))?;
    let writer = writer.as_ref().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            "interruptible PTY wake descriptor is closed",
        )
    })?;
    loop {
        let byte = [1u8];
        // SAFETY: the mutex keeps the owned descriptor alive for this call,
        // and `byte` is a readable one-byte buffer for the supplied length.
        let written = unsafe {
            libc::write(
                writer.as_raw_fd(),
                byte.as_ptr().cast(),
                byte.len() as libc::size_t,
            )
        };
        if written == 1 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        // The queue is the generation SoT. A full pipe is already readable,
        // so coalescing this notification cannot lose a generation.
        if error.kind() == io::ErrorKind::WouldBlock {
            return Ok(());
        }
        return Err(error);
    }
}

struct UnixReader {
    pty: FileDescriptor,
    wake_read: FileDescriptor,
    shared: Arc<Shared>,
    fused: bool,
    /// `drain_wake_fd` coalesces every token. This flag keeps the protected
    /// queue armed until every generation from that batch is acknowledged.
    wake_batch_ready: bool,
}

impl InterruptiblePtyReader for UnixReader {
    fn read_event(&mut self) -> PtyReadEvent {
        if self.fused {
            return PtyReadEvent::Eof;
        }
        loop {
            if self.wake_batch_ready {
                if let Some(event) = self.ack_next_wake() {
                    return event;
                }
                self.wake_batch_ready = false;
            }

            let mut poll_fds = [
                libc::pollfd {
                    fd: self.pty.as_raw_fd(),
                    events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.wake_read.as_raw_fd(),
                    events: libc::POLLIN | libc::POLLHUP | libc::POLLERR,
                    revents: 0,
                },
            ];
            // SAFETY: `poll_fds` is a live mutable array for the exact length
            // passed, and both descriptors are owned by this reader.
            if unsafe { libc::poll(poll_fds.as_mut_ptr(), poll_fds.len() as _, -1) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return self.failure(error);
            }

            let pty_events = poll_fds[0].revents;
            let wake_events = poll_fds[1].revents;
            let pty_terminal = pty_events & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0;
            let wake_terminal = wake_events & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0;

            // Preserve data-first ordering, but drain and arm a simultaneous
            // wake before reading. The next call must observe the accepted
            // generation even while a producer keeps the PTY readable.
            // Terminal readiness is excluded because EOF/failure owns and
            // discards all pending wake generations.
            if !pty_terminal
                && !wake_terminal
                && pty_events & libc::POLLIN != 0
                && wake_events & libc::POLLIN != 0
            {
                drain_wake_fd(&self.wake_read);
                self.wake_batch_ready = true;
            }

            // PTY data wins a simultaneous wake. HUP/ERR still gets one read
            // attempt so buffered data is preserved before EOF/failure.
            if pty_events & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                let mut bytes = vec![0u8; 4096];
                // SAFETY: the PTY descriptor is owned by this reader and
                // `bytes` exposes writable storage for exactly `len` bytes.
                let read = unsafe {
                    libc::read(
                        self.pty.as_raw_fd(),
                        bytes.as_mut_ptr().cast(),
                        bytes.len() as libc::size_t,
                    )
                };
                if read > 0 {
                    bytes.truncate(read as usize);
                    // The generation queue is the SoT and is updated before
                    // the wake descriptor is signalled. Cover that admission
                    // window as well as ordinary simultaneous poll readiness:
                    // after at most one Data event, an accepted wake owns the
                    // next event even if the producer keeps the PTY readable.
                    if !pty_terminal && !wake_terminal {
                        match self.has_pending_wake() {
                            Ok(true) => {
                                // Coalesce a token that is already visible.
                                // If signalling is still in flight this is a
                                // harmless nonblocking drain; a later stale
                                // token is drained without manufacturing Wake.
                                drain_wake_fd(&self.wake_read);
                                self.wake_batch_ready = true;
                            }
                            Ok(false) => {}
                            Err(error) => return self.failure(error),
                        }
                    }
                    return PtyReadEvent::Data(bytes);
                }
                if read == 0 {
                    return self.eof();
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.raw_os_error() == Some(libc::EIO) {
                    return self.eof();
                }
                if error.kind() != io::ErrorKind::WouldBlock {
                    return self.failure(error);
                }
            }

            // A broken control channel is terminal even when stale bytes also
            // make POLLIN ready; it must not manufacture a Wake.
            if wake_events & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                return self.failure(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "interruptible PTY wake descriptor closed",
                ));
            }
            if wake_events & libc::POLLIN != 0 {
                drain_wake_fd(&self.wake_read);
                self.wake_batch_ready = true;
                if let Some(event) = self.ack_next_wake() {
                    return event;
                }
                self.wake_batch_ready = false;
            }
        }
    }
}

impl UnixReader {
    fn has_pending_wake(&self) -> io::Result<bool> {
        self.shared
            .state
            .lock()
            .map(|state| !state.queue.is_empty())
            .map_err(|_| poisoned("interruptible PTY wake state"))
    }

    fn ack_next_wake(&mut self) -> Option<PtyReadEvent> {
        complete_next_wake(&self.shared).map(PtyReadEvent::Wake)
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
        mark_terminal(&self.shared);
    }
}

fn complete_next_wake(shared: &Shared) -> Option<u64> {
    let generation = {
        let mut state = shared.state.lock().ok()?;
        let generation = state.queue.pop_front()?;
        state.completed_through = generation;
        generation
    };
    shared.changed.notify_all();
    Some(generation)
}

impl Drop for UnixReader {
    fn drop(&mut self) {
        self.mark_terminal();
    }
}

fn drain_wake_fd(fd: &FileDescriptor) {
    let mut buffer = [0u8; 64];
    loop {
        // SAFETY: `fd` owns a valid descriptor for the duration of the call,
        // and `buffer` is writable for the supplied length.
        let read = unsafe {
            libc::read(
                fd.as_raw_fd(),
                buffer.as_mut_ptr().cast(),
                buffer.len() as libc::size_t,
            )
        };
        if read > 0 {
            continue;
        }
        if read < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return;
    }
}

fn validate_terminal_generation(shared: &Shared, generation: u64) -> io::Result<()> {
    if generation == shared.terminal_generation {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale PTY terminal generation",
        ))
    }
}

fn mark_terminal(shared: &Shared) {
    if let Ok(mut state) = shared.state.lock() {
        state.terminal = true;
        state.queue.clear();
    }
    shared.changed.notify_all();
}

fn lock_state(shared: &Shared) -> io::Result<std::sync::MutexGuard<'_, State>> {
    shared
        .state
        .lock()
        .map_err(|_| poisoned("interruptible PTY wake state"))
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
    use std::os::unix::io::FromRawFd;
    use std::thread;

    fn fake_pty_pair() -> (FileDescriptor, FileDescriptor) {
        let mut fds = [-1; 2];
        // SAFETY: `fds` is storage for both descriptors returned by `pipe`.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: pipe returned two newly-owned descriptors.
        unsafe {
            (
                FileDescriptor::from_raw_fd(fds[0]),
                FileDescriptor::from_raw_fd(fds[1]),
            )
        }
    }

    #[test]
    fn coalesced_notifications_acknowledge_two_distinct_generations() {
        let (pty_read, _pty_write) = fake_pty_pair();
        let (pair, shared) = new_pair_with_shared(pty_read, 41).unwrap();
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(pair.control);
        let first = Arc::clone(&control);
        let second = Arc::clone(&control);
        let a = thread::spawn(move || first.wake(41, 1, Duration::from_secs(1)));
        let deadline = Instant::now() + Duration::from_secs(1);
        while shared.state.lock().unwrap().highest_requested < 1 {
            assert!(Instant::now() < deadline, "generation 1 was not enqueued");
            thread::yield_now();
        }
        let b = thread::spawn(move || second.wake(41, 2, Duration::from_secs(1)));
        while shared.state.lock().unwrap().highest_requested < 2 {
            assert!(Instant::now() < deadline, "generation 2 was not enqueued");
            thread::yield_now();
        }
        let mut reader = pair.reader;
        let events = [reader.read_event(), reader.read_event()];
        assert!(matches!(events[0], PtyReadEvent::Wake(1)));
        assert!(matches!(events[1], PtyReadEvent::Wake(2)));
        assert_eq!(a.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        assert_eq!(b.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
    }

    #[test]
    fn simultaneous_native_data_and_wake_are_delivered_data_first() {
        let (pty_read, mut pty_write) = fake_pty_pair();
        let (pair, shared) = new_pair_with_shared(pty_read, 41).unwrap();
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(pair.control);
        let waiter_control = Arc::clone(&control);
        let waiter = thread::spawn(move || waiter_control.wake(41, 1, Duration::from_secs(1)));
        let deadline = Instant::now() + Duration::from_secs(1);
        while shared.state.lock().unwrap().highest_requested < 1 {
            assert!(Instant::now() < deadline, "wake was not admitted");
            thread::yield_now();
        }
        let (first_chunk_ready_tx, first_chunk_ready_rx) = std::sync::mpsc::channel();
        let (trailing_byte_ready_tx, trailing_byte_ready_rx) = std::sync::mpsc::channel();
        let (release_writer_tx, release_writer_rx) = std::sync::mpsc::channel();
        let producer = thread::spawn(move || {
            pty_write.write_all(&vec![b'x'; 4096]).unwrap();
            first_chunk_ready_tx.send(()).unwrap();
            pty_write.write_all(b"y").unwrap();
            trailing_byte_ready_tx.send(()).unwrap();
            release_writer_rx.recv().unwrap();
        });
        first_chunk_ready_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let mut reader = pair.reader;
        assert!(
            matches!(reader.read_event(), PtyReadEvent::Data(bytes) if bytes == vec![b'x'; 4096])
        );
        trailing_byte_ready_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(reader.read_event(), PtyReadEvent::Wake(1)));
        assert!(matches!(reader.read_event(), PtyReadEvent::Data(bytes) if bytes == b"y"));
        assert_eq!(waiter.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        release_writer_tx.send(()).unwrap();
        producer.join().unwrap();
    }

    #[test]
    fn queued_generation_before_fd_signal_cannot_be_starved_by_more_data() {
        let (pty_read, mut pty_write) = fake_pty_pair();
        let (pair, shared) = new_pair_with_shared(pty_read, 41).unwrap();

        // Reproduce the exact admission window in UnixControl::wake: the
        // queue is committed before signal_wake writes the descriptor token.
        {
            let mut state = shared.state.lock().unwrap();
            state.highest_requested = 1;
            state.queue.push_back(1);
        }

        let (first_chunk_ready_tx, first_chunk_ready_rx) = std::sync::mpsc::channel();
        let (trailing_byte_ready_tx, trailing_byte_ready_rx) = std::sync::mpsc::channel();
        let (release_writer_tx, release_writer_rx) = std::sync::mpsc::channel();
        let producer = thread::spawn(move || {
            pty_write.write_all(&vec![b'x'; 4096]).unwrap();
            first_chunk_ready_tx.send(()).unwrap();
            pty_write.write_all(b"y").unwrap();
            trailing_byte_ready_tx.send(()).unwrap();
            release_writer_rx.recv().unwrap();
        });
        first_chunk_ready_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let mut reader = pair.reader;
        assert!(
            matches!(reader.read_event(), PtyReadEvent::Data(bytes) if bytes == vec![b'x'; 4096])
        );
        trailing_byte_ready_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(reader.read_event(), PtyReadEvent::Wake(1)));
        assert!(matches!(reader.read_event(), PtyReadEvent::Data(bytes) if bytes == b"y"));
        release_writer_tx.send(()).unwrap();
        producer.join().unwrap();
    }

    #[test]
    fn simultaneous_native_eof_and_wake_emit_only_terminal() {
        let (pty_read, pty_write) = fake_pty_pair();
        let (pair, shared) = new_pair_with_shared(pty_read, 41).unwrap();
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(pair.control);
        let waiter_control = Arc::clone(&control);
        let waiter = thread::spawn(move || waiter_control.wake(41, 1, Duration::from_secs(1)));
        let deadline = Instant::now() + Duration::from_secs(1);
        while shared.state.lock().unwrap().highest_requested < 1 {
            assert!(Instant::now() < deadline, "wake was not admitted");
            thread::yield_now();
        }
        drop(pty_write);

        let mut reader = pair.reader;
        assert!(matches!(reader.read_event(), PtyReadEvent::Eof));
        assert!(matches!(reader.read_event(), PtyReadEvent::Eof));
        assert_eq!(waiter.join().unwrap().unwrap(), PtyWakeOutcome::Terminal);
    }

    #[test]
    fn accepted_waiter_observes_ack_after_a_higher_generation_completes() {
        let (pty_read, _pty_write) = fake_pty_pair();
        let (pair, shared) = new_pair_with_shared(pty_read, 41).unwrap();
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(pair.control);
        {
            let mut state = shared.state.lock().unwrap();
            // Generation 1 was admitted before the reader advanced through
            // both queued wake events while that caller was descheduled.
            state.highest_requested = 2;
            state.queue.extend([1, 2]);
        }
        assert_eq!(complete_next_wake(&shared), Some(1));
        assert_eq!(complete_next_wake(&shared), Some(2));

        assert_eq!(
            wait_for_resolution(&shared, 1, Duration::from_millis(1)).unwrap(),
            PtyWakeOutcome::Acked
        );
        // A fresh lower-generation admission is still stale. This is distinct
        // from resolving the already-admitted waiter above.
        assert_eq!(
            control
                .wake(41, 1, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        drop(pair.reader);
    }

    #[test]
    fn duplicate_waiters_observe_the_same_acknowledgement() {
        let (pty_read, _pty_write) = fake_pty_pair();
        let pair = new_pair(pty_read, 41).unwrap();
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(pair.control);
        let a_control = Arc::clone(&control);
        let b_control = Arc::clone(&control);
        let a = thread::spawn(move || a_control.wake(41, 1, Duration::from_secs(1)));
        let b = thread::spawn(move || b_control.wake(41, 1, Duration::from_secs(1)));
        let mut reader = pair.reader;
        assert!(matches!(reader.read_event(), PtyReadEvent::Wake(1)));
        assert_eq!(a.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        assert_eq!(b.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        assert_eq!(
            control.wake(41, 1, Duration::from_millis(1)).unwrap(),
            PtyWakeOutcome::Acked
        );
    }

    #[test]
    fn zero_and_lower_out_of_order_generations_are_rejected() {
        let (pty_read, _pty_write) = fake_pty_pair();
        let (pair, shared) = new_pair_with_shared(pty_read, 41).unwrap();
        let control: Arc<dyn InterruptiblePtyReaderControl> = Arc::from(pair.control);
        assert_eq!(
            control
                .wake(41, 0, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );

        let high = Arc::clone(&control);
        let high_waiter = thread::spawn(move || high.wake(41, 2, Duration::from_secs(1)));
        let deadline = Instant::now() + Duration::from_secs(1);
        while shared.state.lock().unwrap().highest_requested < 2 {
            assert!(Instant::now() < deadline, "generation 2 was not enqueued");
            thread::yield_now();
        }
        assert_eq!(
            control
                .wake(41, 1, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        let mut reader = pair.reader;
        assert!(matches!(reader.read_event(), PtyReadEvent::Wake(2)));
        assert_eq!(high_waiter.join().unwrap().unwrap(), PtyWakeOutcome::Acked);
        assert_eq!(
            control
                .wake(41, 1, Duration::from_millis(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn full_wake_pipe_coalesces_without_losing_queue_ownership() {
        let mut fds = [-1; 2];
        // SAFETY: `fds` is storage for both descriptors returned by `pipe2`.
        assert_eq!(
            unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
            0
        );
        // SAFETY: successful `pipe2` returned two newly-owned descriptors.
        let read = unsafe { FileDescriptor::from_raw_fd(fds[0]) };
        // SAFETY: ownership of the second descriptor is transferred once.
        let write = unsafe { FileDescriptor::from_raw_fd(fds[1]) };
        let write = Mutex::new(Some(write));
        for _ in 0..100_000 {
            signal_wake(&write).unwrap();
        }
        let mut poll_fd = libc::pollfd {
            fd: read.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `poll_fd` is live mutable storage for the one supplied entry.
        assert_eq!(unsafe { libc::poll(&mut poll_fd, 1, 0) }, 1);
        assert_ne!(poll_fd.revents & libc::POLLIN, 0);
    }

    #[test]
    fn broken_native_wake_descriptor_emits_one_fused_failure() {
        let (pty_read, _pty_write) = fake_pty_pair();
        let pair = new_pair(pty_read, 41).unwrap();
        drop(pair.control);
        let mut reader = pair.reader;
        assert!(matches!(reader.read_event(), PtyReadEvent::Failure(_)));
        assert!(matches!(reader.read_event(), PtyReadEvent::Eof));
    }
}
