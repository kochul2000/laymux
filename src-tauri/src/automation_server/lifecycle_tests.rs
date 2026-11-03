use super::lifecycle::{Phase, ServerLifecycle};
use axum::{routing::get, Router};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;

fn router() -> Router {
    Router::new().route("/health", get(|| async { "ready" }))
}

async fn failed(server: &ServerLifecycle) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while server.snapshot().unwrap().phase != Phase::Failed {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn occupied_port_is_visible_and_retry_recovers_http_without_replacing_a_live_server() {
    let directory = tempfile::tempdir().unwrap();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = occupied.local_addr().unwrap();
    let server = Arc::new(ServerLifecycle::default());
    let first = server
        .start(address, directory.path(), router)
        .await
        .unwrap();
    assert_eq!(first.phase, Phase::Failed);
    assert!(first.error.unwrap().contains(&address.port().to_string()));
    assert!(!directory.path().join("automation.json").exists());
    drop(occupied);

    let (a, b) = tokio::join!(
        server.start(address, directory.path(), router),
        server.start(address, directory.path(), || panic!(
            "must reuse the healthy server"
        ))
    );
    assert_eq!(a.unwrap().phase, Phase::Running);
    assert_eq!(b.unwrap().phase, Phase::Running);
    let response = reqwest::get(format!("http://{address}/health"))
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "ready");
    let discovery: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("automation.json")).unwrap())
            .unwrap();
    assert_eq!(discovery["port"], address.port());
    assert_eq!(discovery["pid"], std::process::id());
    server.fail_stop().await.unwrap();
    failed(&server).await;
}

#[tokio::test]
async fn server_task_exit_clears_its_discovery_and_can_be_retried() {
    let directory = tempfile::tempdir().unwrap();
    let server = Arc::new(ServerLifecycle::default());
    let address: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let before = server
        .start(address, directory.path(), router)
        .await
        .unwrap();
    assert_eq!(before.phase, Phase::Running);
    server.fail_stop().await.unwrap();
    failed(&server).await;
    let failure = server.snapshot().unwrap();
    assert!(failure.revision > before.revision);
    assert!(failure.error.is_some());
    assert!(!directory.path().join("automation.json").exists());
    assert!(TcpListener::bind(("127.0.0.1", before.port)).await.is_ok());
    let after = server
        .start(address, directory.path(), router)
        .await
        .unwrap();
    assert_eq!(after.phase, Phase::Running);
    assert!(after.error.is_none());
    assert!(after.revision > failure.revision);
    server.fail_stop().await.unwrap();
    failed(&server).await;
}

#[tokio::test]
async fn failure_never_removes_another_instances_discovery() {
    let directory = tempfile::tempdir().unwrap();
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = occupied.local_addr().unwrap();
    let path = directory.path().join("automation.json");
    let foreign = br#"{"port":19281,"pid":4294967295}"#;
    std::fs::write(&path, foreign).unwrap();
    let server = Arc::new(ServerLifecycle::default());
    server
        .start(address, directory.path(), router)
        .await
        .unwrap();
    assert_eq!(std::fs::read(path).unwrap(), foreign);
}
