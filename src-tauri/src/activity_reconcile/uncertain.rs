use std::collections::{HashMap, HashSet};

use crate::process_tree::PtyAppLiveness;
use crate::terminal::TerminalActivity;

pub(super) fn discard_replaced_baselines(
    published: &mut HashMap<String, TerminalActivity>,
    published_generations: &HashMap<String, u64>,
    current_generations: &HashMap<String, u64>,
) {
    published.retain(|id, _| {
        current_generations
            .get(id)
            .is_some_and(|generation| published_generations.get(id) == Some(generation))
    });
}

/// Keep the diff baseline, without publishing it as a new observation.
pub(super) fn defer_uncertain_agent_exits(
    published: &HashMap<String, TerminalActivity>,
    current: &mut HashMap<String, TerminalActivity>,
    mut liveness: impl FnMut(&str) -> PtyAppLiveness,
) -> HashSet<String> {
    let mut deferred = HashSet::new();
    for (id, candidate) in current {
        let Some(previous @ TerminalActivity::InteractiveApp { name }) = published.get(id) else {
            continue;
        };
        if !matches!(name.as_str(), "Claude" | "Codex" | "Grok") || candidate == previous {
            continue;
        }
        let live = liveness(id);
        if matches!(live, PtyAppLiveness::Unknown | PtyAppLiveness::Ambiguous)
            || matches!(live, PtyAppLiveness::Running(alive) if alive == name)
        {
            *candidate = previous.clone();
            deferred.insert(id.clone());
        }
    }
    deferred
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_reconcile::{diff, exited_apps};

    fn agent(name: &str) -> TerminalActivity {
        TerminalActivity::InteractiveApp { name: name.into() }
    }

    #[test]
    fn unavailable_probe_cannot_publish_shell_or_run_exit_cleanup_when_repeated() {
        for app in ["Claude", "Codex", "Grok"] {
            for live in [
                PtyAppLiveness::Unknown,
                PtyAppLiveness::Ambiguous,
                PtyAppLiveness::Running(app),
            ] {
                let before = HashMap::from([("pane".into(), agent(app))]);
                let mut current = HashMap::from([("pane".into(), TerminalActivity::Shell)]);
                let deferred = defer_uncertain_agent_exits(&before, &mut current, |_| live);
                assert!(exited_apps(&before, &current).is_empty(), "{app}: {live:?}");
                let events: Vec<_> = diff(&before, &current, 123)
                    .into_iter()
                    .filter(|e| !deferred.contains(&e.terminal_id))
                    .collect();
                assert!(events.is_empty());
                assert_eq!(
                    current, before,
                    "a later confirmed exit still needs its baseline"
                );
            }
        }
    }

    #[test]
    fn confirmed_exit_and_provider_handover_still_run_cleanup() {
        for (next, live) in [
            (TerminalActivity::Shell, PtyAppLiveness::NoneAlive),
            (agent("Claude"), PtyAppLiveness::Running("Claude")),
        ] {
            let before = HashMap::from([("pane".into(), agent("Codex"))]);
            let mut current = HashMap::from([("pane".into(), next.clone())]);
            assert!(defer_uncertain_agent_exits(&before, &mut current, |_| live).is_empty());
            assert_eq!(current["pane"], next);
            assert_eq!(
                exited_apps(&before, &current),
                vec![("pane".into(), "Codex".into())]
            );
        }
    }

    #[test]
    fn a_probe_recovers_and_later_confirms_exit_without_losing_the_previous_app() {
        let mut published = HashMap::from([("pane".into(), agent("Codex"))]);
        for _ in 0..3 {
            let mut current = HashMap::from([("pane".into(), TerminalActivity::Shell)]);
            assert!(defer_uncertain_agent_exits(&published, &mut current, |_| {
                PtyAppLiveness::Unknown
            })
            .contains("pane"));
            assert!(exited_apps(&published, &current).is_empty());
            published = current;
        }
        let mut recovered = HashMap::from([("pane".into(), agent("Codex"))]);
        assert!(
            defer_uncertain_agent_exits(&published, &mut recovered, |_| PtyAppLiveness::Running(
                "Codex"
            ))
            .is_empty()
        );
        assert!(exited_apps(&published, &recovered).is_empty());
        published = recovered;
        let mut exited = HashMap::from([("pane".into(), TerminalActivity::Shell)]);
        assert!(defer_uncertain_agent_exits(&published, &mut exited, |_| {
            PtyAppLiveness::NoneAlive
        })
        .is_empty());
        assert_eq!(
            exited_apps(&published, &exited),
            vec![("pane".into(), "Codex".into())]
        );
    }

    #[test]
    fn deleted_panes_and_non_agent_apps_are_not_retained() {
        let before = HashMap::from([
            ("gone".into(), agent("Codex")),
            ("vim".into(), agent("vim")),
        ]);
        let mut current = HashMap::from([("vim".into(), TerminalActivity::Shell)]);
        assert!(
            defer_uncertain_agent_exits(&before, &mut current, |_| PtyAppLiveness::Unknown)
                .is_empty()
        );
        assert!(!current.contains_key("gone"));
        assert_eq!(current["vim"], TerminalActivity::Shell);
    }

    #[test]
    fn a_replacement_between_passes_cannot_inherit_an_uncertain_agent_baseline() {
        let mut published = HashMap::from([("pane".into(), agent("Codex"))]);
        let published_generations = HashMap::from([("pane".into(), 7)]);
        let current_generations = HashMap::from([("pane".into(), 8)]);
        assert!(crate::activity_reconcile::superseded_terminals(
            &current_generations,
            &current_generations
        )
        .is_empty());
        discard_replaced_baselines(&mut published, &published_generations, &current_generations);
        let mut current = HashMap::from([("pane".into(), TerminalActivity::Shell)]);
        assert!(
            defer_uncertain_agent_exits(&published, &mut current, |_| PtyAppLiveness::Unknown)
                .is_empty()
        );
        assert_eq!(
            diff(&published, &current, 123).len(),
            1,
            "the fresh pane needs its own observation"
        );
        assert!(
            exited_apps(&published, &current).is_empty(),
            "the old PTY was already torn down"
        );
        let mut same_generation = HashMap::from([("pane".into(), agent("Codex"))]);
        discard_replaced_baselines(
            &mut same_generation,
            &current_generations,
            &current_generations,
        );
        assert!(
            defer_uncertain_agent_exits(&same_generation, &mut current, |_| {
                PtyAppLiveness::Unknown
            })
            .contains("pane"),
            "a current PTY still keeps its uncertain baseline"
        );
    }
}
