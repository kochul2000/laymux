use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use axum::extract::{ConnectInfo, Request};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::Response;

use crate::settings::models::RemoteSettings;

use super::json_error;

const REMOTE_TOKEN_HEADER: &str = "x-laymux-remote-token";

pub(crate) async fn remote_guard(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let settings = crate::settings::load_settings().remote;

    if !settings.enabled {
        return json_error(StatusCode::FORBIDDEN, "direct remote mode is disabled");
    }
    if settings.auth_token.is_empty() {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "direct remote mode requires remote.authToken",
        );
    }
    let remote_ip = normalize_ip(addr.ip());
    if !is_remote_ip_allowed(&remote_ip, &settings.allowed_ips) {
        tracing::warn!(
            remote_addr = %addr,
            remote_ip = %remote_ip,
            allowed_ips = ?settings.allowed_ips,
            "remote API client IP denied"
        );
        return json_error(StatusCode::FORBIDDEN, "remote client IP is not allowed");
    }
    if !origin_allowed(req.headers(), &settings) {
        return json_error(StatusCode::FORBIDDEN, "remote Origin is not allowed");
    }
    if !remote_token_matches(req.headers(), req.uri(), &settings) {
        return json_error(StatusCode::UNAUTHORIZED, "remote token is invalid");
    }

    next.run(req).await
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
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    settings
        .allowed_origins
        .iter()
        .any(|allowed| allowed == "*" || allowed == origin)
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
    use axum::http::HeaderValue;

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
}
