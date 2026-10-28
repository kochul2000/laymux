//! Demand coalescing and per-domain fallback (ADR-0362).

use std::collections::{HashMap, HashSet};

#[derive(Clone)]
pub(super) struct Target {
    pub id: String,
    pub generation: u64,
    pub domain: String,
    pub signature: String,
    pub revision: u64,
    pub healthy_hook: bool,
}

struct Entry {
    generation: u64,
    domain: String,
    signature: String,
    revision: u64,
    fallback_at: u64,
}

#[derive(Default)]
pub(super) struct Schedule {
    entries: HashMap<String, Entry>,
    pending: HashSet<String>,
    pending_publish: HashSet<String>,
    next_slot: u64,
}

#[derive(Default)]
pub(super) struct Work {
    pub inspect: HashSet<String>,
    pub probe: HashSet<String>,
    pub republish: HashSet<String>,
}

impl Schedule {
    pub fn plan(&mut self, now: u64, targets: &[Target], requested: &HashSet<String>) -> Work {
        let live: HashSet<_> = targets.iter().map(|t| t.id.clone()).collect();
        self.entries.retain(|id, _| live.contains(id));
        self.pending.retain(|id| live.contains(id));
        self.pending_publish.retain(|id| live.contains(id));
        self.pending_publish
            .extend(requested.intersection(&live).cloned());
        self.pending.extend(requested.intersection(&live).cloned());
        let mut work = Work::default();
        for target in targets {
            let entry = self.entries.entry(target.id.clone()).or_insert_with(|| {
                self.pending.insert(target.id.clone());
                Entry {
                    generation: target.generation,
                    domain: target.domain.clone(),
                    signature: target.signature.clone(),
                    revision: 0,
                    fallback_at: now,
                }
            });
            if entry.generation != target.generation
                || entry.domain != target.domain
                || entry.signature != target.signature
            {
                self.pending.insert(target.id.clone());
                entry.generation = target.generation;
                entry.domain.clone_from(&target.domain);
                entry.signature.clone_from(&target.signature);
            }
            if entry.revision != target.revision {
                work.inspect.insert(target.id.clone());
                entry.revision = target.revision;
            }
        }
        if now < self.next_slot {
            return work;
        }
        // Select one host/distribution, even after suspend or a long probe. No
        // catch-up loop may turn all overdue domains into a single burst.
        let domain = targets
            .iter()
            .filter(|t| {
                self.pending.contains(&t.id)
                    || (!t.healthy_hook && self.entries[&t.id].fallback_at <= now)
            })
            .map(|t| {
                (
                    !self.pending.contains(&t.id),
                    self.entries[&t.id].fallback_at,
                    &t.domain,
                )
            })
            .min_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(b.2)))
            .map(|(_, _, domain)| domain.clone());
        if let Some(domain) = domain {
            // Stable jitter keeps the schedule reproducible while separating
            // distributions. It never invokes a random source or external tool.
            let jitter = domain
                .bytes()
                .fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64))
                % 30_001;
            for target in targets.iter().filter(|t| t.domain == domain) {
                let Some(entry) = self.entries.get_mut(&target.id) else {
                    continue;
                };
                if self.pending.remove(&target.id)
                    || (!target.healthy_hook && entry.fallback_at <= now)
                {
                    work.probe.insert(target.id.clone());
                    if self.pending_publish.remove(&target.id) {
                        work.republish.insert(target.id.clone());
                    }
                    work.inspect.insert(target.id.clone());
                    entry.fallback_at = now
                        + crate::constants::ACTIVITY_FALLBACK_INTERVAL.as_millis() as u64
                        + jitter;
                }
            }
            self.next_slot = now + crate::constants::ACTIVITY_DOMAIN_SPACING.as_millis() as u64;
        }
        work
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, domain: &str) -> Target {
        Target {
            id: id.into(),
            generation: 1,
            domain: domain.into(),
            signature: "idle".into(),
            revision: 1,
            healthy_hook: false,
        }
    }

    #[test]
    fn healthy_hooks_do_not_schedule_repeated_process_scans() {
        let mut schedule = Schedule::default();
        let mut target = row("pane", "Ubuntu");
        assert_eq!(
            schedule
                .plan(0, &[target.clone()], &Default::default())
                .probe
                .len(),
            1
        );
        target.healthy_hook = true;
        for second in 1..=360 {
            target.revision += 1; // spinner/title traffic is not a scan request
            assert!(schedule
                .plan(second * 1000, &[target.clone()], &Default::default())
                .probe
                .is_empty());
        }
    }

    #[test]
    fn fallback_is_grouped_by_domain_and_spread_between_domains() {
        let mut schedule = Schedule::default();
        let targets = [row("a", "Ubuntu"), row("b", "Ubuntu"), row("c", "Debian")];
        let first = schedule.plan(0, &targets, &Default::default());
        assert!(first.probe.len() == 1 || first.probe.len() == 2);
        assert!(schedule
            .plan(100, &targets, &Default::default())
            .probe
            .is_empty());
        let second = schedule.plan(2000, &targets, &Default::default());
        assert_eq!(first.probe.len() + second.probe.len(), 3);
        for t in 3..120 {
            assert!(schedule
                .plan(t * 1000, &targets, &Default::default())
                .probe
                .is_empty());
        }
        let mut fallback = Vec::new();
        for t in 120..=155 {
            let work = schedule.plan(t * 1000, &targets, &Default::default());
            if !work.probe.is_empty() {
                fallback.push((t, work.probe));
            }
        }
        assert_eq!(fallback.len(), 2);
        assert!(fallback[1].0 - fallback[0].0 >= 2);
        assert_eq!(fallback.iter().map(|(_, ids)| ids.len()).sum::<usize>(), 3);
    }

    #[test]
    fn lifecycle_and_entry_requests_are_targeted_and_replacement_cannot_inherit_deadline() {
        let mut schedule = Schedule::default();
        let mut targets = [row("a", "Ubuntu"), row("b", "Ubuntu")];
        schedule.plan(0, &targets, &Default::default());
        let requested = HashSet::from(["b".into()]);
        assert_eq!(schedule.plan(2000, &targets, &requested).probe, requested);
        targets[0].generation = 2;
        assert_eq!(
            schedule.plan(4000, &targets, &Default::default()).probe,
            HashSet::from(["a".into()])
        );
        targets[0].signature = "shell-prompt".into();
        assert!(schedule
            .plan(6000, &targets, &Default::default())
            .probe
            .contains("a"));
        targets[0].domain = "Debian".into();
        assert!(schedule
            .plan(8000, &targets, &Default::default())
            .probe
            .contains("a"));
    }
}
