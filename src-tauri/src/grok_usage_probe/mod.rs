//! Demand-based Grok `/usage` collection (ADR-0154).
//!
//! A probe exists only while a `GrokUsageView` or `grokUsage` widget is
//! subscribed. Automation/MCP reads never start a worker.

mod parse;
mod snapshot;
mod worker;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::AppError;
use crate::lock_ext::MutexExt;

pub use parse::{parse_grok_usage_screen, GrokUsageRow};
pub use snapshot::{GrokProbeStatus, GrokUsageSnapshot};
pub use worker::WorkerSpec;

use worker::WorkerHandle;

pub type SnapshotSink = Arc<dyn Fn(&GrokUsageSnapshot) + Send + Sync>;

struct Entry {
    worker: Option<WorkerHandle>,
    subscribers: Vec<String>,
    snapshot: GrokUsageSnapshot,
}

impl Entry {
    fn new(config_dir: &str) -> Self {
        Self {
            worker: None,
            subscribers: Vec::new(),
            snapshot: GrokUsageSnapshot::idle(config_dir),
        }
    }
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    subscriptions: HashMap<String, String>,
}

pub struct GrokUsageProbe {
    registry: Arc<Mutex<Registry>>,
    sink: Arc<Mutex<Option<SnapshotSink>>>,
}

impl Default for GrokUsageProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl GrokUsageProbe {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(Registry::default())),
            sink: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_sink(&self, sink: SnapshotSink) -> Result<(), AppError> {
        *self.sink.lock_or_err()? = Some(sink);
        Ok(())
    }

    pub fn subscribe(
        &self,
        subscriber_id: &str,
        spec: WorkerSpec,
    ) -> Result<GrokUsageSnapshot, AppError> {
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

    pub fn unsubscribe(&self, subscriber_id: &str) -> Result<(), AppError> {
        if let Some(handle) = self.detach(subscriber_id)? {
            handle.shutdown();
        }
        Ok(())
    }

    pub fn snapshot(&self, config_dir: &str) -> Result<GrokUsageSnapshot, AppError> {
        let registry = self.registry.lock_or_err()?;
        Ok(registry
            .entries
            .get(config_dir)
            .map(|entry| entry.snapshot.clone())
            .unwrap_or_else(|| GrokUsageSnapshot::idle(config_dir)))
    }

    pub fn snapshots(&self) -> Result<Vec<GrokUsageSnapshot>, AppError> {
        let registry = self.registry.lock_or_err()?;
        let mut all: Vec<GrokUsageSnapshot> = registry
            .entries
            .values()
            .map(|entry| entry.snapshot.clone())
            .collect();
        all.sort_by(|a, b| a.config_dir.cmp(&b.config_dir));
        Ok(all)
    }

    pub fn shutdown_all(&self) -> Result<(), AppError> {
        let handles: Vec<WorkerHandle> = {
            let mut registry = self.registry.lock_or_err()?;
            registry.subscriptions.clear();
            registry
                .entries
                .values_mut()
                .filter_map(|entry| {
                    entry.subscribers.clear();
                    entry.snapshot.status = GrokProbeStatus::Idle;
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
        entry.snapshot.status = GrokProbeStatus::Idle;
        entry.snapshot.next_query_at_ms = None;
        Ok(entry.worker.take())
    }

    fn publisher(&self, config_dir: &str) -> worker::Publisher {
        let registry = Arc::clone(&self.registry);
        let sink = Arc::clone(&self.sink);
        let config_dir = config_dir.to_string();
        Arc::new(move |snapshot: GrokUsageSnapshot| {
            if let Ok(mut registry) = registry.lock_or_err() {
                if let Some(entry) = registry.entries.get_mut(&config_dir) {
                    if entry.subscribers.is_empty() {
                        return;
                    }
                    entry.snapshot = snapshot.clone();
                }
            }
            if let Ok(sink) = sink.lock_or_err() {
                if let Some(notify) = sink.as_ref() {
                    notify(&snapshot);
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_without_subscribe_is_idle() {
        let probe = GrokUsageProbe::new();
        let snapshot = probe.snapshot("").unwrap();
        assert_eq!(snapshot.status, GrokProbeStatus::Idle);
        assert!(snapshot.rows.is_empty());
    }

    #[test]
    fn refresh_without_worker_is_false() {
        let probe = GrokUsageProbe::new();
        assert!(!probe.request_refresh("").unwrap());
    }

    #[test]
    fn unsubscribe_unknown_id_is_ok() {
        let probe = GrokUsageProbe::new();
        probe.unsubscribe("missing").unwrap();
    }

    #[test]
    fn last_subscriber_leaving_marks_the_entry_idle() {
        let probe = GrokUsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry.entries.entry(String::new()).or_insert_with(|| {
                let mut entry = Entry::new("");
                entry.snapshot.status = GrokProbeStatus::Ready;
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
        assert_eq!(snapshot.status, GrokProbeStatus::Idle);
        assert_eq!(snapshot.captured_at_ms, Some(1));
    }

    #[test]
    fn a_remaining_subscriber_keeps_the_probe() {
        let probe = GrokUsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let entry = registry
                .entries
                .entry(String::new())
                .or_insert_with(|| Entry::new(""));
            entry.snapshot.status = GrokProbeStatus::Ready;
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
        assert_eq!(probe.snapshot("").unwrap().status, GrokProbeStatus::Ready);
    }

    #[test]
    fn publisher_ignores_a_late_publish_after_retirement() {
        let probe = GrokUsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            registry.entries.insert(String::new(), Entry::new(""));
        }
        let publish = probe.publisher("");
        let mut snapshot = GrokUsageSnapshot::idle("");
        snapshot.status = GrokProbeStatus::Ready;
        publish(snapshot);
        assert_eq!(probe.snapshot("").unwrap().status, GrokProbeStatus::Idle);
    }

    #[test]
    fn shutdown_all_marks_every_entry_idle() {
        let probe = GrokUsageProbe::new();
        {
            let mut registry = probe.registry.lock().unwrap();
            let mut entry = Entry::new("/a");
            entry.snapshot.status = GrokProbeStatus::Ready;
            entry.subscribers.push("view-1".into());
            registry.entries.insert("/a".into(), entry);
            registry.subscriptions.insert("view-1".into(), "/a".into());
        }
        probe.shutdown_all().unwrap();
        assert_eq!(probe.snapshot("/a").unwrap().status, GrokProbeStatus::Idle);
        assert!(!probe.request_refresh("/a").unwrap());
    }
}
