use std::collections::HashMap;
use std::sync::atomic::Ordering;

use crate::lock_ext::MutexExt;
use crate::state::AppState;

/// Called AFTER emission. A pass which read before this publication leaves the
/// correction pending; a pass which read after it takes a newer activity stamp.
pub fn record_observation(state: &AppState, terminal_id: &str, sequence: u64) {
    if let Ok(callbacks) = state.pty_callback_states.lock_or_err() {
        if let Some(callback) = callbacks.get(terminal_id) {
            callback.record_observation(sequence);
        }
    }
}

pub fn observation_sequences(state: &AppState) -> HashMap<String, u64> {
    state
        .pty_callback_states
        .lock_or_err()
        .map(|callbacks| {
            callbacks
                .iter()
                .map(|(id, callback)| {
                    (
                        id.clone(),
                        callback
                            .activity_observation_sequence
                            .load(Ordering::Acquire),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::PtyCallbackState;
    use std::sync::Arc;

    #[test]
    fn observations_are_monotonic_and_do_not_cross_callback_replacement() {
        let state = AppState::new();
        let old = Arc::new(PtyCallbackState::new(0, 0, 0, 0, 0));
        state
            .pty_callback_states
            .lock()
            .unwrap()
            .insert("pane".into(), old.clone());
        record_observation(&state, "pane", 20);
        record_observation(&state, "pane", 10);
        assert_eq!(observation_sequences(&state)["pane"], 20);
        let replacement = Arc::new(PtyCallbackState::new(0, 0, 0, 0, 0));
        state
            .pty_callback_states
            .lock()
            .unwrap()
            .insert("pane".into(), replacement);
        old.record_observation(30);
        assert_eq!(observation_sequences(&state)["pane"], 0);
        record_observation(&state, "pane", 40);
        assert_eq!(observation_sequences(&state)["pane"], 40);
    }
}
