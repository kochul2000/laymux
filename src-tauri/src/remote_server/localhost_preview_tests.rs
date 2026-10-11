use super::localhost_preview::*;
use crate::remote_server::RemoteControlLease;
use crate::state::AppState;
use axum::{routing::get, Router};
use std::time::Instant;

fn state() -> AppState {
    let state = AppState::new();
    state.remote_control.lock().unwrap().lease = Some(RemoteControlLease {
        lease_id: "preview-lease".into(),
        remote_addr: "127.0.0.1:1".into(),
        client_name: None,
        last_heartbeat: Instant::now(),
    });
    state
}

#[test]
fn only_explicit_non_management_loopback_origins_are_accepted() {
    for url in [
        "http://localhost:8765/",
        "http://127.0.0.1:8765/game?q=1",
        "http://[::1]:8765/",
    ] {
        assert!(preview_target(url).is_ok(), "{url}");
    }
    for url in [
        "https://localhost:8765/",
        "http://example.org:8765/",
        "http://localhost/",
        "http://localhost:19280/",
        "http://127.0.0.1:19281/",
        "http://u:p@localhost:8765/",
    ] {
        assert!(preview_target(url).is_err(), "{url}");
    }
}

#[test]
fn resource_paths_cannot_replace_the_registered_authority() {
    let target = preview_target("http://localhost:8765/game/").unwrap();
    assert_eq!(
        resource_url(&target, "/index.wasm?v=2").unwrap().as_str(),
        "http://127.0.0.1:8765/index.wasm?v=2"
    );
    for path in [
        "//evil.test/",
        "http://evil.test/",
        "/\\evil.test/",
        "/x\r\ny",
        "/x#fragment",
    ] {
        assert!(resource_url(&target, path).is_err(), "{path}");
    }
}

#[tokio::test]
async fn large_binary_is_read_in_chunks_once_and_stale_leases_cannot_read_cache() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let reads = Arc::new(AtomicUsize::new(0));
    let expected: Vec<u8> = (0..CHUNK_BYTES + 53).map(|i| (i % 251) as u8).collect();
    let router = Router::new().route(
        "/game.wasm",
        get({
            let reads = reads.clone();
            let bytes = expected.clone();
            move |headers: axum::http::HeaderMap| {
                let reads = reads.clone();
                let bytes = bytes.clone();
                async move {
                    assert!(!headers.contains_key("authorization"));
                    assert!(!headers.contains_key("cookie"));
                    reads.fetch_add(1, Ordering::SeqCst);
                    ([("content-type", "application/wasm")], bytes)
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let app = state();
    let preview = PreviewState::default();
    let session = preview
        .begin(&app, "preview-lease", &format!("http://localhost:{port}/"))
        .await
        .unwrap();
    let first = preview
        .read(&app, "preview-lease", &session.session_id, "/game.wasm", 0)
        .await
        .unwrap();
    let second = preview
        .read(
            &app,
            "preview-lease",
            &session.session_id,
            "/game.wasm",
            first.next_offset,
        )
        .await
        .unwrap();
    use base64::Engine;
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(first.body)
        .unwrap();
    bytes.extend(
        base64::engine::general_purpose::STANDARD
            .decode(second.body)
            .unwrap(),
    );
    assert_eq!(bytes, expected);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(preview
        .read(&app, "wrong-lease", &session.session_id, "/game.wasm", 0)
        .await
        .is_err());
    app.remote_control.lock().unwrap().lease = None;
    assert!(preview
        .read(&app, "preview-lease", &session.session_id, "/game.wasm", 0)
        .await
        .is_err());
    server.abort();
}

#[tokio::test]
async fn a_redirect_to_another_local_service_is_never_followed() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = Router::new().route(
        "/",
        get(|| async {
            axum::response::Redirect::temporary("http://127.0.0.1:19280/api/v1/settings")
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let app = state();
    let preview = PreviewState::default();
    let session = preview
        .begin(&app, "preview-lease", &format!("http://localhost:{port}/"))
        .await
        .unwrap();
    assert!(preview
        .read(&app, "preview-lease", &session.session_id, "/", 0)
        .await
        .is_err());
    let replacement = preview
        .begin(
            &app,
            "preview-lease",
            &format!("http://localhost:{port}/new"),
        )
        .await
        .unwrap();
    assert_ne!(replacement.session_id, session.session_id);
    assert!(preview
        .read(&app, "preview-lease", &session.session_id, "/", 0)
        .await
        .is_err());
    preview
        .close(&app, "preview-lease", &replacement.session_id)
        .await
        .unwrap();
    assert!(preview
        .read(&app, "preview-lease", &replacement.session_id, "/", 0)
        .await
        .is_err());
    server.abort();
}
