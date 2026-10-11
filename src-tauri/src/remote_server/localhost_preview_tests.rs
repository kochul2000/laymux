use super::lease::AndroidE2eFileViewerProof;
use super::localhost_preview::*;
use super::viewer_routes::FileViewerAuthorization;
use crate::remote_server::RemoteControlLease;
use crate::state::AppState;
use axum::http::HeaderMap;
use axum::{routing::get, Router};
use std::time::Instant;

fn state() -> AppState {
    let state = AppState::new();
    state.remote_control.lock().unwrap().install_remote_lease(
        RemoteControlLease {
            lease_id: "preview-lease".into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        },
        std::time::Duration::from_secs(45),
    );
    state
}

#[tokio::test]
async fn a_public_lease_id_alone_does_not_authorize_localhost_access() {
    let app = state();
    assert!(preview_authorization(&app, &HeaderMap::new(), None, "preview-lease").is_err());
}

fn browser_authority(app: &AppState) -> FileViewerAuthorization {
    let capability = app
        .remote_control
        .lock()
        .unwrap()
        .issue_file_viewer_capability("preview-lease");
    FileViewerAuthorization::Browser {
        lease_id: "preview-lease".into(),
        capability,
    }
}

fn android_authority(
    app: &AppState,
) -> (
    crate::android_e2e::AndroidE2eRequestContext,
    String,
    FileViewerAuthorization,
) {
    let context =
        app.android_e2e
            .install_test_request_context("desktop", "owner-session", u64::MAX);
    let token = {
        let mut control = app.remote_control.lock().unwrap();
        control.tag_android_e2e_lease("preview-lease", &context);
        control.issue_file_viewer_capability("preview-lease")
    };
    let proof =
        AndroidE2eFileViewerProof::new(context.clone(), "preview-lease".into(), token.clone());
    let authorization =
        preview_authorization(app, &HeaderMap::new(), Some(&proof), "preview-lease")
            .expect("owner authority");
    (context, token, authorization)
}

#[tokio::test]
async fn a_different_paired_session_cannot_read_or_replace_the_owners_preview_even_with_the_token()
{
    let app = state();
    let (_, token, authority) = android_authority(&app);
    let other = app
        .android_e2e
        .install_test_request_context("desktop", "other-session", u64::MAX);
    let proof = AndroidE2eFileViewerProof::new(other, "preview-lease".into(), token);
    let denied = preview_authorization(&app, &HeaderMap::new(), Some(&proof), "preview-lease")
        .err()
        .expect("different session denied");
    assert_eq!(denied.status(), axum::http::StatusCode::FORBIDDEN);
    let session = app
        .localhost_preview
        .begin(&app, &authority, "http://localhost:8765/")
        .await
        .unwrap();
    assert!(!session.session_id.is_empty());
}

#[tokio::test]
async fn cached_e2e_resource_receipts_die_on_close_replacement_and_capability_rotation() {
    use super::android_e2e_routes::revalidate_cached_file_viewer_request;
    use crate::android_e2e::AndroidE2eReplayGuard;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://localhost:{}/",
        listener.local_addr().unwrap().port()
    );
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/", get(|| async { "private app bytes" })),
        )
        .await
        .unwrap()
    });
    let app = state();
    let (context, token, authority) = android_authority(&app);
    for revoke in ["close", "replace", "rotate"] {
        let session = app
            .localhost_preview
            .begin(&app, &authority, &url)
            .await
            .unwrap();
        let chunk = app
            .localhost_preview
            .read(&app, &authority, &session.session_id, "/", 0)
            .await
            .unwrap();
        let response = chunk.response(&app, &authority);
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let guard = response
            .extensions()
            .get::<AndroidE2eReplayGuard>()
            .expect("sensitive response requires receipt")
            .clone();
        let request = serde_json::json!({"kind":"http", "method":"POST", "path":"/remote/v1/localhost-preview/resource", "body":{
            "sessionId":session.session_id,"leaseId":"preview-lease","pathAndQuery":"/","offset":0,
            "fileViewerAuthorization":{"leaseId":"preview-lease","fileViewerToken":token}
        }});
        revalidate_cached_file_viewer_request(&app, context.clone(), request.clone(), &guard)
            .expect("live authorized retry");
        match revoke {
            "close" => app
                .localhost_preview
                .close(&app, &authority, &session.session_id)
                .await
                .unwrap(),
            "replace" => {
                app.localhost_preview
                    .begin(&app, &authority, &url)
                    .await
                    .unwrap();
            }
            _ => {
                app.remote_control
                    .lock()
                    .unwrap()
                    .issue_file_viewer_capability("preview-lease");
            }
        }
        assert!(
            revalidate_cached_file_viewer_request(&app, context.clone(), request, &guard).is_err(),
            "cached retry after {revoke}"
        );
    }
    task.abort();
}

#[tokio::test]
async fn authority_revoked_during_a_download_cannot_return_the_finished_bytes() {
    use std::sync::Arc;
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let router = Router::new().route(
        "/",
        get({
            let started = started.clone();
            let finish = finish.clone();
            move || {
                let started = started.clone();
                let finish = finish.clone();
                async move {
                    started.notify_one();
                    finish.notified().await;
                    "private bytes"
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://localhost:{}/",
        listener.local_addr().unwrap().port()
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let app = Arc::new(state());
    let authority = browser_authority(&app);
    let session = app
        .localhost_preview
        .begin(&app, &authority, &url)
        .await
        .unwrap();
    let read = tokio::spawn({
        let app = app.clone();
        async move {
            app.localhost_preview
                .read(&app, &authority, &session.session_id, "/", 0)
                .await
        }
    });
    started.notified().await;
    app.remote_control
        .lock()
        .unwrap()
        .issue_file_viewer_capability("preview-lease");
    finish.notify_one();
    assert!(read.await.unwrap().is_err());
    server.abort();
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
    let authorization = browser_authority(&app);
    let preview = PreviewState::default();
    let session = preview
        .begin(&app, &authorization, &format!("http://localhost:{port}/"))
        .await
        .unwrap();
    let first = preview
        .read(&app, &authorization, &session.session_id, "/game.wasm", 0)
        .await
        .unwrap();
    let second = preview
        .read(
            &app,
            &authorization,
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
        .read(
            &app,
            &FileViewerAuthorization::Browser {
                lease_id: "wrong-lease".into(),
                capability: "wrong".into()
            },
            &session.session_id,
            "/game.wasm",
            0
        )
        .await
        .is_err());
    app.remote_control.lock().unwrap().lease = None;
    assert!(preview
        .read(&app, &authorization, &session.session_id, "/game.wasm", 0)
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
    let authorization = browser_authority(&app);
    let preview = PreviewState::default();
    let session = preview
        .begin(&app, &authorization, &format!("http://localhost:{port}/"))
        .await
        .unwrap();
    assert!(preview
        .read(&app, &authorization, &session.session_id, "/", 0)
        .await
        .is_err());
    let replacement = preview
        .begin(
            &app,
            &authorization,
            &format!("http://localhost:{port}/new"),
        )
        .await
        .unwrap();
    assert_ne!(replacement.session_id, session.session_id);
    assert!(preview
        .read(&app, &authorization, &session.session_id, "/", 0)
        .await
        .is_err());
    preview
        .close(&app, &authorization, &replacement.session_id)
        .await
        .unwrap();
    assert!(preview
        .read(&app, &authorization, &replacement.session_id, "/", 0)
        .await
        .is_err());
    server.abort();
}
