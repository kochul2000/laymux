//! Web app manifest and launcher icons for the `/remote/` browser client
//! (issue #654, ADR-0091).
//!
//! A phone that opens `/remote/` spends most of its vertical space on browser
//! chrome. Installing the client to the home screen removes it, and that only
//! happens if the origin serves a manifest that declares `display: standalone`
//! plus launcher icons. Both live here next to the client they describe.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::automation_server::ServerState;

use super::assets::remote_asset_gate;

/// `no-store`, like the page itself: the manifest is compiled in, so there is no
/// mtime/ETag to revalidate against, and a stale `start_url`/icon list would
/// survive an update inside an already-installed app.
const MANIFEST_CACHE_CONTROL: &str = "no-store";
/// Icons change only when the brand mark does. `private`, not `public`: the
/// response is gated and the cloud relay sits on this path, so no shared cache
/// may keep a copy.
const ICON_CACHE_CONTROL: &str = "private, max-age=86400";

const MANIFEST_CONTENT_TYPE: &str = "application/manifest+json; charset=utf-8";

pub(super) const MANIFEST_ROUTE_PATH: &str = "/remote/manifest.webmanifest";
pub(super) const ICON_ROUTE_PATH: &str = "/remote/pwa/{file_name}";

/// `scope`/`start_url` are `/remote/`, so an installed client keeps its own
/// window for every path of the remote surface (including `/remote/viewer/`) and
/// hands anything else back to the browser. `id` pins the app identity to that
/// scope so a later `start_url` change does not register as a second app.
const MANIFEST_JSON: &str = r##"{
  "id": "/remote/",
  "name": "Laymux Remote",
  "short_name": "Laymux",
  "description": "Remote control for a Laymux desktop terminal.",
  "start_url": "/remote/",
  "scope": "/remote/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#1e1e2e",
  "theme_color": "#1e1e2e",
  "icons": [
    {
      "src": "/remote/pwa/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/remote/pwa/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/remote/pwa/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}"##;

/// Generated from `ui/public/logo.svg` by `cd ui && npm run build:pwa-icons`.
const ICON_192_PNG: &[u8] = include_bytes!("assets/pwa/icon-192.png");
const ICON_512_PNG: &[u8] = include_bytes!("assets/pwa/icon-512.png");
const ICON_MASKABLE_512_PNG: &[u8] = include_bytes!("assets/pwa/icon-maskable-512.png");
/// iOS/iPadOS gives the `apple-touch-icon` link in `page.html` precedence over
/// manifest-declared icons, so the Apple-specific size remains bundled too.
const APPLE_TOUCH_ICON_180_PNG: &[u8] = include_bytes!("assets/pwa/apple-touch-icon-180.png");

const ICONS: &[(&str, &[u8])] = &[
    ("icon-192.png", ICON_192_PNG),
    ("icon-512.png", ICON_512_PNG),
    ("icon-maskable-512.png", ICON_MASKABLE_512_PNG),
    ("apple-touch-icon-180.png", APPLE_TOUCH_ICON_180_PNG),
];

pub(crate) async fn remote_manifest(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_asset_gate(&server, addr, &req) {
        return response;
    }

    (
        [
            (header::CONTENT_TYPE, MANIFEST_CONTENT_TYPE),
            (header::CACHE_CONTROL, MANIFEST_CACHE_CONTROL),
        ],
        MANIFEST_JSON,
    )
        .into_response()
}

pub(crate) async fn remote_pwa_icon(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(file_name): Path<String>,
    req: Request,
) -> Response {
    if let Some(response) = remote_asset_gate(&server, addr, &req) {
        return response;
    }

    let Some(bytes) = icon_bytes(&file_name) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, ICON_CACHE_CONTROL),
        ],
        bytes,
    )
        .into_response()
}

fn icon_bytes(file_name: &str) -> Option<&'static [u8]> {
    ICONS
        .iter()
        .find(|(name, _)| *name == file_name)
        .map(|(_, bytes)| *bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Width and height out of a PNG IHDR chunk, which a valid PNG always puts
    /// at a fixed offset right after the 8-byte signature.
    fn png_size(bytes: &[u8]) -> (u32, u32) {
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
        assert_eq!(&bytes[12..16], b"IHDR", "first chunk is not IHDR");
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        (width, height)
    }

    #[test]
    fn manifest_declares_a_standalone_app_scoped_to_the_remote_client() {
        let manifest: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();

        // Hiding the address bar is the whole point of the manifest (issue #654).
        assert_eq!(manifest["display"], "standalone");
        // A launch outside `/remote/` would leave the installed window, and the
        // relay cookie is scoped to this path as well.
        assert_eq!(manifest["scope"], "/remote/");
        assert_eq!(manifest["start_url"], "/remote/");
        assert_eq!(manifest["id"], "/remote/");
        assert!(manifest["name"]
            .as_str()
            .is_some_and(|name| !name.is_empty()));
        assert!(manifest["short_name"]
            .as_str()
            .is_some_and(|name| !name.is_empty()));
        // The splash screen paints before the client's CSS loads, so it has to
        // match `--bg-base` or the launch flashes.
        assert_eq!(manifest["background_color"], "#1e1e2e");
    }

    /// An icon entry whose bytes are missing or a different size than declared
    /// costs the install prompt outright, and neither shows up in a build.
    #[test]
    fn every_declared_icon_is_served_at_the_size_it_advertises() {
        let manifest: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        let icons = manifest["icons"].as_array().unwrap();

        for icon in icons {
            let src = icon["src"].as_str().unwrap();
            let file_name = src.strip_prefix("/remote/pwa/").unwrap();
            let bytes = icon_bytes(file_name)
                .unwrap_or_else(|| panic!("manifest declares {src} but nothing serves it"));
            let declared = icon["sizes"].as_str().unwrap();
            let (width, height) = png_size(bytes);
            assert_eq!(
                format!("{width}x{height}"),
                declared,
                "{src} is {width}x{height} but the manifest says {declared}"
            );
            assert_eq!(icon["type"], "image/png");
        }

        // Chrome's install criteria need both of these present.
        let sizes: Vec<&str> = icons
            .iter()
            .map(|icon| icon["sizes"].as_str().unwrap())
            .collect();
        assert!(sizes.contains(&"192x192"));
        assert!(sizes.contains(&"512x512"));
        // A launcher that crops to a circle uses the maskable variant; without
        // one Android shrinks the "any" icon onto a white plate.
        assert!(icons
            .iter()
            .any(|icon| icon["purpose"] == "maskable" && icon["sizes"] == "512x512"));
    }

    #[test]
    fn the_apple_touch_icon_is_served_even_though_the_manifest_omits_it() {
        let bytes = icon_bytes("apple-touch-icon-180.png").expect("apple touch icon is served");
        assert_eq!(png_size(bytes), (180, 180));
    }

    #[test]
    fn unknown_icon_names_are_not_served() {
        assert!(icon_bytes("icon-192.png").is_some());
        assert!(icon_bytes("icon-193.png").is_none());
        assert!(icon_bytes("../page.html").is_none());
        assert!(icon_bytes("").is_none());
    }

    /// The client page hardcodes these URLs (favicon, `apple-touch-icon`), and a
    /// renamed asset would only show up as a 404 on a phone. Neither side can
    /// see the other's literals, so check them against each other here.
    #[test]
    fn the_client_page_links_only_urls_this_module_serves() {
        let html = super::super::page::remote_page_html();
        assert!(html.contains(MANIFEST_ROUTE_PATH));

        let prefix = ICON_ROUTE_PATH.trim_end_matches("{file_name}");
        let mut linked = 0;
        for reference in html.split(prefix).skip(1) {
            let file_name = reference
                .split(['"', '\'', '?', '#', ' ', '<'])
                .next()
                .unwrap_or_default();
            assert!(
                icon_bytes(file_name).is_some(),
                "page.html links {prefix}{file_name} but nothing serves it"
            );
            linked += 1;
        }
        assert!(
            linked >= 2,
            "page.html should link the favicon and the apple-touch-icon, found {linked}"
        );
    }

    #[test]
    fn manifest_route_paths_stay_inside_the_declared_scope() {
        let manifest: serde_json::Value = serde_json::from_str(MANIFEST_JSON).unwrap();
        let scope = manifest["scope"].as_str().unwrap();
        assert!(MANIFEST_ROUTE_PATH.starts_with(scope));
        assert!(ICON_ROUTE_PATH.starts_with(scope));
    }
}
