use std::convert::Infallible;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Request};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::stream;

use super::*;
use crate::constants::{ANDROID_E2E_RPC_ENVELOPE_PREFIX_BYTES, ANDROID_E2E_RPC_PATH};

const EXPIRED_SESSION_BYTE: u8 = 6;

fn live_state() -> (AppState, String) {
    let state = AppState::new();
    let session_id = URL_SAFE_NO_PAD.encode([3_u8; 16]);
    state
        .android_e2e
        .install_test_request_context("desktop-7", &session_id, u64::MAX);
    // Expired long ago: its prefix is answered with 410.
    state.android_e2e.install_test_request_context(
        "desktop-7",
        &URL_SAFE_NO_PAD.encode([EXPIRED_SESSION_BYTE; 16]),
        1,
    );
    (state, session_id)
}

fn unknown_session() -> String {
    URL_SAFE_NO_PAD.encode([4_u8; 16])
}

fn expired_session() -> String {
    URL_SAFE_NO_PAD.encode([EXPIRED_SESSION_BYTE; 16])
}

fn chunked(chunks: Vec<Vec<u8>>) -> Body {
    Body::from_stream(stream::iter(chunks.into_iter().map(Ok::<_, Infallible>)))
}

fn short_bounds(byte_cap: usize) -> DiscardBounds {
    DiscardBounds {
        byte_cap,
        idle: Duration::from_millis(100),
        total: Duration::from_secs(5),
    }
}

fn closes_connection(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONNECTION)
        .is_some_and(|value| value == "close")
}

#[tokio::test]
async fn direct_body_is_parsed_across_chunk_boundaries() {
    let (state, session_id) = live_state();
    let body = crate::android_e2e::encode_rpc_request(&session_id, 0, &[7_u8; 40]);
    let chunks = body.chunks(5).map(<[u8]>::to_vec).collect();
    let envelope = read_android_e2e_rpc_body(&state, chunked(chunks), 1024)
        .await
        .unwrap_or_else(|response| panic!("rejected: {}", response.status()));
    assert_eq!(envelope.session_id, session_id);
    assert_eq!(envelope.ciphertext, vec![7_u8; 40]);
}

#[tokio::test]
async fn rejected_prefix_is_answered_after_the_rest_of_the_body_is_discarded() {
    let (state, _) = live_state();
    let prefix = crate::android_e2e::encode_rpc_request(&unknown_session(), 0, &[]);
    // Far more than the request limit: the discard holds none of it.
    let consumed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = consumed.clone();
    let body = Body::from_stream(
        stream::iter(std::iter::once(prefix).chain(std::iter::repeat_n(vec![0_u8; 64 * 1024], 32)))
            .map(move |chunk| {
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok::<_, Infallible>(chunk)
            }),
    );
    let response = read_android_e2e_rpc_body_with(&state, body, 1024, short_bounds(4 << 20))
        .await
        .unwrap_err();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(consumed.load(std::sync::atomic::Ordering::Relaxed), 33);
    assert!(!closes_connection(&response));
}

#[tokio::test]
async fn discard_that_outgrows_the_cap_answers_and_closes() {
    let (state, _) = live_state();
    let prefix = crate::android_e2e::encode_rpc_request(&unknown_session(), 0, &[]);
    // A stream that never ends: only the byte cap can stop the discard.
    let body = Body::from_stream(
        stream::iter(vec![Ok::<_, Infallible>(prefix)])
            .chain(stream::repeat_with(|| Ok(vec![0_u8; 1024]))),
    );
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        read_android_e2e_rpc_body_with(&state, body, 1024, short_bounds(256 * 1024)),
    )
    .await
    .expect("the byte cap must end the discard")
    .unwrap_err();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(closes_connection(&response));
}

#[tokio::test]
async fn stalled_discard_answers_and_closes_at_the_idle_deadline() {
    let (state, _) = live_state();
    let prefix = crate::android_e2e::encode_rpc_request(&expired_session(), 0, &[]);
    // The rest of the body never arrives.
    let body =
        Body::from_stream(stream::iter(vec![Ok::<_, Infallible>(prefix)]).chain(stream::pending()));
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        read_android_e2e_rpc_body_with(&state, body, 1024, short_bounds(1 << 20)),
    )
    .await
    .expect("the idle deadline must end the discard")
    .unwrap_err();
    assert_eq!(response.status(), StatusCode::GONE);
    assert!(closes_connection(&response));
}

#[tokio::test]
async fn trickling_discard_answers_and_closes_at_the_total_deadline() {
    let (state, _) = live_state();
    let prefix = crate::android_e2e::encode_rpc_request(&unknown_session(), 0, &[]);
    // One byte every 10 ms never trips the idle deadline.
    let trickle = stream::unfold((), |()| async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        Some((Ok::<_, Infallible>(vec![0_u8]), ()))
    });
    let body = Body::from_stream(stream::iter(vec![Ok::<_, Infallible>(prefix)]).chain(trickle));
    let bounds = DiscardBounds {
        byte_cap: 1 << 20,
        idle: Duration::from_secs(1),
        total: Duration::from_millis(200),
    };
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        read_android_e2e_rpc_body_with(&state, body, 1024, bounds),
    )
    .await
    .expect("the total deadline must end the discard")
    .unwrap_err();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(closes_connection(&response));
}

#[tokio::test]
async fn direct_body_rejects_wrong_format_and_short_bodies() {
    let (state, session_id) = live_state();
    let mut wrong = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 16]);
    wrong[0] = 1;
    let response = read_android_e2e_rpc_body(&state, Body::from(wrong), 1024)
        .await
        .unwrap_err();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let short = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 15]);
    let response = read_android_e2e_rpc_body(&state, Body::from(short), 1024)
        .await
        .unwrap_err();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = read_android_e2e_rpc_body(&state, Body::from(vec![2_u8; 10]), 1024)
        .await
        .unwrap_err();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn direct_body_enforces_the_host_derived_limit() {
    let (state, session_id) = live_state();
    let body = crate::android_e2e::encode_rpc_request(&session_id, 0, &[0; 100]);
    let exact = body.len();
    assert!(
        read_android_e2e_rpc_body(&state, Body::from(body.clone()), exact)
            .await
            .is_ok()
    );
    let response = read_android_e2e_rpc_body(&state, Body::from(body), exact - 1)
        .await
        .unwrap_err();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!closes_connection(&response));
}

#[test]
fn direct_discard_admits_the_largest_envelope_any_host_allows() {
    let bounds = DiscardBounds::DIRECT;
    assert_eq!(bounds.byte_cap, ANDROID_E2E_RPC_MAX_BODY_BYTES);
    let state = AppState::new();
    assert!(android_e2e_rpc_request_limit(&state).unwrap() <= bounds.byte_cap);
    assert_eq!(
        bounds.idle,
        Duration::from_secs(crate::constants::CLOUD_RELAY_ANDROID_E2E_RPC_BODY_IDLE_TIMEOUT_SECS)
    );
    assert!(bounds.total > bounds.idle);
}

#[test]
fn request_limit_follows_the_host_attachment_setting() {
    let state = AppState::new();
    let settings = effective_remote_settings(&state).unwrap();
    let host = AttachmentPolicy::from_settings(&settings, None).host_max_bytes;
    assert_eq!(
        android_e2e_rpc_request_limit(&state).unwrap(),
        android_e2e_rpc_body_limit(host)
    );
}

// --- Real HTTP/1.1 server: the client writes the whole body before reading,
// exactly like Android's fixed-length `HttpURLConnection` (ADR-0352). ---

async fn serve_rpc_route(state: AppState, limit: usize, bounds: DiscardBounds) -> SocketAddr {
    let state = Arc::new(state);
    let app = Router::new()
        .route(
            ANDROID_E2E_RPC_PATH,
            post(move |request: Request| {
                let state = state.clone();
                async move {
                    match read_android_e2e_rpc_body_with(&state, request.into_body(), limit, bounds)
                        .await
                    {
                        Ok(_) => StatusCode::OK.into_response(),
                        Err(response) => response,
                    }
                }
            }),
        )
        .layer(DefaultBodyLimit::disable());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

struct RawResponse {
    status: u16,
    connection_close: bool,
}

/// Writes one request with its entire body, then reads the response. A write
/// error means the server gave up on the body before the client could see
/// its status.
fn post_whole_body(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<RawResponse> {
    write!(
        stream,
        "POST {ANDROID_E2E_RPC_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
         Content-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )?;
    for chunk in body.chunks(64 * 1024) {
        stream.write_all(chunk)?;
    }
    stream.flush()?;
    read_response(stream)
}

fn read_response(stream: &mut TcpStream) -> std::io::Result<RawResponse> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte)? == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("status line");
    let header = |name: &str| {
        head.lines().find_map(|line| {
            line.strip_prefix(name)
                .map(|value| value.trim().to_string())
        })
    };
    let length: usize = header("content-length:")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0_u8; length];
    stream.read_exact(&mut body)?;
    Ok(RawResponse {
        status,
        connection_close: header("connection:").is_some_and(|value| value == "close"),
    })
}

fn connect(addr: SocketAddr) -> TcpStream {
    let stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    stream
}

fn large_body(session_id: &str, ciphertext_bytes: usize) -> Vec<u8> {
    crate::android_e2e::encode_rpc_request(session_id, 0, &vec![0x5A_u8; ciphertext_bytes])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_client_writing_a_large_body_receives_401_then_410_on_the_same_connection() {
    let (state, _) = live_state();
    let addr = serve_rpc_route(state, 1 << 20, short_bounds(16 << 20)).await;
    let (unauthorized, gone) = tokio::task::spawn_blocking(move || {
        let mut stream = connect(addr);
        // 8 MiB: far beyond any socket buffer, so the server must read it.
        let unauthorized = post_whole_body(&mut stream, &large_body(&unknown_session(), 8 << 20))
            .expect("the whole body is written and the status read");
        let gone = post_whole_body(&mut stream, &large_body(&expired_session(), 4 << 20))
            .expect("the drained connection stays usable");
        (unauthorized, gone)
    })
    .await
    .unwrap();
    assert_eq!(unauthorized.status, 401);
    assert!(!unauthorized.connection_close);
    assert_eq!(gone.status, 410);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_client_over_the_limit_receives_413_after_writing_the_body() {
    let (state, session_id) = live_state();
    let addr = serve_rpc_route(state, 64 * 1024, short_bounds(16 << 20)).await;
    let response = tokio::task::spawn_blocking(move || {
        post_whole_body(&mut connect(addr), &large_body(&session_id, 6 << 20))
    })
    .await
    .unwrap()
    .expect("the whole body is written and the status read");
    assert_eq!(response.status, 413);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_client_beyond_the_discard_cap_is_answered_and_closed() {
    const CAP: usize = 512 * 1024;
    let (state, _) = live_state();
    let addr = serve_rpc_route(state, 1 << 20, short_bounds(CAP)).await;
    let response = tokio::task::spawn_blocking(move || {
        let mut stream = connect(addr);
        // Declares four times the cap but sends one byte past it, so the
        // server has read everything sent when it gives up: the answer
        // arrives before an orderly close instead of racing a reset.
        let body = large_body(
            &unknown_session(),
            CAP + 1 - ANDROID_E2E_RPC_ENVELOPE_PREFIX_BYTES,
        );
        write!(
            stream,
            "POST {ANDROID_E2E_RPC_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
             Content-Length: {}\r\n\r\n",
            CAP * 4
        )?;
        stream.write_all(&body)?;
        stream.flush()?;
        read_response(&mut stream)
    })
    .await
    .unwrap()
    .expect("the answer arrives before the close");
    assert_eq!(response.status, 401);
    assert!(response.connection_close);
}
