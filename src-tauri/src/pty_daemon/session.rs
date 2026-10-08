//! One daemon session: the native PTY, its attached client and the output
//! retained while detached.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use super::transport::{self, Stream};
use super::wire::{write_control, write_data, DaemonMessage, SessionInfo};
use crate::constants::PTY_DAEMON_DETACHED_BACKLOG_BYTES;
use crate::lock_ext::MutexExt;
use crate::pty::{PtyHandle, PtyOutputControl, PTY_READ_BUFFER_BYTES};

/// Serialized writes of whole frames to one connection.
pub(super) struct ConnWriter {
    stream: Mutex<Stream>,
    /// Independent clone used to unblock the connection from another thread.
    control: Stream,
}

impl ConnWriter {
    pub(super) fn new(stream: &Stream) -> io::Result<Self> {
        Ok(Self {
            stream: Mutex::new(stream.try_clone()?),
            control: stream.try_clone()?,
        })
    }

    pub(super) fn send(&self, message: &DaemonMessage) -> io::Result<()> {
        let mut stream = self.stream.lock_or_err().map_err(io::Error::other)?;
        write_control(&mut *stream, message)
    }

    pub(super) fn send_data(&self, data: &[u8]) -> io::Result<()> {
        let mut stream = self.stream.lock_or_err().map_err(io::Error::other)?;
        write_data(&mut *stream, data)
    }

    pub(super) fn error(&self, message: &str) {
        tracing::debug!(message, "PTY daemon request rejected");
        let _ = self.send(&DaemonMessage::Error {
            message: message.to_owned(),
        });
    }

    pub(super) fn close(&self) {
        transport::shutdown(&self.control);
    }
}

#[derive(Clone)]
pub(super) struct ClientLink {
    pub(super) connection_id: u64,
    pub(super) writer: Arc<ConnWriter>,
}

pub(super) struct Session {
    pub(super) id: String,
    pub(super) handle: OnceLock<PtyHandle>,
    pub(super) sink: Mutex<Sink>,
    /// Mirror of `sink.client` kept outside the sink lock. The PTY reader can
    /// hold the sink while blocked writing to a stalled client; attach and
    /// list must still be able to see and evict that client. Lock order is
    /// always sink → attached.
    pub(super) attached: Mutex<Option<ClientLink>>,
    exited: AtomicBool,
    pub(super) terminating: AtomicBool,
}

#[derive(Default)]
pub(super) struct Sink {
    pub(super) client: Option<ClientLink>,
    pub(super) backlog: VecDeque<u8>,
    pub(super) dropped_bytes: u64,
    pub(super) reader_ended: bool,
    pub(super) exit_code: Option<u32>,
}

impl Sink {
    pub(super) fn retain(&mut self, data: &[u8]) {
        self.backlog.extend(data);
        let excess = self
            .backlog
            .len()
            .saturating_sub(PTY_DAEMON_DETACHED_BACKLOG_BYTES);
        if excess > 0 {
            self.backlog.drain(..excess);
            self.dropped_bytes += excess as u64;
        }
    }
}

impl Session {
    pub(super) fn new(id: String) -> Self {
        Self {
            id,
            handle: OnceLock::new(),
            sink: Mutex::new(Sink::default()),
            attached: Mutex::new(None),
            exited: AtomicBool::new(false),
            terminating: AtomicBool::new(false),
        }
    }

    /// PTY reader callback. With a client attached this blocks on the socket
    /// write, which is the same backpressure an in-process callback applies.
    /// A failed write means the client is gone: detach and keep reading so a
    /// session nobody watches never stalls its child.
    pub(super) fn deliver_output(&self, data: &[u8]) -> PtyOutputControl {
        let Ok(mut sink) = self.sink.lock_or_err() else {
            return PtyOutputControl::Stop;
        };
        if let Some(client) = sink.client.as_ref() {
            if client.writer.send_data(data).is_ok() {
                return PtyOutputControl::Continue;
            }
            let connection_id = client.connection_id;
            sink.client = None;
            self.forget_attached(connection_id);
        }
        sink.retain(data);
        PtyOutputControl::Continue
    }

    pub(super) fn mark_reader_ended(&self) {
        if let Ok(mut sink) = self.sink.lock_or_err() {
            sink.reader_ended = true;
            if let Some(client) = sink.client.as_ref() {
                let _ = client.writer.send(&DaemonMessage::Eof);
            }
        }
    }

    pub(super) fn mark_child_exited(&self, exit_code: u32) {
        self.exited.store(true, Ordering::Release);
        if let Ok(mut sink) = self.sink.lock_or_err() {
            sink.exit_code = Some(exit_code);
            if let Some(client) = sink.client.as_ref() {
                let _ = client.writer.send(&DaemonMessage::Exit { exit_code });
            }
        }
    }

    pub(super) fn is_finished(&self) -> bool {
        self.sink
            .lock_or_err()
            .map(|sink| sink.reader_ended && sink.exit_code.is_some())
            .unwrap_or(false)
    }

    /// Replace the attached client. Under the sink lock the new client gets
    /// `Attached`, then the retained backlog, then any end-of-life notices,
    /// so no live output can interleave ahead of the replay.
    pub(super) fn attach(
        &self,
        writer: &Arc<ConnWriter>,
        connection_id: u64,
    ) -> Result<(), String> {
        // Evict the previous client before waiting for the sink: a reader
        // blocked writing to a stalled client releases the sink only once
        // that client's socket is shut down.
        if let Some(previous) = self.attached.lock_or_err()?.take() {
            previous.writer.close();
        }
        let mut sink = self.sink.lock_or_err()?;
        if let Some(previous) = sink.client.take() {
            previous.writer.close();
        }
        let child_pid = self.handle.get().and_then(PtyHandle::child_pid);
        let backlog: Vec<u8> = sink.backlog.drain(..).collect();
        let dropped_bytes = std::mem::take(&mut sink.dropped_bytes);
        let delivered = writer
            .send(&DaemonMessage::Attached {
                child_pid,
                dropped_bytes,
            })
            .and_then(|()| {
                backlog
                    .chunks(PTY_READ_BUFFER_BYTES)
                    .try_for_each(|chunk| writer.send_data(chunk))
            })
            .and_then(|()| {
                if sink.reader_ended {
                    writer.send(&DaemonMessage::Eof)?;
                }
                if let Some(exit_code) = sink.exit_code {
                    writer.send(&DaemonMessage::Exit { exit_code })?;
                }
                Ok(())
            });
        delivered.map_err(|error| format!("PTY daemon attach delivery failed: {error}"))?;
        let link = ClientLink {
            connection_id,
            writer: Arc::clone(writer),
        };
        sink.client = Some(link.clone());
        *self.attached.lock_or_err()? = Some(link);
        Ok(())
    }

    /// Forget the client only if it is still this connection; a newer attach
    /// must not be undone by the previous connection's late teardown.
    pub(super) fn detach(&self, connection_id: u64) {
        if let Ok(mut sink) = self.sink.lock_or_err() {
            if sink
                .client
                .as_ref()
                .is_some_and(|client| client.connection_id == connection_id)
            {
                sink.client = None;
                self.forget_attached(connection_id);
                tracing::info!(session_id = %self.id, "PTY daemon client detached; session kept");
            }
        }
    }

    pub(super) fn write_input(&self, data: &[u8], writer: &ConnWriter) {
        let Some(handle) = self.handle.get() else {
            return;
        };
        if let Err(error) = handle.write(data) {
            writer.error(&format!("PTY daemon input failed: {error}"));
        }
    }

    pub(super) fn resize(&self, rows: u16, cols: u16, writer: &ConnWriter) {
        let Some(handle) = self.handle.get() else {
            return;
        };
        if let Err(error) = handle.resize(cols, rows) {
            writer.error(&format!("PTY daemon resize failed: {error}"));
        }
    }

    /// Idempotent; the blocking teardown runs off the connection thread so
    /// the connection keeps draining frames meanwhile.
    pub(super) fn terminate(&self) {
        if self.terminating.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(handle) = self.handle.get().cloned() else {
            return;
        };
        let session_id = self.id.clone();
        thread::spawn(move || {
            if let Err(error) = handle.terminate() {
                tracing::warn!(%session_id, %error, "PTY daemon session terminate failed");
            }
        });
    }

    /// Never takes the sink lock, so listing stays responsive while a reader
    /// is blocked on a stalled client.
    pub(super) fn info(&self) -> Option<SessionInfo> {
        let attached = self.attached.lock_or_err().ok()?.is_some();
        Some(SessionInfo {
            session_id: self.id.clone(),
            child_pid: self.handle.get().and_then(PtyHandle::child_pid),
            attached,
            exited: self.exited.load(Ordering::Acquire),
        })
    }

    fn forget_attached(&self, connection_id: u64) {
        if let Ok(mut attached) = self.attached.lock_or_err() {
            if attached
                .as_ref()
                .is_some_and(|link| link.connection_id == connection_id)
            {
                *attached = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detached_backlog_keeps_the_newest_bytes_and_counts_the_rest() {
        let mut sink = Sink::default();
        sink.retain(&vec![b'a'; PTY_DAEMON_DETACHED_BACKLOG_BYTES]);
        sink.retain(b"tail");
        assert_eq!(sink.backlog.len(), PTY_DAEMON_DETACHED_BACKLOG_BYTES);
        assert_eq!(sink.dropped_bytes, 4);
        let tail: Vec<u8> = sink.backlog.iter().rev().take(4).rev().copied().collect();
        assert_eq!(tail, b"tail");
    }
}
