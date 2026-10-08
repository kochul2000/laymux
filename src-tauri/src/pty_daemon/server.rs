//! The PTY daemon: owns OS PTYs and their children independently of any GUI.
//!
//! One connection binds to at most one session. The bound connection is that
//! session's attached client: it receives output frames and may send input,
//! resize and terminate. A connection ending — cleanly or by a GUI crash — is
//! only a detach; the session keeps running and retains a bounded backlog for
//! the next attach. Only an explicit `Terminate` (or the child exiting) ends a
//! session.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
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
    PTY_DAEMON_ACCEPT_RETRY_MS, PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_HELLO_MAX_BYTES,
    PTY_DAEMON_IDLE_POLL_MS, PTY_DAEMON_MAX_CONNECTIONS, PTY_DAEMON_SHUTDOWN_TIMEOUT_MS,
    PTY_DAEMON_WAKE_CONNECT_TIMEOUT_MS,
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
    next_session_seq: AtomicU64,
    shutdown: AtomicBool,
    /// Set by a requested shutdown: no new session is admitted while the
    /// existing ones are torn down (the accept loop keeps serving them).
    draining: AtomicBool,
    /// Serializes admitting a connection with the idle-shutdown decision, so
    /// a connection accepted just as the daemon goes idle is either counted
    /// before the decision or refused after it — never served by a daemon
    /// that is already exiting.
    admission: Mutex<()>,
    /// Own endpoint, used to wake the accept loop on a requested shutdown.
    endpoint: OnceLock<String>,
}

struct SpawnRequest {
    session_id: String,
    terminal_id: String,
    rows: u16,
    cols: u16,
    command: WireCommand,
    metadata: BTreeMap<String, String>,
}

impl DaemonServer {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            token,
            sessions: Mutex::new(HashMap::new()),
            connections: AtomicUsize::new(0),
            next_connection_id: AtomicU64::new(1),
            next_session_seq: AtomicU64::new(1),
            shutdown: AtomicBool::new(false),
            draining: AtomicBool::new(false),
            admission: Mutex::new(()),
            endpoint: OnceLock::new(),
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
        let _ = self.endpoint.set(endpoint.clone());
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
            {
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
            }
            let server = Arc::clone(self);
            let connection_id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
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

    /// Refuse new sessions, terminate every existing one (including one
    /// still being spawned, through its pending request) and wait until they
    /// are gone or the bound expires.
    pub fn shut_down_sessions(&self) {
        self.draining.store(true, Ordering::Release);
        self.terminate_all();
        let deadline = Instant::now() + Duration::from_millis(PTY_DAEMON_SHUTDOWN_TIMEOUT_MS);
        while self.session_count() > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(PTY_DAEMON_IDLE_POLL_MS));
        }
    }

    /// Request termination of every session; teardowns run concurrently.
    pub fn terminate_all(&self) {
        let sessions: Vec<_> = match self.sessions.lock_or_err() {
            Ok(sessions) => sessions.values().cloned().collect(),
            Err(_) => return,
        };
        for session in sessions {
            session.terminate();
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
                    terminal_id,
                    rows,
                    cols,
                    command,
                    metadata,
                }) if bound.is_none() => {
                    match self.spawn_session(
                        &writer,
                        connection_id,
                        SpawnRequest {
                            session_id,
                            terminal_id,
                            rows,
                            cols,
                            command,
                            metadata,
                        },
                    ) {
                        Ok(session) => bound = Some(session),
                        Err(error) => writer.error(&error),
                    }
                }
                Frame::Control(ClientMessage::Attach {
                    session_id,
                    replay,
                    take_over,
                }) if bound.is_none() => {
                    match self.attach_session(
                        &writer,
                        connection_id,
                        &session_id,
                        replay,
                        take_over,
                    ) {
                        Ok(session) => bound = Some(session),
                        Err(error) => writer.error(&error),
                    }
                }
                Frame::Control(ClientMessage::TerminateSession {
                    session_id,
                    attach_epoch,
                }) => {
                    let session = self.find_session(&session_id);
                    let superseded = session
                        .as_ref()
                        .is_some_and(|session| !session.terminate_owned(attach_epoch));
                    let reply = DaemonMessage::Terminating {
                        found: session.is_some(),
                        superseded,
                    };
                    if writer.send(&reply).is_err() {
                        break;
                    }
                }
                Frame::Control(ClientMessage::Shutdown) => {
                    tracing::info!("PTY daemon shutdown requested");
                    self.shut_down_sessions();
                    if let Some(endpoint) = self.endpoint.get() {
                        self.request_shutdown(endpoint);
                    }
                    break;
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
        request: SpawnRequest,
    ) -> Result<Arc<Session>, String> {
        let SpawnRequest {
            session_id,
            terminal_id,
            rows,
            cols,
            command,
            metadata,
        } = request;
        let command = command.into_builder()?;
        let created_seq = self.next_session_seq.fetch_add(1, Ordering::Relaxed);
        let session = Arc::new(Session::new(
            session_id.clone(),
            terminal_id,
            metadata,
            created_seq,
        ));
        let link = ClientLink {
            connection_id,
            writer: Arc::clone(writer),
        };
        let attach_epoch = session.bind_spawner(link.clone());
        {
            let mut sessions = self.sessions.lock_or_err()?;
            // A shutting-down daemon admits no new work.
            if self.draining.load(Ordering::Acquire) {
                return Err("PTY daemon is shutting down".into());
            }
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
        // A terminate that arrived while the child was being spawned.
        if session.publish_handle(handle) {
            session.terminate();
        }
        if writer
            .send(&DaemonMessage::Spawned {
                child_pid,
                attach_epoch,
            })
            .is_ok()
        {
            sink.client = Some(link);
        } else {
            // The spawner vanished before learning about its child: leave
            // the session detached rather than bound to a dead connection.
            session.release_claim(connection_id);
        }
        tracing::info!(session_id = %session.id, ?child_pid, "PTY daemon session spawned");
        Ok(Arc::clone(&session))
    }

    fn attach_session(
        &self,
        writer: &Arc<ConnWriter>,
        connection_id: u64,
        session_id: &str,
        replay: bool,
        take_over: bool,
    ) -> Result<Arc<Session>, String> {
        let session = self
            .sessions
            .lock_or_err()?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("PTY daemon session '{session_id}' does not exist"))?;
        session.attach(writer, connection_id, replay, take_over)?;
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
        thread::sleep(Duration::from_millis(PTY_DAEMON_IDLE_POLL_MS));
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
        if since.elapsed() < idle_exit {
            continue;
        }
        // Re-check under the admission lock: a connection admitted meanwhile
        // keeps the daemon alive.
        let still_idle = match server.admission.lock_or_err() {
            Ok(_admission) => {
                let idle = server.is_idle();
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
