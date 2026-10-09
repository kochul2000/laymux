//! GUI side of the PTY daemon: a `portable_pty::PtySystem` whose master and
//! child live in the daemon.
//!
//! Plugging in at the `PtySystem` seam keeps everything above it — the output
//! callback (protocol modes, OSC hooks, delivery credit), the control FIFO and
//! the `PtyHandle` lifecycle — byte-for-byte the same as an in-process PTY.
//! Each terminal uses its own connection, so one flooding terminal never
//! delays another terminal's output or control frames.

use std::collections::BTreeMap;
use std::io::{self, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use portable_pty::{
    Child, ChildKiller, CommandBuilder, ExitStatus, InterruptiblePtyReaderPair, MasterPty, PtyPair,
    PtyReadEvent, PtySize, PtySystem, SlavePty,
};

use super::client_queue::{DaemonReader, DaemonReaderControl, Shared, CONNECTION_LOST_EXIT_CODE};
use super::control::{connect_authenticated, terminate_by_id};
use super::transport::{self, Stream};
use super::wire::{
    read_frame, write_control, write_input, ClientMessage, DaemonMessage, Frame, WireCommand,
};
use super::DaemonEndpoint;
use crate::constants::{
    PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_TERMINATE_ATTEMPTS, PTY_DAEMON_TERMINATE_RETRY_MS,
    PTY_WRITE_CHUNK_SIZE,
};
use crate::lock_ext::MutexExt;
use crate::pty::PTY_READ_BUFFER_BYTES;

/// What the daemon PTY of one terminal is bound to.
#[derive(Debug, Clone)]
enum DaemonTarget {
    /// Spawn a new child in a new session.
    Spawn {
        terminal_id: String,
        metadata: BTreeMap<String, String>,
    },
    /// Take over a session a previous GUI left running. The command handed
    /// to `spawn_command` is not run.
    Adopt,
}

pub struct DaemonPtySystem {
    endpoint: DaemonEndpoint,
    session_id: String,
    target: DaemonTarget,
    adopted_metadata: Arc<Mutex<Option<BTreeMap<String, String>>>>,
}

impl DaemonPtySystem {
    pub fn spawn(
        endpoint: DaemonEndpoint,
        session_id: String,
        terminal_id: String,
        metadata: BTreeMap<String, String>,
    ) -> Self {
        Self::with_target(
            endpoint,
            session_id,
            DaemonTarget::Spawn {
                terminal_id,
                metadata,
            },
        )
    }

    pub fn adopt(endpoint: DaemonEndpoint, session_id: String) -> Self {
        Self::with_target(endpoint, session_id, DaemonTarget::Adopt)
    }

    fn with_target(endpoint: DaemonEndpoint, session_id: String, target: DaemonTarget) -> Self {
        Self {
            endpoint,
            session_id,
            target,
            adopted_metadata: Arc::new(Mutex::new(None)),
        }
    }

    /// The metadata stored by the GUI that spawned an adopted session, once
    /// the adoption succeeded.
    pub fn adopted_metadata(&self) -> Option<BTreeMap<String, String>> {
        self.adopted_metadata.lock_or_err().ok()?.clone()
    }
}

impl PtySystem for DaemonPtySystem {
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair> {
        let (writer, reader) = connect_authenticated(&self.endpoint)
            .map_err(|error| anyhow!("PTY daemon unavailable: {error}"))?;
        let connection = Arc::new(Connection {
            writer: Mutex::new(writer),
            reader: Mutex::new(Some(reader)),
            shared: Arc::new(Shared::default()),
            size: Mutex::new(size),
            writer_taken: AtomicBool::new(false),
            endpoint: self.endpoint.clone(),
            session_id: self.session_id.clone(),
            attach_epoch: Mutex::new(None),
            owns_session_id: matches!(self.target, DaemonTarget::Spawn { .. }),
        });
        Ok(PtyPair {
            slave: Box::new(DaemonSlave {
                connection: Arc::clone(&connection),
                session_id: self.session_id.clone(),
                target: self.target.clone(),
                adopted_metadata: Arc::clone(&self.adopted_metadata),
            }),
            master: Box::new(DaemonMaster { connection }),
        })
    }
}

struct Connection {
    /// Whole-frame writes: input, resize, terminate.
    writer: Mutex<Stream>,
    /// Consumed by `spawn_command` for the reply, then by the pump thread.
    reader: Mutex<Option<BufReader<Stream>>>,
    shared: Arc<Shared>,
    size: Mutex<PtySize>,
    writer_taken: AtomicBool,
    /// Where to send a by-id terminate when this connection cannot.
    endpoint: DaemonEndpoint,
    session_id: String,
    /// Epoch this connection was bound with; a terminate carrying it cannot
    /// end the session once a newer client adopted it.
    attach_epoch: Mutex<Option<u64>>,
    /// The session id was minted for this connection's own spawn (not an
    /// adoption target), so it may be ended even before an epoch arrived.
    owns_session_id: bool,
}

impl Connection {
    fn send(&self, message: &ClientMessage) -> io::Result<()> {
        let mut writer = self.writer.lock_or_err().map_err(io::Error::other)?;
        write_control(&mut *writer, message)
    }

    /// Ask the daemon to end this session and wait for its acknowledgement.
    ///
    /// Always uses a fresh connection addressed by session id: on the
    /// terminal connection the request would queue behind input frames the
    /// daemon may be blocked writing to a child, and that connection may
    /// already be broken. The acknowledgement makes the request durable
    /// before an exiting GUI closes the socket.
    fn request_terminate(&self) -> io::Result<()> {
        let attach_epoch = *self.attach_epoch.lock_or_err().map_err(io::Error::other)?;
        // Without an epoch the bind never completed: our own spawn may still
        // have created the session (end it unconditionally), but a refused
        // adoption left someone else's session that must not be touched.
        if attach_epoch.is_none() && !self.owns_session_id {
            return Ok(());
        }
        terminate_by_id(&self.endpoint, &self.session_id, attach_epoch)
    }

    /// `request_terminate` with a few retries, for paths that cannot report
    /// failure (dropping the master).
    fn request_terminate_with_retry(&self) {
        let mut last_error = None;
        for attempt in 0..PTY_DAEMON_TERMINATE_ATTEMPTS {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(PTY_DAEMON_TERMINATE_RETRY_MS));
            }
            match self.request_terminate() {
                Ok(()) => return,
                Err(error) => last_error = Some(error),
            }
        }
        if let Some(error) = last_error {
            tracing::warn!(session_id = %self.session_id, %error, "PTY daemon terminate request failed");
        }
    }
}

struct DaemonSlave {
    connection: Arc<Connection>,
    session_id: String,
    target: DaemonTarget,
    adopted_metadata: Arc<Mutex<Option<BTreeMap<String, String>>>>,
}

impl SlavePty for DaemonSlave {
    fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let size = *self.connection.size.lock_or_err().map_err(|e| anyhow!(e))?;
        let request = match &self.target {
            DaemonTarget::Spawn {
                terminal_id,
                metadata,
            } => ClientMessage::Spawn {
                session_id: self.session_id.clone(),
                terminal_id: terminal_id.clone(),
                rows: size.rows,
                cols: size.cols,
                command: WireCommand::from_builder(&cmd).map_err(|error| anyhow!(error))?,
                metadata: metadata.clone(),
            },
            DaemonTarget::Adopt => ClientMessage::Attach {
                session_id: self.session_id.clone(),
                replay: false,
                take_over: false,
            },
        };
        self.connection.send(&request)?;
        let mut reader = self
            .connection
            .reader
            .lock_or_err()
            .map_err(|e| anyhow!(e))?
            .take()
            .ok_or_else(|| anyhow!("PTY daemon command was already spawned"))?;
        // A daemon that accepted the request but never answers must not pin
        // the terminal-creating thread forever.
        reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS)))?;
        let (child_pid, attach_epoch) = match read_frame::<_, DaemonMessage>(&mut reader)? {
            Some(Frame::Control(DaemonMessage::Spawned {
                child_pid,
                attach_epoch,
            })) => (child_pid, attach_epoch),
            Some(Frame::Control(DaemonMessage::Attached {
                child_pid,
                attach_epoch,
                metadata,
                ..
            })) if matches!(self.target, DaemonTarget::Adopt) => {
                *self
                    .adopted_metadata
                    .lock_or_err()
                    .map_err(|e| anyhow!(e))? = Some(metadata);
                (child_pid, attach_epoch)
            }
            Some(Frame::Control(DaemonMessage::Error { message })) => {
                return Err(anyhow!("PTY daemon spawn failed: {message}"))
            }
            other => return Err(anyhow!("unexpected PTY daemon spawn reply: {other:?}")),
        };
        reader.get_ref().set_read_timeout(None)?;
        *self
            .connection
            .attach_epoch
            .lock_or_err()
            .map_err(|e| anyhow!(e))? = Some(attach_epoch);
        if matches!(self.target, DaemonTarget::Adopt) {
            // The adopting GUI's grid may differ from the size the session
            // last had; apply it before any new output is produced for it.
            self.connection.send(&ClientMessage::Resize {
                rows: size.rows,
                cols: size.cols,
            })?;
        }
        let shared = Arc::clone(&self.connection.shared);
        let session_id = self.session_id.clone();
        thread::spawn(move || pump(reader, shared, session_id));
        Ok(Box::new(DaemonChild {
            connection: Arc::clone(&self.connection),
            child_pid,
        }))
    }
}

/// Route daemon frames into the reader queue and the child exit slot until
/// the daemon has reported both end-of-output and exit, or the link drops.
fn pump(mut reader: BufReader<Stream>, shared: Arc<Shared>, session_id: String) {
    let mut reader_ended = false;
    let mut child_exited = false;
    while !(reader_ended && child_exited) {
        match read_frame::<_, DaemonMessage>(&mut reader) {
            Ok(Some(Frame::Data(bytes))) => {
                for chunk in bytes.chunks(PTY_READ_BUFFER_BYTES) {
                    shared.push_data(chunk.to_vec());
                }
            }
            Ok(Some(Frame::Control(DaemonMessage::Eof))) => {
                reader_ended = true;
                shared.push_end(PtyReadEvent::Eof);
            }
            Ok(Some(Frame::Control(DaemonMessage::Exit { exit_code }))) => {
                child_exited = true;
                shared.publish_exit(exit_code);
            }
            Ok(Some(Frame::Control(DaemonMessage::Error { message }))) => {
                tracing::warn!(%session_id, %message, "PTY daemon reported an error");
            }
            Ok(Some(Frame::Control(other))) => {
                tracing::warn!(%session_id, ?other, "unexpected PTY daemon message");
            }
            Ok(None) | Err(_) => {
                tracing::warn!(%session_id, "PTY daemon connection lost");
                if !reader_ended {
                    shared.push_end(PtyReadEvent::Failure(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "PTY daemon connection lost",
                    )));
                }
                if !child_exited {
                    shared.publish_exit(CONNECTION_LOST_EXIT_CODE);
                }
                return;
            }
        }
    }
    // The daemon has reaped the session; release the link so its connection
    // thread ends without waiting for this handle to be dropped.
    transport::shutdown(reader.get_ref());
}

struct DaemonMaster {
    connection: Arc<Connection>,
}

impl MasterPty for DaemonMaster {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        self.connection.send(&ClientMessage::Resize {
            rows: size.rows,
            cols: size.cols,
        })?;
        *self.connection.size.lock_or_err().map_err(|e| anyhow!(e))? = size;
        Ok(())
    }

    fn get_size(&self) -> anyhow::Result<PtySize> {
        Ok(*self.connection.size.lock_or_err().map_err(|e| anyhow!(e))?)
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn io::Read + Send>> {
        Err(anyhow!(
            "PTY daemon output is only available through the interruptible reader"
        ))
    }

    fn try_clone_interruptible_reader(
        &self,
        terminal_generation: u64,
    ) -> anyhow::Result<Option<InterruptiblePtyReaderPair>> {
        let shared = Arc::clone(&self.connection.shared);
        Ok(Some(InterruptiblePtyReaderPair {
            reader: Box::new(DaemonReader {
                shared: Arc::clone(&shared),
            }),
            control: Box::new(DaemonReaderControl {
                shared,
                terminal_generation,
            }),
        }))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
        if self.connection.writer_taken.swap(true, Ordering::AcqRel) {
            return Err(anyhow!("PTY daemon writer was already taken"));
        }
        Ok(Box::new(DaemonWriter {
            connection: Arc::clone(&self.connection),
            last_write: None,
        }))
    }

    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<i32> {
        None
    }

    #[cfg(unix)]
    fn as_raw_fd(&self) -> Option<std::os::unix::io::RawFd> {
        None
    }
}

impl Drop for DaemonMaster {
    /// Dropping an in-process master closes the PTY and ends the shell. The
    /// handle drops its master only on terminate/fault, so mirror that
    /// intent explicitly. A GUI that dies without dropping sends nothing and
    /// the daemon keeps the session (detach).
    fn drop(&mut self) {
        // `PtyHandle` drops the master while holding its master lock; the
        // acknowledged request must not stall resize behind a network wait.
        let connection = Arc::clone(&self.connection);
        thread::spawn(move || {
            connection.request_terminate_with_retry();
        });
    }
}

struct DaemonWriter {
    connection: Arc<Connection>,
    /// When the previous input write returned. Each frame carries the pause
    /// since then so the daemon can keep gaps such as the submit CR gap
    /// (#490) that the socket's buffering would otherwise erase.
    last_write: Option<Instant>,
}

impl Write for DaemonWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let chunk = &buf[..buf.len().min(PTY_WRITE_CHUNK_SIZE)];
        let pause = self
            .last_write
            .map_or(Duration::ZERO, |last| last.elapsed());
        let mut writer = self
            .connection
            .writer
            .lock_or_err()
            .map_err(io::Error::other)?;
        write_input(&mut *writer, pause, chunk)?;
        self.last_write = Some(Instant::now());
        Ok(chunk.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct DaemonChild {
    connection: Arc<Connection>,
    child_pid: Option<u32>,
}

impl std::fmt::Debug for DaemonChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonChild")
            .field("child_pid", &self.child_pid)
            .finish()
    }
}

impl ChildKiller for DaemonChild {
    fn kill(&mut self) -> io::Result<()> {
        self.connection.request_terminate()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(DaemonKiller {
            connection: Arc::clone(&self.connection),
        })
    }
}

impl Child for DaemonChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Ok(self
            .connection
            .shared
            .exit_code()
            .map(ExitStatus::with_exit_code))
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        Ok(ExitStatus::with_exit_code(
            self.connection.shared.wait_exit(),
        ))
    }

    fn process_id(&self) -> Option<u32> {
        self.child_pid
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

struct DaemonKiller {
    connection: Arc<Connection>,
}

impl std::fmt::Debug for DaemonKiller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DaemonKiller")
    }
}

impl ChildKiller for DaemonKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.connection.request_terminate()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(DaemonKiller {
            connection: Arc::clone(&self.connection),
        })
    }
}
