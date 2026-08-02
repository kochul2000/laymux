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
    active: bool,
    backend: Box<dyn InhibitBackend>,
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
                active: false,
                backend,
            }),
            watchdog_started: AtomicBool::new(false),
        }
    }

    /// Re-acquire the inhibitor if the OS resource behind it died.
    ///
    /// A no-op unless one is currently believed to be held.
    pub fn revalidate(&self) -> Result<(), AppError> {
        let mut guard = self.inner.lock_or_err()?;
        let inner = &mut *guard;
        if !inner.active || !inner.backend.needs_reapply() {
            return Ok(());
        }
        inner.backend.apply(true)?;
        tracing::warn!("sleep inhibitor died and was acquired again");
        Ok(())
    }

    /// Start the background re-acquire loop, at most once per inhibitor.
    ///
    /// Idle until something is actually held, so calling it on the first enable
    /// costs nothing on a machine that never uses the feature.
    pub fn ensure_watchdog(self: &Arc<Self>) {
        if self.watchdog_started.swap(true, Ordering::SeqCst) {
            return;
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
        if let Err(error) = spawned {
            // Let a later enable try again rather than silently going unguarded.
            self.watchdog_started.store(false, Ordering::SeqCst);
            tracing::warn!(%error, "failed to start the sleep inhibitor watchdog");
        }
    }

    /// Hold or release the inhibitor. Idempotent: a request for the state the
    /// process is already in touches no OS resource. Returns the state in
    /// effect afterwards.
    pub fn set(&self, enabled: bool) -> Result<bool, AppError> {
        let mut guard = self.inner.lock_or_err()?;
        let inner = &mut *guard;
        if inner.active == enabled && !(enabled && inner.backend.needs_reapply()) {
            return Ok(inner.active);
        }
        inner.backend.apply(enabled)?;
        inner.active = enabled;
        tracing::info!(enabled, "sleep inhibitor updated");
        Ok(enabled)
    }

    pub fn is_active(&self) -> Result<bool, AppError> {
        Ok(self.inner.lock_or_err()?.active)
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
        if !inner.active {
            return;
        }
        if let Err(error) = inner.backend.apply(false) {
            tracing::warn!(%error, "failed to release sleep inhibitor on drop");
        }
        inner.active = false;
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
    use std::process::{Child, Stdio};
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

    pub struct PlatformBackend {
        child: Option<Child>,
    }

    impl PlatformBackend {
        pub fn new() -> Self {
            Self { child: None }
        }

        /// Drain whatever the child managed to say before dying. Best effort:
        /// a missing pipe or a read error must not mask the exit itself.
        fn failure_detail(child: &mut Child, status: std::process::ExitStatus) -> String {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            let stderr = stderr.trim();
            if stderr.is_empty() {
                format!("systemd-inhibit exited immediately ({status})")
            } else {
                format!("systemd-inhibit failed ({status}): {stderr}")
            }
        }
    }

    impl InhibitBackend for PlatformBackend {
        fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
            if enabled {
                if self.child.is_some() {
                    return Ok(());
                }
                // `cat` blocks on a pipe laymux holds the write end of, so the
                // lock outlives nothing: if this process dies for any reason,
                // the kernel closes the pipe, `cat` sees EOF, and systemd-inhibit
                // releases the lock. A detached `sleep infinity` would survive a
                // SIGKILL and keep the machine awake forever.
                //
                // stderr stays piped rather than nulled so a failure can be
                // reported verbatim. Neither systemd-inhibit nor cat writes to
                // it while the lock is held, so an undrained pipe cannot fill.
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

                let deadline = Instant::now() + SPAWN_GRACE;
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            return Err(AppError::Other(Self::failure_detail(&mut child, status)));
                        }
                        Ok(None) => {}
                        Err(error) => {
                            let _ = child.kill();
                            let _ = child.wait();
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

                self.child = Some(child);
                return Ok(());
            }

            if let Some(mut child) = self.child.take() {
                // Closing the pipe is what actually releases the lock; the kill
                // is only so the process is not left waiting on a dead pipe.
                drop(child.stdin.take());
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(())
        }

        fn needs_reapply(&mut self) -> bool {
            let Some(child) = self.child.as_mut() else {
                return true;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    tracing::warn!(%status, "systemd-inhibit exited while the lock was held");
                    self.child = None;
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
