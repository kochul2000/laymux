//! The PTY daemon: owns OS PTYs and their children independently of any GUI.
//!
//! One connection binds to at most one session. The bound connection is that
//! session's attached client: it receives output frames and may send input,
//! resize and terminate. A connection ending — cleanly or by a GUI crash — is
//! only a detach; the session keeps running and retains a bounded backlog for
//! the next attach. Only an explicit `Terminate` (or the child exiting) ends a
//! session.

use std::collections::HashMap;
use std::io::{self, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, PtySize};

use super::discovery::tokens_match;
use super::session::{ClientLink, ConnWriter, Session};
use super::transport::{self, Listener, Stream};
use super::wire::{
    read_frame, read_frame_limited, ClientMessage, DaemonMessage, Frame, SessionInfo, WireCommand,
    PROTOCOL_VERSION,
};
use crate::constants::{
    PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_HELLO_MAX_BYTES, PTY_DAEMON_MAX_CONNECTIONS,
};
use crate::lock_ext::MutexExt;
use crate::pty::{spawn_command_on, ChildKillOwner, PtyLifecycleHooks, SpawnOptions};

const IDLE_POLL: Duration = Duration::from_millis(250);

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
}

impl DaemonServer {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            token,
            sessions: Mutex::new(HashMap::new()),
            connections: AtomicUsize::new(0),
            next_connection_id: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
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
            if self.shutdown.load(Ordering::Acquire) {
                return Ok(());
            }
            match accepted {
                Ok(stream)
                    if self.connections.load(Ordering::Acquire) >= PTY_DAEMON_MAX_CONNECTIONS =>
                {
                    // Refuse instead of queueing: an unauthenticated local flood
                    // must not exhaust threads or memory.
                    tracing::warn!("PTY daemon connection limit reached; refusing");
                    drop(stream);
                }
                Ok(stream) => {
                    let server = Arc::clone(self);
                    let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
                    self.connections.fetch_add(1, Ordering::AcqRel);
                    thread::spawn(move || {
                        server.handle_connection(stream, connection_id);
                        server.connections.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(error) => {
                    tracing::warn!(%error, "PTY daemon accept failed");
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    /// Stop accepting and wake the accept loop. Live sessions are left to the
    /// caller (`terminate_all`) because an idle shutdown has none.
    pub fn request_shutdown(&self, endpoint: &str) {
        self.shutdown.store(true, Ordering::Release);
        // Wake the blocking accept; the connection is dropped immediately.
        let _ = transport::connect(endpoint, Duration::from_millis(500));
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
        if stream
            .set_read_timeout(Some(Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS)))
            .is_err()
        {
            return;
        }
        let mut reader = BufReader::new(stream);
        if !self.authenticate(&mut reader, &writer) {
            writer.close();
            return;
        }
        if reader.get_ref().set_read_timeout(None).is_err() {
            return;
        }

        let mut bound: Option<Arc<Session>> = None;
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
                Frame::Data(bytes) => {
                    let Some(session) = bound.as_ref() else {
                        writer.error("input before a session was bound");
                        break;
                    };
                    session.write_input(&bytes, &writer);
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
                    match self.find_session(&session_id) {
                        Some(session) => session.terminate(),
                        None => writer
                            .error(&format!("PTY daemon session '{session_id}' does not exist")),
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
        match read_frame_limited::<_, ClientMessage>(reader, PTY_DAEMON_HELLO_MAX_BYTES) {
            Ok(Some(Frame::Control(ClientMessage::Hello {
                token,
                protocol_version,
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
                writer
                    .send(&DaemonMessage::HelloOk {
                        protocol_version: PROTOCOL_VERSION,
                        daemon_pid: std::process::id(),
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

fn idle_monitor(server: Weak<DaemonServer>, endpoint: String, idle_exit: Duration) {
    let mut idle_since: Option<Instant> = None;
    loop {
        thread::sleep(IDLE_POLL);
        let Some(server) = server.upgrade() else {
            return;
        };
        if server.shutdown.load(Ordering::Acquire) {
            return;
        }
        if !server.is_idle() {
            idle_since = None;
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= idle_exit {
            tracing::info!("PTY daemon idle; shutting down");
            server.request_shutdown(&endpoint);
            return;
        }
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
