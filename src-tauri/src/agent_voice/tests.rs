use super::*;
use serde_json::json;

#[test]
fn voice_signaling_rejects_unbounded_or_non_audio_offers() {
    assert!(validate_offer("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n").is_ok());
    assert!(validate_offer("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n").is_err());
    assert!(validate_offer(&"x".repeat(MAX_SDP_BYTES + 1)).is_err());
}

#[test]
fn voice_events_never_leak_another_threads_audio_or_rpc_credentials() {
    assert!(voice_event(
        &json!({"method":"thread/realtime/sdp", "params":{"threadId":"a","sdp":"answer"}}),
        "a"
    )
    .is_some());
    assert!(voice_event(
        &json!({"method":"thread/realtime/sdp", "params":{"threadId":"b","sdp":"answer"}}),
        "a"
    )
    .is_none());
    assert!(voice_event(
        &json!({"method":"account/updated", "params":{"threadId":"a","token":"secret"}}),
        "a"
    )
    .is_none());
    assert!(voice_event(&json!({"id":4,"result":{"token":"secret"}}), "a").is_none());
}

#[test]
fn voice_event_ring_reports_a_gap_instead_of_losing_sdp_silently() {
    let mut events = Events::default();
    for _ in 0..(MAX_EVENTS + 1) {
        events.push(json!({"method":"thread/realtime/started","params":{}}));
    }
    assert!(events.after(0).is_err());
    assert_eq!(events.after(1).unwrap().events.len(), MAX_EVENTS);
}

fn target() -> Target {
    Target {
        terminal_id: "pane".into(),
        generation: 1,
        title: Default::default(),
        thread_id: "thread".into(),
        socket_path: "unused.sock".into(),
        distro: None,
    }
}

#[test]
fn a_different_controller_cannot_read_refresh_or_stop_a_voice_session() {
    let before = Instant::now() - Duration::from_secs(3);
    let session = Arc::new(Session {
        id: "session".into(),
        target: target(),
        owner: Some("lease-a".into()),
        cancel: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        last_seen: Mutex::new(before),
        events: Mutex::new(Events::default()),
    });
    let manager = VoiceManager {
        current: Mutex::new(Some(session.clone())),
    };
    assert!(manager.poll("session", Some("lease-b"), 0).is_err());
    assert!(manager.poll("session", None, 0).is_err());
    assert_eq!(*session.last_seen.lock().unwrap(), before);
    assert!(manager.stop("session", Some("lease-b")).is_err());
    assert!(!session.cancel.load(Ordering::Acquire));
    manager.stop("session", Some("lease-a")).unwrap();
    assert!(session.cancel.load(Ordering::Acquire));
}

#[test]
fn clients_cannot_supply_an_arbitrary_thread_or_server_in_signaling_requests() {
    assert!(serde_json::from_value::<routes::Start>(
        json!({"terminalId":"pane","sdp":"offer","threadId":"other"})
    )
    .is_err());
    assert!(serde_json::from_value::<routes::Start>(
        json!({"terminalId":"pane","sdp":"offer","server":"ws://example.test"})
    )
    .is_err());
}

#[test]
fn the_control_socket_uses_real_websocket_json_rpc_and_preserves_backend_errors() {
    use tokio_tungstenite::tungstenite::{accept, Message};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice.sock");
    let listener = crate::local_socket::bind_user_only(&path).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket = accept(stream).unwrap();
        let request: Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(request["method"], "thread/realtime/start");
        socket.send(Message::Text(json!({"id":request["id"],"error":{"code":-32600,"message":"voice is already active"}}).to_string().into())).unwrap();
    });
    let mut target = target();
    target.socket_path = path;
    let mut connection = transport::Connection::connect(&target).unwrap();
    assert_eq!(
        connection
            .request("thread/realtime/start", json!({}), |_| {})
            .unwrap_err(),
        "voice is already active"
    );
    server.join().unwrap();
}
