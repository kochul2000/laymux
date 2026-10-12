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
use super::session::{AttachOptions, ConnWriter, Session};
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

    let system = DaemonPtySystem::adopt(
        daemon.endpoint.clone(),
        "pane-k#1-a".into(),
        Default::default(),
    );
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
fn an_adopting_terminal_reads_what_it_missed_first_and_knows_where_it_ends() {
    let daemon = TestDaemon::start();
    let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-g#1", delayed_printer());
    drop(writer);
    drop(reader);
    wait_detached(&daemon.endpoint, "pane-g#1");
    // Let the child print while nobody is attached.
    std::thread::sleep(Duration::from_millis(2500));

    let missed_output = Arc::new(super::client::MissedOutput::default());
    let system = DaemonPtySystem::adopt(
        daemon.endpoint.clone(),
        "pane-g#1".into(),
        Arc::clone(&missed_output),
    );
    let (tx, rx) = mpsc::channel();
    let tally = Arc::clone(&missed_output);
    let handle = spawn_command_on(
        &system,
        size(),
        sleeper(),
        1,
        SpawnOptions {
            wsl_backed: false,
            kill_owner: ChildKillOwner::Backend,
        },
        move |data: Vec<u8>| {
            // What the terminal output callback does (ADR-0309).
            let missed = tally.take(data.len());
            let _ = tx.send((data[..missed].to_vec(), data[missed..].to_vec()));
            PtyOutputControl::Continue
        },
        PtyLifecycleHooks::default(),
    )
    .unwrap();
    let (mut missed, mut live) = (Vec::new(), Vec::new());
    let deadline = Instant::now() + TIMEOUT;
    while live.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (missed_part, live_part) = rx.recv_timeout(remaining).expect("output");
        missed.extend(missed_part);
        live.extend(live_part);
    }
    // Everything the child printed while detached is counted as missed,
    // and live output starts with the redraw.
    assert!(!missed.is_empty());
    assert!(
        String::from_utf8_lossy(&live).contains("[H[J"),
        "{:?}",
        String::from_utf8_lossy(&live)
    );
    // The inbox conhost the Windows test binary falls back to may hold the
    // echo back; a Unix PTY passes it straight through.
    #[cfg(unix)]
    assert!(String::from_utf8_lossy(&missed).contains("LATE_2"));
    assert!(!live.starts_with(&missed));
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
            size: None,
            missed_output: false,
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
    // The screen it drew is redrawn once (ADR-0307); the raw output itself
    // is never replayed on top of it.
    assert!(
        output.matches("LATE_2").count() <= 1,
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
            size: None,
            missed_output: false,
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
            size: None,
            missed_output: false,
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

/// One daemon terminal registered in a fresh app state, as a GUI has it.
fn state_with_daemon_terminal(daemon: &TestDaemon, session_id: &str) -> crate::state::AppState {
    let state = crate::state::AppState::new();
    let system = spawning(daemon.endpoint.clone(), session_id.into());
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
        .insert(session_id.into(), handle);
    daemon.wait_for_sessions(1);
    state
}

fn assert_session_keeps_running(daemon: &TestDaemon) {
    std::thread::sleep(Duration::from_millis(500));
    let sessions = list_sessions(&daemon.endpoint).unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(!sessions[0].terminating && !sessions[0].exited);
}

#[test]
fn the_installer_teardown_hands_daemon_terminals_to_the_updated_gui() {
    let daemon = TestDaemon::start();
    let state = state_with_daemon_terminal(&daemon, "pane-h#1");
    state.begin_update_handoff();
    // Windows: `on_before_exit`, then `process::exit` (ADR-0308).
    state.terminate_child_processes();
    assert!(state.pty_handles.lock().unwrap().is_empty());
    std::mem::forget(state);
    assert_session_keeps_running(&daemon);
    super::control::terminate_by_id(&daemon.endpoint, "pane-h#1", None).unwrap();
    daemon.wait_for_sessions(0);
}

#[test]
fn the_restart_into_an_update_hands_daemon_terminals_to_the_updated_gui() {
    let daemon = TestDaemon::start();
    let state = state_with_daemon_terminal(&daemon, "pane-u#1");
    state.begin_update_handoff();
    // Linux: `app.restart()` runs the app exit path, and the state may drop.
    state.terminate_daemon_sessions_on_exit();
    assert_session_keeps_running(&daemon);
    drop(state);
    assert_session_keeps_running(&daemon);
    super::control::terminate_by_id(&daemon.endpoint, "pane-u#1", None).unwrap();
    daemon.wait_for_sessions(0);
}

#[test]
fn a_failed_update_ends_daemon_terminals_on_exit_again() {
    let daemon = TestDaemon::start();
    let state = state_with_daemon_terminal(&daemon, "pane-f#1");
    state.begin_update_handoff();
    state.cancel_update_handoff();
    state.terminate_daemon_sessions_on_exit();
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
            size: None,
            missed_output: false,
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
    attach_after_output_with(
        output,
        AttachOptions {
            replay,
            ..AttachOptions::default()
        },
    )
}

fn attach_after_output_with(output: &[u8], options: AttachOptions) -> BufReader<Stream> {
    let dir = tempfile::tempdir().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    let client = transport::connect(&endpoint).unwrap();
    let server_side = listener.accept().unwrap();
    let session = Session::new("pane-s#1".into(), "pane-s".into(), BTreeMap::new(), 1);
    let _ = session.deliver_output(output);
    let writer = Arc::new(ConnWriter::new(&server_side).unwrap());
    session.attach(&writer, 1, options).unwrap();
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

/// Every data frame the client gets before the connection goes quiet, and
/// how many there were.
fn first_data(reader: &mut BufReader<Stream>) -> (Vec<u8>, usize) {
    let mut bytes = Vec::new();
    let mut frames = 0;
    while let Ok(Some(Frame::Data(data))) = read_frame::<_, DaemonMessage>(reader) {
        bytes.extend(data);
        frames += 1;
    }
    (bytes, frames)
}

fn position(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
        .unwrap_or_else(|| panic!("{needle:?} not in {:?}", String::from_utf8_lossy(haystack)))
}

#[test]
fn a_replayless_attach_redraws_the_screen_it_missed_then_asserts_the_modes() {
    let mut reader = attach_after_output(b"old screen \x1b[?2004h\x1b[?1h more", false);
    let (bytes, _) = first_data(&mut reader);
    let mut screen = vt100::Parser::new(24, 80, 0);
    screen.process(&bytes);
    assert_eq!(screen.screen().contents(), "old screen  more");
    assert_eq!(screen.screen().cursor_position(), (0, 16));
    // The modes (ADR-0303) follow the redraw (ADR-0307), and the cursor's
    // visibility is stated last.
    assert!(
        bytes.ends_with(b"\x1b[?1h\x1b[?2004h\x1b[?25h"),
        "{:?}",
        String::from_utf8_lossy(&bytes)
    );
    assert_redraw_only(&bytes);
}

#[test]
fn modes_that_change_how_text_is_drawn_follow_the_redraw() {
    // Without autowrap a redrawn wrapped row would overwrite its last cell
    // instead of continuing on the next row.
    let wrapped = format!("{}\x1b[?7l\x1b[4h", "x".repeat(100));
    let mut reader = attach_after_output(wrapped.as_bytes(), false);
    let (bytes, _) = first_data(&mut reader);
    let last_x = bytes.iter().rposition(|byte| *byte == b'x').unwrap();
    assert!(last_x < position(&bytes, b"\x1b[?7l"));
    assert!(last_x < position(&bytes, b"\x1b[4h"));
}

#[test]
fn the_alternate_screen_is_entered_before_it_is_redrawn() {
    let mut reader = attach_after_output(b"main\x1b[?1049h\x1b[HALT SCREEN", false);
    let (bytes, _) = first_data(&mut reader);
    assert!(bytes.starts_with(b"\x1b[?1049h"));
    let mut screen = vt100::Parser::new(24, 80, 0);
    screen.process(&bytes);
    assert!(screen.screen().alternate_screen());
    assert_eq!(screen.screen().contents(), "ALT SCREEN");
}

#[test]
fn the_cursor_visibility_follows_the_modes_after_a_soft_reset() {
    // DECSTR shows the cursor in xterm.js; vt100 keeps it hidden.
    let mut reader = attach_after_output(b"\x1b[?25lprompt\x1b[!p", false);
    let (bytes, _) = first_data(&mut reader);
    assert!(bytes.ends_with(b"\x1b[?25h"));
}

#[test]
fn a_large_redraw_is_split_into_frames() {
    let mut cells = String::new();
    for index in 0..(24 * 80 - 1) {
        let shade = index % 256;
        cells.push_str(&format!("\x1b[38;2;{shade};1;2;48;2;3;{shade};4mX"));
    }
    let mut reader = attach_after_output(cells.as_bytes(), false);
    let (bytes, frames) = first_data(&mut reader);
    assert!(frames > 1, "{} bytes in one frame", bytes.len());
    let mut screen = vt100::Parser::new(24, 80, 0);
    screen.process(&bytes);
    assert_eq!(screen.screen().contents().matches('X').count(), 24 * 80 - 1);
}

/// A redraw must only set cells, attributes, cursor and modes: an OSC or a
/// device query in it would be processed or answered a second time.
fn assert_redraw_only(bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    assert!(!text.contains("\x1b]"), "OSC in redraw: {text:?}");
    for query in ["\x1b[c", "\x1b[0c", "\x1b[>c", "\x1b[5n", "\x1b[6n", "$p"] {
        assert!(!text.contains(query), "query {query:?} in redraw: {text:?}");
    }
}

#[test]
fn a_client_that_asks_gets_the_missed_backlog_marked_ahead_of_the_redraw() {
    let output = b"]0;a titleshown";
    let mut reader = attach_after_output_with(
        output,
        AttachOptions {
            missed_output: true,
            ..AttachOptions::default()
        },
    );
    let mut next = || read_frame::<_, DaemonMessage>(&mut reader).unwrap();
    assert!(matches!(
        next(),
        Some(Frame::Control(DaemonMessage::MissedOutputBegin))
    ));
    match next() {
        Some(Frame::Data(bytes)) => assert_eq!(bytes, output),
        other => panic!("expected the missed backlog, got {other:?}"),
    }
    assert!(matches!(
        next(),
        Some(Frame::Control(DaemonMessage::MissedOutputEnd))
    ));
    let (bytes, _) = first_data(&mut reader);
    assert!(String::from_utf8_lossy(&bytes).contains("shown"));
    assert_redraw_only(&bytes);
}

#[test]
fn a_client_that_does_not_ask_gets_no_missed_output() {
    let mut reader = attach_after_output(b"]0;a titleshown", false);
    assert!(matches!(
        read_frame::<_, DaemonMessage>(&mut reader).unwrap(),
        Some(Frame::Data(_))
    ));
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
    session.attach(&first, 1, AttachOptions::default()).unwrap();
    let _ = session.deliver_output(b"\x1b[?2004h prompt");
    session.detach(1);
    drop(first_client);

    let client = transport::connect(&endpoint).unwrap();
    let server_side = listener.accept().unwrap();
    let writer = Arc::new(ConnWriter::new(&server_side).unwrap());
    session
        .attach(&writer, 2, AttachOptions::default())
        .unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut reader = BufReader::new(client);
    match read_frame::<_, DaemonMessage>(&mut reader).unwrap() {
        Some(Frame::Control(DaemonMessage::Attached { .. })) => {}
        other => panic!("unexpected attach reply {other:?}"),
    }
    let (bytes, _) = first_data(&mut reader);
    assert!(bytes.ends_with(b"\x1b[?2004h\x1b[?25h"), "{bytes:?}");
    // The screen the first GUI saw is redrawn for the next one.
    let mut screen = vt100::Parser::new(24, 80, 0);
    screen.process(&bytes);
    assert_eq!(screen.screen().contents(), " prompt");
}
