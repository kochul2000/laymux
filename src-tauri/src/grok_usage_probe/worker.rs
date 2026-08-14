//! Headless PTY worker that boots `grok` and reads `/usage`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::constants::ENV_GROK_HOME;
use crate::pty::{self, PtyHandle, PtyOutputControl};
use crate::terminal::{TerminalConfig, TerminalSession};
use crate::usage_probe::{sanitize_refresh_seconds, ProbeScreen, PROBE_COLS, PROBE_ROWS};

use super::parse::parse_grok_usage_screen;
use super::snapshot::{GrokProbeStatus, GrokUsageSnapshot};

const WAIT_SLICE: Duration = Duration::from_millis(100);
const BOOT_POLL: Duration = Duration::from_secs(1);
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const USAGE_RENDER: Duration = Duration::from_secs(5);
const READY_MARKER: &str = "grok build";
const MISSING_MARKERS: [&str; 4] = [
    "command not found",
    "is not recognized as the name of a cmdlet",
    "not found in %path%",
    "no such file or directory",
];

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

fn cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

fn wait(flag: &AtomicBool, duration: Duration) {
    let mut remaining = duration;
    while !remaining.is_zero() {
        if cancelled(flag) {
            return;
        }
        let slice = remaining.min(WAIT_SLICE);
        thread::sleep(slice);
        remaining -= slice;
    }
}

fn run(
    spec: WorkerSpec,
    publish: Publisher,
    rx: Receiver<WorkerCommand>,
    shutdown: Arc<AtomicBool>,
) {
    let mut snapshot = GrokUsageSnapshot::idle(&spec.config_dir);
    snapshot.status = GrokProbeStatus::Starting;
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
            tracing::warn!(config_dir = %spec.config_dir, %error, "grok usage probe pty spawn failed");
            snapshot.status = GrokProbeStatus::Failed { message: error };
            publish(snapshot);
            return;
        }
    };

    match boot(&handle, &screen, &shutdown) {
        Boot::Ready => {}
        Boot::Cancelled => {
            let _ = handle.terminate();
            return;
        }
        other => {
            snapshot.status = match other {
                Boot::GrokMissing => GrokProbeStatus::GrokMissing,
                Boot::Timeout => GrokProbeStatus::StartupTimeout,
                Boot::TransportFailed(message) => GrokProbeStatus::Failed { message },
                Boot::Ready | Boot::Cancelled => unreachable!(),
            };
            snapshot.raw_screen = Some(screen.text());
            publish(snapshot);
            let _ = handle.terminate();
            return;
        }
    }

    let refresh_seconds = sanitize_refresh_seconds(spec.refresh_seconds);
    loop {
        if cancelled(&shutdown) {
            break;
        }
        query(&handle, &screen, &shutdown, &mut snapshot);
        snapshot.next_query_at_ms = Some(now_ms() + refresh_seconds * 1000);
        publish(snapshot.clone());

        let deadline = Duration::from_secs(refresh_seconds);
        let mut remaining = deadline;
        loop {
            if cancelled(&shutdown) {
                let _ = handle.terminate();
                return;
            }
            match rx.recv_timeout(remaining.min(WAIT_SLICE)) {
                Ok(WorkerCommand::Refresh) => break,
                Ok(WorkerCommand::Shutdown) => {
                    let _ = handle.terminate();
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {
                    remaining = remaining.saturating_sub(WAIT_SLICE);
                    if remaining.is_zero() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = handle.terminate();
                    return;
                }
            }
        }
    }
    let _ = handle.terminate();
}

enum Boot {
    Ready,
    GrokMissing,
    Timeout,
    Cancelled,
    TransportFailed(String),
}

fn boot(handle: &PtyHandle, screen: &ProbeScreen, shutdown: &AtomicBool) -> Boot {
    if let Err(error) = handle.write(b"grok\r") {
        return Boot::TransportFailed(error);
    }
    let mut waited = Duration::ZERO;
    while waited < BOOT_TIMEOUT {
        if cancelled(shutdown) {
            return Boot::Cancelled;
        }
        wait(shutdown, BOOT_POLL);
        waited += BOOT_POLL;
        let text = screen.text().to_ascii_lowercase();
        if MISSING_MARKERS.iter().any(|marker| text.contains(marker)) {
            return Boot::GrokMissing;
        }
        if text.contains(READY_MARKER) {
            return Boot::Ready;
        }
    }
    Boot::Timeout
}

fn query(
    handle: &PtyHandle,
    screen: &ProbeScreen,
    shutdown: &AtomicBool,
    snapshot: &mut GrokUsageSnapshot,
) {
    if let Err(error) = handle.write(b"/usage\r") {
        snapshot.status = GrokProbeStatus::Failed { message: error };
        snapshot.raw_screen = Some(screen.text());
        return;
    }
    wait(shutdown, USAGE_RENDER);
    let text = screen.text();
    snapshot.raw_screen = Some(text.clone());
    let rows = parse_grok_usage_screen(&text);
    if rows.is_empty() {
        snapshot.status = GrokProbeStatus::ParseFailed;
        snapshot.rows.clear();
        return;
    }
    snapshot.rows = rows;
    snapshot.status = GrokProbeStatus::Ready;
    snapshot.captured_at_ms = Some(now_ms());
}
