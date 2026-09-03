use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::settings::models::RemoteSettings;

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::android_e2e_output::{parse_android_e2e_output_route, ANDROID_E2E_OUTPUT_PATH};
use super::{internal_error, json_error};

const REMOTE_TOKEN_HEADER: &str = "x-laymux-remote-token";

#[derive(Debug, Clone, Copy)]
pub(crate) struct TunnelAuthorized;

/// Which transport carried a Remote request into the router (ADR-0226). The
/// extension is absent for Direct/Tailscale browser requests. Handlers use it
/// to size payload policy to what the Cloud relay can carry on that path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteTransport {
    /// Browser request forwarded by the Cloud relay over the WSS tunnel.
    CloudRelayBrowser,
    /// Inner HTTP request unwrapped from an Android E2E RPC envelope. The
    /// envelope itself arrived via the Cloud relay or Tailscale Direct.
    AndroidE2e { via_cloud_relay: bool },
}

pub(crate) async fn remote_guard(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };

    match tunnel_authorized_decision(&req, &settings) {
        TunnelAuthorizedDecision::Allowed => return next.run(req).await,
        TunnelAuthorizedDecision::Denied(response) => return response,
        TunnelAuthorizedDecision::NotTunnel => {}
    }
    match local_connector_authorized_decision(&req, &settings, addr) {
        LocalConnectorAuthorizedDecision::Allowed => return next.run(req).await,
        LocalConnectorAuthorizedDecision::Denied(response) => return response,
        LocalConnectorAuthorizedDecision::NotConnector => {}
    }
    match android_tailscale_e2e_authorized_decision(&req, &settings, addr) {
        AndroidTailscaleE2eDecision::Allowed => return next.run(req).await,
        AndroidTailscaleE2eDecision::Denied(response) => return response,
        AndroidTailscaleE2eDecision::NotAndroidE2e => {}
    }

    if let Some(response) = check_remote_base_access(&settings, addr) {
        return response;
    }
    if !origin_allowed(req.headers(), &settings) {
        return json_error(StatusCode::FORBIDDEN, "remote Origin is not allowed");
    }
    if !remote_token_matches(req.headers(), req.uri(), &settings) {
        return json_error(StatusCode::UNAUTHORIZED, "remote token is invalid");
    }

    next.run(req).await
}

pub(crate) fn request_is_tunnel_authorized(req: &Request) -> bool {
    req.extensions().get::<TunnelAuthorized>().is_some()
}

enum TunnelAuthorizedDecision {
    NotTunnel,
    Allowed,
    Denied(Response),
}

enum LocalConnectorAuthorizedDecision {
    NotConnector,
    Allowed,
    Denied(Response),
}

enum AndroidTailscaleE2eDecision {
    NotAndroidE2e,
    Allowed,
    Denied(Response),
}

fn tunnel_authorized_decision(
    req: &Request,
    settings: &RemoteSettings,
) -> TunnelAuthorizedDecision {
    // Cloud tunnel requests are authorized at the WSS device-token layer, so
    // they skip the local token/IP/Origin gate — BUT they still require the user
    // to have allowed remote control (the same enable toggle that governs
    // Tailscale). Pairing/being online must not hand over control on its own.
    if !request_is_tunnel_authorized(req) {
        return TunnelAuthorizedDecision::NotTunnel;
    }
    if let Some(response) = check_remote_enabled(settings) {
        return TunnelAuthorizedDecision::Denied(response);
    }
    TunnelAuthorizedDecision::Allowed
}

fn local_connector_authorized_decision(
    req: &Request,
    settings: &RemoteSettings,
    addr: SocketAddr,
) -> LocalConnectorAuthorizedDecision {
    // The Python tunnel connector reaches this one fixed adapter over
    // loopback. Direct-client IP/Tailscale/Origin policy describes the public
    // socket peer and must not reject this internal hop. Keep the Remote
    // enabled gate and its exact bearer/query token as the local authority;
    // the handler then independently requires a valid E2E session and AEAD
    // OPEN before terminal state is attached.
    if req.uri().path() != ANDROID_E2E_OUTPUT_PATH
        || !normalize_ip(addr.ip()).is_loopback()
        || req.headers().contains_key(header::ORIGIN)
    {
        return LocalConnectorAuthorizedDecision::NotConnector;
    }
    if let Some(response) = check_remote_enabled(settings) {
        return LocalConnectorAuthorizedDecision::Denied(response);
    }
    if !remote_token_matches(req.headers(), req.uri(), settings) {
        return LocalConnectorAuthorizedDecision::Denied(json_error(
            StatusCode::UNAUTHORIZED,
            "remote connector token is invalid",
        ));
    }
    LocalConnectorAuthorizedDecision::Allowed
}

fn android_tailscale_e2e_authorized_decision(
    req: &Request,
    settings: &RemoteSettings,
    addr: SocketAddr,
) -> AndroidTailscaleE2eDecision {
    let is_fixed_http_route = req.method() == Method::POST
        && req.uri().query().is_none()
        && matches!(
            req.uri().path(),
            "/remote/v1/e2e/session/challenge"
                | "/remote/v1/e2e/session/establish"
                | "/remote/v1/e2e/rpc"
        );
    let is_fixed_output_route = req.method() == Method::GET
        && req.uri().path() == ANDROID_E2E_OUTPUT_PATH
        && parse_android_e2e_output_route(req.uri().query()).is_some();
    if !is_fixed_http_route && !is_fixed_output_route {
        return AndroidTailscaleE2eDecision::NotAndroidE2e;
    }
    // Preserve the existing authenticated Direct/loopback path. In particular,
    // the Python cloud connector forwards these fixed HTTP routes to loopback
    // with the desktop remote token. Only tokenless native requests need the
    // Tailscale E2E bypass below; bearer requests still pass every common
    // enabled/IP/Origin/token check in `remote_guard`.
    if remote_token_matches(req.headers(), req.uri(), settings) {
        return AndroidTailscaleE2eDecision::NotAndroidE2e;
    }
    if let Some(response) = check_remote_enabled(settings) {
        return AndroidTailscaleE2eDecision::Denied(response);
    }
    if req.headers().contains_key(header::ORIGIN) {
        return AndroidTailscaleE2eDecision::Denied(json_error(
            StatusCode::FORBIDDEN,
            "Android Tailscale E2E requests must not include Origin",
        ));
    }
    let remote_ip = normalize_ip(addr.ip());
    if !is_tailscale_ip(&remote_ip) {
        tracing::warn!(
            remote_addr = %addr,
            remote_ip = %remote_ip,
            "non-Tailscale Android E2E client denied"
        );
        return AndroidTailscaleE2eDecision::Denied(json_error(
            StatusCode::FORBIDDEN,
            "Android Direct E2E requires a Tailscale peer",
        ));
    }
    AndroidTailscaleE2eDecision::Allowed
}

/// The user-facing remote-control gate shared by every transport (Tailscale and
/// cloud tunnel). Returns a 403 when remote control is not enabled. Cloud tunnel
/// requests check only this — not the token/IP/Origin gate below.
pub(crate) fn check_remote_enabled(settings: &RemoteSettings) -> Option<Response> {
    if !settings.enabled {
        return Some(json_error(
            StatusCode::FORBIDDEN,
            "direct remote mode is disabled",
        ));
    }
    None
}

pub(crate) fn check_remote_base_access(
    settings: &RemoteSettings,
    addr: SocketAddr,
) -> Option<Response> {
    if let Some(response) = check_remote_enabled(settings) {
        return Some(response);
    }
    if settings.auth_token.is_empty() {
        return Some(json_error(
            StatusCode::UNAUTHORIZED,
            "direct remote mode requires remote.authToken",
        ));
    }
    let remote_ip = normalize_ip(addr.ip());
    if settings.tailscale_only && !is_tailscale_ip(&remote_ip) {
        tracing::warn!(
            remote_addr = %addr,
            remote_ip = %remote_ip,
            "non-Tailscale remote client denied by tailscale-only policy"
        );
        return Some(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": format!("remote client IP is not a Tailscale address: {remote_ip}"),
                    "remoteIp": remote_ip.to_string(),
                    "tailscaleOnly": true,
                })),
            )
                .into_response(),
        );
    }
    if !is_remote_ip_allowed(&remote_ip, &settings.allowed_ips) {
        tracing::warn!(
            remote_addr = %addr,
            remote_ip = %remote_ip,
            allowed_ips = ?settings.allowed_ips,
            "remote client IP denied"
        );
        let message = format!("remote client IP is not allowed: {remote_ip}");
        return Some(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": message,
                    "remoteIp": remote_ip.to_string(),
                    "allowedIps": &settings.allowed_ips,
                })),
            )
                .into_response(),
        );
    }

    None
}

fn remote_token_matches(headers: &HeaderMap, uri: &Uri, settings: &RemoteSettings) -> bool {
    if let Some(token) =
        token_from_authorization(headers).or_else(|| header_value(headers, REMOTE_TOKEN_HEADER))
    {
        return token_matches(token, &settings.auth_token);
    }

    query_param(uri, "token")
        .as_deref()
        .is_some_and(|token| token_matches(token, &settings.auth_token))
}

fn token_matches(token: &str, expected: &str) -> bool {
    constant_time_eq(token.as_bytes(), expected.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();

    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(left_byte ^ right_byte);
    }

    diff == 0
}

fn token_from_authorization(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .filter(|token| !token.is_empty())
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn query_param(uri: &Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name != key || value.is_empty() {
            return None;
        }
        decode_query_component(value)
    })
}

fn decode_query_component(value: &str) -> Option<String> {
    let input = value.as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut index = 0;

    while index < input.len() {
        match input[index] {
            b'%' => {
                let high = hex_value(*input.get(index + 1)?)?;
                let low = hex_value(*input.get(index + 2)?)?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn origin_allowed(headers: &HeaderMap, settings: &RemoteSettings) -> bool {
    if settings.allowed_origins.is_empty() {
        return true;
    }
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        return origin_matches_allowed(origin, settings);
    }

    missing_origin_allowed_for_same_origin_fetch(headers, settings)
}

fn origin_matches_allowed(origin: &str, settings: &RemoteSettings) -> bool {
    settings
        .allowed_origins
        .iter()
        .any(|allowed| allowed == "*" || allowed == origin)
}

fn missing_origin_allowed_for_same_origin_fetch(
    headers: &HeaderMap,
    settings: &RemoteSettings,
) -> bool {
    if settings
        .allowed_origins
        .iter()
        .any(|allowed| allowed == "*")
    {
        return true;
    }

    // Browser same-origin GET fetches can omit Origin. Sec-Fetch-Site and Host
    // are forgeable by non-browser clients, so this is a compatibility path, not
    // a security boundary; IP allowlist and bearer token remain authoritative.
    if !header_value(headers, "sec-fetch-site")
        .is_some_and(|value| value.eq_ignore_ascii_case("same-origin"))
    {
        return false;
    }

    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };

    settings.allowed_origins.iter().any(|allowed| {
        allowed_origin_authority(allowed)
            .as_deref()
            .is_some_and(|authority| authority.eq_ignore_ascii_case(host))
    })
}

fn allowed_origin_authority(origin: &str) -> Option<String> {
    // Compare only authority for the no-Origin browser compatibility path.
    // The configured scheme is enforced only when an Origin header is present.
    let uri = origin.parse::<Uri>().ok()?;
    match (uri.scheme_str(), uri.authority()) {
        (Some("http" | "https"), Some(authority)) => Some(authority.as_str().to_string()),
        _ => None,
    }
}

pub(crate) fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        other => other,
    }
}

pub(crate) fn is_remote_ip_allowed(ip: &IpAddr, allowed_ips: &[String]) -> bool {
    if allowed_ips.is_empty() {
        return ip.is_loopback();
    }

    allowed_ips
        .iter()
        .any(|entry| ip_matches_allowlist_entry(ip, entry.trim()))
}

pub(crate) fn is_tailscale_ip(ip: &IpAddr) -> bool {
    match normalize_ip(*ip) {
        IpAddr::V4(addr) => ipv4_in_cidr(addr, Ipv4Addr::new(100, 64, 0, 0), 10),
        IpAddr::V6(addr) => ipv6_in_cidr(
            addr,
            Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0),
            48,
        ),
    }
}

fn ip_matches_allowlist_entry(ip: &IpAddr, entry: &str) -> bool {
    if entry.is_empty() {
        return false;
    }
    if entry == "*" {
        return true;
    }
    if let Ok(exact) = entry.parse::<IpAddr>() {
        return normalize_ip(exact) == *ip;
    }
    let Some((network, prefix)) = entry.split_once('/') else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    match (ip, network.parse::<IpAddr>().map(normalize_ip)) {
        (IpAddr::V4(addr), Ok(IpAddr::V4(network))) => ipv4_in_cidr(*addr, network, prefix),
        (IpAddr::V6(addr), Ok(IpAddr::V6(network))) => ipv6_in_cidr(*addr, network, prefix),
        _ => false,
    }
}

fn ipv4_in_cidr(addr: Ipv4Addr, network: Ipv4Addr, prefix: u8) -> bool {
    if prefix > 32 {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(addr) & mask) == (u32::from(network) & mask)
}

fn ipv6_in_cidr(addr: Ipv6Addr, network: Ipv6Addr, prefix: u8) -> bool {
    if prefix > 128 {
        return false;
    }
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    let addr = u128::from_be_bytes(addr.octets());
    let network = u128::from_be_bytes(network.octets());
    (addr & mask) == (network & mask)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::HeaderValue;

    fn guard_request(tunnel_authorized: bool) -> Request {
        let mut request = Request::builder()
            .uri("/remote/v1/health")
            .body(Body::empty())
            .unwrap();
        if tunnel_authorized {
            request.extensions_mut().insert(TunnelAuthorized);
        }
        request
    }

    #[test]
    fn remote_allowlist_matches_tailscale_cidrs() {
        let allowed = vec![
            "100.64.0.0/10".to_string(),
            "fd7a:115c:a1e0::/48".to_string(),
        ];
        assert!(is_remote_ip_allowed(
            &"100.100.10.20".parse::<IpAddr>().unwrap(),
            &allowed
        ));
        assert!(is_remote_ip_allowed(
            &"100.127.255.255".parse::<IpAddr>().unwrap(),
            &allowed
        ));
        assert!(!is_remote_ip_allowed(
            &"100.128.0.1".parse::<IpAddr>().unwrap(),
            &allowed
        ));
        assert!(is_remote_ip_allowed(
            &"fd7a:115c:a1e0::5e37:230".parse::<IpAddr>().unwrap(),
            &allowed
        ));
        assert!(!is_remote_ip_allowed(
            &"fd7b:115c:a1e0::1".parse::<IpAddr>().unwrap(),
            &allowed
        ));
    }

    #[test]
    fn remote_allowlist_defaults_to_loopback_when_empty() {
        assert!(is_remote_ip_allowed(
            &"127.0.0.1".parse::<IpAddr>().unwrap(),
            &[]
        ));
        assert!(!is_remote_ip_allowed(
            &"192.168.1.10".parse::<IpAddr>().unwrap(),
            &[]
        ));
    }

    #[test]
    fn tailscale_only_recognizes_only_tailscale_address_ranges() {
        assert!(is_tailscale_ip(&"100.100.10.20".parse().unwrap()));
        assert!(is_tailscale_ip(
            &"fd7a:115c:a1e0::5e37:230".parse().unwrap()
        ));
        assert!(!is_tailscale_ip(&"192.168.1.10".parse().unwrap()));
        assert!(!is_tailscale_ip(&"fd7b:115c:a1e0::1".parse().unwrap()));
    }

    #[test]
    fn tailscale_only_rejects_non_tailscale_before_general_allowlist() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: "secret".into(),
            allowed_ips: vec!["*".into()],
            tailscale_only: true,
            ..RemoteSettings::default()
        };

        let response =
            check_remote_base_access(&settings, "192.168.1.10:1".parse().unwrap()).unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(check_remote_base_access(&settings, "100.100.10.20:1".parse().unwrap()).is_none());
    }

    #[test]
    fn remote_base_access_rejects_missing_token() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: String::new(),
            ..RemoteSettings::default()
        };
        let response =
            check_remote_base_access(&settings, "127.0.0.1:1".parse::<SocketAddr>().unwrap())
                .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn check_remote_enabled_requires_enabled_settings() {
        let disabled = RemoteSettings {
            enabled: false,
            ..RemoteSettings::default()
        };
        let response = check_remote_enabled(&disabled).unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let enabled = RemoteSettings {
            enabled: true,
            ..RemoteSettings::default()
        };
        assert!(check_remote_enabled(&enabled).is_none());
    }

    #[test]
    fn tunnel_authorized_request_marker_is_not_remote_enable_gate() {
        let settings = RemoteSettings {
            enabled: false,
            auth_token: "persistent-token".into(),
            ..RemoteSettings::default()
        };
        assert!(
            check_remote_base_access(&settings, "127.0.0.1:1".parse::<SocketAddr>().unwrap())
                .is_some()
        );

        let mut request = Request::builder()
            .uri("/remote/v1/health")
            .body(Body::empty())
            .unwrap();
        assert!(!request_is_tunnel_authorized(&request));
        request.extensions_mut().insert(TunnelAuthorized);
        assert!(request_is_tunnel_authorized(&request));
    }

    #[test]
    fn remote_guard_rejects_tunnel_authorized_when_remote_disabled() {
        let settings = RemoteSettings {
            enabled: false,
            auth_token: "persistent-token".into(),
            ..RemoteSettings::default()
        };
        let request = guard_request(true);

        match tunnel_authorized_decision(&request, &settings) {
            TunnelAuthorizedDecision::Denied(response) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
            _ => panic!("expected disabled tunnel request to be denied"),
        }
    }

    #[test]
    fn remote_guard_allows_tunnel_authorized_when_enabled_without_token_ip_origin() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: String::new(),
            allowed_ips: vec!["198.51.100.1/32".into()],
            allowed_origins: vec!["https://remote.example".into()],
            tailscale_only: true,
            ..RemoteSettings::default()
        };
        let tunnel_request = guard_request(true);
        let direct_request = guard_request(false);

        assert!(matches!(
            tunnel_authorized_decision(&tunnel_request, &settings),
            TunnelAuthorizedDecision::Allowed
        ));
        assert!(matches!(
            tunnel_authorized_decision(&direct_request, &settings),
            TunnelAuthorizedDecision::NotTunnel
        ));

        let direct_response =
            check_remote_base_access(&settings, "203.0.113.10:1".parse::<SocketAddr>().unwrap())
                .unwrap();
        assert_eq!(direct_response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn android_e2e_direct_allows_only_exact_native_routes_from_tailscale() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: "browser-secret".into(),
            ..RemoteSettings::default()
        };
        let request = |method: &str, uri: &str| {
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap()
        };
        for (method, uri) in [
            ("POST", "/remote/v1/e2e/session/challenge"),
            ("POST", "/remote/v1/e2e/session/establish"),
            ("POST", "/remote/v1/e2e/rpc"),
            (
                "GET",
                "/remote/v1/e2e/output?instanceId=desktop-7&sessionId=UFFSU1RVVldYWVpbXF1eXw&streamNonce=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            ),
        ] {
            assert!(matches!(
                android_tailscale_e2e_authorized_decision(
                    &request(method, uri),
                    &settings,
                    "100.100.10.20:43100".parse().unwrap(),
                ),
                AndroidTailscaleE2eDecision::Allowed
            ));
        }

        for (method, uri) in [
            ("GET", "/remote/v1/e2e/session/challenge"),
            ("POST", "/remote/v1/e2e/session/challenge/"),
            ("POST", "/remote/v1/session/claim"),
            ("GET", "/remote/"),
        ] {
            assert!(matches!(
                android_tailscale_e2e_authorized_decision(
                    &request(method, uri),
                    &settings,
                    "100.100.10.20:43100".parse().unwrap(),
                ),
                AndroidTailscaleE2eDecision::NotAndroidE2e
            ));
        }
    }

    #[test]
    fn android_e2e_direct_rejects_non_tailscale_origin_and_disabled_remote() {
        let request = Request::builder()
            .method("POST")
            .uri("/remote/v1/e2e/session/challenge")
            .body(Body::empty())
            .unwrap();
        let enabled = RemoteSettings {
            enabled: true,
            ..RemoteSettings::default()
        };
        assert!(matches!(
            android_tailscale_e2e_authorized_decision(
                &request,
                &enabled,
                "192.168.1.10:43100".parse().unwrap(),
            ),
            AndroidTailscaleE2eDecision::Denied(_)
        ));

        let mut with_origin = Request::builder()
            .method("POST")
            .uri("/remote/v1/e2e/session/challenge")
            .body(Body::empty())
            .unwrap();
        with_origin.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("https://untrusted.example"),
        );
        assert!(matches!(
            android_tailscale_e2e_authorized_decision(
                &with_origin,
                &enabled,
                "100.100.10.20:43100".parse().unwrap(),
            ),
            AndroidTailscaleE2eDecision::Denied(_)
        ));

        let disabled = RemoteSettings::default();
        assert!(matches!(
            android_tailscale_e2e_authorized_decision(
                &request,
                &disabled,
                "100.100.10.20:43100".parse().unwrap(),
            ),
            AndroidTailscaleE2eDecision::Denied(_)
        ));
    }

    #[test]
    fn android_e2e_direct_preserves_existing_bearer_authenticated_connector_http() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: "connector-secret".into(),
            ..RemoteSettings::default()
        };
        let request = Request::builder()
            .method("POST")
            .uri("/remote/v1/e2e/session/challenge")
            .header(REMOTE_TOKEN_HEADER, "connector-secret")
            .body(Body::empty())
            .unwrap();

        assert!(matches!(
            android_tailscale_e2e_authorized_decision(
                &request,
                &settings,
                "127.0.0.1:43100".parse().unwrap(),
            ),
            AndroidTailscaleE2eDecision::NotAndroidE2e
        ));
        assert!(check_remote_base_access(&settings, "127.0.0.1:43100".parse().unwrap(),).is_none());
        assert!(remote_token_matches(
            request.headers(),
            request.uri(),
            &settings,
        ));
    }

    #[test]
    fn local_e2e_connector_bypasses_direct_ip_and_origin_policy_with_exact_token() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: "connector-secret".into(),
            allowed_ips: vec!["100.64.0.0/10".into()],
            allowed_origins: vec!["https://remote.example".into()],
            tailscale_only: true,
            ..RemoteSettings::default()
        };
        let request = Request::builder()
            .uri(concat!(
                "/remote/v1/e2e/output?instanceId=desktop-7&",
                "sessionId=UFFSU1RVVldYWVpbXF1eXw&",
                "streamNonce=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&",
                "token=connector-secret"
            ))
            .body(Body::empty())
            .unwrap();

        assert!(matches!(
            local_connector_authorized_decision(
                &request,
                &settings,
                "127.0.0.1:43100".parse().unwrap(),
            ),
            LocalConnectorAuthorizedDecision::Allowed
        ));

        let non_loopback = local_connector_authorized_decision(
            &request,
            &settings,
            "100.100.10.20:43100".parse().unwrap(),
        );
        assert!(matches!(
            non_loopback,
            LocalConnectorAuthorizedDecision::NotConnector
        ));
    }

    #[test]
    fn local_e2e_connector_still_requires_enabled_remote_and_exact_token() {
        let request = |token: &str| {
            Request::builder()
                .uri(format!(
                    "/remote/v1/e2e/output?instanceId=desktop-7&sessionId=UFFSU1RVVldYWVpbXF1eXw&streamNonce=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&token={token}"
                ))
                .body(Body::empty())
                .unwrap()
        };
        let enabled = RemoteSettings {
            enabled: true,
            auth_token: "connector-secret".into(),
            ..RemoteSettings::default()
        };
        match local_connector_authorized_decision(
            &request("wrong"),
            &enabled,
            "127.0.0.1:43100".parse().unwrap(),
        ) {
            LocalConnectorAuthorizedDecision::Denied(response) => {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            }
            _ => panic!("expected invalid connector token to be denied"),
        }

        let disabled = RemoteSettings {
            enabled: false,
            auth_token: "connector-secret".into(),
            ..RemoteSettings::default()
        };
        match local_connector_authorized_decision(
            &request("connector-secret"),
            &disabled,
            "127.0.0.1:43100".parse().unwrap(),
        ) {
            LocalConnectorAuthorizedDecision::Denied(response) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
            _ => panic!("expected disabled Remote connector to be denied"),
        }
    }

    #[tokio::test]
    async fn remote_base_access_rejects_disallowed_ip_with_observed_ip() {
        let settings = RemoteSettings {
            enabled: true,
            auth_token: "secret".into(),
            allowed_ips: vec!["127.0.0.1/32".into(), "::1/128".into()],
            ..RemoteSettings::default()
        };
        let response =
            check_remote_base_access(&settings, "100.100.10.20:1".parse::<SocketAddr>().unwrap())
                .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(body["remoteIp"], "100.100.10.20");
        assert_eq!(body["allowedIps"][0], "127.0.0.1/32");
        assert!(body["error"].as_str().unwrap().contains("100.100.10.20"));
    }

    #[test]
    fn remote_token_accepts_bearer_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );
        let settings = RemoteSettings {
            auth_token: "secret".into(),
            ..RemoteSettings::default()
        };
        assert!(remote_token_matches(
            &headers,
            &"/remote/v1/health".parse::<Uri>().unwrap(),
            &settings
        ));
    }

    #[test]
    fn remote_token_accepts_query_for_websocket() {
        let headers = HeaderMap::new();
        let settings = RemoteSettings {
            auth_token: "secret".into(),
            ..RemoteSettings::default()
        };
        assert!(remote_token_matches(
            &headers,
            &"/remote/v1/terminals/t1/output?token=secret"
                .parse::<Uri>()
                .unwrap(),
            &settings
        ));
    }

    #[test]
    fn remote_token_decodes_query_for_websocket() {
        let headers = HeaderMap::new();
        let settings = RemoteSettings {
            auth_token: "sec/ret+?".into(),
            ..RemoteSettings::default()
        };
        assert!(remote_token_matches(
            &headers,
            &"/remote/v1/terminals/t1/output?token=sec%2Fret%2B%3F"
                .parse::<Uri>()
                .unwrap(),
            &settings
        ));
    }

    #[test]
    fn token_match_rejects_mismatch() {
        assert!(token_matches("secret", "secret"));
        assert!(!token_matches("secret", "secrets"));
        assert!(!token_matches("secret", "nope"));
    }

    #[test]
    fn origin_allowlist_is_enforced_when_configured() {
        let settings = RemoteSettings {
            allowed_origins: vec!["http://100.64.0.2:19281".into()],
            ..RemoteSettings::default()
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://100.64.0.2:19281"),
        );
        assert!(origin_allowed(&headers, &settings));

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://example.com"),
        );
        assert!(!origin_allowed(&headers, &settings));
    }

    #[test]
    fn origin_allowlist_rejects_missing_origin_when_configured() {
        let settings = RemoteSettings {
            allowed_origins: vec!["http://100.64.0.2:19281".into()],
            ..RemoteSettings::default()
        };
        let headers = HeaderMap::new();

        assert!(!origin_allowed(&headers, &settings));
    }

    #[test]
    fn origin_allowlist_accepts_same_origin_fetch_without_origin() {
        let settings = RemoteSettings {
            allowed_origins: vec!["http://100.64.0.2:19281".into()],
            ..RemoteSettings::default()
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("100.64.0.2:19281"));
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));

        assert!(origin_allowed(&headers, &settings));

        headers.insert(header::HOST, HeaderValue::from_static("example.com"));
        assert!(!origin_allowed(&headers, &settings));

        let https_settings = RemoteSettings {
            allowed_origins: vec!["https://100.64.0.2:19281".into()],
            ..RemoteSettings::default()
        };
        headers.insert(header::HOST, HeaderValue::from_static("100.64.0.2:19281"));
        assert!(origin_allowed(&headers, &https_settings));
    }
}
