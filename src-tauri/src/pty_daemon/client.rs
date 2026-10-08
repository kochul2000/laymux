//! GUI side of the PTY daemon: a `portable_pty::PtySystem` whose master and
//! child live in the daemon.
//!
//! Plugging in at the `PtySystem` seam keeps everything above it — the output
//! callback (protocol modes, OSC hooks, delivery credit), the control FIFO and
//! the `PtyHandle` lifecycle — byte-for-byte the same as an in-process PTY.
//! Each terminal uses its own connection, so one flooding terminal never
//! delays another terminal's output or control frames.

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
use super::discovery::{generate_token, handshake_proof, tokens_match};
use super::transport::{self, Stream};
use super::wire::{
    read_frame, write_control, write_input, ClientMessage, DaemonMessage, Frame, SessionInfo,
    WireCommand, PROTOCOL_VERSION,
};
use super::DaemonEndpoint;
use crate::constants::{
    PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_TERMINATE_REQUEST_TIMEOUT_MS, PTY_WRITE_CHUNK_SIZE,
};
use crate::lock_ext::MutexExt;
use crate::pty::PTY_READ_BUFFER_BYTES;

/// Open an authenticated connection to the daemon.
pub(crate) fn connect_authenticated(
    endpoint: &DaemonEndpoint,
) -> io::Result<(Stream, BufReader<Stream>)> {
    connect_authenticated_within(
        endpoint,
        Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS),
    )
}

fn connect_authenticated_within(
    endpoint: &DaemonEndpoint,
    timeout: Duration,
) -> io::Result<(Stream, BufReader<Stream>)> {
    let stream = transport::connect(&endpoint.endpoint, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let mut writer = stream.try_clone()?;
    let nonce = generate_token().map_err(io::Error::other)?;
    write_control(
        &mut writer,
        &ClientMessage::Hello {
            token: endpoint.token.clone(),
            protocol_version: PROTOCOL_VERSION,
            nonce: nonce.clone(),
        },
    )?;
    let mut reader = BufReader::new(stream);
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::HelloOk {
            protocol_version,
            proof,
            ..
        })) if protocol_version == PROTOCOL_VERSION => {
            // Whoever answers must hold the token too; otherwise it is some
            // other program on a stale endpoint and gets nothing more.
            if !tokens_match(&proof, &handshake_proof(&endpoint.token, &nonce)?) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "PTY daemon endpoint failed to prove it holds the instance token",
                ));
            }
        }
        Some(Frame::Control(DaemonMessage::Error { message })) => {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, message))
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected PTY daemon handshake reply: {other:?}"),
            ))
        }
    }
    reader.get_ref().set_read_timeout(None)?;
    writer.set_write_timeout(None)?;
    Ok((writer, reader))
}

/// List the daemon's sessions on a short-lived connection.
pub fn list_sessions(endpoint: &DaemonEndpoint) -> io::Result<Vec<SessionInfo>> {
    let (mut writer, mut reader) = connect_authenticated(endpoint)?;
    write_control(&mut writer, &ClientMessage::List)?;
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::Sessions { sessions })) => Ok(sessions),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected PTY daemon list reply: {other:?}"),
        )),
    }
}

/// Attach to `session_id`, terminate it and wait for its exit code. This is
/// the explicit way to end a session no GUI holds (for example after a GUI
/// crash); output replayed by the attach is discarded.
pub fn terminate_session(endpoint: &DaemonEndpoint, session_id: &str) -> io::Result<u32> {
    let (mut writer, mut reader) = connect_authenticated(endpoint)?;
    write_control(
        &mut writer,
        &ClientMessage::Attach {
            session_id: session_id.to_owned(),
        },
    )?;
    let mut terminate_sent = false;
    loop {
        match read_frame::<_, DaemonMessage>(&mut reader)? {
            Some(Frame::Control(DaemonMessage::Attached { .. })) if !terminate_sent => {
                write_control(&mut writer, &ClientMessage::Terminate)?;
                terminate_sent = true;
            }
            Some(Frame::Control(DaemonMessage::Exit { exit_code })) => return Ok(exit_code),
            Some(Frame::Control(DaemonMessage::Error { message })) if !terminate_sent => {
                return Err(io::Error::new(io::ErrorKind::NotFound, message))
            }
            Some(_) => {}
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "PTY daemon closed the connection before the session exited",
                ))
            }
        }
    }
}

pub struct DaemonPtySystem {
    endpoint: DaemonEndpoint,
    session_id: String,
}

impl DaemonPtySystem {
    pub fn new(endpoint: DaemonEndpoint, session_id: String) -> Self {
        Self {
            endpoint,
            session_id,
        }
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
        });
        Ok(PtyPair {
            slave: Box::new(DaemonSlave {
                connection: Arc::clone(&connection),
                session_id: self.session_id.clone(),
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
        terminate_by_id(&self.endpoint, &self.session_id)
    }
}

pub(crate) fn terminate_by_id(endpoint: &DaemonEndpoint, session_id: &str) -> io::Result<()> {
    let timeout = Duration::from_millis(PTY_DAEMON_TERMINATE_REQUEST_TIMEOUT_MS);
    let (mut writer, mut reader) = connect_authenticated_within(endpoint, timeout)?;
    reader.get_ref().set_read_timeout(Some(timeout))?;
    write_control(
        &mut writer,
        &ClientMessage::TerminateSession {
            session_id: session_id.to_owned(),
        },
    )?;
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        // An unknown session has already ended: the request is satisfied.
        Some(Frame::Control(DaemonMessage::Terminating { .. })) => Ok(()),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected PTY daemon terminate reply: {other:?}"),
        )),
    }
}

struct DaemonSlave {
    connection: Arc<Connection>,
    session_id: String,
}

impl SlavePty for DaemonSlave {
    fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let command = WireCommand::from_builder(&cmd).map_err(|error| anyhow!(error))?;
        let size = *self.connection.size.lock_or_err().map_err(|e| anyhow!(e))?;
        self.connection.send(&ClientMessage::Spawn {
            session_id: self.session_id.clone(),
            rows: size.rows,
            cols: size.cols,
            command,
        })?;
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
        let child_pid = match read_frame::<_, DaemonMessage>(&mut reader)? {
            Some(Frame::Control(DaemonMessage::Spawned { child_pid })) => child_pid,
            Some(Frame::Control(DaemonMessage::Error { message })) => {
                return Err(anyhow!("PTY daemon spawn failed: {message}"))
            }
            other => return Err(anyhow!("unexpected PTY daemon spawn reply: {other:?}")),
        };
        reader.get_ref().set_read_timeout(None)?;
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
            if let Err(error) = connection.request_terminate() {
                tracing::warn!(session_id = %connection.session_id, %error, "PTY daemon terminate request failed");
            }
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
