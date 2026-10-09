//! One daemon session: the native PTY, its attached client and the output
//! retained while detached.

use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use super::modes::TerminalModes;
use super::transport::{self, Stream};
use super::wire::{write_control, write_data, DaemonMessage, SessionInfo};
use crate::constants::{
    PTY_DAEMON_DETACHED_BACKLOG_BYTES, PTY_DAEMON_SCREEN_DEFAULT_COLS,
    PTY_DAEMON_SCREEN_DEFAULT_ROWS,
};
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
    pub(super) terminal_id: String,
    /// Opaque GUI state returned to an adopting client.
    pub(super) metadata: BTreeMap<String, String>,
    /// Daemon-wide creation order; picks the newest adoption candidate.
    pub(super) created_seq: u64,
    /// Bumped by every bind (spawn or attach). A by-id terminate carrying an
    /// older epoch comes from a client that no longer owns the session.
    attach_epoch: AtomicU64,
    pub(super) handle: OnceLock<PtyHandle>,
    pub(super) sink: Mutex<Sink>,
    /// Mirror of `sink.client` kept outside the sink lock. The PTY reader can
    /// hold the sink while blocked writing to a stalled client; attach and
    /// list must still be able to see and evict that client. Lock order is
    /// always sink → attached.
    pub(super) attached: Mutex<Option<ClientLink>>,
    exited: AtomicBool,
    /// Shared with the teardown thread so a failed terminate can be retried.
    terminating: Arc<AtomicBool>,
    terminate_requested: AtomicBool,
    /// PTY size applied by the latest resize, for the screen model to adopt
    /// under the sink lock (a resize must not wait behind a stalled client).
    pending_screen_size: Mutex<Option<(u16, u16)>>,
}

pub(super) struct Sink {
    pub(super) client: Option<ClientLink>,
    pub(super) backlog: VecDeque<u8>,
    pub(super) dropped_bytes: u64,
    pub(super) reader_ended: bool,
    pub(super) exit_code: Option<u32>,
    /// Modes set by all output so far, attached or not (ADR-0303).
    pub(super) modes: TerminalModes,
    /// The visible screen as all output so far left it, for the next
    /// replay-less attach to redraw (ADR-0307).
    pub(super) screen: vt100::Parser,
}

impl Default for Sink {
    fn default() -> Self {
        Self {
            client: None,
            backlog: VecDeque::new(),
            dropped_bytes: 0,
            reader_ended: false,
            exit_code: None,
            modes: TerminalModes::default(),
            // Sized for real at spawn; no scrollback is kept.
            screen: vt100::Parser::new(
                PTY_DAEMON_SCREEN_DEFAULT_ROWS,
                PTY_DAEMON_SCREEN_DEFAULT_COLS,
                0,
            ),
        }
    }
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
    pub(super) fn new(
        id: String,
        terminal_id: String,
        metadata: BTreeMap<String, String>,
        created_seq: u64,
    ) -> Self {
        Self {
            id,
            terminal_id,
            metadata,
            created_seq,
            attach_epoch: AtomicU64::new(0),
            handle: OnceLock::new(),
            sink: Mutex::new(Sink::default()),
            attached: Mutex::new(None),
            exited: AtomicBool::new(false),
            terminating: Arc::new(AtomicBool::new(false)),
            terminate_requested: AtomicBool::new(false),
            pending_screen_size: Mutex::new(None),
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
        // Under the sink lock, so an attach's preamble reflects exactly the
        // output that precedes the client's first live frame.
        sink.modes.process(data);
        self.apply_pending_screen_size(&mut sink);
        sink.screen.process(data);
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
    /// `Attached`, then either the retained backlog (with `replay`) or the
    /// mode preamble (without it, ADR-0303), then any end-of-life notices,
    /// so no live output can interleave ahead of them.
    pub(super) fn attach(
        &self,
        writer: &Arc<ConnWriter>,
        connection_id: u64,
        replay: bool,
        take_over: bool,
    ) -> Result<u64, String> {
        let link = ClientLink {
            connection_id,
            writer: Arc::clone(writer),
        };
        // Evict the previous client and publish this one before waiting for
        // the sink. A reader blocked writing to a stalled client releases the
        // sink only once that socket is shut down, and if this client stalls
        // during the replay below, the next attach can evict it the same way.
        let attach_epoch = {
            let mut attached = self.attached.lock_or_err()?;
            // Adoption is decided and claimed under this lock, so of two
            // adopters (or an adopter racing a terminate) exactly one wins.
            if !take_over && (attached.is_some() || self.terminate_requested()) {
                return Err("PTY daemon session is attached or terminating".into());
            }
            if let Some(previous) = attached.replace(link.clone()) {
                previous.writer.close();
            }
            // The epoch moves with the claim, under the same lock a by-id
            // terminate checks it under, so a stale owner's request cannot
            // slip in between the claim and the epoch change.
            self.next_attach_epoch_claimed()
        };
        let mut sink = self.sink.lock_or_err()?;
        if let Some(previous) = sink.client.take() {
            previous.writer.close();
        }
        if !self.is_attached(connection_id) {
            return Err("PTY daemon attach was superseded by a newer attach".into());
        }
        let child_pid = self.handle.get().and_then(PtyHandle::child_pid);
        // Without replay the client never sees the output that set the
        // session's modes and drew its screen, so it gets the modes
        // re-asserted (ADR-0303) and then the screen redrawn (ADR-0307):
        // cells, attributes and cursor only — no query, no OSC. A replay (no
        // production path yet) carries neither: the backlog holds only
        // output from while no client was attached.
        let preamble = if replay {
            Vec::new()
        } else {
            self.apply_pending_screen_size(&mut sink);
            let screen = sink.screen.screen();
            [
                sink.modes.preamble(),
                screen.contents_formatted(),
                screen.cursor_state_formatted(),
            ]
            .concat()
        };
        // Without replay the retained bytes are discarded instead of handed
        // to a client that would parse them as live output (and answer the
        // terminal queries inside them again).
        if !replay {
            sink.dropped_bytes += sink.backlog.len() as u64;
            sink.backlog.clear();
        }
        // Consume the backlog only once it was delivered, so a client that
        // drops mid-replay leaves it for the next attach.
        let delivered = writer
            .send(&DaemonMessage::Attached {
                child_pid,
                attach_epoch,
                dropped_bytes: sink.dropped_bytes,
                metadata: self.metadata.clone(),
            })
            .and_then(|()| {
                let (front, back) = sink.backlog.as_slices();
                front
                    .chunks(PTY_READ_BUFFER_BYTES)
                    .chain(back.chunks(PTY_READ_BUFFER_BYTES))
                    .try_for_each(|chunk| writer.send_data(chunk))
            })
            .and_then(|()| {
                if preamble.is_empty() {
                    Ok(())
                } else {
                    writer.send_data(&preamble)
                }
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
        if let Err(error) = delivered {
            self.forget_attached(connection_id);
            return Err(format!("PTY daemon attach delivery failed: {error}"));
        }
        sink.backlog.clear();
        sink.dropped_bytes = 0;
        sink.client = Some(link);
        Ok(attach_epoch)
    }

    /// Callers hold the claim (`attached`) lock.
    fn next_attach_epoch_claimed(&self) -> u64 {
        self.attach_epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub(super) fn attach_epoch(&self) -> u64 {
        self.attach_epoch.load(Ordering::Acquire)
    }

    /// Whether a by-id terminate from a client that attached with
    /// `attach_epoch` may still end this session.
    fn owned_by_epoch(&self, attach_epoch: Option<u64>) -> bool {
        attach_epoch.is_none_or(|epoch| epoch == self.attach_epoch.load(Ordering::Acquire))
    }

    fn is_attached(&self, connection_id: u64) -> bool {
        self.attached.lock_or_err().is_ok_and(|attached| {
            attached
                .as_ref()
                .is_some_and(|link| link.connection_id == connection_id)
        })
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
            return;
        }
        if let Ok(mut pending) = self.pending_screen_size.lock_or_err() {
            *pending = Some((rows, cols));
        }
    }

    /// Give the screen model the PTY's latest size. Output after a resize is
    /// laid out for the new size, so this runs before that output is parsed.
    fn apply_pending_screen_size(&self, sink: &mut Sink) {
        let pending = self
            .pending_screen_size
            .lock_or_err()
            .ok()
            .and_then(|mut pending| pending.take());
        if let Some((rows, cols)) = pending {
            sink.screen.screen_mut().set_size(rows, cols);
        }
    }

    /// Idempotent while a teardown is in flight; the blocking teardown runs
    /// off the connection thread so the connection keeps draining frames
    /// meanwhile. A failed teardown re-arms, so a later request retries
    /// instead of being acknowledged without effect. A request that arrives
    /// before the handle exists is remembered and applied by the spawner
    /// right after it publishes the handle.
    pub(super) fn terminate(&self) {
        let _ = self.terminate_owned(None);
    }

    /// Terminate unless a client attached after the requester did
    /// (`attach_epoch` older than the current one). Returns `false` when
    /// the request was superseded and the session left running.
    ///
    /// The ownership check, the request flag and reading the handle happen
    /// under the claim lock that adoption and handle publication also take,
    /// so none of them can interleave with a terminate.
    pub(super) fn terminate_owned(&self, attach_epoch: Option<u64>) -> bool {
        let handle = {
            let _claim = self
                .attached
                .lock_or_recover_for_discard("PTY daemon terminate claim");
            if !self.owned_by_epoch(attach_epoch) {
                return false;
            }
            self.terminate_requested.store(true, Ordering::Release);
            self.handle.get().cloned()
        };
        let Some(handle) = handle else {
            return true;
        };
        if self.terminating.swap(true, Ordering::AcqRel) {
            return true;
        }
        let session_id = self.id.clone();
        let terminating = Arc::clone(&self.terminating);
        thread::spawn(move || {
            if let Err(error) = handle.terminate() {
                tracing::warn!(%session_id, %error, "PTY daemon session terminate failed");
                terminating.store(false, Ordering::Release);
            }
        });
        true
    }

    /// Publish the spawned handle; returns whether a terminate arrived
    /// before it existed (the spawner must then apply it).
    pub(super) fn publish_handle(&self, handle: PtyHandle) -> bool {
        let _claim = self
            .attached
            .lock_or_recover_for_discard("PTY daemon handle publication");
        let _ = self.handle.set(handle);
        self.terminate_requested()
    }

    /// Bind the spawning connection as the attached client before the
    /// session becomes visible, so listing never shows a session that is
    /// still being spawned as adoptable. Returns the first epoch.
    pub(super) fn bind_spawner(&self, link: ClientLink) -> u64 {
        let mut attached = self
            .attached
            .lock_or_recover_for_discard("PTY daemon spawn bind");
        *attached = Some(link);
        self.next_attach_epoch_claimed()
    }

    pub(super) fn terminate_requested(&self) -> bool {
        self.terminate_requested.load(Ordering::Acquire)
    }

    /// Never takes the sink lock, so listing stays responsive while a reader
    /// is blocked on a stalled client.
    pub(super) fn info(&self) -> Option<SessionInfo> {
        let attached = self.attached.lock_or_err().ok()?.is_some();
        Some(SessionInfo {
            session_id: self.id.clone(),
            terminal_id: self.terminal_id.clone(),
            created_seq: self.created_seq,
            attach_epoch: self.attach_epoch(),
            metadata: self.metadata.clone(),
            child_pid: self.handle.get().and_then(PtyHandle::child_pid),
            attached,
            exited: self.exited.load(Ordering::Acquire),
            terminating: self.terminate_requested(),
        })
    }

    pub(super) fn release_claim(&self, connection_id: u64) {
        self.forget_attached(connection_id);
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
