//! Real-process tests: an in-process daemon server, real OS PTYs and shells.

use std::io::BufReader;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, PtySize, PtySystem};

use super::client::{connect_authenticated, list_sessions, DaemonPtySystem};
use super::discovery::generate_token;
use super::server::DaemonServer;
use super::transport::{Listener, Stream};
use super::wire::{
    read_frame, write_control, ClientMessage, DaemonMessage, Frame, WireCommand, PROTOCOL_VERSION,
};
use super::DaemonEndpoint;
use crate::pty::{
    spawn_command_on, ChildKillOwner, PtyLifecycleHooks, PtyOutputControl, SpawnOptions,
};

const TIMEOUT: Duration = Duration::from_secs(20);

struct TestDaemon {
    server: Arc<DaemonServer>,
    endpoint: DaemonEndpoint,
    thread: Option<JoinHandle<()>>,
    _dir: tempfile::TempDir,
}

impl TestDaemon {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let token = generate_token().unwrap();
        let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
        let server = DaemonServer::new(token.clone());
        let thread = {
            let server = Arc::clone(&server);
            let endpoint = endpoint.clone();
            std::thread::spawn(move || server.run(listener, endpoint, None).unwrap())
        };
        Self {
            server,
            endpoint: DaemonEndpoint { endpoint, token },
            thread: Some(thread),
            _dir: dir,
        }
    }

    fn wait_for_sessions(&self, count: usize) {
        let deadline = Instant::now() + TIMEOUT;
        while self.server.session_count() != count {
            assert!(
                Instant::now() < deadline,
                "daemon kept {} sessions, expected {count}",
                self.server.session_count()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for TestDaemon {
    fn drop(&mut self) {
        self.server.terminate_all();
        self.server.request_shutdown(&self.endpoint.endpoint);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn size() -> PtySize {
    PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Interactive shell plus a line whose output (`MARK_42`) differs from its
/// echoed input, so seeing it proves the command really ran.
fn interactive_shell() -> (CommandBuilder, &'static [u8]) {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/q"]);
        (command, b"echo MARK_^42\r\n")
    }
    #[cfg(unix)]
    {
        (CommandBuilder::new("/bin/sh"), b"echo MARK_$((40+2))\n")
    }
}

/// Prints `LATE_2` about a second after start, then idles.
fn delayed_printer() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args([
            "/d",
            "/c",
            "ping -n 2 127.0.0.1 >nul & echo LATE_2 & ping -n 60 127.0.0.1 >nul",
        ]);
        command
    }
    #[cfg(unix)]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 1; echo LATE_2; sleep 60"]);
        command
    }
}

fn sleeper() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"]);
        command
    }
    #[cfg(unix)]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 60"]);
        command
    }
}

/// Prints `BYE_2` and exits on its own.
fn short_lived() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "echo BYE_2"]);
        command
    }
    #[cfg(unix)]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "echo BYE_2"]);
        command
    }
}

/// Floods output forever, so a client that stops reading stalls the reader.
fn flooder() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args([
            "/d",
            "/c",
            "for /l %i in (0,0,1) do @echo FLOOD_FLOOD_FLOOD_FLOOD_FLOOD",
        ]);
        command
    }
    #[cfg(unix)]
    {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "while :; do echo FLOOD_FLOOD_FLOOD_FLOOD_FLOOD; done"]);
        command
    }
}

fn collect_until(rx: &mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
    let deadline = Instant::now() + TIMEOUT;
    let mut output = String::new();
    while !output.contains(needle) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "never saw {needle:?}; got {output:?}");
        if let Ok(data) = rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
            output.push_str(&String::from_utf8_lossy(&data));
        }
    }
    output
}

/// Raw protocol client used to act like a GUI that can vanish at any time.
fn raw_spawn(
    endpoint: &DaemonEndpoint,
    session_id: &str,
    command: CommandBuilder,
) -> (Stream, BufReader<Stream>) {
    let (mut writer, mut reader) = connect_authenticated(endpoint).unwrap();
    // A protocol bug must fail the test, not hang it.
    reader.get_ref().set_read_timeout(Some(TIMEOUT)).unwrap();
    write_control(
        &mut writer,
        &ClientMessage::Spawn {
            session_id: session_id.into(),
            rows: 24,
            cols: 80,
            command: WireCommand::from_builder(&command).unwrap(),
        },
    )
    .unwrap();
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Spawned { child_pid })) => assert!(child_pid.is_some()),
        other => panic!("unexpected spawn reply {other:?}"),
    }
    (writer, reader)
}

fn raw_attach(endpoint: &DaemonEndpoint, session_id: &str) -> (Stream, BufReader<Stream>) {
    let (mut writer, mut reader) = connect_authenticated(endpoint).unwrap();
    // A protocol bug must fail the test, not hang it.
    reader.get_ref().set_read_timeout(Some(TIMEOUT)).unwrap();
    write_control(
        &mut writer,
        &ClientMessage::Attach {
            session_id: session_id.into(),
        },
    )
    .unwrap();
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { .. })) => {}
        other => panic!("unexpected attach reply {other:?}"),
    }
    (writer, reader)
}

/// Read until `stop` says so, returning all output seen.
fn read_until(
    reader: &mut BufReader<Stream>,
    mut stop: impl FnMut(&str, Option<&DaemonMessage>) -> bool,
) -> String {
    let mut output = String::new();
    loop {
        match read_frame::<_, DaemonMessage>(reader).unwrap() {
            Some(Frame::Data(bytes)) => {
                output.push_str(&String::from_utf8_lossy(&bytes));
                if stop(&output, None) {
                    return output;
                }
            }
            Some(Frame::Control(message)) => {
                if stop(&output, Some(&message)) {
                    return output;
                }
            }
            None => panic!("daemon closed the connection; output so far {output:?}"),
        }
    }
}

#[test]
fn pty_handle_runs_a_real_shell_inside_the_daemon() {
    let daemon = TestDaemon::start();
    let system = DaemonPtySystem::new(daemon.endpoint.clone(), "pane-a#7".into());
    let (tx, rx) = mpsc::channel();
    let (command, input) = interactive_shell();
    let handle = spawn_command_on(
        &system,
        size(),
        command,
        7,
        SpawnOptions {
            wsl_backed: false,
            kill_owner: ChildKillOwner::Backend,
        },
        move |data| {
            let _ = tx.send(data);
            PtyOutputControl::Continue
        },
        PtyLifecycleHooks::default(),
    )
    .unwrap();

    let child_pid = handle
        .child_pid()
        .expect("daemon reports the real child PID");
    assert_ne!(child_pid, std::process::id());
    handle.write(input).unwrap();
    collect_until(&rx, "MARK_42");
    handle.resize(100, 30).unwrap();

    let sessions = list_sessions(&daemon.endpoint).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "pane-a#7");
    assert_eq!(sessions[0].child_pid, Some(child_pid));
    assert!(sessions[0].attached);

    // Explicit terminate is the only GUI action that ends daemon work.
    handle.terminate().unwrap();
    daemon.wait_for_sessions(0);
}

#[test]
fn a_vanished_client_only_detaches_and_reattach_replays_missed_output() {
    let daemon = TestDaemon::start();
    let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-b#1", delayed_printer());
    // Simulate a GUI crash: the connection vanishes without Terminate.
    drop(writer);
    drop(reader);

    let deadline = Instant::now() + TIMEOUT;
    loop {
        let sessions = list_sessions(&daemon.endpoint).unwrap();
        assert_eq!(sessions.len(), 1, "a disconnect must not end the session");
        if !sessions[0].attached {
            break;
        }
        assert!(Instant::now() < deadline, "session never became detached");
        std::thread::sleep(Duration::from_millis(20));
    }

    // Output produced while nobody was attached is retained, then delivered
    // ahead of live output on the next attach.
    let (mut writer, mut reader) = raw_attach(&daemon.endpoint, "pane-b#1");
    let output = read_until(&mut reader, |output, _| output.contains("LATE_2"));
    assert!(output.contains("LATE_2"));
    assert!(list_sessions(&daemon.endpoint).unwrap()[0].attached);

    write_control(&mut writer, &ClientMessage::Terminate).unwrap();
    read_until(&mut reader, |_, message| {
        matches!(message, Some(DaemonMessage::Exit { .. }))
    });
    daemon.wait_for_sessions(0);
}

#[test]
fn a_new_attach_takes_over_and_closes_the_previous_client() {
    let daemon = TestDaemon::start();
    let (_old_writer, mut old_reader) = raw_spawn(&daemon.endpoint, "pane-c#1", sleeper());
    let (mut writer, mut reader) = raw_attach(&daemon.endpoint, "pane-c#1");

    let ended = match read_frame::<_, DaemonMessage>(&mut old_reader) {
        Ok(None) | Err(_) => true,
        Ok(Some(_)) => false,
    };
    assert!(ended, "the superseded client must be disconnected");
    assert!(list_sessions(&daemon.endpoint).unwrap()[0].attached);

    write_control(&mut writer, &ClientMessage::Terminate).unwrap();
    read_until(&mut reader, |_, message| {
        matches!(message, Some(DaemonMessage::Exit { .. }))
    });
    daemon.wait_for_sessions(0);
}

#[test]
fn duplicate_session_ids_are_refused_without_touching_the_live_one() {
    let daemon = TestDaemon::start();
    let (mut writer, mut reader) = raw_spawn(&daemon.endpoint, "pane-d#1", sleeper());

    let (mut dup_writer, mut dup_reader) = connect_authenticated(&daemon.endpoint).unwrap();
    write_control(
        &mut dup_writer,
        &ClientMessage::Spawn {
            session_id: "pane-d#1".into(),
            rows: 24,
            cols: 80,
            command: WireCommand::from_builder(&sleeper()).unwrap(),
        },
    )
    .unwrap();
    match read_frame::<_, DaemonMessage>(&mut dup_reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Error { message })) => {
            assert!(message.contains("already exists"), "{message}")
        }
        other => panic!("unexpected duplicate spawn reply {other:?}"),
    }
    assert_eq!(daemon.server.session_count(), 1);

    write_control(&mut writer, &ClientMessage::Terminate).unwrap();
    read_until(&mut reader, |_, message| {
        matches!(message, Some(DaemonMessage::Exit { .. }))
    });
    daemon.wait_for_sessions(0);
}

#[test]
fn wrong_token_and_wrong_protocol_are_rejected_before_any_request() {
    let daemon = TestDaemon::start();
    let forged = DaemonEndpoint {
        endpoint: daemon.endpoint.endpoint.clone(),
        token: generate_token().unwrap(),
    };
    let error = connect_authenticated(&forged).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);

    let mut stream =
        super::transport::connect(&daemon.endpoint.endpoint, Duration::from_secs(5)).unwrap();
    write_control(
        &mut stream,
        &ClientMessage::Hello {
            token: daemon.endpoint.token.clone(),
            protocol_version: PROTOCOL_VERSION + 1,
        },
    )
    .unwrap();
    let mut reader = BufReader::new(stream);
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Error { message })) => {
            assert!(message.contains("protocol"), "{message}")
        }
        other => panic!("unexpected reply {other:?}"),
    }
    assert!(list_sessions(&forged).is_err());
    assert_eq!(daemon.server.session_count(), 0);
}

#[test]
fn an_exit_time_terminate_request_ends_the_session_without_any_cleanup() {
    let daemon = TestDaemon::start();
    let system = DaemonPtySystem::new(daemon.endpoint.clone(), "pane-e#1".into());
    let handle = spawn_command_on(
        &system,
        size(),
        sleeper(),
        1,
        SpawnOptions {
            wsl_backed: false,
            kill_owner: ChildKillOwner::Backend,
        },
        |_| PtyOutputControl::Continue,
        PtyLifecycleHooks::default(),
    )
    .unwrap();

    // App exit runs no destructors: the request alone must end the work.
    handle.request_backend_termination().unwrap();
    std::mem::forget(handle);
    daemon.wait_for_sessions(0);
}

#[test]
fn a_child_that_exits_on_its_own_delivers_its_output_and_is_reaped() {
    let daemon = TestDaemon::start();
    let (_writer, mut reader) = raw_spawn(&daemon.endpoint, "pane-f#1", short_lived());
    let mut saw_eof = false;
    let mut saw_exit = false;
    let output = read_until(&mut reader, |_, message| {
        saw_eof |= matches!(message, Some(DaemonMessage::Eof));
        saw_exit |= matches!(message, Some(DaemonMessage::Exit { .. }));
        saw_eof && saw_exit
    });
    assert!(output.contains("BYE_2"), "{output:?}");
    daemon.wait_for_sessions(0);
}

#[test]
fn a_stalled_client_does_not_block_listing_or_a_takeover_attach() {
    let daemon = TestDaemon::start();
    // Spawn and never read again: the socket fills and the daemon's PTY
    // reader blocks inside its output write.
    let (_stalled_writer, _stalled_reader) = raw_spawn(&daemon.endpoint, "pane-g#1", flooder());
    std::thread::sleep(Duration::from_millis(1500));

    let (tx, rx) = mpsc::channel();
    let endpoint = daemon.endpoint.clone();
    std::thread::spawn(move || {
        let listed = list_sessions(&endpoint).map(|s| s.len());
        let (mut writer, mut reader) = raw_attach(&endpoint, "pane-g#1");
        // Ends on the first data frame; EOF or a read error fails the test
        // through the missing channel message instead of spinning.
        loop {
            match read_frame::<_, DaemonMessage>(&mut reader) {
                Ok(Some(Frame::Data(_))) => break,
                Ok(Some(Frame::Control(_))) => {}
                Ok(None) | Err(_) => return,
            }
        }
        write_control(&mut writer, &ClientMessage::Terminate).unwrap();
        let _ = tx.send(listed.ok());
    });
    let listed = rx
        .recv_timeout(TIMEOUT)
        .expect("list/attach must not wait behind the stalled client");
    assert_eq!(listed, Some(1));
    daemon.wait_for_sessions(0);
}

#[test]
fn terminate_by_session_id_works_from_a_fresh_connection() {
    let daemon = TestDaemon::start();
    let (_writer, mut reader) = raw_spawn(&daemon.endpoint, "pane-h#1", sleeper());
    super::client::terminate_by_id(&daemon.endpoint, "pane-h#1").unwrap();
    // An unknown session already satisfies the request.
    super::client::terminate_by_id(&daemon.endpoint, "no-such-pane#1").unwrap();
    read_until(&mut reader, |_, message| {
        matches!(message, Some(DaemonMessage::Exit { .. }))
    });
    daemon.wait_for_sessions(0);
}

#[test]
fn an_oversized_frame_before_authentication_is_refused_without_reading_it() {
    let daemon = TestDaemon::start();
    let mut stream =
        super::transport::connect(&daemon.endpoint.endpoint, Duration::from_secs(5)).unwrap();
    // Announce a body larger than the pre-auth limit; the daemon must close
    // instead of allocating and waiting for it.
    let body_len = (crate::constants::PTY_DAEMON_HELLO_MAX_BYTES + 1) as u32;
    std::io::Write::write_all(&mut stream, &body_len.to_le_bytes()).unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    let mut reader = BufReader::new(stream);
    match read_frame::<_, DaemonMessage>(&mut reader) {
        Ok(Some(Frame::Control(DaemonMessage::Error { .. }))) | Ok(None) | Err(_) => {}
        other => panic!("oversized hello must be refused, got {other:?}"),
    }
    assert_eq!(daemon.server.session_count(), 0);
}

#[test]
fn a_daemon_that_never_answers_spawn_fails_the_spawn_instead_of_hanging() {
    // A fake daemon that authenticates and then goes silent.
    let dir = tempfile::tempdir().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    let token = generate_token().unwrap();
    std::thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        let _hello = read_frame::<_, ClientMessage>(&mut reader);
        write_control(
            &mut writer,
            &DaemonMessage::HelloOk {
                protocol_version: PROTOCOL_VERSION,
                daemon_pid: 0,
            },
        )
        .unwrap();
        let _spawn = read_frame::<_, ClientMessage>(&mut reader);
        std::thread::sleep(Duration::from_secs(30));
        drop(writer);
    });
    let system = DaemonPtySystem::new(DaemonEndpoint { endpoint, token }, "pane-i#1".into());
    let started = Instant::now();
    let pair = system.openpty(size()).unwrap();
    assert!(pair.slave.spawn_command(sleeper()).is_err());
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn app_exit_ends_daemon_terminals_registered_in_app_state() {
    let daemon = TestDaemon::start();
    let state = crate::state::AppState::new();
    for index in 0..3 {
        let system = DaemonPtySystem::new(daemon.endpoint.clone(), format!("pane-j{index}#1"));
        let handle = spawn_command_on(
            &system,
            size(),
            sleeper(),
            1,
            SpawnOptions {
                wsl_backed: false,
                kill_owner: ChildKillOwner::Backend,
            },
            |_| PtyOutputControl::Continue,
            PtyLifecycleHooks::default(),
        )
        .unwrap();
        state
            .pty_handles
            .lock()
            .unwrap()
            .insert(format!("pane-j{index}"), handle);
    }
    daemon.wait_for_sessions(3);

    state.terminate_daemon_sessions_on_exit();
    // The process would exit here without running any destructor.
    std::mem::forget(state);
    daemon.wait_for_sessions(0);
}
