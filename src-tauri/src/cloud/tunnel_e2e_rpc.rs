//! Cloud tunnel bounds for binary Android E2E RPC request streams (ADR-0351).
//!
//! The relay streams these bodies instead of buffering them, so the desktop
//! tunnel itself bounds what an unauthenticated caller can make it hold: a
//! per-stream byte cap derived from the host attachment setting, an early
//! answer once the 31-byte prefix is known to be unusable, and an idle
//! deadline so a stalled body cannot keep a `MAX_ACTIVE_STREAMS` slot.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::{ActiveStream, StreamOpenPayload, KIND_HTTP_REQUEST};
use crate::constants::{
    ANDROID_E2E_RPC_PATH, ANDROID_E2E_RPC_TUNNEL_BODY_IDLE_TIMEOUT_SECS,
    CLOUD_RELAY_ANDROID_E2E_RPC_BODY_IDLE_TIMEOUT_SECS,
};

/// Longest gap between two body frames of an E2E RPC request stream. A
/// healthy relay forwards chunks back to back and enforces its own, shorter
/// idle deadline; this backstop only cuts a stream the relay failed to end,
/// so the client sees the relay's 408 rather than this stream error.
pub(super) const E2E_RPC_BODY_IDLE_TIMEOUT: Duration =
    Duration::from_secs(ANDROID_E2E_RPC_TUNNEL_BODY_IDLE_TIMEOUT_SECS);
const _: () = assert!(
    ANDROID_E2E_RPC_TUNNEL_BODY_IDLE_TIMEOUT_SECS
        > CLOUD_RELAY_ANDROID_E2E_RPC_BODY_IDLE_TIMEOUT_SECS
);
/// How often the connection loop looks for idle E2E RPC streams.
pub(super) const E2E_RPC_IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(5);
/// Streams answered early whose late body frames are still being dropped.
/// They hold no body and do not count against `MAX_ACTIVE_STREAMS`, but are
/// bounded so a flood of rejected requests cannot grow the map.
pub(super) const MAX_ANSWERED_E2E_RPC_STREAMS: usize = 128;

/// Receive-side state of one E2E RPC request body.
#[derive(Debug, Clone)]
pub(super) struct E2eRpcBodyGate {
    pub(super) prefix_accepted: bool,
    pub(super) last_activity: Instant,
}

impl E2eRpcBodyGate {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            prefix_accepted: false,
            last_activity: now,
        }
    }
}

pub(super) fn is_android_e2e_rpc_request(payload: &StreamOpenPayload) -> bool {
    payload.kind == KIND_HTTP_REQUEST
        && payload.method.as_deref() == Some("POST")
        && payload.path.as_deref() == Some(ANDROID_E2E_RPC_PATH)
        && payload.query.as_deref().unwrap_or("").is_empty()
}

fn idle(last_activity: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_activity) >= E2E_RPC_BODY_IDLE_TIMEOUT
}

/// Streams the idle sweep must end: `timed_out` are still receiving a body and
/// get a `stream.error`; `forgotten` were already answered and are dropped
/// silently.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct IdleE2eRpcStreams {
    pub(super) timed_out: Vec<String>,
    pub(super) forgotten: Vec<String>,
}

pub(super) fn idle_e2e_rpc_streams(
    active_streams: &HashMap<String, ActiveStream>,
    now: Instant,
) -> IdleE2eRpcStreams {
    let mut idle_streams = IdleE2eRpcStreams::default();
    for (stream_id, stream) in active_streams {
        match stream {
            ActiveStream::Http(request) => {
                if request
                    .e2e_rpc
                    .as_ref()
                    .is_some_and(|gate| idle(gate.last_activity, now))
                {
                    idle_streams.timed_out.push(stream_id.clone());
                }
            }
            ActiveStream::Answered { last_activity } if idle(*last_activity, now) => {
                idle_streams.forgotten.push(stream_id.clone());
            }
            _ => {}
        }
    }
    idle_streams.timed_out.sort();
    idle_streams.forgotten.sort();
    idle_streams
}

/// Streams that count against `MAX_ACTIVE_STREAMS`.
pub(super) fn counted_streams(active_streams: &HashMap<String, ActiveStream>) -> usize {
    active_streams
        .values()
        .filter(|stream| !matches!(stream, ActiveStream::Answered { .. }))
        .count()
}

/// Makes room for one more answered stream by forgetting the oldest ones.
pub(super) fn evict_answered_streams(active_streams: &mut HashMap<String, ActiveStream>) {
    let mut answered: Vec<(Instant, String)> = active_streams
        .iter()
        .filter_map(|(stream_id, stream)| match stream {
            ActiveStream::Answered { last_activity } => Some((*last_activity, stream_id.clone())),
            _ => None,
        })
        .collect();
    if answered.len() < MAX_ANSWERED_E2E_RPC_STREAMS {
        return;
    }
    answered.sort();
    let excess = answered.len() + 1 - MAX_ANSWERED_E2E_RPC_STREAMS;
    for (_, stream_id) in answered.into_iter().take(excess) {
        active_streams.remove(&stream_id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use serde_json::{json, Value};
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle as TokioJoinHandle;

    use super::super::{
        handle_frame_with_dispatch, sweep_idle_e2e_rpc_streams, FrameDispatchState,
        IncomingHttpRequest, OutputCheckpointBridge, TunnelFrame, BASE64, ENCODING_BASE64,
        FRAME_STREAM_CLOSE, FRAME_STREAM_DATA, FRAME_STREAM_ERROR, FRAME_STREAM_OPEN,
        HTTP_REQUEST_BYTES_LIMIT, KIND_HTTP_RESPONSE,
    };
    use super::*;
    use crate::state::AppState;

    const STREAM: &str = "srv-e2e";

    struct Harness {
        state: Arc<AppState>,
        active_streams: HashMap<String, ActiveStream>,
        socket_pending_bytes: usize,
        next_task_id: u64,
        outbound_tx: mpsc::Sender<TunnelFrame>,
        outbound_rx: mpsc::Receiver<TunnelFrame>,
        dispatched: Arc<std::sync::Mutex<Vec<IncomingHttpRequest>>>,
    }

    impl Harness {
        fn new() -> (Self, String) {
            let state = Arc::new(AppState::new());
            let session_id = URL_SAFE_NO_PAD.encode([5_u8; 16]);
            state
                .android_e2e
                .install_test_request_context("desktop-7", &session_id, u64::MAX);
            let (outbound_tx, outbound_rx) = mpsc::channel(64);
            (
                Self {
                    state,
                    active_streams: HashMap::new(),
                    socket_pending_bytes: 0,
                    next_task_id: 1,
                    outbound_tx,
                    outbound_rx,
                    dispatched: Arc::default(),
                },
                session_id,
            )
        }

        async fn frame(&mut self, frame: TunnelFrame) {
            let (completion_tx, _completion_rx) = mpsc::unbounded_channel();
            let dispatched = self.dispatched.clone();
            handle_frame_with_dispatch(
                frame,
                &mut self.active_streams,
                &mut self.socket_pending_bytes,
                &mut self.next_task_id,
                &self.outbound_tx,
                FrameDispatchState {
                    app_state: self.state.clone(),
                    output_checkpoint_bridge: OutputCheckpointBridge,
                    completion_tx,
                },
                move |_, _, request| -> TokioJoinHandle<()> {
                    dispatched.lock().unwrap().push(request);
                    tokio::spawn(std::future::pending::<()>())
                },
            )
            .await;
        }

        async fn open(&mut self, path: &str) {
            self.frame(TunnelFrame::new(
                STREAM,
                FRAME_STREAM_OPEN,
                json!({ "kind": "http.request", "method": "POST", "path": path }),
            ))
            .await;
        }

        async fn data(&mut self, bytes: &[u8]) {
            self.frame(TunnelFrame::new(
                STREAM,
                FRAME_STREAM_DATA,
                json!({ "encoding": ENCODING_BASE64, "data": BASE64.encode(bytes) }),
            ))
            .await;
        }

        fn sent(&mut self) -> Vec<TunnelFrame> {
            let mut frames = Vec::new();
            while let Ok(frame) = self.outbound_rx.try_recv() {
                frames.push(frame);
            }
            frames
        }

        fn gate(&self) -> &E2eRpcBodyGate {
            match self.active_streams.get(STREAM) {
                Some(ActiveStream::Http(request)) => request.e2e_rpc.as_ref().unwrap(),
                other => panic!("expected a receiving E2E stream, got {other:?}"),
            }
        }

        fn close_all(self) {
            for (_, stream) in self.active_streams {
                super::super::close_active_stream(stream);
            }
        }
    }

    fn response_status(frames: &[TunnelFrame]) -> u64 {
        let open = &frames[0];
        assert_eq!(open.frame_type, FRAME_STREAM_OPEN);
        let payload = open.payload.as_ref().unwrap();
        assert_eq!(payload["kind"], KIND_HTTP_RESPONSE);
        assert_eq!(
            frames.last().map(|frame| frame.frame_type.as_str()),
            Some(FRAME_STREAM_CLOSE)
        );
        payload["status"].as_u64().unwrap()
    }

    fn prefix(session_id: &str, sequence: u64) -> Vec<u8> {
        crate::android_e2e::encode_rpc_request(session_id, sequence, &[])
    }

    #[tokio::test]
    async fn e2e_rpc_stream_is_capped_at_the_host_derived_limit() {
        let (mut harness, session_id) = Harness::new();
        harness.open(ANDROID_E2E_RPC_PATH).await;
        let limit = crate::remote_server::android_e2e_rpc_request_limit(&harness.state).unwrap();
        // The default 16 MiB host derives its envelope bound from the
        // attachment JSON, under the relay's 24 MiB (ADR-0353).
        assert_eq!(
            limit,
            crate::constants::android_e2e_rpc_body_limit(16 * 1024 * 1024)
        );
        assert!(limit < HTTP_REQUEST_BYTES_LIMIT);
        match harness.active_streams.get(STREAM) {
            Some(ActiveStream::Http(request)) => assert_eq!(request.body_limit, limit),
            other => panic!("unexpected stream {other:?}"),
        }

        harness.data(&prefix(&session_id, 0)).await;
        assert!(harness.sent().is_empty());
        assert!(harness.gate().prefix_accepted);
        harness.data(&vec![0_u8; limit - 31]).await;
        assert!(harness.sent().is_empty());
        assert_eq!(harness.socket_pending_bytes, limit);

        // One byte over the host-derived cap: answered 413 without buffering.
        harness.data(&[0]).await;
        assert_eq!(response_status(&harness.sent()), 413);
        assert!(matches!(
            harness.active_streams.get(STREAM),
            Some(ActiveStream::Answered { .. })
        ));
        assert_eq!(harness.socket_pending_bytes, 0);

        // Late frames are dropped quietly; the relay's close forgets the marker.
        harness.data(&vec![0_u8; 1024]).await;
        assert!(harness.sent().is_empty());
        harness
            .frame(TunnelFrame::empty(STREAM, FRAME_STREAM_CLOSE))
            .await;
        assert!(harness.sent().is_empty());
        assert!(harness.active_streams.is_empty());
        assert!(harness.dispatched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn other_http_streams_keep_the_relay_bound() {
        let (mut harness, _) = Harness::new();
        harness.open("/remote/v1/health").await;
        match harness.active_streams.get(STREAM) {
            Some(ActiveStream::Http(request)) => {
                assert_eq!(request.body_limit, HTTP_REQUEST_BYTES_LIMIT);
                assert!(request.e2e_rpc.is_none());
            }
            other => panic!("unexpected stream {other:?}"),
        }
        harness.close_all();
    }

    #[tokio::test]
    async fn unknown_session_prefix_is_answered_at_31_bytes() {
        let (mut harness, _) = Harness::new();
        harness.open(ANDROID_E2E_RPC_PATH).await;
        let unknown = prefix(&URL_SAFE_NO_PAD.encode([6_u8; 16]), 0);
        harness.data(&unknown[..30]).await;
        assert!(harness.sent().is_empty());
        assert!(!harness.gate().prefix_accepted);
        harness.data(&unknown[30..]).await;
        assert_eq!(response_status(&harness.sent()), 401);
        assert!(matches!(
            harness.active_streams.get(STREAM),
            Some(ActiveStream::Answered { .. })
        ));
        // The relay's own stream.error also clears the marker.
        harness
            .frame(TunnelFrame::new(
                STREAM,
                FRAME_STREAM_ERROR,
                json!({ "code": "cancelled", "message": "x", "retryable": false }),
            ))
            .await;
        assert!(harness.active_streams.is_empty());
    }

    #[tokio::test]
    async fn wrong_format_prefix_is_answered_400() {
        let (mut harness, session_id) = Harness::new();
        harness.open(ANDROID_E2E_RPC_PATH).await;
        let mut body = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 64]);
        body[0] = b'{';
        harness.data(&body).await;
        assert_eq!(response_status(&harness.sent()), 400);
        harness.close_all();
    }

    #[tokio::test]
    async fn accepted_prefix_is_dispatched_after_the_body_ends() {
        let (mut harness, session_id) = Harness::new();
        harness.open(ANDROID_E2E_RPC_PATH).await;
        let body = crate::android_e2e::encode_rpc_request(&session_id, 0, &[9; 48]);
        harness.data(&body[..40]).await;
        harness.data(&body[40..]).await;
        assert!(harness.sent().is_empty());
        harness
            .frame(TunnelFrame::empty(STREAM, FRAME_STREAM_CLOSE))
            .await;
        let dispatched = harness.dispatched.lock().unwrap().clone();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].body, body);
        assert!(matches!(
            harness.active_streams.get(STREAM),
            Some(ActiveStream::Responding { .. })
        ));
        harness.close_all();
    }

    #[tokio::test]
    async fn stalled_e2e_body_is_cut_at_the_idle_deadline() {
        let (mut harness, session_id) = Harness::new();
        harness.open(ANDROID_E2E_RPC_PATH).await;
        harness.data(&prefix(&session_id, 0)).await;
        harness
            .frame(TunnelFrame::new(
                "srv-browser",
                FRAME_STREAM_OPEN,
                json!({ "kind": "http.request", "method": "POST", "path": "/remote/v1/health" }),
            ))
            .await;
        harness.active_streams.insert(
            "srv-answered".into(),
            ActiveStream::Answered {
                last_activity: Instant::now(),
            },
        );
        let pending = harness.socket_pending_bytes;
        assert_eq!(pending, 31);

        // Just under the deadline nothing happens.
        let almost = Instant::now() + E2E_RPC_BODY_IDLE_TIMEOUT - Duration::from_secs(1);
        sweep_idle_e2e_rpc_streams(
            &mut harness.active_streams,
            &mut harness.socket_pending_bytes,
            &harness.outbound_tx,
            almost,
        )
        .await;
        assert!(harness.sent().is_empty());
        assert_eq!(harness.active_streams.len(), 3);

        let late = Instant::now() + E2E_RPC_BODY_IDLE_TIMEOUT + Duration::from_secs(1);
        sweep_idle_e2e_rpc_streams(
            &mut harness.active_streams,
            &mut harness.socket_pending_bytes,
            &harness.outbound_tx,
            late,
        )
        .await;
        let frames = harness.sent();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].stream_id, STREAM);
        assert_eq!(frames[0].frame_type, FRAME_STREAM_ERROR);
        assert_eq!(
            frames[0].payload.as_ref().and_then(|p| p.get("code")),
            Some(&Value::from("stream_idle_timeout"))
        );
        assert_eq!(harness.socket_pending_bytes, 0);
        // The browser stream has no E2E deadline; the answered marker is forgotten.
        assert_eq!(
            harness.active_streams.keys().cloned().collect::<Vec<_>>(),
            vec!["srv-browser".to_string()]
        );
        harness.close_all();
    }

    #[test]
    fn answered_markers_neither_count_as_active_nor_grow_without_bound() {
        let mut active_streams = HashMap::new();
        let start = Instant::now();
        for index in 0..MAX_ANSWERED_E2E_RPC_STREAMS {
            evict_answered_streams(&mut active_streams);
            active_streams.insert(
                format!("answered-{index:03}"),
                ActiveStream::Answered {
                    last_activity: start + Duration::from_millis(index as u64),
                },
            );
        }
        assert_eq!(counted_streams(&active_streams), 0);
        assert_eq!(active_streams.len(), MAX_ANSWERED_E2E_RPC_STREAMS);
        evict_answered_streams(&mut active_streams);
        assert_eq!(active_streams.len(), MAX_ANSWERED_E2E_RPC_STREAMS - 1);
        assert!(!active_streams.contains_key("answered-000"));
        assert!(active_streams.contains_key("answered-001"));
    }

    #[test]
    fn desktop_idle_backstop_outlasts_the_relay_idle_deadline() {
        let relay = Duration::from_secs(CLOUD_RELAY_ANDROID_E2E_RPC_BODY_IDLE_TIMEOUT_SECS);
        assert_eq!(E2E_RPC_BODY_IDLE_TIMEOUT, Duration::from_secs(40));
        // At least one sweep interval of margin: the relay's 408 has gone out
        // before the desktop's sweep can possibly see the stream as idle.
        assert!(E2E_RPC_BODY_IDLE_TIMEOUT >= relay + E2E_RPC_IDLE_SWEEP_INTERVAL);

        let start = Instant::now();
        let mut active_streams = HashMap::new();
        active_streams.insert(
            "answered".to_string(),
            ActiveStream::Answered {
                last_activity: start,
            },
        );
        let at_relay_deadline = start + relay + Duration::from_secs(1);
        assert_eq!(
            idle_e2e_rpc_streams(&active_streams, at_relay_deadline),
            IdleE2eRpcStreams::default()
        );
    }

    #[test]
    fn socket_pending_budget_fits_every_concurrent_max_size_e2e_upload() {
        use crate::constants::{
            android_e2e_rpc_body_limit, ANDROID_E2E_RPC_MAX_BODY_BYTES,
            CLOUD_RELAY_ANDROID_E2E_RPC_INSTANCE_MAX_REQUESTS, REMOTE_TERMINAL_ATTACHMENT_MAX_MIB,
        };
        const MIB: usize = 1024 * 1024;
        let largest = android_e2e_rpc_body_limit(REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize * MIB);
        assert_eq!(largest, ANDROID_E2E_RPC_MAX_BODY_BYTES);
        let e2e = CLOUD_RELAY_ANDROID_E2E_RPC_INSTANCE_MAX_REQUESTS * largest;
        let socket_limit = super::super::SOCKET_PENDING_BYTES_LIMIT;
        // Every upload the relay lets through at once, plus a full browser
        // request: exactly the ADR-0352 formula.
        assert_eq!(socket_limit, e2e + HTTP_REQUEST_BYTES_LIMIT);
        // The browser path keeps at least two full requests.
        assert!(2 * HTTP_REQUEST_BYTES_LIMIT <= socket_limit);
        // 16 MiB attachment maximum, 24 MiB relay bound (ADR-0353):
        // 4 x 22,402,439 B + 25,165,824 B = 114,775,580 B, about 109.5 MiB.
        assert_eq!(HTTP_REQUEST_BYTES_LIMIT, 24 * MIB);
        assert_eq!(largest, 22_402_439);
        assert_eq!(socket_limit, 114_775_580);
        // Bounded: under 110 MiB per tunnel socket.
        assert!(socket_limit < 110 * MIB);
    }
}
