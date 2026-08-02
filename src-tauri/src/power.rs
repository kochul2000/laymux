//! OS sleep prevention (ADR-0113).
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
pub struct SleepInhibitor {
    inner: Mutex<Inner>,
    watchdog_started: AtomicBool,
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
        }
    }

    /// Re-check the OS resource and bring it back in line with what was asked.
    ///
    /// Covers an inhibitor that died behind our back *and* one that was never
    /// acquired because the first attempt failed. A no-op when nothing is
    /// wanted and nothing is held.
    pub fn revalidate(&self) -> Result<(), AppError> {
        let mut guard = self.inner.lock_or_err()?;
        let inner = &mut *guard;
        let before = inner.held;
        inner.reconcile()?;
        if inner.held && !before {
            tracing::warn!("sleep inhibitor was missing and has been acquired again");
        }
        Ok(())
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

#[cfg(windows)]
mod platform {
    use std::sync::mpsc::{self, Sender};

    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    use super::InhibitBackend;
    use crate::error::AppError;

    /// `SetThreadExecutionState` attaches the request to the *calling thread*
    /// and the request dies with that thread. A Tauri command runs on whatever
    /// worker the runtime picks, so the inhibitor lives on a thread this module
    /// owns and keeps alive instead.
    struct Request {
        enabled: bool,
        ack: Sender<Result<(), String>>,
    }

    pub struct PlatformBackend {
        tx: Option<Sender<Request>>,
    }

    impl PlatformBackend {
        pub fn new() -> Self {
            Self { tx: None }
        }

        fn worker(&mut self) -> Result<&Sender<Request>, AppError> {
            if self.tx.is_none() {
                let (tx, rx) = mpsc::channel::<Request>();
                std::thread::Builder::new()
                    .name("sleep-inhibitor".into())
                    .spawn(move || {
                        while let Ok(request) = rx.recv() {
                            let flags = if request.enabled {
                                ES_CONTINUOUS | ES_SYSTEM_REQUIRED
                            } else {
                                ES_CONTINUOUS
                            };
                            // Returns the previous state, or 0 on failure.
                            let previous = unsafe { SetThreadExecutionState(flags) };
                            let result = if previous == 0 {
                                Err("SetThreadExecutionState failed".to_string())
                            } else {
                                Ok(())
                            };
                            let _ = request.ack.send(result);
                        }
                        // The channel is only dropped when the process is going
                        // away, but clear the request anyway so the thread never
                        // exits still holding one.
                        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                    })
                    .map_err(AppError::Io)?;
                self.tx = Some(tx);
            }
            self.tx
                .as_ref()
                .ok_or_else(|| AppError::Other("sleep inhibitor thread missing".into()))
        }
    }

    impl InhibitBackend for PlatformBackend {
        fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
            // Nothing to release before the thread has ever run.
            if !enabled && self.tx.is_none() {
                return Ok(());
            }
            let (ack_tx, ack_rx) = mpsc::channel();
            self.worker()?
                .send(Request {
                    enabled,
                    ack: ack_tx,
                })
                .map_err(|_| AppError::Other("sleep inhibitor thread stopped".into()))?;
            ack_rx
                .recv()
                .map_err(|_| AppError::Other("sleep inhibitor thread stopped".into()))?
                .map_err(AppError::Other)
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::io::Read;
    use std::process::{Child, ChildStderr, Stdio};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::InhibitBackend;
    use crate::error::AppError;
    use crate::process::headless_command;

    /// How long a freshly spawned `systemd-inhibit` is watched before its lock
    /// is believed.
    ///
    /// `systemd-inhibit` execs fine and *then* exits non-zero when the inhibit
    /// call itself fails — no D-Bus session, no seat, a container, a polkit
    /// denial. Without this window that failure is indistinguishable from
    /// success, and the UI would claim the machine is being kept awake while it
    /// sleeps through the user's build.
    const SPAWN_GRACE: Duration = Duration::from_millis(300);
    const SPAWN_POLL_INTERVAL: Duration = Duration::from_millis(10);
    /// How long the child is given to notice EOF on its stdin before it is killed.
    const RELEASE_GRACE: Duration = Duration::from_millis(300);
    /// Cap on captured stderr. Enough for a diagnostic, bounded so a chatty
    /// child cannot grow this without limit.
    const STDERR_CAPTURE_LIMIT: usize = 4096;

    struct Inhibitor {
        child: Child,
        /// Filled by a reader thread. The pipe is drained continuously: leaving
        /// it unread would let a long-lived child block on a full pipe, and
        /// reading it only on failure would block this thread — inside the
        /// inhibitor mutex — until the writer closed it.
        stderr: Arc<Mutex<String>>,
    }

    impl Inhibitor {
        fn stderr_text(&self) -> String {
            self.stderr
                .lock()
                .map(|captured| captured.trim().to_string())
                .unwrap_or_default()
        }
    }

    /// Consume the child's stderr on its own thread, keeping the first
    /// [`STDERR_CAPTURE_LIMIT`] bytes and discarding the rest.
    fn drain_stderr(mut pipe: ChildStderr) -> Arc<Mutex<String>> {
        let captured = Arc::new(Mutex::new(String::new()));
        let sink = captured.clone();
        let spawned = std::thread::Builder::new()
            .name("systemd-inhibit-stderr".into())
            .spawn(move || {
                let mut chunk = [0u8; 512];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(read) => {
                            if let Ok(mut sink) = sink.lock() {
                                let room = STDERR_CAPTURE_LIMIT.saturating_sub(sink.len());
                                if room > 0 {
                                    let text = String::from_utf8_lossy(&chunk[..read.min(room)]);
                                    sink.push_str(&text);
                                }
                            }
                        }
                    }
                }
            });
        if let Err(error) = spawned {
            // Without a reader the pipe could fill; the diagnostic is worth
            // less than the child staying unblocked.
            tracing::warn!(%error, "failed to capture systemd-inhibit stderr");
        }
        captured
    }

    pub struct PlatformBackend {
        inhibitor: Option<Inhibitor>,
    }

    impl PlatformBackend {
        pub fn new() -> Self {
            Self { inhibitor: None }
        }
    }

    impl InhibitBackend for PlatformBackend {
        fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
            if enabled {
                if self.inhibitor.is_some() {
                    return Ok(());
                }
                // `cat` blocks on a pipe laymux holds the write end of, so the
                // lock outlives nothing: if this process dies for any reason,
                // the kernel closes the pipe, `cat` sees EOF, and systemd-inhibit
                // releases the lock. A detached `sleep infinity` would survive a
                // SIGKILL and keep the machine awake forever.
                //
                // stderr stays piped rather than nulled so a failure can be
                // reported verbatim; a reader thread keeps it drained.
                let mut child = headless_command("systemd-inhibit")
                    .arg("--what=idle:sleep")
                    .arg("--who=Laymux")
                    .arg("--why=Terminal work in progress")
                    .arg("--mode=block")
                    .arg("cat")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| {
                        AppError::Other(format!("failed to start systemd-inhibit: {e}"))
                    })?;

                let stderr = match child.stderr.take() {
                    Some(pipe) => drain_stderr(pipe),
                    None => Arc::new(Mutex::new(String::new())),
                };
                let mut inhibitor = Inhibitor { child, stderr };

                let deadline = Instant::now() + SPAWN_GRACE;
                loop {
                    match inhibitor.child.try_wait() {
                        Ok(Some(status)) => {
                            let detail = inhibitor.stderr_text();
                            return Err(AppError::Other(if detail.is_empty() {
                                format!("systemd-inhibit exited immediately ({status})")
                            } else {
                                format!("systemd-inhibit failed ({status}): {detail}")
                            }));
                        }
                        Ok(None) => {}
                        Err(error) => {
                            let _ = inhibitor.child.kill();
                            let _ = inhibitor.child.wait();
                            return Err(AppError::Other(format!(
                                "failed to check systemd-inhibit: {error}"
                            )));
                        }
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(SPAWN_POLL_INTERVAL);
                }

                self.inhibitor = Some(inhibitor);
                return Ok(());
            }

            let Some(mut inhibitor) = self.inhibitor.take() else {
                return Ok(());
            };
            // Closing the pipe is what releases the lock: `cat` sees EOF and
            // both processes exit.
            drop(inhibitor.child.stdin.take());

            let deadline = Instant::now() + RELEASE_GRACE;
            let exited = loop {
                match inhibitor.child.try_wait() {
                    Ok(Some(_)) => break true,
                    Ok(None) => {}
                    Err(error) => {
                        // Whether the lock is gone is unknown; keep the handle so
                        // a later attempt can try again rather than leaking it.
                        self.inhibitor = Some(inhibitor);
                        return Err(AppError::Other(format!(
                            "failed to check systemd-inhibit during release: {error}"
                        )));
                    }
                }
                if Instant::now() >= deadline {
                    break false;
                }
                std::thread::sleep(SPAWN_POLL_INTERVAL);
            };

            if !exited {
                // It ignored EOF. Killing it drops the lock just as well, but a
                // failure here means the lock may still be held — say so.
                if let Err(error) = inhibitor.child.kill() {
                    self.inhibitor = Some(inhibitor);
                    return Err(AppError::Other(format!(
                        "failed to kill systemd-inhibit: {error}"
                    )));
                }
            }
            inhibitor.child.wait().map_err(|error| {
                AppError::Other(format!("failed to reap systemd-inhibit: {error}"))
            })?;
            Ok(())
        }

        fn needs_reapply(&mut self) -> bool {
            let Some(inhibitor) = self.inhibitor.as_mut() else {
                return true;
            };
            match inhibitor.child.try_wait() {
                Ok(Some(status)) => {
                    let detail = inhibitor.stderr_text();
                    tracing::warn!(
                        %status,
                        detail = %detail,
                        "systemd-inhibit exited while the lock was held"
                    );
                    self.inhibitor = None;
                    true
                }
                // Still running, or the check itself failed — in the latter case
                // respawning would leak the child we already have.
                _ => false,
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::InhibitBackend;
    use crate::error::AppError;

    pub struct PlatformBackend;

    impl PlatformBackend {
        pub fn new() -> Self {
            Self
        }
    }

    impl InhibitBackend for PlatformBackend {
        fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
            if enabled {
                return Err(AppError::Other(
                    "sleep prevention is not supported on this platform".into(),
                ));
            }
            Ok(())
        }
    }
}

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
