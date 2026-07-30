use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::constants::{
    TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES, TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
};
use crate::state::AppState;
use crate::terminal_output;

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AttachTerminalOutputResponse {
    Attached(terminal_output::DesktopTerminalOutputAttachment),
    FailStopped(TerminalOutputFailStoppedAttachResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFailStoppedAttachResponse {
    kind: &'static str,
    terminal_id: String,
    generation: u64,
    reason: String,
}

fn attach_terminal_output_response(
    protocol_states: &terminal_output::SharedTerminalProtocolStates,
    id: &str,
) -> Result<AttachTerminalOutputResponse, String> {
    terminal_output::attach_desktop_terminal_output_outcome(
        protocol_states,
        id,
        TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
        TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
    )
    .map(|outcome| match outcome {
        terminal_output::DesktopTerminalOutputAttachOutcome::Attached(attachment) => {
            AttachTerminalOutputResponse::Attached(attachment)
        }
        terminal_output::DesktopTerminalOutputAttachOutcome::FailStopped {
            terminal_id,
            generation,
            reason,
        } => AttachTerminalOutputResponse::FailStopped(TerminalOutputFailStoppedAttachResponse {
            kind: "failStopped",
            terminal_id,
            generation,
            reason,
        }),
    })
}

#[tauri::command]
pub fn attach_terminal_output(
    id: String,
    state: State<Arc<AppState>>,
) -> Result<AttachTerminalOutputResponse, String> {
    attach_terminal_output_response(&state.terminal_protocol_states, &id)
}

#[tauri::command]
pub fn acknowledge_terminal_output_envelope(
    id: String,
    generation: u64,
    token: String,
    envelope_id: u64,
    grant_id: Option<String>,
    seq_end: u64,
    state: State<Arc<AppState>>,
) -> Result<bool, String> {
    terminal_output::acknowledge_desktop_terminal_output_envelope(
        &state.terminal_protocol_states,
        &id,
        &terminal_output::TerminalOutputEnvelopeIdentity {
            generation,
            lease_token: token,
            envelope_id,
            grant_id,
        },
        seq_end,
    )
}

#[tauri::command]
pub fn repair_terminal_output_envelope(
    id: String,
    generation: u64,
    token: String,
    envelope_id: u64,
    grant_id: Option<String>,
    seq_start: u64,
    state: State<Arc<AppState>>,
) -> Result<terminal_output::TerminalOutputEnvelopeRepairResponse, String> {
    terminal_output::repair_desktop_terminal_output_envelope(
        &state.terminal_protocol_states,
        &id,
        &terminal_output::TerminalOutputEnvelopeIdentity {
            generation,
            lease_token: token,
            envelope_id,
            grant_id,
        },
        seq_start,
    )
}

#[tauri::command]
pub fn hold_terminal_output_continuation(
    id: String,
    generation: u64,
    token: String,
    envelope_id: u64,
    grant_id: String,
    frame_start_seq: u64,
    state: State<Arc<AppState>>,
) -> Result<bool, String> {
    terminal_output::hold_desktop_terminal_output_continuation(
        &state.terminal_protocol_states,
        &id,
        generation,
        &token,
        envelope_id,
        &grant_id,
        frame_start_seq,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn close_terminal_output_continuation(
    id: String,
    generation: u64,
    token: String,
    envelope_id: u64,
    grant_id: String,
    close_seq: u64,
    reason: String,
    state: State<Arc<AppState>>,
) -> Result<bool, String> {
    terminal_output::close_desktop_terminal_output_continuation(
        &state.terminal_protocol_states,
        &id,
        generation,
        &token,
        envelope_id,
        &grant_id,
        close_seq,
        &reason,
    )
}

#[tauri::command]
pub fn fail_stop_terminal_output_surface(
    id: String,
    generation: u64,
    token: String,
    reason: String,
    state: State<Arc<AppState>>,
) -> Result<bool, String> {
    terminal_output::fail_stop_desktop_terminal_output_surface(
        &state.terminal_protocol_states,
        &id,
        generation,
        &token,
        &reason,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::output_buffer::TerminalOutputBuffer;

    struct Fixture {
        states: terminal_output::SharedTerminalProtocolStates,
        buffers: Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
        session: Arc<terminal_output::TerminalOutputSession>,
    }

    fn live_session(id: &str) -> Fixture {
        let states = terminal_output::SharedTerminalProtocolStates::default();
        let buffers = Arc::new(Mutex::new(HashMap::new()));
        let registration =
            terminal_output::register_terminal_output_session(&states, &buffers, id).unwrap();
        let session = registration.commit().unwrap();
        session
            .start_desktop_output_delivery(Arc::new(|_, _| Ok(())))
            .unwrap();
        session
            .begin_desktop_output_bootstrap(TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES)
            .unwrap();
        Fixture {
            states,
            buffers,
            session,
        }
    }

    #[test]
    fn successful_attach_keeps_the_existing_attachment_wire_shape() {
        let response_fixture = live_session("response");
        let response = serde_json::to_value(
            attach_terminal_output_response(&response_fixture.states, "response").unwrap(),
        )
        .unwrap();

        let legacy_fixture = live_session("legacy");
        let legacy = serde_json::to_value(
            terminal_output::attach_desktop_terminal_output(
                &legacy_fixture.states,
                "legacy",
                TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
                TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(response, legacy);
        assert!(response.get("kind").is_none());

        terminal_output::retire_terminal_output_session(
            &response_fixture.states,
            &response_fixture.buffers,
            "response",
            &response_fixture.session,
        )
        .unwrap();
        terminal_output::retire_terminal_output_session(
            &legacy_fixture.states,
            &legacy_fixture.buffers,
            "legacy",
            &legacy_fixture.session,
        )
        .unwrap();
    }

    #[test]
    fn fail_stopped_attach_is_resolved_without_payload_bytes_or_paths() {
        let fixture = live_session("failed");
        let first = attach_terminal_output_response(&fixture.states, "failed").unwrap();
        let AttachTerminalOutputResponse::Attached(first) = first else {
            panic!("initial attach must succeed");
        };
        assert!(fixture
            .session
            .fail_stop_desktop_surface(
                fixture.session.generation(),
                &first.flow_control.token,
                "surface_unavailable",
            )
            .unwrap());

        let response = serde_json::to_value(
            attach_terminal_output_response(&fixture.states, "failed").unwrap(),
        )
        .unwrap();
        assert_eq!(
            response,
            serde_json::json!({
                "kind": "failStopped",
                "terminalId": "failed",
                "generation": fixture.session.generation(),
                "reason": "surface_unavailable",
            })
        );
        assert!(response.get("data").is_none());
        assert!(response.get("snapshot").is_none());
        assert!(response.get("path").is_none());

        terminal_output::retire_terminal_output_session(
            &fixture.states,
            &fixture.buffers,
            "failed",
            &fixture.session,
        )
        .unwrap();
    }
}
