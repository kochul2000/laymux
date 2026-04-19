//! MCP Resources for Laymux.
//!
//! See GitHub issue #202. Resources expose read-only, cacheable views of IDE
//! state so MCP clients can subscribe instead of polling `list_*` tools.
//!
//! ## Supported URIs
//! - `workspace://active`         — active workspace + panes + terminal activity
//! - `workspace://list`           — workspace summaries
//! - `profile://list`             — terminal profile list
//! - `terminal://{id}`            — single terminal state
//! - `terminal://{id}/output`     — recent terminal output as plain text
//!
//! ## Subscriptions
//! `resources/subscribe` and `resources/unsubscribe` are accepted and recorded
//! in a shared subscription set. When Tauri events like
//! `EVENT_WORKSPACE_STATE_CHANGED`, `EVENT_TERMINAL_OUTPUT_ACTIVITY`, etc. are
//! emitted, the bridge (see `spawn_resource_event_bridge`) translates them into
//! `notifications/resources/updated` pushed to every MCP peer that subscribed
//! to the affected URI.
//!
//! ## Tool compatibility
//! Tools are kept intact for backward compatibility. Resources are the new
//! recommended path for read-only data.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};

use rmcp::model::{
    Annotated, RawResource, RawResourceTemplate, ReadResourceResult, Resource, ResourceContents,
    ResourceTemplate, ResourceUpdatedNotificationParam,
};
use rmcp::service::{Peer, RoleServer};
use rmcp::ErrorData as McpError;
use serde_json::{json, Value};
use tauri::Listener;
use uuid::Uuid;

use crate::constants::{
    EVENT_CLAUDE_MESSAGE_CHANGED, EVENT_TERMINAL_CWD_CHANGED, EVENT_TERMINAL_OUTPUT_ACTIVITY,
    EVENT_TERMINAL_TITLE_CHANGED, EVENT_WORKSPACE_STATE_CHANGED, MCP_SCHEME_TERMINAL,
    MCP_URI_PROFILE_LIST, MCP_URI_WORKSPACE_ACTIVE, MCP_URI_WORKSPACE_LIST,
};
use crate::lock_ext::MutexExt;

// ── URI parsing ──────────────────────────────────────────────────

/// Parsed MCP resource URI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceUri {
    WorkspaceActive,
    WorkspaceList,
    ProfileList,
    Terminal(String),
    TerminalOutput(String),
}

impl ResourceUri {
    /// Parse a raw URI string. Returns `None` if the URI is not recognised.
    pub fn parse(uri: &str) -> Option<Self> {
        if uri == MCP_URI_WORKSPACE_ACTIVE {
            return Some(Self::WorkspaceActive);
        }
        if uri == MCP_URI_WORKSPACE_LIST {
            return Some(Self::WorkspaceList);
        }
        if uri == MCP_URI_PROFILE_LIST {
            return Some(Self::ProfileList);
        }

        if let Some(rest) = uri.strip_prefix(MCP_SCHEME_TERMINAL) {
            let rest = rest.trim_end_matches('/');
            if rest.is_empty() {
                return None;
            }
            if let Some((id, tail)) = rest.split_once('/') {
                if tail == "output" && !id.is_empty() {
                    return Some(Self::TerminalOutput(id.to_string()));
                }
                return None;
            }
            return Some(Self::Terminal(rest.to_string()));
        }

        None
    }

    /// Return the canonical URI string for this resource.
    pub fn as_string(&self) -> String {
        match self {
            Self::WorkspaceActive => MCP_URI_WORKSPACE_ACTIVE.to_string(),
            Self::WorkspaceList => MCP_URI_WORKSPACE_LIST.to_string(),
            Self::ProfileList => MCP_URI_PROFILE_LIST.to_string(),
            Self::Terminal(id) => format!("{MCP_SCHEME_TERMINAL}{id}"),
            Self::TerminalOutput(id) => format!("{MCP_SCHEME_TERMINAL}{id}/output"),
        }
    }

    /// Construct the URI for a terminal ID. Always yields `terminal://{id}`.
    pub fn for_terminal(id: &str) -> String {
        ResourceUri::Terminal(id.to_string()).as_string()
    }

    /// Construct the URI for terminal output. Always yields `terminal://{id}/output`.
    pub fn for_terminal_output(id: &str) -> String {
        ResourceUri::TerminalOutput(id.to_string()).as_string()
    }
}

// ── Static catalogues ────────────────────────────────────────────

/// Static resources always advertised via `resources/list`.
///
/// Per-terminal resources are advertised dynamically (based on live terminal
/// IDs) via [`dynamic_terminal_resources`], merged into the list at request
/// time.
pub fn static_resources() -> Vec<Resource> {
    vec![
        Annotated::new(
            RawResource::new(MCP_URI_WORKSPACE_ACTIVE, "active-workspace")
                .with_title("Active workspace")
                .with_description(
                    "Currently active workspace with panes, terminal activity, and focused pane.",
                )
                .with_mime_type("application/json"),
            None,
        ),
        Annotated::new(
            RawResource::new(MCP_URI_WORKSPACE_LIST, "workspace-list")
                .with_title("Workspace list")
                .with_description("Summary of all workspaces (id, name, pane count, active flag).")
                .with_mime_type("application/json"),
            None,
        ),
        Annotated::new(
            RawResource::new(MCP_URI_PROFILE_LIST, "profile-list")
                .with_title("Terminal profiles")
                .with_description("Configured and runtime terminal profiles.")
                .with_mime_type("application/json"),
            None,
        ),
    ]
}

/// Resource templates that describe parameterised resource families.
/// Clients use templates to discover the `terminal://{id}` URI shape.
pub fn resource_templates() -> Vec<ResourceTemplate> {
    vec![
        Annotated::new(
            RawResourceTemplate::new(format!("{MCP_SCHEME_TERMINAL}{{terminal_id}}"), "terminal")
                .with_title("Terminal state")
                .with_description(
                    "Single terminal's metadata (profile, cwd, activity, pane position).",
                )
                .with_mime_type("application/json"),
            None,
        ),
        Annotated::new(
            RawResourceTemplate::new(
                format!("{MCP_SCHEME_TERMINAL}{{terminal_id}}/output"),
                "terminal-output",
            )
            .with_title("Terminal output")
            .with_description(
                "Recent terminal output with ANSI escape sequences stripped (text mode).",
            )
            .with_mime_type("text/plain"),
            None,
        ),
    ]
}

// ── Subscription registry ────────────────────────────────────────

/// Tracks which URIs each peer is subscribed to.
///
/// Shared between `McpHandler::subscribe/unsubscribe` and the
/// [`spawn_resource_event_bridge`] Tauri listeners.
#[derive(Default)]
pub struct SubscriptionRegistry {
    /// peer-id → set of URIs this peer subscribed to.
    by_peer: HashMap<PeerId, HashSet<String>>,
    /// peer-id → Peer handle used for outbound notifications.
    peers: HashMap<PeerId, Peer<RoleServer>>,
}

/// Opaque, process-unique identifier for a connected MCP peer.
///
/// A fresh value is minted whenever a client initializes a session; it lives
/// only inside the server process and is not exposed over the wire.
pub type PeerId = String;

impl SubscriptionRegistry {
    pub fn new() -> Arc<StdMutex<Self>> {
        Arc::new(StdMutex::new(Self::default()))
    }

    /// Remember this peer so notifications can target it later.
    pub fn register_peer(&mut self, id: PeerId, peer: Peer<RoleServer>) {
        self.peers.insert(id, peer);
    }

    pub fn unregister_peer(&mut self, id: &PeerId) {
        self.peers.remove(id);
        self.by_peer.remove(id);
    }

    pub fn subscribe(&mut self, peer_id: &PeerId, uri: &str) {
        self.by_peer
            .entry(peer_id.clone())
            .or_default()
            .insert(uri.to_string());
    }

    pub fn unsubscribe(&mut self, peer_id: &PeerId, uri: &str) {
        if let Some(set) = self.by_peer.get_mut(peer_id) {
            set.remove(uri);
        }
    }

    /// Return `(peer_id, peer_handle)` pairs currently subscribed to the URI.
    pub fn subscribers_of(&self, uri: &str) -> Vec<(PeerId, Peer<RoleServer>)> {
        let mut out = Vec::new();
        for (peer_id, set) in &self.by_peer {
            if set.contains(uri) {
                if let Some(peer) = self.peers.get(peer_id) {
                    out.push((peer_id.clone(), peer.clone()));
                }
            }
        }
        out
    }

    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }

    pub fn subscription_count(&self, peer_id: &PeerId) -> usize {
        self.by_peer.get(peer_id).map(|s| s.len()).unwrap_or(0)
    }
}

/// Shared handle type used outside this module.
pub type SharedSubscriptionRegistry = Arc<StdMutex<SubscriptionRegistry>>;

/// Create a fresh, process-unique peer identifier.
pub fn new_peer_id() -> PeerId {
    Uuid::new_v4().to_string()
}

// ── Tauri event → resource updated bridge ────────────────────────

/// Subscribe to the Tauri events that mutate MCP-visible state and translate
/// them into `notifications/resources/updated` pushes.
///
/// Called once at server startup. The listener handles are leaked because
/// they must outlive the entire process.
pub fn spawn_resource_event_bridge(
    app_handle: tauri::AppHandle,
    registry: SharedSubscriptionRegistry,
) {
    // Workspace-level changes invalidate both `workspace://active` and
    // `workspace://list`.
    {
        let registry = registry.clone();
        app_handle.listen(EVENT_WORKSPACE_STATE_CHANGED, move |_evt| {
            notify_uri(&registry, MCP_URI_WORKSPACE_ACTIVE);
            notify_uri(&registry, MCP_URI_WORKSPACE_LIST);
        });
    }

    // CWD / title / claude-message → per-terminal resource update.
    for event in [
        EVENT_TERMINAL_CWD_CHANGED,
        EVENT_TERMINAL_TITLE_CHANGED,
        EVENT_CLAUDE_MESSAGE_CHANGED,
    ] {
        let registry = registry.clone();
        app_handle.listen(event, move |evt| {
            let Some(terminal_id) = terminal_id_from_event(evt.payload()) else {
                return;
            };
            notify_uri(&registry, &ResourceUri::for_terminal(&terminal_id));
            // Title/CWD changes also affect the active workspace summary.
            notify_uri(&registry, MCP_URI_WORKSPACE_ACTIVE);
        });
    }

    // Output activity → only the output resource is marked dirty.
    {
        let registry = registry.clone();
        app_handle.listen(EVENT_TERMINAL_OUTPUT_ACTIVITY, move |evt| {
            let Some(terminal_id) = terminal_id_from_event(evt.payload()) else {
                return;
            };
            notify_uri(&registry, &ResourceUri::for_terminal_output(&terminal_id));
        });
    }
}

/// Extract a `terminalId` / `terminal_id` field from a Tauri event payload.
/// Returns `None` if the payload is not JSON or does not contain the field.
pub fn terminal_id_from_event(payload: &str) -> Option<String> {
    let value: Value = serde_json::from_str(payload).ok()?;
    value
        .get("terminalId")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("terminal_id").and_then(|v| v.as_str()))
        .or_else(|| value.get("id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

/// Fan out a `notifications/resources/updated` to every peer subscribed
/// to `uri`.
fn notify_uri(registry: &SharedSubscriptionRegistry, uri: &str) {
    let targets = match registry.lock_or_err() {
        Ok(g) => g.subscribers_of(uri),
        Err(e) => {
            tracing::warn!(error = %e, "MCP subscription registry poisoned while notifying");
            return;
        }
    };
    if targets.is_empty() {
        return;
    }
    let uri_owned = uri.to_string();
    tokio::spawn(async move {
        for (peer_id, peer) in targets {
            let param = ResourceUpdatedNotificationParam::new(uri_owned.clone());
            if let Err(e) = peer.notify_resource_updated(param).await {
                tracing::debug!(
                    peer_id,
                    uri = %uri_owned,
                    error = %e,
                    "notify_resource_updated failed; peer likely disconnected"
                );
            }
        }
    });
}

// ── Content helpers ──────────────────────────────────────────────

/// Wrap a JSON value in a `text/json` resource contents struct.
pub fn json_contents(uri: &str, value: &Value) -> ResourceContents {
    let text = serde_json::to_string_pretty(value)
        .unwrap_or_else(|e| format!("{{\"error\":\"serialize failed: {e}\"}}"));
    ResourceContents::TextResourceContents {
        uri: uri.to_string(),
        mime_type: Some("application/json".to_string()),
        text,
        meta: None,
    }
}

/// Wrap plain text in resource contents with `text/plain` MIME.
pub fn text_contents(uri: &str, text: impl Into<String>) -> ResourceContents {
    ResourceContents::TextResourceContents {
        uri: uri.to_string(),
        mime_type: Some("text/plain".to_string()),
        text: text.into(),
        meta: None,
    }
}

/// Construct a concrete `Resource` entry for a live terminal ID.
pub fn terminal_resource(terminal_id: &str) -> Resource {
    Annotated::new(
        RawResource::new(
            ResourceUri::for_terminal(terminal_id),
            format!("terminal-{terminal_id}"),
        )
        .with_title(format!("Terminal {terminal_id}"))
        .with_description("Single terminal state (profile, cwd, activity, pane position).")
        .with_mime_type("application/json"),
        None,
    )
}

/// Enumerate terminal IDs from the `AppState` so `resources/list` can expose
/// concrete per-terminal resources in addition to the templates.
pub fn dynamic_terminal_resources(state: &crate::state::AppState) -> Vec<Resource> {
    let Ok(terminals) = state.terminals.lock_or_err() else {
        return Vec::new();
    };
    terminals
        .keys()
        .map(|id| terminal_resource(id))
        .collect::<Vec<_>>()
}

/// Convenience wrapper turning a list of `ResourceContents` into a
/// `ReadResourceResult`, used by the dispatch code in `mcp.rs`.
pub fn read_result(contents: Vec<ResourceContents>) -> ReadResourceResult {
    ReadResourceResult::new(contents)
}

/// Build a `ReadResourceResult` from a single JSON payload + URI.
pub fn read_result_json(uri: &str, value: &Value) -> ReadResourceResult {
    read_result(vec![json_contents(uri, value)])
}

/// Build a `ReadResourceResult` from plain text.
pub fn read_result_text(uri: &str, text: impl Into<String>) -> ReadResourceResult {
    read_result(vec![text_contents(uri, text)])
}

/// Return a `resource not found` McpError in the shape expected by MCP.
pub fn resource_not_found(uri: &str) -> McpError {
    McpError::invalid_params(
        format!("Resource not found: {uri}"),
        Some(json!({ "uri": uri })),
    )
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_workspace_active_uri() {
        assert_eq!(
            ResourceUri::parse("workspace://active"),
            Some(ResourceUri::WorkspaceActive)
        );
    }

    #[test]
    fn parses_workspace_list_uri() {
        assert_eq!(
            ResourceUri::parse("workspace://list"),
            Some(ResourceUri::WorkspaceList)
        );
    }

    #[test]
    fn parses_profile_list_uri() {
        assert_eq!(
            ResourceUri::parse("profile://list"),
            Some(ResourceUri::ProfileList)
        );
    }

    #[test]
    fn parses_terminal_uri() {
        assert_eq!(
            ResourceUri::parse("terminal://abc-123"),
            Some(ResourceUri::Terminal("abc-123".into()))
        );
    }

    #[test]
    fn parses_terminal_output_uri() {
        assert_eq!(
            ResourceUri::parse("terminal://abc-123/output"),
            Some(ResourceUri::TerminalOutput("abc-123".into()))
        );
    }

    #[test]
    fn rejects_unknown_scheme() {
        assert!(ResourceUri::parse("file:///etc/passwd").is_none());
        assert!(ResourceUri::parse("terminal://").is_none());
        assert!(ResourceUri::parse("terminal:///output").is_none());
        assert!(ResourceUri::parse("terminal://id/bogus").is_none());
        assert!(ResourceUri::parse("").is_none());
    }

    #[test]
    fn round_trip_uri_strings() {
        for uri in [
            "workspace://active",
            "workspace://list",
            "profile://list",
            "terminal://t1",
            "terminal://t1/output",
        ] {
            let parsed = ResourceUri::parse(uri).expect(uri);
            assert_eq!(parsed.as_string(), uri);
        }
    }

    #[test]
    fn static_resources_advertise_all_fixed_uris() {
        let uris: Vec<_> = static_resources().into_iter().map(|r| r.raw.uri).collect();
        assert!(uris.iter().any(|u| u == MCP_URI_WORKSPACE_ACTIVE));
        assert!(uris.iter().any(|u| u == MCP_URI_WORKSPACE_LIST));
        assert!(uris.iter().any(|u| u == MCP_URI_PROFILE_LIST));
    }

    #[test]
    fn resource_templates_describe_terminal_family() {
        let templates = resource_templates();
        let uris: Vec<_> = templates.into_iter().map(|t| t.raw.uri_template).collect();
        assert!(uris.iter().any(|u| u.contains("{terminal_id}")));
        assert!(uris
            .iter()
            .any(|u| u.ends_with("{terminal_id}/output") || u.ends_with("{terminal_id}")));
    }

    #[test]
    fn subscription_registry_tracks_peer_subscriptions() {
        let reg = SubscriptionRegistry::new();
        let peer_id: PeerId = new_peer_id();
        {
            let mut g = reg.lock().unwrap();
            // Register without a real Peer — empty subscribers_of result when no
            // Peer handle is registered is acceptable; test the URI set instead.
            g.by_peer.entry(peer_id.clone()).or_default();
            g.subscribe(&peer_id, MCP_URI_WORKSPACE_ACTIVE);
            g.subscribe(&peer_id, "terminal://t1");
            assert_eq!(g.subscription_count(&peer_id), 2);
            g.unsubscribe(&peer_id, "terminal://t1");
            assert_eq!(g.subscription_count(&peer_id), 1);
        }
    }

    #[test]
    fn subscription_registry_unregister_clears_state() {
        let reg = SubscriptionRegistry::new();
        let peer_id: PeerId = new_peer_id();
        {
            let mut g = reg.lock().unwrap();
            g.by_peer.entry(peer_id.clone()).or_default();
            g.subscribe(&peer_id, MCP_URI_WORKSPACE_LIST);
            assert_eq!(g.subscription_count(&peer_id), 1);
            g.unregister_peer(&peer_id);
            assert_eq!(g.subscription_count(&peer_id), 0);
        }
    }

    #[test]
    fn json_contents_wraps_text_with_json_mime() {
        let contents = json_contents("workspace://active", &json!({"a":1}));
        match contents {
            ResourceContents::TextResourceContents {
                mime_type,
                text,
                uri,
                ..
            } => {
                assert_eq!(uri, "workspace://active");
                assert_eq!(mime_type.as_deref(), Some("application/json"));
                assert!(text.contains("\"a\""));
            }
            _ => panic!("expected text contents"),
        }
    }

    #[test]
    fn text_contents_uses_plain_mime() {
        let contents = text_contents("terminal://t1/output", "hello");
        match contents {
            ResourceContents::TextResourceContents {
                mime_type, text, ..
            } => {
                assert_eq!(mime_type.as_deref(), Some("text/plain"));
                assert_eq!(text, "hello");
            }
            _ => panic!("expected text contents"),
        }
    }

    #[test]
    fn terminal_id_from_event_handles_terminal_id_field() {
        let payload = r#"{"terminalId":"pane-1","other":"x"}"#;
        assert_eq!(terminal_id_from_event(payload), Some("pane-1".into()));
    }

    #[test]
    fn terminal_id_from_event_falls_back_to_snake_case_and_id() {
        assert_eq!(
            terminal_id_from_event(r#"{"terminal_id":"pane-2"}"#),
            Some("pane-2".into())
        );
        assert_eq!(
            terminal_id_from_event(r#"{"id":"pane-3"}"#),
            Some("pane-3".into())
        );
    }

    #[test]
    fn terminal_id_from_event_returns_none_for_bad_payload() {
        assert_eq!(terminal_id_from_event("not json"), None);
        assert_eq!(terminal_id_from_event("{}"), None);
    }

    #[test]
    fn for_terminal_helpers_build_canonical_uris() {
        assert_eq!(ResourceUri::for_terminal("abc"), "terminal://abc");
        assert_eq!(
            ResourceUri::for_terminal_output("abc"),
            "terminal://abc/output"
        );
    }

    #[test]
    fn resource_not_found_has_uri_in_data() {
        let err = resource_not_found("terminal://ghost");
        let json = serde_json::to_value(&err).unwrap();
        // McpError is serialized into a JSON-RPC error shape; just assert the
        // URI surfaces somewhere in the payload.
        let rendered = serde_json::to_string(&json).unwrap();
        assert!(rendered.contains("terminal://ghost"));
    }
}
