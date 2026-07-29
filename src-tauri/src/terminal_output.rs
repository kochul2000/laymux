//! Generation-scoped terminal protocol state, output ring, and atomic attach.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};

use crate::lock_ext::MutexExt;
use crate::output_buffer::{TerminalOutputBuffer, TerminalOutputSlice};
use crate::terminal_protocol::{TerminalProtocolSnapshot, TerminalProtocolState};

mod desktop_flow;
use desktop_flow::DesktopOutputFlow;
pub use desktop_flow::TerminalOutputFlowControl;

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalGeometry {
    pub revision: u64,
    pub cols: u16,
    pub rows: u16,
}

impl TerminalGeometry {
    pub fn new(cols: u16, rows: u16) -> Result<Self, String> {
        if cols == 0 || rows == 0 {
            return Err("terminal size must be positive".into());
        }
        Ok(Self {
            revision: 0,
            cols,
            rows,
        })
    }
}

impl Default for TerminalGeometry {
    fn default() -> Self {
        Self {
            revision: 0,
            cols: 80,
            rows: 24,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalSnapshotKind {
    Raw,
    Screen,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachState {
    pub version: u8,
    pub generation: u64,
    pub snapshot_start_seq: u64,
    pub snapshot_seq: u64,
    pub source_start_seq: u64,
    pub source_seq: u64,
    pub snapshot_kind: TerminalSnapshotKind,
    pub protocol_revision: u64,
    pub modes: TerminalAttachModes,
    pub geometry: TerminalGeometry,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputAttachment {
    pub state: TerminalAttachState,
    pub snapshot: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTerminalOutputAttachment {
    #[serde(flatten)]
    pub attachment: TerminalOutputAttachment,
    pub flow_control: TerminalOutputFlowControl,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputDelta {
    pub generation: u64,
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
    pub geometry: TerminalGeometry,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRenderCheckpointTarget {
    pub generation: u64,
    pub seq: u64,
    pub geometry: TerminalGeometry,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRenderCheckpoint {
    pub generation: u64,
    pub seq: u64,
    pub geometry: TerminalGeometry,
    pub data: String,
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
        Self::delta_with_offset(delta, 0)
            .expect("zero wire offset cannot overflow a terminal output sequence")
    }

    pub fn delta_with_offset(
        delta: &TerminalOutputDelta,
        wire_seq_offset: u64,
    ) -> Result<Self, String> {
        let seq_start = delta
            .seq_start
            .checked_add(wire_seq_offset)
            .ok_or_else(|| "terminal output wire sequence overflow".to_string())?;
        let seq_end = delta
            .seq_end
            .checked_add(wire_seq_offset)
            .ok_or_else(|| "terminal output wire sequence overflow".to_string())?;
        Ok(Self {
            frame_type: TERMINAL_OUTPUT_FRAME_TYPE.into(),
            version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
            phase: TerminalOutputPhase::Delta,
            seq_start,
            seq_end,
            byte_length: delta.data.len(),
            state: None,
        })
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
    geometry: TerminalGeometry,
    next_subscriber_id: u64,
    subscribers: HashMap<u64, TerminalOutputSubscriber>,
}

impl TerminalOutputSessionRuntime {
    fn new(geometry: TerminalGeometry) -> Self {
        Self {
            creating: true,
            retired: false,
            geometry,
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
    desktop_flow: DesktopOutputFlow,
}

impl TerminalOutputSession {
    fn new(
        terminal_id: String,
        generation: u64,
        output: TerminalOutputBuffer,
        geometry: TerminalGeometry,
    ) -> Self {
        Self {
            terminal_id,
            generation,
            protocol: new_protocol_gate(),
            output,
            runtime: Mutex::new(TerminalOutputSessionRuntime::new(geometry)),
            desktop_flow: DesktopOutputFlow::new(),
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

    /// Bound output that can race ahead of the first desktop attach.
    pub fn begin_desktop_output_bootstrap(&self, window_bytes: usize) -> Result<(), String> {
        self.desktop_flow.begin_bootstrap(window_bytes)
    }

    /// Wait after a fully processed PTY callback when the desktop parsed-credit
    /// window is full. This method owns only the flow mutex while sleeping.
    pub fn wait_for_desktop_output_capacity(&self, produced_seq: u64) -> Result<(), String> {
        self.desktop_flow.wait_for_capacity(produced_seq)
    }

    /// Fail closed after `record_output` could not preserve the exact stream.
    /// ACK or reattach cannot repair bytes that never received a sequence, so
    /// the PTY callback remains parked until this generation is retired.
    pub fn wait_for_terminal_output_retirement(&self) {
        self.desktop_flow.wait_until_retired();
    }

    /// Cheap fail-stop guard for a PTY callback racing generation close.
    pub fn is_terminal_output_retired(&self) -> bool {
        self.desktop_flow.is_retired()
    }

    pub fn acknowledge_desktop_output(
        &self,
        generation: u64,
        token: &str,
        seq: u64,
    ) -> Result<bool, String> {
        if generation != self.generation {
            return Ok(false);
        }
        self.desktop_flow
            .acknowledge(token, seq, self.output.write_seq()?)
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
        let written = self.output.push_sequenced(data)?;
        let delta = TerminalOutputDelta {
            generation: self.generation,
            seq_start: written.seq_start,
            seq_end: written.seq_end,
            data: written.data,
            geometry: runtime.geometry,
        };

        let retained_start_seq = self.output.start_seq()?;
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
        let snapshot = self.output.snapshot(max_snapshot_bytes)?;
        Ok(attachment_from_snapshot(
            self.generation,
            runtime.geometry,
            protocol.snapshot(),
            snapshot,
        ))
    }

    fn attach_desktop(
        &self,
        max_snapshot_bytes: usize,
        window_bytes: usize,
    ) -> Result<DesktopTerminalOutputAttachment, String> {
        // Snapshot capture and token replacement share the protocol/runtime
        // prefix gate. The replacement ACK starts at the exact first byte in
        // the copied snapshot, and old tokens become stale before new output
        // can acquire the runtime lock.
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
        let snapshot = self.output.snapshot(max_snapshot_bytes)?;
        let attachment = attachment_from_snapshot(
            self.generation,
            runtime.geometry,
            protocol.snapshot(),
            snapshot,
        );
        let flow_control = self
            .desktop_flow
            .attach(attachment.state.snapshot_start_seq, window_bytes)?;
        Ok(DesktopTerminalOutputAttachment {
            attachment,
            flow_control,
        })
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
        let snapshot = self.output.snapshot(max_snapshot_bytes)?;
        let attachment = attachment_from_snapshot(
            self.generation,
            runtime.geometry,
            protocol.snapshot(),
            snapshot,
        );

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
            wire_seq_offset: 0,
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

    /// Serve the exact byte range a surface lost to a delivery gap.
    ///
    /// `terminal-output-v2` delivery is a notification, not a guarantee; the
    /// ring is the single source of truth for sequenced bytes ([ADR-0072]). A
    /// surface that observed `seqStart > expectedSeq` asks for `[seq, write_seq)`
    /// and splices it in without touching its screen.
    ///
    /// `Ok(None)` means the range is no longer bridgeable — the generation was
    /// replaced or the ring evicted past `seq` — and the caller must perform a
    /// fresh attach. Clamping to a shorter prefix is forbidden: it would hand
    /// back a hole disguised as a contiguous repair.
    ///
    /// [ADR-0072]: ../../docs/adr/0072-terminal-output-gap-sequence-exact-repair.md
    pub fn resume_output(
        &self,
        generation: u64,
        seq: u64,
    ) -> Result<Option<TerminalOutputDelta>, String> {
        // Same protocol → runtime gate order as `record_output`, so the range
        // and the geometry that explains it come from one consistent prefix.
        let _protocol = self.protocol.lock_or_err()?;
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
        if generation != self.generation {
            return Ok(None);
        }
        let Some(slice) = self.output.delta_since(seq)? else {
            return Ok(None);
        };
        Ok(Some(TerminalOutputDelta {
            generation: self.generation,
            seq_start: slice.seq_start,
            seq_end: slice.seq_end,
            data: slice.data,
            geometry: runtime.geometry,
        }))
    }

    fn checkpoint_target(&self) -> Result<TerminalRenderCheckpointTarget, String> {
        let _protocol = self.protocol.lock_or_err()?;
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
        Ok(TerminalRenderCheckpointTarget {
            generation: self.generation,
            seq: self.output.write_seq()?,
            geometry: runtime.geometry,
        })
    }

    fn update_geometry(&self, cols: u16, rows: u16) -> Result<TerminalGeometry, String> {
        if cols == 0 || rows == 0 {
            return Err("terminal size must be positive".into());
        }
        let _protocol = self.protocol.lock_or_err()?;
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
        if runtime.geometry.cols != cols || runtime.geometry.rows != rows {
            runtime.geometry.revision = runtime.geometry.revision.wrapping_add(1);
            runtime.geometry.cols = cols;
            runtime.geometry.rows = rows;
        }
        Ok(runtime.geometry)
    }

    fn attach_and_subscribe_from_render_checkpoint(
        self: &Arc<Self>,
        checkpoint: TerminalRenderCheckpoint,
        queue_capacity: usize,
    ) -> Result<TerminalOutputSubscribedAttachment, String> {
        if queue_capacity == 0 {
            return Err("terminal output subscriber capacity must be positive".into());
        }

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
        if checkpoint.generation != self.generation {
            return Err("terminal render checkpoint generation changed".into());
        }
        if checkpoint.geometry != runtime.geometry {
            return Err("terminal render checkpoint geometry changed".into());
        }
        let suffix = self
            .output
            .delta_since(checkpoint.seq)?
            .ok_or_else(|| "terminal render checkpoint fell behind the output ring".to_string())?;
        let serialized = checkpoint.data.into_bytes();
        let wire_seq_offset = u64::try_from(serialized.len())
            .map_err(|_| "terminal render checkpoint is too large".to_string())?;
        let wire_snapshot_seq = suffix
            .seq_end
            .checked_add(wire_seq_offset)
            .ok_or_else(|| "terminal output wire sequence overflow".to_string())?;
        let mut snapshot = serialized;
        snapshot.extend_from_slice(&suffix.data);
        let protocol_snapshot = protocol.snapshot();
        let attachment = TerminalOutputAttachment {
            state: TerminalAttachState {
                version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
                generation: self.generation,
                snapshot_start_seq: checkpoint.seq,
                snapshot_seq: wire_snapshot_seq,
                source_start_seq: checkpoint.seq,
                source_seq: suffix.seq_end,
                snapshot_kind: TerminalSnapshotKind::Screen,
                protocol_revision: protocol_snapshot.revision,
                modes: TerminalAttachModes {
                    bracketed_paste: protocol_snapshot.bracketed_paste,
                },
                geometry: runtime.geometry,
            },
            snapshot,
        };

        runtime.next_subscriber_id = runtime.next_subscriber_id.wrapping_add(1).max(1);
        let subscriber_id = runtime.next_subscriber_id;
        let (delta_tx, delta_rx) = mpsc::channel(queue_capacity);
        let (terminal_tx, terminal_rx) = watch::channel(None);
        runtime.subscribers.insert(
            subscriber_id,
            TerminalOutputSubscriber {
                next_seq: suffix.seq_end,
                delta_tx,
                terminal_tx,
            },
        );

        Ok(TerminalOutputSubscribedAttachment {
            generation: self.generation,
            attachment,
            wire_seq_offset,
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
        // Retirement discards both states, so poison is recoverable here even
        // though it is fatal on every read/write path. Recovering lets the
        // close command finish catalog cleanup and reach `PtyHandle::terminate`
        // instead of returning early while an orphan reader resumes.
        let _protocol = self
            .protocol
            .lock_or_recover_for_discard("retiring terminal output protocol");
        let mut runtime = self
            .runtime
            .lock_or_recover_for_discard("retiring terminal output runtime");
        if runtime.retired {
            self.desktop_flow.retire();
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
        // Wake credit/fatal waiters only after the generation is observably
        // retired. A callback that races close and runs again therefore sees
        // `retired`/poison and returns before OSC or legacy emission; the close
        // command can then terminate the selected PTY handle normally.
        self.desktop_flow.retire();
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
    pub wire_seq_offset: u64,
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
