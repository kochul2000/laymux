//! Read-only widget mirror for the remote client (ADR-0123).
//!
//! The desktop owns placement, options and every displayed value, so this route
//! is deliberately thin: it decides whether the surface exists at all and hands
//! the frontend's display models through untouched. Rebuilding the models here
//! would put a second implementation of row selection and failure wording in
//! Rust, which is the drift the ADR exists to prevent.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::automation_server::ServerState;

use super::navigation_routes::frontend_bridge_json;

/// Font size the desktop falls back to, mirrored so a disabled response is still
/// a well-formed payload rather than a special case for the client to parse.
const DEFAULT_WIDGET_FONT_SIZE: u32 = 9;

/// `GET /remote/v1/widgets`.
///
/// Outside the controller lease on purpose: the strip changes nothing on the
/// host, so a browser that is only watching still gets its indicators. The
/// `remote_guard` layer (token, IP, Origin) still applies.
pub(super) async fn remote_widgets(State(server): State<ServerState>) -> Response {
    let settings = crate::settings::load_settings();
    if let Some(payload) = gated_payload(settings.remote.widgets) {
        return Json(payload).into_response();
    }

    match frontend_bridge_json(&server, "query", "widgets", "snapshot", json!({})).await {
        Ok(snapshot) => Json(enabled_payload(snapshot)).into_response(),
        Err(response) => response,
    }
}

/// The answer that needs no frontend round trip, or `None` to go ask.
///
/// The gate is judged on the host rather than in the page: a client that ignored
/// it would otherwise keep polling the frontend bridge for a surface the user
/// turned off.
fn gated_payload(widgets_enabled: bool) -> Option<Value> {
    if widgets_enabled {
        None
    } else {
        Some(disabled_payload())
    }
}

fn disabled_payload() -> Value {
    json!({
        "enabled": false,
        "fontFamily": "",
        "fontSize": DEFAULT_WIDGET_FONT_SIZE,
        "items": [],
    })
}

/// Tag the frontend's snapshot as enabled without rewriting anything in it.
///
/// A non-object answer cannot be tagged, so it is replaced by the disabled shape
/// rather than forwarded: the client's contract is an object with `items`, and
/// half-honouring it would surface as an unexplained blank strip.
fn enabled_payload(snapshot: Value) -> Value {
    let Value::Object(mut map) = snapshot else {
        return disabled_payload();
    };
    map.insert("enabled".into(), Value::Bool(true));
    if !map.contains_key("items") {
        map.insert("items".into(), Value::Array(Vec::new()));
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_answers_a_disabled_surface_without_asking_the_frontend() {
        // `None` is what sends the request on to the bridge, so a flipped
        // condition here would poll the frontend for a surface the user turned
        // off — or hide a surface they turned on.
        assert_eq!(gated_payload(false), Some(disabled_payload()));
        assert_eq!(gated_payload(true), None);
    }

    #[test]
    fn disabled_payload_is_a_well_formed_empty_strip() {
        let payload = disabled_payload();
        assert_eq!(payload["enabled"], json!(false));
        assert_eq!(payload["items"], json!([]));
        assert_eq!(payload["fontSize"], json!(DEFAULT_WIDGET_FONT_SIZE));
    }

    #[test]
    fn enabled_payload_forwards_the_frontend_models_untouched() {
        let payload = enabled_payload(json!({
            "fontFamily": "Cascadia Mono",
            "fontSize": 11,
            "items": [{ "id": "w1", "type": "cwd", "align": "left", "kind": "text", "text": "~/x" }],
        }));

        assert_eq!(payload["enabled"], json!(true));
        assert_eq!(payload["fontFamily"], json!("Cascadia Mono"));
        assert_eq!(payload["fontSize"], json!(11));
        assert_eq!(payload["items"][0]["kind"], json!("text"));
        assert_eq!(payload["items"][0]["text"], json!("~/x"));
    }

    #[test]
    fn a_snapshot_without_items_still_answers_the_client_contract() {
        let payload = enabled_payload(json!({ "fontFamily": "", "fontSize": 9 }));
        assert_eq!(payload["items"], json!([]));
    }

    #[test]
    fn a_non_object_snapshot_degrades_to_the_empty_strip() {
        assert_eq!(enabled_payload(json!("nope"))["enabled"], json!(false));
        assert_eq!(enabled_payload(json!(null))["items"], json!([]));
    }
}
