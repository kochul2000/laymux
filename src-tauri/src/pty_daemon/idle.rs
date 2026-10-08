//! Idle exit: a daemon with no session and no connection stops by itself.

use std::sync::atomic::Ordering;
use std::sync::Weak;
use std::thread;
use std::time::{Duration, Instant};

use super::server::DaemonServer;
use crate::constants::PTY_DAEMON_IDLE_POLL_MS;
use crate::lock_ext::MutexExt;

pub(super) fn idle_monitor(server: Weak<DaemonServer>, endpoint: String, idle_exit: Duration) {
    let mut idle_since: Option<Instant> = None;
    // A connection that opened and closed between two polls (a GUI's probe
    // right before it opens a terminal connection) still counts as activity.
    let mut seen_admissions = 0;
    loop {
        thread::sleep(Duration::from_millis(PTY_DAEMON_IDLE_POLL_MS));
        let Some(server) = server.upgrade() else {
            return;
        };
        if server.shutdown.load(Ordering::Acquire) {
            return;
        }
        let admissions = server.next_connection_id.load(Ordering::Acquire);
        if !server.is_idle() || admissions != seen_admissions {
            seen_admissions = admissions;
            idle_since = None;
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() < idle_exit {
            continue;
        }
        // Re-check under the admission lock: a connection admitted meanwhile
        // keeps the daemon alive.
        let still_idle = match server.admission.lock_or_err() {
            Ok(_admission) => {
                let idle = server.is_idle()
                    && server.next_connection_id.load(Ordering::Acquire) == seen_admissions;
                if idle {
                    server.shutdown.store(true, Ordering::Release);
                }
                idle
            }
            Err(_) => false,
        };
        if still_idle {
            tracing::info!("PTY daemon idle; shutting down");
            server.request_shutdown(&endpoint);
            return;
        }
        idle_since = None;
    }
}
