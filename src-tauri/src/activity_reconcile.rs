//! Periodic activity reconcile (ADR-0135).
//!
//! Activity display is event-driven: the PTY callback resolves each OSC 0/2
//! title and pushes the result to the frontend. That is fast but lossy — the
//! backend can only report a change when a title arrives, and an interactive app
//! parked at its prompt emits nothing. Any pane whose classification was missed
//! (or arrived while the frontend store was empty) therefore stayed wrong until
//! the user typed something, because the only other sync was a single
//! `get_terminal_states` call at mount that deliberately skips panes the store
//! has already classified (ADR-0009).
//!
//! This worker closes that hole from the authoritative side: it re-derives every
//! terminal's activity on a timer, diffs against what it last published, and
//! emits only the panes that changed. The frontend applies those exactly like a
//! live event, so no pull-side "is my value fresher?" race exists.
//!
//! The cadence adapts: fast while activity is changing, backing off while
//! everything holds still. It is also the only thing that crosses the WSL
//! boundary — see [`crate::wsl_liveness`] — so the reconcile cadence is the
//! guest probe cadence.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants::{
    ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL, ACTIVITY_RECONCILE_MAX_INTERVAL,
    ACTIVITY_RECONCILE_MIN_INTERVAL, EVENT_TERMINAL_ACTIVITY_RECONCILED,
};
use crate::state::AppState;
use crate::terminal::TerminalActivity;

/// One pane whose authoritative activity no longer matches what was published.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledActivity {
    pub terminal_id: String,
    pub activity: TerminalActivity,
}

/// Terminals whose activity differs from the last published value.
///
/// Disappeared terminals produce nothing: the frontend removes an instance when
/// its session closes, and emitting about a pane that no longer exists would
/// only invite a store entry to be recreated.
pub fn diff(
    published: &HashMap<String, TerminalActivity>,
    current: &HashMap<String, TerminalActivity>,
) -> Vec<ReconciledActivity> {
    let mut changed: Vec<ReconciledActivity> = current
        .iter()
        .filter(|(terminal_id, activity)| {
            published
                .get(*terminal_id)
                .is_none_or(|previous| previous != *activity)
        })
        .map(|(terminal_id, activity)| ReconciledActivity {
            terminal_id: terminal_id.clone(),
            activity: activity.clone(),
        })
        .collect();
    // Stable order so a burst of changes reads the same way in logs and tests.
    changed.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
    changed
}

/// Next wait after a pass that did (or did not) find something to publish.
///
/// A pane that just changed is likely to change again — an agent going
/// working → idle → working — so a productive pass keeps the fast cadence. A
/// quiet system doubles the wait up to the ceiling, which bounds the steady-state
/// cost of both the detection sweep and the WSL guest probe.
pub fn next_interval(current: Duration, published_changes: bool) -> Duration {
    if published_changes {
        return ACTIVITY_RECONCILE_MIN_INTERVAL;
    }
    (current * 2).min(ACTIVITY_RECONCILE_MAX_INTERVAL)
}

/// Start the reconcile worker. One thread for the whole app.
pub fn start(state: Arc<AppState>, app: AppHandle) {
    std::thread::spawn(move || {
        let mut published: HashMap<String, TerminalActivity> = HashMap::new();
        let mut interval = ACTIVITY_RECONCILE_MIN_INTERVAL;
        let mut last_full_publish = Instant::now();
        loop {
            std::thread::sleep(interval);
            // The diff only sees changes on the *backend* side. The frontend can
            // drift on its own — the title state machine's exit signal hard-
            // overrides an interactive app to shell, for instance — and then no
            // backend change follows, so the diff stays silent forever. Re-publish
            // everything periodically so any drift converges regardless of what
            // caused it. Costs one event; the frontend skips entries that already
            // match, so a matching resync writes nothing.
            if last_full_publish.elapsed() >= ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL {
                published.clear();
                last_full_publish = Instant::now();
            }
            let changed = run_pass(&state, &app, &mut published);
            interval = next_interval(interval, changed);
        }
    });
}

/// One reconcile pass. Returns whether anything was published.
fn run_pass(
    state: &AppState,
    app: &AppHandle,
    published: &mut HashMap<String, TerminalActivity>,
) -> bool {
    // The guest probe is refreshed from here so the sweep below reads a snapshot
    // taken for this pass rather than whatever a previous pass left behind.
    #[cfg(windows)]
    crate::wsl_liveness::refresh(state);

    let current = match crate::activity::detect_all_terminal_states(state) {
        Ok(states) => states
            .into_iter()
            .map(|(terminal_id, info)| (terminal_id, info.activity))
            .collect::<HashMap<_, _>>(),
        Err(error) => {
            // A poisoned ring or registry is not "everything is a shell": drop
            // the pass and keep the last published view untouched.
            tracing::debug!(%error, "activity reconcile pass skipped");
            return false;
        }
    };

    let changed = diff(published, &current);
    // Track the full current view, including panes that vanished, so a pane that
    // closes and reopens with the same id is re-published rather than compared
    // against a verdict about the previous session.
    *published = current;
    if changed.is_empty() {
        return false;
    }
    if let Err(error) = app.emit(EVENT_TERMINAL_ACTIVITY_RECONCILED, &changed) {
        tracing::warn!(%error, "failed to emit reconciled activity");
        // The frontend never saw these, so forget them and let the next pass
        // publish again instead of silently holding a divergent view.
        for entry in &changed {
            published.remove(&entry.terminal_id);
        }
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::WSL_LIVENESS_POSITIVE_MAX_AGE;

    fn shell() -> TerminalActivity {
        TerminalActivity::Shell
    }

    fn claude() -> TerminalActivity {
        TerminalActivity::InteractiveApp {
            name: "Claude".into(),
        }
    }

    fn map(entries: &[(&str, TerminalActivity)]) -> HashMap<String, TerminalActivity> {
        entries
            .iter()
            .map(|(id, activity)| ((*id).to_string(), activity.clone()))
            .collect()
    }

    #[test]
    fn only_changed_panes_are_published() {
        let published = map(&[("t-a", shell()), ("t-b", claude())]);
        let current = map(&[("t-a", claude()), ("t-b", claude())]);
        assert_eq!(
            diff(&published, &current),
            vec![ReconciledActivity {
                terminal_id: "t-a".into(),
                activity: claude(),
            }]
        );
    }

    #[test]
    fn a_pane_with_no_published_value_yet_is_published() {
        let current = map(&[("t-new", claude())]);
        assert_eq!(diff(&HashMap::new(), &current).len(), 1);
    }

    #[test]
    fn interactive_app_name_changes_are_a_change() {
        let published = map(&[("t", claude())]);
        let current = map(&[(
            "t",
            TerminalActivity::InteractiveApp {
                name: "Codex".into(),
            },
        )]);
        assert_eq!(diff(&published, &current).len(), 1);
    }

    #[test]
    fn a_closed_pane_publishes_nothing() {
        let published = map(&[("t-gone", claude())]);
        assert!(diff(&published, &HashMap::new()).is_empty());
    }

    #[test]
    fn a_quiet_system_backs_off_and_a_change_resets_the_cadence() {
        let mut interval = ACTIVITY_RECONCILE_MIN_INTERVAL;
        for _ in 0..10 {
            interval = next_interval(interval, false);
        }
        assert_eq!(interval, ACTIVITY_RECONCILE_MAX_INTERVAL);
        assert_eq!(
            next_interval(interval, true),
            ACTIVITY_RECONCILE_MIN_INTERVAL
        );
    }

    /// The reconcile pass is what refreshes the guest snapshot, so a pane's
    /// positive verdict must still be inside its own window when the next pass
    /// reads it — otherwise an idle WSL agent would lapse back to the heuristics
    /// between passes.
    #[test]
    fn backoff_ceiling_keeps_guest_verdicts_alive_between_passes() {
        assert!(ACTIVITY_RECONCILE_MIN_INTERVAL <= ACTIVITY_RECONCILE_MAX_INTERVAL);
        assert!(ACTIVITY_RECONCILE_MAX_INTERVAL <= WSL_LIVENESS_POSITIVE_MAX_AGE);
    }
}
