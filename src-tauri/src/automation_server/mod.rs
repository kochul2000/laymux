pub mod handlers_backend;
pub mod handlers_bridge;
pub mod helpers;
pub mod mcp;
pub mod mcp_resources;
pub mod types;

// Re-export key types used by other modules
pub use helpers::base64_decode;
pub use types::{AutomationRequest, AutomationResponse};

use std::net::SocketAddr;
use std::sync::Arc;

use std::net::IpAddr;

use axum::extract::ConnectInfo;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use tauri::AppHandle;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::lock_ext::MutexExt;
use crate::state::AppState;

use handlers_backend::*;
use handlers_bridge::*;
use helpers::err_json;
use mcp_resources::{SharedSubscriptionRegistry, SubscriptionRegistry};

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
    let path = discovery_file_path();
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

/// Remove discovery file on shutdown.
pub fn remove_discovery_file() {
    let _ = std::fs::remove_file(discovery_file_path());
}

fn discovery_file_path() -> std::path::PathBuf {
    crate::settings::settings_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("automation.json")
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

    let app = build_router(server_state, subscriptions);

    let port = automation_port();
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

/// Check if an IP address is allowed to access the automation API.
/// Allows only loopback, link-local, and Hyper-V/WSL2 bridge (172.16.0.0/12).
/// Broader RFC 1918 ranges (10.0.0.0/8, 192.168.0.0/16) are excluded to prevent
/// LAN/VPN peers from accessing the API without authentication.
fn is_local_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()            // 127.0.0.0/8
                || (v4.octets()[0] == 172 && (16..=31).contains(&v4.octets()[1])) // 172.16.0.0/12 (WSL2/Hyper-V)
                || (v4.octets()[0] == 169 && v4.octets()[1] == 254) // 169.254.0.0/16 link-local
        }
        IpAddr::V6(v6) => {
            // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x) — OS may use these when bound to 0.0.0.0
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_local_ip(&IpAddr::V4(mapped));
            }
            v6.is_loopback()  // ::1
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        }
    }
}

/// IP allowlist middleware — only permits requests from local/private networks.
/// Replaces Bearer token auth: since this is localhost/WSL communication,
/// IP restriction provides equivalent security without key management overhead.
async fn ip_allowlist_middleware(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if is_local_ip(&addr.ip()) {
        next.run(req).await
    } else {
        (
            StatusCode::FORBIDDEN,
            Json(err_json(
                "Access denied: only local/private network connections are allowed",
            )),
        )
            .into_response()
    }
}

pub fn build_router(state: ServerState, subscriptions: SharedSubscriptionRegistry) -> Router {
    Router::new()
        .route("/api/v1/docs", get(api_docs))
        .route("/api/v1/health", get(health))
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
        .route("/api/v1/notifications", get(notifications_list))
        .route("/api/v1/notifications", post(notifications_add))
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
            mcp::create_service(state.clone(), subscriptions.clone()),
        )
        .route("/api/v1/ui/settings", post(ui_toggle_settings))
        .route("/api/v1/ui/settings/navigate", post(ui_navigate_settings))
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
        .route("/api/v1/ui/hide-mode/toggle", post(ui_toggle_hide_mode))
        .route(
            "/api/v1/ui/hidden/workspace/{id}/toggle",
            post(ui_toggle_workspace_hidden),
        )
        .route(
            "/api/v1/ui/hidden/pane/{id}/toggle",
            post(ui_toggle_pane_hidden),
        )
        .layer(middleware::from_fn(ip_allowlist_middleware))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use serial_test::serial;
    use tower::ServiceExt;

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
    fn is_local_ip_allows_loopback() {
        assert!(is_local_ip(&"127.0.0.1".parse().unwrap()));
        assert!(is_local_ip(&"127.0.0.2".parse().unwrap()));
        assert!(is_local_ip(&"::1".parse().unwrap()));
    }

    #[test]
    fn is_local_ip_allows_wsl2_and_link_local() {
        // 172.16.0.0/12 (WSL2/Hyper-V bridge)
        assert!(is_local_ip(&"172.16.0.1".parse().unwrap()));
        assert!(is_local_ip(&"172.31.255.255".parse().unwrap()));
        // link-local
        assert!(is_local_ip(&"169.254.1.1".parse().unwrap()));
    }

    #[test]
    fn is_local_ip_rejects_lan_and_vpn_ranges() {
        // 10.0.0.0/8 (corporate VPN)
        assert!(!is_local_ip(&"10.0.0.1".parse().unwrap()));
        assert!(!is_local_ip(&"10.255.255.255".parse().unwrap()));
        // 192.168.0.0/16 (home LAN)
        assert!(!is_local_ip(&"192.168.1.1".parse().unwrap()));
        assert!(!is_local_ip(&"192.168.0.1".parse().unwrap()));
    }

    #[test]
    fn is_local_ip_rejects_public() {
        assert!(!is_local_ip(&"8.8.8.8".parse().unwrap()));
        assert!(!is_local_ip(&"172.32.0.1".parse().unwrap()));
        assert!(!is_local_ip(&"172.15.255.255".parse().unwrap()));
        assert!(!is_local_ip(&"192.169.0.1".parse().unwrap()));
    }

    #[test]
    fn is_local_ip_handles_ipv4_mapped_ipv6() {
        // ::ffff:127.0.0.1 → loopback
        assert!(is_local_ip(&"::ffff:127.0.0.1".parse().unwrap()));
        // ::ffff:172.20.0.1 → WSL2 range
        assert!(is_local_ip(&"::ffff:172.20.0.1".parse().unwrap()));
        // ::ffff:192.168.1.1 → rejected (LAN)
        assert!(!is_local_ip(&"::ffff:192.168.1.1".parse().unwrap()));
        // ::ffff:8.8.8.8 → rejected (public)
        assert!(!is_local_ip(&"::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn discovery_file_path_ends_with_automation_json() {
        let path = discovery_file_path();
        assert!(path.to_string_lossy().ends_with("automation.json"));
    }

    #[test]
    #[serial]
    fn write_and_remove_discovery_file() {
        write_discovery_file(19280);
        let path = discovery_file_path();
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["port"], 19280);
        assert!(parsed.get("key").is_none());
        assert!(parsed["pid"].as_u64().unwrap() > 0);
        remove_discovery_file();
        assert!(!path.exists());
    }
}
