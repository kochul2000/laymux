use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Request};
use axum::http::{Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use tower_http::cors::CorsLayer;

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

fn observed_client_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    }
}

fn ip_allowlist_denied_body(client_ip: IpAddr) -> serde_json::Value {
    let message = format!(
        "Access denied: only local/private network connections are allowed; client IP: {client_ip}"
    );
    serde_json::json!({
        "error": message,
        "clientIp": client_ip.to_string(),
    })
}

/// The local-network gate itself, shared by the middleware that wraps the
/// automation routes and by the 404 fallback. Returns the 403 response when
/// the observed peer is outside the allowlist.
fn ip_allowlist_rejection(addr: SocketAddr) -> Option<Response> {
    let client_ip = observed_client_ip(addr.ip());
    if is_local_ip(&client_ip) {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(ip_allowlist_denied_body(client_ip)),
        )
            .into_response(),
    )
}

/// IP allowlist middleware — only permits requests from local/private networks.
/// Replaces Bearer token auth: since this is localhost/WSL communication,
/// IP restriction provides equivalent security without key management overhead.
pub(super) async fn ip_allowlist_middleware(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    match ip_allowlist_rejection(addr) {
        Some(denied) => denied,
        None => next.run(req).await,
    }
}

/// The single fallback of the combined server: a request that matched no route
/// gets a 404 that names the path, not an auth error about it (issue #591).
///
/// The IP allowlist is re-applied here on purpose. It is a *network* boundary
/// rather than route authorization, so an off-allowlist peer must not be able
/// to map the API by reading 404-vs-401 off unknown paths. The remote auth
/// guard is the opposite kind of gate — it belongs to `/remote/v1/*` and
/// nothing else, which is why it is attached with `route_layer` there.
async fn not_found(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    method: Method,
    uri: Uri,
) -> Response {
    if let Some(denied) = ip_allowlist_rejection(addr) {
        return denied;
    }
    let path = uri.path();
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": format!("no such route: {method} {path}"),
            "method": method.as_str(),
            "path": path,
            "docs": "/api/v1/docs",
        })),
    )
        .into_response()
}

/// Merge the automation and remote surfaces into the served router.
///
/// Guards stay on the routes they protect. The combined router owns the only
/// fallback, while the outer CORS response decoration covers both registered
/// routes and fallback responses.
pub(super) fn compose_surfaces<S>(automation: Router<S>, remote: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    automation
        .merge(remote)
        .fallback(not_found)
        .layer(CorsLayer::permissive())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN};
    use axum::middleware;
    use axum::routing::get;
    use tower::ServiceExt;

    /// Stand-in for `remote_server::build_router`: a guard that rejects every
    /// request it sees, attached the way the real remote router used to attach
    /// `remote_guard`. Building the real one needs a Tauri `AppHandle`, so the
    /// composition contract is pinned with the same shape instead.
    async fn deny_everything(_req: Request, _next: Next) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "remote token is invalid" })),
        )
            .into_response()
    }

    /// The worst case for #591: the remote surface wraps its guard — and hence
    /// its fallback — with `layer`, so the merge donates a guarded fallback.
    fn composed_probe_router() -> Router {
        let automation = Router::new()
            .route("/api/v1/grid", get(|| async { "grid" }))
            .layer(middleware::from_fn(ip_allowlist_middleware))
            .layer(CorsLayer::permissive());
        let remote = Router::new()
            .route("/remote/v1/health", get(|| async { "health" }))
            .layer(middleware::from_fn(deny_everything))
            .layer(CorsLayer::permissive());
        compose_surfaces(automation, remote)
    }

    async fn call(router: Router, path: &str, peer: &str) -> (StatusCode, serde_json::Value) {
        let peer: SocketAddr = peer.parse().unwrap();
        let mut request = Request::builder().uri(path).body(Body::empty()).unwrap();
        request.extensions_mut().insert(ConnectInfo(peer));
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn unmatched_path_is_404_not_the_remote_auth_error() {
        let (status, body) = call(
            composed_probe_router(),
            "/api/v1/nonexistent",
            "127.0.0.1:5000",
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["path"], "/api/v1/nonexistent");
        assert_eq!(body["method"], "GET");
        let message = body["error"].as_str().unwrap();
        assert!(
            message.contains("/api/v1/nonexistent"),
            "the 404 body must name the missing path, got {message}"
        );
        assert!(
            !message.contains("token"),
            "a routing mistake must not be reported as an auth failure, got {message}"
        );
    }

    #[tokio::test]
    async fn unmatched_path_still_answers_off_allowlist_peers_with_403() {
        // The 404 must not become a route scanner for peers the IP allowlist
        // keeps out of the automation API.
        let (status, body) = call(
            composed_probe_router(),
            "/api/v1/nonexistent",
            "203.0.113.5:5000",
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["clientIp"], "203.0.113.5");
    }

    #[tokio::test]
    async fn unmatched_path_includes_cors_header() {
        let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let mut request = Request::builder()
            .uri("/api/v1/nonexistent")
            .header(ORIGIN, "http://localhost:3000")
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(peer));

        let response = composed_probe_router().oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get(ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|value| value.to_str().ok()),
            Some("*"),
            "browser clients must be able to read the fallback JSON body"
        );
    }

    #[tokio::test]
    async fn merged_surfaces_keep_their_own_gates() {
        let (status, _) = call(composed_probe_router(), "/api/v1/grid", "127.0.0.1:5000").await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = call(composed_probe_router(), "/api/v1/grid", "203.0.113.5:5000").await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // A matched remote route keeps hitting the remote guard: the fallback
        // fix must not soften authentication on the routes that own it.
        let (status, body) = call(
            composed_probe_router(),
            "/remote/v1/health",
            "127.0.0.1:5000",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "remote token is invalid");
    }

    #[test]
    fn is_local_ip_allows_loopback() {
        assert!(is_local_ip(&"127.0.0.1".parse().unwrap()));
        assert!(is_local_ip(&"127.0.0.2".parse().unwrap()));
        assert!(is_local_ip(&"::1".parse().unwrap()));
    }

    #[test]
    fn is_local_ip_allows_wsl2_and_link_local() {
        assert!(is_local_ip(&"172.16.0.1".parse().unwrap()));
        assert!(is_local_ip(&"172.31.255.255".parse().unwrap()));
        assert!(is_local_ip(&"169.254.1.1".parse().unwrap()));
    }

    #[test]
    fn is_local_ip_rejects_lan_and_vpn_ranges() {
        assert!(!is_local_ip(&"10.0.0.1".parse().unwrap()));
        assert!(!is_local_ip(&"10.255.255.255".parse().unwrap()));
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
        assert!(is_local_ip(&"::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_local_ip(&"::ffff:172.20.0.1".parse().unwrap()));
        assert!(!is_local_ip(&"::ffff:192.168.1.1".parse().unwrap()));
        assert!(!is_local_ip(&"::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn ip_allowlist_denied_body_includes_observed_client_ip() {
        let body = ip_allowlist_denied_body("192.168.1.20".parse().unwrap());

        assert_eq!(body["clientIp"], "192.168.1.20");
        assert!(body["error"].as_str().unwrap().contains("192.168.1.20"));
    }

    #[test]
    fn observed_client_ip_normalizes_ipv4_mapped_ipv6() {
        assert_eq!(
            observed_client_ip("::ffff:192.168.1.20".parse().unwrap()).to_string(),
            "192.168.1.20"
        );
    }
}
