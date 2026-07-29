use std::sync::Arc;

use crate::terminal_output;

/// Install the sole production PTY-output event path.
///
/// The emitter receives bounded v3 envelopes. Per-read v2 and legacy raw
/// events remain frontend compatibility inputs for old backends and fixtures,
/// but this backend never produces them.
pub(super) fn start_production_terminal_output_delivery(
    session: &Arc<terminal_output::TerminalOutputSession>,
    emitter: Arc<terminal_output::TerminalOutputEnvelopeEmitter>,
    notifier: Arc<terminal_output::TerminalOutputFailStopNotifier>,
) -> Result<(), String> {
    session.start_desktop_output_delivery_with_notifier(emitter, notifier)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{mpsc, Mutex};
    use std::thread;
    use std::time::Duration;

    use crate::constants::{
        EVENT_TERMINAL_OUTPUT_V2_PREFIX, EVENT_TERMINAL_OUTPUT_V3_PREFIX,
        TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES, TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
        TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES, TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS,
        TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES,
    };

    #[test]
    fn production_output_wiring_emits_only_bounded_v3_envelopes_for_many_panes() {
        const PANE_COUNT: usize = 4;
        const BOOTSTRAP_CHUNKS_PER_PANE: usize = 1_000;
        const CHUNK: &[u8] = b"0123456789abcdef";

        let protocol_states = terminal_output::SharedTerminalProtocolStates::default();
        let output_buffers = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, event_rx) = mpsc::channel();
        let mut sessions = Vec::new();

        for pane_index in 0..PANE_COUNT {
            let terminal_id = format!("event-count-{pane_index}");
            let registration = terminal_output::register_terminal_output_session(
                &protocol_states,
                &output_buffers,
                &terminal_id,
            )
            .unwrap();
            let session = registration.session();
            let tx = event_tx.clone();
            start_production_terminal_output_delivery(
                &session,
                Arc::new(
                    move |event: &str,
                          envelope: &terminal_output::TerminalOutputDeltaEnvelopeV3| {
                        tx.send((event.to_string(), envelope.clone())).unwrap();
                        Ok(())
                    },
                ),
                Arc::new(|_| {}),
            )
            .unwrap();
            session
                .begin_desktop_output_bootstrap(TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES)
                .unwrap();
            let session = registration.commit().unwrap();

            for _ in 0..BOOTSTRAP_CHUNKS_PER_PANE {
                session.record_desktop_output(CHUNK).unwrap();
            }
            sessions.push((terminal_id, session));
        }

        thread::sleep(Duration::from_millis(30));
        assert!(
            event_rx.try_recv().is_err(),
            "bootstrap ingress must stay ring-only instead of emitting per-chunk events"
        );

        for (terminal_id, session) in &sessions {
            let attached = terminal_output::attach_desktop_terminal_output(
                &protocol_states,
                terminal_id,
                TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
                TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
            )
            .unwrap();
            assert_eq!(
                attached.attachment.snapshot.len(),
                BOOTSTRAP_CHUNKS_PER_PANE * CHUNK.len()
            );
            session.record_desktop_output(b"hot").unwrap();
        }

        let mut events = Vec::new();
        for _ in 0..PANE_COUNT {
            events.push(event_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        }
        assert!(event_rx.try_recv().is_err());
        assert_eq!(events.len(), PANE_COUNT);
        assert!(
            events.len() < PANE_COUNT * (BOOTSTRAP_CHUNKS_PER_PANE + 1),
            "event cost must follow bounded envelopes, not PTY chunk count"
        );
        for (event, envelope) in &events {
            assert!(event.starts_with(EVENT_TERMINAL_OUTPUT_V3_PREFIX));
            assert!(!event.starts_with(EVENT_TERMINAL_OUTPUT_V2_PREFIX));
            assert!(!event.starts_with("terminal-output-event-count-"));
            assert_eq!(envelope.data, b"hot");
            assert!(envelope.data.len() <= TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES);
            assert!(envelope.delta_ends.len() <= TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS);
            assert!(
                serde_json::to_vec(envelope).unwrap().len()
                    < TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES
            );
        }

        for (terminal_id, session) in sessions {
            terminal_output::retire_terminal_output_session(
                &protocol_states,
                &output_buffers,
                &terminal_id,
                &session,
            )
            .unwrap();
        }
    }
}
