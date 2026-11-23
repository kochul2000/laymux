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

    fn ensure_detached_allowed(&self, kind: DetachedMutationKind) -> Result<(), AppError> {
        match kind {
            DetachedMutationKind::Session => self.check_mutation_admission(),
            DetachedMutationKind::Navigation if self.is_finalizing() => {
                Err(AppError::SessionFinalizing)
            }
            DetachedMutationKind::Navigation => Ok(()),
        }
    }

    /// Only explicit navigation may overlap background retirement (ADR-0365).
    /// It remains part of update drain even after the HTTP waiter times out.
    pub(crate) fn begin_detached_navigation(&self, request_id: &str) -> Result<(), String> {
        self.begin_detached(request_id, DetachedMutationKind::Navigation)
            .map_err(Into::into)
    }

    pub fn begin_detached_mutation(&self, request_id: &str) -> Result<(), String> {
        self.begin_detached(request_id, DetachedMutationKind::Session)
            .map_err(Into::into)
    }

    pub(crate) async fn begin_pane_creation_after_eviction(
        &self,
        request_id: &str,
        wait_budget: Duration,
    ) -> Result<(), String> {
        let deadline = tokio::time::sleep(wait_budget);
        tokio::pin!(deadline);
        loop {
            // 승인 시도 전에 구독해야 검사 도중 끝난 회수의 알림도 받는다.
            let changed = self.admission_changed.notified();
            match self.begin_detached(request_id, DetachedMutationKind::Session) {
                Err(AppError::HiddenTerminalEviction) => tokio::select! {
                    biased;
                    // 회수 해제와 기한 만료를 함께 관측하면 새 pane을 만들지 않는다.
                    _ = &mut deadline => {
                        return Err("timed out waiting for hidden terminal eviction before pane creation".into());
                    }
                    _ = changed => {}
                },
                result => return result.map_err(String::from),
            }
        }
    }

    fn begin_detached(&self, request_id: &str, kind: DetachedMutationKind) -> Result<(), AppError> {
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
                return Err(error);
            }
        };
        if detached.contains_key(request_id) {
            counter.fetch_sub(1, Ordering::AcqRel);
            return Err(AppError::Other(format!(
                "session checkpoint mutation {request_id} is already active"
            )));
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
