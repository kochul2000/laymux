//! Claude usage collection.
//!
//! Owns headless `claude` probes — one per `CLAUDE_CONFIG_DIR` — and caches the
//! raw snapshot each produces. Per [ADR-0099] a probe exists only while some
//! `UsageView` is subscribed to it, and the probe PTY never appears in the
//! terminal registry.
//!
//! Lock discipline: worker threads publish through `registry`, and shutting a
//! worker down joins its thread. Therefore a `WorkerHandle` is always taken out
//! from under the lock and shut down after the guard is dropped.

mod parse;
mod schedule;
mod screen;
mod session;
mod snapshot;
mod worker;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::AppError;
use crate::lock_ext::MutexExt;

pub use schedule::{sanitize_refresh_seconds, MAX_REFRESH_SECS, MIN_REFRESH_SECS};
pub use snapshot::{ProbeStatus, UsageLimit, UsageSnapshot};
pub use worker::WorkerSpec;

use worker::WorkerHandle;

/// Notified whenever a snapshot changes, so the frontend does not have to poll
/// to notice a fresh capture.
pub type SnapshotSink = Arc<dyn Fn(&UsageSnapshot) + Send + Sync>;

struct Entry {
    worker: Option<WorkerHandle>,
    /// Subscriber ids (view instance ids) keeping this probe alive.
    subscribers: Vec<String>,
    snapshot: UsageSnapshot,
}

impl Entry {
    fn new(config_dir: &str) -> Self {
        Self {
            worker: None,
            subscribers: Vec::new(),
            snapshot: UsageSnapshot::idle(config_dir),
        }
    }
}

#[derive(Default)]
struct Registry {
    /// Keyed by config dir. Empty string is the default config dir.
    entries: HashMap<String, Entry>,
    /// Subscriber id -> config dir, so unsubscribe needs only the id.
    subscriptions: HashMap<String, String>,
}

pub struct UsageProbe {
    registry: Arc<Mutex<Registry>>,
    sink: Arc<Mutex<Option<SnapshotSink>>>,
}

impl Default for UsageProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageProbe {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(Registry::default())),
            sink: Arc::new(Mutex::new(None)),
        }
    }

    /// Install the change notifier. Called once during app setup.
    pub fn set_sink(&self, sink: SnapshotSink) -> Result<(), AppError> {
        *self.sink.lock_or_err()? = Some(sink);
        Ok(())
    }

    /// Register interest in a config dir, spawning its probe if this is the
    /// first subscriber. Returns the snapshot known right now — possibly a
    /// stale one from a previous worker, which the caller shows while the fresh
    /// query is in flight.
    ///
    /// Re-subscribing the same id moves it to the new config dir.
    pub fn subscribe(
        &self,
        subscriber_id: &str,
        spec: WorkerSpec,
    ) -> Result<UsageSnapshot, AppError> {
        // Re-subscribing the same id to the same config dir is a no-op on
        // demand. Detaching first would momentarily drop demand to zero and
        // retire a healthy `claude`, only to spawn a replacement.
        let already_here = {
            let registry = self.registry.lock_or_err()?;
            registry.subscriptions.get(subscriber_id) == Some(&spec.config_dir)
        };
        if !already_here {
            if let Some(retired) = self.detach(subscriber_id)? {
                retired.shutdown();
            }
        }

        let config_dir = spec.config_dir.clone();
        let needs_worker = {
            let mut registry = self.registry.lock_or_err()?;
            registry
                .subscriptions
                .insert(subscriber_id.to_string(), config_dir.clone());
            let entry = registry
                .entries
                .entry(config_dir.clone())
                .or_insert_with(|| Entry::new(&config_dir));
            if !entry.subscribers.iter().any(|id| id == subscriber_id) {
                entry.subscribers.push(subscriber_id.to_string());
            }
            entry.worker.is_none()
        };

        if needs_worker {
            let handle = worker::spawn(spec, self.publisher(&config_dir));
            let orphaned = {
                let mut registry = self.registry.lock_or_err()?;
                match registry.entries.get_mut(&config_dir) {
                    // Demand can vanish between the two locks. Retire the worker
                    // we just spawned rather than leave `claude` running with no
                    // subscriber.
                    Some(entry) if !entry.subscribers.is_empty() => {
                        entry.worker = Some(handle);
                        None
                    }
                    _ => Some(handle),
                }
            };
            if let Some(handle) = orphaned {
                handle.shutdown();
            }
        }

        self.snapshot(&config_dir)
    }

    /// Drop a subscriber. The probe is torn down once nobody is left.
    pub fn unsubscribe(&self, subscriber_id: &str) -> Result<(), AppError> {
        if let Some(handle) = self.detach(subscriber_id)? {
            handle.shutdown();
        }
        Ok(())
    }

    /// Latest snapshot for a config dir. Never spawns a probe.
    pub fn snapshot(&self, config_dir: &str) -> Result<UsageSnapshot, AppError> {
        let registry = self.registry.lock_or_err()?;
        Ok(registry
            .entries
            .get(config_dir)
            .map(|entry| entry.snapshot.clone())
            .unwrap_or_else(|| UsageSnapshot::idle(config_dir)))
    }

    /// Every known snapshot, for the read-only Automation contract.
    pub fn snapshots(&self) -> Result<Vec<UsageSnapshot>, AppError> {
        let registry = self.registry.lock_or_err()?;
        let mut all: Vec<UsageSnapshot> = registry
            .entries
            .values()
            .map(|entry| entry.snapshot.clone())
            .collect();
        all.sort_by(|a, b| a.config_dir.cmp(&b.config_dir));
        Ok(all)
    }

    /// Ask a running probe to query now. Returns false when no probe is running
    /// — a refresh request must never bring `claude` up as a side effect.
    pub fn request_refresh(&self, config_dir: &str) -> Result<bool, AppError> {
        let registry = self.registry.lock_or_err()?;
        match registry
            .entries
            .get(config_dir)
            .and_then(|entry| entry.worker.as_ref())
        {
            Some(worker) => {
                worker.request_refresh();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Retire every probe. Called on app shutdown.
    pub fn shutdown_all(&self) -> Result<(), AppError> {
        let handles: Vec<WorkerHandle> = {
            let mut registry = self.registry.lock_or_err()?;
            registry.subscriptions.clear();
            registry
                .entries
                .values_mut()
                .filter_map(|entry| {
                    entry.subscribers.clear();
                    entry.snapshot.status = ProbeStatus::Idle;
                    entry.snapshot.next_query_at_ms = None;
                    entry.worker.take()
                })
                .collect()
        };
        for handle in handles {
            handle.shutdown();
        }
        Ok(())
    }

    /// Remove the subscriber and, if that emptied its entry, hand back the
    /// worker for the caller to shut down outside the lock.
    fn detach(&self, subscriber_id: &str) -> Result<Option<WorkerHandle>, AppError> {
        let mut registry = self.registry.lock_or_err()?;
        let Some(config_dir) = registry.subscriptions.remove(subscriber_id) else {
            return Ok(None);
        };
        let Some(entry) = registry.entries.get_mut(&config_dir) else {
            return Ok(None);
        };
        entry.subscribers.retain(|id| id != subscriber_id);
        if !entry.subscribers.is_empty() {
            return Ok(None);
        }
        // Keep the entry so its last capture survives for a future subscriber;
        // only the `claude` process goes away.
        entry.snapshot.status = ProbeStatus::Idle;
        entry.snapshot.next_query_at_ms = None;
        Ok(entry.worker.take())
    }

    /// Callback handed to a worker: store the snapshot, then notify.
    fn publisher(&self, config_dir: &str) -> worker::Publisher {
        let registry = Arc::clone(&self.registry);
        let sink = Arc::clone(&self.sink);
        let config_dir = config_dir.to_string();
        Arc::new(move |snapshot: UsageSnapshot| {
            if let Ok(mut guard) = registry.lock() {
                if let Some(entry) = guard.entries.get_mut(&config_dir) {
                    // A retired entry keeps its Idle status; a late publish from
                    // a worker being torn down must not resurrect it.
                    if entry.subscribers.is_empty() {
                        return;
                    }
                    entry.snapshot = snapshot.clone();
                }
            }
            let sink = sink.lock().ok().and_then(|guard| guard.clone());
            if let Some(sink) = sink {
                sink(&snapshot);
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(config_dir: &str) -> WorkerSpec {
        WorkerSpec {
            config_dir: config_dir.to_string(),
            profile: "PowerShell".into(),
            command_line: String::new(),
            starting_directory: String::new(),
            refresh_seconds: 600,
        }
    }

    /// A subscribe/unsubscribe cycle without spawning a real worker: an empty
    /// `command_line` makes the PTY spawn fail fast, which is enough to exercise
    /// the registry bookkeeping.
    #[test]
    fn snapshot_for_unknown_config_dir_is_idle() {
        let probe = UsageProbe::new();
        let snapshot = probe.snapshot("/nowhere").unwrap();
        assert_eq!(snapshot.status, ProbeStatus::Idle);
        assert_eq!(snapshot.config_dir, "/nowhere");
    }

    #[test]
    fn refresh_does_not_start_a_probe() {
        // Reads must never have the side effect of launching `claude`.
        let probe = UsageProbe::new();
        assert!(!probe.request_refresh("").unwrap());
        assert!(probe.snapshots().unwrap().is_empty());
    }

    #[test]
    fn unsubscribing_an_unknown_id_is_a_no_op() {
        let probe = UsageProbe::new();
        probe.unsubscribe("view-does-not-exist").unwrap();
    }

    #[test]
    fn snapshots_are_sorted_by_config_dir() {
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            for dir in ["/b", "/a", "/c"] {
                registry.entries.insert(dir.to_string(), Entry::new(dir));
            }
        }
        let dirs: Vec<String> = probe
            .snapshots()
            .unwrap()
            .into_iter()
            .map(|s| s.config_dir)
            .collect();
        assert_eq!(dirs, vec!["/a", "/b", "/c"]);
    }

    #[test]
    fn last_subscriber_leaving_marks_the_entry_idle() {
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry.entries.entry(String::new()).or_insert_with(|| {
                let mut entry = Entry::new("");
                entry.snapshot.status = ProbeStatus::Ready;
                entry.snapshot.captured_at_ms = Some(1);
                entry
            });
            entry.subscribers.push("view-1".into());
            registry
                .subscriptions
                .insert("view-1".into(), String::new());
        }

        probe.unsubscribe("view-1").unwrap();

        let snapshot = probe.snapshot("").unwrap();
        assert_eq!(snapshot.status, ProbeStatus::Idle);
        // The last capture is kept so a future subscriber has something to show.
        assert_eq!(snapshot.captured_at_ms, Some(1));
    }

    #[test]
    fn a_remaining_subscriber_keeps_the_probe() {
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry
                .entries
                .entry(String::new())
                .or_insert_with(|| Entry::new(""));
            entry.snapshot.status = ProbeStatus::Ready;
            entry.subscribers.push("view-1".into());
            entry.subscribers.push("view-2".into());
            registry
                .subscriptions
                .insert("view-1".into(), String::new());
            registry
                .subscriptions
                .insert("view-2".into(), String::new());
        }

        probe.unsubscribe("view-1").unwrap();
        assert_eq!(probe.snapshot("").unwrap().status, ProbeStatus::Ready);
    }

    #[test]
    fn resubscribing_the_same_id_and_dir_keeps_the_running_worker() {
        // Guards the live failure mode: a repeated subscribe must not retire the
        // probe the mounted view is waiting on.
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry
                .entries
                .entry(String::new())
                .or_insert_with(|| Entry::new(""));
            entry.subscribers.push("view-1".into());
            entry.snapshot.status = ProbeStatus::Ready;
            registry
                .subscriptions
                .insert("view-1".into(), String::new());
        }

        // An empty command line makes any worker spawn fail fast, so if this
        // path retired and respawned, the status would not survive as Ready.
        probe.subscribe("view-1", spec("")).unwrap();

        let snapshot = probe.snapshot("").unwrap();
        assert_eq!(snapshot.status, ProbeStatus::Ready);
        let registry = probe.registry.lock().unwrap();
        assert_eq!(registry.entries[""].subscribers, vec!["view-1".to_string()]);
    }

    #[test]
    fn publisher_ignores_a_late_publish_after_retirement() {
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            registry.entries.insert(String::new(), Entry::new(""));
        }
        let publish = probe.publisher("");
        let mut snapshot = UsageSnapshot::idle("");
        snapshot.status = ProbeStatus::Ready;
        publish(snapshot);
        // No subscribers, so the retired entry must stay idle.
        assert_eq!(probe.snapshot("").unwrap().status, ProbeStatus::Idle);
    }

    #[test]
    fn publisher_stores_snapshots_for_a_live_entry() {
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry
                .entries
                .entry(String::new())
                .or_insert_with(|| Entry::new(""));
            entry.subscribers.push("view-1".into());
        }
        let publish = probe.publisher("");
        let mut snapshot = UsageSnapshot::idle("");
        snapshot.status = ProbeStatus::Ready;
        snapshot.session.percent = Some(42);
        publish(snapshot);

        let stored = probe.snapshot("").unwrap();
        assert_eq!(stored.status, ProbeStatus::Ready);
        assert_eq!(stored.session.percent, Some(42));
    }

    #[test]
    fn sink_receives_published_snapshots() {
        let probe = UsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry
                .entries
                .entry(String::new())
                .or_insert_with(|| Entry::new(""));
            entry.subscribers.push("view-1".into());
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        probe
            .set_sink(Arc::new(move |snapshot: &UsageSnapshot| {
                recorder.lock().unwrap().push(snapshot.status.clone());
            }))
            .unwrap();

        let publish = probe.publisher("");
        publish(UsageSnapshot::idle("").with_status(ProbeStatus::Starting));

        assert_eq!(seen.lock().unwrap().as_slice(), &[ProbeStatus::Starting]);
    }

    #[test]
    fn spec_carries_the_config_dir_key() {
        assert_eq!(spec("/x").config_dir, "/x");
    }
}
