//! Protocol fixtures only: no GUI, PTY or child process is started here.
use super::super::discovery::{generate_token, handshake_proof};
use super::super::transport::Listener;
use super::super::wire::{
    read_frame, write_control, write_data, ClientMessage, DaemonMessage, Frame, PROTOCOL_VERSION,
};
use super::super::DaemonEndpoint;
use super::*;
use std::collections::BTreeMap;
use std::io::BufReader;
use std::sync::Arc;

#[derive(Clone, Copy)]
enum ReplyMode {
    Reclaim,
    Busy,
    SupersededAgain,
    LostReply,
    Gone,
}

struct FakeDaemon {
    endpoint: DaemonEndpoint,
    requests: Arc<Mutex<Vec<ClientMessage>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    _dir: tempfile::TempDir,
}

impl FakeDaemon {
    fn start(mode: ReplyMode) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (listener, endpoint) = Listener::bind(dir.path()).unwrap();
        let token = generate_token().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let server_requests = Arc::clone(&requests);
        let server_stop = Arc::clone(&stop);
        let server_token = token.clone();
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while let Ok(stream) = listener.accept() {
                if server_stop.load(Ordering::Acquire) {
                    break;
                }
                let token = server_token.clone();
                let requests = Arc::clone(&server_requests);
                workers.push(std::thread::spawn(move || {
                    respond(stream, token, requests, mode)
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            endpoint: DaemonEndpoint { endpoint, token },
            requests,
            stop,
            thread: Some(thread),
            _dir: dir,
        }
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = transport::connect(&self.endpoint.endpoint);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

fn respond(
    mut writer: Stream,
    token: String,
    requests: Arc<Mutex<Vec<ClientMessage>>>,
    mode: ReplyMode,
) {
    writer
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    writer
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut reader = BufReader::new(writer.try_clone().unwrap());
    let nonce = match read_frame::<_, ClientMessage>(&mut reader).unwrap() {
        Some(Frame::Control(ClientMessage::Hello { nonce, .. })) => nonce,
        other => panic!("expected authenticated connection, got {other:?}"),
    };
    write_control(
        &mut writer,
        &DaemonMessage::HelloOk {
            protocol_version: PROTOCOL_VERSION,
            daemon_pid: 0,
            proof: handshake_proof(&token, &nonce).unwrap(),
        },
    )
    .unwrap();
    let message = match read_frame::<_, ClientMessage>(&mut reader).unwrap() {
        Some(Frame::Control(message)) => message,
        other => panic!("expected control request, got {other:?}"),
    };
    requests.lock().unwrap().push(message.clone());
    match message {
        ClientMessage::TerminateSession {
            session_id,
            attach_epoch,
        } => {
            assert_eq!(session_id, "pane#original");
            assert!(
                matches!(attach_epoch, Some(1 | 3)),
                "never terminate without a confirmed epoch"
            );
            write_control(
                &mut writer,
                &DaemonMessage::Terminating {
                    found: !matches!(mode, ReplyMode::Gone),
                    superseded: !matches!(mode, ReplyMode::Gone)
                        && (attach_epoch == Some(1) || matches!(mode, ReplyMode::SupersededAgain)),
                },
            )
            .unwrap();
        }
        ClientMessage::Attach {
            session_id,
            take_over,
            replay,
            size,
            missed_output,
        } => {
            assert_eq!(session_id, "pane#original");
            assert!(!take_over && !replay && !missed_output && size.is_none());
            if matches!(mode, ReplyMode::LostReply) {
                return;
            }
            if matches!(mode, ReplyMode::Busy) {
                write_control(
                    &mut writer,
                    &DaemonMessage::Error {
                        message: "another client holds this session".into(),
                    },
                )
                .unwrap();
                return;
            }
            write_control(
                &mut writer,
                &DaemonMessage::Attached {
                    child_pid: Some(42),
                    attach_epoch: 3,
                    dropped_bytes: 0,
                    metadata: BTreeMap::new(),
                },
            )
            .unwrap();
            // Larger than a socket buffer: termination must not wait for this
            // redraw to fit without a concurrent reader.
            for _ in 0..64 {
                if write_data(&mut writer, &[b'x'; 65536]).is_err() {
                    break;
                }
            }
            let _ = read_frame::<_, ClientMessage>(&mut reader);
        }
        other => panic!("unexpected recovery command {other:?}"),
    }
}

#[test]
fn lost_attach_reply_reclaims_detached_session_before_explicit_termination() {
    let daemon = FakeDaemon::start(ReplyMode::Reclaim);
    let epoch = Mutex::new(Some(1));
    terminate_preserved_session(&daemon.endpoint, "pane#original", &epoch).unwrap();
    assert_eq!(*epoch.lock().unwrap(), Some(3));
    assert_eq!(daemon.requests.lock().unwrap().len(), 3);
}

#[test]
fn reclaim_never_steals_an_active_client_or_guesses_a_lost_epoch() {
    for mode in [ReplyMode::Busy, ReplyMode::LostReply] {
        let daemon = FakeDaemon::start(mode);
        let epoch = Mutex::new(Some(1));
        assert!(terminate_preserved_session(&daemon.endpoint, "pane#original", &epoch).is_err());
        assert_eq!(*epoch.lock().unwrap(), Some(1));
        assert_eq!(daemon.requests.lock().unwrap().len(), 2);
    }
}

#[test]
fn a_second_superseded_reply_is_not_success() {
    let daemon = FakeDaemon::start(ReplyMode::SupersededAgain);
    let epoch = Mutex::new(Some(1));
    assert!(terminate_preserved_session(&daemon.endpoint, "pane#original", &epoch).is_err());
    assert_eq!(daemon.requests.lock().unwrap().len(), 3);
}

#[test]
fn an_already_gone_session_does_not_need_a_reclaim() {
    let daemon = FakeDaemon::start(ReplyMode::Gone);
    let epoch = Mutex::new(Some(1));
    terminate_preserved_session(&daemon.endpoint, "pane#original", &epoch).unwrap();
    assert_eq!(daemon.requests.lock().unwrap().len(), 1);
}

#[test]
fn an_unknown_epoch_never_sends_an_unconditional_termination() {
    let daemon = FakeDaemon::start(ReplyMode::Gone);
    assert!(
        terminate_preserved_session(&daemon.endpoint, "pane#original", &Mutex::new(None)).is_err()
    );
    assert!(daemon.requests.lock().unwrap().is_empty());
}
