use std::collections::{HashMap, HashSet};

/// A conversation may be resumed by distinct processes. Only a process claimed
/// by multiple panes is ambiguous (ADR-0383). WSL PIDs are distro-local.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct ProcessOwner(pub Option<String>, pub u32);

pub(super) fn reject_shared_processes(
    mut attributions: HashMap<String, Option<String>>,
    owners: &HashMap<String, ProcessOwner>,
) -> HashMap<String, Option<String>> {
    let mut seen = HashSet::new();
    let mut conflicts = HashSet::new();
    for owner in owners.values() {
        if !seen.insert(owner) {
            conflicts.insert(owner);
        }
    }
    for (terminal, session) in &mut attributions {
        if session.is_some()
            && owners
                .get(terminal)
                .is_none_or(|owner| conflicts.contains(owner))
        {
            tracing::warn!(
                terminal_id = terminal,
                "Claude process ownership is ambiguous"
            );
            *session = None;
        }
    }
    attributions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_process_claimed_by_two_panes_is_rejected_even_with_different_ids() {
        let claims = HashMap::from([
            ("a".into(), Some("session-a".into())),
            ("b".into(), Some("session-b".into())),
            ("c".into(), Some("session-a".into())),
        ]);
        let owners = HashMap::from([
            ("a".into(), ProcessOwner(None, 10)),
            ("b".into(), ProcessOwner(None, 10)),
            ("c".into(), ProcessOwner(None, 20)),
        ]);
        let result = reject_shared_processes(claims, &owners);
        assert_eq!(result["a"], None);
        assert_eq!(result["b"], None);
        assert_eq!(result["c"].as_deref(), Some("session-a"));
    }

    #[test]
    fn pid_namespaces_are_independent_and_missing_proof_fails_closed() {
        let claims = ["native", "ubuntu", "debian", "missing"]
            .into_iter()
            .map(|id| (id.into(), Some("same".into())))
            .collect();
        let owners = HashMap::from([
            ("native".into(), ProcessOwner(None, 10)),
            ("ubuntu".into(), ProcessOwner(Some("Ubuntu".into()), 10)),
            ("debian".into(), ProcessOwner(Some("Debian".into()), 10)),
        ]);
        let result = reject_shared_processes(claims, &owners);
        for id in ["native", "ubuntu", "debian"] {
            assert_eq!(result[id].as_deref(), Some("same"));
        }
        assert_eq!(result["missing"], None);
    }
}
