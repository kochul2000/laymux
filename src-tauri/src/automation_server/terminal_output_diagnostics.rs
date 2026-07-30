use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use super::helpers::err_json;
use super::ServerState;

/// Frontend responsiveness vitals, served without touching the frontend.
///
/// The whole point is that this answers while every bridged endpoint is
/// returning `504 Frontend response timeout` (issue #606). Read
/// `lastReportAgeMs` first: a large value means the WebView main thread itself is
/// unavailable, while a small value next to rising `bridge.requestTimeouts` means
/// the thread is alive and the `automation-request` events are queued behind
/// something else.
pub async fn diagnostics_frontend(AxumState(state): AxumState<ServerState>) -> impl IntoResponse {
    frontend_diagnostics_response(
        state.app_state.frontend_health.snapshot(),
        crate::terminal_output::terminal_output_diagnostics(
            &state.app_state.terminal_protocol_states,
        ),
    )
}

fn frontend_diagnostics_response(
    snapshot: Result<serde_json::Value, crate::error::AppError>,
    terminal_output: Result<Vec<crate::terminal_output::TerminalOutputDesktopDiagnostics>, String>,
) -> axum::response::Response {
    match (snapshot, terminal_output) {
        (Ok(mut snapshot), Ok(terminal_output)) => {
            let Some(object) = snapshot.as_object_mut() else {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(err_json("frontend diagnostics snapshot is not an object")),
                )
                    .into_response();
            };
            object.insert(
                "terminalOutput".into(),
                serde_json::to_value(terminal_output).unwrap_or(serde_json::Value::Null),
            );
            Json(snapshot).into_response()
        }
        (Err(error), _) => {
            tracing::error!(error = %error, "failed to read frontend diagnostics state");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json(&error.to_string())),
            )
                .into_response()
        }
        (Ok(_), Err(error)) => {
            tracing::error!(%error, "failed to read terminal output diagnostics state");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(err_json(&error))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frontend_diagnostics_maps_snapshot_failure_to_json_500() {
        let response = frontend_diagnostics_response(
            Err(crate::error::AppError::Lock("frontend health".into())),
            Ok(Vec::new()),
        );

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["success"], false);
        assert!(json["error"].as_str().unwrap().contains("Lock poisoned"));
    }

    #[tokio::test]
    async fn frontend_diagnostics_includes_payload_free_backend_terminal_output() {
        let terminal = crate::terminal_output::TerminalOutputDesktopDiagnostics {
            terminal_id: "t1".into(),
            generation: 7,
            desktop_output_state: "backpressured".into(),
            reason: None,
            reason_detail: None,
            lease_token: Some("lease".into()),
            parsed_ack: Some(10),
            write_seq: 12,
            ring_start_seq: 0,
            ring_end_seq: 12,
            delivery_observed_seq: 12,
            pending_delivery_bytes: 2,
            active_grant_id: None,
            receipt_slot: None,
        };
        let response = frontend_diagnostics_response(
            Ok(serde_json::json!({ "frontend": null })),
            Ok(vec![terminal]),
        );
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["terminalOutput"][0]["terminalId"], "t1");
        assert_eq!(json["terminalOutput"][0]["writeSeq"], 12);
        assert!(json["terminalOutput"][0].get("data").is_none());
        // `reason` collapses distinct faults onto one code, so the detail has to
        // survive serialization or a fail-stop cause is unrecoverable in the field.
        assert!(json["terminalOutput"][0].get("reasonDetail").is_some());
    }

    #[tokio::test]
    async fn frontend_diagnostics_isolates_one_unavailable_terminal() {
        let unavailable = crate::terminal_output::TerminalOutputDesktopDiagnostics {
            terminal_id: "broken".into(),
            generation: 3,
            desktop_output_state: "failStopped".into(),
            reason: Some("surface_unavailable".into()),
            reason_detail: Some("terminal output session lock poisoned".into()),
            lease_token: None,
            parsed_ack: None,
            write_seq: 0,
            ring_start_seq: 0,
            ring_end_seq: 0,
            delivery_observed_seq: 0,
            pending_delivery_bytes: 0,
            active_grant_id: None,
            receipt_slot: None,
        };
        let healthy = crate::terminal_output::TerminalOutputDesktopDiagnostics {
            terminal_id: "healthy".into(),
            generation: 4,
            desktop_output_state: "healthy".into(),
            reason: None,
            reason_detail: None,
            lease_token: Some("lease".into()),
            parsed_ack: Some(9),
            write_seq: 9,
            ring_start_seq: 0,
            ring_end_seq: 9,
            delivery_observed_seq: 9,
            pending_delivery_bytes: 0,
            active_grant_id: None,
            receipt_slot: None,
        };
        let response = frontend_diagnostics_response(
            Ok(serde_json::json!({
                "bridge": { "requestsEmitted": 17 },
                "frontend": { "probeLagMs": 4 }
            })),
            Ok(vec![unavailable, healthy]),
        );

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["bridge"]["requestsEmitted"], 17);
        assert_eq!(json["frontend"]["probeLagMs"], 4);
        assert_eq!(json["terminalOutput"][0]["terminalId"], "broken");
        assert_eq!(json["terminalOutput"][0]["reason"], "surface_unavailable");
        assert_eq!(
            json["terminalOutput"][0]["reasonDetail"],
            "terminal output session lock poisoned"
        );
        assert_eq!(json["terminalOutput"][1]["terminalId"], "healthy");
        assert!(json["terminalOutput"][0].get("data").is_none());
        assert!(json["terminalOutput"][0].get("path").is_none());
    }
}
