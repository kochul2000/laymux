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
//! It is the second writer of that field, though, and emission order is not
//! derivation order — so every verdict carries the stamp it was derived under
//! and the frontend ignores anything older (ADR-0136, see
//! [`crate::activity_order`]).
//!
//! It is also the only thing that crosses the WSL boundary — see
//! [`crate::wsl_liveness`] — so the reconcile cadence is the guest probe
//! cadence, and the cadence is fixed rather than adaptive: a guest negative
//! stops being authoritative after `WSL_LIVENESS_AUTHORITATIVE_MAX_AGE`, and
//! detection then falls back to heuristics that an exited agent's still-resident
//! banner can fool.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    /// Taken when the pass snapshotted state, not when it emitted. The PTY
    /// callback stamps its own verdicts from the same counter, so the frontend
    /// can tell which of two activity events was actually derived later — the
    /// emit order does not (`activity_order`).
    pub activity_sequence: u64,
}

/// Terminals whose activity differs from the last published value, or every
/// terminal when `publish_all` is set.
///
/// Disappeared terminals produce nothing: the frontend removes an instance when
/// its session closes, and emitting about a pane that no longer exists would
/// only invite a store entry to be recreated.
pub fn diff(
    published: &HashMap<String, TerminalActivity>,
    current: &HashMap<String, TerminalActivity>,
    publish_all: bool,
    activity_sequence: u64,
) -> Vec<ReconciledActivity> {
    let mut changed: Vec<ReconciledActivity> = current
        .iter()
        .filter(|(terminal_id, activity)| {
            publish_all
                || published
                    .get(*terminal_id)
                    .is_none_or(|previous| previous != *activity)
        })
        .map(|(terminal_id, activity)| ReconciledActivity {
            terminal_id: terminal_id.clone(),
            activity: activity.clone(),
            activity_sequence,
        })
        .collect();
    // Stable order so a burst of changes reads the same way in logs and tests.
    changed.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
    changed
}

/// How long to wait before starting the next pass.
///
/// The cadence is measured pass-start to pass-start, because what has to stay
/// inside `WSL_LIVENESS_AUTHORITATIVE_MAX_AGE` is the gap between two published
/// guest snapshots. Sleeping a fixed interval *after* the pass would add the
/// pass duration to that gap and quietly break the invariant the constants
/// assert. A pass that overran the interval starts the next one immediately
/// rather than trying to catch up.
fn next_pass_delay(pass_duration: Duration) -> Duration {
    ACTIVITY_RECONCILE_INTERVAL.saturating_sub(pass_duration)
}

/// Start the reconcile worker. One thread for the whole app.
pub fn start(state: Arc<AppState>, app: AppHandle) {
    std::thread::spawn(move || {
        let mut published: HashMap<String, TerminalActivity> = HashMap::new();
        let mut last_full_publish = Instant::now();
        let mut delay = ACTIVITY_RECONCILE_INTERVAL;
        loop {
            std::thread::sleep(delay);
            let pass_start = Instant::now();
            // The diff only sees changes on the *backend* side. The frontend can
            // drift on its own — the title state machine's exit signal hard-
            // overrides an interactive app to shell, for instance — and then no
            // backend change follows, so the diff stays silent forever. Re-publish
            // everything periodically so any drift converges regardless of what
            // caused it. Costs one event; the frontend skips entries that already
            // match, so a matching resync writes nothing.
            let publish_all =
                last_full_publish.elapsed() >= ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL;
            if publish_all {
                last_full_publish = pass_start;
            }
            run_pass(&state, &app, &mut published, publish_all);
            delay = next_pass_delay(pass_start.elapsed());
        }
    });
}

/// One reconcile pass.
///
/// `published` is two things at once: the diff baseline, and the only record of
/// what each pane was running last pass — which is what turns "was an app, is
/// not now" into an exit. A full resync therefore changes how much is *emitted*
/// and nothing else; wiping the map instead would hide any exit that first
/// became visible on a resync pass, and the pane would keep its message, grace
/// entry and missing exit marker forever, because the next pass compares against
/// the already-stored `shell`.
fn run_pass(
    state: &AppState,
    app: &AppHandle,
    published: &mut HashMap<String, TerminalActivity>,
    publish_all: bool,
) {
    // The guest probe is refreshed from here so the sweep below reads a snapshot
    // taken for this pass rather than whatever a previous pass left behind.
    #[cfg(windows)]
    crate::wsl_liveness::refresh(state);

    let generations_at_snapshot = pty_generations(state);
    // Read with the generations so an exit verdict can be refused if the pane
    // started a *new session of the same app* before the cleanup runs — the one
    // successor `(terminal, app)` scoping cannot see (ADR-0136 §5).
    let epochs_at_snapshot = crate::activity::detection_epochs(state);
    // Stamped before deriving, so a title resolved while this pass runs is
    // ordered after it — see the module docs of `activity_order`.
    let activity_sequence = crate::activity_order::next_activity_sequence();
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

    // Everything from the final generation read to the emit runs under the
    // terminal catalog lock. Create takes it for its duplicate check and
    // generation reservation, close holds it across every id-keyed cleanup — so
    // holding it here makes "is this still the PTY I derived from?", the exit
    // cleanup and the publish one step that a restart cannot slip into. Without
    // that, a close starting just after the check would race the cleanup into
    // state it had already torn down (ADR-0136 §2).
    //
    // Each helper below takes only higher-numbered locks, so the ordering holds.
    let Ok(mut terminals) = state.terminals.lock_or_err() else {
        tracing::debug!("activity reconcile pass skipped: terminal catalog unavailable");
        return;
    };
    let generations_now = pty_generations(state);
    let superseded = superseded_terminals(&generations_at_snapshot, &generations_now);

    // An app that this worker sees disappear may never have produced a title the
    // PTY state machine could read as an exit — that is the whole reason the
    // worker exists — so it owns the rest of the exit transition too.
    //
    // A pane whose PTY was replaced mid-pass is skipped: the "exit" there is the
    // old session's teardown, which already cleans up after itself, and running
    // the transition would clear the replacement's state instead. A pane with no
    // detection epoch is mid-lifecycle for the same reason.
    for (terminal_id, app_name) in exited_apps(published, &current) {
        if superseded.contains(&terminal_id) {
            continue;
        }
        let Some(epoch) = epochs_at_snapshot.get(&terminal_id).copied() else {
            continue;
        };
        apply_exit_transition(&mut terminals, state, app, &terminal_id, &app_name, epoch);
    }

    let changed = diff(published, &current, publish_all, activity_sequence);
    // Track the full current view, including panes that vanished, so a pane that
    // closes and reopens with the same id is re-published rather than compared
    // against a verdict about the previous session.
    *published = current;

    // Every replaced pane loses its baseline, not just the ones that happened to
    // differ this pass. A restart into the *same* app produces an identical
    // verdict, so it would never enter the diff — and the fresh frontend
    // instance, whose activity starts empty, would then wait out the full resync
    // interval for a value the backend already knows.
    for terminal_id in &superseded {
        published.remove(terminal_id);
    }
    if !superseded.is_empty() {
        tracing::debug!(
            count = superseded.len(),
            "activity reconcile dropped verdicts about replaced PTYs"
        );
    }
    let fresh: Vec<ReconciledActivity> = changed
        .into_iter()
        .filter(|entry| !superseded.contains(&entry.terminal_id))
        .collect();
    if fresh.is_empty() {
        return;
    }
    if let Err(error) = app.emit(EVENT_TERMINAL_ACTIVITY_RECONCILED, &fresh) {
        tracing::warn!(%error, "failed to emit reconciled activity");
        // The frontend never saw these, so forget them and let the next pass
        // publish again instead of silently holding a divergent view.
        for entry in &fresh {
            published.remove(&entry.terminal_id);
        }
    }
    drop(terminals);
}

/// The PTY generation backing each terminal right now. A pane with no handle
/// (never spawned, already torn down) is absent rather than zero, so it compares
/// equal to itself across two reads and unequal to any live generation.
fn pty_generations(state: &AppState) -> HashMap<String, u64> {
    match state.pty_handles.lock_or_err() {
        Ok(handles) => handles
            .iter()
            .map(|(terminal_id, handle)| (terminal_id.clone(), handle.terminal_generation()))
            .collect(),
        // No generations means nothing can be proven stale, so nothing is
        // dropped — the same failure mode as before this check existed.
        Err(error) => {
            tracing::debug!(%error, "activity reconcile could not read PTY generations");
            HashMap::new()
        }
    }
}

/// Panes whose PTY is not the one this pass derived from.
///
/// A pane can be torn down and respawned under the same terminal id (Restart
/// View, profile change) while a pass is walking every terminal. Anything the
/// pass concluded about it describes the session that is gone: publishing it
/// would show the replacement whatever the previous session was running, and
/// keeping it as the diff baseline would compare the next pass against a verdict
/// about a different process.
///
/// Computed over both reads, not over the pass's findings — a restart into the
/// same app is invisible to the diff and still has to invalidate the baseline.
pub fn superseded_terminals(
    at_snapshot: &HashMap<String, u64>,
    now: &HashMap<String, u64>,
) -> HashSet<String> {
    at_snapshot
        .keys()
        .chain(now.keys())
        .filter(|terminal_id| at_snapshot.get(*terminal_id) != now.get(*terminal_id))
        .cloned()
        .collect()
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
///
/// Scoped to the app that exited. `exited_apps` also reports a handover — Codex
/// gives the pane to Claude with no shell in between — and there the successor
/// is already running and has already written its own state. Clearing by
/// terminal alone would take the new session's working flag, status message and
/// grace entry with it, and emit a null message event on top.
///
/// `epoch` is the pane's detection epoch as read with the verdict; a relaunch of
/// the *same* app since then makes this cleanup belong to a session that is no
/// longer there, and the whole transition is skipped.
///
/// Takes the catalog the caller already holds — the pass keeps it across the
/// generation check, these transitions and the emit so a restart cannot land in
/// the middle.
fn apply_exit_transition(
    terminals: &mut HashMap<String, crate::terminal::TerminalSession>,
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    app_name: &str,
    epoch: u64,
) {
    // The shared cleanup owns the epoch check, so it runs first: if it refuses,
    // the session these fields describe is the successor's, not the exited
    // app's.
    if !crate::activity::apply_interactive_app_exit(state, terminal_id, app_name, Some(epoch)) {
        return;
    }
    let mut message_cleared = false;
    // `claude_*` is Claude's alone; on a Codex exit these fields either belong
    // to a Claude session that took the pane over or hold nothing at all.
    if app_name == "Claude" {
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.claude_was_working = false;
            session.claude_last_working_title = None;
            message_cleared = session.claude_message.take().is_some();
        }
    }

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
        WSL_LIVENESS_AUTHORITATIVE_MAX_AGE, WSL_LIVENESS_PASS_BUDGET, WSL_LIVENESS_POSITIVE_MAX_AGE,
    };

    /// Any value; the tests below care about which entries come back, not about
    /// the stamp itself.
    const SEQ: u64 = 42;

    fn generations(entries: &[(&str, u64)]) -> HashMap<String, u64> {
        entries
            .iter()
            .map(|(id, generation)| ((*id).to_string(), *generation))
            .collect()
    }

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
            diff(&published, &current, false, SEQ),
            vec![ReconciledActivity {
                terminal_id: "t-a".into(),
                activity: claude(),
                activity_sequence: SEQ,
            }]
        );
    }

    #[test]
    fn a_pane_with_no_published_value_yet_is_published() {
        let current = map(&[("t-new", claude())]);
        assert_eq!(diff(&HashMap::new(), &current, false, SEQ).len(), 1);
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
        assert_eq!(diff(&published, &current, false, SEQ).len(), 1);
    }

    #[test]
    fn a_closed_pane_publishes_nothing() {
        let published = map(&[("t-gone", claude())]);
        assert!(diff(&published, &HashMap::new(), false, SEQ).is_empty());
    }

    /// The frontend can drift with no backend change behind it, and the diff
    /// cannot see that. The periodic resync republishes matching panes too.
    #[test]
    fn a_full_resync_publishes_panes_the_diff_would_skip() {
        let published = map(&[("t-a", claude()), ("t-b", shell())]);
        let current = published.clone();
        assert!(diff(&published, &current, false, SEQ).is_empty());
        assert_eq!(diff(&published, &current, true, SEQ).len(), 2);
    }

    /// The resync must not double as "forget the previous state". `published` is
    /// also the only record of what each pane was running, so an exit that first
    /// becomes visible on a resync pass has to still be detectable — otherwise
    /// its message, grace entry and exit marker are never cleaned up, and the
    /// next pass sees `shell` on both sides and finds nothing to do.
    #[test]
    fn a_full_resync_still_detects_an_exit_that_happened_this_pass() {
        let published = map(&[("t", claude())]);
        let current = map(&[("t", shell())]);
        assert_eq!(
            exited_apps(&published, &current),
            vec![("t".to_string(), "Claude".to_string())]
        );
        assert_eq!(diff(&published, &current, true, SEQ).len(), 1);
    }

    #[test]
    fn every_entry_carries_the_pass_stamp() {
        let current = map(&[("t", claude())]);
        let published = diff(&HashMap::new(), &current, false, SEQ);
        assert_eq!(published[0].activity_sequence, SEQ);
    }

    /// A pane torn down and respawned mid-pass gets a new PTY generation, and
    /// the verdict in flight describes the session that is gone.
    #[test]
    fn a_replaced_pty_is_superseded() {
        let superseded = superseded_terminals(
            &generations(&[("t-same", 1), ("t-restarted", 1)]),
            &generations(&[("t-same", 1), ("t-restarted", 2)]),
        );
        assert_eq!(superseded, HashSet::from(["t-restarted".to_string()]));
    }

    /// A pane that lost its handle while the pass ran is being torn down; its
    /// verdict is about a PTY that no longer exists either. A pane that gained
    /// one is a session this pass never looked at.
    #[test]
    fn a_pane_whose_pty_appeared_or_vanished_is_superseded() {
        assert_eq!(
            superseded_terminals(&generations(&[("t", 1)]), &generations(&[])),
            HashSet::from(["t".to_string()])
        );
        assert_eq!(
            superseded_terminals(&generations(&[]), &generations(&[("t", 1)])),
            HashSet::from(["t".to_string()])
        );
    }

    /// Restarting into the *same* app produces the same verdict, so the diff
    /// never sees it — but the new frontend instance starts with no activity at
    /// all. Computing this from the pass's findings would leave that pane blank
    /// until the next full resync; computing it from the generations does not.
    #[test]
    fn a_restart_into_the_same_app_is_superseded_even_though_the_diff_is_silent() {
        let published = map(&[("t", claude())]);
        let current = map(&[("t", claude())]);
        assert!(diff(&published, &current, false, SEQ).is_empty());
        assert!(
            superseded_terminals(&generations(&[("t", 1)]), &generations(&[("t", 2)]))
                .contains("t")
        );
    }

    /// Without generations to compare — a poisoned handle table — nothing can be
    /// proven stale, so nothing is dropped.
    #[test]
    fn unknown_generations_supersede_nothing() {
        assert!(superseded_terminals(&generations(&[]), &generations(&[])).is_empty());
        let unchanged = generations(&[("t", 1)]);
        assert!(superseded_terminals(&unchanged, &unchanged).is_empty());
    }

    /// This worker refreshes the guest snapshot, so its cadence decides how
    /// stale that snapshot gets between passes. A guest **negative** expires
    /// sooner than a positive, and once it does, detection falls back to the
    /// title/buffer heuristics — where the exited agent's banner, still resident
    /// in the 16KB window, can re-pin the pane. The gap between two publishes is
    /// one cadence plus one whole pass, and the pass — default-distribution
    /// resolution plus every distribution's probe — is bounded by the pass
    /// budget, not by a single probe timeout.
    #[test]
    fn the_cadence_keeps_guest_verdicts_authoritative_between_passes() {
        assert!(
            ACTIVITY_RECONCILE_INTERVAL + WSL_LIVENESS_PASS_BUDGET
                <= WSL_LIVENESS_AUTHORITATIVE_MAX_AGE
        );
        assert!(WSL_LIVENESS_AUTHORITATIVE_MAX_AGE <= WSL_LIVENESS_POSITIVE_MAX_AGE);
    }

    /// That invariant only holds if the cadence is measured pass-start to
    /// pass-start. A fixed sleep after the pass would add the pass duration to
    /// the gap between two published snapshots.
    #[test]
    fn the_cadence_absorbs_the_time_the_pass_itself_took() {
        assert_eq!(
            next_pass_delay(Duration::from_secs(1)),
            ACTIVITY_RECONCILE_INTERVAL - Duration::from_secs(1)
        );
    }

    /// A pass that overran the interval starts the next one immediately instead
    /// of trying to make up the lost time with a burst of passes.
    #[test]
    fn an_overrunning_pass_does_not_produce_a_negative_delay() {
        assert_eq!(
            next_pass_delay(ACTIVITY_RECONCILE_INTERVAL * 3),
            Duration::ZERO
        );
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
