//! `laymux --pty-daemon`: the daemon process entry point.

use std::fs::{File, OpenOptions, TryLockError};
use std::sync::Mutex;
use std::time::Duration;

use super::discovery::{
    generate_token, remove_discovery_if_owned, write_discovery, DaemonPaths, Discovery,
};
use super::server::DaemonServer;
use super::transport::Listener;
use super::wire::PROTOCOL_VERSION;
use crate::constants::{
    PTY_DAEMON_IDLE_EXIT_MS, PTY_DAEMON_LAUNCH_POLL_MS, PTY_DAEMON_LOG_ROTATE_BYTES,
};

/// Short retries before concluding another daemon owns the directory.
const LOCK_RETRIES: u32 = 10;

/// Run the daemon until it goes idle. Returns the process exit code.
pub fn run_daemon_main() -> i32 {
    match run() {
        Ok(()) => 0,
        Err(error) => {
            tracing::error!(%error, "PTY daemon failed");
            1
        }
    }
}

fn run() -> Result<(), String> {
    // `laymux --pty-daemon <dir>`: the launcher always names the directory.
    let paths = match std::env::args_os().nth(2) {
        Some(dir) => DaemonPaths::in_dir(dir),
        None => DaemonPaths::for_current_build()?,
    };
    paths
        .ensure_dir()
        .map_err(|error| format!("cannot create PTY daemon directory: {error}"))?;
    init_logging(&paths);

    // One daemon per directory. The kernel releases this lock when the
    // process dies, so a crashed daemon never blocks its successor and a
    // stale PID in discovery never matters.
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock_file())
        .map_err(|error| format!("cannot open PTY daemon lock: {error}"))?;
    // A GUI probing liveness holds the lock for an instant; only a lock that
    // stays held means another daemon.
    let mut attempt = lock.try_lock();
    for _ in 0..LOCK_RETRIES {
        if !matches!(attempt, Err(TryLockError::WouldBlock)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(PTY_DAEMON_LAUNCH_POLL_MS));
        attempt = lock.try_lock();
    }
    match attempt {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            tracing::info!("another PTY daemon owns this directory; exiting");
            return Ok(());
        }
        Err(TryLockError::Error(error)) => {
            return Err(format!("cannot lock PTY daemon directory: {error}"))
        }
    }

    let token = generate_token()?;
    let (listener, endpoint) = Listener::bind(paths.dir())
        .map_err(|error| format!("cannot bind PTY daemon endpoint: {error}"))?;
    let server = DaemonServer::new(token.clone());
    let pid = std::process::id();
    write_discovery(
        &paths,
        &Discovery {
            pid,
            endpoint: endpoint.clone(),
            token,
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .map_err(|error| format!("cannot publish PTY daemon discovery: {error}"))?;
    tracing::info!(pid, %endpoint, "PTY daemon ready");

    let served = server.run(
        listener,
        endpoint,
        Some(Duration::from_millis(PTY_DAEMON_IDLE_EXIT_MS)),
    );
    remove_discovery_if_owned(&paths, pid);
    drop(lock);
    served.map_err(|error| format!("PTY daemon accept loop failed: {error}"))
}

fn init_logging(paths: &DaemonPaths) {
    let path = paths.log_file();
    let rotate =
        std::fs::metadata(&path).is_ok_and(|meta| meta.len() > PTY_DAEMON_LOG_ROTATE_BYTES);
    let file: Option<File> = OpenOptions::new()
        .create(true)
        .append(!rotate)
        .write(true)
        .truncate(rotate)
        .open(&path)
        .ok();
    let Some(file) = file else {
        return;
    };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .with_ansi(false)
        .with_target(false)
        .with_writer(Mutex::new(file))
        .try_init();
}
