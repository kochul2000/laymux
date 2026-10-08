//! Handshake trust and bounds: who a GUI may treat as its daemon, and how
//! long an unauthenticated connection may occupy the daemon.

use std::io::{BufReader, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::client::connect_authenticated;
use super::discovery::{generate_token, write_discovery, DaemonPaths, Discovery};
use super::launcher::find_running;
use super::server::{input_delay, DaemonServer};
use super::transport::{self, Listener};
use super::wire::PROTOCOL_VERSION;
use super::wire::{read_frame, write_control, ClientMessage, DaemonMessage, Frame};
use super::DaemonEndpoint;
use crate::constants::PTY_DAEMON_HANDSHAKE_TIMEOUT_MS;

/// A program that took over an endpoint: it answers every hello with
/// success but cannot know the instance token.
fn spawn_impostor(listener: Listener) {
    std::thread::spawn(move || {
        while let Ok(stream) = listener.accept() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                let _hello = read_frame::<_, ClientMessage>(&mut reader);
                let _ = write_control(
                    &mut writer,
                    &DaemonMessage::HelloOk {
                        protocol_version: PROTOCOL_VERSION,
                        daemon_pid: 0,
                        proof: generate_token().unwrap(),
                    },
                );
                let _ = read_frame::<_, ClientMessage>(&mut reader);
            });
        }
    });
}

#[test]
fn a_stale_endpoint_answered_by_another_program_is_never_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::in_dir(dir.path().join("pty-daemon"));
    paths.ensure_dir().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    spawn_impostor(listener);
    // Discovery left behind by a daemon that died without cleaning up.
    let token = generate_token().unwrap();
    write_discovery(
        &paths,
        &Discovery {
            pid: 1,
            endpoint: endpoint.clone(),
            token: token.clone(),
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .unwrap();

    // No process holds the instance lock, so there is no daemon at all.
    assert!(matches!(find_running(&paths), Ok(None)));
    // Even when asked directly, the impostor cannot prove the token.
    let error = connect_authenticated(&DaemonEndpoint { endpoint, token }).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn a_daemon_holding_the_instance_lock_is_found() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DaemonPaths::in_dir(dir.path().join("pty-daemon"));
    paths.ensure_dir().unwrap();
    let lock = std::fs::File::create(paths.lock_file()).unwrap();
    lock.try_lock().unwrap();
    let token = generate_token().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    let server = DaemonServer::new(token.clone());
    let serving = {
        let server = Arc::clone(&server);
        let endpoint = endpoint.clone();
        std::thread::spawn(move || server.run(listener, endpoint, None).unwrap())
    };
    write_discovery(
        &paths,
        &Discovery {
            pid: std::process::id(),
            endpoint: endpoint.clone(),
            token: token.clone(),
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .unwrap();

    assert_eq!(
        find_running(&paths).unwrap().map(|found| found.token),
        Some(token)
    );
    server.request_shutdown(&endpoint);
    serving.join().unwrap();
}

#[test]
fn a_trickled_hello_is_cut_off_at_the_handshake_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
    let server = DaemonServer::new(generate_token().unwrap());
    let serving = {
        let server = Arc::clone(&server);
        let endpoint = endpoint.clone();
        std::thread::spawn(move || server.run(listener, endpoint, None).unwrap())
    };

    let mut stream = transport::connect(&endpoint, Duration::from_secs(5)).unwrap();
    // Announce a small hello, then send it one byte at a time, each well
    // inside a per-read timeout.
    stream.write_all(&100u32.to_le_bytes()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let started = Instant::now();
    let limit = Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS * 3);
    let cut_off = loop {
        assert!(
            started.elapsed() < limit,
            "a trickling client held its connection past {limit:?}"
        );
        if stream.write_all(b" ").is_err() {
            break started.elapsed();
        }
        match read_frame::<_, DaemonMessage>(&mut reader) {
            Ok(Some(Frame::Control(DaemonMessage::Error { .. }))) | Ok(None) => {
                break started.elapsed()
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break started.elapsed(),
            Ok(other) => panic!("unexpected reply {other:?}"),
        }
        std::thread::sleep(Duration::from_millis(1_000));
    };
    assert!(
        cut_off < Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS + 2_000),
        "cut off only after {cut_off:?}"
    );
    server.request_shutdown(&endpoint);
    serving.join().unwrap();
}

#[test]
fn input_pauses_are_replayed_only_when_frames_arrive_bunched_up() {
    let gap = Duration::from_millis(300);
    // First input on a connection: nothing to space it from.
    assert_eq!(input_delay(gap, None), Duration::ZERO);
    // Arrived on time: the socket already carried the pause.
    assert_eq!(input_delay(gap, Some(gap)), Duration::ZERO);
    assert_eq!(
        input_delay(gap, Some(Duration::from_secs(5))),
        Duration::ZERO
    );
    // Queued behind a slow write: the rest of the pause is restored.
    assert_eq!(
        input_delay(gap, Some(Duration::from_millis(20))),
        Duration::from_millis(280)
    );
    assert_eq!(
        input_delay(Duration::ZERO, Some(Duration::ZERO)),
        Duration::ZERO
    );
}
