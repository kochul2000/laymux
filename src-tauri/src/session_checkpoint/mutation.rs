//! Delivered frontend actions stay tracked through late HTTP responses.
use super::*;

pub(super) enum DetachedMutationKind {
    Session,
    Navigation,
    Terminals(Vec<String>),
}

impl SessionCheckpointRuntime {
    fn mutation_counter(&self, kind: &DetachedMutationKind) -> &AtomicUsize {
        match kind {
            DetachedMutationKind::Session => &self.active_mutations,
            DetachedMutationKind::Navigation | DetachedMutationKind::Terminals(_) => {
                &self.active_non_global_bridge_actions
            }
        }
    }

    fn ensure_detached_allowed(&self, kind: &DetachedMutationKind) -> Result<(), AppError> {
        match kind {
            DetachedMutationKind::Session => self.check_mutation_admission(),
            _ if self.is_finalizing() => Err(AppError::SessionFinalizing),
            _ => Ok(()),
        }
    }

    /// Explicit navigation may overlap background retirement (ADR-0365).
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
        terminal_ids: &[String],
        wait_budget: Duration,
    ) -> Result<(), String> {
        let deadline = tokio::time::sleep(wait_budget);
        tokio::pin!(deadline);
        loop {
            // 승인 시도 전에 구독해야 검사 도중 끝난 회수의 알림도 받는다.
            let changed = self.admission_changed.notified();
            match self.begin_detached(
                request_id,
                DetachedMutationKind::Terminals(terminal_ids.to_vec()),
            ) {
                // 등록 락을 기다리는 사이 기한이 지났으면 발행 전에 등록을 철회한다.
                Ok(()) if tokio::time::Instant::now() >= deadline.deadline() => {
                    self.finish_detached_mutation(request_id)?;
                    return Err(AppError::PaneCreationTimeout.into());
                }
                Err(AppError::HiddenTerminalEviction) => tokio::select! {
                    biased;
                    // 회수 해제와 기한 만료를 함께 관측하면 새 pane을 만들지 않는다.
                    _ = &mut deadline => {
                        return Err(AppError::PaneCreationTimeout.into());
                    }
                    _ = changed => {}
                },
                result => return result.map_err(String::from),
            }
        }
    }

    pub(crate) fn begin_detached_terminal_mutation(
        &self,
        request_id: &str,
        terminal_id: &str,
    ) -> Result<(), String> {
        self.begin_detached(
            request_id,
            DetachedMutationKind::Terminals(vec![terminal_id.into()]),
        )
        .map_err(Into::into)
    }

    fn begin_detached(&self, request_id: &str, kind: DetachedMutationKind) -> Result<(), AppError> {
        self.ensure_detached_allowed(&kind)?;
        let counter = self.mutation_counter(&kind);
        counter.fetch_add(1, Ordering::AcqRel);
        let admission = match &kind {
            DetachedMutationKind::Terminals(ids) => {
                self.acquire_terminal_mutations(ids.iter().map(String::as_str))
            }
            _ => self.ensure_detached_allowed(&kind),
        };
        if let Err(error) = admission {
            counter.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
        let error = match self.detached_mutations.lock_or_err() {
            Ok(mut detached) if !detached.contains_key(request_id) => {
                detached.insert(request_id.to_owned(), kind);
                return Ok(());
            }
            Ok(_) => AppError::Other(format!(
                "session checkpoint mutation {request_id} is already active"
            )),
            Err(error) => error,
        };
        self.release_detached_mutation(&kind);
        Err(error)
    }

    fn release_detached_mutation(&self, kind: &DetachedMutationKind) {
        if let DetachedMutationKind::Terminals(ids) = kind {
            self.release_terminal_mutations(ids.iter().map(String::as_str));
        }
        self.mutation_counter(kind).fetch_sub(1, Ordering::AcqRel);
    }

    pub fn finish_detached_mutation(&self, request_id: &str) -> Result<bool, String> {
        let removed = self.detached_mutations.lock_or_err()?.remove(request_id);
        if let Some(kind) = &removed {
            self.release_detached_mutation(kind);
        }
        Ok(removed.is_some())
    }
}
