//! Targeted activity reconciliation (ADR-0362), retaining ADR-0136 ordering.
//! A metadata wakeup coalesces lifecycle/entry requests. Only selected domains
//! receive OS/guest observations; healthy verified hooks skip slow fallback.
//! Failed observations preserve the last agent and pending correction revision.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::constants::{ACTIVITY_RECONCILE_INTERVAL, EVENT_TERMINAL_ACTIVITY_RECONCILED};
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::TerminalActivity;

pub(crate) mod metrics;
mod uncertain;

/// A leaf queue: requests are cloned/drained before any application lock or I/O.
#[derive(Default)]
pub struct Demand(std::sync::Mutex<HashSet<String>>);

impl Demand {
    pub fn request(&self, ids: impl IntoIterator<Item = String>) {
        if let Ok(mut pending) = self.0.lock_or_err() {
            pending.extend(ids);
        }
    }
    fn take(&self) -> HashSet<String> {
        self.0
            .lock_or_err()
            .map(|mut p| std::mem::take(&mut *p))
            .unwrap_or_default()
    }
}

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

/// Terminals whose activity differs from the last published value.
///
/// Disappeared terminals produce nothing: the frontend removes an instance when
/// its session closes, and emitting about a pane that no longer exists would
/// only invite a store entry to be recreated.
#[cfg(test)]
pub fn diff(
    published: &HashMap<String, TerminalActivity>,
    current: &HashMap<String, TerminalActivity>,
    activity_sequence: u64,
) -> Vec<ReconciledActivity> {
    diff_observed(
        published,
        current,
        &HashMap::new(),
        &HashMap::new(),
        activity_sequence,
    )
}

fn diff_observed(
    published: &HashMap<String, TerminalActivity>,
    current: &HashMap<String, TerminalActivity>,
    previous_observations: &HashMap<String, u64>,
    observations: &HashMap<String, u64>,
    activity_sequence: u64,
) -> Vec<ReconciledActivity> {
    let mut changed: Vec<ReconciledActivity> = current
        .iter()
        .filter(|(terminal_id, activity)| {
            observations.get(*terminal_id).is_some_and(|revision| {
                *revision
                    > previous_observations
                        .get(*terminal_id)
                        .copied()
                        .unwrap_or(0)
            }) || published
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

fn diff_requested(
    published: &HashMap<String, TerminalActivity>,
    current: &HashMap<String, TerminalActivity>,
    previous_observations: &HashMap<String, u64>,
    observations: &HashMap<String, u64>,
    requested: &HashSet<String>,
    sequence: u64,
) -> Vec<ReconciledActivity> {
    let mut changed = diff_observed(
        published,
        current,
        previous_observations,
        observations,
        sequence,
    );
    for id in requested {
        if !changed.iter().any(|entry| &entry.terminal_id == id) {
            if let Some(activity) = current.get(id) {
                changed.push(ReconciledActivity {
                    terminal_id: id.clone(),
                    activity: activity.clone(),
                    activity_sequence: sequence,
                });
            }
        }
    }
    changed.sort_by(|a, b| a.terminal_id.cmp(&b.terminal_id));
    changed
}

/// Always leave an idle metadata interval, including after an overrun.
fn next_pass_delay(_pass_duration: Duration) -> Duration {
    ACTIVITY_RECONCILE_INTERVAL
}

/// Start the reconcile worker. One thread for the whole app.
pub fn start(state: Arc<AppState>, app: AppHandle) {
    std::thread::spawn(move || {
        let mut published: HashMap<String, TerminalActivity> = HashMap::new();
        let mut published_generations = HashMap::new();
        let mut published_observations = HashMap::new();
        let mut delay = ACTIVITY_RECONCILE_INTERVAL;
        let started = Instant::now();
        let mut schedule = schedule::Schedule::default();
        loop {
            std::thread::sleep(delay);
            let pass_start = Instant::now();
            let targets = targets(&state);
            let work = schedule.plan(
                started.elapsed().as_millis() as u64,
                &targets,
                &state.activity_reconcile.take(),
            );
            if work.inspect.is_empty() {
                continue;
            }
            run_pass(
                &state,
                &work,
                &app,
                &mut published,
                &mut published_generations,
                &mut published_observations,
            );
            delay = next_pass_delay(pass_start.elapsed());
        }
    });
}

/// One reconcile pass.
///
/// `published` is two things at once: the diff baseline, and the only record of
/// what each pane was running last pass — which is what turns "was an app, is
/// not now" into an exit. Keep it across passes until replacement/teardown.
fn run_pass(
    state: &AppState,
    work: &schedule::Work,
    app: &AppHandle,
    published: &mut HashMap<String, TerminalActivity>,
    published_generations: &mut HashMap<String, u64>,
    published_observations: &mut HashMap<String, u64>,
) {
    // The guest probe is refreshed from here so the sweep below reads a snapshot
    // taken for this pass rather than whatever a previous pass left behind.
    metrics::pass(&work.probe);
    crate::commands::suspend(state, &work.probe);
    #[cfg(windows)]
    crate::wsl_liveness::refresh_selected(state, &work.probe);
    if !work.probe.is_empty() {
        let observation = crate::wsl_probe::snapshot::GuestObservation::starting_now();
        // Prime display ownership/diagnostics once. Read-only record subscribers
        // cannot create a process observation of their own.
        match crate::commands::get_terminal_session_attributions_scoped(
            None,
            None,
            None,
            state,
            observation,
            Some(&work.probe),
        ) {
            Ok(_) => {
                if let Err(error) =
                    crate::commands::refresh_agent_hook_states(state, &work.probe, observation)
                {
                    tracing::debug!(%error, "targeted hook ownership verification failed");
                }
            }
            Err(error) => tracing::debug!(%error, "targeted ownership observation failed"),
        }
    }

    // Session attribution and the OSC oracle have separate caches. A fresh
    // session read must not be followed by a pre-launch cached negative here.
    let native = state.pty_handles.lock_or_err().ok().and_then(|handles| {
        work.probe
            .iter()
            .find(|id| handles.get(*id).is_some_and(|h| !h.is_wsl_backed()))
            .cloned()
    });
    if let Some(id) = native {
        crate::process_tree::interactive_app_in_pty_fresh(state, &id);
    }

    let generations_at_snapshot = pty_generations(state);
    // Read with the generations so an exit verdict can be refused if the pane
    // started a *new session of the same app* before the cleanup runs — the one
    // successor `(terminal, app)` scoping cannot see (ADR-0136 §5).
    let epochs_at_snapshot = crate::activity::detection_epochs(state);
    // Read before taking the pass stamp. An observation published after this
    // read stays pending for the next pass; one read here has an older stamp.
    let mut observations_at_snapshot = crate::activity::observation_sequences(state);
    // Stamped before deriving, so a title resolved while this pass runs is
    // ordered after it — see the module docs of `activity_order`.
    let activity_sequence = crate::activity_order::next_activity_sequence();
    let mut current = match crate::activity::detect_terminal_states_scoped(state, &work.inspect) {
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

    // A restart can also land BETWEEN passes, not only during this pass's
    // generation reads. An old PTY's baseline cannot be deferred for its successor.
    uncertain::discard_replaced_baselines(
        published,
        published_generations,
        &generations_at_snapshot,
    );

    // A failed probe is not an exit (ADR-0359). In particular, do not clear
    // Codex's live title and destroy the evidence its task recovery still needs.
    let deferred = uncertain::defer_uncertain_agent_exits(published, &mut current, |id| {
        crate::process_tree::interactive_app_in_pty(state, id)
    });

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

    let changed = diff_requested(
        published,
        &current,
        published_observations,
        &observations_at_snapshot,
        &work.republish,
        activity_sequence,
    );
    // An uncertain pass must not consume a correction request. Recovery may
    // agree with the old backend value while the live event changed the UI.
    uncertain::retain_deferred_observations(
        published_observations,
        &mut observations_at_snapshot,
        &deferred,
    );
    // Track the full current view, including panes that vanished, so a pane that
    // closes and reopens with the same id is re-published rather than compared
    // against a verdict about the previous session.
    // A partial observation cannot erase baselines belonging to unselected panes.
    published.retain(|id, _| generations_now.contains_key(id));
    published_generations.retain(|id, _| generations_now.contains_key(id));
    published_observations.retain(|id, _| generations_now.contains_key(id));
    for id in current.keys() {
        if let Some(generation) = generations_at_snapshot.get(id) {
            published_generations.insert(id.clone(), *generation);
        }
        if let Some(revision) = observations_at_snapshot.get(id) {
            published_observations.insert(id.clone(), *revision);
        }
    }
    published.extend(current);

    // Every replaced pane loses its baseline, not just the ones that happened to
    // differ this pass. A restart into the *same* app produces an identical
    // verdict, so it would never enter the diff — and the fresh frontend
    // instance, whose activity starts empty, would then wait for another
    // activity change for a value the backend already knows.
    for terminal_id in &superseded {
        published.remove(terminal_id);
        published_generations.remove(terminal_id);
        published_observations.remove(terminal_id);
    }
    if !superseded.is_empty() {
        tracing::debug!(
            count = superseded.len(),
            "activity reconcile dropped verdicts about replaced PTYs"
        );
    }
    let fresh: Vec<ReconciledActivity> = changed
        .into_iter()
        .filter(|entry| {
            !superseded.contains(&entry.terminal_id) && !deferred.contains(&entry.terminal_id)
        })
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
            published_generations.remove(&entry.terminal_id);
            published_observations.remove(&entry.terminal_id);
        }
    }
    drop(terminals);
}

fn targets(state: &AppState) -> Vec<schedule::Target> {
    let observations = crate::activity::observation_sequences(state);
    let epochs = crate::activity::detection_epochs(state);
    #[cfg(windows)]
    let distros: HashMap<_, _> =
        crate::wsl_probe::wsl_terminal_targets(state, Instant::now() + Duration::from_secs(1))
            .map(|t| t.targets.into_iter().collect())
            .unwrap_or_default();
    #[cfg(not(windows))]
    let distros: HashMap<String, Option<String>> = HashMap::new();
    let handles = state
        .pty_handles
        .lock_or_err()
        .map(|h| h.clone())
        .unwrap_or_default();
    let Ok(terminals) = state.terminals.lock_or_err() else {
        return Vec::new();
    };
    terminals
        .iter()
        .filter_map(|(id, session)| {
            let handle = handles.get(id)?;
            let generation = handle.terminal_generation();
            let hook = crate::commands::cached_liveness(state, id, generation);
            let title_app = session
                .osc_title
                .as_deref()
                .and_then(crate::activity::detect_interactive_app_from_title);
            // A cache's suspension/expiry is not a lifecycle event and cannot
            // feed back into the signature that requests fresh observations.
            let app = title_app.as_deref();
            Some(schedule::Target {
                id: id.clone(),
                generation,
                domain: if handle.is_wsl_backed() {
                    format!(
                        "wsl:{}",
                        distros.get(id).and_then(|d| d.as_deref()).unwrap_or("?")
                    )
                } else {
                    "native".into()
                },
                signature: format!(
                    "{}:{}:{:?}:{:?}",
                    epochs.get(id).copied().unwrap_or(0),
                    session.command_running,
                    session.last_command_at,
                    app
                ),
                revision: observations.get(id).copied().unwrap_or(0),
                healthy_hook: hook.is_some(),
            })
        })
        .collect()
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
    if app_name == "Codex" {
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.codex_hook_title.clear();
            state.session_checkpoint.hints.request();
        }
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

mod schedule;
#[cfg(test)]
mod tests;
