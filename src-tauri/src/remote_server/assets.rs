use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::{check_remote_base_access, check_remote_enabled, request_is_tunnel_authorized};
use super::font_assets::{parse_font_token, served_font, ServedFont};
use super::internal_error;

/// Font URLs carry a content hash (ADR-0077), so a hit is immutable forever.
/// `private`, not `public`: the bytes can be a redistribution-restricted font and
/// the cloud relay sits on this path — no shared cache may keep a copy.
const FONT_CACHE_CONTROL: &str = "private, max-age=31536000, immutable";

const XTERM_JS: &str = include_str!("assets/xterm.js");
const XTERM_CSS: &str = include_str!("assets/xterm.css");
const ADDON_FIT_JS: &str = include_str!("assets/addon-fit.js");
const WEB_LINKS_ADDON_JS: &str = include_str!("assets/addon-web-links.js");
/// Shared cell-width provider, generated from `ui/src/lib/terminal-unicode-width.ts`
/// by `npm run build:remote-provider` (issue #538). Without it the remote client
/// keeps xterm default Unicode 6 widths and wraps at different columns than the
/// desktop for emoji and 89 BMP code points.
const UNICODE_PROVIDER_JS: &str = include_str!("assets/unicode-provider.js");

pub(crate) async fn remote_xterm_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        XTERM_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn remote_unicode_provider_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        UNICODE_PROVIDER_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn remote_xterm_css(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        XTERM_CSS,
        "text/css; charset=utf-8",
    )
}

pub(crate) async fn remote_addon_fit_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        ADDON_FIT_JS,
        "application/javascript; charset=utf-8",
    )
}

pub(crate) async fn remote_web_links_addon_js(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    remote_asset(
        &server,
        addr,
        request_is_tunnel_authorized(&req),
        WEB_LINKS_ADDON_JS,
        "application/javascript; charset=utf-8",
    )
}

/// Serves the desktop terminal font advertised in the appearance payload
/// (ADR-0077). Unknown or expired tokens are a plain 404 — the client keeps
/// rendering with its fallback font.
pub(crate) async fn remote_font(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(file_name): Path<String>,
    req: Request,
) -> Response {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return internal_error(err),
    };
    if let Some(response) =
        remote_font_gate_for_settings(&settings, addr, request_is_tunnel_authorized(&req))
    {
        return response;
    }

    let Some(font) = parse_font_token(&file_name).and_then(served_font) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let compressed = if accepts_brotli(req.headers()) {
        let font = Arc::clone(&font);
        // Compressing an MB-scale font is CPU work; keep it off the async
        // runtime threads. The result is cached, so this runs once per font.
        tokio::task::spawn_blocking(move || font.brotli_bytes())
            .await
            .ok()
            .flatten()
    } else {
        None
    };

    font_response(&font, compressed)
}

/// `compressed` carries the brotli body when the client accepts it; `None`
/// serves the original sfnt bytes.
fn font_response(font: &ServedFont, compressed: Option<Bytes>) -> Response {
    let brotli_encoded = compressed.is_some();
    let mut response = compressed
        .unwrap_or_else(|| font.bytes.clone())
        .into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(font.content_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(FONT_CACHE_CONTROL),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if brotli_encoded {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
    }
    response
}

/// The font route carries the base asset gate plus the serve toggle. Turning the
/// toggle off must stop serving immediately, including for URLs a browser was
/// already handed and for bytes already sitting in the cache.
fn remote_font_gate_for_settings(
    settings: &crate::settings::models::RemoteSettings,
    addr: SocketAddr,
    tunnel_authorized: bool,
) -> Option<Response> {
    if let Some(response) = remote_asset_gate_for_settings(settings, addr, tunnel_authorized) {
        return Some(response);
    }
    if !settings.serve_terminal_font {
        return Some(StatusCode::NOT_FOUND.into_response());
    }
    None
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    value.split(',').any(|entry| {
        let mut parts = entry.split(';').map(str::trim);
        if !parts
            .next()
            .is_some_and(|coding| coding.eq_ignore_ascii_case("br"))
        {
            return false;
        }
        !parts.any(is_zero_quality)
    })
}

fn is_zero_quality(parameter: &str) -> bool {
    let Some((name, value)) = parameter.split_once('=') else {
        return false;
    };
    name.trim().eq_ignore_ascii_case("q")
        && value
            .trim()
            .parse::<f32>()
            .is_ok_and(|quality| quality == 0.0)
}

fn remote_asset(
    server: &ServerState,
    addr: SocketAddr,
    tunnel_authorized: bool,
    body: &'static str,
    content_type: &'static str,
) -> Response {
    if let Some(response) = remote_asset_gate_for_request(server, addr, tunnel_authorized) {
        return response;
    }

    ([(header::CONTENT_TYPE, content_type)], body).into_response()
}

/// The base access gate every asset route shares. Asset routes sit outside the
/// `remote_guard` middleware, so each handler applies it itself.
pub(super) fn remote_asset_gate(
    server: &ServerState,
    addr: SocketAddr,
    req: &Request,
) -> Option<Response> {
    remote_asset_gate_for_request(server, addr, request_is_tunnel_authorized(req))
}

fn remote_asset_gate_for_request(
    server: &ServerState,
    addr: SocketAddr,
    tunnel_authorized: bool,
) -> Option<Response> {
    // Cloud tunnel requests only need the enable gate (WSS-authorized); direct
    // requests go through the full token/IP/Origin base-access check.
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return Some(internal_error(err)),
    };
    remote_asset_gate_for_settings(&settings, addr, tunnel_authorized)
}

fn remote_asset_gate_for_settings(
    settings: &crate::settings::models::RemoteSettings,
    addr: SocketAddr,
    tunnel_authorized: bool,
) -> Option<Response> {
    if tunnel_authorized {
        check_remote_enabled(settings)
    } else {
        check_remote_base_access(settings, addr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    use crate::settings::Settings;

    fn remote_settings(enabled: bool, token: &str) -> crate::settings::models::RemoteSettings {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = token.into();
        settings.remote
    }

    #[test]
    fn bundled_remote_assets_are_present() {
        assert!(XTERM_JS.contains("Terminal"));
        assert!(XTERM_CSS.contains(".xterm"));
        assert!(ADDON_FIT_JS.contains("FitAddon"));
        assert!(WEB_LINKS_ADDON_JS.contains("WebLinksAddon"));
    }

    #[test]
    fn remote_asset_requires_enabled_for_tunnel_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let disabled_settings = remote_settings(false, "");
        let disabled = remote_asset_gate_for_settings(&disabled_settings, addr, true).unwrap();
        assert_eq!(disabled.status(), StatusCode::FORBIDDEN);

        let enabled_settings = remote_settings(true, "");
        assert!(remote_asset_gate_for_settings(&enabled_settings, addr, true).is_none());
    }

    #[test]
    fn font_route_stops_serving_the_moment_the_toggle_goes_off() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        // Toggle off: a URL a browser was already handed must stop resolving,
        // even though the base asset gate would let the request through.
        let mut settings = remote_settings(true, "");
        assert!(!settings.serve_terminal_font);
        assert!(remote_asset_gate_for_settings(&settings, addr, true).is_none());
        let blocked = remote_font_gate_for_settings(&settings, addr, true).unwrap();
        assert_eq!(blocked.status(), StatusCode::NOT_FOUND);

        settings.serve_terminal_font = true;
        assert!(remote_font_gate_for_settings(&settings, addr, true).is_none());

        // The base gate still comes first: remote disabled outranks the toggle.
        let mut disabled = remote_settings(false, "");
        disabled.serve_terminal_font = true;
        let refused = remote_font_gate_for_settings(&disabled, addr, true).unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);

        // Direct (non-tunnel) requests keep the full token/IP/Origin check.
        let mut direct = remote_settings(true, "");
        direct.serve_terminal_font = true;
        let unauthorized = remote_font_gate_for_settings(&direct, addr, false).unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn font_response_marks_the_encoding_and_pins_the_immutable_cache() {
        let raw = Bytes::from_static(b"\x00\x01\x00\x00 laymux font payload");
        let font = super::super::font_assets::served_font_for_test(raw.clone(), "font/ttf");

        let plain = font_response(&font, None);
        assert_eq!(
            plain.headers().get(header::CONTENT_TYPE).unwrap(),
            "font/ttf"
        );
        assert_eq!(
            plain.headers().get(header::CACHE_CONTROL).unwrap(),
            FONT_CACHE_CONTROL
        );
        assert_eq!(
            plain.headers().get(header::VARY).unwrap(),
            "Accept-Encoding"
        );
        assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());
        let body = axum::body::to_bytes(plain.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body, raw);

        let brotli = font
            .brotli_bytes()
            .expect("brotli bytes should be produced");
        let encoded = font_response(&font, Some(brotli.clone()));
        assert_eq!(
            encoded.headers().get(header::CONTENT_ENCODING).unwrap(),
            "br"
        );
        // The declared media type stays the font's own; `br` is transport only.
        assert_eq!(
            encoded.headers().get(header::CONTENT_TYPE).unwrap(),
            "font/ttf"
        );
        let body = axum::body::to_bytes(encoded.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body, brotli);
    }

    #[test]
    fn brotli_is_used_only_when_the_client_actually_accepts_it() {
        let accepts = |value: &str| {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(header::ACCEPT_ENCODING, value.parse().unwrap());
            accepts_brotli(&headers)
        };

        assert!(accepts("br"));
        assert!(accepts("gzip, deflate, br"));
        assert!(accepts("gzip;q=1.0, BR;q=0.8"));
        assert!(!accepts("gzip, deflate"));
        assert!(!accepts("br;q=0"));
        assert!(!accepts("gzip, br;q=0.0"));
        assert!(!accepts("brotli"));
        assert!(!accepts_brotli(&axum::http::HeaderMap::new()));
    }

    #[test]
    fn remote_asset_uses_full_base_access_for_direct_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let settings = remote_settings(true, "");
        let response = remote_asset_gate_for_settings(&settings, addr, false).unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
