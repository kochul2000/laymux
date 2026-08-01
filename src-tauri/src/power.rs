//! OS sleep prevention (ADR-0113).
//!
//! The frontend owns *when* sleep should be inhibited — it derives one boolean
//! from the user's mode setting and the busy state of the terminals. This
//! module owns *how*: it is the only place in the process that acquires or
//! releases an OS-level sleep inhibitor, so a leak has exactly one suspect.
//!
//! Only system sleep is inhibited. The display is left alone: the user asked
//! not to be put to sleep mid-run, not to have the screen burn all night.

use std::sync::Mutex;

use crate::error::AppError;
use crate::lock_ext::MutexExt;

/// Platform-specific half of the inhibitor.
///
/// `apply` is called only when the desired state actually changes, so an
/// implementation never has to deduplicate; it may assume `enabled` differs
/// from what it last applied.
pub trait InhibitBackend: Send {
    fn apply(&mut self, enabled: bool) -> Result<(), AppError>;
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
        }
    }

    /// Hold or release the inhibitor. Idempotent: a request for the state the
    /// process is already in touches no OS resource. Returns the state in
    /// effect afterwards.
    pub fn set(&self, enabled: bool) -> Result<bool, AppError> {
        let mut guard = self.inner.lock_or_err()?;
        let inner = &mut *guard;
        if inner.active == enabled {
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
    use std::process::{Child, Stdio};

    use super::InhibitBackend;
    use crate::error::AppError;
    use crate::process::headless_command;

    pub struct PlatformBackend {
        child: Option<Child>,
    }

    impl PlatformBackend {
        pub fn new() -> Self {
            Self { child: None }
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
                let child = headless_command("systemd-inhibit")
                    .arg("--what=idle:sleep")
                    .arg("--who=Laymux")
                    .arg("--why=Terminal work in progress")
                    .arg("--mode=block")
                    .arg("cat")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| {
                        AppError::Other(format!("failed to start systemd-inhibit: {e}"))
                    })?;
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    struct RecordingBackend {
        calls: Arc<Mutex<Vec<bool>>>,
        fail_next: Arc<AtomicUsize>,
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
    }

    fn recording() -> (SleepInhibitor, Arc<Mutex<Vec<bool>>>, Arc<AtomicUsize>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fail_next = Arc::new(AtomicUsize::new(0));
        let inhibitor = SleepInhibitor::with_backend(Box::new(RecordingBackend {
            calls: calls.clone(),
            fail_next: fail_next.clone(),
        }));
        (inhibitor, calls, fail_next)
    }

    #[test]
    fn starts_inactive() {
        let (inhibitor, calls, _) = recording();
        assert!(!inhibitor.is_active().unwrap());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn repeated_enable_touches_the_backend_once() {
        let (inhibitor, calls, _) = recording();
        assert!(inhibitor.set(true).unwrap());
        assert!(inhibitor.set(true).unwrap());
        assert!(inhibitor.set(true).unwrap());
        assert_eq!(*calls.lock().unwrap(), vec![true]);
        assert!(inhibitor.is_active().unwrap());
    }

    #[test]
    fn disable_while_inactive_is_a_no_op() {
        let (inhibitor, calls, _) = recording();
        assert!(!inhibitor.set(false).unwrap());
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn toggling_applies_each_transition() {
        let (inhibitor, calls, _) = recording();
        inhibitor.set(true).unwrap();
        inhibitor.set(false).unwrap();
        inhibitor.set(true).unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![true, false, true]);
    }

    #[test]
    fn a_failed_apply_leaves_the_state_unchanged() {
        // Otherwise the process would believe it holds an inhibitor it never
        // acquired, and would then skip the next enable as a duplicate.
        let (inhibitor, calls, fail_next) = recording();
        fail_next.store(1, Ordering::SeqCst);
        assert!(inhibitor.set(true).is_err());
        assert!(!inhibitor.is_active().unwrap());

        assert!(inhibitor.set(true).unwrap());
        assert_eq!(*calls.lock().unwrap(), vec![true]);
    }

    #[test]
    fn drop_releases_an_active_inhibitor() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        {
            let inhibitor = SleepInhibitor::with_backend(Box::new(RecordingBackend {
                calls: calls.clone(),
                fail_next: Arc::new(AtomicUsize::new(0)),
            }));
            inhibitor.set(true).unwrap();
        }
        assert_eq!(*calls.lock().unwrap(), vec![true, false]);
    }
}
