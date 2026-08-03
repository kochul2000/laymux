//! Generation-scoped interruptible PTY reader integration.
//!
//! The platform primitive lives in the pinned `portable-pty` fork. This
//! module owns laymux's callback/stop boundary and deliberately does not
//! assign output provenance or geometry revisions to wake events.

use portable_pty::{InterruptiblePtyReader, InterruptiblePtyReaderControl, PtyReadEvent};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::lock_ext::MutexExt;
use crate::pty::PtyOutputControl;

pub(crate) struct PtyReaderLifecycle {
    terminal_generation: u64,
    control: Arc<dyn InterruptiblePtyReaderControl>,
    stop_requested: AtomicBool,
    exited: Mutex<bool>,
    exited_changed: Condvar,
}

impl PtyReaderLifecycle {
    pub(crate) fn new(
        terminal_generation: u64,
        control: Box<dyn InterruptiblePtyReaderControl>,
    ) -> Result<Arc<Self>, String> {
        if control.terminal_generation() != terminal_generation {
            return Err("interruptible PTY reader generation mismatch".into());
        }
        Ok(Arc::new(Self {
            terminal_generation,
            control: Arc::from(control),
            stop_requested: AtomicBool::new(false),
            exited: Mutex::new(false),
            exited_changed: Condvar::new(),
        }))
    }

    #[cfg(test)]
    pub(crate) fn completed_for_test(terminal_generation: u64) -> Arc<Self> {
        struct TerminalControl {
            terminal_generation: u64,
        }
        impl InterruptiblePtyReaderControl for TerminalControl {
            fn terminal_generation(&self) -> u64 {
                self.terminal_generation
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
        Arc::new(Self {
            terminal_generation,
            control: Arc::new(TerminalControl {
                terminal_generation,
            }),
            stop_requested: AtomicBool::new(true),
            exited: Mutex::new(true),
            exited_changed: Condvar::new(),
        })
    }

    pub(crate) fn terminal_generation(&self) -> u64 {
        self.terminal_generation
    }

    pub(crate) fn request_stop(&self, timeout: Duration) -> Result<(), String> {
        if self.stop_requested.swap(true, Ordering::AcqRel) {
            return self.wait_for_exit(timeout);
        }
        if *self.exited.lock_or_err()? {
            return Ok(());
        }
        self.control
            .wake(self.terminal_generation, 1, timeout)
            .map(|_| ())
            .map_err(|error| format!("failed to wake PTY reader: {error}"))
    }

    pub(crate) fn wait_for_exit(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut exited = self.exited.lock_or_err()?;
        while !*exited {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("PTY reader generation teardown timed out".into());
            }
            let (next, result) = self
                .exited_changed
                .wait_timeout(exited, remaining)
                .map_err(|_| "PTY reader lifecycle mutex is poisoned".to_string())?;
            exited = next;
            if result.timed_out() && !*exited {
                return Err("PTY reader generation teardown timed out".into());
            }
        }
        Ok(())
    }

    fn mark_exited(&self) {
        match self.exited.lock() {
            Ok(mut exited) => *exited = true,
            Err(poisoned) => *poisoned.into_inner() = true,
        }
        self.exited_changed.notify_all();
    }
}

struct ReaderExitGuard(Arc<PtyReaderLifecycle>);

impl Drop for ReaderExitGuard {
    fn drop(&mut self) {
        self.0.mark_exited();
    }
}

pub(crate) fn run_interruptible_reader_loop<F>(
    reader: Box<dyn InterruptiblePtyReader>,
    lifecycle: Arc<PtyReaderLifecycle>,
    on_output: F,
) where
    F: Fn(Vec<u8>) -> PtyOutputControl,
{
    let _exit = ReaderExitGuard(Arc::clone(&lifecycle));
    // Windows CancelSynchronousIo targets every synchronous operation on a
    // thread, not one handle. Keep native reads on a dedicated pump thread;
    // callbacks (Tauri emit, OSC hooks, locks) run only on this consumer.
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    let (decision_tx, decision_rx) = std::sync::mpsc::channel();
    let pump_lifecycle = Arc::clone(&lifecycle);
    let pump = std::thread::spawn(move || {
        let mut reader = reader;
        loop {
            let event = reader.read_event();
            let data = matches!(event, PtyReadEvent::Data(_));
            let terminal = matches!(event, PtyReadEvent::Eof | PtyReadEvent::Failure(_));
            if event_tx.send(event).is_err() || terminal {
                break;
            }
            // Preserve ADR-0088's synchronous Stop boundary: do not admit the
            // next master read until the callback has accepted this Data.
            if data
                && (decision_rx.recv() != Ok(PtyOutputControl::Continue)
                    || pump_lifecycle.stop_requested.load(Ordering::Acquire))
            {
                break;
            }
            if pump_lifecycle.stop_requested.load(Ordering::Acquire) {
                break;
            }
        }
    });

    while let Ok(event) = event_rx.recv() {
        match event {
            PtyReadEvent::Data(bytes) => {
                if bytes.is_empty() {
                    tracing::error!(
                        generation = lifecycle.terminal_generation,
                        "interruptible PTY reader emitted empty data"
                    );
                    let _ = decision_tx.send(PtyOutputControl::Stop);
                    break;
                }
                if bytes.len() > crate::pty::PTY_READ_BUFFER_BYTES {
                    tracing::error!(
                        generation = lifecycle.terminal_generation,
                        bytes = bytes.len(),
                        limit = crate::pty::PTY_READ_BUFFER_BYTES,
                        "interruptible PTY reader exceeded the output credit chunk bound"
                    );
                    let _ = decision_tx.send(PtyOutputControl::Stop);
                    break;
                }
                let callback_control = on_output(bytes);
                let control = if lifecycle.stop_requested.load(Ordering::Acquire) {
                    PtyOutputControl::Stop
                } else {
                    callback_control
                };
                let _ = decision_tx.send(control);
                if control == PtyOutputControl::Stop {
                    break;
                }
            }
            PtyReadEvent::Wake(wake_generation) => {
                tracing::trace!(
                    generation = lifecycle.terminal_generation,
                    wake_generation,
                    "interruptible PTY reader observed control wake"
                );
                if lifecycle.stop_requested.load(Ordering::Acquire) {
                    break;
                }
            }
            PtyReadEvent::Eof => break,
            PtyReadEvent::Failure(error) => {
                tracing::warn!(
                    generation = lifecycle.terminal_generation,
                    %error,
                    "interruptible PTY reader failed"
                );
                break;
            }
        }
    }
    drop(event_rx);
    if pump.join().is_err() {
        tracing::error!(
            generation = lifecycle.terminal_generation,
            "interruptible PTY reader pump panicked"
        );
    }
}

#[cfg(test)]
use std::collections::VecDeque;

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReaderEvent {
    Data(Vec<u8>),
    Wake(u64),
    Eof,
    Failure(String),
}

#[cfg(test)]
struct ReaderProtocol {
    terminal_generation: u64,
    pending_wakes: VecDeque<u64>,
    events: Vec<ReaderEvent>,
    fused: bool,
}

#[cfg(test)]
impl ReaderProtocol {
    fn new(terminal_generation: u64) -> Self {
        Self {
            terminal_generation,
            pending_wakes: VecDeque::new(),
            events: Vec::new(),
            fused: false,
        }
    }

    fn mark_wake_pending(&mut self, wake_generation: u64) -> Result<(), String> {
        self.ensure_live()?;
        if !self.pending_wakes.contains(&wake_generation) {
            self.pending_wakes.push_back(wake_generation);
        }
        Ok(())
    }

    fn observe_data(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        self.ensure_live()?;
        if bytes.is_empty() {
            return Err("empty PTY data event".into());
        }
        self.events.push(ReaderEvent::Data(bytes));
        Ok(())
    }

    fn observe_wake(&mut self, wake_generation: u64) -> Result<(), String> {
        self.observe_generation_wake(self.terminal_generation, wake_generation)
    }

    fn observe_generation_wake(
        &mut self,
        terminal_generation: u64,
        wake_generation: u64,
    ) -> Result<(), String> {
        self.ensure_live()?;
        if terminal_generation != self.terminal_generation {
            return Err("stale PTY terminal generation".into());
        }
        let Some(index) = self
            .pending_wakes
            .iter()
            .position(|generation| *generation == wake_generation)
        else {
            return Err("unrequested PTY wake generation".into());
        };
        self.pending_wakes.remove(index);
        self.events.push(ReaderEvent::Wake(wake_generation));
        Ok(())
    }

    fn observe_eof(&mut self) -> Result<(), String> {
        self.finish(ReaderEvent::Eof)
    }

    fn observe_failure(&mut self, error: impl Into<String>) -> Result<(), String> {
        self.finish(ReaderEvent::Failure(error.into()))
    }

    fn finish(&mut self, event: ReaderEvent) -> Result<(), String> {
        self.ensure_live()?;
        self.pending_wakes.clear();
        self.fused = true;
        self.events.push(event);
        Ok(())
    }

    fn ensure_live(&self) -> Result<(), String> {
        if self.fused {
            Err("PTY reader already reached a terminal event".into())
        } else {
            Ok(())
        }
    }

    fn events(&self) -> &[ReaderEvent] {
        &self.events
    }

    fn into_events(self) -> Vec<ReaderEvent> {
        self.events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::PtyWakeOutcome;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn data_wins_before_a_racing_wake_and_terminal_events_are_fused() {
        let mut protocol = ReaderProtocol::new(41);

        protocol.mark_wake_pending(7).unwrap();
        protocol.observe_data(b"old bytes".to_vec()).unwrap();
        protocol.observe_wake(7).unwrap();
        protocol.observe_eof().unwrap();

        assert_eq!(
            protocol.into_events(),
            vec![
                ReaderEvent::Data(b"old bytes".to_vec()),
                ReaderEvent::Wake(7),
                ReaderEvent::Eof,
            ]
        );
    }

    #[test]
    fn eof_or_failure_discards_a_pending_wake_and_forbids_later_data() {
        let mut eof = ReaderProtocol::new(41);
        eof.mark_wake_pending(7).unwrap();
        eof.observe_eof().unwrap();
        assert!(eof.observe_wake(7).is_err());
        assert!(eof.observe_data(b"must-not-run".to_vec()).is_err());
        assert_eq!(eof.into_events(), vec![ReaderEvent::Eof]);

        let mut failed = ReaderProtocol::new(41);
        failed.mark_wake_pending(8).unwrap();
        failed.observe_failure("unrelated read failure").unwrap();
        assert!(failed.observe_data(b"must-not-run".to_vec()).is_err());
        assert_eq!(
            failed.into_events(),
            vec![ReaderEvent::Failure("unrelated read failure".into())]
        );
    }

    #[test]
    fn stale_terminal_generation_cannot_acknowledge_a_new_reader() {
        let mut protocol = ReaderProtocol::new(42);
        protocol.mark_wake_pending(9).unwrap();
        assert!(protocol.observe_generation_wake(41, 9).is_err());
        assert!(protocol.events().is_empty());

        protocol.mark_wake_pending(10).unwrap();
        protocol.observe_generation_wake(42, 10).unwrap();
        assert_eq!(protocol.events(), &[ReaderEvent::Wake(10)]);
    }

    #[test]
    fn duplicate_wake_request_is_acknowledged_once() {
        let mut protocol = ReaderProtocol::new(42);
        protocol.mark_wake_pending(11).unwrap();
        protocol.mark_wake_pending(11).unwrap();
        protocol.observe_wake(11).unwrap();
        assert!(protocol.observe_wake(11).is_err());
        assert_eq!(protocol.events(), &[ReaderEvent::Wake(11)]);
    }

    #[test]
    fn concurrent_stop_requests_emit_one_wake_and_share_completion() {
        struct CountingControl(Arc<AtomicUsize>);
        impl InterruptiblePtyReaderControl for CountingControl {
            fn terminal_generation(&self) -> u64 {
                42
            }

            fn wake(
                &self,
                terminal_generation: u64,
                wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<PtyWakeOutcome> {
                assert_eq!(terminal_generation, 42);
                assert_eq!(wake_generation, 1);
                self.0.fetch_add(1, Ordering::AcqRel);
                Ok(PtyWakeOutcome::Acked)
            }
        }

        let wakes = Arc::new(AtomicUsize::new(0));
        let lifecycle =
            PtyReaderLifecycle::new(42, Box::new(CountingControl(Arc::clone(&wakes)))).unwrap();
        lifecycle.request_stop(Duration::from_secs(1)).unwrap();

        let second = Arc::clone(&lifecycle);
        let waiter = std::thread::spawn(move || second.request_stop(Duration::from_secs(1)));
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(wakes.load(Ordering::Acquire), 1);
        lifecycle.mark_exited();
        waiter.join().unwrap().unwrap();
        assert_eq!(wakes.load(Ordering::Acquire), 1);
    }

    fn assert_failed_wake_falls_back_to_generation_completion(kind: std::io::ErrorKind) {
        struct FailingControl(std::io::ErrorKind);
        impl InterruptiblePtyReaderControl for FailingControl {
            fn terminal_generation(&self) -> u64 {
                43
            }

            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<PtyWakeOutcome> {
                Err(std::io::Error::new(self.0, "injected wake failure"))
            }
        }

        let lifecycle = PtyReaderLifecycle::new(43, Box::new(FailingControl(kind))).unwrap();
        let first = lifecycle.request_stop(Duration::from_millis(1));
        assert!(
            first.is_err(),
            "a failed wake must not be reported as success"
        );

        // All later stop callers share this generation's completion instead
        // of attempting another cancellation against a potentially new read.
        let waiter_lifecycle = Arc::clone(&lifecycle);
        let waiter =
            std::thread::spawn(move || waiter_lifecycle.request_stop(Duration::from_secs(1)));
        std::thread::sleep(Duration::from_millis(20));
        lifecycle.mark_exited();
        waiter.join().unwrap().unwrap();
    }

    #[test]
    fn cancellation_error_falls_back_to_generation_completion() {
        assert_failed_wake_falls_back_to_generation_completion(
            std::io::ErrorKind::PermissionDenied,
        );
    }

    #[test]
    fn cancellation_deadline_falls_back_to_generation_completion() {
        assert_failed_wake_falls_back_to_generation_completion(std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn concurrent_reader_pumps_never_cross_terminal_callback_channels() {
        struct TaggedReader {
            tag: u8,
            remaining: u8,
        }
        impl InterruptiblePtyReader for TaggedReader {
            fn read_event(&mut self) -> PtyReadEvent {
                if self.remaining == 0 {
                    PtyReadEvent::Eof
                } else {
                    let sequence = self.remaining;
                    self.remaining -= 1;
                    PtyReadEvent::Data(vec![self.tag, sequence])
                }
            }
        }
        struct TerminalControl(u64);
        impl InterruptiblePtyReaderControl for TerminalControl {
            fn terminal_generation(&self) -> u64 {
                self.0
            }
            fn wake(
                &self,
                _terminal_generation: u64,
                _wake_generation: u64,
                _timeout: Duration,
            ) -> std::io::Result<PtyWakeOutcome> {
                Ok(PtyWakeOutcome::Terminal)
            }
        }

        let run = |tag: u8, generation: u64| {
            std::thread::spawn(move || {
                let lifecycle =
                    PtyReaderLifecycle::new(generation, Box::new(TerminalControl(generation)))
                        .unwrap();
                let seen = Arc::new(Mutex::new(Vec::new()));
                let callback_seen = Arc::clone(&seen);
                run_interruptible_reader_loop(
                    Box::new(TaggedReader { tag, remaining: 64 }),
                    lifecycle,
                    move |bytes| {
                        assert_eq!(bytes[0], tag, "PTY bytes crossed callback ownership");
                        callback_seen.lock().unwrap().push(bytes);
                        PtyOutputControl::Continue
                    },
                );
                seen
            })
        };

        let first_worker = run(0xA1, 201);
        let second_worker = run(0xB2, 202);
        let first = first_worker.join().unwrap();
        let second = second_worker.join().unwrap();
        let first = first.lock().unwrap();
        let second = second.lock().unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert!(first.iter().all(|bytes| bytes[0] == 0xA1));
        assert!(second.iter().all(|bytes| bytes[0] == 0xB2));
    }
}
