use std::collections::{HashMap, HashSet, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::AtomicU64;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::lock_ext::MutexExt;
use crate::output_buffer::TerminalOutputBuffer;
use crate::pty::PtyHandle;
use crate::terminal::{SyncGroup, TerminalNotification, TerminalSession};
use crate::terminal_output::SharedTerminalProtocolStates;

/// Global application state shared across all commands and PTY callbacks.
///
/// ## Lock ordering
///
/// When acquiring multiple locks, always follow this order to prevent deadlocks:
///
/// 1. `terminals`
/// 2. terminal-output session registry
/// 3. `terminal_protocol_states` compatibility table / per-terminal protocol gate
/// 4. `output_buffers` compatibility table / per-terminal output ring
/// 5. `known_claude_terminals`
/// 6. `known_codex_terminals`
/// 7. `last_detected_interactive_app`
/// 8. `recently_exited_interactive_app`
/// 9. `notifications`
/// 10. `sync_groups`
/// 11. `propagated_terminals`
/// 12. `pty_handles` / `automation_channels` / `automation_port` / `ipc_socket_path`
/// 13. `remote_access`
/// 14. `remote_control`
/// 15. `cloud_tunnel`
/// 16. `cloud`
/// 17. `exec_locks` (table mutex; held only to get/insert a per-terminal lock,
///     never across `.await` and never while holding another `AppState` lock)
///
/// Never acquire a lower-numbered lock while holding a higher-numbered one.
/// Inside one terminal-output session, nested locks have their own fixed order:
/// per-terminal protocol gate -> session runtime -> output ring -> desktop flow.
/// Paths that skip a lock, including retirement, preserve the remaining relative
/// order.
///
/// The per-terminal locks *inside* `exec_locks` are `tokio::sync::Mutex` because
/// a writer holds one across `.await` (the body→CR delay); they are acquired
/// only after the `exec_locks` table mutex has been released, so they sit
/// outside this ordering.
/// `settings_update_lock` is also async and is held only across frontend settings
/// snapshot/validation/apply awaits, never together with a synchronous AppState lock.
/// `usage_probe` owns its own registry mutex and participates in no ordering with
/// the locks above: nothing acquires it while holding another `AppState` lock, and
/// its worker threads touch no `AppState` state (ADR-0102).
/// `commands::github_repo` owns its per-repository snapshot registry on the same
/// terms: its locks are taken only on `spawn_blocking` workers that touch no
/// `AppState` state, so they join no ordering above (ADR-0106).
/// `sleep_inhibitor` likewise owns a mutex that guards only itself and is taken
/// from the `set_sleep_inhibit` command alone, never under another lock (ADR-0113).
///
/// ## Poison policy
///
/// Operational access fails closed through `MutexExt::lock_or_err`. Explicit
/// close/rollback may recover a guard only through the discard-only helper and
/// still follows the order above. Recovered state is removed/overwritten or an
/// extracted OS resource is terminated; it is never returned to operation and
/// the mutex poison is not cleared. See ADR-0087 and api-contracts §14.3.
pub struct AppState {
    pub terminals: Arc<Mutex<HashMap<String, TerminalSession>>>,
    pub sync_groups: Mutex<HashMap<String, SyncGroup>>,
    pub pty_handles: Mutex<HashMap<String, PtyHandle>>,
    pub ipc_socket_path: Mutex<Option<String>>,
    pub output_buffers: Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    /// Generation-scoped terminal output registry plus the compatibility
    /// protocol-gate index. The canonical session owns protocol state, ring
    /// identity, retirement, and subscribers as one Arc lifetime.
    pub terminal_protocol_states: SharedTerminalProtocolStates,
    pub automation_channels:
        Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
    pub automation_port: Mutex<Option<u16>>,
    /// Terminals that recently received a propagated command (e.g., cd from sync-cwd).
    /// Used to suppress OSC echo loops. Entries expire after PROPAGATION_TIMEOUT.
    pub propagated_terminals: Mutex<HashMap<String, Instant>>,
    /// Single source of truth for Claude Code terminal detection.
    /// Populated proactively by the PTY output callback (real-time) and
    /// by frontend via `mark_claude_terminal` command (from command text detection).
    /// Removed when the terminal title no longer contains "Claude Code" (exit detection)
    /// or when the terminal session closes.
    /// Both backend (CWD skip) and frontend (activity display) consume this state.
    pub known_claude_terminals: Arc<Mutex<HashSet<String>>>,
    /// Single source of truth for Codex terminal detection.
    /// Populated proactively by the PTY output callback and frontend command detection.
    /// Removed when the terminal session closes.
    pub known_codex_terminals: Arc<Mutex<HashSet<String>>>,
    /// Per-terminal grace-window cache of the last successfully detected
    /// interactive app name and the `Instant` of that detection.
    ///
    /// Used by `activity::detect_interactive_app_from_live_title` to preserve
    /// the previous detection across title events that evaluate to `None`
    /// (path-like titles, early-splash spinner frames, PowerShell `prompt`
    /// rewrites). Entries older than `INTERACTIVE_APP_GRACE_WINDOW` are
    /// ignored. See issue #237.
    pub last_detected_interactive_app: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    /// Per-terminal negative cache: records the moment an interactive app
    /// (Claude / Codex) was explicitly seen to exit via the PTY title
    /// state machine. Used by `activity::is_claude_terminal_from_buffer`
    /// and its Codex mirror to suppress the buffer-scan strong-signal
    /// branch for the duration of `INTERACTIVE_APP_GRACE_WINDOW`,
    /// preventing the still-resident `Claude Code` / `OpenAI Codex`
    /// banners in the recent 16KB window from re-pinning the cache the
    /// moment the user returns to the shell prompt.
    pub recently_exited_interactive_app: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    /// Single source of truth for terminal notifications.
    /// Stored in backend so `get_terminal_summaries` can return unread counts.
    pub notifications: Arc<Mutex<Vec<TerminalNotification>>>,
    /// Auto-incrementing counter for notification IDs.
    pub notification_counter: AtomicU64,
    /// Direct Remote runtime access gate plus an in-memory snapshot of the
    /// persisted Remote settings used by latency-sensitive owner checks.
    pub remote_access: Mutex<crate::remote_server::RemoteAccessRuntimeState>,
    /// Current Direct Remote Mode controller lease plus local reclaim lockout state.
    pub remote_control: Mutex<crate::remote_server::RemoteControlState>,
    /// Runtime cloud tunnel worker control. Stored separately from status so
    /// disconnect can cancel the long-running WSS task without holding cloud.
    pub cloud_tunnel: Mutex<Option<crate::cloud::tunnel::TunnelControl>>,
    /// Runtime cloud relay connection status. Pairing/tunnel workers update this state.
    pub cloud: Mutex<crate::cloud::CloudStatus>,
    /// Process-global per-terminal lock table serializing `write_input` /
    /// `execute_command` on the same terminal (#314). Living on the shared
    /// `Arc<AppState>` — not on the per-MCP-session handler — is what makes the
    /// serialization hold **across MCP sessions** (#427). Entries are removed on
    /// terminal close so the table does not grow unbounded.
    ///
    /// The outer table is a `std::sync::Mutex` (held only briefly to get/insert,
    /// never across `.await`, so sync close paths can clean it too); each entry
    /// binds the lock Arc to one terminal generation, and each inner lock is a
    /// `tokio::sync::Mutex` because a writer holds it across the body→CR delay.
    pub exec_locks: SharedExecLocks,
    /// Non-callback cleanup/reaper coordinators for generation-scoped fatal PTY
    /// cleanup. Both exist before AppState becomes usable; per-handle reaper
    /// spawn failures retain and retry the owned job.
    pub terminal_teardown_dispatcher: TerminalTeardownDispatcher,
    /// Serializes settings snapshot → validation → persistence across MCP sessions
    /// and legacy Automation setters so optimistic revisions cannot lose updates.
    pub settings_update_lock: tokio::sync::Mutex<()>,
    /// Frontend responsiveness vitals plus bridge counters, served by
    /// `GET /api/v1/diagnostics/frontend` without a bridge round-trip so a stalled
    /// WebView is still diagnosable (issue #606). Diagnostic only — its own
    /// `Mutex`/atomics participate in no ordering with the locks above because
    /// nothing reads it while holding another AppState lock.
    pub frontend_health: Arc<crate::frontend_health::FrontendHealthState>,
    /// Claude usage probes. Owns headless `claude` PTYs that are deliberately
    /// absent from `terminals`, keyed by `CLAUDE_CONFIG_DIR` (ADR-0102).
    pub usage_probe: Arc<crate::usage_probe::UsageProbe>,
    /// The process's only OS sleep inhibitor (ADR-0113). Owns its own mutex and
    /// participates in no ordering above: nothing acquires it while holding
    /// another AppState lock.
    pub sleep_inhibitor: crate::power::SleepInhibitor,
}

/// Process-global per-terminal write/exec serialization table. See
/// [`AppState::exec_locks`].
pub struct TerminalExecLockEntry {
    pub(crate) generation: u64,
    pub(crate) lock: Arc<tokio::sync::Mutex<()>>,
}

pub type SharedExecLocks = Arc<Mutex<HashMap<String, TerminalExecLockEntry>>>;

type TerminalTeardownJob = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
pub struct TerminalTeardownDispatcher {
    cleanup_sender: Sender<TerminalTeardownJob>,
    reaper_sender: Sender<TerminalTeardownJob>,
}

impl TerminalTeardownDispatcher {
    fn new() -> Self {
        let (cleanup_sender, cleanup_receiver) = mpsc::channel::<TerminalTeardownJob>();
        let (reaper_sender, reaper_receiver) = mpsc::channel::<TerminalTeardownJob>();
        // Both coordinators exist before AppState is returned. `thread::spawn`
        // aborts construction if the OS cannot create either thread, so no live
        // terminal can claim a fatal request without both consumers.
        thread::spawn(move || {
            while let Ok(job) = cleanup_receiver.recv() {
                run_terminal_teardown_job(job, "terminal fatal cleanup job panicked");
            }
        });
        thread::spawn(move || run_terminal_reaper_dispatcher(reaper_receiver));
        Self {
            cleanup_sender,
            reaper_sender,
        }
    }

    pub(crate) fn dispatch_cleanup(&self, job: TerminalTeardownJob) -> Result<(), String> {
        self.cleanup_sender
            .send(job)
            .map_err(|_| "terminal fatal cleanup worker is unavailable".to_string())
    }

    pub(crate) fn dispatch_reaper(&self, job: TerminalTeardownJob) -> Result<(), String> {
        self.reaper_sender
            .send(job)
            .map_err(|_| "terminal fatal reaper coordinator is unavailable".to_string())
    }
}

fn run_terminal_teardown_job(job: TerminalTeardownJob, panic_message: &'static str) {
    if catch_unwind(AssertUnwindSafe(job)).is_err() {
        tracing::error!(panic_message);
    }
}

fn run_terminal_reaper_dispatcher(receiver: mpsc::Receiver<TerminalTeardownJob>) {
    run_terminal_reaper_dispatcher_with(receiver, try_spawn_terminal_reaper);
}

fn run_terminal_reaper_dispatcher_with(
    receiver: mpsc::Receiver<TerminalTeardownJob>,
    mut spawn: impl FnMut(TerminalTeardownJob) -> Result<(), TerminalTeardownJob>,
) {
    let mut pending = VecDeque::new();
    let mut disconnected = false;
    loop {
        if pending.is_empty() && !disconnected {
            match receiver.recv() {
                Ok(job) => pending.push_back(job),
                Err(_) => disconnected = true,
            }
        } else if !disconnected {
            loop {
                match receiver.try_recv() {
                    Ok(job) => pending.push_back(job),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }

        let attempts = pending.len();
        let mut retry_needed = false;
        for _ in 0..attempts {
            let Some(job) = pending.pop_front() else {
                break;
            };
            if let Err(job) = spawn(job) {
                pending.push_back(job);
                retry_needed = true;
            }
        }
        if disconnected && pending.is_empty() {
            return;
        }
        if retry_needed {
            thread::sleep(Duration::from_millis(25));
        }
    }
}

fn try_spawn_terminal_reaper(job: TerminalTeardownJob) -> Result<(), TerminalTeardownJob> {
    let slot = Arc::new(Mutex::new(Some(job)));
    let worker_slot = Arc::clone(&slot);
    match thread::Builder::new()
        .name("terminal-fatal-reaper".into())
        .spawn(move || {
            let job = match worker_slot.lock() {
                Ok(mut slot) => slot.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            if let Some(job) = job {
                run_terminal_teardown_job(job, "terminal fatal reaper job panicked");
            }
        }) {
        Ok(_) => Ok(()),
        Err(error) => {
            tracing::warn!(%error, "failed to spawn terminal fatal reaper; retrying");
            let job = match slot.lock() {
                Ok(mut slot) => slot.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            match job {
                Some(job) => Err(job),
                None => {
                    tracing::error!(
                        "terminal fatal reaper job was unavailable after spawn failure"
                    );
                    Ok(())
                }
            }
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
            sync_groups: Mutex::new(HashMap::new()),
            pty_handles: Mutex::new(HashMap::new()),
            ipc_socket_path: Mutex::new(None),
            output_buffers: Arc::new(Mutex::new(HashMap::new())),
            terminal_protocol_states: SharedTerminalProtocolStates::default(),
            automation_channels: Mutex::new(HashMap::new()),
            automation_port: Mutex::new(None),
            propagated_terminals: Mutex::new(HashMap::new()),
            known_claude_terminals: Arc::new(Mutex::new(HashSet::new())),
            known_codex_terminals: Arc::new(Mutex::new(HashSet::new())),
            last_detected_interactive_app: Arc::new(Mutex::new(HashMap::new())),
            recently_exited_interactive_app: Arc::new(Mutex::new(HashMap::new())),
            notifications: Arc::new(Mutex::new(Vec::new())),
            notification_counter: AtomicU64::new(1),
            remote_access: Mutex::new(crate::remote_server::RemoteAccessRuntimeState::new(
                crate::settings::load_settings().remote,
            )),
            remote_control: Mutex::new(crate::remote_server::RemoteControlState::default()),
            cloud_tunnel: Mutex::new(None),
            cloud: Mutex::new(crate::cloud::CloudStatus::default()),
            exec_locks: Arc::new(Mutex::new(HashMap::new())),
            terminal_teardown_dispatcher: TerminalTeardownDispatcher::new(),
            settings_update_lock: tokio::sync::Mutex::new(()),
            frontend_health: Arc::new(crate::frontend_health::FrontendHealthState::default()),
            usage_probe: Arc::new(crate::usage_probe::UsageProbe::new()),
            sleep_inhibitor: crate::power::SleepInhibitor::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        // Probe PTYs are intentionally absent from `pty_handles` (ADR-0102), so
        // they need their own teardown or the `claude` children outlive the app.
        if let Err(err) = self.usage_probe.shutdown_all() {
            tracing::warn!(error = %err, "usage probe cleanup during app shutdown failed");
        }
        let handles = self
            .pty_handles
            .get_mut_or_recover_for_discard("dropping PTY handle registry");
        for (terminal_id, handle) in handles.drain() {
            if let Err(err) = handle.terminate() {
                tracing::warn!(terminal_id, error = %err, "PTY cleanup during app shutdown failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_empty_state() {
        let state = AppState::new();
        let terminals = state.terminals.lock().unwrap();
        assert!(terminals.is_empty());
        let groups = state.sync_groups.lock().unwrap();
        assert!(groups.is_empty());
        let ptys = state.pty_handles.lock().unwrap();
        assert!(ptys.is_empty());
    }

    #[test]
    fn default_matches_new() {
        let state = AppState::default();
        let terminals = state.terminals.lock().unwrap();
        assert!(terminals.is_empty());
    }

    #[test]
    fn terminal_teardown_dispatcher_survives_a_panicking_job() {
        let dispatcher = TerminalTeardownDispatcher::new();
        dispatcher
            .dispatch_cleanup(Box::new(|| panic!("injected teardown panic")))
            .unwrap();
        let (tx, rx) = mpsc::channel();
        dispatcher
            .dispatch_cleanup(Box::new(move || tx.send(()).unwrap()))
            .unwrap();

        rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn terminal_reaper_does_not_head_of_line_block_a_second_job() {
        let dispatcher = TerminalTeardownDispatcher::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        dispatcher
            .dispatch_reaper(Box::new(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }))
            .unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let (done_tx, done_rx) = mpsc::channel();
        dispatcher
            .dispatch_reaper(Box::new(move || done_tx.send(()).unwrap()))
            .unwrap();
        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        release_tx.send(()).unwrap();
    }

    #[test]
    fn terminal_reaper_retries_a_job_after_spawn_failure() {
        let (sender, receiver) = mpsc::channel();
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_attempts = Arc::clone(&attempts);
        let worker = thread::spawn(move || {
            run_terminal_reaper_dispatcher_with(receiver, move |job| {
                if worker_attempts.fetch_add(1, std::sync::atomic::Ordering::AcqRel) == 0 {
                    return Err(job);
                }
                job();
                Ok(())
            });
        });
        let (done_tx, done_rx) = mpsc::channel();
        sender
            .send(Box::new(move || done_tx.send(()).unwrap()))
            .unwrap();
        drop(sender);

        done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
        assert_eq!(attempts.load(std::sync::atomic::Ordering::Acquire), 2);
    }

    #[test]
    fn propagated_terminals_starts_empty() {
        let state = AppState::new();
        let propagated = state.propagated_terminals.lock().unwrap();
        assert!(propagated.is_empty());
    }

    #[test]
    fn known_claude_terminals_starts_empty() {
        let state = AppState::new();
        let known = state.known_claude_terminals.lock().unwrap();
        assert!(known.is_empty());
    }

    #[test]
    fn known_codex_terminals_starts_empty() {
        let state = AppState::new();
        let known = state.known_codex_terminals.lock().unwrap();
        assert!(known.is_empty());
    }

    #[test]
    fn notifications_starts_empty() {
        let state = AppState::new();
        let notifs = state.notifications.lock().unwrap();
        assert!(notifs.is_empty());
    }

    #[test]
    fn remote_control_starts_empty() {
        let state = AppState::new();
        let access = state.remote_access.lock().unwrap();
        assert!(!access.enabled);
        assert!(access.auth_token.is_none());
        drop(access);
        let remote = state.remote_control.lock().unwrap();
        assert!(remote.lease.is_none());
        assert!(remote.reclaim_lockout_until.is_none());
    }

    #[test]
    fn cloud_status_starts_disconnected() {
        let state = AppState::new();
        let cloud = state.cloud.lock().unwrap();
        assert!(!cloud.connected);
        assert!(cloud.instance_id.is_none());
        assert!(cloud.last_error.is_none());
    }

    #[test]
    fn cloud_tunnel_control_starts_empty() {
        let state = AppState::new();
        let tunnel = state.cloud_tunnel.lock().unwrap();
        assert!(tunnel.is_none());
    }
}
