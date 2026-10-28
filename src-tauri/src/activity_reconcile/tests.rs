use super::*;

#[test]
fn an_explicit_entry_request_repairs_only_that_panes_equal_backend_baseline() {
    let previous = map(&[("a", claude()), ("b", claude())]);
    let unchanged = HashMap::new();
    let requested = HashSet::from(["b".into()]);
    let changed = diff_requested(&previous, &previous, &unchanged, &unchanged, &requested, 77);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].terminal_id, "b");
    assert_eq!(changed[0].activity_sequence, 77);
    assert!(diff_requested(
        &previous,
        &previous,
        &unchanged,
        &unchanged,
        &HashSet::new(),
        78
    )
    .is_empty());
}
use crate::constants::{
    ACTIVITY_FALLBACK_INTERVAL, WSL_LIVENESS_AUTHORITATIVE_MAX_AGE, WSL_LIVENESS_POSITIVE_MAX_AGE,
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
        diff(&published, &current, SEQ),
        vec![ReconciledActivity {
            terminal_id: "t-a".into(),
            activity: claude(),
            activity_sequence: SEQ,
        }]
    );
}

#[test]
fn a_live_title_can_be_corrected_without_backend_activity_changing() {
    let published = map(&[("late-title", shell()), ("quiet", shell())]);
    let previous = generations(&[("late-title", 10), ("quiet", 10)]);
    let observed = generations(&[("late-title", 20), ("quiet", 10)]);
    let correction = diff_observed(&published, &published, &previous, &observed, 21);
    assert_eq!(correction.len(), 1);
    assert_eq!(correction[0].terminal_id, "late-title");
    assert_eq!(correction[0].activity, TerminalActivity::Shell);
    assert_eq!(correction[0].activity_sequence, 21);
    assert!(diff_observed(&published, &published, &observed, &observed, 30).is_empty());
}

#[test]
fn an_uncertain_pass_keeps_the_correction_pending_until_recovery() {
    let published = map(&[("pane", claude())]);
    let previous = generations(&[("pane", 10)]);
    let mut observed = generations(&[("pane", 20)]);
    uncertain::retain_deferred_observations(
        &previous,
        &mut observed,
        &HashSet::from(["pane".into()]),
    );
    assert_eq!(observed["pane"], 10);
    let recovered = generations(&[("pane", 20)]);
    assert_eq!(
        diff_observed(&published, &published, &observed, &recovered, 30).len(),
        1
    );
}

#[test]
fn a_pane_with_no_published_value_yet_is_published() {
    let current = map(&[("t-new", claude())]);
    assert_eq!(diff(&HashMap::new(), &current, SEQ).len(), 1);
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
    assert_eq!(diff(&published, &current, SEQ).len(), 1);
}

#[test]
fn a_closed_pane_publishes_nothing() {
    let published = map(&[("t-gone", claude())]);
    assert!(diff(&published, &HashMap::new(), SEQ).is_empty());
}

/// Elapsed time never forces an unchanged pane to be published again.
#[test]
fn unchanged_panes_are_not_republished() {
    let published = map(&[("t-a", claude()), ("t-b", shell())]);
    let current = published.clone();
    assert!(diff(&published, &current, SEQ).is_empty());
    assert!(diff(&published, &current, SEQ + 1000).is_empty());
}

#[test]
fn a_change_still_detects_an_exit_that_happened_this_pass() {
    let published = map(&[("t", claude())]);
    let current = map(&[("t", shell())]);
    assert_eq!(
        exited_apps(&published, &current),
        vec![("t".to_string(), "Claude".to_string())]
    );
    assert_eq!(diff(&published, &current, SEQ).len(), 1);
}

#[test]
fn every_entry_carries_the_pass_stamp() {
    let current = map(&[("t", claude())]);
    let published = diff(&HashMap::new(), &current, SEQ);
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
/// until another activity change; computing it from the generations does not.
#[test]
fn a_restart_into_the_same_app_is_superseded_even_though_the_diff_is_silent() {
    let published = map(&[("t", claude())]);
    let current = map(&[("t", claude())]);
    assert!(diff(&published, &current, SEQ).is_empty());
    assert!(
        superseded_terminals(&generations(&[("t", 1)]), &generations(&[("t", 2)])).contains("t")
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

/// Display fallback must not extend the lifetime of control-path evidence.
#[test]
fn slow_fallback_is_independent_of_authoritative_guest_evidence_lifetime() {
    assert!(ACTIVITY_FALLBACK_INTERVAL > WSL_LIVENESS_AUTHORITATIVE_MAX_AGE);
    assert!(WSL_LIVENESS_AUTHORITATIVE_MAX_AGE <= WSL_LIVENESS_POSITIVE_MAX_AGE);
}

/// A metadata wakeup never catches up by starting additional observations.
#[test]
fn metadata_wakeup_does_not_trigger_catch_up_after_a_pass() {
    assert_eq!(
        next_pass_delay(Duration::from_secs(1)),
        ACTIVITY_RECONCILE_INTERVAL
    );
}

/// An overrun still leaves an idle metadata interval without a catch-up burst.
#[test]
fn an_overrunning_pass_still_leaves_a_metadata_idle_delay() {
    assert_eq!(
        next_pass_delay(ACTIVITY_RECONCILE_INTERVAL * 3),
        ACTIVITY_RECONCILE_INTERVAL
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
