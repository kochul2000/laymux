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
//! It is also the only thing that crosses the WSL boundary — see
//! [`crate::wsl_liveness`] — so the reconcile cadence is the guest probe
//! cadence, and the cadence is fixed rather than adaptive: a guest negative
//! stops being authoritative after `WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`, and
//! detection then falls back to heuristics that an exited agent's still-resident
//! banner can fool.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants::{
    ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL, ACTIVITY_RECONCILE_INTERVAL,
    EVENT_TERMINAL_ACTIVITY_RECONCILED,
};
use crate::lock_ext::MutexExt;
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

/// Start the reconcile worker. One thread for the whole app.
pub fn start(state: Arc<AppState>, app: AppHandle) {
    std::thread::spawn(move || {
        let mut published: HashMap<String, TerminalActivity> = HashMap::new();
        let mut last_full_publish = Instant::now();
        loop {
            std::thread::sleep(ACTIVITY_RECONCILE_INTERVAL);
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
            run_pass(&state, &app, &mut published);
        }
    });
}

/// One reconcile pass.
fn run_pass(state: &AppState, app: &AppHandle, published: &mut HashMap<String, TerminalActivity>) {
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
            return;
        }
    };

    // An app that this worker sees disappear may never have produced a title the
    // PTY state machine could read as an exit — that is the whole reason the
    // worker exists — so it owns the rest of the exit transition too.
    for (terminal_id, app_name) in exited_apps(published, &current) {
        apply_exit_transition(state, app, &terminal_id, app_name);
    }

    let changed = diff(published, &current);
    // Track the full current view, including panes that vanished, so a pane that
    // closes and reopens with the same id is re-published rather than compared
    // against a verdict about the previous session.
    *published = current;
    if changed.is_empty() {
        return;
    }
    if let Err(error) = app.emit(EVENT_TERMINAL_ACTIVITY_RECONCILED, &changed) {
        tracing::warn!(%error, "failed to emit reconciled activity");
        // The frontend never saw these, so forget them and let the next pass
        // publish again instead of silently holding a divergent view.
        for entry in &changed {
            published.remove(&entry.terminal_id);
        }
    }
}

/// Panes that were running an interactive app and are not running it any more,
/// with the app they were running. A pane that vanished from the sweep is not
/// included: its session is being torn down, which clears this state anyway.
pub fn exited_apps(
    published: &HashMap<String, TerminalActivity>,
    current: &HashMap<String, TerminalActivity>,
) -> Vec<(String, String)> {
    let mut exited: Vec<(String, String)> = published
        .iter()
        .filter_map(|(terminal_id, previous)| {
            let TerminalActivity::InteractiveApp { name } = previous else {
                return None;
            };
            match current.get(terminal_id) {
                Some(TerminalActivity::InteractiveApp { name: still }) if still == name => None,
                Some(_) => Some((terminal_id.clone(), name.clone())),
                None => None,
            }
        })
        .collect();
    exited.sort();
    exited
}

/// Everything the PTY callback's exit branch does besides the activity itself.
///
/// Without this, an app that died quietly leaves its last status message on the
/// pane, keeps its grace-window entry alive so detection can still name it, and
/// leaves no exit marker — so the startup banner still sitting in the 16KB
/// window can re-pin the pane the moment any title arrives (ADR-0135 §4-2).
fn apply_exit_transition(state: &AppState, app: &AppHandle, terminal_id: &str, app_name: String) {
    let mut message_cleared = false;
    if let Ok(mut terminals) = state.terminals.lock_or_err() {
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.claude_was_working = false;
            session.claude_last_working_title = None;
            message_cleared = session.claude_message.take().is_some();
        }
    }
    crate::activity::record_interactive_app_exit(state, terminal_id, &app_name);
    crate::activity::clear_interactive_app_grace_window(state, terminal_id);

    if message_cleared {
        let _ = app.emit(
            crate::constants::EVENT_CLAUDE_MESSAGE_CHANGED,
            serde_json::json!({ "terminalId": terminal_id, "message": None::<String> }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        WSL_LIVENESS_AUTHORITATIVE_MAX_AGE, WSL_LIVENESS_POSITIVE_MAX_AGE,
        WSL_LIVENESS_PROBE_TIMEOUT,
    };

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

    /// This worker refreshes the guest snapshot, so its cadence decides how
    /// stale that snapshot gets between passes. A guest **negative** expires
    /// sooner than a positive, and once it does, detection falls back to the
    /// title/buffer heuristics — where the exited agent's banner, still resident
    /// in the 16KB window, can re-pin the pane. The probe itself can burn up to
    /// its whole timeout before publishing, so that counts against the budget.
    #[test]
    fn the_cadence_keeps_guest_verdicts_authoritative_between_passes() {
        assert!(
            ACTIVITY_RECONCILE_INTERVAL + WSL_LIVENESS_PROBE_TIMEOUT
                <= WSL_LIVENESS_AUTHORITATIVE_MAX_AGE
        );
        assert!(WSL_LIVENESS_AUTHORITATIVE_MAX_AGE <= WSL_LIVENESS_POSITIVE_MAX_AGE);
    }

    #[test]
    fn an_app_that_disappears_is_reported_as_exited() {
        let published = map(&[("t", claude())]);
        let current = map(&[("t", shell())]);
        assert_eq!(
            exited_apps(&published, &current),
            vec![("t".to_string(), "Claude".to_string())]
        );
    }

    #[test]
    fn a_still_running_app_is_not_an_exit() {
        let published = map(&[("t", claude())]);
        let current = map(&[("t", claude())]);
        assert!(exited_apps(&published, &current).is_empty());
    }

    /// Handing a pane from one agent to another is an exit of the first: its
    /// message and grace-window entry must not survive into the second.
    #[test]
    fn a_handover_to_another_agent_still_exits_the_first() {
        let published = map(&[("t", claude())]);
        let current = map(&[(
            "t",
            TerminalActivity::InteractiveApp {
                name: "Codex".into(),
            },
        )]);
        assert_eq!(
            exited_apps(&published, &current),
            vec![("t".to_string(), "Claude".to_string())]
        );
    }

    /// A pane that vanished is being torn down, and teardown already clears this
    /// state — recording an exit for it would only write to a dead session.
    #[test]
    fn a_closed_pane_is_not_reported_as_an_exit() {
        let published = map(&[("t", claude())]);
        assert!(exited_apps(&published, &HashMap::new()).is_empty());
    }
}
