//! Delivered frontend actions stay tracked through late HTTP responses.
use super::*;

#[derive(Clone, Copy)]
pub(super) enum DetachedMutationKind {
    Session,
    Navigation,
}

impl SessionCheckpointRuntime {
    fn mutation_counter(&self, kind: DetachedMutationKind) -> &AtomicUsize {
        match kind {
            DetachedMutationKind::Session => &self.active_mutations,
            DetachedMutationKind::Navigation => &self.active_navigation,
        }
    }

    fn ensure_detached_allowed(&self, kind: DetachedMutationKind) -> Result<(), String> {
        match kind {
            DetachedMutationKind::Session => self.ensure_mutations_allowed(),
            DetachedMutationKind::Navigation if self.is_finalizing() => {
                Err("destructive session finalization is in progress".into())
            }
            DetachedMutationKind::Navigation => Ok(()),
        }
    }

    /// Only explicit navigation may overlap background retirement (ADR-0365).
    /// It remains part of update drain even after the HTTP waiter times out.
    pub(crate) fn begin_detached_navigation(&self, request_id: &str) -> Result<(), String> {
        self.begin_detached(request_id, DetachedMutationKind::Navigation)
    }

    pub fn begin_detached_mutation(&self, request_id: &str) -> Result<(), String> {
        self.begin_detached(request_id, DetachedMutationKind::Session)
    }

    fn begin_detached(&self, request_id: &str, kind: DetachedMutationKind) -> Result<(), String> {
        self.ensure_detached_allowed(kind)?;
        let counter = self.mutation_counter(kind);
        counter.fetch_add(1, Ordering::AcqRel);
        if let Err(error) = self.ensure_detached_allowed(kind) {
            counter.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
        let mut detached = match self.detached_mutations.lock_or_err() {
            Ok(detached) => detached,
            Err(error) => {
                counter.fetch_sub(1, Ordering::AcqRel);
                return Err(error.to_string());
            }
        };
        if detached.contains_key(request_id) {
            counter.fetch_sub(1, Ordering::AcqRel);
            return Err(format!(
                "session checkpoint mutation {request_id} is already active"
            ));
        }
        detached.insert(request_id.to_owned(), kind);
        Ok(())
    }

    pub fn finish_detached_mutation(&self, request_id: &str) -> Result<bool, String> {
        let removed = self.detached_mutations.lock_or_err()?.remove(request_id);
        if let Some(kind) = removed {
            self.mutation_counter(kind).fetch_sub(1, Ordering::AcqRel);
        }
        Ok(removed.is_some())
    }
}
