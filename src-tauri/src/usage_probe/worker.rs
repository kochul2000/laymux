//! One probe worker: a headless PTY running `claude`, plus the thread that
//! drives `/usage` on a schedule.
//!
//! The PTY is deliberately *not* registered in `AppState::terminals`
//! ([ADR-0102]) — it is the probe's implementation detail, not a terminal the
//! user can see, attach to, or persist.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::constants::ENV_CLAUDE_CONFIG_DIR;
use crate::pty::{self, PtyHandle, PtyOutputControl};
use crate::terminal::{TerminalConfig, TerminalSession};

use super::schedule::{next_delay, sanitize_refresh_seconds};
use super::screen::{ProbeScreen, PROBE_COLS, PROBE_ROWS};
use super::session::{BootOutcome, Pacer, ProbeSession, ProbeTiming, ProbeTransport};
use super::snapshot::{ProbeStatus, UsageSnapshot};

/// Slice length for cancellable sleeps.
const WAIT_SLICE: Duration = Duration::from_millis(100);

/// Publishes a snapshot to whoever owns the cache (the probe manager).
pub type Publisher = Arc<dyn Fn(UsageSnapshot) + Send + Sync>;

/// What a worker needs to spawn its PTY.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    /// `CLAUDE_CONFIG_DIR` value; empty means the default config dir.
    pub config_dir: String,
    /// Terminal profile name, for diagnostics.
    pub profile: String,
    /// Shell command line resolved from the profile.
    pub command_line: String,
    pub starting_directory: String,
    pub refresh_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerCommand {
    Refresh,
    Shutdown,
}

/// Handle to a running worker.
pub struct WorkerHandle {
    tx: Sender<WorkerCommand>,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl WorkerHandle {
    /// Ask for an immediate query. Ignored if the worker already exited.
    pub fn request_refresh(&self) {
        let _ = self.tx.send(WorkerCommand::Refresh);
    }

    /// Stop the worker and terminate `claude`. Blocks until the thread exits so
    /// the PTY is gone before a replacement worker may spawn for the same
    /// config dir.
    pub fn shutdown(mut self) {
        self.signal_shutdown();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }

    fn signal_shutdown(&self) {
        // The flag is set before the message so a worker parked inside a
        // cancellable sleep observes shutdown even if the channel send races.
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = self.tx.send(WorkerCommand::Shutdown);
    }
}

impl Drop for WorkerHandle {
    fn drop(&mut self) {
        if self.join.is_some() {
            self.signal_shutdown();
        }
    }
}

/// PTY-backed transport.
struct PtyTransport {
    handle: PtyHandle,
    screen: ProbeScreen,
}

impl ProbeTransport for PtyTransport {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.handle.write(bytes)
    }

    fn screen_text(&self) -> String {
        self.screen.text()
    }
}

/// Sleeps in slices so shutdown does not have to wait out a long boot poll.
struct FlagPacer {
    shutdown: Arc<AtomicBool>,
}

impl Pacer for FlagPacer {
    fn wait(&self, duration: Duration) {
        let mut remaining = duration;
        while !remaining.is_zero() {
            if self.cancelled() {
                return;
            }
            let slice = remaining.min(WAIT_SLICE);
            thread::sleep(slice);
            remaining -= slice;
        }
    }

    fn cancelled(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn a worker thread for one config dir.
pub fn spawn(spec: WorkerSpec, publish: Publisher) -> WorkerHandle {
    let (tx, rx) = mpsc::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let join = thread::Builder::new()
        .name("usage-probe".into())
        .spawn(move || run(spec, publish, rx, thread_shutdown))
        .ok();

    WorkerHandle { tx, shutdown, join }
}

fn probe_terminal_id(config_dir: &str) -> String {
    if config_dir.is_empty() {
        "usage-probe-default".to_string()
    } else {
        // Not registered anywhere; the suffix only aids log reading.
        format!("usage-probe-{:x}", fnv1a(config_dir))
    }
}

fn fnv1a(value: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn build_session(spec: &WorkerSpec) -> TerminalSession {
    let mut env = Vec::new();
    if !spec.config_dir.is_empty() {
        env.push((ENV_CLAUDE_CONFIG_DIR.to_string(), spec.config_dir.clone()));
    }

    let config = TerminalConfig {
        profile: spec.profile.clone(),
        command_line: spec.command_line.clone(),
        // The probe never runs a profile's startup command: it must reach a bare
        // shell prompt so `claude` is the only thing driving the screen.
        startup_command: String::new(),
        starting_directory: spec.starting_directory.clone(),
        cols: PROBE_COLS,
        rows: PROBE_ROWS,
        // Never joins a CWD sync group — the probe is not a user terminal.
        sync_group: "none".to_string(),
        env,
        advertise_true_color: true,
    };

    TerminalSession::new(probe_terminal_id(&spec.config_dir), config)
}

fn run(
    spec: WorkerSpec,
    publish: Publisher,
    rx: Receiver<WorkerCommand>,
    shutdown: Arc<AtomicBool>,
) {
    let mut snapshot = UsageSnapshot::idle(spec.config_dir.clone());
    snapshot.status = ProbeStatus::Starting;
    publish(snapshot.clone());

    let screen = ProbeScreen::new();
    let session = build_session(&spec);
    let reader_screen = screen.clone();
    let handle = match pty::spawn_pty(&session, move |data| {
        reader_screen.feed(&data);
        PtyOutputControl::Continue
    }) {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!(config_dir = %spec.config_dir, %error, "usage probe pty spawn failed");
            snapshot.status = ProbeStatus::Failed { message: error };
            publish(snapshot);
            return;
        }
    };

    let transport = PtyTransport { handle, screen };
    let pacer = FlagPacer {
        shutdown: Arc::clone(&shutdown),
    };
    let timing = ProbeTiming::default();
    let probe = ProbeSession::new(&transport, &pacer, timing);

    match probe.boot() {
        BootOutcome::Ready(account) => {
            snapshot.model = account.model;
            snapshot.plan = account.plan;
            publish(snapshot.clone());
        }
        BootOutcome::Cancelled => {
            let _ = transport.handle.terminate();
            return;
        }
        other => {
            tracing::warn!(config_dir = %spec.config_dir, outcome = ?other, "usage probe boot failed");
            snapshot.status = match other {
                BootOutcome::ClaudeMissing => ProbeStatus::ClaudeMissing,
                BootOutcome::Timeout => ProbeStatus::StartupTimeout,
                BootOutcome::TransportFailed(message) => ProbeStatus::Failed { message },
                BootOutcome::Ready(_) | BootOutcome::Cancelled => unreachable!(),
            };
            // A boot failure is exactly when the screen matters most: an empty
            // capture means the shell never spoke, while a populated one points
            // at whatever prompt or error blocked startup.
            snapshot.raw_screen = Some(transport.screen_text());
            publish(snapshot);
            let _ = transport.handle.terminate();
            return;
        }
    }

    let refresh_seconds = sanitize_refresh_seconds(spec.refresh_seconds);
    let mut consecutive_failures: u32 = 0;

    loop {
        if pacer.cancelled() {
            break;
        }

        match probe.query() {
            Ok(outcome) => {
                let status = outcome.parsed.status();
                let success = status.has_usable_data();
                if success {
                    snapshot.session = outcome.parsed.session;
                    snapshot.week_all = outcome.parsed.week_all;
                    snapshot.week_model = outcome.parsed.week_model;
                    snapshot.week_model_label = outcome.parsed.week_model_label;
                    snapshot.captured_at_ms = Some(now_ms());
                    consecutive_failures = 0;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                }
                snapshot.status = status;
                // Always keep the capture: on failure it is the only evidence of
                // what the upstream TUI actually rendered.
                snapshot.raw_screen = Some(outcome.screen);
            }
            Err(error) => {
                tracing::warn!(config_dir = %spec.config_dir, %error, "usage probe query failed");
                consecutive_failures = consecutive_failures.saturating_add(1);
                snapshot.status = ProbeStatus::Failed { message: error };
            }
        }

        let delay = next_delay(refresh_seconds, consecutive_failures);
        snapshot.next_query_at_ms = Some(now_ms() + delay.as_millis() as u64);
        publish(snapshot.clone());

        match rx.recv_timeout(delay) {
            Ok(WorkerCommand::Refresh) | Err(RecvTimeoutError::Timeout) => continue,
            Ok(WorkerCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = transport.handle.terminate();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> WorkerSpec {
        WorkerSpec {
            config_dir: String::new(),
            profile: "PowerShell".into(),
            command_line: "powershell.exe -NoLogo".into(),
            starting_directory: String::new(),
            refresh_seconds: 600,
        }
    }

    #[test]
    fn probe_session_never_joins_a_sync_group() {
        let session = build_session(&spec());
        assert_eq!(session.config.sync_group, "none");
    }

    #[test]
    fn probe_session_drops_the_profile_startup_command() {
        // A profile startup command would type into the shell while `claude` is
        // booting and corrupt the screen the probe parses.
        let session = build_session(&spec());
        assert!(session.config.startup_command.is_empty());
    }

    #[test]
    fn probe_session_uses_the_wide_screen_geometry() {
        let session = build_session(&spec());
        assert_eq!(session.config.cols, PROBE_COLS);
        assert_eq!(session.config.rows, PROBE_ROWS);
    }

    #[test]
    fn default_config_dir_injects_no_env_override() {
        let session = build_session(&spec());
        assert!(session.config.env.is_empty());
    }

    #[test]
    fn explicit_config_dir_is_injected_as_env() {
        let mut spec = spec();
        spec.config_dir = "/home/me/.claude-personal".into();
        let session = build_session(&spec);
        assert_eq!(
            session.config.env,
            vec![(
                ENV_CLAUDE_CONFIG_DIR.to_string(),
                "/home/me/.claude-personal".to_string()
            )]
        );
    }

    #[test]
    fn probe_terminal_ids_are_stable_and_distinct_per_config_dir() {
        assert_eq!(probe_terminal_id(""), "usage-probe-default");
        let a = probe_terminal_id("/home/me/.claude");
        let b = probe_terminal_id("/home/me/.claude-personal");
        assert_ne!(a, b);
        assert_eq!(a, probe_terminal_id("/home/me/.claude"));
    }

    #[test]
    fn flag_pacer_returns_immediately_once_cancelled() {
        let shutdown = Arc::new(AtomicBool::new(true));
        let pacer = FlagPacer {
            shutdown: Arc::clone(&shutdown),
        };
        let start = std::time::Instant::now();
        pacer.wait(Duration::from_secs(30));
        assert!(pacer.cancelled());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn flag_pacer_wakes_when_the_flag_flips_mid_wait() {
        let shutdown = Arc::new(AtomicBool::new(false));
        let pacer = FlagPacer {
            shutdown: Arc::clone(&shutdown),
        };
        let flipper = Arc::clone(&shutdown);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            flipper.store(true, Ordering::SeqCst);
        });
        let start = std::time::Instant::now();
        pacer.wait(Duration::from_secs(30));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
