//! Target-scoped input admission for background terminal retirement.
use super::*;

#[derive(Default)]
pub(super) struct EvictionAdmission {
    pub(super) targets: HashSet<String>,
    active: HashMap<String, usize>,
}

pub struct TerminalMutationPermit<'a> {
    runtime: &'a SessionCheckpointRuntime,
    terminal_id: String,
}

impl Drop for TerminalMutationPermit<'_> {
    fn drop(&mut self) {
        let mut admission = self
            .runtime
            .eviction
            .lock_or_recover_for_discard("releasing terminal mutation");
        if let Some(count) = admission.active.get_mut(&self.terminal_id) {
            *count -= 1;
            if *count == 0 {
                admission.active.remove(&self.terminal_id);
            }
        }
    }
}

pub(super) struct EvictionGuard<'a> {
    runtime: &'a SessionCheckpointRuntime,
}
impl Drop for EvictionGuard<'_> {
    fn drop(&mut self) {
        self.runtime
            .eviction
            .lock_or_recover_for_discard("releasing hidden eviction")
            .targets
            .clear();
    }
}

impl SessionCheckpointRuntime {
    pub fn begin_terminal_mutation(
        &self,
        terminal_id: &str,
    ) -> Result<TerminalMutationPermit<'_>, String> {
        let mut admission = self.eviction.lock_or_err()?;
        if self.finalizing.load(Ordering::Acquire) {
            return Err("destructive session finalization is in progress".into());
        }
        if admission.targets.contains(terminal_id) {
            return Err("hidden terminal eviction is in progress".into());
        }
        *admission.active.entry(terminal_id.to_owned()).or_default() += 1;
        Ok(TerminalMutationPermit {
            runtime: self,
            terminal_id: terminal_id.to_owned(),
        })
    }

    pub(super) fn terminal_mutations_drained(&self) -> Result<bool, String> {
        let admission = self.eviction.lock_or_err()?;
        Ok(admission.active.is_empty() && admission.targets.is_empty())
    }

    pub(super) async fn begin_eviction_and_drain<'a>(
        &'a self,
        state: &AppState,
        targets: &[String],
    ) -> Result<EvictionGuard<'a>, String> {
        {
            let mut admission = self.eviction.lock_or_err()?;
            if self.finalizing.load(Ordering::Acquire) || !admission.targets.is_empty() {
                return Err(
                    "session finalization or hidden eviction is already in progress".into(),
                );
            }
            admission.targets.extend(targets.iter().cloned());
        }
        let guard = EvictionGuard { runtime: self };
        // ponytail: generic multi-pane mutations still drain globally; scope
        // those separately if background eviction needs structural concurrency.
        // New input for unrelated panes does not join this drain.
        tokio::time::timeout(FINALIZATION_DRAIN_TIMEOUT, async {
            loop {
                let targets_drained = {
                    let admission = self.eviction.lock_or_err()?;
                    targets.iter().all(|id| !admission.active.contains_key(id))
                };
                let workers_drained = {
                    let handles = state.pty_handles.lock_or_err()?;
                    targets
                        .iter()
                        .filter_map(|id| handles.get(id))
                        .all(|handle| {
                            handle
                                .pending_control_completion()
                                .is_none_or(|completion| completion.is_complete())
                        })
                };
                if targets_drained
                    && workers_drained
                    && self.active_mutations.load(Ordering::Acquire) == 0
                {
                    return Ok::<(), String>(());
                }
                tokio::time::sleep(FINALIZATION_DRAIN_POLL).await;
            }
        })
        .await
        .map_err(|_| "hidden terminal mutation drain timed out".to_string())??;
        Ok(guard)
    }
}
