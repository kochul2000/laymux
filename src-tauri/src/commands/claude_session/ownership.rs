use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Direct PID attribution does not prove which process wrote a shared transcript.
pub(super) fn exclusive_transcript_roots(
    attributions: &HashMap<String, Option<String>>,
    mut roots: HashMap<String, PathBuf>,
) -> HashMap<String, PathBuf> {
    let mut counts = HashMap::new();
    for (terminal, root) in &roots {
        if let Some(Some(session)) = attributions.get(terminal) {
            *counts.entry((root.clone(), session.clone())).or_insert(0) += 1;
        }
    }
    roots.retain(|terminal, root| {
        attributions
            .get(terminal)
            .and_then(Option::as_ref)
            .is_some_and(|session| counts.get(&(root.clone(), session.clone())) == Some(&1))
    });
    roots
}

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
    fn shared_transcript_is_not_evidence_for_a_panes_input_or_result() {
        let claims = HashMap::from([
            ("a".into(), Some("shared".into())),
            ("b".into(), Some("shared".into())),
            ("separate-root".into(), Some("shared".into())),
            ("separate-session".into(), Some("other".into())),
            ("unresolved".into(), None),
        ]);
        let roots = HashMap::from([
            ("a".into(), PathBuf::from("home-one")),
            ("b".into(), PathBuf::from("home-one")),
            ("separate-root".into(), PathBuf::from("home-two")),
            ("separate-session".into(), PathBuf::from("home-one")),
            ("unresolved".into(), PathBuf::from("home-three")),
        ]);
        let result = exclusive_transcript_roots(&claims, roots);
        assert_eq!(
            result,
            HashMap::from([
                ("separate-root".into(), PathBuf::from("home-two")),
                ("separate-session".into(), PathBuf::from("home-one")),
            ])
        );
        assert_eq!(claims["a"].as_deref(), Some("shared"));
        assert_eq!(claims["b"].as_deref(), Some("shared"));
    }

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
