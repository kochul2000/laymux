//! App-owned listener lifecycle. The gate serializes startup, retry and exit
//! cleanup; the status mutex is a leaf and is never held over I/O or await.
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use rmcp::transport::streamable_http_server::StreamableHttpServerConfig;
use tokio::net::TcpListener;
use tokio::task::AbortHandle;

use crate::error::AppError;
use crate::lock_ext::MutexExt;

use super::mcp_resources::{SharedSubscriptionRegistry, SubscriptionRegistry};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Starting,
    Running,
    Failed,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub phase: Phase,
    pub port: u16,
    pub error: Option<String>,
    pub revision: u64,
}

pub struct ServerLifecycle {
    gate: tokio::sync::Mutex<Option<RunningServer>>,
    status: Mutex<ServerStatus>,
    subscriptions: OnceLock<SharedSubscriptionRegistry>,
}

struct RunningServer {
    task: AbortHandle,
    mcp: StreamableHttpServerConfig,
}

impl Default for ServerLifecycle {
    fn default() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(None),
            status: Mutex::new(ServerStatus {
                phase: Phase::Starting,
                port: super::automation_port(),
                error: None,
                revision: 0,
            }),
            subscriptions: OnceLock::new(),
        }
    }
}

impl ServerLifecycle {
    pub fn snapshot(&self) -> Result<ServerStatus, AppError> {
        Ok(self.status.lock_or_err()?.clone())
    }

    pub fn running_port(&self) -> Result<Option<u16>, AppError> {
        let status = self.snapshot()?;
        Ok((status.phase == Phase::Running).then_some(status.port))
    }

    pub(super) fn subscriptions(&self, app: tauri::AppHandle) -> SharedSubscriptionRegistry {
        self.subscriptions
            .get_or_init(|| {
                let registry = SubscriptionRegistry::new();
                super::mcp_resources::spawn_resource_event_bridge(app, registry.clone());
                registry
            })
            .clone()
    }

    fn update(
        &self,
        phase: Phase,
        port: u16,
        error: Option<String>,
    ) -> Result<ServerStatus, AppError> {
        let mut status = self.status.lock_or_err()?;
        status.phase = phase;
        status.port = port;
        status.error = error;
        status.revision += 1;
        Ok(status.clone())
    }

    /// Bind first: failed retries never install resource listeners or publish
    /// discovery. Running servers are idempotent, including concurrent retries.
    pub(super) async fn start(
        self: &Arc<Self>,
        address: SocketAddr,
        directory: &Path,
        make_router: impl FnOnce(StreamableHttpServerConfig) -> Router,
    ) -> Result<ServerStatus, AppError> {
        let mut active = self.gate.lock().await;
        if active.is_some() {
            return self.snapshot();
        }
        self.update(Phase::Starting, address.port(), None)?;
        let listener = match TcpListener::bind(address).await {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!(
                    "Failed to bind automation server on port {}: {error}",
                    address.port()
                );
                tracing::warn!(%message, "MCP/Automation server start failed");
                return self.update(Phase::Failed, address.port(), Some(message));
            }
        };
        let port = listener.local_addr()?.port();
        let mcp = StreamableHttpServerConfig::default();
        let router = make_router(mcp.clone());
        super::write_discovery_file_in(directory, port);
        let serving = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        *active = Some(RunningServer {
            task: serving.abort_handle(),
            mcp,
        });
        let status = self.update(Phase::Running, port, None)?;
        tracing::info!(port, "MCP/Automation server listening");

        let owner = self.clone();
        let directory = directory.to_path_buf();
        tokio::spawn(async move {
            let error = match serving.await {
                Ok(Ok(())) => "Automation server stopped unexpectedly".to_string(),
                Ok(Err(error)) => format!("Automation server error: {error}"),
                Err(error) => format!("Automation server task stopped: {error}"),
            };
            // Cleanup finishes before another attempt can acquire the port.
            let mut active = owner.gate.lock().await;
            if let Some(server) = active.as_ref() {
                server.mcp.cancellation_token.cancel();
            }
            if let Some(registry) = owner.subscriptions.get() {
                match registry.lock_or_err() {
                    Ok(mut registry) => registry.clear(),
                    Err(error) => {
                        tracing::error!(%error, "Failed to clear stopped MCP subscriptions")
                    }
                }
            }
            remove_owned_discovery_file(&directory);
            if let Err(status_error) = owner.update(Phase::Failed, port, Some(error.clone())) {
                tracing::error!(%status_error, "Failed to record automation server failure");
            }
            *active = None;
            tracing::warn!(%error, port, "MCP/Automation server unavailable");
        });
        Ok(status)
    }

    /// Dev injection also exercises the supervisor's cancellation path.
    pub(crate) async fn fail_stop(&self) -> Result<(), AppError> {
        if !cfg!(debug_assertions) {
            return Err(AppError::Other(
                "Server failure injection is dev-only".into(),
            ));
        }
        let active = self.gate.lock().await;
        let handle = active
            .as_ref()
            .ok_or_else(|| AppError::Other("Server is not running".into()))?;
        handle.task.abort();
        Ok(())
    }
}

pub(super) fn remove_owned_discovery_file(directory: &Path) {
    let path: PathBuf = directory.join("automation.json");
    let owner = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("pid").and_then(|pid| pid.as_u64()));
    if owner == Some(u64::from(std::process::id())) {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(%error, "Failed to remove automation discovery file");
        }
    }
}
