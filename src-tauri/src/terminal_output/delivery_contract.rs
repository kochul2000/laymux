use std::time::Instant;

use serde::Serialize;

use super::{TerminalGeometry, TerminalOutputDelta};

pub const TERMINAL_OUTPUT_ENVELOPE_VERSION: u8 = 3;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEnvelopeGeometryRun {
    pub delta_index: u32,
    pub geometry: TerminalGeometry,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputDeltaEnvelopeV3 {
    pub version: u8,
    pub generation: u64,
    pub lease_token: String,
    pub envelope_id: u64,
    pub grant_id: Option<String>,
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
    pub delta_ends: Vec<u32>,
    pub geometry_runs: Vec<TerminalOutputEnvelopeGeometryRun>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutputEnvelopeIdentity {
    pub generation: u64,
    pub lease_token: String,
    pub envelope_id: u64,
    pub grant_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalOutputDeliveryCloseReason {
    Retired,
    EmitFailed(String),
    ReceiptExpired,
    ContinuationExpired,
    ParsedProgressExpired,
    DesktopSnapshotIncomplete,
    IdentityConflict,
    SurfaceUnavailable,
    ControlOrphanCap,
    ContractViolation(String),
    WorkerPanicked,
    WorkerShutdownTimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalOutputDeliveryAdmission {
    Queued,
    CoveredBySnapshot,
    BootstrapRingOnly,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalOutputControlCompletion {
    Accepted,
    Duplicate,
    Stale,
}

pub type TerminalOutputReceiptCompletion = TerminalOutputControlCompletion;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalOutputEnvelopeRepairStatus {
    Exact,
    Idle,
    Stale,
    AlreadyReceipted,
    Mismatch,
    Exhausted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEnvelopeRepairResponse {
    pub status: TerminalOutputEnvelopeRepairStatus,
    pub envelope: Option<TerminalOutputDeltaEnvelopeV3>,
}

pub type TerminalOutputEnvelopeEmitter =
    dyn Fn(&str, &TerminalOutputDeltaEnvelopeV3) -> Result<(), String> + Send + Sync + 'static;
pub type TerminalOutputDeliveryCloseHook =
    std::sync::Arc<dyn Fn(TerminalOutputDeliveryCloseReason) + Send + Sync>;

#[derive(Clone)]
pub(super) struct DeliveryLease {
    pub(super) token: String,
    pub(super) grant_id: Option<String>,
    pub(super) grant_expires_at: Option<Instant>,
    /// True after this lease has admitted any production v3 delta. Prefix ACK
    /// compatibility is forbidden from that point onward.
    pub(super) v3_admitted: bool,
}

#[derive(Debug, Clone)]
pub(super) struct InFlightEnvelope {
    pub(super) envelope: TerminalOutputDeltaEnvelopeV3,
    pub(super) expires_at: Instant,
    pub(super) repair_attempts: u8,
}

impl InFlightEnvelope {
    pub(super) fn identity(&self) -> TerminalOutputEnvelopeIdentity {
        (&self.envelope).into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReceiptRecord {
    pub(super) identity: TerminalOutputEnvelopeIdentity,
    pub(super) seq_end: u64,
    /// A receipt owns bytes before its flow projection is committed. If that
    /// second projection fails, every exact retry must return the same terminal
    /// result instead of disguising it as a successful duplicate.
    pub(super) terminal_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HoldRecord {
    pub(super) opener: TerminalOutputEnvelopeIdentity,
    pub(super) grant_id: String,
    pub(super) frame_start_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CloseRecord {
    pub(super) identity: TerminalOutputEnvelopeIdentity,
    pub(super) opener_envelope_id: u64,
    pub(super) close_seq: u64,
    pub(super) reason: String,
    pub(super) frame_start_seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalOutputContinuationCompletion {
    pub completion: TerminalOutputControlCompletion,
    pub opener_envelope_id: Option<u64>,
    pub frame_start_seq: Option<u64>,
}

#[derive(Debug, Clone)]
pub(super) struct DeliveryDiagnostics {
    pub(super) closed: bool,
    pub(super) close_reason: Option<TerminalOutputDeliveryCloseReason>,
    pub(super) lease_token: Option<String>,
    pub(super) grant_id: Option<String>,
    pub(super) parsed_seq: u64,
    pub(super) observed_seq: u64,
    pub(super) pending_bytes: usize,
    pub(super) in_flight: Option<InFlightEnvelope>,
}

impl From<&TerminalOutputDeltaEnvelopeV3> for TerminalOutputEnvelopeIdentity {
    fn from(envelope: &TerminalOutputDeltaEnvelopeV3) -> Self {
        Self {
            generation: envelope.generation,
            lease_token: envelope.lease_token.clone(),
            envelope_id: envelope.envelope_id,
            grant_id: envelope.grant_id.clone(),
        }
    }
}

pub(super) fn build_envelope(
    generation: u64,
    envelope_id: u64,
    lease: &DeliveryLease,
    deltas: &[TerminalOutputDelta],
) -> Result<TerminalOutputDeltaEnvelopeV3, String> {
    let first = deltas
        .first()
        .ok_or_else(|| "empty terminal output envelope".to_string())?;
    let last = deltas
        .last()
        .ok_or_else(|| "empty terminal output envelope".to_string())?;
    let mut offset = 0u32;
    let mut delta_ends = Vec::with_capacity(deltas.len());
    let mut data = Vec::with_capacity((last.seq_end - first.seq_start) as usize);
    for delta in deltas {
        data.extend_from_slice(&delta.data);
        offset = offset
            .checked_add(delta.data.len() as u32)
            .ok_or_else(|| "terminal output envelope offset overflow".to_string())?;
        delta_ends.push(offset);
    }
    Ok(TerminalOutputDeltaEnvelopeV3 {
        version: TERMINAL_OUTPUT_ENVELOPE_VERSION,
        generation,
        lease_token: lease.token.clone(),
        envelope_id,
        grant_id: lease.grant_id.clone(),
        seq_start: first.seq_start,
        seq_end: last.seq_end,
        data,
        delta_ends,
        geometry_runs: vec![TerminalOutputEnvelopeGeometryRun {
            delta_index: 0,
            geometry: first.geometry,
        }],
    })
}
