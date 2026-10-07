//! Checkpoint liveness uses one native snapshot and the fresh guest probes.
use super::ProviderSessionLookup;
use crate::process_tree::{ProcessEntry, PtyAppLiveness};
use crate::pty::PtyHandle;
use std::collections::HashMap;

pub(super) fn collect(
    handles: &HashMap<String, PtyHandle>,
    lookups: [&ProviderSessionLookup; 3],
    mut snapshot: impl FnMut() -> Vec<ProcessEntry>,
) -> HashMap<String, PtyAppLiveness> {
    let native = handles
        .values()
        .any(|h| !h.is_wsl_backed() && h.child_pid().is_some())
        .then(&mut snapshot)
        .unwrap_or_default();
    handles
        .iter()
        .map(|(id, handle)| {
            let live = if handle.is_wsl_backed() {
                // Each provider just probed the guest. The reconcile/display
                // cache can predate a launch or exit and must not erase this ID.
                guest_liveness(
                    id,
                    lookups,
                    crate::wsl_liveness::liveness(id, handle.terminal_generation()),
                )
            } else {
                crate::process_tree::classify(handle.child_pid(), &native)
            };
            (id.clone(), live)
        })
        .collect()
}

fn guest_liveness(
    id: &str,
    lookups: [&ProviderSessionLookup; 3],
    display: PtyAppLiveness,
) -> PtyAppLiveness {
    if lookups
        .iter()
        .any(|lookup| lookup.failed_terminal_ids.contains(id))
    {
        return PtyAppLiveness::Unknown;
    }
    let mut active = ["Claude", "Codex", "Grok"]
        .into_iter()
        .zip(lookups)
        .filter_map(|(provider, lookup)| lookup.attributions.contains_key(id).then_some(provider));
    match (active.next(), active.next()) {
        // The provider probe skips processes whose environment is unreadable.
        // Its absence alone cannot upgrade an unknown guest verdict to exit.
        (None, _) if display == PtyAppLiveness::NoneAlive => PtyAppLiveness::NoneAlive,
        (None, _) => PtyAppLiveness::Unknown,
        (Some(provider), None) => PtyAppLiveness::Running(provider),
        _ => PtyAppLiveness::Ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(pid: u32, wsl: bool) -> PtyHandle {
        PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 7)
            .with_child_pid(Some(pid))
            .with_wsl_backed(wsl)
    }

    #[test]
    fn native_checkpoint_enumerates_once_for_all_panes_and_keeps_failures_unknown() {
        let handles = (1..=16)
            .map(|pid| (format!("pane-{pid}"), handle(pid, false)))
            .collect();
        let empty = ProviderSessionLookup::default();
        let mut calls = 0;
        let observed = collect(&handles, [&empty; 3], || {
            calls += 1;
            vec![ProcessEntry {
                pid: 1,
                ppid: 0,
                name: "codex".into(),
                is_helper: false,
            }]
        });
        assert_eq!(
            calls, 1,
            "process enumeration must not grow with pane count"
        );
        assert_eq!(observed["pane-1"], PtyAppLiveness::Running("Codex"));
        assert_eq!(observed["pane-16"], PtyAppLiveness::NoneAlive);
        assert!(collect(&handles, [&empty; 3], Vec::new)
            .values()
            .all(|v| *v == PtyAppLiveness::Unknown));
    }

    #[test]
    fn fresh_wsl_provider_observation_does_not_depend_on_display_cache() {
        let handles = ["live", "gone", "failed", "handover"]
            .into_iter()
            .map(|id| (id.into(), handle(1, true)))
            .collect();
        let claude = ProviderSessionLookup {
            attributions: HashMap::from([("handover".into(), Some("new".into()))]),
            ..Default::default()
        };
        let codex = ProviderSessionLookup {
            attributions: HashMap::from([
                ("live".into(), Some("current".into())),
                ("handover".into(), Some("old".into())),
            ]),
            failed_terminal_ids: ["failed".into()].into(),
            ..Default::default()
        };
        let empty = ProviderSessionLookup::default();
        let result = collect(&handles, [&claude, &codex, &empty], || {
            panic!("guest-only lookup must not enumerate Windows")
        });
        assert_eq!(result["live"], PtyAppLiveness::Running("Codex"));
        assert_eq!(result["gone"], PtyAppLiveness::Unknown);
        assert_eq!(result["failed"], PtyAppLiveness::Unknown);
        assert_eq!(result["handover"], PtyAppLiveness::Ambiguous);
    }

    #[test]
    fn guest_probe_absence_cannot_turn_an_unreadable_or_stale_guest_view_into_an_exit() {
        let empty = ProviderSessionLookup::default();
        for display in [
            PtyAppLiveness::Unknown,
            PtyAppLiveness::Running("Codex"),
            PtyAppLiveness::Ambiguous,
        ] {
            assert_eq!(
                guest_liveness("pane", [&empty; 3], display),
                PtyAppLiveness::Unknown
            );
        }
        assert_eq!(
            guest_liveness("pane", [&empty; 3], PtyAppLiveness::NoneAlive),
            PtyAppLiveness::NoneAlive
        );
        let codex = ProviderSessionLookup {
            attributions: HashMap::from([("pane".into(), Some("current".into()))]),
            ..Default::default()
        };
        assert_eq!(
            guest_liveness("pane", [&empty, &codex, &empty], PtyAppLiveness::NoneAlive),
            PtyAppLiveness::Running("Codex")
        );
    }
}
