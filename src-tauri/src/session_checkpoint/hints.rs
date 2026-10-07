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

use std::time::Duration;
struct Timing {
    settle: Duration,
    retry: Duration,
    cap: Duration,
    watchdog: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            settle: Duration::from_millis(500),
            retry: Duration::from_secs(1),
            cap: Duration::from_secs(30),
            watchdog: super::CHECKPOINT_WATCHDOG_INTERVAL,
        }
    }
}
async fn run<F, Fut>(
    hints: &CheckpointHints,
    finalizing: impl Fn() -> bool,
    mut checkpoint: F,
    timing: Timing,
) where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<bool, String>>,
{
    let mut saved_revision = 0;
    let mut observed_revision = 0;
    let mut retry = None;
    let mut attempts = 0u32;
    loop {
        let hinted = tokio::select! {
            _=hints.changed.notified()=>true,
            _=tokio::time::sleep(retry.unwrap_or(timing.watchdog))=>false,
        };
        if hinted {
            tokio::time::sleep(timing.settle).await;
        }
        let revision = hints.revision();
        if revision != observed_revision {
            attempts = 0;
            observed_revision = revision;
        }
        if hinted && revision == saved_revision && retry.is_none() {
            continue;
        }
        if finalizing() {
            retry = Some(timing.retry);
            continue;
        }
        let reason = if hinted || retry.is_some() {
            "completion"
        } else {
            "watchdog"
        };
        let confirmed = match checkpoint(reason).await {
            Ok(confirmed) => confirmed,
            Err(error) => {
                tracing::warn!(%error,reason,"background session checkpoint failed");
                false
            }
        };
        if confirmed {
            saved_revision = revision;
            retry = None;
            attempts = 0;
        } else {
            retry = Some(
                timing
                    .retry
                    .saturating_mul(1u32 << attempts.min(5))
                    .min(timing.cap),
            );
            attempts = attempts.saturating_add(1);
        }
    }
}
pub(super) fn start(app: tauri::AppHandle, state: std::sync::Arc<crate::state::AppState>) {
    tauri::async_runtime::spawn(async move {
        run(
            &state.session_checkpoint.hints,
            || state.session_checkpoint.is_finalizing(),
            |reason| {
                let app = app.clone();
                let state = state.clone();
                async move {
                    let commit =
                        super::request_frontend_checkpoint(&app, &state, reason, false).await?;
                    tauri::async_runtime::spawn_blocking(move || {
                        let store = crate::local_state::LocalStateStore::new(
                            crate::local_state::state_path().map_err(String::from)?,
                        );
                        store
                            .checkpoint_needs_retry(commit)
                            .map(|retry| !retry)
                            .map_err(String::from)
                    })
                    .await
                    .map_err(|e| e.to_string())?
                }
            },
            Timing::default(),
        )
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    #[tokio::test]
    async fn database_partial_ack_recovers_an_unknown_pane_without_a_new_hint() {
        use crate::local_state::{LocalSessionSnapshot, LocalStateStore};
        use std::sync::{atomic::AtomicUsize, Arc};
        let temp = tempfile::tempdir().unwrap();
        let store = LocalStateStore::new(temp.path().join("state.db"));
        let settings = crate::settings::Settings::default();
        let mut snapshot = LocalSessionSnapshot {
            workspaces: settings.workspaces,
            docks: settings.docks,
            ..Default::default()
        };
        let pane_id = snapshot.workspaces[0].panes[0].id.clone();
        snapshot.workspaces[0].panes[0].content_views_mut()[0].extra["lastCodexSession"] =
            "previous-conversation".into();
        store.commit_session(&snapshot).unwrap();
        let hints = Arc::new(CheckpointHints::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_hints = hints.clone();
        let worker_calls = calls.clone();
        let worker_store = store.clone();
        let worker = tokio::spawn(async move {
            run(&worker_hints, || false, |_| {
                let partial = worker_calls.load(Ordering::SeqCst) == 0;
                snapshot.coverage = serde_json::from_value(serde_json::json!([{
                    "terminalId":format!("terminal-{pane_id}"), "state": if partial {"unknown"} else {"identified"},
                    "generation":3,"provider":"codex","sessionId":"latest-conversation"
                }])).unwrap();
                snapshot.workspaces[0].panes[0].content_views_mut()[0].extra["lastCodexSession"] = "latest-conversation".into();
                let commit = worker_store.commit_session(&snapshot).unwrap();
                let confirmed = !worker_store.checkpoint_needs_retry(commit.revision).unwrap();
                worker_calls.fetch_add(1, Ordering::SeqCst);
                async move { Ok(confirmed) }
            }, Timing { settle: Duration::from_millis(1), retry: Duration::from_millis(2), cap: Duration::from_millis(8), watchdog: Duration::from_secs(300) }).await;
        });
        hints.request();
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert!(!store.checkpoint_needs_retry(2).unwrap());
        assert_eq!(
            store.load_session().unwrap().unwrap().workspaces[0].panes[0].content_views()[0]
                .1
                .extra["lastCodexSession"],
            "latest-conversation"
        );
        worker.abort();
    }

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
    #[tokio::test]
    async fn a_partial_success_retries_without_another_hint_and_stops_when_confirmed() {
        use std::sync::{atomic::AtomicUsize, Arc};
        let hints = Arc::new(CheckpointHints::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_hints = hints.clone();
        let worker_calls = calls.clone();
        let worker = tokio::spawn(async move {
            run(
                &worker_hints,
                || false,
                |_| {
                    let confirmed = worker_calls.fetch_add(1, Ordering::SeqCst) > 0;
                    async move { Ok(confirmed) }
                },
                Timing {
                    settle: Duration::from_millis(1),
                    retry: Duration::from_millis(2),
                    cap: Duration::from_millis(8),
                    watchdog: Duration::from_secs(300),
                },
            )
            .await;
        });
        hints.request();
        tokio::time::timeout(Duration::from_secs(1), async {
            while calls.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "confirmed checkpoint must not keep retrying"
        );
        worker.abort();
    }
}
