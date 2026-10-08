//! The PTY daemon: owns OS PTYs and their children independently of any GUI.
//!
//! One connection binds to at most one session. The bound connection is that
//! session's attached client: it receives output frames and may send input,
//! resize and terminate. A connection ending — cleanly or by a GUI crash — is
//! only a detach; the session keeps running and retains a bounded backlog for
//! the next attach. Only an explicit `Terminate` (or the child exiting) ends a
//! session.

use std::collections::HashMap;
use std::io::{self, BufReader, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, PtySize};

use super::discovery::{handshake_proof, tokens_match};
use super::session::{ClientLink, ConnWriter, Session};
use super::transport::{self, Listener, Stream};
use super::wire::{
    read_frame, read_frame_limited, split_input, ClientMessage, DaemonMessage, Frame, SessionInfo,
    WireCommand, PROTOCOL_VERSION,
};
use crate::constants::{
    PTY_DAEMON_ACCEPT_RETRY_MS, PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_HELLO_MAX_BYTES,
    PTY_DAEMON_IDLE_POLL_MS, PTY_DAEMON_MAX_CONNECTIONS, PTY_DAEMON_WAKE_CONNECT_TIMEOUT_MS,
};
use crate::lock_ext::MutexExt;
use crate::pty::{spawn_command_on, ChildKillOwner, PtyLifecycleHooks, SpawnOptions};

/// Daemon sessions are created once and never respawned in place, so every
/// native PTY runs as reader generation 1. The client-visible identity is the
/// session key, which already carries the GUI's terminal generation.
const DAEMON_PTY_GENERATION: u64 = 1;

pub struct DaemonServer {
    token: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    connections: AtomicUsize,
    next_connection_id: AtomicU64,
    shutdown: AtomicBool,
    /// Serializes admitting a connection with the idle-shutdown decision, so
    /// a connection accepted just as the daemon goes idle is either counted
    /// before the decision or refused after it — never served by a daemon
    /// that is already exiting.
    admission: Mutex<()>,
}

impl DaemonServer {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            token,
            sessions: Mutex::new(HashMap::new()),
            connections: AtomicUsize::new(0),
            next_connection_id: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
            admission: Mutex::new(()),
        })
    }

    /// Serve until shut down. With `idle_exit`, the daemon stops by itself
    /// once it has had no session and no connection for that long.
    pub fn run(
        self: &Arc<Self>,
        listener: Listener,
        endpoint: String,
        idle_exit: Option<Duration>,
    ) -> io::Result<()> {
        if let Some(idle_exit) = idle_exit {
            let server = Arc::downgrade(self);
            let endpoint = endpoint.clone();
            thread::spawn(move || idle_monitor(server, endpoint, idle_exit));
        }
        loop {
            let accepted = listener.accept();
            let stream = match accepted {
                Ok(stream) => stream,
                Err(error) => {
                    if self.shutdown.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    tracing::warn!(%error, "PTY daemon accept failed");
                    thread::sleep(Duration::from_millis(PTY_DAEMON_ACCEPT_RETRY_MS));
                    continue;
                }
            };
            let connection_id = {
                let _admission = self.admission.lock_or_err().map_err(io::Error::other)?;
                if self.shutdown.load(Ordering::Acquire) {
                    return Ok(());
                }
                if self.connections.load(Ordering::Acquire) >= PTY_DAEMON_MAX_CONNECTIONS {
                    // Refuse instead of queueing: an unauthenticated local
                    // flood must not exhaust threads or memory.
                    tracing::warn!("PTY daemon connection limit reached; refusing");
                    continue;
                }
                self.connections.fetch_add(1, Ordering::AcqRel);
                // Allocated under the admission lock so the idle monitor can
                // also see connections that came and went between its polls.
                self.next_connection_id.fetch_add(1, Ordering::AcqRel)
            };
            let server = Arc::clone(self);
            thread::spawn(move || {
                server.handle_connection(stream, connection_id);
                server.connections.fetch_sub(1, Ordering::AcqRel);
            });
        }
    }

    /// Stop accepting and wake the accept loop. Live sessions are left to the
    /// caller (`terminate_all`) because an idle shutdown has none.
    pub fn request_shutdown(&self, endpoint: &str) {
        self.shutdown.store(true, Ordering::Release);
        // Wake the blocking accept; the connection is dropped immediately.
        let _ = transport::connect(
            endpoint,
            Duration::from_millis(PTY_DAEMON_WAKE_CONNECT_TIMEOUT_MS),
        );
    }

    #[cfg(test)]
    pub fn terminate_all(&self) {
        let sessions: Vec<_> = match self.sessions.lock_or_err() {
            Ok(sessions) => sessions.values().cloned().collect(),
            Err(_) => return,
        };
        for session in sessions {
            if let Some(handle) = session.handle.get() {
                let _ = handle.terminate();
            }
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.lock_or_err().map(|s| s.len()).unwrap_or(0)
    }

    fn is_idle(&self) -> bool {
        self.connections.load(Ordering::Acquire) == 0 && self.session_count() == 0
    }

    fn handle_connection(self: &Arc<Self>, stream: Stream, connection_id: u64) {
        let writer = match ConnWriter::new(&stream) {
            Ok(writer) => Arc::new(writer),
            Err(error) => {
                tracing::warn!(%error, "PTY daemon could not clone a connection");
                return;
            }
        };
        let mut reader = BufReader::new(stream);
        if !self.authenticate(&mut reader, &writer) {
            writer.close();
            return;
        }
        if reader.get_ref().set_read_timeout(None).is_err() {
            return;
        }

        let mut bound: Option<Arc<Session>> = None;
        // When this connection's previous input reached the PTY.
        let mut last_input: Option<Instant> = None;
        loop {
            let frame = match read_frame::<_, ClientMessage>(&mut reader) {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(error) => {
                    tracing::debug!(connection_id, %error, "PTY daemon connection ended");
                    break;
                }
            };
            match frame {
                Frame::Data(payload) => {
                    let Some(session) = bound.as_ref() else {
                        writer.error("input before a session was bound");
                        break;
                    };
                    let (pause, data) = match split_input(&payload) {
                        Ok(input) => input,
                        Err(error) => {
                            writer.error(&error.to_string());
                            break;
                        }
                    };
                    let delay = input_delay(pause, last_input.map(|at| at.elapsed()));
                    if !delay.is_zero() {
                        thread::sleep(delay);
                    }
                    session.write_input(data, &writer);
                    last_input = Some(Instant::now());
                }
                Frame::Control(ClientMessage::Spawn {
                    session_id,
                    rows,
                    cols,
                    command,
                }) if bound.is_none() => {
                    match self.spawn_session(
                        &writer,
                        connection_id,
                        session_id,
                        rows,
                        cols,
                        command,
                    ) {
                        Ok(session) => bound = Some(session),
                        Err(error) => writer.error(&error),
                    }
                }
                Frame::Control(ClientMessage::Attach { session_id }) if bound.is_none() => {
                    match self.attach_session(&writer, connection_id, &session_id) {
                        Ok(session) => bound = Some(session),
                        Err(error) => writer.error(&error),
                    }
                }
                Frame::Control(ClientMessage::TerminateSession { session_id }) => {
                    let session = self.find_session(&session_id);
                    if let Some(session) = session.as_ref() {
                        session.terminate();
                    }
                    let found = session.is_some();
                    if writer.send(&DaemonMessage::Terminating { found }).is_err() {
                        break;
                    }
                }
                Frame::Control(ClientMessage::List) => {
                    let sessions = self.list_sessions();
                    if writer.send(&DaemonMessage::Sessions { sessions }).is_err() {
                        break;
                    }
                }
                Frame::Control(ClientMessage::Resize { rows, cols }) => match bound.as_ref() {
                    Some(session) => session.resize(rows, cols, &writer),
                    None => writer.error("resize before a session was bound"),
                },
                Frame::Control(ClientMessage::Terminate) => match bound.as_ref() {
                    Some(session) => session.terminate(),
                    None => writer.error("terminate before a session was bound"),
                },
                Frame::Control(other) => {
                    writer.error(&format!("unexpected PTY daemon message {other:?}"));
                }
            }
        }
        if let Some(session) = bound {
            session.detach(connection_id);
        }
    }

    fn authenticate(&self, reader: &mut BufReader<Stream>, writer: &ConnWriter) -> bool {
        let mut reader = HandshakeReader {
            inner: reader,
            deadline: Instant::now() + Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS),
        };
        match read_frame_limited::<_, ClientMessage>(&mut reader, PTY_DAEMON_HELLO_MAX_BYTES) {
            Ok(Some(Frame::Control(ClientMessage::Hello {
                token,
                protocol_version,
                nonce,
            }))) => {
                if !tokens_match(&token, &self.token) {
                    writer.error("PTY daemon authentication failed");
                    return false;
                }
                if protocol_version != PROTOCOL_VERSION {
                    writer.error(&format!(
                        "PTY daemon protocol {PROTOCOL_VERSION} cannot serve client protocol {protocol_version}"
                    ));
                    return false;
                }
                let Ok(proof) = handshake_proof(&self.token, &nonce) else {
                    writer.error("PTY daemon could not prove its identity");
                    return false;
                };
                writer
                    .send(&DaemonMessage::HelloOk {
                        protocol_version: PROTOCOL_VERSION,
                        daemon_pid: std::process::id(),
                        proof,
                    })
                    .is_ok()
            }
            _ => {
                writer.error("PTY daemon handshake expected hello");
                false
            }
        }
    }

    fn spawn_session(
        self: &Arc<Self>,
        writer: &Arc<ConnWriter>,
        connection_id: u64,
        session_id: String,
        rows: u16,
        cols: u16,
        command: WireCommand,
    ) -> Result<Arc<Session>, String> {
        let command = command.into_builder()?;
        let session = Arc::new(Session::new(session_id.clone()));
        {
            let mut sessions = self.sessions.lock_or_err()?;
            if sessions.contains_key(&session_id) {
                return Err(format!("PTY daemon session '{session_id}' already exists"));
            }
            sessions.insert(session_id.clone(), Arc::clone(&session));
        }

        // Hold the sink across spawn so `Spawned` is the first frame the
        // client sees: early output and exit callbacks wait on this lock.
        let mut sink = session.sink.lock_or_err()?;
        let output_session = Arc::clone(&session);
        let reader_end = (Arc::downgrade(self), Arc::clone(&session));
        let child_exit = (Arc::downgrade(self), Arc::clone(&session));
        let spawned = spawn_command_on(
            native_pty_system().as_ref(),
            PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            },
            command,
            DAEMON_PTY_GENERATION,
            SpawnOptions {
                wsl_backed: false,
                kill_owner: ChildKillOwner::Local,
            },
            move |data| output_session.deliver_output(&data),
            PtyLifecycleHooks {
                on_reader_end: Some(Box::new(move || {
                    let (server, session) = reader_end;
                    session.mark_reader_ended();
                    reap_if_done(&server, &session);
                })),
                on_child_exit: Some(Box::new(move |exit_code| {
                    let (server, session) = child_exit;
                    session.mark_child_exited(exit_code);
                    // Nobody else closes this PTY after a natural exit, and
                    // ConPTY keeps its output open until the master closes.
                    if let Some(handle) = session.handle.get() {
                        handle.release_after_child_exit();
                    }
                    reap_if_done(&server, &session);
                })),
            },
        );
        let handle = match spawned {
            Ok(handle) => handle,
            Err(error) => {
                drop(sink);
                self.remove_session(&session);
                return Err(error);
            }
        };
        let child_pid = handle.child_pid();
        let _ = session.handle.set(handle);
        // A terminate that arrived while the child was being spawned.
        if session.terminate_requested() {
            session.terminate();
        }
        if writer.send(&DaemonMessage::Spawned { child_pid }).is_ok() {
            let link = ClientLink {
                connection_id,
                writer: Arc::clone(writer),
            };
            sink.client = Some(link.clone());
            *session.attached.lock_or_err()? = Some(link);
        }
        tracing::info!(session_id = %session.id, ?child_pid, "PTY daemon session spawned");
        Ok(Arc::clone(&session))
    }

    fn attach_session(
        &self,
        writer: &Arc<ConnWriter>,
        connection_id: u64,
        session_id: &str,
    ) -> Result<Arc<Session>, String> {
        let session = self
            .sessions
            .lock_or_err()?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("PTY daemon session '{session_id}' does not exist"))?;
        session.attach(writer, connection_id)?;
        Ok(session)
    }

    fn find_session(&self, session_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock_or_err().ok()?.get(session_id).cloned()
    }

    fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions: Vec<_> = match self.sessions.lock_or_err() {
            Ok(sessions) => sessions.values().cloned().collect(),
            Err(_) => return Vec::new(),
        };
        let mut infos: Vec<_> = sessions.iter().filter_map(|s| s.info()).collect();
        infos.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        infos
    }

    fn remove_session(&self, session: &Arc<Session>) {
        if let Ok(mut sessions) = self.sessions.lock_or_err() {
            if sessions
                .get(&session.id)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(&session.id);
            }
        }
    }
}

/// Reads the handshake against one deadline for the whole exchange. A plain
/// socket read timeout restarts on every byte, so a client trickling its
/// hello could hold a connection slot indefinitely.
struct HandshakeReader<'a> {
    inner: &'a mut BufReader<Stream>,
    deadline: Instant,
}

impl Read for HandshakeReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "PTY daemon handshake deadline passed",
            ));
        }
        self.inner.get_ref().set_read_timeout(Some(remaining))?;
        self.inner.read(buf)
    }
}

/// How long to hold an input frame before writing it to the PTY so the
/// client's pause before it survives socket buffering. `since_last` is the
/// time since this connection's previous input reached the PTY; frames that
/// arrive already spaced by their pause wait for nothing.
pub(super) fn input_delay(pause: Duration, since_last: Option<Duration>) -> Duration {
    since_last.map_or(Duration::ZERO, |since| pause.saturating_sub(since))
}

fn idle_monitor(server: Weak<DaemonServer>, endpoint: String, idle_exit: Duration) {
    let mut idle_since: Option<Instant> = None;
    // A connection that opened and closed between two polls (a GUI's probe
    // right before it opens a terminal connection) still counts as activity.
    let mut seen_admissions = 0;
    loop {
        thread::sleep(Duration::from_millis(PTY_DAEMON_IDLE_POLL_MS));
        let Some(server) = server.upgrade() else {
            return;
        };
        if server.shutdown.load(Ordering::Acquire) {
            return;
        }
        let admissions = server.next_connection_id.load(Ordering::Acquire);
        if !server.is_idle() || admissions != seen_admissions {
            seen_admissions = admissions;
            idle_since = None;
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() < idle_exit {
            continue;
        }
        // Re-check under the admission lock: a connection admitted meanwhile
        // keeps the daemon alive.
        let still_idle = match server.admission.lock_or_err() {
            Ok(_admission) => {
                let idle = server.is_idle()
                    && server.next_connection_id.load(Ordering::Acquire) == seen_admissions;
                if idle {
                    server.shutdown.store(true, Ordering::Release);
                }
                idle
            }
            Err(_) => false,
        };
        if still_idle {
            tracing::info!("PTY daemon idle; shutting down");
            server.request_shutdown(&endpoint);
            return;
        }
        idle_since = None;
    }
}

fn reap_if_done(server: &Weak<DaemonServer>, session: &Arc<Session>) {
    if !session.is_finished() {
        return;
    }
    if let Some(server) = server.upgrade() {
        server.remove_session(session);
        tracing::info!(session_id = %session.id, "PTY daemon session ended");
    }
}
