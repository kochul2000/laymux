//! Backend-served frontend vitals (issue #606).
//!
//! Every Automation endpoint that needs UI state goes through `bridge_request`,
//! which emits `automation-request` and waits for the WebView to answer. When the
//! WebView main thread is saturated — an output flood plus a layout change is the
//! reproduction — every one of those endpoints returns
//! `504 Frontend response timeout` and no diagnosis is possible from the outside:
//! the only endpoint still answering is `/api/v1/health`, which never leaves Rust
//! and therefore says nothing about the frontend.
//!
//! This module gives the frontend's own vitals that same property. The WebView
//! pushes a small report on a timer (`report_frontend_health`); Rust keeps the
//! last one plus its own bridge counters, and `GET /api/v1/diagnostics/frontend`
//! serves both without a bridge round-trip. The *age* of the last report is the
//! primary signal — it is readable while the stall is happening.
//!
//! Everything here is diagnostic. No control path reads it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;
use crate::lock_ext::MutexExt;

/// Wall-clock milliseconds since the Unix epoch.
///
/// Wall clock, not `Instant`, because the frontend compares against `Date.now()`
/// and the deadline it receives has to mean the same thing on both sides.
pub fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Bridge counters plus the last report the frontend pushed.
#[derive(Debug, Default)]
pub struct FrontendHealthState {
    /// `automation-request` events emitted.
    requests_emitted: AtomicU64,
    /// Responses that found their pending channel — the frontend answered in time.
    responses_matched: AtomicU64,
    /// Responses that arrived after the request had already been given up on.
    ///
    /// The frontend paid full main-thread cost for these and the HTTP caller
    /// already received its `504`. A nonzero value with a flat
    /// `responses_matched` is the signature of a bridge starved behind its own
    /// queue rather than of handlers that are individually slow.
    responses_orphaned: AtomicU64,
    /// Requests that hit `FRONTEND_RESPONSE_TIMEOUT`.
    request_timeouts: AtomicU64,
    /// Requests where the oneshot was dropped without a response.
    request_disconnects: AtomicU64,
    /// The last report pushed by the frontend, verbatim, plus when it landed.
    last_report: Mutex<Option<(u64, serde_json::Value)>>,
}

impl FrontendHealthState {
    pub fn note_request_emitted(&self) {
        self.requests_emitted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_request_timeout(&self) {
        self.request_timeouts.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_request_disconnect(&self) {
        self.request_disconnects.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_response_matched(&self) {
        self.responses_matched.fetch_add(1, Ordering::Relaxed);
    }

    /// Count a response nobody is waiting for. Returns the running total so the
    /// caller can log a countable number instead of an uncountable event.
    pub fn note_response_orphaned(&self) -> u64 {
        self.responses_orphaned.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Replace the stored report.
    ///
    /// A poisoned lock is surfaced to the command caller instead of making a
    /// failed write look like a healthy-but-stalled frontend.
    pub fn store_report(&self, report: serde_json::Value) -> Result<(), AppError> {
        let mut slot = self.last_report.lock_or_err()?;
        *slot = Some((epoch_millis(), report));
        Ok(())
    }

    pub fn snapshot(&self) -> Result<serde_json::Value, AppError> {
        let now = epoch_millis();
        let slot = self.last_report.lock_or_err()?;
        let (received_at_ms, report) = match slot.as_ref() {
            Some((at, value)) => (Some(*at), Some(value.clone())),
            None => (None, None),
        };
        Ok(serde_json::json!({
            "nowMs": now,
            // `null` means the frontend has never reported — a build without the
            // probe, or a WebView that has not finished booting. Distinguishing
            // that from "stalled" matters when reading a live reproduction.
            "lastReportAgeMs": received_at_ms.map(|at| now.saturating_sub(at)),
            "lastReportAtMs": received_at_ms,
            "bridge": {
                "requestsEmitted": self.requests_emitted.load(Ordering::Relaxed),
                "responsesMatched": self.responses_matched.load(Ordering::Relaxed),
                "responsesOrphaned": self.responses_orphaned.load(Ordering::Relaxed),
                "requestTimeouts": self.request_timeouts.load(Ordering::Relaxed),
                "requestDisconnects": self.request_disconnects.load(Ordering::Relaxed),
            },
            "frontend": report,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_no_frontend_before_the_first_report() {
        let state = FrontendHealthState::default();
        let snapshot = state.snapshot().unwrap();
        assert!(snapshot["lastReportAgeMs"].is_null());
        assert!(snapshot["frontend"].is_null());
        assert_eq!(snapshot["bridge"]["requestsEmitted"], 0);
    }

    #[test]
    fn snapshot_carries_bridge_counters_and_the_last_report() {
        let state = FrontendHealthState::default();
        state.note_request_emitted();
        state.note_request_emitted();
        state.note_request_timeout();
        state.note_response_matched();
        assert_eq!(state.note_response_orphaned(), 1);
        assert_eq!(state.note_response_orphaned(), 2);
        state
            .store_report(serde_json::json!({ "probeLagMaxMs": 42 }))
            .unwrap();

        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot["bridge"]["requestsEmitted"], 2);
        assert_eq!(snapshot["bridge"]["requestTimeouts"], 1);
        assert_eq!(snapshot["bridge"]["responsesMatched"], 1);
        assert_eq!(snapshot["bridge"]["responsesOrphaned"], 2);
        assert_eq!(snapshot["frontend"]["probeLagMaxMs"], 42);
        assert!(snapshot["lastReportAgeMs"].as_u64().is_some());
    }

    #[test]
    fn store_report_returns_lock_error_instead_of_hiding_poison() {
        let state = FrontendHealthState::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.last_report.lock().unwrap();
            panic!("intentional poison");
        }));

        let error = state
            .store_report(serde_json::json!({ "probeLagMaxMs": 42 }))
            .unwrap_err();
        assert!(matches!(error, crate::error::AppError::Lock(_)));
    }

    #[test]
    fn snapshot_returns_lock_error_instead_of_reporting_never_seen() {
        let state = FrontendHealthState::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.last_report.lock().unwrap();
            panic!("intentional poison");
        }));

        let error = state.snapshot().unwrap_err();
        assert!(matches!(error, crate::error::AppError::Lock(_)));
    }
}
