//! Per-terminal lifecycle admission; its mutex never nests an AppState table lock.
use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::lock_ext::MutexExt;

#[derive(Default)]
pub(crate) struct TerminalOutputReconnectClaims {
    active: Mutex<HashSet<String>>,
    changed: Condvar,
}

pub(super) struct TerminalOutputLifecycleClaim<'a> {
    claims: &'a TerminalOutputReconnectClaims,
    id: String,
}

impl TerminalOutputReconnectClaims {
    pub(super) fn reconnect(&self, id: &str) -> Result<TerminalOutputLifecycleClaim<'_>, String> {
        if !self.active.lock_or_err()?.insert(id.to_owned()) {
            return Err("Terminal reconnect or close already in progress".into());
        }
        Ok(TerminalOutputLifecycleClaim {
            claims: self,
            id: id.to_owned(),
        })
    }

    /// Called only by a blocking close worker, before removing any table entry.
    pub(super) fn close(&self, id: &str) -> Result<TerminalOutputLifecycleClaim<'_>, String> {
        self.close_with_timeout(
            id,
            Duration::from_millis(crate::constants::TERMINAL_OUTPUT_RECONNECT_CLOSE_TIMEOUT_MS),
        )
    }

    fn close_with_timeout(
        &self,
        id: &str,
        timeout: Duration,
    ) -> Result<TerminalOutputLifecycleClaim<'_>, String> {
        let deadline = Instant::now() + timeout;
        let mut active = self.active.lock_or_err()?;
        while active.contains(id) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Terminal reconnect is still in progress; close timed out".into());
            }
            active = self
                .changed
                .wait_timeout(active, remaining)
                .map_err(|_| "Terminal lifecycle claim lock poisoned")?
                .0;
        }
        active.insert(id.to_owned());
        Ok(TerminalOutputLifecycleClaim {
            claims: self,
            id: id.to_owned(),
        })
    }
}

impl Drop for TerminalOutputLifecycleClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.claims.active.lock_or_err() {
            active.remove(&self.id);
        }
        self.claims.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};

    #[test]
    fn close_waits_for_reconnect_cleanup_and_excludes_the_next_reconnect() {
        let claims = Arc::new(TerminalOutputReconnectClaims::default());
        let reconnect = claims.reconnect("pane").unwrap();
        let (entered, waiting) = mpsc::channel();
        let (closed, done) = mpsc::channel();
        let worker_claims = Arc::clone(&claims);
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            let close = worker_claims.close("pane").unwrap();
            assert!(worker_claims.reconnect("pane").is_err());
            closed.send(()).unwrap();
            drop(close);
        });
        waiting.recv().unwrap();
        assert!(done.try_recv().is_err());
        drop(reconnect);
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert!(claims.reconnect("pane").is_ok());
    }

    #[test]
    fn close_timeout_keeps_the_original_claim_and_allows_other_terminals() {
        let claims = TerminalOutputReconnectClaims::default();
        let original = claims.reconnect("pane").unwrap();
        assert!(claims
            .close_with_timeout("pane", Duration::from_millis(5))
            .is_err());
        assert!(claims.reconnect("pane").is_err());
        assert!(claims.reconnect("other").is_ok());
        drop(original);
        assert!(claims.close("pane").is_ok());
    }
}
