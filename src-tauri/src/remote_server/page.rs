use std::net::SocketAddr;
use std::sync::OnceLock;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{Html, IntoResponse, Redirect, Response};

use crate::automation_server::ServerState;

use super::access::effective_remote_settings;
use super::auth::{check_remote_base_access, check_remote_enabled, request_is_tunnel_authorized};
use super::internal_error;

/// Gate the page/asset routes, which sit outside the `remote_guard` middleware.
/// Cloud tunnel requests (WSS-authorized) only need the enable gate; direct
/// requests go through the full token/IP/Origin base-access check.
pub(super) fn remote_page_gate(
    server: &ServerState,
    addr: SocketAddr,
    req: &Request,
) -> Option<Response> {
    let settings = match effective_remote_settings(&server.app_state) {
        Ok(settings) => settings,
        Err(err) => return Some(internal_error(err)),
    };
    remote_page_gate_for_settings(&settings, addr, request_is_tunnel_authorized(req))
}

fn remote_page_gate_for_settings(
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

pub(crate) async fn remote_page_redirect(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_page_gate(&server, addr, &req) {
        return response;
    }

    Redirect::temporary("/remote/").into_response()
}

pub(crate) async fn remote_page(
    State(server): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    if let Some(response) = remote_page_gate(&server, addr, &req) {
        return response;
    }

    // The page shell is compiled in via include_str!, so there is no mtime/ETag
    // for revalidation — without no-store, browsers heuristically cache it and
    // users need a hard refresh after every update. The heavy app bundle and
    // vendor assets it references are immutable hashed URLs (ADR-0169) instead.
    let response = if super::page_assets::accepts_gzip(req.headers()) {
        (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CONTENT_ENCODING, "gzip"),
                (header::VARY, "Accept-Encoding"),
            ],
            remote_page_gzip().to_vec(),
        )
            .into_response()
    } else {
        (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::VARY, "Accept-Encoding"),
            ],
            Html(remote_page_html()),
        )
            .into_response()
    };
    secure_page_response(response, req.headers())
}

/// The document policy, with `__WS_SOURCES__` resolved per request. Kept in its
/// own file because `ui/e2e/remote-client-assets.ts` serves the mocked page
/// under the same policy — one text file, no cross-language drift.
const REMOTE_PAGE_CSP_TEMPLATE: &str = include_str!("page-csp.txt");

const WS_SOURCES_PLACEHOLDER: &str = "__WS_SOURCES__";

/// The document carries the policy the Remote viewer document already had
/// (ADR-0041), so host file bytes are never rendered by a document without one.
/// `script-src 'self'` is the boundary that matters: the shell has no inline
/// script, no inline handler and no `eval`, so it costs nothing.
///
/// `style-src` keeps `'unsafe-inline'` because xterm's DOM renderer appends
/// generated `<style>` elements for cell dimensions, theme and decorations.
/// Dropping it blanks the terminal, and CSS-only injection needs an HTML sink
/// this page does not have — every rendered file goes into a sandboxed iframe.
pub(super) fn secure_page_response(
    mut response: Response,
    request_headers: &HeaderMap,
) -> Response {
    let policy = REMOTE_PAGE_CSP_TEMPLATE.trim_end().replace(
        WS_SOURCES_PLACEHOLDER,
        &websocket_csp_sources(request_headers),
    );
    let headers = response.headers_mut();
    // Fail closed. `is_bare_authority` should make an unencodable value
    // impossible, but "the validator let something through" must not be the one
    // case that ships the document with no policy at all — fall back to the
    // template's own WebSocket-less form, which is a compile-time constant.
    let value = HeaderValue::from_str(&policy)
        .or_else(|_| {
            HeaderValue::from_str(
                &REMOTE_PAGE_CSP_TEMPLATE
                    .trim_end()
                    .replace(WS_SOURCES_PLACEHOLDER, ""),
            )
        })
        .unwrap_or_else(|_| HeaderValue::from_static("default-src 'none'"));
    headers.insert(header::CONTENT_SECURITY_POLICY, value);
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// CSP3 has `'self'` cover same-origin `ws:`/`wss:`, but Safari shipped
/// releases where it does not, and the output socket is the whole product. The
/// `Host` authority is client-controlled, so it is echoed only when it matches
/// the bare `host[:port]` grammar; anything else drops the WebSocket sources
/// rather than letting a crafted header widen the policy.
fn websocket_csp_sources(request_headers: &HeaderMap) -> String {
    let Some(authority) = request_headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return String::new();
    };
    if !is_bare_authority(authority) {
        return String::new();
    }
    format!(" ws://{authority} wss://{authority}")
}

fn is_bare_authority(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 {
        return false;
    }
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        // IPv6 literals keep their brackets: `[::1]` or `[::1]:19281`.
        let Some((inside, tail)) = rest.split_once(']') else {
            return false;
        };
        if !inside
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == ':' || ch == '.')
        {
            return false;
        }
        match tail {
            "" => (inside, None),
            _ => match tail.strip_prefix(':') {
                Some(port) => (inside, Some(port)),
                None => return false,
            },
        }
    } else {
        let (host, port) = match value.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (value, None),
        };
        if !host.chars().all(is_authority_host_char) {
            return false;
        }
        (host, port)
    };
    if host.is_empty() {
        return false;
    }
    match port {
        None => true,
        Some(port) => {
            !port.is_empty() && port.len() <= 5 && port.chars().all(|ch| ch.is_ascii_digit())
        }
    }
}

fn is_authority_host_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '.' || ch == '-'
}

/// The committed shell references assets as `{{ASSET:<logical name>}}`; the
/// served document points them at the content-hashed immutable URLs.
pub(super) fn remote_page_html() -> &'static str {
    static RENDERED: OnceLock<String> = OnceLock::new();
    RENDERED.get_or_init(|| {
        let mut html = REMOTE_PAGE_SHELL.to_string();
        for logical_name in [
            "xterm.css",
            "remote-app.css",
            "xterm.js",
            "unicode-provider.js",
            "addon-fit.js",
            "addon-web-links.js",
            "remote-app.js",
        ] {
            let placeholder = format!("{{{{ASSET:{logical_name}}}}}");
            let url = super::page_assets::hashed_asset_url(logical_name)
                .expect("page shell references only registered assets");
            html = html.replace(&placeholder, &url);
        }
        assert!(
            !html.contains("{{ASSET:"),
            "page shell references an unregistered asset"
        );
        html
    })
}

fn remote_page_gzip() -> &'static [u8] {
    static GZIP: OnceLock<Vec<u8>> = OnceLock::new();
    GZIP.get_or_init(|| super::page_assets::gzip_for_page(remote_page_html().as_bytes()))
}

/// What the browser effectively loads: the rendered shell plus the readable
/// app sources the shell's hashed bundle was built from. Content-pinning
/// tests assert against this instead of the minified artifact.
#[cfg(test)]
pub(super) fn remote_client_source() -> String {
    format!(
        "{}\n{}\n{}",
        remote_page_html(),
        include_str!("assets/remote-app.css"),
        include_str!("assets/remote-app.js"),
    )
}

const REMOTE_PAGE_SHELL: &str = include_str!("page.html");

#[cfg(test)]
mod tests {
    use super::*;

    use crate::settings::Settings;

    fn remote_settings(enabled: bool, token: &str) -> crate::settings::models::RemoteSettings {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = token.into();
        settings.remote
    }

    /// Issue #561: leaving the page releases the lease (ADR-0037) and a long
    /// background expires it, so returning always meant tapping Connect again.
    /// The return trip is now armed — but only from a visible document, and a
    /// definitive refusal disarms it (ADR-0027 stays intact for takeovers).
    #[test]
    fn remote_page_html_auto_reconnects_only_from_a_visible_document() {
        let html = remote_client_source();
        // Tab-scoped intent. It survives the reload/discard a long background causes,
        // but a second tab must not inherit it — a stale tab that kept re-claiming
        // turned a fresh dashboard "Connect" into a 409 lease conflict.
        assert!(html.contains("const autoConnectKey = \"laymux.remote.autoConnect\";"));
        assert!(html.contains("sessionStorage.setItem(autoConnectKey, \"1\");"));
        assert!(html.contains("sessionStorage.removeItem(autoConnectKey);"));
        assert!(html.contains("return sessionStorage.getItem(autoConnectKey) === \"1\";"));
        // Reconnecting is not a takeover: ask who holds control before claiming.
        assert!(html.contains("async function autoConnectWhenFree()"));
        // One claim at a time: the automatic reconnect and a manual Connect aim at the
        // same lease, and racing them made the loser see a 409 for its own tab s lease
        // while the winner was released as stale.
        assert!(html.contains("let claimInFlight = false;"));
        assert!(html.contains("if (claimInFlight) {"));
        assert!(html.contains(
            "if (leaseId || claimInFlight || !autoConnectArmed() || (!androidE2eMode && !token())) return;"
        ));
        // Landing with the intent armed — or an imminent autoConnect claim
        // (the Android E2E entry always loads with autoConnect=1): no drawer
        // open-then-shut animation.
        assert!(html.contains(
            "setNavigationOpen(!(autoConnectArmed() || (autoConnectMode && (androidE2eMode || token()))));"
        ));
        assert!(html.contains("if (status && status.active && !resumeToken) {"));
        // A boot-time autoConnect claim runs outside a user gesture: focusing
        // the input would strand DOM focus without a soft keyboard and turn the
        // Keyboard toggle's first tap into a dismiss.
        assert!(html.contains("connect({ focusInput: false })"));
        assert!(html.contains("async function connect({ auto = false, focusInput = !auto } = {})"));
        // The pre-check is advisory. Only a bad token or remote access being off are
        // answers on their own; the claim judges ownership.
        assert!(html.contains("if (err && (err.status === 401 || err.status === 403)) {"));
        // A bfcache restore brings the document back with its variables intact, so a
        // lingering leaseId after the pagehide release reads as "we still have
        // control" and the reconnect skips its own return trip.
        assert!(
            html.contains("// capability above is what lets the reclaim follow the release drain.")
        );
        assert!(html.contains("setStatus(\"Another client has control.\");"));
        assert!(html.contains("function maybeAutoConnect()"));
        assert!(html.contains("if (document.visibilityState !== \"visible\") return;"));
        // Three signals for one moment: tab switch, bfcache restore, network back.
        assert!(html.contains("document.addEventListener(\"visibilitychange\", () => {"));
        assert!(html.contains("function resumeControlOnReturn()"));
        assert!(
            html.contains("window.addEventListener(\"pageshow\", () => resumeControlOnReturn());")
        );
        assert!(
            html.contains("window.addEventListener(\"online\", () => resumeControlOnReturn());")
        );
        // Connecting arms the intent; releasing on purpose withdraws it.
        assert!(html.contains("armAutoConnect();"));
        assert!(html.contains("disarmAutoConnect();"));
        // A host takeover ends the standing intent; a heartbeat timeout does not.
        assert!(
            html.contains("function loseRemoteControl(message, { hostTookOver = false } = {}) {")
        );
        assert!(html.contains("if (hostTookOver) disarmAutoConnect();"));
        // Reclaiming our own expired lease is not a failure to paint red: the notice
        // used to flash for the second before the reconnect replaced it.
        // Not visibility-gated: painting the failure screen into a hidden page only
        // shows up as a flash on the way back (menu popped open, red notice).
        assert!(html.contains("const reclaimingOurOwn = !hostTookOver && autoConnectArmed();"));
        assert!(html.contains("if (!reclaimingOurOwn) discardResumeToken();"));
        assert!(html.contains("if (reclaimingOurOwn) {"));
        assert!(html.contains("setConnectionHint(\"Reconnecting...\", false);"));
        // A heartbeat 409 (\"lease is not active\") does not name an owner, so it must
        // not be read as a takeover — an expiry while the phone was away answers the
        // same way. The claim settles ownership.
        assert!(html.contains("hostTookOver: err && (err.status === 401 || err.status === 403),"));
        assert!(html.contains(
            "const drainInProgress = err && err.status === 409 && err.transitioning === true;"
        ));
        assert!(html.contains("if (isFatalRemoteControlError(err) && !drainInProgress) {"));
        // A background/online reclaim restores control and output, not a soft
        // keyboard the user had already dismissed before the interruption.
        // `undefined`, not `null`: the pane hint parameter defaults to the
        // remembered pane, and an explicit `null` opts out of it — a reconnect
        // would then land on the focused pane instead of this tab's own.
        assert!(html.contains("await loadNavigation(undefined, {"));
        let connect_start = html
            .find("async function connect({ auto = false, focusInput = !auto } = {})")
            .unwrap();
        let connect_end = connect_start
            + html[connect_start..]
                .find("async function writeToTerminal")
                .unwrap();
        let connect = &html[connect_start..connect_end];
        assert!(
            !connect.contains("ensureTerminal();"),
            "xterm must not exist before navigation establishes its terminal owner"
        );
        let navigation_start = html.find("async function loadNavigation(").unwrap();
        let navigation_end = navigation_start
            + html[navigation_start..]
                .find("async function activateWorkspace")
                .unwrap();
        let navigation = &html[navigation_start..navigation_end];
        let owner_index = navigation
            .find("setActiveTerminal(nextTerminalId);")
            .unwrap();
        let terminal_index = navigation
            .find("ensureTerminal(terminalInfo && terminalInfo.appearance);")
            .unwrap();
        let attach_index = navigation
            .find("attachTerminal(activeTerminalId, {")
            .unwrap();
        assert!(
            owner_index < terminal_index && terminal_index < attach_index,
            "navigation must establish the draft owner before fallible xterm construction and attach"
        );
        // `focusInput` is the connect() option (default `!auto`); the boot-time
        // autoConnect claim passes false so no gesture-less focus strands DOM
        // focus without a soft keyboard.
        assert!(html.contains("focusInput,"));
        assert!(html.contains("preserveViewport: auto,"));
        assert!(html.contains("\"transitioning\","));
        assert!(html.contains("scheduleAutoConnectRetry();"));
        assert!(html.contains("const AUTO_CONNECT_RETRY_MAX_MS = 15000;"));
    }

    #[test]
    fn remote_page_html_registers_the_desktop_terminal_font() {
        let html = remote_client_source();
        // Only the exact advertised shapes may be registered as a font.
        assert!(html.contains("const REMOTE_FONT_FAMILY_PATTERN = /^LxRemoteFont-[0-9a-f]{12}$/;"));
        assert!(html.contains(
            "const REMOTE_FONT_URL_PATTERN = /^\\/remote\\/font\\/[0-9a-f]{16}\\.(?:ttf|otf)$/;"
        ));
        // A CSS `@font-face` rule whose src failed once stays in an error state,
        // so a retry through it would never re-request. FontFace objects do.
        assert!(html.contains("new FontFace(assets.family, `url(\"${face.url}\")`, {"));
        assert!(!html.contains("@font-face{font-family:"));
        assert!(html.contains("const REMOTE_FONT_MAX_ATTEMPTS = 3;"));
        assert!(html.contains("remoteFontFamilyState.delete(assets.key);"));
        // State is keyed by the advertised URLs: the alias hashes the face name,
        // so replacing the font file keeps the alias while the tokens change.
        assert!(
            html.contains("const key = `${family}|${faces.map((face) => face.url).join(\",\")}`;")
        );
        // One missing face must not throw away the ones that loaded.
        assert!(html.contains("Promise.allSettled(fontFaces.map((fontFace) => fontFace.load()))"));
        assert!(html.contains("const REMOTE_FONT_LOAD_TIMEOUT_MS = 20000;"));
        // `document.fonts.check` answers true for an unknown family (the fallback
        // can render the text), so readiness must also require an added face.
        assert!(html.contains(
            "if (loaded.length === 0 || !document.fonts.check(`16px \"${assets.family}\"`)) {"
        ));
        // No active terminal must not turn into applyTerminalAppearance(null) —
        // and either way an attach waiting on this font stops waiting (ADR-0133).
        assert!(html.contains("if (!info || !info.appearance) {"));
        assert!(html.contains("notifyAttachChromeSettled();"));
        // The alias is prepended only once loaded, so the fontFamily string
        // really changes and xterm re-measures the cell (ADR-0077).
        assert!(html.contains("fontFamily: remoteFontIsReady(fontAssets)"));
        assert!(html.contains("applyTerminalAppearance(info.appearance);"));
        assert!(html.contains("scheduleTerminalFit();"));
    }

    /// The wheel multipliers ride the per-terminal option bundle and are applied
    /// wherever the font and theme are, both at creation and on a live update.
    #[test]
    fn remote_page_html_applies_the_served_wheel_sensitivities() {
        let html = remote_client_source();
        assert!(html.contains("scrollSensitivity: normalized.scrollSensitivity,"));
        assert!(html.contains("fastScrollSensitivity: normalized.fastScrollSensitivity,"));
        // An older desktop omits the field and a hand-edited value can be out of
        // band; xterm throws on a non-positive sensitivity, so both are absorbed.
        assert!(html.contains("function normalizeScrollSensitivity(value, fallback) {"));
        assert!(html.contains("if (!Number.isFinite(parsed) || parsed <= 0) return fallback;"));
    }

    /// Finger-drag scrolling is this page's own pixel→line conversion, so the
    /// active gesture's multiplier is applied to the raw delta and never handed
    /// to xterm as an option (xterm rejects unknown option keys).
    #[test]
    fn remote_page_html_scales_finger_drag_scrollback() {
        let html = remote_client_source();
        assert!(html.contains("gesture.scrollRemainderPx += -deltaY * sensitivity;"));
        assert!(
            html.contains("sendTerminalCursorScroll(term, deltaY, twoFingerScrollSensitivity);")
        );
        assert!(html.contains("function adoptTouchScrollSensitivity(appearance = {}) {"));
        // Both the first terminal and every later appearance update adopt it.
        assert!(html.contains("adoptTouchScrollSensitivity(appearance);"));
        assert!(!html.contains("term.options.touchScrollSensitivity"));
    }

    /// ADR-0133: every PTY geometry change is a window-size event a
    /// frame-repainting TUI redraws from, and its erase is counted at the
    /// previous width — so attach publishes exactly one geometry.
    #[test]
    fn remote_page_html_publishes_one_attach_geometry() {
        let html = remote_client_source();
        // Bounded wait: a font that never arrives must not hold the terminal.
        assert!(html.contains("const REMOTE_ATTACH_CHROME_SETTLE_MS = 900;"));
        assert!(html
            .contains("await awaitAttachChromeSettled(terminalInfo && terminalInfo.appearance);"));
        // Both late chrome causes count, and "gave up"/"empty" count as settled.
        assert!(html.contains(
            "const fontPending = Boolean(assets) && remoteFontFamilyState.get(assets.key) === \"loading\";"
        ));
        assert!(html.contains("const stripPending = widgetPollActive && !widgetStripSettled;"));
        assert!(html.contains("widgetStripSettled = true;"));
        // The surface still fits during the wait; only publication is held, and a
        // resize queued before the hold must not fire out from under it.
        assert!(html.contains("attachGeometryHolds += 1;"));
        assert!(html.contains("attachGeometryHolds -= 1;"));
        assert!(html.contains(
            "if (outputAttachGeometryGeneration !== null || attachGeometryHolds > 0) return;"
        ));
        // xterm re-measures the cell only on resize, so the first fit can propose
        // a grid from a stale measurement: fit until the proposal stops moving.
        assert!(html.contains("function fitTerminalForAttach() {"));
        assert!(html.contains("if (terminal.cols === cols && terminal.rows === rows) return;"));
        assert!(html.contains("fitTerminalForAttach();"));
    }

    /// Issue #654: on a phone the address bar eats a row of terminal, and the
    /// portable way to drop it is an installable web app. Chrome needs the manifest
    /// link; iOS/iPadOS gives `apple-touch-icon` precedence over manifest icons
    /// and retains the legacy `apple-*` metadata path, so both sets stay present
    /// (ADR-0091).
    #[test]
    fn remote_page_html_declares_an_installable_standalone_app() {
        let html = remote_client_source();
        // A manifest fetch omits cookies by default, and this route carries the
        // same gate as the rest of `/remote/*` — without the attribute the
        // manifest 401s and the install prompt never appears.
        assert!(html.contains(
            "<link rel=\"manifest\" href=\"/remote/manifest.webmanifest\" crossorigin=\"use-credentials\" />"
        ));
        assert!(html.contains("<meta name=\"mobile-web-app-capable\" content=\"yes\" />"));
        assert!(html.contains("<meta name=\"apple-mobile-web-app-capable\" content=\"yes\" />"));
        assert!(html.contains("<meta name=\"apple-mobile-web-app-title\" content=\"Laymux\" />"));
        // `black-translucent` would run the terminal's first row under the clock.
        assert!(html.contains(
            "<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\" />"
        ));
        // Matches --bg-base so the launch splash does not flash a stock colour.
        assert!(html.contains("<meta name=\"theme-color\" content=\"#1e1e2e\" />"));
        assert!(html.contains(
            "<link rel=\"apple-touch-icon\" href=\"/remote/pwa/apple-touch-icon-180.png\" />"
        ));
    }

    /// The drawer opens on workspace navigation once control is connected.
    /// Notifications, connection, and infrequently changed device settings
    /// remain available, but live on their own drawer pages instead of
    /// surrounding the workspace list on every open.
    #[test]
    fn remote_page_html_keeps_secondary_pages_out_of_the_workspace_home() {
        let html = remote_client_source();

        let workspace_view = html
            .split("<div id=\"drawerWorkspaceView\"")
            .nth(1)
            .expect("the workspace drawer view is present")
            .split("</div><!-- /drawerWorkspaceView -->")
            .next()
            .unwrap();
        assert!(workspace_view.contains("id=\"workspaceSection\""));
        assert!(workspace_view.contains("id=\"dockSection\""));
        assert!(!workspace_view.contains("id=\"hiddenWorkspaceShelf\""));
        assert!(!workspace_view.contains("id=\"notificationSection\""));
        assert!(!workspace_view.contains("class=\"connection-panel\""));
        assert!(!workspace_view.contains("id=\"displaySection\""));
        assert!(!workspace_view.contains(">Workspaces</h2>"));

        let hidden_view = html
            .split("<div id=\"drawerHiddenView\"")
            .nth(1)
            .expect("the hidden-workspace drawer view is present")
            .split("</div><!-- /drawerHiddenView -->")
            .next()
            .unwrap();
        assert!(hidden_view.contains("id=\"hiddenWorkspaceSection\""));
        assert!(hidden_view.contains("id=\"hiddenWorkspaceShelf\""));

        let notifications_view = html
            .split("<div id=\"drawerNotificationsView\"")
            .nth(1)
            .expect("the notifications drawer view is present")
            .split("</div><!-- /drawerNotificationsView -->")
            .next()
            .unwrap();
        assert!(notifications_view.contains("id=\"notificationSection\""));
        assert!(notifications_view.contains("id=\"notificationPanel\""));

        let connection_view = html
            .split("<div id=\"drawerConnectionView\"")
            .nth(1)
            .expect("the connection drawer view is present")
            .split("</div><!-- /drawerConnectionView -->")
            .next()
            .unwrap();
        assert!(connection_view.contains("class=\"connection-panel\""));

        let settings_view = html
            .split("<div id=\"drawerSettingsView\"")
            .nth(1)
            .expect("the settings drawer view is present")
            .split("</div><!-- /drawerSettingsView -->")
            .next()
            .unwrap();
        assert!(settings_view.contains("id=\"displaySection\""));
        assert!(settings_view.contains("id=\"pcUpdateSection\""));
        assert!(settings_view.contains("id=\"installSection\""));

        assert!(html.contains("id=\"drawerNotificationsButton\""));
        assert!(html.contains("id=\"drawerConnectionButton\""));
        assert!(html.contains("id=\"drawerSettingsButton\""));
        assert!(!html.contains("id=\"hiddenWorkspaceBadge\""));
        assert!(!html.contains("id=\"notificationBadge\""));
        assert!(html.contains("status-indicator"));
        assert!(html.contains("id=\"drawerBack\""));
        assert!(!html.contains("id=\"navClose\""));
        assert!(!html.contains("class=\"drawer-close\""));
        let drawer_header_css = html
            .split(".drawer-header {")
            .nth(1)
            .and_then(|rules| rules.split('}').next())
            .expect("the drawer header CSS is present");
        assert!(drawer_header_css.contains("height: 32px;"));
        assert!(html.contains("function setDrawerView(view)"));
        assert!(html.contains("setDrawerView(leaseId ? \"workspace\" : \"connection\");"));
    }

    /// ADR-0099: the manifest makes installation possible, but every browser hides
    /// the path inside its own menu. The offer lives in the drawer — a banner would
    /// spend the terminal rows ADR-0091 set out to win back.
    #[test]
    fn remote_page_html_offers_installation_from_the_drawer() {
        let html = remote_client_source();
        // Inside the navigation drawer, after the last section — not the header
        // (already crowded) and not over the terminal.
        assert!(html.contains("<section id=\"installSection\""));
        assert!(html.contains("<button id=\"installApp\""));
        let drawer = html
            .split("<aside id=\"navigationPanel\"")
            .nth(1)
            .expect("the navigation drawer is present");
        let drawer = drawer.split("</aside>").next().unwrap();
        assert!(
            drawer.contains("id=\"installSection\""),
            "the install offer must sit inside the drawer"
        );
        // Hidden until something makes it actionable.
        assert!(html.contains("<section id=\"installSection\" class=\"nav-section\" aria-label=\"Install this app\" hidden>"));
    }

    /// ADR-0132: the device half of the widget-strip gate lives in the drawer.
    /// The key bar's popover is the other candidate and it is rejected here —
    /// the switch that brings a chrome row back must not sit behind another
    /// piece of chrome being visible.
    #[test]
    fn remote_page_html_offers_the_widget_bar_toggle_from_the_drawer() {
        let html = remote_client_source();
        let drawer = html
            .split("<aside id=\"navigationPanel\"")
            .nth(1)
            .expect("the navigation drawer is present");
        let drawer = drawer.split("</aside>").next().unwrap();
        assert!(
            drawer.contains("id=\"widgetStripToggle\""),
            "the widget bar toggle must sit inside the drawer"
        );
        // Not `locked`: what this browser spends its rows on needs no lease, and
        // it has to be settable before the first connect.
        assert!(html.contains(
            "<section id=\"displaySection\" class=\"nav-section\" aria-label=\"Display\">"
        ));
    }

    #[test]
    fn remote_page_html_edits_pc_owned_display_settings() {
        let html = remote_client_source();

        assert!(html.contains("id=\"remoteTerminalFontSize\""));
        assert!(html.contains("id=\"remoteComposerFontSize\""));
        assert!(html.contains("id=\"remoteMenuFontSize\""));
        assert!(html.contains("id=\"remoteComposerIdleOpacity\""));
        assert!(html.contains("id=\"remoteComposerFocusedOpacity\""));
        assert!(html.contains("id=\"remoteComposerActiveOpacity\""));
        assert!(html.contains("id=\"remoteTouchScrollSensitivity\""));
        assert!(html.contains("id=\"remoteTwoFingerScrollSensitivity\""));
        assert!(html.contains("/remote/v1/display-settings"));
        assert!(html.contains("method: \"PUT\""));
        assert!(html.contains("body: JSON.stringify({"));
        assert!(html.contains("leaseId: selectedLeaseId"));
        assert!(html.contains("terminalFontSize"));
        assert!(html.contains("composerFontSize"));
        assert!(html.contains("menuFontSize"));
        assert!(html.contains("composerIdleOpacity"));
        assert!(html.contains("composerFocusedOpacity"));
        assert!(html.contains("composerActiveOpacity"));
        assert!(html.contains("--remote-composer-font-size"));
        assert!(html.contains("--remote-menu-font-size"));
        assert!(html.contains("--remote-composer-idle-opacity"));
        assert!(html.contains("--remote-composer-focused-opacity"));
        assert!(html.contains("--remote-composer-active-opacity"));
        assert!(html.contains("data-opacity-state"));
        assert!(html.contains("function composerOpacityState()"));
        assert!(html.contains("applyTerminalAppearance(appearance);"));
        assert!(html.contains("scheduleTerminalFit();"));
    }

    #[test]
    fn remote_page_reports_and_starts_pc_updates() {
        let html = remote_client_source();

        assert!(html.contains("id=\"pcUpdateStatus\""));
        assert!(html.contains("id=\"checkPcUpdate\""));
        assert!(html.contains("id=\"installPcUpdate\""));
        assert!(html.contains("/remote/v1/update/check"));
        assert!(html.contains("/remote/v1/update/install"));
        assert!(html.contains("body: JSON.stringify({ leaseId: selectedLeaseId })"));
        assert!(html.contains(
            "installPcUpdateButton.disabled = busy || pcUpdateRequestInFlight || !leaseId"
        ));
        assert!(html.contains("drawerSettingsButton.classList.toggle(\"update-available\""));
        assert!(html.contains("delay ?? (busy ? 1000 : 60000)"));
    }

    /// A button that cannot install anything is worse than no button, so every
    /// condition that rules installation out keeps the section hidden (ADR-0099).
    #[test]
    fn remote_page_html_hides_the_install_offer_when_it_cannot_be_acted_on() {
        let html = remote_client_source();
        // Already on the home screen: nothing left to offer. iOS' legacy flag is
        // checked too — its standalone launch predates `display-mode`.
        assert!(html.contains("window.matchMedia(\"(display-mode: standalone)\")"));
        assert!(html.contains("navigator.standalone === true"));
        // HTTP direct mode is not a secure context, so no browser installs it.
        assert!(html.contains("window.isSecureContext"));
        assert!(html.contains("installSection.hidden = !installable;"));
        // Installing removes the reason to keep offering.
        assert!(html.contains("window.addEventListener(\"appinstalled\""));
    }

    /// Chromium proves installability by firing `beforeinstallprompt`, and that
    /// event is the only handle to the prompt. iOS has no such event and no
    /// programmatic path at all, so it gets the share-sheet instruction instead of
    /// a call into an API that does not exist (ADR-0099).
    #[test]
    fn remote_page_html_installs_through_the_deferred_prompt_or_explains_ios() {
        let html = remote_client_source();
        assert!(html.contains("window.addEventListener(\"beforeinstallprompt\""));
        // Letting the event through would spend Chromium's own mini-infobar and
        // leave nothing to trigger from the drawer.
        assert!(html.contains("deferredInstallPrompt = event;"));
        // A prompt event cannot be replayed, so it is dropped on use either way.
        assert!(html.contains("deferredInstallPrompt = null;"));
        assert!(html.contains("prompt.prompt()"));
        // No automatic prompt: Chromium refuses one without a user gesture, and
        // hijacking a page nobody asked to install is what the drawer avoids.
        assert!(!html.contains("deferredInstallPrompt.prompt();"));
        assert!(html.contains("installHint.hidden = !installHint.hidden;"));
        // The audience is developers, so the button names the thing being
        // installed. The hint quotes iOS' own share-sheet wording, which is what
        // the user has to look for on that platform.
        assert!(html.contains(">Install PWA</button>"));
        assert!(html.contains("Add to Home Screen"));
    }

    #[test]
    fn remote_page_html_contains_remote_bootstrap() {
        let html = remote_client_source();
        assert!(html.contains("Laymux Remote"));
        // The rendered shell references the hashed immutable asset URLs
        // (ADR-0169), never the fixed vendor paths.
        for logical_name in ["xterm.js", "xterm.css", "remote-app.js", "remote-app.css"] {
            let url = super::super::page_assets::hashed_asset_url(logical_name)
                .expect("registered asset");
            assert!(html.contains(&url), "shell must reference {url}");
        }
        assert!(!html.contains("/remote/vendor/"));
        // Without the provider script the remote client silently falls back to
        // xterm default Unicode 6 widths and wraps at different columns than the
        // desktop for emoji and 89 BMP code points (issue #538).
        assert!(html.contains(
            &super::super::page_assets::hashed_asset_url("unicode-provider.js")
                .expect("registered asset")
        ));
        assert!(html.contains("window.LaymuxUnicodeProvider"));
        assert!(html.contains("/remote/v1/session/claim"));
        assert!(html.contains("/remote/v1/navigation"));
        assert!(html.contains("/remote/v1/layouts"));
        assert!(html.contains("/remote/v1/workspaces"));
        assert!(html.contains("/remote/v1/workspaces/active"));
        assert!(
            html.contains("/remote/v1/workspaces/${encodeURIComponent(workspaceId)}/visibility")
        );
        assert!(html.contains("/remote/v1/panes/${encodeURIComponent(paneId)}/visibility"));
        assert!(html.contains("id=\"hiddenWorkspaceToggle\""));
        // New-workspace entry lives in the drawer header (left of
        // notifications) and opens its own subview instead of an inline row.
        assert!(html.contains("id=\"newWorkspace\""));
        assert!(html.contains("id=\"drawerCreateView\""));
        assert!(html.contains("id=\"newWorkspacePanel\""));
        assert!(html.contains("if (view === \"create\") return newWorkspaceButton;"));
        // Subviews close with the top-right X, not a leading back arrow.
        assert!(html.contains("aria-label=\"Close and return to workspace navigation\""));
        assert!(html.contains("function createWorkspace(layoutId)"));
        assert!(html.contains("function loadWorkspaceLayouts()"));
        assert!(html.contains("JSON.stringify({ leaseId: selectedLeaseId, layoutId })"));
        assert!(html.contains("id=\"hiddenWorkspaceShelf\""));
        assert!(html.contains("function setWorkspaceVisibility(workspaceId, hidden)"));
        assert!(html.contains("function setPaneVisibility(paneId, hidden)"));
        assert!(html.contains("/remote/v1/terminals/${encodeURIComponent(terminalId)}/focus"));
        assert!(html.contains("/remote/v1/terminals"));
        assert!(
            html.contains("JSON.stringify({ leaseId: activeLeaseId, cols, rows, exact: false })")
        );
        assert!(html.contains("new WebSocket"));
        assert!(html.contains("const androidE2eMode ="));
        assert!(html.contains("Native performs the encrypted background transition"));
        assert!(!html.contains("androidBackgroundLeaseSeconds()"));
        assert!(html.contains("window.LaymuxNative.requestRemoteHttp"));
        assert!(html.contains("function cancelAndroidRemoteHttp(requestId)"));
        assert!(html.contains(
            "if (typeof window.LaymuxNative?.cancelRemoteHttp !== \"function\") return;"
        ));
        assert!(html.contains("const androidHttpDocumentId = (() => {"));
        assert!(html.contains("cancelAndroidRemoteHttp(requestId);"));
        assert!(!html.contains("typeof window.LaymuxNative.cancelRemoteHttp === \"function\" &&"));
        assert!(html.contains("window.LaymuxOutputTransport.postMessage"));
        assert!(html.contains("onNativeForeground()"));
        assert!(html.contains("Secure Remote transport resumed after background."));
        assert!(
            html.contains("for (const outputSocket of Array.from(androidOutputSockets.values()))")
        );
        assert!(html.contains("outputSocket.acknowledge()"));
        assert!(!html.contains("window.LaymuxNative.openRemoteOutput"));
        assert!(!html.contains("terminalOutputPoll"));
        assert!(html.contains("new AndroidE2eOutputSocket(url)"));
        assert!(html.contains("new TerminalCtor"));
        assert!(html.contains("new WebLinksAddonCtor"));
        assert!(html.contains("function openRemoteUrl(uri)"));
        assert!(html.contains("function createRemotePrLinkProvider(term)"));
        assert!(html.contains("/github-repo"));
        assert!(html.contains("typeof terminal.registerLinkProvider === \"function\""));
        assert!(
            html.contains("terminal.registerLinkProvider(createRemotePrLinkProvider(terminal));")
        );
        assert!(html.contains("terminalInfoById.get(terminalId)?.cwd !== cwd"));
        assert!(html.contains("data.cwd !== cwd"));
        assert!(html.contains("repoRevision !== githubRepoRequestRevision"));
        assert!(html.contains("function activateTouchLink(term, element, point)"));
        assert!(html.contains("const linkElement = element.querySelector(\".xterm-screen\");"));
        assert!(html.contains("linkElement.classList.contains(\"xterm-cursor-pointer\")"));
        assert!(html.contains("if (activateTouchLink(term, element, point)) return;"));
        assert!(html.contains("event.pointerType === \"touch\" || event.pointerType === \"pen\""));
        assert!(html.contains("linkHandler: {"));
        assert!(html.contains("allowNonHttpProtocols: false"));
        assert!(html.contains("url.protocol !== \"http:\" && url.protocol !== \"https:\""));
        assert!(html.contains("window.open(url.href, \"_blank\", \"noopener,noreferrer\")"));
        // The Android wrapper WebView cannot open a window, so links there go to
        // the OS browser through the native bridge instead (ADR-0162).
        assert!(html.contains("if (typeof window.LaymuxNative?.openExternalUrl === \"function\")"));
        assert!(html.contains("window.LaymuxNative.openExternalUrl(url.href);"));
        assert!(html.contains("terminalOptionsForAppearance"));
        assert!(html.contains("terminalInfo.appearance"));
        assert!(html.contains("inputWriteChain"));
        assert!(html.contains("writeToTerminal(inputTerminalId, inputLeaseId"));
        assert!(html.contains("resizeTerminal(resizeTerminalId, resizeLeaseId"));
        assert!(html.contains("touch-action: none"));
        assert!(html.contains("UX contract: long press"));
        assert!(html.contains("const INTERNAL_TOUCH_LONG_PRESS_DELAY_MS"));
        assert!(html.contains("const INTERNAL_TOUCH_SCROLL_SLOP_PX"));
        assert!(html.contains("function installTouchSelectionBridge(term)"));
        assert!(html.contains("function installSelectionHandles(term)"));
        assert!(html.contains("function isNormalScrollbackMode(term)"));
        assert!(html.contains("function hasMouseTracking(term)"));
        assert!(html.contains("function isAlternateBufferCursorInput(term, data)"));
        assert!(html.contains("function consumeTouchScrollLines("));
        assert!(html.contains("function routeOneFingerScroll(term, deltaY, point)"));
        assert!(html.contains("function routeTwoFingerScroll(term, deltaY, point)"));
        assert!(html.contains("function sendTerminalAppScroll(term, deltaY, point)"));
        assert!(html.contains("function sendTerminalCursorScroll("));
        assert!(html.contains("enqueueDiscreteInput(sequence, Math.abs(wholeLines));"));
        assert!(html.contains("if (isAlternateBufferCursorInput(terminal, data))"));
        assert!(html.contains("function handleTouchTap(term, element, point)"));
        let touch_tap_start = html
            .find("function handleTouchTap(term, element, point)")
            .unwrap();
        let touch_tap_end = touch_tap_start
            + html[touch_tap_start..]
                .find("function selectionRange")
                .unwrap();
        let touch_tap = &html[touch_tap_start..touch_tap_end];
        assert!(touch_tap.contains("focusComposerFromTerminalTap();"));
        assert!(!touch_tap.contains("focusCurrentInputSurface();"));
        assert!(!touch_tap.contains("term.blur?.();"));
        let touch_focus_start = html
            .find("function focusComposerFromTerminalTap()")
            .unwrap();
        let touch_focus_end = touch_focus_start
            + html[touch_focus_start..]
                .find("function focusInputSurfaceAfterAwait")
                .unwrap();
        let touch_focus = &html[touch_focus_start..touch_focus_end];
        assert!(touch_focus.contains("focusCurrentInputSurface();"));
        assert!(touch_focus.contains("requestAnimationFrame(() => {"));
        assert!(touch_focus.contains("!fileViewerOverlayElement.hidden"));
        assert!(touch_focus.contains("focusedElement !== terminal?.textarea"));
        assert!(touch_focus.contains("focusedElement !== document.body"));
        assert!(html.contains("function startTouchSelection(term, element, pointerId)"));
        assert!(html.contains("function extendTouchSelection(term, gesture, point)"));
        assert!(html.contains("function handleSelectionMouseupAfterInteraction()"));
        assert!(html.contains("touchGesture.forceSelection,\n            2"));
        assert!(html.contains("touchGesture.selectionSeed = selection"));
        assert!(html.contains("if (!isTouchPointer(event)) return;"));
        assert!(!html.contains("activePointerId !== null || event.isPrimary === false"));
        assert!(html.contains("touchGesture.mode = \"scrolling\""));
        assert!(html.contains("touchGesture.mode = \"selecting\""));
        assert!(html.contains("mode: \"twoFingerScrolling\""));
        assert!(html.contains("triggerTouchTapSelection(term, element, point, 2)"));
        assert!(html.contains("triggerTouchTapSelection(term, element, point, 3)"));
        assert!(html.contains("className = \"touch-selection-handle\""));
        assert!(html.contains("new MouseEvent(type"));
        assert!(html.contains("mouseTrackingMode !== \"none\""));
        assert!(!html.contains("id=\"copySelection\""));
        assert!(html.contains("copySelectionToClipboard"));
        assert!(html.contains("terminal.onSelectionChange(() => {"));
        assert!(html.contains(
            "document.addEventListener(\"mouseup\", handleSelectionMouseupAfterInteraction);"
        ));
        assert!(!html.contains(
            "terminalHost.addEventListener(\"mouseup\", copySelectionAfterInteraction);"
        ));
        assert!(html.contains("if (fallbackCopyText(text)) return;"));
        assert!(html.contains("const terminalShell = document.querySelector(\".terminal-shell\")"));
        assert!(html.contains("resizeObserver.observe(terminalShell)"));
        assert!(html.contains("rect.width < 20 || rect.height < 20"));
        assert!(html.contains("function scheduleTerminalFit(sendResize = true)"));
        assert!(html.contains("function scheduleTerminalRefresh()"));
        assert!(html.contains("function loseRemoteControl(message, { hostTookOver = false } = {})"));
        assert!(html.contains("const OUTPUT_RECONNECT_INITIAL_DELAY_MS"));
        assert!(html.contains("const OUTPUT_RECONNECT_MAX_DELAY_MS"));
        assert!(html.contains("function scheduleOutputReconnect(terminalId, outputLeaseId)"));
        assert!(html.contains("function handleHeartbeatError(err)"));
        assert!(html.contains("let heartbeatAbortController = null;"));
        assert!(html.contains("const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 45;"));
        assert!(html.contains("const HEARTBEAT_REQUEST_TIMEOUT_MAX_MS = 4000;"));
        assert!(html.contains("const HEARTBEAT_RETRY_DELAY_MS = 1000;"));
        assert!(html.contains("const TRANSIENT_CONNECTION_NOTICE_DELAY_MS = 2000;"));
        assert!(html.contains(".status.warning"));
        assert!(html.contains("overflow-x: auto;"));
        let status_css = html
            .split(".status {")
            .nth(1)
            .and_then(|rules| rules.split(".status.error").next())
            .expect("Remote status CSS must exist");
        assert!(!status_css.contains("text-overflow: ellipsis;"));
        assert!(html.contains("function setStatus(message, error = false, warning = false)"));
        assert!(html.contains("function setBusyStatus(message, error = false, warning = false)"));
        assert!(html.contains("id=\"statusSpinner\""));
        assert!(html.contains("statusEl.setAttribute(\"aria-busy\", busy ? \"true\" : \"false\");"));
        assert!(html.contains("statusEl.classList.toggle(\"warning\", warning);"));
        assert!(
            html.contains("setBusyStatus(\"Connection interrupted. Reconnecting…\", false, true);")
        );
        assert!(html.contains(".input-mode-toggle {"));
        assert!(html.contains("width: 34px;"));
        assert!(html.contains("height: var(--key-bar-control-height);"));
        assert!(!html.contains("id=\"inputModeLabel\""));
        assert!(html
            .contains("inputModeToggleButton.setAttribute(\"aria-label\", inputModeActionLabel);"));
        assert!(html.contains("id=\"desktopModeHeader\""));
        assert!(html.contains("id=\"desktopModeDrawer\""));
        assert!(html.contains("desktopModeHeaderButton.hidden = !localAppMode;"));
        assert!(html.contains("desktopModeDrawerButton.hidden = !localAppMode;"));
        assert!(!html.contains("desktopModeHeaderButton.textContent = \"Close\""));
        assert!(!html.contains("desktopModeDrawerButton.textContent = \"Close\""));
        assert!(html.contains("id=\"exit\" class=\"danger\">Exit</button>"));
        assert!(!html.contains("id=\"exit\" class=\"danger\" disabled"));
        assert!(html.contains("async function exitRemote()"));
        assert!(
            html.contains("if (currentLease) await releaseLease(currentLease).catch(() => {});")
        );
        assert!(html.contains("window.LaymuxNative.disconnectRemote();"));
        assert!(html.contains("const localAppMode ="));
        assert!(html.contains("const autoConnectMode ="));
        assert!(html.contains("clientNameInput.value = clientNameFromParams"));
        assert!(html.contains("function requestDesktopMode()"));
        assert!(
            html.contains("window.parent.postMessage({ type: \"laymux:desktop-mode\" }, \"*\")")
        );
        assert!(html.contains("location.hash.replace"));
        assert!(html.contains("const lostLeaseId = leaseId"));
        assert!(html.contains("releaseLease(lostLeaseId).catch(() => {})"));
        assert!(html.contains("Control returned to the host"));
        assert!(html.contains("connection-panel.attention"));
        assert!(html.contains("Host has control. Connect again to request control."));
        assert!(html.contains("queueTerminalWrite(payload)"));
        assert!(html.contains("cols < 1 || rows < 1"));
        assert!(html.contains("id=\"navToggle\""));
        assert!(!html.contains("<h1>Laymux Remote</h1>"));
        assert!(html.contains("class=\"drawer-header\""));
        assert!(html.contains("class=\"connection-panel\""));
        assert!(html.contains("Connect first to load workspaces"));
        assert!(html.contains("id=\"workspaceSection\""));
        assert!(html.contains("workspace-item-content"));
        assert!(html.contains("workspace-pane-row"));
        assert!(html.contains("id=\"notificationSection\""));
        assert!(html.contains("id=\"drawerNotificationsButton\""));
        assert!(html.contains("id=\"notificationPanel\""));
        assert!(!html.contains("id=\"notificationBadge\""));
        assert!(html.contains("renderNotificationPanel(data.notifications || []"));
        assert!(html.contains("/remote/v1/notifications/mark-all-read"));
        assert!(
            html.contains("/remote/v1/notifications/${encodeURIComponent(notification.id)}/read")
        );
        assert!(html.contains("/remote/v1/notifications\","));
        assert!(html.contains("function openNotification(notification)"));
        assert!(!html.contains("id=\"terminals\""));
        assert!(html.contains("id=\"dockSection\""));
        assert!(html.contains("id=\"dockToggle\""));
        assert!(html.contains("id=\"dockPanel\""));
        assert!(html.contains("id=\"dockList\""));
        assert!(html.contains("renderDockList(data.docks || [])"));
        assert!(html.contains("function renderDockTerminalRow(dock, pane)"));
        assert!(html.contains("focusDockHost: true"));
        assert!(html.contains("function isDockTerminalId(terminalId)"));
        assert!(html.contains("options.focusDockHost === true || !isDockTerminalId(terminalId)"));
        assert!(html.contains("function isMainOutputTerminal(data, terminalId)"));
    }

    #[test]
    fn remote_page_html_contains_in_page_file_viewer() {
        let html = remote_client_source();
        assert!(html.contains("id=\"fileViewerSection\""));
        assert!(html.contains(
            "id=\"fileViewerPath\" type=\"text\" autocomplete=\"off\" autocapitalize=\"off\""
        ));
        assert!(html.contains("id=\"openFileViewer\" type=\"button\" disabled>Open viewer"));
        assert!(html.contains("id=\"pullHostFileViewerPath\""));
        assert!(html.contains(">From host</button>"));
        assert!(!html.contains("id=\"openCurrentFileViewer\""));
        assert!(!html.contains("id=\"refreshFileViewer\""));
        assert!(!html.contains("id=\"openFileViewerPath\""));
        assert!(!html.contains("let fileViewerPathDirty = false;"));
        assert!(html.contains("let fileViewerStatusRequestRevision = 0;"));
        assert!(html.contains("let fileViewerPathRevision = 0;"));
        assert!(!html.contains("refreshFileViewerStatus().catch(() => {});"));
        assert!(html.contains("event.isComposing ||"));
        assert!(html.contains("event.keyCode === 229 ||"));
        // The viewer renders in this document (ADR-0184): no second tab, so no
        // `window.open`, no credential handshake, and no viewer bootstrap route.
        assert!(html.contains("id=\"fileViewerOverlay\""));
        assert!(html.contains("function openFileViewerOverlay(path, explorerReturnPath = null)"));
        assert!(html.contains("function closeFileViewer()"));
        assert!(html.contains("body: JSON.stringify({ source: \"path\", path }),"));
        // Explorer mode (ADR-0198): the directory listing lives in this same
        // overlay and reaches the host only through the lease+capability route.
        assert!(html.contains("id=\"fileExplorerHeader\""));
        assert!(html.contains("id=\"fileViewerDirectory\""));
        assert!(html.contains("id=\"fileViewerBack\""));
        assert!(html.contains("function openFileExplorerOverlay(request)"));
        assert!(html.contains("function renderDirectoryListing(payload)"));
        assert!(html.contains("\"/remote/v1/file-viewer/list\""));
        // Entry names are text, never markup: a hostile file name must not
        // become HTML in this document.
        assert!(html.contains("name.textContent = entry.name;"));
        assert!(!html.contains("/remote/viewer/"));
        assert!(!html.contains("window.open(\"/remote/viewer/\""));
        assert!(!html.contains("laymux:file-viewer-ready"));
        assert!(!html.contains("laymux:file-viewer-session"));
        assert!(!html.contains("Popup blocked. Allow popups and try again."));
        // The Android wrapper has no second window, which is why the section was
        // hidden there. In-page rendering removes the reason.
        assert!(!html.contains("fileViewerSection.hidden = true;"));
    }

    #[test]
    fn remote_page_file_viewer_keeps_the_sandboxed_preview_boundary() {
        let html = remote_client_source();
        // Same origin as the old tab (ADR-0041), so the boundary that matters is
        // the empty sandbox: no allow-scripts, no allow-same-origin.
        assert!(html.contains("id=\"fileViewerPreview\""));
        assert!(html.contains("sandbox=\"\""));
        assert!(html.contains("fileViewerPreviewElement.setAttribute(\"sandbox\", \"\");"));
        assert!(html.contains("fileViewerPreviewElement.srcdoc = payload.previewDocument;"));
        // Images stay a decoded `data:` URL and text stays textContent — neither
        // path may become HTML in this document.
        assert!(html.contains("/^data:image\\//i.test(payload.dataUrl || \"\")"));
        assert!(html.contains("fileViewerTextElement.textContent = payload.content || \"\";"));
        assert!(!html.contains("fileViewerTextElement.innerHTML"));
    }

    #[test]
    fn remote_page_file_viewer_download_asks_for_bytes_not_the_rendered_payload() {
        let html = remote_client_source();
        assert!(html.contains("id=\"fileViewerDownload\""));
        assert!(html.contains("function downloadCurrentFileViewerFile()"));
        // Its own endpoint (ADR-0185): `render` hands back a sanitized preview
        // for HTML/Markdown and no bytes at all for binary or archive kinds.
        assert!(html.contains("/remote/v1/file-viewer/download"));
        assert!(html.contains("function saveDownloadInBrowser(payload)"));
        assert!(html.contains("anchor.download = payload.name;"));
        // The wrapper WebView has no download handler, so a browser-style save
        // is a silent no-op there and must not be attempted.
        assert!(html.contains("window.LaymuxNative?.saveRemoteFile"));
        assert!(html.contains("This app version cannot save files. Update the app."));
    }

    #[test]
    fn remote_page_file_viewer_zoom_is_transient_display_state() {
        let html = remote_client_source();
        assert!(html.contains("const FILE_VIEWER_ZOOM_STEP = 0.25;"));
        assert!(html.contains("function handleFileViewerPointerDown(event)"));
        assert!(html.contains("fileViewerPointers.size === 2"));
        assert!(html.contains("function handleFileViewerWheel(event)"));
        assert!(html.contains("{ passive: false }"));
        // Zoom is per-view state, never a setting: nothing persists it.
        assert!(!html.contains("laymux.remote.fileViewerZoom"));
    }

    #[test]
    fn remote_page_html_contains_selected_file_path_links() {
        let html = remote_client_source();
        assert!(html.contains("/remote/v1/file-viewer/path-link"));
        assert!(html.contains("function evaluatePathLinkSelection()"));
        assert!(html.contains("function schedulePathLinkSelectionEvaluation("));
        assert!(html.contains("const PATH_LINK_SELECTION_DEBOUNCE_MS = 100;"));
        assert!(html.contains("const currentPosition = term.getSelectionPosition?.();"));
        assert!(html.contains("data.valid !== true || !Array.isArray(data.matches)"));
        assert!(html.contains("data.matches.length > REMOTE_PATH_LINK_MAX_SELECTION_MATCHES"));
        assert!(html.contains("slice(match.startIndex, match.endIndex) === match.token"));
        assert!(
            html.contains("const { text, columns, endColumns } = reconstructRemoteLinkLine(line);")
        );
        assert!(html.contains("text.slice(startOffset, endOffset + 1) === match.token"));
        assert!(html.contains("endCol: endColumns[endOffset]"));
        assert!(html.contains("setVerifiedPathLinks(\"selection\", matches.map((match) => ({"));
        assert!(html.contains("pathLinkAtPoint(event.clientX, event.clientY)"));
        assert!(html.contains("remote-path-link-decoration"));
        assert!(html.contains("openFileViewerOverlay(press.path)"));
        assert!(html.contains("clearPathLinkSelection()"));
        assert!(html.contains("mode: \"selection\","));
    }

    /// ADR-0188: the tap/click (`point`) and idle-screen (`screen`) triggers are
    /// part of the page contract, each bounded to one batch per trigger.
    #[test]
    fn remote_page_html_contains_point_and_idle_screen_path_link_triggers() {
        let html = remote_client_source();
        assert!(html.contains("const PATH_LINK_SCOPES = [\"selection\", \"point\", \"screen\"];"));
        assert!(html.contains("const REMOTE_PATH_LINK_IDLE_SCAN_DELAY_MS = 500;"));
        assert!(html.contains("const REMOTE_PATH_LINK_MAX_SCREEN_LINES = 64;"));
        assert!(html.contains("const REMOTE_PATH_LINK_MAX_SCREEN_CHARS = 8192;"));
        assert!(html.contains("const REMOTE_PATH_LINK_MAX_SCREEN_CANDIDATES = 64;"));
        assert!(html.contains("function evaluatePathLinkPoint(point)"));
        assert!(html.contains("function evaluatePathLinkScreen()"));
        assert!(html.contains("function schedulePathLinkIdleScan()"));
        assert!(html.contains("function requestLineScopedPathLinks("));
        assert!(html.contains("function mapRemoteLinePathRange(bufferLine, match)"));
        assert!(html.contains("queuePathLinkPointEvaluation(point)"));
        // Output pushes the idle scan out instead of scanning mid-stream.
        assert!(html.contains("schedulePathLinkIdleScan();"));
        // An unchanged screen must not re-run the filesystem batch — but the
        // skip only holds while the previous scan is still drawn, otherwise the
        // idle scheduler's retire would drop the display for good.
        assert!(html.contains(
            "if (signature === pathLinkLastScreenSignature && pathLinkScopes.screen.length > 0)"
        ));
        // A live selection owns discovery, for the screen scan and for a tap.
        assert_eq!(
            html.matches("if (term.hasSelection?.()) return;").count(),
            2
        );
        // Output can repaint a row in place: the surviving scopes are re-checked
        // against their stored token instead of being trusted.
        assert!(html.contains("function revalidatePathLinkScopes()"));
        assert!(html.contains("function pathLinkEntryStillOnScreen(entry)"));
        assert!(html.contains(
            "revalidatePathLinkScopes();
                      schedulePathLinkIdleScan();"
        ));
        assert_eq!(html.matches("token: match.token,").count(), 2);
        assert!(
            html.contains("caret: { lineIndex: 0, index: caretIndex }")
                || html.contains("{ lineIndex: 0, index: caretIndex }")
        );
    }

    #[test]
    fn remote_page_html_contains_jump_to_bottom_button() {
        let html = remote_client_source();

        assert!(html.contains(
            "id=\"scrollToBottom\" class=\"terminal-scroll-to-bottom\" type=\"button\" hidden"
        ));
        assert!(html.contains("aria-label=\"Scroll to bottom\""));
        assert!(html.contains("function isTerminalScrolledUp(term)"));
        assert!(html.contains("function terminalViewportDistanceFromBottom(term)"));
        assert!(html.contains("function restoreTerminalViewport(term, distanceFromBottom)"));
        assert!(html.contains("function updateScrollToBottomButton(term = terminal)"));
        assert!(html.contains("function scrollTowardComposerBottom()"));
        // A pending Composer hide waits for the newest two-pass fit and is
        // invalidated by any user-owned viewport movement in either direction.
        assert!(html.contains("let terminalFitRevision = 0;"));
        assert!(html.contains("let terminalFitSettledRevision = 0;"));
        assert!(html.contains("function scheduleComposerAgentInputHideFlush()"));
        assert!(html.contains("if (terminalFitSettledRevision !== terminalFitRevision) return;"));
        assert!(html.contains("terminalFitSettledRevision = fitRevision;"));
        assert!(html.contains("viewportInteractionRevision: terminalViewportInteractionRevision"));
        assert!(html.contains("function markTerminalViewportInteraction()"));
        assert!(html.contains("markTerminalViewportInteraction();\n          const distanceFromBottom"));
        assert!(html.contains(
            "scrollToBottomButton.addEventListener(\"pointerdown\", markTerminalViewportInteraction);"
        ));
        assert!(html.contains(
            "scrollToBottomButton.addEventListener(\"click\", scrollTowardComposerBottom);"
        ));
        assert!(html.contains("terminal.scrollToBottom();"));
    }

    #[test]
    fn remote_page_html_contains_soft_key_toolbar() {
        let html = remote_client_source();
        // Markup: toolbar row, footer toggle, and the drawer Settings editor.
        assert!(html.contains("id=\"keyBar\""));
        assert!(html.contains("id=\"keyBarToggle\""));
        assert!(!html.contains("id=\"keyBarSettings\""));
        assert!(!html.contains("id=\"keyPopover\""));
        assert!(html.contains("id=\"inputLayoutEditor\""));
        assert!(html.contains("id=\"keyRow\""));
        assert!(
            html.contains("id=\"keyRow\" class=\"key-row\" role=\"group\" aria-label=\"Keys row\"")
        );
        // Config is client-only UI state persisted to localStorage (ADR-0028).
        assert!(html.contains("laymux.remote.keybar"));
        assert!(html.contains("const DEFAULT_KEYBAR = {"));
        assert!(html.contains("expanded: false,"));
        assert!(html.contains("sets: [\"step\", \"nav\"],"));
        assert!(html.contains("order: KEY_ORDER,"));
        // Predefined sets are selectable and a custom palette exists.
        assert!(html.contains("id: \"nav\", name: \"Navigation\""));
        assert!(html.contains("id: \"ctrl\", name: \"Ctrl keys\""));
        assert!(html.contains("id: \"fn\", name: \"Function\""));
        assert!(html.contains("function resolveKeyIds()"));
        assert!(html.contains("function renderKeyPopover()"));
        // Every enabled key appears in a compact sortable grid. Long-press drag
        // is the primary path; selection exposes keyboard/accessibility moves.
        assert!(html.contains("function moveKey(id, offset)"));
        assert!(html.contains("return keyBarConfig.order.filter((id) => enabled.has(id));"));
        assert!(html.contains("const KEY_ORDER_HOLD_MS = 180;"));
        assert!(html.contains("function installKeyOrderDrag(chip, id)"));
        assert!(html.contains("chip.classList.add(\"dragging\");"));
        assert!(html.contains(
            "target.classList.add(gesture.afterTarget ? \"drop-after\" : \"drop-before\");"
        ));
        assert!(html.contains("title.textContent = \"Key order\";"));
        assert!(html.contains("reset.setAttribute(\"aria-label\", \"Reset key order\");"));
        assert!(html.contains("`Move ${accessibleName} to start`"));
        assert!(html.contains("function appendKeyToVisibleEnd(id, visibleIds)"));
        assert!(html.contains("section.className = \"key-order-section\";"));
        assert!(html.contains("chip.className = \"key-chip key-order-chip\";"));
        // Keys reuse the existing write path via enqueueInput, no new API.
        assert!(html.contains("function sendKey(id, button = null)"));
        assert!(html.contains("if (seq) enqueueInput(seq);"));
        // Pointer/mouse activation must not blur the focused input surface and
        // dismiss an already-open native keyboard (#482). WebKit/iOS only honors
        // mousedown.preventDefault() for this, so both events are guarded via the
        // shared helper. Click remains the accessible send path.
        assert!(html.contains("function preventFocusSteal(event)"));
        assert!(html.contains("function keepInputSurfaceFocus(button)"));
        assert!(html.contains("button.addEventListener(\"mousedown\", preventFocusSteal);"));
        assert!(html.contains("button.addEventListener(\"pointerdown\", preventFocusSteal);"));
        assert!(html.contains("function installSoftKey(button, id)"));
        assert!(html.contains("keepInputSurfaceFocus(button);"));
        assert!(html.contains("button.addEventListener(\"click\", () => sendKey(id, button));"));
        // Cursor keys (arrows/Home/End) are DECCKM-aware: SS3 in app mode, else CSI.
        assert!(html.contains("up: { label: \"↑\", cursor: \"A\" }"));
        assert!(html.contains("home: { label: \"Home\", cursor: \"H\" }"));
        assert!(html.contains("return (appMode ? \"\\x1bO\" : \"\\x1b[\") + def.cursor;"));
        assert!(html.contains("terminal.modes.applicationCursorKeysMode"));
        // The compact direction pad maps a four-way pointer flick back through the
        // same DECCKM-aware arrow definitions and exposes a pressed-state hint.
        assert!(html.contains("dpad: { label: \"↕↔\", flick: true }"));
        assert!(html.contains("const KEY_FLICK_THRESHOLD_PX = 18;"));
        assert!(html.contains("function directionFromFlick(deltaX, deltaY)"));
        assert!(html.contains(
            "installDirectionalFlick(button, onDirection = (direction) => sendKey(direction))"
        ));
        assert!(html.contains("onDirection(direction);"));
        assert!(html.contains("id=\"keyFlickHint\""));
        assert!(html.contains("data-flick-direction=\"up\""));
        assert!(html.contains("data-flick-direction=\"right\""));
        assert!(html.contains("data-flick-direction=\"down\""));
        assert!(html.contains("data-flick-direction=\"left\""));
        // A representative fixed sequence: Tab, Delete, and F1 (SS3).
        assert!(html.contains("tab: { label: \"Tab\", seq: \"\\t\" }"));
        assert!(html.contains("stab: { label: \"⇧Tab\", seq: \"\\x1b[Z\" }"));
        assert!(html.contains("end: { label: \"End\", cursor: \"F\" }"));
        assert!(html.contains("del: { label: \"Del\", seq: \"\\x1b[3~\" }"));
        assert!(html.contains("f1: { label: \"F1\", seq: \"\\x1bOP\" }"));
        // Toggle visibility drives the hidden attribute + persistence.
        assert!(html.contains("function setKeyBarVisible(visible, persist = true)"));
        assert!(html.contains("keyBar.hidden = !keysVisible || !keyBarConfig.expanded;"));
    }

    #[test]
    fn remote_page_html_contains_three_zone_input_layout_settings() {
        let html = remote_client_source();

        assert!(html.contains("id=\"mainActionRow\""));
        assert!(html.contains("id=\"inputLayoutEditor\""));
        assert!(html.contains("Input bar"));
        assert!(html.contains("const INPUT_ACTION_ZONES = [\"main\", \"expanded\", \"hidden\"]"));
        assert!(html.contains("main: [\"ctrl-c\", \"keyboard\", \"keys\", \"send\"]"));
        assert!(html.contains("hidden: [\"attachment\"]"));
        assert!(html.contains("function normalizeInputLayoutConfig(raw)"));
        assert!(html.contains("const KEY_ID_SET = new Set(KEY_ORDER);"));
        assert!(html.contains("value.order.filter((id) => KEY_ID_SET.has(id))"));
        assert!(!html.contains("value.order.filter((id) => KEY_DEFS[id])"));
        assert!(html.contains("function projectSoftKeyOrderFromZones(zones)"));
        assert!(html.contains("function syncKeyOrderProjection()"));
        assert!(html.contains("function resolvePlacedKeyIdsInZone(zone)"));
        assert!(html.contains("function moveInputAction(actionId, zone, commit = true)"));
        assert!(html.contains("function renderInputSettingsPreservingScroll()"));
        assert!(html.contains("function renderInputActionRows()"));
        assert!(html.contains("function syncExpandedRowEmptyState()"));
        assert!(html.contains("actionId !== \"send\" || composerMode"));
        assert!(html.contains("chip.dataset.orderZone = zone;"));
        assert!(html.contains("target?.dataset.orderZone === sourceZone"));
        assert!(html.contains("keyBarConfig.expanded = false;"));
        assert!(!html.contains("id=\"keyBarSettings\""));
        assert!(!html.contains("id=\"keyPopover\""));
    }

    #[test]
    fn remote_page_html_contains_step_navigation_keys() {
        let html = remote_client_source();
        // Step navigation lives INSIDE the soft-key toolbar as a configurable
        // key set (issue #474): no dedicated bar row exists.
        assert!(!html.contains("id=\"navStepBar\""));
        // Nav action keys carry `nav: [kind, direction]` instead of a byte seq.
        assert!(html.contains("navPad: { label: \"P↕N↔\", navFlick: true, navBadge: true }"));
        assert!(html.contains("navPrev: { label: \"P↑\", nav: [\"spatial\", \"prev\"]"));
        assert!(html.contains("navNext: { label: \"P↓\", nav: [\"spatial\", \"next\"]"));
        assert!(html.contains("notifRecent: { label: \"N←\", nav: [\"notification\", \"recent\"]"));
        assert!(html.contains("notifOldest: { label: \"N→\", nav: [\"notification\", \"oldest\"]"));
        // Selectable via the key-set popover and enabled by default.
        assert!(html.contains("id: \"step\", name: \"Pane/Alert nav\""));
        assert!(html.contains("sets: [\"step\", \"nav\"],"));
        // 4-way nav flick: vertical = spatial pane step, horizontal = alerts.
        assert!(html.contains("const NAV_FLICK_TARGETS = {"));
        assert!(html.contains("up: [\"spatial\", \"prev\"]"));
        assert!(html.contains("down: [\"spatial\", \"next\"]"));
        assert!(html.contains("left: [\"notification\", \"recent\"]"));
        assert!(html.contains("right: [\"notification\", \"oldest\"]"));
        // Controller actions hit the lease-gated endpoints, taps serialize on
        // a promise chain, and the viewport follows the landing target.
        assert!(html.contains("spatial: \"/remote/v1/navigation/spatial\""));
        assert!(html.contains("notification: \"/remote/v1/navigation/notification\""));
        assert!(html.contains("excludedPaneIds: [...spatialExcludedPaneIds]"));
        assert!(html.contains("let navStepChain = Promise.resolve();"));
        assert!(html.contains("if (!leaseId || navStepPending >= 2) return;"));
        assert!(html.contains("await loadNavigation(data.target.terminalId || null);"));
        assert!(
            html.contains("no_included_panes: \"Every pane is excluded from pane navigation.\"")
        );
        assert!(html.contains("no_unread_notifications: \"No unread notifications.\""));
        // Nav keys gate on the lease only (escape-seq keys need a terminal
        // too); alert keys idle at zero unread and carry one count badge.
        assert!(html.contains("const isAlertKey = def.nav && def.nav[0] === \"notification\";"));
        assert!(html.contains("btn.disabled = !connected || (isAlertKey && unread <= 0);"));
        assert!(html.contains("function updateNavKeyBadge(unread)"));
    }

    #[test]
    fn remote_page_html_contains_spatial_pane_exclusion_toggle() {
        let html = remote_client_source();

        assert!(html.contains("id=\"spatialExclusion\""));
        assert!(html.contains("data-icon=\"circle-minus\""));
        // Every compact Remote header action shares one explicit border-box
        // height, including the adjacent text-bearing Composer toggle.
        assert!(html.contains("--header-control-height: 26px;"));
        assert!(html.contains("height: var(--header-control-height);"));
        assert!(html.contains("laymux.remote.spatialExcludedPaneIds"));
        assert!(html.contains("let spatialExcludedPaneIds = loadSpatialExcludedPaneIds();"));
        assert!(html.contains("function activeWorkspacePane()"));
        assert!(html.contains("spatialExclusionButton.hidden = !pane;"));
        assert!(html
            .contains("spatialExclusionButton.setAttribute(\"aria-pressed\", String(excluded));"));
        assert!(html.contains("spatialExclusionButton.addEventListener(\"click\", () => {"));
        assert!(html.contains("saveSpatialExcludedPaneIds();"));
    }

    #[test]
    fn remote_page_html_contains_workspace_skip_toggle() {
        let html = remote_client_source();

        // Drawer per-workspace skip toggle reuses the same circle-minus icon
        // and a Set<workspaceId> denylist persisted under its own key (#507).
        assert!(html.contains("laymux.remote.spatialExcludedWorkspaceIds"));
        assert!(
            html.contains("let spatialExcludedWorkspaceIds = loadSpatialExcludedWorkspaceIds();")
        );
        assert!(html.contains("button.className = \"workspace-skip-button\";"));
        assert!(html.contains(".workspace-skip-button[aria-pressed=\"true\"]"));
        assert!(html.contains("function renderWorkspaceSkipButton(workspace)"));
        assert!(html.contains("data-icon=\"circle-minus\""));
        // Skip toggle must not also switch workspace (row click) — the handler
        // stops the click from bubbling to the row.
        assert!(html.contains("event.stopPropagation();"));
        assert!(html.contains("saveSpatialExcludedWorkspaceIds();"));
        // Pure promotion/demotion + on-entry reconcile rules (all panes skipped
        // <-> workspace skipped) live in named functions.
        assert!(html.contains("function computeSkipStateAfterPaneToggle("));
        assert!(html.contains("function computeSkipStateAfterWorkspaceToggle("));
        assert!(html.contains("function reconcileWorkspaceSkips()"));
        // The spatial step request carries both denylists.
        assert!(html.contains("excludedWorkspaceIds: [...spatialExcludedWorkspaceIds]"));
    }

    #[test]
    fn remote_page_html_contains_header_pane_identity() {
        let html = remote_client_source();
        // The header shows a friendly "Workspace · Pane N" context title
        // instead of the raw terminal id, and doubles as the landing indicator
        // after a navigation step (issue #474).
        assert!(html.contains("function activeTerminalTitle()"));
        assert!(html.contains("`${ctx.workspace.name} · Pane ${ctx.paneNumber}`"));
        assert!(html.contains("(terminalId === activeTerminalId && activeTerminalTitle())"));
        // Header copy button yields the same lx:pane locator as the desktop
        // pane badge; hidden when no workspace pane is attached.
        assert!(html.contains("id=\"copyPaneId\""));
        assert!(html.contains("function activePaneIdentifier()"));
        assert!(html.contains("`lx:pane:${name}:${ctx.paneNumber}`"));
        assert!(html.contains("copyPaneIdButton.hidden = !activePaneIdentifier();"));
        // Copy reuses the secure-context clipboard helper with its fallback.
        assert!(html.contains("writeClipboardText(identifier)"));
    }

    #[test]
    fn remote_page_html_contains_detached_input_composer() {
        let html = remote_client_source();

        // The focused Remote surface exposes the same Direct/Composer choice on
        // fine-pointer desktops and coarse-pointer mobile clients.
        assert!(html.contains("id=\"inputModeToggle\""));
        assert!(html.contains("id=\"terminalComposer\""));
        assert!(html.contains("id=\"composerInput\""));
        assert!(!html.contains("id=\"composerInsert\""));
        // A configurable Send action is available whenever Composer is active.
        assert!(html.contains("id=\"composerSend\""));
        assert!(html.contains("class=\"composer-send\""));
        assert!(html.contains(
            "data-icon=\"paper-plane\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"currentColor\""
        ));
        assert!(html.contains(
            "M13.47 20.21 19.91 4.09 3.8 10.53l3.75 3.77 9.14-6.99-6.99 9.14 3.77 3.76Z"
        ));
        assert!(!html.contains("M12 5l6.5 6.5-1.42 1.42L13 8.83V19h-2V8.83l-4.08 4.09L5.5 11.5z"));
        assert!(html.contains("laymux.remote.inputMode"));
        assert!(html.contains("matchMedia(\"(pointer: coarse)\")"));

        // Mode and unsent drafts are terminal-local runtime state. Only the
        // preferred default mode is persisted.
        assert!(html.contains("const inputModeByTerminalId = new Map()"));
        assert!(html.contains("const composerDraftByTerminalId = new Map()"));
        assert!(html.contains("revision: 0, inFlight: null"));
        assert!(html.contains("function renderInputSurface"));
        assert!(!html.contains("laymux.remote.composerDraft"));

        // A commit is a single structured Remote request. Its captured token,
        // revision and text guard conditional clearing after an async response.
        assert!(html.contains("/input`, {"));
        assert!(html.contains("body: JSON.stringify({ leaseId: activeLeaseId, text, submit })"));
        assert!(html.contains("function commitComposer()"));
        assert!(html.contains("draft.inFlight !== submission"));
        assert!(html.contains("draft.revision === submission.revision"));
        assert!(html.contains("draft.text === submission.text"));

        // Enter follows the layout (ADR-0036): the mobile layout (coarse
        // pointer OR the PC app's embedded mobile view, localApp=1) inserts a
        // newline and sends via the button only, keeping the fragile
        // soft-keyboard Enter off the send path; the desktop layout sends on
        // Enter with Shift+Enter as newline. IME confirmation (isComposing /
        // keyCode 229) never sends, and no keyboard shortcut is hardcoded
        // outside the keybinding system (api-contracts §15.5).
        assert!(html.contains("composerInput.addEventListener(\"compositionstart\""));
        assert!(html.contains("composerInput.addEventListener(\"compositionend\""));
        assert!(html.contains("const mobileLayout = coarsePointer || localAppMode"));
        assert!(html.contains("if (event.key !== \"Enter\" || event.shiftKey) return;"));
        assert!(!html.contains("event.ctrlKey || event.metaKey"));
        assert!(html.contains("if (mobileLayout) return;"));
        assert!(html.contains(
            "if (event.isComposing || composerIsComposing || event.keyCode === 229) return;"
        ));
        assert!(html.contains("composerSendButton.addEventListener(\"click\""));
        assert!(
            html.contains("element.hidden = !placed || (actionId === \"send\" && !composerMode);")
        );
        assert!(html.contains("matchMedia(\"(pointer: coarse)\").matches"));

        // Composer actions stay closed until a valid V1 snapshot header/state +
        // binary frame pair has established the active output attachment.
        assert!(html.contains("header.type !== \"terminal.output\""));
        assert!(html.contains("header.version !== 1"));
        assert!(html.contains("header.phase === \"snapshot\""));
        assert!(html.contains("let outputProtocolFailed = false"));
        assert!(html.contains("outputProtocolFailed = true"));
        assert!(html.contains("outputProtocolFailed ||"));
        assert!(html.contains("composerReady = true"));

        // Direct mode keeps xterm input, while Composer moves focus/caret to the
        // native textarea and hides the inactive xterm application cursor.
        assert!(html.contains("cursorInactiveStyle = \"none\""));
        assert!(html.contains("scheduleTerminalFit();"));
        assert!(html.contains("if (currentInputMode() === \"direct\")"));
    }

    #[test]
    fn remote_page_html_contains_terminal_file_attachments() {
        let html = remote_client_source();

        assert!(html.contains("id=\"attachFile\""));
        assert!(html.contains("id=\"attachmentInput\""));
        assert!(html.contains("accept=\"image/*,text/*,"));
        assert!(html.contains("/attachments`"));
        assert!(html.contains("REMOTE_ATTACHMENT_MAX_BYTES = 1024 * 1024"));
        assert!(html.contains("REMOTE_LONG_TEXT_ATTACHMENT_THRESHOLD_BYTES = 5 * 1024"));
        assert!(html.contains("function attachRemoteFiles(files, options = {})"));
        assert!(html.contains("new File([text], \"pasted-text.txt\""));
        assert!(html.contains("composerInput.addEventListener(\"paste\""));
        assert!(html.contains("snapshot.mode === \"composer\""));
        assert!(html.contains("const insertion = paths.join(\" \");"));
    }

    #[test]
    fn remote_page_html_contains_composer_recall_history_and_autocomplete() {
        let html = remote_client_source();

        // Two floating listboxes over the editor: Tab recall popup (#504) and
        // as-you-type autocomplete (#505). They share one CSS class since only
        // one shows at a time (empty vs non-empty draft).
        assert!(html.contains(
            "id=\"composerHistoryList\" class=\"composer-suggest-list\" role=\"listbox\""
        ));
        assert!(html.contains(
            "id=\"composerAutocompleteList\" class=\"composer-suggest-list\" role=\"listbox\""
        ));
        assert!(html.contains(".composer-suggest-list {"));
        assert!(html.contains(".composer-suggest-item[aria-selected=\"true\"] {"));

        // Pure selection helpers ported from the desktop
        // terminal-input-composer-state.ts (case-insensitive prefix, newest
        // first, de-duped, blank-skipping, exact-query excluded, capped).
        assert!(html.contains("function selectComposerHistoryEntries(history, max"));
        assert!(html.contains("function selectComposerAutocompleteSuggestions("));
        assert!(html.contains("if (!entry || entry === query || seen.has(entry)) continue;"));
        assert!(html.contains("if (!entry.toLowerCase().startsWith(needle)) continue;"));

        // History is a RUNTIME-ONLY Map keyed by scope bucket (ADR-0029
        // non-persistence boundary, ADR-0055 scope key). The sent text must never
        // reach any persistent store — this keeps passwords/secrets typed into a
        // shell from leaking through recall.
        assert!(html.contains("const composerHistoryByScopeKey = new Map();"));
        assert!(html.contains("function readComposerHistory(terminalId = activeTerminalId)"));
        assert!(html.contains("function pushComposerHistory(terminalId, text)"));
        assert!(html.contains("pushComposerHistory(terminalId, submission.text);"));
        assert!(!html.contains("laymux.remote.composerHistory\""));
        assert!(!html.contains("JSON.stringify([...composerHistoryByScopeKey"));

        // ADR-0055: one derivation point for the bucket key, and a "workspace"
        // scope with no resolvable workspace stays pane-local (fail-narrow).
        assert!(html.contains("function composerHistoryBucketKey(terminalId = activeTerminalId)"));
        assert!(html.contains("if (composerHistoryScope === \"global\") return \"global\";"));
        assert!(html.contains("if (workspaceId) return \"ws:\" + workspaceId;"));
        assert!(html.contains("return \"pane:\" + terminalId;"));
        let bucket_start = html
            .find("function composerHistoryBucketKey")
            .expect("bucket key helper must exist");
        let read_start = html.find("function readComposerHistory").unwrap();
        assert!(
            bucket_start < read_start,
            "reads must go through the bucket key helper"
        );
        // Only the scope CHOICE is persisted, and unknown values fall back.
        assert!(html.contains("laymux.remote.composerHistoryScope"));
        assert!(
            html.contains("const COMPOSER_HISTORY_SCOPES = [\"global\", \"workspace\", \"pane\"];")
        );
        assert!(html.contains("const DEFAULT_COMPOSER_HISTORY_SCOPE = \"global\";"));
        assert!(html.contains("let composerHistoryScope = loadComposerHistoryScope();"));
        assert!(html.contains("function saveComposerHistoryScope(scope)"));
        assert!(html.contains("\"composerHistoryScopeSelect\""));

        // The history read/write helpers touch no persistent storage at all.
        let history_region_start = html.find("function readComposerHistory").unwrap();
        let history_region_end = history_region_start
            + html[history_region_start..]
                .find("function selectComposerHistoryEntries")
                .unwrap();
        let history_region = &html[history_region_start..history_region_end];
        assert!(
            !history_region.contains("localStorage"),
            "sent-input history must never touch localStorage"
        );
        assert!(
            !history_region.contains("sessionStorage"),
            "sent-input history must never touch sessionStorage"
        );

        // Only the on/off feature toggles are surface-local persisted state.
        assert!(html.contains("laymux.remote.composerHistoryPopup"));
        assert!(html.contains("laymux.remote.composerAutocomplete"));
        assert!(html.contains("function loadComposerToggle(key)"));
        assert!(html.contains("return localStorage.getItem(key) !== \"0\";"));
        assert!(html.contains("localStorage.setItem(key, enabled ? \"1\" : \"0\");"));
        // Toggles default ON to match the desktop composer (non-destructive).
        assert!(html.contains("loadComposerToggle(composerHistoryPopupKey)"));
        assert!(html.contains("loadComposerToggle(composerAutocompleteKey)"));

        // #504 popup needs an EMPTY draft; #505 autocomplete needs a NON-empty
        // draft — mutually exclusive by construction so they never fight.
        assert!(html.contains("if (!draft || draft.text.length !== 0) return [];"));
        assert!(html.contains("if (!draft || draft.text.length === 0) return [];"));

        // Key ownership: the autocomplete block sits before the Tab-open block so
        // a non-empty draft's Tab accepts a suggestion instead of opening recall.
        let keydown_start = html
            .find("composerInput.addEventListener(\"keydown\"")
            .unwrap();
        let keydown_region = &html[keydown_start..];
        let autocomplete_block = keydown_region
            .find("if (autocompleteVisible && !composing && plainKey) {")
            .unwrap();
        // The Tab-open action (empty draft opens the recall popup) is unique to
        // the third block.
        let tab_open_block = keydown_region.find("composerHistoryOpen = true;").unwrap();
        assert!(
            autocomplete_block < tab_open_block,
            "autocomplete key handling must precede the Tab-open handling"
        );
        // Plain Enter still sends when no suggestion is highlighted (index −1);
        // the original Enter=Send guard remains untouched below the recall logic.
        assert!(html.contains("if (event.key === \"Enter\" && activeAutocompleteIndex >= 0) {"));
        assert!(html.contains("commitComposerHistoryEntry(historyEntries[composerHistoryIndex]);"));

        // Touch path: soft keyboards have no Tab key, so a tap/click on the
        // empty editor can open the same recall popup. The handler must sit
        // OUTSIDE the keydown listener (it is a pointer gesture, not a key).
        let click_block = html
            .find("composerInput.addEventListener(\"click\"")
            .expect("tap-to-open recall handler must exist");
        assert!(
            click_block < keydown_start,
            "tap-to-open handler must not live inside the keydown listener"
        );
        let click_region = &html[click_block..keydown_start];
        assert!(click_region.contains("if (dismissVisibleComposerSuggestions()) return;"));
        assert!(click_region.contains("if (!keyboardWasVisibleBeforeTap) return;"));
        assert!(click_region.contains("if (composerIsComposing) return;"));
        assert!(click_region.contains("const historyEntries = currentComposerHistoryEntries();"));
        assert!(click_region.contains("if (historyEntries.length === 0) return;"));
        assert!(click_region.contains("composerHistoryOpen = true;"));

        // Focus alone is not a soft-keyboard signal. The page tracks a closed
        // VisualViewport baseline per width/orientation and requires a material
        // height loss before tap-to-open recall is armed.
        assert!(html.contains("const SOFT_KEYBOARD_MIN_VIEWPORT_SHRINK_PX = 80;"));
        assert!(html.contains("function remoteSoftKeyboardVisible()"));
        assert!(html.contains("return virtualKeyboardHeight > 0;"));
        assert!(html.contains("remoteViewportClosedHeight - remoteViewportHeight"));
        assert!(html.contains("function dismissVisibleComposerSuggestions()"));
        assert!(html.contains("composerInput.addEventListener(\"pointerdown\", () => {"));
        assert!(html.contains("composerKeyboardVisibleBeforeTap = remoteSoftKeyboardVisible();"));

        // Recall lists reset on terminal switch, mode switch, and after a send.
        assert!(html.contains("function resetComposerSuggestions()"));
        assert!(html.contains("function renderComposerSuggestions()"));

        // Feature toggles live in the existing key-set popover (Remote settings
        // home), accessible and aria-labelled.
        assert!(html.contains("function renderComposerPopoverSection()"));
        assert!(html.contains("title.textContent = \"Composer\";"));
        assert!(html.contains("\"composerHideAgentInputToggle\""));
        assert!(html.contains("\"Hide unused agent input\""));
        assert!(html.contains("function scrollTowardComposerBottom()"));
        assert!(html.contains("composerInput.addEventListener(\"focus\", () => {"));
        assert!(html.contains("hideActiveAgentInputForComposer();"));
        assert!(html.contains("updateComposerOpacityState();"));
        assert!(html.contains("\"composerHistoryPopupToggle\""));
        assert!(html.contains("\"composerAutocompleteToggle\""));
    }

    #[test]
    fn remote_page_mobile_layout_tracks_viewport_without_outer_scroll() {
        let html = remote_client_source();

        // Ask supporting mobile browsers to resize layout content for the native keyboard,
        // then use VisualViewport as the cross-browser source for the actual visible height.
        assert!(html.contains("interactive-widget=resizes-content"));
        assert!(html.contains("height: var(--remote-viewport-height, 100%);"));
        assert!(html.contains("function syncRemoteViewportHeight()"));
        assert!(html.contains("const height = remoteVisualViewport ? remoteVisualViewport.height : window.innerHeight;"));
        assert!(html.contains(
            "remoteVisualViewport?.addEventListener(\"resize\", syncRemoteViewportHeight);"
        ));

        // Horizontal scrolling is confined to the toolbar; its intrinsic width must not
        // enlarge the document.
        assert!(html.contains(".key-bar {\n        position: relative;\n        display: flex;\n        width: 100%;\n        min-width: 0;\n        max-width: 100%;"));
        assert!(html.contains("flex-wrap: nowrap;"));
        assert!(html.contains("overflow-x: auto;"));
        assert!(html.contains("scrollbar-width: none;"));
        assert!(html.contains(".key-row::-webkit-scrollbar {\n        display: none;"));
        assert!(html.contains("--key-bar-control-height: 26px;"));

        // Showing or hiding a grid row changes terminal geometry and must trigger a fit
        // even on WebViews whose ResizeObserver delivery is delayed.
        assert!(html.contains("if (persist) saveKeyBarConfig();\n          scheduleTerminalFit();"));
    }

    /// ADR-0112: colors are authored as `#rrggbb` / `#rrggbbaa`, never as separate
    /// r/g/b channels. `color-mix()` stays banned (html2canvas), so alpha variants
    /// are pre-mixed 8-digit hex — the same form the desktop tokens use.
    #[test]
    fn remote_page_writes_colors_as_color_codes() {
        let offenders: Vec<(usize, String)> = remote_client_source()
            .lines()
            .enumerate()
            .filter(|(_, line)| line.contains("rgb(") || line.contains("rgba("))
            .map(|(i, line)| (i + 1, line.trim().to_string()))
            .collect();
        assert!(offenders.is_empty(), "rgb()/rgba() literals: {offenders:?}");
    }

    #[test]
    fn remote_page_activity_badge_colors_match_desktop() {
        let html = remote_client_source();
        // Palette vars ported from ui/src/index.css so badges match the desktop.
        assert!(html.contains("--claude: #d97757;"));
        assert!(html.contains("--codex: #10a37f;"));
        assert!(html.contains("--orange-15: #d9775726;"));
        // Per-app badge classes with desktop-matching color + background.
        assert!(html.contains(".pane-activity.claude {\n        color: var(--claude);\n        background: var(--orange-15);\n      }"));
        assert!(html.contains(".pane-activity.codex {\n        color: var(--codex);\n        background: var(--accent-12);\n      }"));
        // running badge background matches desktop (--active-bg, not --accent-12).
        assert!(html.contains(".pane-activity.running {\n        color: var(--yellow);\n        background: var(--active-bg);\n      }"));
        // Class selection mirrors formatActivity: Claude/Codex keep brand hue.
        assert!(html.contains("function activityClass(activity)"));
        assert!(html.contains("if (activity.name === \"Claude\") return \"claude\";"));
        assert!(html.contains("if (activity.name === \"Codex\") return \"codex\";"));
        assert!(html.contains("`pane-activity ${activityClass(pane.activity)}`"));
    }

    #[test]
    fn remote_page_gate_requires_enabled_for_tunnel_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let disabled_settings = remote_settings(false, "");
        let disabled = remote_page_gate_for_settings(&disabled_settings, addr, true).unwrap();
        assert_eq!(disabled.status(), axum::http::StatusCode::FORBIDDEN);

        let enabled_settings = remote_settings(true, "");
        assert!(remote_page_gate_for_settings(&enabled_settings, addr, true).is_none());
    }

    #[test]
    fn remote_page_gate_uses_full_base_access_for_direct_requests() {
        let addr = "203.0.113.10:1".parse::<SocketAddr>().unwrap();

        let settings = remote_settings(true, "");
        let response = remote_page_gate_for_settings(&settings, addr, false).unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn remote_page_terminal_notification_focuses_without_prior_workspace_switch() {
        let html = remote_client_source();
        let start = html.find("async function openNotification").unwrap();
        let end = start
            + html[start..]
                .find("async function focusTerminalOnHost")
                .unwrap();
        let open_notification = &html[start..end];

        let terminal_branch = open_notification
            .find("if (notification.terminalId)")
            .unwrap();
        let workspace_branch = open_notification
            .find("if (notification.workspaceId)")
            .unwrap();

        assert!(terminal_branch < workspace_branch);
        assert!(open_notification.contains("await focusTerminalOnHost(notification.terminalId);"));
        assert!(open_notification.contains("await activateWorkspace(notification.workspaceId);"));
    }

    #[test]
    fn remote_page_reconnects_output_socket_without_releasing_lease() {
        let html = remote_client_source();
        let start = html.find("function scheduleOutputReconnect").unwrap();
        let end = start + html[start..].find("async function connect").unwrap();
        let output_stream = &html[start..end];

        assert!(output_stream.contains("const outputLeaseId = leaseId;"));
        assert!(output_stream.contains("stopSocket(!reconnecting);"));
        assert!(output_stream.contains("scheduleOutputReconnect(terminalId, outputLeaseId);"));
        assert!(output_stream.contains("openOutput(terminalId, { reconnect: true });"));
        assert!(output_stream.contains("scheduleTransientConnectionNotice"));
        assert!(output_stream.contains("let resetOnNextPayload = true;"));
        assert!(!output_stream.contains("if (!reconnecting) queueTerminalReset();"));
        assert!(output_stream.contains("if (resetOnNextPayload)"));
        assert!(output_stream.contains("queueTerminalReset();"));
        let resize_before_attach = output_stream
            .find("await resizeTerminal(terminalId, outputLeaseId, attachCols, attachRows);")
            .unwrap();
        let websocket_attach = output_stream
            .find("const outputSocket = createOutputSocket(url);")
            .unwrap();
        assert!(resize_before_attach < websocket_attach);
        assert!(output_stream.contains("queueTerminalGeometry(header.state.geometry);"));
        assert!(output_stream.contains("Number.isSafeInteger(state.geometry.cols)"));
        assert!(html.contains("if (outputAttachGeometryGeneration !== null) return;"));
        assert!(output_stream.contains("if (err.status === 404)"));
        assert!(output_stream.contains("terminalOutputGeneration"));
        assert!(output_stream
            .contains("const focusInputOnOpen = !reconnecting && options.focusInput !== false;"));
        assert!(output_stream.contains("if (focusInputOnOpen) focusInputSurfaceAfterAwait();"));
        assert!(output_stream.contains("renderedTerminalId === terminalId"));
        assert!(output_stream.contains("restoreTerminalViewport(term, preservedViewportDistance);"));
        assert_eq!(
            output_stream
                .matches("focusInputSurfaceAfterAwait();")
                .count(),
            1,
            "snapshot completion must not refocus a dismissed input surface"
        );
        // The attach focus goes through the pointer-gated helper (ADR-0196): a
        // soft-keyboard device leaves the input focus to the first real gesture,
        // so an attach that called the ungated helper would strand DOM focus
        // without an IME and flip the Keyboard button's first tap into a dismiss.
        assert!(
            !output_stream.contains("focusCurrentInputSurface();"),
            "attach must not focus an input surface outside the pointer gate"
        );
        assert!(html.contains(
            "        function focusInputSurfaceAfterAwait() {\n          if (coarsePointer) return;\n          focusCurrentInputSurface();\n        }"
        ));
        assert!(output_stream.contains("let outputTerminalMissing = false;"));
        assert!(output_stream.contains("payload === \"terminal session not found\""));
        assert!(output_stream.contains("loadNavigation(null, { focusInput: false }).catch"));
        assert!(
            !output_stream.contains("loseRemoteControl("),
            "output WebSocket close is recoverable while heartbeat keeps the lease alive"
        );
        let reconnect_scheduler =
            &output_stream[..output_stream.find("function openOutput").unwrap()];
        assert!(
            !reconnect_scheduler.contains("setStatus("),
            "short output interruptions must stay invisible while reconnecting"
        );
    }

    #[test]
    fn remote_page_heartbeat_tolerates_transient_failures_until_timeout() {
        let html = remote_client_source();
        let start = html.find("function handleHeartbeatError").unwrap();
        let end = start + html[start..].find("function startHeartbeat").unwrap();
        let heartbeat_error = &html[start..end];
        let heartbeat_start = html.find("async function heartbeat").unwrap();
        let heartbeat_end = heartbeat_start
            + html[heartbeat_start..]
                .find("function isFatalRemoteControlError")
                .unwrap();
        let heartbeat_request = &html[heartbeat_start..heartbeat_end];
        let start_heartbeat = &html[html.find("function startHeartbeat").unwrap()..];

        assert!(html.contains("error.status = status;"));
        assert!(heartbeat_error.contains("isFatalRemoteControlError(err) || heartbeatTimedOut()"));
        assert!(heartbeat_error.contains("loseRemoteControl(`Control returned to the host."));
        assert!(heartbeat_error.contains("scheduleTransientConnectionNotice(\"heartbeat\")"));
        assert!(heartbeat_error.contains("scheduleHeartbeatRetry()"));
        assert!(heartbeat_request.contains("signal: controller.signal"));
        assert!(heartbeat_request.contains("heartbeatRequestTimeoutMs()"));
        assert!(
            heartbeat_request.contains("setTimeout(() => controller.abort(), requestTimeoutMs)")
        );
        assert!(start_heartbeat.contains("HEARTBEAT_INTERVAL_MAX_MS"));
        assert!(start_heartbeat.contains("Math.min("));
        assert!(!start_heartbeat.contains(
            "loseRemoteControl(\"Control returned to the host. Heartbeat timed out.\");"
        ));
        assert!(start_heartbeat.contains("lastHeartbeatOkAt = Date.now();"));
        assert!(start_heartbeat.contains("handleHeartbeatError(err);"));
    }

    #[test]
    fn remote_page_keeps_dock_navigation_separate_from_workspace_list() {
        let html = remote_client_source();
        let workspace_start = html.find("id=\"workspaceSection\"").unwrap();
        let dock_start = html.find("id=\"dockSection\"").unwrap();
        let script_start = html.find("function renderWorkspaceList").unwrap();
        let script_end = html.find("function renderWorkspaceItem").unwrap();
        let render_workspace_list = &html[script_start..script_end];

        assert!(workspace_start < dock_start);
        assert!(html.contains("function renderDockList(docks)"));
        assert!(html.contains("dockToggleButton.addEventListener"));
        assert!(!render_workspace_list.contains("dockListEl"));
        assert!(!render_workspace_list.contains("renderDockTerminalRow"));
    }

    #[test]
    fn remote_page_mirrors_workspace_last_input_modes_without_old_bottom_summary() {
        let html = remote_client_source();
        let list_start = html.find("function renderWorkspaceList").unwrap();
        let item_start = html.find("function renderWorkspaceItem").unwrap();
        let pane_start = html.find("function renderPaneRow").unwrap();
        let pane_end = html.find("function paneMinimapElement").unwrap();
        let render_list = &html[list_start..item_start];
        let render_item = &html[item_start..pane_start];
        let render_pane = &html[pane_start..pane_end];

        assert!(render_list.contains("workspace.panes || []"));
        assert!(!render_list.contains("workspace.isActive ?"));
        assert!(render_pane.contains("pane.selectorStatus"));
        assert!(render_pane.contains("pane.selectorDisplay"));
        assert!(render_pane.contains("pane-command-status"));
        assert!(render_pane.contains("paneMinimapElement(panes, pane.id)"));
        assert!(render_pane.contains("pane-last-input"));
        assert!(render_pane.contains("selectorDisplay.lastInput"));
        assert!(render_item.contains("workspaceLastInputMode"));
        assert!(render_item.contains("latestWorkspaceInput"));
        assert!(render_item.contains("workspace-last-input"));
        assert!(render_item.contains("workspace.selectorSummary"));
        assert!(!render_item.contains("workspace-status-line"));
        assert!(!render_item.contains("renderWorkspaceStatusLine"));
    }

    #[test]
    fn remote_page_refreshes_variable_selector_state_while_drawer_is_open() {
        let html = remote_client_source();

        assert!(html.contains("const NAVIGATION_VIEW_REFRESH_MS = 2000;"));
        assert!(html.contains("async function refreshNavigationView()"));
        assert!(html.contains("function startNavigationViewPolling()"));
        assert!(html.contains("function stopNavigationViewPolling()"));
        assert!(html.contains("if (open) startNavigationViewPolling();"));
        assert!(html.contains("else stopNavigationViewPolling();"));
    }

    #[test]
    fn remote_page_prefers_only_visible_dock_terminal_fallbacks() {
        let html = remote_client_source();
        let start = html.find("function preferredTerminal").unwrap();
        let end = start + html[start..].find("async function loadNavigation").unwrap();
        let preferred_terminal = &html[start..end];

        assert!(html.contains(
            "function visibleDockItems(data) {\n          return (data.docks || []).filter((dock) => dock.visible !== false);"
        ));
        assert!(preferred_terminal.contains("for (const dock of visibleDockItems(data))"));
        assert!(!preferred_terminal.contains("for (const dock of data.docks || [])"));
        assert!(!preferred_terminal.contains("return terminals[0] || null"));
    }

    #[test]
    fn remote_page_rejects_hidden_dock_preferred_terminal_ids() {
        let html = remote_client_source();
        let start = html.find("function isMainOutputTerminal").unwrap();
        let end = start + html[start..].find("async function loadNavigation").unwrap();
        let main_output_selection = &html[start..end];
        let preferred_start = html.find("function preferredTerminal").unwrap();
        let preferred_end = preferred_start
            + html[preferred_start..]
                .find("async function loadNavigation")
                .unwrap();
        let preferred_terminal = &html[preferred_start..preferred_end];

        assert!(
            main_output_selection.contains("return visibleDockItems(data).some((dock) =>"),
            "main output gate must inspect only visible dock items"
        );
        assert!(
            main_output_selection
                .contains("(dock.panes || []).some((pane) => pane.terminalId === terminalId)"),
            "hidden dock preferred ids must not bypass pane visibility checks"
        );
        assert!(preferred_terminal.contains(
            "if (preferredTerminalId && isMainOutputTerminal(data, preferredTerminalId))"
        ));
        assert!(
            !preferred_terminal.contains("if (preferredTerminalId) {\n            const existing")
        );
    }

    /// Issue #779: a pane the desktop has not opened yet owns no PTY, so its
    /// summary carries `terminalLive: false`. Selection must key off pane
    /// identity and let the attach path open the pane on the host, otherwise
    /// those panes are unreachable and a workspace full of them dead-ends.
    #[test]
    fn remote_page_enters_panes_the_desktop_has_not_opened_yet() {
        let html = remote_client_source();

        assert!(html.contains(
            "function isTerminalPane(pane) {\n          return Boolean(pane && pane.terminalId);\n        }"
        ));
        assert!(
            html.contains("const isTerminal = isTerminalPane(pane);"),
            "workspace and dock rows must treat every terminal pane as enterable"
        );
        assert!(!html.contains("Boolean(pane.terminalId && pane.terminalLive)"));
        assert!(html.contains("async function openTerminalOnHost(terminalId, selectionRevision)"));
        assert!(
            html.contains("if (terminalSessionLive(terminalId)) {\n            openOutput(terminalId, options);"),
            "a live session must attach without waiting on a host open request"
        );
        assert!(
            !html.contains("No open terminal sessions."),
            "a queued pane is opened on entry, so it is never reported as missing"
        );
    }

    #[test]
    fn remote_page_keeps_last_selection_only_in_document_memory() {
        let html = remote_client_source();

        assert!(html.contains("let lastSelectedTerminalId = null;"));
        assert!(html.contains("if (nextId) {\n            lastSelectedTerminalId = nextId;"));
        assert!(html.contains("preferredTerminalId = activeTerminalId || lastSelectedTerminalId"));
        assert!(!html.contains("laymux.remote.lastSelectedTerminalId"));

        // Per-workspace resume hint (issue #508): surface-local map, never
        // persisted, consulted first when re-entering a workspace.
        assert!(html.contains("const lastSelectedTerminalIdByWorkspace = new Map();"));
        assert!(html.contains(
            "if (workspaceId) lastSelectedTerminalIdByWorkspace.set(workspaceId, nextId);"
        ));
        assert!(html.contains(
            "await loadNavigation(lastSelectedTerminalIdByWorkspace.get(workspaceId) || null);"
        ));
        assert!(!html.contains("laymux.remote.lastSelectedTerminalIdByWorkspace"));
    }

    #[test]
    fn remote_page_auto_claims_on_autoconnect_without_local_app_gate() {
        // The cloud dashboard flow serves the page in an external browser (not
        // localApp), so auto-claim must fire on autoConnect=1 alone — otherwise
        // the user has to click Connect a second time to take control.
        let html = remote_client_source();
        assert!(html.contains("if (autoConnectMode && (androidE2eMode || token())) {"));
        assert!(!html.contains("if (localAppMode && autoConnectMode && token())"));
    }

    fn host_headers(host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        headers
    }

    fn page_policy(host: &str) -> String {
        let response =
            secure_page_response(Html("<!doctype html>").into_response(), &host_headers(host));
        response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("the Remote page must carry a CSP")
            .to_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn remote_page_locks_the_document_down_to_its_own_origin() {
        let policy = page_policy("100.64.0.2:19281");
        assert!(policy.contains("default-src 'none'"));
        assert!(policy.contains("script-src 'self'"));
        assert!(policy.contains("object-src 'none'"));
        assert!(policy.contains("base-uri 'none'"));
        assert!(policy.contains("frame-ancestors 'none'"));
        // The manifest and the PWA icons are what make the installed client
        // possible (ADR-0091); blocking them would silently un-install it.
        assert!(policy.contains("manifest-src 'self'"));
        assert!(policy.contains("img-src 'self' data:"));
    }

    #[test]
    fn remote_page_never_allows_inline_or_evaluated_script() {
        let policy = page_policy("100.64.0.2:19281");
        let script_src = policy
            .split("script-src ")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("script-src must be present");
        assert!(!script_src.contains("unsafe-inline"));
        assert!(!script_src.contains("unsafe-eval"));
        // xterm's DOM renderer appends generated <style> elements, so style is
        // the one directive that stays permissive. Keep that explicit.
        assert!(policy.contains("style-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn remote_page_allows_its_own_output_socket() {
        let policy = page_policy("100.64.0.2:19281");
        assert!(policy.contains("connect-src 'self' ws://100.64.0.2:19281 wss://100.64.0.2:19281;"));
    }

    #[test]
    fn remote_page_keeps_a_bracketed_ipv6_host_intact() {
        let policy = page_policy("[::1]:19281");
        assert!(policy.contains("connect-src 'self' ws://[::1]:19281 wss://[::1]:19281;"));
    }

    #[test]
    fn remote_page_drops_websocket_sources_for_a_crafted_host() {
        // Host is client-controlled: a header carrying its own directives must
        // narrow the policy, never widen it.
        for host in [
            "evil.example; script-src *",
            "evil.example ws://evil.example",
            "user@evil.example",
            "evil.example:notaport",
            "evil.example:",
            "'self'",
        ] {
            let policy = page_policy(host);
            assert!(
                policy.contains("connect-src 'self';"),
                "host {host:?} must not reach the policy: {policy}"
            );
            assert!(
                !policy.contains("ws://") && !policy.contains("wss://"),
                "host {host:?} leaked a socket source into {policy}"
            );
        }
    }

    #[test]
    fn remote_page_drops_websocket_sources_without_a_host() {
        let response =
            secure_page_response(Html("<!doctype html>").into_response(), &HeaderMap::new());
        let policy = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(policy.contains("connect-src 'self';"));
    }

    #[test]
    fn remote_page_sends_the_document_hardening_headers() {
        let response = secure_page_response(
            Html("<!doctype html>").into_response(),
            &host_headers("laymux.local"),
        );
        assert_eq!(
            response.headers().get(header::REFERRER_POLICY).unwrap(),
            "no-referrer"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
    }

    #[test]
    fn remote_page_csp_template_carries_the_websocket_placeholder() {
        // ui/e2e/remote-client-assets.ts resolves the same placeholder so the
        // Playwright suite runs under the served policy.
        assert!(REMOTE_PAGE_CSP_TEMPLATE.contains(WS_SOURCES_PLACEHOLDER));
        assert!(!REMOTE_PAGE_CSP_TEMPLATE.trim_end().ends_with(';'));
    }
}
