//! OS sleep prevention (ADR-0114).
//!
//! The frontend owns *when* sleep should be inhibited — it derives one boolean
//! from the user's mode setting and the busy state of the terminals. This
//! module owns *how*: it is the only place in the process that acquires or
//! releases an OS-level sleep inhibitor, so a leak has exactly one suspect.
//!
//! Only system sleep is inhibited. The display is left alone: the user asked
//! not to be put to sleep mid-run, not to have the screen burn all night.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::error::AppError;
use crate::lock_ext::MutexExt;

/// How often a held inhibitor is checked for having died behind our back.
///
/// The frontend only calls in on a *change*, so without this a `systemd-inhibit`
/// child killed from outside would stay unnoticed for as long as the user's
/// mode and terminals hold still — which in `always` mode is forever.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);

/// Platform-specific half of the inhibitor.
///
/// `apply` is called when the desired state changes, and again with `true` when
/// `needs_reapply` reports that a held inhibitor died. Those are the only two
/// cases, so an implementation does not have to deduplicate a steady state.
pub trait InhibitBackend: Send {
    fn apply(&mut self, enabled: bool) -> Result<(), AppError>;

    /// Whether an inhibitor this backend reported as held has since died and
    /// must be acquired again.
    ///
    /// A backend that owns an OS resource which can disappear behind its back
    /// (a child process) overrides this; one whose resource lives as long as
    /// the process does not. Consulted only while the inhibitor is believed
    /// active, so a `true` here turns the next redundant-looking enable into a
    /// real one instead of a silent no-op.
    fn needs_reapply(&mut self) -> bool {
        false
    }
}

struct Inner {
    /// What the frontend asked for.
    desired: bool,
    /// What is actually held. Only ever set from a successful `apply`.
    held: bool,
    backend: Box<dyn InhibitBackend>,
}

impl Inner {
    /// Bring `held` in line with `desired`, acquiring or releasing as needed.
    ///
    /// Separating the two is what keeps a failure honest: an acquire that threw
    /// leaves `held` false, so the UI is not told the machine is being kept
    /// awake and the watchdog has something to retry.
    fn reconcile(&mut self) -> Result<(), AppError> {
        if self.desired {
            if self.held && !self.backend.needs_reapply() {
                return Ok(());
            }
            // A failed acquire is not a held inhibitor, whatever we believed
            // a moment ago.
            self.held = false;
            self.backend.apply(true)?;
            self.held = true;
        } else {
            if !self.held {
                return Ok(());
            }
            // A failed release may well have left it held; say so rather than
            // recording a release that did not happen.
            self.backend.apply(false)?;
            self.held = false;
        }
        Ok(())
    }
}

/// Process-wide owner of the OS sleep inhibitor.
///
/// The mutex protects only this struct. Nothing acquires it while holding
/// another `AppState` lock, so it joins no lock ordering (api-contracts §14.3).
/// Notified whenever the state actually in effect changes, with
/// `(held, satisfied)` — `satisfied` is false when the last attempt did not
/// deliver what was asked for.
pub type SleepInhibitorSink = Arc<dyn Fn(bool, bool) + Send + Sync>;

pub struct SleepInhibitor {
    inner: Mutex<Inner>,
    watchdog_started: AtomicBool,
    /// Installed once at startup. Without it the watchdog could acquire or lose
    /// an inhibitor and the UI would never hear: the frontend only reports
    /// *changes*, so its own dedupe means no request comes to carry the news.
    sink: Mutex<Option<SleepInhibitorSink>>,
}

impl SleepInhibitor {
    pub fn new() -> Self {
        Self::with_backend(Box::new(platform::PlatformBackend::new()))
    }

    pub fn with_backend(backend: Box<dyn InhibitBackend>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                desired: false,
                held: false,
                backend,
            }),
            watchdog_started: AtomicBool::new(false),
            sink: Mutex::new(None),
        }
    }

    /// Install the state-change notifier. Replaces any previous one.
    pub fn set_sink(&self, sink: SleepInhibitorSink) -> Result<(), AppError> {
        self.sink.lock_or_err()?.replace(sink);
        Ok(())
    }

    /// Notify outside the state lock: a sink emits a Tauri event, and holding
    /// the inhibitor mutex across that would invite a stall.
    fn notify(&self, held: bool, satisfied: bool) {
        let sink = match self.sink.lock_or_err() {
            Ok(guard) => guard.clone(),
            Err(error) => {
                tracing::warn!(%error, "failed to read the sleep inhibitor sink");
                return;
            }
        };
        if let Some(sink) = sink {
            sink(held, satisfied);
        }
    }

    /// Re-check the OS resource and bring it back in line with what was asked.
    ///
    /// Covers an inhibitor that died behind our back *and* one that was never
    /// acquired because the first attempt failed. A no-op when nothing is
    /// wanted and nothing is held.
    pub fn revalidate(&self) -> Result<(), AppError> {
        let (before, outcome, held) = {
            let mut guard = self.inner.lock_or_err()?;
            let inner = &mut *guard;
            let before = inner.held;
            let outcome = inner.reconcile();
            (before, outcome, inner.held)
        };
        if held != before {
            if held {
                tracing::warn!("sleep inhibitor was missing and has been acquired again");
            } else {
                tracing::warn!("sleep inhibitor is no longer held");
            }
        }
        // The watchdog is the only thing that sees these transitions — the
        // frontend reports changes, so its own dedupe means no request comes
        // along to carry the news. The UI hears it here or not at all.
        if held != before || outcome.is_err() {
            self.notify(held, outcome.is_ok());
        }
        outcome
    }

    /// Start the background reconcile loop, at most once per inhibitor.
    ///
    /// Called at startup rather than on the first acquire, and again from the
    /// command path: tying it to a single moment would let one failed spawn
    /// disable it for the session, and it is the only thing that retries an
    /// acquire the frontend will never ask for twice.
    ///
    /// Returns whether a watchdog is running.
    pub fn ensure_watchdog(self: &Arc<Self>) -> bool {
        if self.watchdog_started.swap(true, Ordering::SeqCst) {
            return true;
        }
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("sleep-inhibitor-watchdog".into())
            .spawn(move || loop {
                std::thread::sleep(WATCHDOG_INTERVAL);
                // The app is gone; so is any inhibitor it held.
                let Some(inhibitor) = weak.upgrade() else {
                    return;
                };
                if let Err(error) = inhibitor.revalidate() {
                    tracing::warn!(%error, "failed to revalidate the sleep inhibitor");
                }
            });
        match spawned {
            Ok(_) => true,
            Err(error) => {
                // Leave the flag clear so the next request tries again.
                self.watchdog_started.store(false, Ordering::SeqCst);
                tracing::warn!(%error, "failed to start the sleep inhibitor watchdog");
                false
            }
        }
    }

    /// Hold or release the inhibitor. Idempotent: a request for the state the
    /// process is already in touches no OS resource.
    ///
    /// Returns what is actually held afterwards, which is not always what was
    /// asked for — on failure it returns the error and the caller can read the
    /// last known state from [`Self::is_active`].
    pub fn set(&self, enabled: bool) -> Result<bool, AppError> {
        let mut guard = self.inner.lock_or_err()?;
        let inner = &mut *guard;
        inner.desired = enabled;
        inner.reconcile()?;
        tracing::info!(
            desired = enabled,
            held = inner.held,
            "sleep inhibitor updated"
        );
        Ok(inner.held)
    }

    /// Whether an inhibitor is actually held right now.
    pub fn is_active(&self) -> Result<bool, AppError> {
        Ok(self.inner.lock_or_err()?.held)
    }
}

impl Default for SleepInhibitor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        let inner = self
            .inner
            .get_mut_or_recover_for_discard("sleep inhibitor drop");
        inner.desired = false;
        if !inner.held {
            return;
        }
        if let Err(error) = inner.backend.apply(false) {
            tracing::warn!(%error, "failed to release sleep inhibitor on drop");
            return;
        }
        inner.held = false;
    }
}

/// Platform backends. Split out because the module runs past the 500-line
/// guideline once all three are inlined (api-contracts §14.1); the split is by
/// target, so exactly one is ever compiled.
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
#[cfg(not(any(windows, target_os = "linux")))]
#[path = "unsupported.rs"]
mod platform;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    struct RecordingBackend {
        calls: Arc<Mutex<Vec<bool>>>,
        fail_next: Arc<AtomicUsize>,
        died: Arc<AtomicBool>,
    }

    impl InhibitBackend for RecordingBackend {
        fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
            if self.fail_next.load(Ordering::SeqCst) > 0 {
                self.fail_next.fetch_sub(1, Ordering::SeqCst);
                return Err(AppError::Other("backend refused".into()));
            }
            self.calls
                .lock()
                .expect("recording backend lock")
                .push(enabled);
            Ok(())
        }

        fn needs_reapply(&mut self) -> bool {
            // Report once, like a real backend that reaps the dead child.
            self.died.swap(false, Ordering::SeqCst)
        }
    }

    struct Harness {
        inhibitor: SleepInhibitor,
        calls: Arc<Mutex<Vec<bool>>>,
        fail_next: Arc<AtomicUsize>,
        died: Arc<AtomicBool>,
    }

    impl Harness {
        fn applied(&self) -> Vec<bool> {
            self.calls.lock().expect("recording backend lock").clone()
        }
    }

    fn recording() -> Harness {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fail_next = Arc::new(AtomicUsize::new(0));
        let died = Arc::new(AtomicBool::new(false));
        let inhibitor = SleepInhibitor::with_backend(Box::new(RecordingBackend {
            calls: calls.clone(),
            fail_next: fail_next.clone(),
            died: died.clone(),
        }));
        Harness {
            inhibitor,
            calls,
            fail_next,
            died,
        }
    }

    #[test]
    fn starts_inactive() {
        let harness = recording();
        assert!(!harness.inhibitor.is_active().unwrap());
        assert!(harness.applied().is_empty());
    }

    #[test]
    fn repeated_enable_touches_the_backend_once() {
        let harness = recording();
        assert!(harness.inhibitor.set(true).unwrap());
        assert!(harness.inhibitor.set(true).unwrap());
        assert!(harness.inhibitor.set(true).unwrap());
        assert_eq!(harness.applied(), vec![true]);
        assert!(harness.inhibitor.is_active().unwrap());
    }

    #[test]
    fn disable_while_inactive_is_a_no_op() {
        let harness = recording();
        assert!(!harness.inhibitor.set(false).unwrap());
        assert!(harness.applied().is_empty());
    }

    #[test]
    fn toggling_applies_each_transition() {
        let harness = recording();
        harness.inhibitor.set(true).unwrap();
        harness.inhibitor.set(false).unwrap();
        harness.inhibitor.set(true).unwrap();
        assert_eq!(harness.applied(), vec![true, false, true]);
    }

    #[test]
    fn a_failed_apply_leaves_the_state_unchanged() {
        // Otherwise the process would believe it holds an inhibitor it never
        // acquired, and would then skip the next enable as a duplicate.
        let harness = recording();
        harness.fail_next.store(1, Ordering::SeqCst);
        assert!(harness.inhibitor.set(true).is_err());
        assert!(!harness.inhibitor.is_active().unwrap());

        assert!(harness.inhibitor.set(true).unwrap());
        assert_eq!(harness.applied(), vec![true]);
    }

    #[test]
    fn an_inhibitor_that_died_behind_our_back_is_acquired_again() {
        // A `systemd-inhibit` child can be killed from outside. Without this the
        // dedupe would treat every later enable as already satisfied and the
        // machine would sleep while the UI insists it is awake.
        let harness = recording();
        harness.inhibitor.set(true).unwrap();
        assert_eq!(harness.applied(), vec![true]);

        harness.died.store(true, Ordering::SeqCst);
        assert!(harness.inhibitor.set(true).unwrap());
        assert_eq!(harness.applied(), vec![true, true]);

        // And the revived inhibitor is deduped normally again.
        assert!(harness.inhibitor.set(true).unwrap());
        assert_eq!(harness.applied(), vec![true, true]);
    }

    #[test]
    fn revalidate_reacquires_an_inhibitor_that_died() {
        // What the watchdog calls. The frontend only reports *changes*, so in
        // "always" mode nothing else would ever notice the loss.
        let harness = recording();
        harness.inhibitor.set(true).unwrap();

        harness.died.store(true, Ordering::SeqCst);
        harness.inhibitor.revalidate().unwrap();
        assert_eq!(harness.applied(), vec![true, true]);
        assert!(harness.inhibitor.is_active().unwrap());
    }

    #[test]
    fn a_failed_reacquire_is_not_reported_as_held() {
        // The dangerous lie: the watchdog notices the loss, fails to get it
        // back, and the UI keeps showing a lit icon over a machine that sleeps.
        let harness = recording();
        harness.inhibitor.set(true).unwrap();

        harness.died.store(true, Ordering::SeqCst);
        harness.fail_next.store(1, Ordering::SeqCst);
        assert!(harness.inhibitor.revalidate().is_err());
        assert!(!harness.inhibitor.is_active().unwrap());
    }

    #[test]
    fn the_watchdog_retries_an_acquire_that_never_succeeded() {
        // The frontend reports *changes*, so a first attempt that failed is
        // never repeated from that side. Wanting it is enough to keep trying.
        let harness = recording();
        harness.fail_next.store(1, Ordering::SeqCst);
        assert!(harness.inhibitor.set(true).is_err());
        assert!(!harness.inhibitor.is_active().unwrap());
        assert!(harness.applied().is_empty());

        harness.inhibitor.revalidate().unwrap();
        assert!(harness.inhibitor.is_active().unwrap());
        assert_eq!(harness.applied(), vec![true]);
    }

    #[test]
    fn a_failed_release_keeps_reporting_it_as_held() {
        // Recording a release that did not happen would strand the machine
        // awake with nothing left to notice.
        let harness = recording();
        harness.inhibitor.set(true).unwrap();

        harness.fail_next.store(1, Ordering::SeqCst);
        assert!(harness.inhibitor.set(false).is_err());
        assert!(harness.inhibitor.is_active().unwrap());

        // Wanting it off is remembered, so the next attempt retries the release.
        harness.inhibitor.revalidate().unwrap();
        assert!(!harness.inhibitor.is_active().unwrap());
        assert_eq!(harness.applied(), vec![true, false]);
    }

    #[test]
    fn revalidate_does_nothing_while_the_inhibitor_is_alive_or_unheld() {
        let harness = recording();
        harness.inhibitor.revalidate().unwrap();
        assert!(harness.applied().is_empty());

        harness.inhibitor.set(true).unwrap();
        harness.inhibitor.revalidate().unwrap();
        assert_eq!(harness.applied(), vec![true]);
    }

    #[test]
    fn a_dead_inhibitor_is_not_consulted_while_sleep_is_allowed() {
        // `needs_reapply` answers "does the held lock still exist"; with nothing
        // held there is nothing to revive, and a disable must stay a no-op.
        let harness = recording();
        harness.died.store(true, Ordering::SeqCst);
        assert!(!harness.inhibitor.set(false).unwrap());
        assert!(harness.applied().is_empty());
    }

    #[test]
    fn drop_releases_an_active_inhibitor() {
        let harness = recording();
        harness.inhibitor.set(true).unwrap();
        let calls = harness.calls.clone();
        drop(harness);
        assert_eq!(*calls.lock().unwrap(), vec![true, false]);
    }
}
