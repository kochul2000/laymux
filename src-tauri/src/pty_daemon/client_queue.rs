//! GUI-side receive path of one daemon terminal: the bounded queue between
//! the socket pump and laymux's interruptible reader loop, plus the child
//! exit slot.

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{
    InterruptiblePtyReader, InterruptiblePtyReaderControl, PtyReadEvent, PtyWakeOutcome,
};

use crate::constants::PTY_DAEMON_CLIENT_QUEUE_BYTES;
use crate::lock_ext::MutexExt;

/// Exit code reported when the daemon connection is lost before the child's
/// real exit status arrived. The child may still be running in the daemon.
pub(super) const CONNECTION_LOST_EXIT_CODE: u32 = 1;

/// Reader queue and exit slot shared by the pump, reader and child.
#[derive(Default)]
pub(super) struct Shared {
    queue: Mutex<Queue>,
    queue_changed: Condvar,
    exit: Mutex<Option<u32>>,
    exit_changed: Condvar,
}

#[derive(Default)]
pub(super) struct Queue {
    events: VecDeque<PtyReadEvent>,
    data_bytes: usize,
    /// Eof/Failure queued: the reader is fused after it.
    ended: bool,
    /// The reader was dropped; incoming data is discarded so the pump keeps
    /// draining the socket and can still observe the exit notice.
    closed: bool,
}

impl Shared {
    /// Block while the consumer is behind; this is what turns a slow GUI
    /// callback into socket — and therefore PTY — backpressure. A poisoned
    /// queue discards the data; the reader fails closed in `next_event`.
    pub(super) fn push_data(&self, data: Vec<u8>) {
        let Ok(mut queue) = self.queue.lock_or_err() else {
            return;
        };
        while queue.data_bytes >= PTY_DAEMON_CLIENT_QUEUE_BYTES && !queue.closed {
            queue = match self.queue_changed.wait(queue) {
                Ok(queue) => queue,
                Err(_) => return,
            };
        }
        if queue.closed || queue.ended {
            return;
        }
        queue.data_bytes += data.len();
        queue.events.push_back(PtyReadEvent::Data(data));
        self.queue_changed.notify_all();
    }

    pub(super) fn push_end(&self, event: PtyReadEvent) {
        let Ok(mut queue) = self.queue.lock_or_err() else {
            return;
        };
        if queue.ended {
            return;
        }
        queue.ended = true;
        queue.events.push_back(event);
        self.queue_changed.notify_all();
    }

    pub(super) fn push_wake(&self, wake_generation: u64) -> PtyWakeOutcome {
        let Ok(mut queue) = self.queue.lock_or_err() else {
            return PtyWakeOutcome::Terminal;
        };
        if queue.closed || queue.ended {
            return PtyWakeOutcome::Terminal;
        }
        queue.events.push_back(PtyReadEvent::Wake(wake_generation));
        self.queue_changed.notify_all();
        PtyWakeOutcome::Acked
    }

    pub(super) fn next_event(&self) -> PtyReadEvent {
        let Ok(mut queue) = self.queue.lock_or_err() else {
            return poisoned_failure();
        };
        loop {
            if let Some(event) = queue.events.pop_front() {
                if let PtyReadEvent::Data(bytes) = &event {
                    queue.data_bytes -= bytes.len();
                    self.queue_changed.notify_all();
                }
                return event;
            }
            if queue.ended {
                return PtyReadEvent::Eof;
            }
            queue = match self.queue_changed.wait(queue) {
                Ok(queue) => queue,
                Err(_) => return poisoned_failure(),
            };
        }
    }

    /// Discard-only teardown: the reader is gone and nothing below is used to
    /// admit or account further data (ADR-0087).
    pub(super) fn close_reader(&self) {
        let mut queue = self
            .queue
            .lock_or_recover_for_discard("closing PTY daemon reader queue");
        queue.closed = true;
        queue.events.clear();
        queue.data_bytes = 0;
        self.queue_changed.notify_all();
    }

    pub(super) fn publish_exit(&self, exit_code: u32) {
        if let Ok(mut exit) = self.exit.lock_or_err() {
            if exit.is_none() {
                *exit = Some(exit_code);
            }
        }
        self.exit_changed.notify_all();
    }

    pub(super) fn exit_code(&self) -> Option<u32> {
        self.exit.lock_or_err().ok().and_then(|exit| *exit)
    }

    /// A poisoned exit slot reports the connection-lost status instead of
    /// waiting forever.
    pub(super) fn wait_exit(&self) -> u32 {
        let Ok(mut exit) = self.exit.lock_or_err() else {
            return CONNECTION_LOST_EXIT_CODE;
        };
        loop {
            if let Some(code) = *exit {
                return code;
            }
            exit = match self.exit_changed.wait(exit) {
                Ok(exit) => exit,
                Err(_) => return CONNECTION_LOST_EXIT_CODE,
            };
        }
    }
}

fn poisoned_failure() -> PtyReadEvent {
    PtyReadEvent::Failure(io::Error::other("PTY daemon reader queue is poisoned"))
}

pub(super) struct DaemonReader {
    pub(super) shared: Arc<Shared>,
}

impl InterruptiblePtyReader for DaemonReader {
    fn read_event(&mut self) -> PtyReadEvent {
        self.shared.next_event()
    }
}

impl Drop for DaemonReader {
    fn drop(&mut self) {
        self.shared.close_reader();
    }
}

pub(super) struct DaemonReaderControl {
    pub(super) shared: Arc<Shared>,
    pub(super) terminal_generation: u64,
}

impl InterruptiblePtyReaderControl for DaemonReaderControl {
    fn terminal_generation(&self) -> u64 {
        self.terminal_generation
    }

    fn wake(
        &self,
        terminal_generation: u64,
        wake_generation: u64,
        _timeout: Duration,
    ) -> io::Result<PtyWakeOutcome> {
        if terminal_generation != self.terminal_generation {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "PTY daemon reader generation mismatch",
            ));
        }
        Ok(self.shared.push_wake(wake_generation))
    }
}
