use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::lock_ext::MutexExt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFlowControl {
    /// Opaque attach lease identity. A string avoids truncating a Rust `u64`
    /// when the value crosses the JavaScript number boundary.
    pub token: String,
    pub window_bytes: usize,
}

#[derive(Debug, Clone)]
struct DesktopOutputLease {
    token: Option<String>,
    acknowledged_seq: u64,
    window_bytes: u64,
}

#[derive(Default)]
struct DesktopOutputFlowState {
    next_token: u64,
    active: Option<DesktopOutputLease>,
    retired: bool,
}

/// Generation-local credit gate for the desktop surface.
///
/// The PTY reader waits only on this mutex/condvar, after every protocol,
/// output-ring, AppState and event operation has released its locks.
pub(super) struct DesktopOutputFlow {
    state: Mutex<DesktopOutputFlowState>,
    changed: Condvar,
    /// Independent fail-stop bit. Normal credit state is never trusted after
    /// poison; retirement alone publishes this bit and wakes fatal waiters.
    retired: AtomicBool,
}

impl DesktopOutputFlow {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(DesktopOutputFlowState::default()),
            changed: Condvar::new(),
            retired: AtomicBool::new(false),
        }
    }

    pub(super) fn begin_bootstrap(&self, window_bytes: usize) -> Result<(), String> {
        let mut state = self.lock_state()?;
        if state.retired {
            return Ok(());
        }
        state.active = Some(DesktopOutputLease {
            token: None,
            acknowledged_seq: 0,
            window_bytes: window_bytes.max(1) as u64,
        });
        self.changed.notify_all();
        Ok(())
    }

    pub(super) fn attach(
        &self,
        acknowledged_seq: u64,
        window_bytes: usize,
    ) -> Result<TerminalOutputFlowControl, String> {
        let mut state = self.lock_state()?;
        state.next_token = state.next_token.wrapping_add(1).max(1);
        let token = state.next_token.to_string();
        state.active = Some(DesktopOutputLease {
            token: Some(token.clone()),
            acknowledged_seq,
            window_bytes: window_bytes.max(1) as u64,
        });
        // A same-generation reattach must wake a waiter so it stops evaluating
        // the superseded token and starts waiting on the replacement prefix.
        self.changed.notify_all();
        Ok(TerminalOutputFlowControl {
            token,
            window_bytes: window_bytes.max(1),
        })
    }

    pub(super) fn acknowledge(
        &self,
        token: &str,
        seq: u64,
        current_seq: u64,
    ) -> Result<bool, String> {
        if seq > current_seq {
            return Err(format!(
                "terminal output ACK {seq} is ahead of current sequence {current_seq}"
            ));
        }
        let mut state = self.lock_state()?;
        if state.retired {
            return Ok(false);
        }
        let Some(active) = state.active.as_mut() else {
            return Ok(false);
        };
        if active.token.as_deref() != Some(token) {
            return Ok(false);
        }
        if seq < active.acknowledged_seq {
            return Err(format!(
                "terminal output ACK {seq} is behind acknowledged sequence {}",
                active.acknowledged_seq
            ));
        }
        if seq > active.acknowledged_seq {
            active.acknowledged_seq = seq;
            self.changed.notify_all();
        }
        Ok(true)
    }

    pub(super) fn wait_for_capacity(&self, produced_seq: u64) -> Result<(), String> {
        let mut state = self.lock_state()?;
        while !state.retired
            && state.active.as_ref().is_some_and(|active| {
                produced_seq.saturating_sub(active.acknowledged_seq) >= active.window_bytes
            })
        {
            state = self
                .changed
                .wait(state)
                .map_err(|error| format!("terminal desktop flow lock poisoned: {error}"))?;
        }
        Ok(())
    }

    /// Stop the PTY reader after the sequenced ring/protocol path failed.
    ///
    /// Unlike ordinary credit waiting this deliberately ignores leases and
    /// ACKs. Once bytes failed to enter the authoritative sequence there is no
    /// safe prefix a surface can acknowledge, so only generation retirement
    /// may let the callback return.
    pub(super) fn wait_until_retired(&self) {
        let mut state = self
            .state
            .lock_or_recover_for_cleanup("waiting for terminal output retirement");
        while !self.retired.load(Ordering::Acquire) {
            state = match self.changed.wait(state) {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }

    pub(super) fn retire(&self) {
        // Publish the only fact fatal waiters may trust before recovering the
        // poisoned guard solely to clear/discard it and notify the condvar.
        self.retired.store(true, Ordering::Release);
        let mut state = self
            .state
            .lock_or_recover_for_cleanup("retiring terminal desktop flow");
        state.retired = true;
        state.active = None;
        self.changed.notify_all();
    }

    pub(super) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, DesktopOutputFlowState>, String> {
        self.state.lock_or_err().map_err(|error| format!("{error}"))
    }

    #[cfg(test)]
    pub(super) fn poison_for_test(&self) {
        let _state = self.state.lock().unwrap();
        panic!("poison terminal desktop flow for test");
    }
}
