//! Dev counters measure real OS/guest runs, including runs outside the worker.
#[cfg(debug_assertions)]
use std::{
    collections::{HashMap, VecDeque},
    sync::{LazyLock, Mutex},
    time::Instant,
};

#[cfg(debug_assertions)]
#[derive(Default)]
struct Metrics {
    native: u64,
    guest: HashMap<String, u64>,
    passes: VecDeque<(Instant, Vec<String>)>,
}
#[cfg(debug_assertions)]
static METRICS: LazyLock<Mutex<Metrics>> = LazyLock::new(|| Mutex::new(Metrics::default()));

pub(crate) fn native() {
    #[cfg(debug_assertions)]
    if let Ok(mut metrics) = METRICS.lock() {
        metrics.native += 1;
    }
}

pub(crate) fn guest(distro: &str, probe: &str) {
    #[cfg(debug_assertions)]
    if let Ok(mut metrics) = METRICS.lock() {
        let key = format!("{distro}:{probe}");
        if metrics.guest.len() < 128 || metrics.guest.contains_key(&key) {
            *metrics.guest.entry(key).or_default() += 1;
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (distro, probe);
}

pub(super) fn pass(ids: &std::collections::HashSet<String>) {
    #[cfg(debug_assertions)]
    if !ids.is_empty() {
        if let Ok(mut metrics) = METRICS.lock() {
            let mut ids: Vec<_> = ids.iter().cloned().collect();
            ids.sort();
            metrics.passes.push_back((Instant::now(), ids));
            if metrics.passes.len() > 128 {
                metrics.passes.pop_front();
            }
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = ids;
}

pub(crate) fn snapshot() -> serde_json::Value {
    #[cfg(debug_assertions)]
    if let Ok(metrics) = METRICS.lock() {
        return serde_json::json!({ "nativeSnapshots": metrics.native, "guestRuns": metrics.guest,
            "passes": metrics.passes.iter().map(|(at, ids)| serde_json::json!({ "ageMs": at.elapsed().as_millis(), "ids": ids })).collect::<Vec<_>>() });
    }
    serde_json::json!({})
}
