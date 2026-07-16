//! Generation-scoped terminal protocol state, output ring, and atomic attach.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};

use crate::lock_ext::MutexExt;
use crate::output_buffer::{TerminalOutputBuffer, TerminalOutputSlice};
use crate::terminal_protocol::{TerminalProtocolSnapshot, TerminalProtocolState};

pub const TERMINAL_OUTPUT_PROTOCOL_VERSION: u8 = 1;
pub const TERMINAL_OUTPUT_PROTOCOL_NAME: &str = "laymux-terminal-output.v1";
pub const TERMINAL_OUTPUT_FRAME_TYPE: &str = "terminal.output";
pub const TERMINAL_OUTPUT_SUBSCRIBER_CAPACITY: usize = 256;

pub type TerminalProtocolGate = Arc<Mutex<TerminalProtocolState>>;
type TerminalProtocolMap = HashMap<String, TerminalProtocolGate>;

/// Compatibility protocol index plus the canonical generation-scoped session
/// registry. Existing callers can continue using this value like the old
/// `Arc<Mutex<HashMap<...>>>` through `Deref`.
#[derive(Clone, Default)]
pub struct SharedTerminalProtocolStates {
    gates: Arc<Mutex<TerminalProtocolMap>>,
    sessions: Arc<Mutex<TerminalOutputSessionRegistry>>,
}

impl Deref for SharedTerminalProtocolStates {
    type Target = Mutex<TerminalProtocolMap>;

    fn deref(&self) -> &Self::Target {
        &self.gates
    }
}

#[derive(Default)]
struct TerminalOutputSessionRegistry {
    next_generation: u64,
    active: HashMap<String, Arc<TerminalOutputSession>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachModes {
    pub bracketed_paste: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachState {
    pub version: u8,
    pub snapshot_start_seq: u64,
    pub snapshot_seq: u64,
    pub protocol_revision: u64,
    pub modes: TerminalAttachModes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputAttachment {
    pub state: TerminalAttachState,
    pub snapshot: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputDelta {
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFrameHeaderV1 {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub version: u8,
    pub phase: TerminalOutputPhase,
    pub seq_start: u64,
    pub seq_end: u64,
    pub byte_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<TerminalAttachState>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalOutputPhase {
    Snapshot,
    Delta,
}

impl TerminalOutputFrameHeaderV1 {
    pub fn snapshot(attachment: &TerminalOutputAttachment) -> Self {
        Self {
            frame_type: TERMINAL_OUTPUT_FRAME_TYPE.into(),
            version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
            phase: TerminalOutputPhase::Snapshot,
            seq_start: attachment.state.snapshot_start_seq,
            seq_end: attachment.state.snapshot_seq,
            byte_length: attachment.snapshot.len(),
            state: Some(attachment.state.clone()),
        }
    }

    pub fn delta(delta: &TerminalOutputDelta) -> Self {
        Self {
            frame_type: TERMINAL_OUTPUT_FRAME_TYPE.into(),
            version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
            phase: TerminalOutputPhase::Delta,
            seq_start: delta.seq_start,
            seq_end: delta.seq_end,
            byte_length: delta.data.len(),
            state: None,
        }
    }
}

/// Terminal condition for a generation-scoped subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalOutputSubscriptionEvent {
    Delta(TerminalOutputDelta),
    Gap {
        generation: u64,
        expected_seq: u64,
        retained_start_seq: u64,
        current_seq: u64,
    },
    Retired {
        generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalOutputSubscriptionTerminal {
    Gap {
        generation: u64,
        expected_seq: u64,
        retained_start_seq: u64,
        current_seq: u64,
    },
    Retired {
        generation: u64,
    },
}

impl From<TerminalOutputSubscriptionTerminal> for TerminalOutputSubscriptionEvent {
    fn from(value: TerminalOutputSubscriptionTerminal) -> Self {
        match value {
            TerminalOutputSubscriptionTerminal::Gap {
                generation,
                expected_seq,
                retained_start_seq,
                current_seq,
            } => Self::Gap {
                generation,
                expected_seq,
                retained_start_seq,
                current_seq,
            },
            TerminalOutputSubscriptionTerminal::Retired { generation } => {
                Self::Retired { generation }
            }
        }
    }
}

struct TerminalOutputSubscriber {
    next_seq: u64,
    delta_tx: mpsc::Sender<TerminalOutputDelta>,
    terminal_tx: watch::Sender<Option<TerminalOutputSubscriptionTerminal>>,
}

struct TerminalOutputSessionRuntime {
    creating: bool,
    retired: bool,
    next_subscriber_id: u64,
    subscribers: HashMap<u64, TerminalOutputSubscriber>,
}

impl Default for TerminalOutputSessionRuntime {
    fn default() -> Self {
        Self {
            creating: true,
            retired: false,
            next_subscriber_id: 0,
            subscribers: HashMap::new(),
        }
    }
}

/// One immutable terminal generation. Protocol state, ring identity, and all
/// output subscribers live behind this Arc for the generation's full lifetime.
pub struct TerminalOutputSession {
    terminal_id: String,
    generation: u64,
    protocol: TerminalProtocolGate,
    output: TerminalOutputBuffer,
    runtime: Mutex<TerminalOutputSessionRuntime>,
}

impl TerminalOutputSession {
    fn new(terminal_id: String, generation: u64, output: TerminalOutputBuffer) -> Self {
        Self {
            terminal_id,
            generation,
            protocol: new_protocol_gate(),
            output,
            runtime: Mutex::new(TerminalOutputSessionRuntime::default()),
        }
    }

    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn protocol_gate(&self) -> TerminalProtocolGate {
        Arc::clone(&self.protocol)
    }

    pub fn output_buffer(&self) -> TerminalOutputBuffer {
        self.output.clone()
    }

    /// Parse and record one PTY callback chunk for this exact generation.
    /// `None` means the generation was retired and the stale callback was
    /// deliberately dropped rather than written into a replacement session.
    pub fn record_output(&self, data: &[u8]) -> Result<Option<TerminalOutputDelta>, String> {
        let mut protocol = self.protocol.lock_or_err()?;
        let mut runtime = self.runtime.lock_or_err()?;
        if runtime.retired {
            return Ok(None);
        }

        protocol.process_output(data);
        let written = self.output.push_sequenced(data);
        let delta = TerminalOutputDelta {
            seq_start: written.seq_start,
            seq_end: written.seq_end,
            data: written.data,
        };

        let retained_start_seq = self.output.start_seq();
        let mut remove = Vec::new();
        for (&subscriber_id, subscriber) in &mut runtime.subscribers {
            if subscriber.next_seq != delta.seq_start {
                subscriber.terminal_tx.send_replace(Some(
                    TerminalOutputSubscriptionTerminal::Gap {
                        generation: self.generation,
                        expected_seq: subscriber.next_seq,
                        retained_start_seq,
                        current_seq: delta.seq_end,
                    },
                ));
                remove.push(subscriber_id);
                continue;
            }

            match subscriber.delta_tx.try_send(delta.clone()) {
                Ok(()) => subscriber.next_seq = delta.seq_end,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    subscriber.terminal_tx.send_replace(Some(
                        TerminalOutputSubscriptionTerminal::Gap {
                            generation: self.generation,
                            expected_seq: subscriber.next_seq,
                            retained_start_seq,
                            current_seq: delta.seq_end,
                        },
                    ));
                    remove.push(subscriber_id);
                }
                Err(mpsc::error::TrySendError::Closed(_)) => remove.push(subscriber_id),
            }
        }
        for subscriber_id in remove {
            runtime.subscribers.remove(&subscriber_id);
        }

        Ok(Some(delta))
    }

    fn attach(&self, max_snapshot_bytes: usize) -> Result<TerminalOutputAttachment, String> {
        let protocol = self.protocol.lock_or_err()?;
        let runtime = self.runtime.lock_or_err()?;
        if runtime.retired {
            return Err(format!("Session '{}' not found", self.terminal_id));
        }
        if runtime.creating {
            return Err(format!(
                "Session '{}' is still being created",
                self.terminal_id
            ));
        }
        let snapshot = self.output.snapshot(max_snapshot_bytes);
        Ok(attachment_from_snapshot(protocol.snapshot(), snapshot))
    }

    fn attach_and_subscribe(
        self: &Arc<Self>,
        max_snapshot_bytes: usize,
        queue_capacity: usize,
    ) -> Result<TerminalOutputSubscribedAttachment, String> {
        if queue_capacity == 0 {
            return Err("terminal output subscriber capacity must be positive".into());
        }

        // Registration and snapshot capture share the same protocol/runtime
        // gate as record_output. The first queued delta therefore starts at the
        // returned snapshotSeq without an attach race.
        let protocol = self.protocol.lock_or_err()?;
        let mut runtime = self.runtime.lock_or_err()?;
        if runtime.retired {
            return Err(format!("Session '{}' not found", self.terminal_id));
        }
        if runtime.creating {
            return Err(format!(
                "Session '{}' is still being created",
                self.terminal_id
            ));
        }
        let snapshot = self.output.snapshot(max_snapshot_bytes);
        let attachment = attachment_from_snapshot(protocol.snapshot(), snapshot);

        runtime.next_subscriber_id = runtime.next_subscriber_id.wrapping_add(1).max(1);
        let subscriber_id = runtime.next_subscriber_id;
        let (delta_tx, delta_rx) = mpsc::channel(queue_capacity);
        let (terminal_tx, terminal_rx) = watch::channel(None);
        runtime.subscribers.insert(
            subscriber_id,
            TerminalOutputSubscriber {
                next_seq: attachment.state.snapshot_seq,
                delta_tx,
                terminal_tx,
            },
        );

        Ok(TerminalOutputSubscribedAttachment {
            generation: self.generation,
            attachment,
            subscription: TerminalOutputSubscription {
                generation: self.generation,
                subscriber_id,
                session: Arc::downgrade(self),
                delta_rx,
                terminal_rx,
                terminal_watch_open: true,
                terminated: false,
            },
        })
    }

    fn remove_subscriber(&self, subscriber_id: u64) {
        if let Ok(mut runtime) = self.runtime.lock_or_err() {
            runtime.subscribers.remove(&subscriber_id);
        }
    }

    fn commit_creation(&self) -> Result<(), String> {
        let mut runtime = self.runtime.lock_or_err()?;
        if runtime.retired {
            return Err(format!("Session '{}' not found", self.terminal_id));
        }
        runtime.creating = false;
        Ok(())
    }

    fn retire(&self, _allow_creating: bool) -> Result<(), String> {
        let _protocol = self.protocol.lock_or_err()?;
        let mut runtime = self.runtime.lock_or_err()?;
        if runtime.retired {
            return Ok(());
        }
        // A close that wins while create is still spawning the PTY records a
        // real cancellation, not a transient error. The registration guard's
        // later commit then fails and its create path terminates the spawned
        // PTY instead of publishing an orphan session.
        runtime.retired = true;
        for subscriber in runtime.subscribers.values() {
            subscriber.terminal_tx.send_replace(Some(
                TerminalOutputSubscriptionTerminal::Retired {
                    generation: self.generation,
                },
            ));
        }
        runtime.subscribers.clear();
        Ok(())
    }

    #[cfg(test)]
    fn subscriber_count(&self) -> usize {
        self.runtime
            .lock()
            .map(|runtime| runtime.subscribers.len())
            .unwrap_or_default()
    }
}

pub struct TerminalOutputSubscription {
    generation: u64,
    subscriber_id: u64,
    session: Weak<TerminalOutputSession>,
    delta_rx: mpsc::Receiver<TerminalOutputDelta>,
    terminal_rx: watch::Receiver<Option<TerminalOutputSubscriptionTerminal>>,
    terminal_watch_open: bool,
    terminated: bool,
}

impl TerminalOutputSubscription {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Receive the next contiguous delta or a terminal gap/retirement signal.
    /// Gap/retirement wins over already queued deltas so a consumer never
    /// renders more bytes after the generation became invalid.
    pub async fn recv(&mut self) -> Option<TerminalOutputSubscriptionEvent> {
        if self.terminated {
            return None;
        }

        loop {
            if let Some(terminal) = self.terminal_rx.borrow().clone() {
                self.terminated = true;
                return Some(terminal.into());
            }

            if !self.terminal_watch_open {
                return self
                    .delta_rx
                    .recv()
                    .await
                    .map(TerminalOutputSubscriptionEvent::Delta);
            }

            tokio::select! {
                biased;
                changed = self.terminal_rx.changed() => {
                    if changed.is_err() {
                        self.terminal_watch_open = false;
                    }
                }
                delta = self.delta_rx.recv() => {
                    if let Some(terminal) = self.terminal_rx.borrow().clone() {
                        self.terminated = true;
                        return Some(terminal.into());
                    }
                    return delta.map(TerminalOutputSubscriptionEvent::Delta);
                }
            }
        }
    }
}

impl Drop for TerminalOutputSubscription {
    fn drop(&mut self) {
        if let Some(session) = self.session.upgrade() {
            session.remove_subscriber(self.subscriber_id);
        }
    }
}

pub struct TerminalOutputSubscribedAttachment {
    pub generation: u64,
    pub attachment: TerminalOutputAttachment,
    pub subscription: TerminalOutputSubscription,
}

/// Rollback guard for the create path. Until committed, every error (including
/// PTY spawn failure) conditionally retires only this generation and removes
/// its compatibility projections.
mod registry;
use registry::attachment_from_snapshot;
pub use registry::*;

#[cfg(test)]
mod tests;
