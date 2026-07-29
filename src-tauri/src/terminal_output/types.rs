use serde::{Deserialize, Serialize};
use std::fmt;

use super::{
    TerminalOutputFlowControl, TerminalOutputSubscriptionTerminal, TERMINAL_OUTPUT_FRAME_TYPE,
    TERMINAL_OUTPUT_PROTOCOL_VERSION,
};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopTerminalOutputAttachOutcome {
    Attached(DesktopTerminalOutputAttachment),
    FailStopped {
        terminal_id: String,
        generation: u64,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputReceiptSlotDiagnostics {
    pub generation: u64,
    pub lease_token: String,
    pub envelope_id: u64,
    pub grant_id: Option<String>,
    pub seq_start: u64,
    pub seq_end: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputDesktopDiagnostics {
    pub terminal_id: String,
    pub generation: u64,
    pub desktop_output_state: String,
    pub reason: Option<String>,
    pub lease_token: Option<String>,
    pub parsed_ack: Option<u64>,
    pub write_seq: u64,
    pub ring_start_seq: u64,
    pub ring_end_seq: u64,
    pub delivery_observed_seq: u64,
    pub pending_delivery_bytes: usize,
    pub active_grant_id: Option<String>,
    pub receipt_slot: Option<TerminalOutputReceiptSlotDiagnostics>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputFailStopNotice {
    pub terminal_id: String,
    pub generation: u64,
    pub lease_token: Option<String>,
    pub reason: String,
}

pub type TerminalOutputFailStopNotifier =
    dyn Fn(&TerminalOutputFailStopNotice) + Send + Sync + 'static;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalOutputRecordFailureKind {
    Transport,
    Credit,
    Authoritative,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutputRecordError {
    pub kind: TerminalOutputRecordFailureKind,
    pub message: String,
}

impl TerminalOutputRecordError {
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: TerminalOutputRecordFailureKind::Transport,
            message: message.into(),
        }
    }

    pub fn credit(message: impl Into<String>) -> Self {
        Self {
            kind: TerminalOutputRecordFailureKind::Credit,
            message: message.into(),
        }
    }

    pub fn authoritative(message: impl Into<String>) -> Self {
        Self {
            kind: TerminalOutputRecordFailureKind::Authoritative,
            message: message.into(),
        }
    }

    pub fn requires_generation_teardown(&self) -> bool {
        self.kind == TerminalOutputRecordFailureKind::Authoritative
    }
}

impl fmt::Display for TerminalOutputRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TerminalOutputRecordError {}

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
