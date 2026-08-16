//! Content-hashed, immutable Remote client assets (ADR-0169).
//!
//! The Remote main document stays `no-store` so updates land immediately, but
//! everything it references — the minified app bundle and the vendor xterm
//! files — is served here under a URL that embeds the content hash. A hit is
//! immutable forever, so browsers and the Android E2E resource cache
//! (ADR-0168) stop re-downloading them on every reconnect. Bytes are compiled
//! in, and a gzip body is precomputed once per asset for clients that accept
//! it.

use std::collections::HashMap;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::OnceLock;

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use crate::automation_server::ServerState;

use super::assets::{
    remote_asset_gate, ADDON_FIT_JS, UNICODE_PROVIDER_JS, WEB_LINKS_ADDON_JS, XTERM_CSS, XTERM_JS,
};

/// Same reasoning as the font route (ADR-0077): the URL is the content, so a
/// hit never revalidates. `private` because the cloud relay sits on this path.
const HASHED_ASSET_CACHE_CONTROL: &str = "private, max-age=31536000, immutable";

const APP_JS: &str = include_str!("assets/remote-app.min.js");
const APP_CSS: &str = include_str!("assets/remote-app.min.css");

const JS_CONTENT_TYPE: &str = "application/javascript; charset=utf-8";
const CSS_CONTENT_TYPE: &str = "text/css; charset=utf-8";

/// Logical names are what `page.html` references via `{{ASSET:<name>}}`.
const DEFINITIONS: [(&str, &str, &str); 7] = [
    ("remote-app.js", APP_JS, JS_CONTENT_TYPE),
    ("remote-app.css", APP_CSS, CSS_CONTENT_TYPE),
    ("xterm.js", XTERM_JS, JS_CONTENT_TYPE),
    ("xterm.css", XTERM_CSS, CSS_CONTENT_TYPE),
    ("unicode-provider.js", UNICODE_PROVIDER_JS, JS_CONTENT_TYPE),
    ("addon-fit.js", ADDON_FIT_JS, JS_CONTENT_TYPE),
    ("addon-web-links.js", WEB_LINKS_ADDON_JS, JS_CONTENT_TYPE),
];

pub(super) struct HashedAsset {
    pub logical_name: &'static str,
    /// `<stem>-<hash16>.<ext>`, e.g. `xterm-0123456789abcdef.js`.
    pub file_name: String,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
    pub gzip: Vec<u8>,
}

fn registry() -> &'static HashMap<String, HashedAsset> {
    static REGISTRY: OnceLock<HashMap<String, HashedAsset>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        DEFINITIONS
            .iter()
            .map(|(logical_name, body, content_type)| {
                let bytes = body.as_bytes();
                let hash = Sha256::digest(bytes);
                let (stem, ext) = logical_name
                    .rsplit_once('.')
                    .expect("logical asset names carry an extension");
                let file_name = format!("{stem}-{:016x}.{ext}", u64_prefix(&hash));
                let asset = HashedAsset {
                    logical_name,
                    file_name: file_name.clone(),
                    content_type,
                    bytes,
                    gzip: gzip_bytes(bytes),
                };
                (file_name, asset)
            })
            .collect()
    })
}

fn u64_prefix(hash: &[u8]) -> u64 {
    let mut prefix = [0u8; 8];
    prefix.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(prefix)
}

pub(super) fn gzip_for_page(bytes: &[u8]) -> Vec<u8> {
    gzip_bytes(bytes)
}

fn gzip_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    // Writing a compiled-in slice into a Vec cannot fail.
    encoder.write_all(bytes).expect("gzip write");
    encoder.finish().expect("gzip finish")
}

/// URL for a logical asset name, used to render the page shell.
pub(super) fn hashed_asset_url(logical_name: &str) -> Option<String> {
    registry()
        .values()
        .find(|asset| asset.logical_name == logical_name)
        .map(|asset| format!("/remote/asset/{}", asset.file_name))
}

/// The Android E2E resource allowlist delegates here so it stays in lockstep
/// with what the served page actually references.
pub(super) fn is_hashed_asset_file(file_name: &str) -> bool {
    registry().contains_key(file_name)
}

/// `Accept-Encoding: gzip` with a non-zero quality.
pub(super) fn accepts_gzip(headers: &HeaderMap) -> bool {
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
            .is_some_and(|coding| coding.eq_ignore_ascii_case("gzip"))
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

pub(crate) async fn remote_hashed_asset(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(file_name): Path<String>,
    req: Request,
) -> Response {
    if let Some(response) = remote_asset_gate(&server, addr, &req) {
        return response;
    }
    let Some(asset) = registry().get(file_name.as_str()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let gzip = accepts_gzip(req.headers());
    let mut response = if gzip {
        asset.gzip.clone().into_response()
    } else {
        asset.bytes.to_vec().into_response()
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(asset.content_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(HASHED_ASSET_CACHE_CONTROL),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if gzip {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_placeholder_resolves_to_a_hashed_immutable_file() {
        for (logical_name, body, _) in DEFINITIONS {
            let url = hashed_asset_url(logical_name).expect("registered asset");
            let file_name = url.strip_prefix("/remote/asset/").expect("asset prefix");
            assert!(is_hashed_asset_file(file_name));
            let hash = Sha256::digest(body.as_bytes());
            assert!(file_name.contains(&format!("{:016x}", u64_prefix(&hash))));
        }
        assert!(!is_hashed_asset_file("xterm-0000000000000000.js"));
        assert!(hashed_asset_url("unknown.js").is_none());
    }

    #[test]
    fn gzip_bodies_round_trip_and_negotiation_respects_quality() {
        let asset = registry()
            .values()
            .find(|asset| asset.logical_name == "remote-app.js")
            .expect("app bundle");
        let mut decoder = flate2::read::GzDecoder::new(asset.gzip.as_slice());
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut decoded).expect("gzip round trip");
        assert_eq!(decoded, asset.bytes);
        assert!(asset.gzip.len() < asset.bytes.len());

        let mut headers = HeaderMap::new();
        assert!(!accepts_gzip(&headers));
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br, gzip;q=0.5"),
        );
        assert!(accepts_gzip(&headers));
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip;q=0"),
        );
        assert!(!accepts_gzip(&headers));
    }
}
