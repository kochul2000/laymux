pub mod handlers_backend;
pub mod handlers_bridge;
pub mod helpers;
pub mod mcp;
pub mod mcp_resources;
pub mod settings_bridge;
mod surface_router;
pub mod types;

// Re-export key types used by other modules
pub use helpers::base64_decode;
pub use types::{AutomationRequest, AutomationResponse};

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware;
use axum::routing::{delete, get, post, put};
use axum::Router;
use tauri::AppHandle;
use tokio::net::TcpListener;

use crate::lock_ext::MutexExt;
use crate::state::AppState;

use handlers_backend::*;
use handlers_bridge::*;
use mcp_resources::{SharedSubscriptionRegistry, SubscriptionRegistry};
use surface_router::{compose_surfaces, ip_allowlist_middleware};

/// Shared state for the axum server.
#[derive(Clone)]
pub struct ServerState {
    pub app_state: Arc<AppState>,
    pub app_handle: AppHandle,
}

/// Fixed automation port: release = 19280, dev = 19281.
/// Only one instance of each build type can run at a time.
pub const RELEASE_PORT: u16 = 19280;
pub const DEV_PORT: u16 = 19281;

/// Return the fixed automation port for this build type.
pub fn automation_port() -> u16 {
    if cfg!(debug_assertions) {
        DEV_PORT
    } else {
        RELEASE_PORT
    }
}

/// Write discovery file so external tools can find the automation port.
pub fn write_discovery_file(port: u16) {
    write_discovery_file_in(&discovery_dir(), port);
}

/// Remove discovery file on shutdown.
pub fn remove_discovery_file() {
    remove_discovery_file_in(&discovery_dir());
}

/// Directory that owns the discovery file — the settings directory
/// (`%APPDATA%\laymux[-dev]`, `~/.config/laymux[-dev]`). See api-contracts §12.2.
fn discovery_dir() -> std::path::PathBuf {
    crate::settings::settings_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn discovery_file_path_in(base: &std::path::Path) -> std::path::PathBuf {
    base.join("automation.json")
}

/// Base-relative write. Tests pass a temp directory so they never touch the
/// live dev instance's discovery file (issue #574).
fn write_discovery_file_in(base: &std::path::Path, port: u16) {
    let path = discovery_file_path_in(base);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&content).unwrap_or_default(),
    );
}

fn remove_discovery_file_in(base: &std::path::Path) {
    let _ = std::fs::remove_file(discovery_file_path_in(base));
}

/// Start the automation HTTP server on a fixed port.
/// Release = 19280, Dev = 19281. No fallback — fails if port is occupied.
pub async fn start(app_state: Arc<AppState>, app_handle: AppHandle) -> Result<u16, String> {
    let server_state = ServerState {
        app_state: app_state.clone(),
        app_handle: app_handle.clone(),
    };

    // MCP resource subscription registry — shared between the MCP service
    // (used inside `build_router`) and the Tauri→MCP event bridge spawned
    // below. The bridge converts Tauri events into
    // `notifications/resources/updated` for subscribed peers.
    let subscriptions = SubscriptionRegistry::new();
    mcp_resources::spawn_resource_event_bridge(app_handle.clone(), subscriptions.clone());

    let port = automation_port();
    let is_dev = port == DEV_PORT;
    let app = build_router(server_state, subscriptions, is_dev);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind automation server on port {port}: {e}. Is another instance already running?"))?;

    // Store port in AppState
    if let Ok(mut p) = app_state.automation_port.lock_or_err() {
        *p = Some(port);
    } else {
        tracing::error!("Failed to store automation port in AppState (lock poisoned)");
    }

    write_discovery_file(port);

    tracing::info!(port, "Automation server listening on 0.0.0.0:{port}");

    tokio::spawn(async move {
        if let Err(e) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            tracing::error!(error = %e, "Automation server error");
        }
    });

    Ok(port)
}

pub fn build_router(
    state: ServerState,
    subscriptions: SharedSubscriptionRegistry,
    is_dev: bool,
) -> Router {
    let automation_routes = Router::new()
        .route("/api/v1/docs", get(api_docs))
        .route("/api/v1/health", get(health))
        .route("/api/v1/diagnostics/frontend", get(diagnostics_frontend))
        .route("/api/v1/workspaces", get(workspaces_list))
        .route("/api/v1/workspaces", post(workspaces_create))
        .route("/api/v1/workspaces/active", get(workspaces_get_active))
        .route("/api/v1/workspaces/active", post(workspaces_switch_active))
        .route("/api/v1/workspaces/reorder", post(workspaces_reorder))
        .route("/api/v1/workspaces/{id}", put(workspaces_rename))
        .route("/api/v1/workspaces/{id}", delete(workspaces_delete))
        .route("/api/v1/layouts/export", post(layouts_export))
        .route("/api/v1/grid", get(grid_get_state))
        .route("/api/v1/grid/edit-mode", post(grid_set_edit_mode))
        .route("/api/v1/grid/focus", post(grid_focus_pane))
        .route("/api/v1/grid/hover", post(grid_simulate_hover))
        .route("/api/v1/panes/split", post(panes_split))
        .route("/api/v1/panes/{index}", delete(panes_remove))
        .route("/api/v1/panes/{index}/resize", post(panes_resize))
        .route("/api/v1/panes/{index}/view", put(panes_set_view))
        .route("/api/v1/docks", get(docks_list))
        .route(
            "/api/v1/docks/layout-mode/toggle",
            post(docks_toggle_layout_mode),
        )
        .route(
            "/api/v1/docks/{position}/active-view",
            put(docks_set_active_view),
        )
        .route(
            "/api/v1/docks/{position}/toggle",
            post(docks_toggle_visible),
        )
        .route("/api/v1/docks/{position}/size", put(docks_set_size))
        .route("/api/v1/docks/{position}/views", put(docks_set_views))
        .route("/api/v1/docks/{position}/split", post(docks_split_pane))
        .route(
            "/api/v1/docks/{position}/panes/{paneId}",
            delete(docks_remove_pane),
        )
        .route(
            "/api/v1/docks/{position}/panes/{paneId}/view",
            put(docks_set_pane_view),
        )
        .route("/api/v1/terminals", get(terminals_list))
        .route("/api/v1/terminals/{id}/write", post(terminal_write))
        .route("/api/v1/terminals/{id}/output", get(terminal_output))
        .route("/api/v1/terminals/{id}/buffer", get(terminal_buffer_dump))
        .route("/api/v1/memos", get(memos_list))
        .route("/api/v1/memos/{key}", get(memo_get))
        .route("/api/v1/notifications", get(notifications_list))
        .route("/api/v1/notifications", post(notifications_add))
        .route("/api/v1/notifications", delete(notifications_clear))
        .route(
            "/api/v1/notifications/mark-read",
            post(notifications_mark_read),
        )
        .route(
            "/api/v1/workspaces/{id}/summary",
            get(workspaces_get_summary),
        )
        .route("/api/v1/terminals/{id}/focus", post(terminals_set_focus))
        .route("/api/v1/terminals/states", get(terminals_states))
        .route("/api/v1/layouts", get(layouts_list))
        .route("/api/v1/screenshot", post(screenshot_capture))
        .nest_service(
            "/mcp",
            mcp::create_service(state.clone(), subscriptions.clone(), is_dev),
        )
        .route("/api/v1/ui/settings", post(ui_toggle_settings))
        .route("/api/v1/ui/remote-access", post(ui_remote_access))
        .route("/api/v1/ui/settings/navigate", post(ui_navigate_settings))
        .route("/api/v1/ui/file-viewer", post(ui_open_file_viewer))
        .route("/api/v1/settings/app-theme", put(settings_set_app_theme))
        .route(
            "/api/v1/settings/profile-defaults",
            put(settings_set_profile_defaults),
        )
        .route(
            "/api/v1/settings/profiles/{index}",
            put(settings_update_profile),
        )
        .route(
            "/api/v1/ui/notifications",
            post(ui_toggle_notification_panel),
        )
        .route("/api/v1/ui/hidden-items", post(ui_set_hidden_items_open))
        .route(
            "/api/v1/ui/hidden/workspace/{id}/toggle",
            post(ui_toggle_workspace_hidden),
        )
        .route(
            "/api/v1/ui/hidden/pane/{id}/toggle",
            post(ui_toggle_pane_hidden),
        )
        .layer(middleware::from_fn(ip_allowlist_middleware));

    compose_surfaces(
        automation_routes,
        crate::remote_server::build_router(state.clone()),
    )
    .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_port_returns_dev_in_debug() {
        assert_eq!(automation_port(), DEV_PORT);
        assert_eq!(automation_port(), 19281);
    }

    #[test]
    fn port_constants_are_adjacent() {
        assert_eq!(DEV_PORT, RELEASE_PORT + 1);
    }

    #[test]
    fn discovery_file_path_ends_with_automation_json() {
        // Real path (api-contracts §12.2) — read only, never written by tests.
        assert!(discovery_file_path_in(&discovery_dir())
            .to_string_lossy()
            .ends_with("automation.json"));
        // Base-relative form used by tests.
        let dir = tempfile::tempdir().unwrap();
        assert!(discovery_file_path_in(dir.path())
            .to_string_lossy()
            .ends_with("automation.json"));
    }

    #[test]
    fn write_and_remove_discovery_file_uses_given_base() {
        let dir = tempfile::tempdir().unwrap();
        let live = discovery_file_path_in(&discovery_dir());
        // 존재 여부만으로는 #574 의 실제 피해(파일을 지우지 않고 port 19280 으로 덮어씀)를
        // 못 잡는다. 내용까지 스냅샷해야 "지우고 다시 만든" 경우도 같이 걸린다.
        let live_before = std::fs::read(&live).ok();

        write_discovery_file_in(dir.path(), 19280);
        let path = discovery_file_path_in(dir.path());
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["port"], 19280);
        assert!(parsed.get("key").is_none());
        assert!(parsed["pid"].as_u64().unwrap() > 0);
        assert_eq!(parsed["version"], env!("CARGO_PKG_VERSION"));

        remove_discovery_file_in(dir.path());
        assert!(!path.exists());

        // The live dev instance's discovery file must be untouched (issue #574).
        assert_eq!(
            std::fs::read(&live).ok(),
            live_before,
            "test must not create, delete, or rewrite {}",
            live.display()
        );
    }

    #[test]
    fn write_discovery_file_creates_missing_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("nested").join("config");
        assert!(!base.exists());

        write_discovery_file_in(&base, DEV_PORT);

        let path = discovery_file_path_in(&base);
        assert!(path.exists());
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], DEV_PORT);
    }
}
