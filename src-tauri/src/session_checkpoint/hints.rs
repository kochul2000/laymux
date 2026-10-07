//! Coalesced identity-change hints; the checkpoint remains the only writer.
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub(crate) struct CheckpointHints {
    revision: AtomicU64,
    pub(super) changed: tokio::sync::Notify,
}

impl CheckpointHints {
    pub(crate) fn request(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_one();
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
}

pub(super) fn start(app: tauri::AppHandle, state: std::sync::Arc<crate::state::AppState>) {
    use std::time::Duration;
    const HINT_SETTLE: Duration = Duration::from_millis(500);
    const RETRY_DELAY: Duration = Duration::from_secs(1);
    tauri::async_runtime::spawn(async move {
        let hints = &state.session_checkpoint.hints;
        let mut saved_revision = 0;
        loop {
            let hinted = tokio::select! {
                _ = hints.changed.notified() => true,
                _ = tokio::time::sleep(super::CHECKPOINT_WATCHDOG_INTERVAL) => false,
            };
            if hinted {
                tokio::time::sleep(HINT_SETTLE).await;
            }
            let revision = hints.revision();
            if hinted && revision == saved_revision {
                continue;
            }
            // Do not turn a background hint into a competing final save. A
            // cancelled close must still retain the pending dirty revision.
            if state.session_checkpoint.is_finalizing() {
                tokio::time::sleep(RETRY_DELAY).await;
                hints.changed.notify_one();
                continue;
            }
            let reason = if hinted { "completion" } else { "watchdog" };
            match super::request_frontend_checkpoint(&app, &state, reason, false).await {
                Ok(_) => saved_revision = revision,
                Err(error) => {
                    tracing::warn!(%error, reason, "background session checkpoint failed");
                    if hinted {
                        tokio::time::sleep(RETRY_DELAY).await;
                        hints.changed.notify_one();
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    #[test]
    fn hints_before_subscription_coalesce_and_changes_during_a_save_remain_pending() {
        let hints = CheckpointHints::default();
        for _ in 0..100 {
            hints.request();
        }
        assert!(hints.changed.notified().now_or_never().is_some());
        assert!(hints.changed.notified().now_or_never().is_none());
        let collecting_revision = hints.revision();
        hints.request();
        assert!(hints.revision() > collecting_revision);
        assert!(hints.changed.notified().now_or_never().is_some());
    }
}
