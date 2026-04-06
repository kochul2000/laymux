pub mod handlers_backend;
pub mod handlers_bridge;
pub mod helpers;
pub mod types;

// Re-export key types used by other modules
pub use helpers::base64_decode;
pub use types::{AutomationRequest, AutomationResponse};

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Request, State as AxumState};
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

/// Generate a random bearer token for API authentication.
pub fn generate_automation_key() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Write discovery file so external tools can find the automation port and key.
pub fn write_discovery_file(port: u16, key: &str) {
    let path = discovery_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
        "key": key,
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
    let key = generate_automation_key();

    let server_state = ServerState {
        app_state: app_state.clone(),
        app_handle,
    };

    let app = build_router(server_state, &key);

    let port = automation_port();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind automation server on port {port}: {e}. Is another instance already running?"))?;

    // Store port and key in AppState
    if let Ok(mut p) = app_state.automation_port.lock_or_err() {
        *p = Some(port);
    } else {
        tracing::error!("Failed to store automation port in AppState (lock poisoned)");
    }
    if let Ok(mut k) = app_state.automation_key.lock_or_err() {
        *k = Some(key.clone());
    } else {
        tracing::error!("Failed to store automation key in AppState (lock poisoned)");
    }

    // Write discovery file (includes key)
    write_discovery_file(port, &key);

    tracing::info!(port, "Automation server listening on 0.0.0.0:{port}");
    tracing::info!(
        key_prefix = &key[..8],
        key_suffix = &key[key.len() - 4..],
        "Automation API key: {}...{}",
        &key[..8],
        &key[key.len() - 4..]
    );

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "Automation server error");
        }
    });

    Ok(port)
}

/// Bearer token authentication middleware.
/// Skips auth for GET /api/v1/health and CORS preflight (OPTIONS).
async fn auth_middleware(
    AxumState(expected_key): AxumState<String>,
    req: Request,
    next: Next,
) -> Response {
    // Allow CORS preflight through (OPTIONS must pass before auth)
    if req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }

    // Allow health endpoint without auth
    if req.uri().path() == "/api/v1/health" {
        return next.run(req).await;
    }

    let auth_header = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok());

    match auth_header.and_then(|h| h.strip_prefix("Bearer ")) {
        Some(token) if token == expected_key => next.run(req).await,
        Some(_) => (
            StatusCode::UNAUTHORIZED,
            Json(err_json("Invalid API key")),
        )
            .into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(err_json(
                "Missing Authorization header. Use: Authorization: Bearer <key from automation.json>",
            )),
        )
            .into_response(),
    }
}

pub fn build_router(state: ServerState, key: &str) -> Router {
    let key = key.to_string();

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
        .layer(middleware::from_fn_with_state(key, auth_middleware))
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
    fn generate_automation_key_is_unique() {
        let k1 = generate_automation_key();
        let k2 = generate_automation_key();
        assert_ne!(k1, k2);
        assert!(!k1.is_empty());
    }

    /// Build a minimal router with auth middleware for testing.
    fn auth_test_router(key: &str) -> Router {
        let protected = Router::new()
            .route("/api/v1/health", get(|| async { StatusCode::OK }))
            .route("/api/v1/protected", get(|| async { StatusCode::OK }));

        protected
            .layer(middleware::from_fn_with_state(
                key.to_string(),
                auth_middleware,
            ))
            .layer(CorsLayer::permissive())
    }

    #[tokio::test]
    async fn auth_health_no_token_returns_ok() {
        let app = auth_test_router("secret-key");
        let req = axum::http::Request::builder()
            .uri("/api/v1/health")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_valid_token_returns_ok() {
        let app = auth_test_router("secret-key");
        let req = axum::http::Request::builder()
            .uri("/api/v1/protected")
            .header("Authorization", "Bearer secret-key")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn auth_invalid_token_returns_401() {
        let app = auth_test_router("secret-key");
        let req = axum::http::Request::builder()
            .uri("/api/v1/protected")
            .header("Authorization", "Bearer wrong-key")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn auth_missing_header_returns_401() {
        let app = auth_test_router("secret-key");
        let req = axum::http::Request::builder()
            .uri("/api/v1/protected")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    #[serial]
    fn discovery_file_contains_key() {
        write_discovery_file(19281, "secret-abc");
        let path = discovery_file_path();
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["key"], "secret-abc");
        remove_discovery_file();
    }

    #[test]
    fn discovery_file_path_ends_with_automation_json() {
        let path = discovery_file_path();
        assert!(path.to_string_lossy().ends_with("automation.json"));
    }

    #[test]
    #[serial]
    fn write_and_remove_discovery_file() {
        write_discovery_file(19280, "test-key-123");
        let path = discovery_file_path();
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["port"], 19280);
        assert_eq!(parsed["key"], "test-key-123");
        assert!(parsed["pid"].as_u64().unwrap() > 0);
        remove_discovery_file();
        assert!(!path.exists());
    }
}
