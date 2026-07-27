use axum::Json;
use serde_json::{json, Value};
use std::fmt;

use crate::automation_server::helpers::bridge_request;
use crate::automation_server::ServerState;
use crate::constants::REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES;
use crate::terminal_output::{self, TerminalOutputSubscribedAttachment, TerminalRenderCheckpoint};

const ATTACH_RETRY_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RenderCheckpointAttachErrorKind {
    NotFound,
    Retryable,
    Fatal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderCheckpointAttachError {
    kind: RenderCheckpointAttachErrorKind,
    message: String,
}

impl RenderCheckpointAttachError {
    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            kind: RenderCheckpointAttachErrorKind::NotFound,
            message: message.into(),
        }
    }

    pub(crate) fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: RenderCheckpointAttachErrorKind::Retryable,
            message: message.into(),
        }
    }

    pub(crate) fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: RenderCheckpointAttachErrorKind::Fatal,
            message: message.into(),
        }
    }

    pub(crate) fn kind(&self) -> RenderCheckpointAttachErrorKind {
        self.kind
    }
}

impl fmt::Display for RenderCheckpointAttachError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RenderCheckpointAttachError {}

fn classify_session_error(error: String) -> RenderCheckpointAttachError {
    if error.contains("not found") {
        RenderCheckpointAttachError::not_found(error)
    } else {
        RenderCheckpointAttachError::retryable(error)
    }
}

fn classify_frontend_checkpoint_error(message: String) -> RenderCheckpointAttachError {
    if message.contains("absolute size limit")
        || message.contains("Invalid terminal render checkpoint request")
    {
        RenderCheckpointAttachError::fatal(message)
    } else {
        RenderCheckpointAttachError::retryable(message)
    }
}

/// Ask the rendererless desktop xterm for a reconstructable screen and bind it
/// atomically to the raw suffix/subscriber boundary of the same generation.
pub(crate) async fn attach_and_subscribe_render_checkpoint(
    server: &ServerState,
    terminal_id: &str,
    max_checkpoint_bytes: usize,
) -> Result<TerminalOutputSubscribedAttachment, RenderCheckpointAttachError> {
    let mut last_race = None;
    for _ in 0..ATTACH_RETRY_LIMIT {
        let target = terminal_output::terminal_render_checkpoint_target(
            &server.app_state.terminal_protocol_states,
            terminal_id,
        )
        .map_err(classify_session_error)?;
        let response = bridge_request(
            server,
            "query",
            "terminals",
            "renderCheckpoint",
            json!({
                "id": terminal_id,
                "target": target,
                "maxBytes": max_checkpoint_bytes,
            }),
        )
        .await
        .map_err(|error| RenderCheckpointAttachError::retryable(bridge_error_message(error)))?;
        let checkpoint = parse_checkpoint_response(response)?;

        match terminal_output::attach_and_subscribe_terminal_output_from_render_checkpoint(
            &server.app_state.terminal_protocol_states,
            terminal_id,
            checkpoint,
        ) {
            Ok(subscribed) => return Ok(subscribed),
            Err(error)
                if error.contains("generation changed")
                    || error.contains("geometry changed")
                    || error.contains("fell behind the output ring") =>
            {
                last_race = Some(error);
            }
            Err(error) => return Err(classify_session_error(error)),
        }
    }

    Err(RenderCheckpointAttachError::retryable(format!(
        "terminal render checkpoint could not stabilize: {}",
        last_race.unwrap_or_else(|| "unknown attach race".into())
    )))
}

fn parse_checkpoint_response(
    response: Value,
) -> Result<TerminalRenderCheckpoint, RenderCheckpointAttachError> {
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(classify_frontend_checkpoint_error(
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("terminal render checkpoint failed")
                .to_string(),
        ));
    }
    let checkpoint: TerminalRenderCheckpoint =
        serde_json::from_value(response).map_err(|error| {
            RenderCheckpointAttachError::fatal(format!(
                "invalid terminal render checkpoint: {error}"
            ))
        })?;
    if checkpoint.data.len() > REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES {
        return Err(RenderCheckpointAttachError::fatal(
            "terminal render checkpoint exceeds the absolute size limit",
        ));
    }
    Ok(checkpoint)
}

fn bridge_error_message(error: (axum::http::StatusCode, Json<Value>)) -> String {
    let (status, Json(body)) = error;
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("frontend bridge request failed");
    format!("frontend bridge {status}: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_strict_frontend_checkpoint_response() {
        let checkpoint = parse_checkpoint_response(json!({
            "generation": 3,
            "seq": 99,
            "geometry": { "revision": 2, "cols": 100, "rows": 30 },
            "data": "screen",
        }))
        .unwrap();

        assert_eq!(checkpoint.generation, 3);
        assert_eq!(checkpoint.seq, 99);
        assert_eq!(checkpoint.geometry.cols, 100);
    }

    #[test]
    fn rejects_frontend_errors_and_oversized_checkpoints() {
        assert_eq!(
            parse_checkpoint_response(json!({ "success": false, "error": "not ready" }))
                .unwrap_err(),
            RenderCheckpointAttachError::retryable("not ready")
        );
        let error = parse_checkpoint_response(json!({
            "generation": 3,
            "seq": 99,
            "geometry": { "revision": 2, "cols": 100, "rows": 30 },
            "data": "x".repeat(REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES + 1),
        }))
        .unwrap_err();
        assert!(error.to_string().contains("absolute size limit"));
        assert_eq!(error.kind(), RenderCheckpointAttachErrorKind::Fatal);
        assert_eq!(
            parse_checkpoint_response(json!({
                "success": false,
                "error": "Terminal render checkpoint error: terminal render checkpoint exceeds the absolute size limit"
            }))
            .unwrap_err()
            .kind(),
            RenderCheckpointAttachErrorKind::Fatal
        );
    }

    #[test]
    fn classifies_session_and_bridge_failures_for_transport_retry() {
        assert_eq!(
            classify_session_error("Session 'gone' not found".into()).kind(),
            RenderCheckpointAttachErrorKind::NotFound
        );
        assert_eq!(
            classify_session_error("Session 'new' is still being created".into()).kind(),
            RenderCheckpointAttachErrorKind::Retryable
        );
    }
}
