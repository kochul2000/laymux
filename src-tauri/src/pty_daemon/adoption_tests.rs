//! GUI lifecycle across the daemon: app exit, re-adoption by a new GUI,
//! attach epochs, replay policy and shutdown.

use std::collections::BTreeMap;
use std::io::BufReader;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(unix)]
use portable_pty::CommandBuilder;

use super::client::DaemonPtySystem;
use super::control::{connect_authenticated, list_sessions};
use super::session::{ConnWriter, Session};
use super::tests::{
    collect_until, delayed_printer, interactive_shell, raw_spawn, read_until, size, sleeper,
    spawning, TestDaemon, TIMEOUT,
};
use super::transport::{self, Listener, Stream};
use super::wire::{read_frame, write_control, ClientMessage, DaemonMessage, Frame, WireCommand};
use super::DaemonEndpoint;
use crate::pty::{
    spawn_command_on, ChildKillOwner, PtyLifecycleHooks, PtyOutputControl, SpawnOptions,
};
#[cfg(unix)]
use crate::terminal_protocol::TerminalProtocolState;

fn wait_detached(endpoint: &DaemonEndpoint, session_id: &str) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let detached = list_sessions(endpoint)
            .unwrap()
            .into_iter()
            .any(|session| session.session_id == session_id && !session.attached);
        if detached {
            return;
        }
        assert!(Instant::now() < deadline, "{session_id} never detached");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn adoption_continues_the_same_child_and_returns_the_spawners_metadata() {
    let daemon = TestDaemon::start();
    let (command, input) = interactive_shell();
    let (mut writer, mut reader) = connect_authenticated(&daemon.endpoint).unwrap();
    write_control(
        &mut writer,
        &ClientMessage::Spawn {
            session_id: "pane-k#1-a".into(),
            terminal_id: "pane-k".into(),
            rows: 24,
            cols: 80,
            command: WireCommand::from_builder(&command).unwrap(),
            metadata: BTreeMap::from([("agentHookToken".to_owned(), "tok-1".to_owned())]),
        },
    )
    .unwrap();
    let original_pid = match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Spawned { child_pid, .. })) => child_pid,
        other => panic!("unexpected spawn reply {other:?}"),
    };
    // The spawning GUI disappears.
    drop(writer);
    drop(reader);
    wait_detached(&daemon.endpoint, "pane-k#1-a");

    let system = DaemonPtySystem::adopt(daemon.endpoint.clone(), "pane-k#1-a".into());
    let (tx, rx) = mpsc::channel();
    // The command is ignored on adoption; a different one proves it.
    let handle = spawn_command_on(
        &system,
        size(),
        sleeper(),
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
    assert_eq!(handle.child_pid(), original_pid);
    assert_eq!(
        system
            .adopted_metadata()
            .and_then(|metadata| metadata.get("agentHookToken").cloned()),
        Some("tok-1".to_owned())
    );
    assert!(list_sessions(&daemon.endpoint).unwrap()[0].attached);

    // Input and output flow to the adopted child.
    handle.write(input).unwrap();
    collect_until(&rx, "MARK_42");
    handle.terminate().unwrap();
    daemon.wait_for_sessions(0);
}

#[test]
fn attach_without_replay_discards_detached_output() {
    let daemon = TestDaemon::start();
    let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-l#1", delayed_printer());
    drop(writer);
    drop(reader);
    wait_detached(&daemon.endpoint, "pane-l#1");
    // Let the child print while nobody is attached.
    std::thread::sleep(Duration::from_millis(2500));

    let (mut writer, mut reader) = connect_authenticated(&daemon.endpoint).unwrap();
    reader.get_ref().set_read_timeout(Some(TIMEOUT)).unwrap();
    write_control(
        &mut writer,
        &ClientMessage::Attach {
            session_id: "pane-l#1".into(),
            replay: false,
            take_over: true,
        },
    )
    .unwrap();
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { dropped_bytes, .. })) => {
            assert!(
                dropped_bytes > 0,
                "the detached output must be counted as dropped"
            )
        }
        other => panic!("unexpected attach reply {other:?}"),
    }
    write_control(&mut writer, &ClientMessage::Terminate).unwrap();
    let output = read_until(&mut reader, |_, message| {
        matches!(message, Some(DaemonMessage::Exit { .. }))
    });
    assert!(
        !output.contains("LATE_2"),
        "replay must not deliver {output:?}"
    );
    daemon.wait_for_sessions(0);
}

#[test]
fn shutdown_ends_every_session_and_stops_the_daemon() {
    let mut daemon = TestDaemon::start();
    let (_first, _first_reader) = raw_spawn(&daemon.endpoint, "pane-m#1", sleeper());
    let (_second, _second_reader) = raw_spawn(&daemon.endpoint, "pane-n#1", sleeper());

    let (mut writer, _reader) = connect_authenticated(&daemon.endpoint).unwrap();
    write_control(&mut writer, &ClientMessage::Shutdown).unwrap();
    let thread = daemon.thread.take().unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while !thread.is_finished() {
        assert!(Instant::now() < deadline, "daemon accept loop kept running");
        std::thread::sleep(Duration::from_millis(20));
    }
    thread.join().unwrap();
    daemon.wait_for_sessions(0);
}

#[test]
fn an_adopting_attach_is_refused_while_another_client_holds_the_session() {
    let daemon = TestDaemon::start();
    let (mut writer, mut reader) = raw_spawn(&daemon.endpoint, "pane-o#1", sleeper());
    let (mut adopter, mut adopter_reader) = connect_authenticated(&daemon.endpoint).unwrap();
    adopter_reader
        .get_ref()
        .set_read_timeout(Some(TIMEOUT))
        .unwrap();
    write_control(
        &mut adopter,
        &ClientMessage::Attach {
            session_id: "pane-o#1".into(),
            replay: false,
            take_over: false,
        },
    )
    .unwrap();
    match read_frame::<_, DaemonMessage>(&mut adopter_reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Error { .. })) => {}
        other => panic!("adoption of a held session must be refused, got {other:?}"),
    }
    assert!(list_sessions(&daemon.endpoint).unwrap()[0].attached);

    write_control(&mut writer, &ClientMessage::Terminate).unwrap();
    read_until(&mut reader, |_, message| {
        matches!(message, Some(DaemonMessage::Exit { .. }))
    });
    daemon.wait_for_sessions(0);
}

#[test]
fn a_terminate_from_the_previous_owner_cannot_end_an_adopted_session() {
    let daemon = TestDaemon::start();
    let (writer, mut reader) = connect_authenticated(&daemon.endpoint).unwrap();
    let mut writer = writer;
    write_control(
        &mut writer,
        &ClientMessage::Spawn {
            session_id: "pane-p#1".into(),
            terminal_id: "pane-p".into(),
            rows: 24,
            cols: 80,
            command: WireCommand::from_builder(&sleeper()).unwrap(),
            metadata: BTreeMap::new(),
        },
    )
    .unwrap();
    let first_epoch = match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Spawned { attach_epoch, .. })) => attach_epoch,
        other => panic!("unexpected spawn reply {other:?}"),
    };
    drop(writer);
    drop(reader);
    wait_detached(&daemon.endpoint, "pane-p#1");

    let (mut adopter, mut adopter_reader) = connect_authenticated(&daemon.endpoint).unwrap();
    adopter_reader
        .get_ref()
        .set_read_timeout(Some(TIMEOUT))
        .unwrap();
    write_control(
        &mut adopter,
        &ClientMessage::Attach {
            session_id: "pane-p#1".into(),
            replay: false,
            take_over: false,
        },
    )
    .unwrap();
    let adopted_epoch = match read_frame::<_, DaemonMessage>(&mut adopter_reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { attach_epoch, .. })) => attach_epoch,
        other => panic!("unexpected attach reply {other:?}"),
    };
    assert!(adopted_epoch > first_epoch);

    // The old owner's late request is acknowledged but leaves the work alone.
    super::control::terminate_by_id(&daemon.endpoint, "pane-p#1", Some(first_epoch)).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let session = list_sessions(&daemon.endpoint).unwrap().remove(0);
    assert!(!session.terminating && !session.exited);

    super::control::terminate_by_id(&daemon.endpoint, "pane-p#1", Some(adopted_epoch)).unwrap();
    daemon.wait_for_sessions(0);
}

#[test]
fn app_exit_ends_daemon_terminals_registered_in_app_state() {
    let daemon = TestDaemon::start();
    let state = crate::state::AppState::new();
    for index in 0..3 {
        let system = spawning(daemon.endpoint.clone(), format!("pane-j{index}#1"));
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

/// Turns on bracketed paste about a second after start, then idles. Unix
/// only: test binaries do not sit next to the bundled ConPTY, and the inbox
/// conhost they fall back to swallows DECSET 2004 instead of passing it on.
#[cfg(unix)]
fn late_bracketed_paste() -> CommandBuilder {
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "sleep 1; printf '\\033[?2004h'; sleep 60"]);
    command
}

#[cfg(unix)]
#[test]
fn an_adopting_attach_reasserts_modes_set_while_detached() {
    let daemon = TestDaemon::start();
    let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-r#1", late_bracketed_paste());
    drop(writer);
    drop(reader);
    wait_detached(&daemon.endpoint, "pane-r#1");
    // The mode is set while nobody is attached.
    std::thread::sleep(Duration::from_millis(4000));

    let (mut writer, mut reader) = connect_authenticated(&daemon.endpoint).unwrap();
    reader.get_ref().set_read_timeout(Some(TIMEOUT)).unwrap();
    write_control(
        &mut writer,
        &ClientMessage::Attach {
            session_id: "pane-r#1".into(),
            replay: false,
            take_over: false,
        },
    )
    .unwrap();
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { .. })) => {}
        other => panic!("unexpected attach reply {other:?}"),
    }
    // The first output a fresh GUI parses re-asserts the mode.
    let preamble = match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Data(bytes)) => bytes,
        other => panic!("expected the mode preamble, got {other:?}"),
    };
    let mut protocol = TerminalProtocolState::new();
    protocol.process_output(&preamble);
    assert!(
        protocol.bracketed_paste(),
        "preamble {:?} must turn on bracketed paste",
        String::from_utf8_lossy(&preamble)
    );
    write_control(&mut writer, &ClientMessage::Terminate).unwrap();
    daemon.wait_for_sessions(0);
}

/// A session fed output directly, attached over a real local connection.
fn attach_after_output(output: &[u8], replay: bool) -> BufReader<Stream> {
    let dir = tempfile::tempdir().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    let client = transport::connect(&endpoint).unwrap();
    let server_side = listener.accept().unwrap();
    let session = Session::new("pane-s#1".into(), "pane-s".into(), BTreeMap::new(), 1);
    let _ = session.deliver_output(output);
    let writer = Arc::new(ConnWriter::new(&server_side).unwrap());
    session.attach(&writer, 1, replay, false).unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut reader = BufReader::new(client);
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { .. })) => {}
        other => panic!("unexpected attach reply {other:?}"),
    }
    reader
}

#[test]
fn a_replayless_attach_starts_with_the_modes_then_the_screen_it_missed() {
    let mut reader = attach_after_output(b"old screen [?2004h[?1h more", false);
    let bytes = match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Data(bytes)) => bytes,
        other => panic!("expected the mode preamble and screen, got {other:?}"),
    };
    // Modes first (ADR-0303), then a redraw of the screen (ADR-0307).
    assert!(bytes.starts_with(b"[?1h[?2004h"), "{bytes:?}");
    let mut screen = vt100::Parser::new(24, 80, 0);
    screen.process(&bytes);
    assert_eq!(screen.screen().contents(), "old screen  more");
    assert_eq!(screen.screen().cursor_position(), (0, 16));
    assert_redraw_only(&bytes);
    // The discarded raw output itself never follows.
    assert!(!matches!(
        read_frame::<_, DaemonMessage>(&mut reader),
        Ok(Some(_))
    ));
}

/// A redraw must only set cells, attributes, cursor and modes: an OSC or a
/// device query in it would be processed or answered a second time.
fn assert_redraw_only(bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    assert!(!text.contains("]"), "OSC in redraw: {text:?}");
    for query in ["[c", "[0c", "[>c", "[5n", "[6n", "$p"] {
        assert!(!text.contains(query), "query {query:?} in redraw: {text:?}");
    }
}

#[test]
fn a_replaying_attach_gets_the_backlog_without_a_preamble() {
    let output = b"old screen \x1b[?2004h more";
    let mut reader = attach_after_output(output, true);
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Data(bytes)) => assert_eq!(bytes, output),
        other => panic!("expected the backlog, got {other:?}"),
    }
    assert!(!matches!(
        read_frame::<_, DaemonMessage>(&mut reader),
        Ok(Some(_))
    ));
}

#[test]
fn modes_set_while_a_client_was_attached_survive_into_the_next_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    let session = Session::new("pane-t#1".into(), "pane-t".into(), BTreeMap::new(), 1);

    // The first GUI is attached when the application turns the mode on, so
    // the bytes reach that GUI and never enter the detached backlog.
    let first_client = transport::connect(&endpoint).unwrap();
    let first_server = listener.accept().unwrap();
    let first = Arc::new(ConnWriter::new(&first_server).unwrap());
    session.attach(&first, 1, false, false).unwrap();
    let _ = session.deliver_output(b"\x1b[?2004h prompt");
    session.detach(1);
    drop(first_client);

    let client = transport::connect(&endpoint).unwrap();
    let server_side = listener.accept().unwrap();
    let writer = Arc::new(ConnWriter::new(&server_side).unwrap());
    session.attach(&writer, 2, false, false).unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut reader = BufReader::new(client);
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { .. })) => {}
        other => panic!("unexpected attach reply {other:?}"),
    }
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Data(bytes)) => {
            assert!(bytes.starts_with(b"\x1b[?2004h"), "{bytes:?}");
            // The screen the first GUI saw is redrawn for the next one.
            let mut screen = vt100::Parser::new(24, 80, 0);
            screen.process(&bytes);
            assert_eq!(screen.screen().contents(), " prompt");
        }
        other => panic!("expected the mode preamble and screen, got {other:?}"),
    }
}
