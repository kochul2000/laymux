//! Headless PTY worker that boots `grok` and reads `/usage`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::constants::ENV_GROK_HOME;
use crate::pty::{self, PtyHandle, PtyOutputControl};
use crate::terminal::{TerminalConfig, TerminalSession};
use crate::usage_probe::{next_delay, ProbeScreen, PROBE_COLS, PROBE_ROWS};

use super::session::{BootOutcome, Pacer, ProbeSession, ProbeTiming, ProbeTransport};
use super::snapshot::{GrokProbeStatus, GrokUsageSnapshot};

const WAIT_SLICE: Duration = Duration::from_millis(100);

pub type Publisher = Arc<dyn Fn(GrokUsageSnapshot) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct WorkerSpec {
    pub config_dir: String,
    pub profile: String,
    pub command_line: String,
    pub starting_directory: String,
    pub refresh_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerCommand {
    Refresh,
    Shutdown,
}

pub struct WorkerHandle {
    tx: Sender<WorkerCommand>,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl WorkerHandle {
    pub fn request_refresh(&self) {
        let _ = self.tx.send(WorkerCommand::Refresh);
    }

    pub fn is_alive(&self) -> bool {
        self.join.as_ref().is_some_and(|join| !join.is_finished())
    }

    pub fn shutdown(mut self) {
        self.signal_shutdown();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }

    fn signal_shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = self.tx.send(WorkerCommand::Shutdown);
    }

    #[cfg(test)]
    pub fn finished_for_test() -> Self {
        let (tx, rx) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let join = thread::spawn(move || {
            drop(rx);
        });
        while !join.is_finished() {
            thread::sleep(Duration::from_millis(1));
        }
        Self {
            tx,
            shutdown,
            join: Some(join),
        }
    }

    #[cfg(test)]
    pub fn idle_for_test() -> Self {
        let (tx, rx) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&shutdown);
        let join = thread::spawn(move || loop {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(WorkerCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(WorkerCommand::Refresh) | Err(RecvTimeoutError::Timeout) => {}
            }
        });
        Self {
            tx,
            shutdown,
            join: Some(join),
        }
    }
}

impl Drop for WorkerHandle {
    fn drop(&mut self) {
        if self.join.is_some() {
            self.signal_shutdown();
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn spawn(spec: WorkerSpec, publish: Publisher) -> WorkerHandle {
    let (tx, rx) = mpsc::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let join = thread::Builder::new()
        .name("grok-usage-probe".into())
        .spawn(move || run(spec, publish, rx, thread_shutdown))
        .ok();
    WorkerHandle { tx, shutdown, join }
}

fn probe_terminal_id(config_dir: &str) -> String {
    if config_dir.is_empty() {
        "grok-usage-probe-default".to_string()
    } else {
        format!("grok-usage-probe-{:x}", fnv1a(config_dir))
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
        env.push((ENV_GROK_HOME.to_string(), spec.config_dir.clone()));
    }
    let config = TerminalConfig {
        profile: spec.profile.clone(),
        command_line: spec.command_line.clone(),
        startup_command: String::new(),
        starting_directory: spec.starting_directory.clone(),
        cols: PROBE_COLS,
        rows: PROBE_ROWS,
        sync_group: "none".to_string(),
        env,
        advertise_true_color: true,
    };
    TerminalSession::new(probe_terminal_id(&spec.config_dir), config)
}

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

fn run(
    spec: WorkerSpec,
    publish: Publisher,
    rx: Receiver<WorkerCommand>,
    shutdown: Arc<AtomicBool>,
) {
    let mut snapshot = GrokUsageSnapshot::idle(&spec.config_dir);
    let mut consecutive_failures: u32 = 0;
    while !shutdown.load(Ordering::SeqCst) {
        run_session(
            &spec,
            &publish,
            &rx,
            &shutdown,
            &mut snapshot,
            &mut consecutive_failures,
        );
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        consecutive_failures = consecutive_failures.saturating_add(1);
        let delay = next_delay(spec.refresh_seconds, consecutive_failures);
        snapshot.next_query_at_ms = Some(now_ms() + delay.as_millis() as u64);
        publish(snapshot.clone());
        match rx.recv_timeout(delay) {
            Ok(WorkerCommand::Refresh) | Err(RecvTimeoutError::Timeout) => {}
            Ok(WorkerCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

// 실패한 CLI의 인증 캐시를 버리고 같은 프로필에서 로그인 정보를 다시 읽는다.
fn run_session(
    spec: &WorkerSpec,
    publish: &Publisher,
    rx: &Receiver<WorkerCommand>,
    shutdown: &Arc<AtomicBool>,
    snapshot: &mut GrokUsageSnapshot,
    consecutive_failures: &mut u32,
) {
    snapshot.status = GrokProbeStatus::Starting;
    snapshot.next_query_at_ms = None;
    publish(snapshot.clone());

    let screen = ProbeScreen::new();
    let session = build_session(spec);
    let reader_screen = screen.clone();
    let handle = match pty::spawn_pty(&session, move |data| {
        reader_screen.feed(&data);
        PtyOutputControl::Continue
    }) {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!(config_dir = %spec.config_dir, %error, "grok usage probe pty spawn failed");
            snapshot.status = GrokProbeStatus::Failed { message: error };
            return;
        }
    };

    let transport = PtyTransport { handle, screen };
    let pacer = FlagPacer {
        shutdown: Arc::clone(shutdown),
    };
    let probe = ProbeSession::new(&transport, &pacer, ProbeTiming::default());

    match probe.boot() {
        BootOutcome::Ready => {}
        BootOutcome::Cancelled => {
            let _ = transport.handle.terminate();
            return;
        }
        other => {
            snapshot.status = match other {
                BootOutcome::GrokMissing => GrokProbeStatus::GrokMissing,
                BootOutcome::Timeout => GrokProbeStatus::StartupTimeout,
                BootOutcome::TransportFailed(message) => GrokProbeStatus::Failed { message },
                BootOutcome::Ready | BootOutcome::Cancelled => unreachable!(),
            };
            snapshot.raw_screen = Some(transport.screen_text());
            let _ = transport.handle.terminate();
            return;
        }
    }

    loop {
        if pacer.cancelled() {
            break;
        }
        match probe.query() {
            Ok(outcome) => {
                snapshot.raw_screen = Some(outcome.screen);
                if outcome.rows.is_empty() {
                    snapshot.status = GrokProbeStatus::ParseFailed;
                    snapshot.rows.clear();
                } else {
                    snapshot.rows = outcome.rows;
                    snapshot.status = GrokProbeStatus::Ready;
                    snapshot.captured_at_ms = Some(now_ms());
                    *consecutive_failures = 0;
                }
            }
            Err(error) => {
                if error == "cancelled" {
                    let _ = transport.handle.terminate();
                    return;
                }
                snapshot.status = GrokProbeStatus::Failed { message: error };
                snapshot.raw_screen = Some(transport.screen_text());
            }
        }
        if !snapshot.status.has_usable_data() {
            break;
        }
        let delay = next_delay(spec.refresh_seconds, 0);
        snapshot.next_query_at_ms = Some(now_ms() + delay.as_millis() as u64);
        publish(snapshot.clone());

        match rx.recv_timeout(delay) {
            Ok(WorkerCommand::Refresh) | Err(RecvTimeoutError::Timeout) => {}
            Ok(WorkerCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = transport.handle.terminate();
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[test]
    fn startup_failure_keeps_an_automatic_retry_scheduled() {
        let (tx, rx) = mpsc::channel();
        let worker = spawn(
            WorkerSpec {
                config_dir: String::new(),
                profile: "WSL".into(),
                command_line: "laymux-nonexistent-grok-test-shell".into(),
                starting_directory: String::new(),
                refresh_seconds: 600,
            },
            Arc::new(move |snapshot| {
                let _ = tx.send(snapshot);
            }),
        );
        let failed = loop {
            let snapshot = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if matches!(snapshot.status, GrokProbeStatus::Failed { .. }) {
                break snapshot;
            }
        };
        worker.shutdown();
        assert!(
            failed.next_query_at_ms.is_some(),
            "기동 실패 후 자동 재시도가 끊겼다"
        );
    }
}
