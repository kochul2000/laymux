use std::fmt;

use serde::{Deserialize, Serialize};

use crate::constants::EXACT_GEOMETRY_CUTOVER_UNAVAILABLE;

/// Production capability is intentionally false until #636 supplies an
/// OS-proven adapter. This shape is shared by Local Tauri and Remote HTTP.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalGeometryCapabilities {
    pub exact_geometry_cutover: bool,
    pub interruptible_read: bool,
    pub follow_up_issue: u32,
}

pub const fn production_geometry_capabilities() -> TerminalGeometryCapabilities {
    TerminalGeometryCapabilities {
        exact_geometry_cutover: false,
        interruptible_read: false,
        follow_up_issue: 636,
    }
}

pub fn reject_unavailable_exact_geometry() -> Result<(), String> {
    if production_geometry_capabilities().exact_geometry_cutover {
        Ok(())
    } else {
        Err(EXACT_GEOMETRY_CUTOVER_UNAVAILABLE.into())
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum ProvenanceCapability {
    #[default]
    Unsupported,
    ProducerFreezeAndDrain,
    KernelByteEpoch,
}

impl ProvenanceCapability {
    pub(super) fn supports_exact(self) -> bool {
        !matches!(self, Self::Unsupported)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalResizeOutcome {
    Applied,
    NotApplied,
    Indeterminate,
}

pub trait PtyGeometryProvenanceAdapter {
    fn capability(&self) -> ProvenanceCapability;

    /// Freeze every old-geometry producer and deliver the authoritative drain
    /// through the existing old-revision callback before returning its exact
    /// source boundary. A quiet/empty heuristic must return Unsupported instead.
    fn freeze_and_drain(
        &mut self,
        starting_seq: u64,
        on_old_output: &mut dyn FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<u64, String>;

    fn abort_prepared(&mut self) -> Result<(), String>;
    fn apply_resize(&mut self, geometry: TerminalGeometry) -> PhysicalResizeOutcome;

    /// After the physical resize is proven Applied, atomically commit the
    /// authoritative logical PTY configuration and terminal-output geometry
    /// revision. Any error is post-physical and therefore Indeterminate; an
    /// adapter must never claim that a partial logical commit was rolled back.
    fn commit_authoritative_geometry(&mut self, geometry: TerminalGeometry) -> Result<(), String>;

    fn release(&mut self) -> Result<(), String>;
    fn teardown(&mut self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalGeometry {
    pub cols: u16,
    pub rows: u16,
    pub revision: u64,
}

impl TerminalGeometry {
    pub fn new(cols: u16, rows: u16, revision: u64) -> Result<Self, String> {
        if cols == 0 || rows == 0 {
            return Err("terminal size must be positive".into());
        }
        Ok(Self {
            cols,
            rows,
            revision,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryOwnerKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GeometryParticipantRole {
    PcVisible,
    RemoteBrowser,
    RendererCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeometryParticipant {
    pub id: String,
    pub role: GeometryParticipantRole,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeometryPrepareRequest {
    pub generation: u64,
    pub owner_kind: GeometryOwnerKind,
    pub owner_epoch: u64,
    pub participants: Vec<GeometryParticipant>,
    pub source_seq: u64,
    pub old_geometry: TerminalGeometry,
    pub proposed_geometry: TerminalGeometry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GeometryTransactionToken {
    pub generation: u64,
    pub owner_epoch: u64,
    pub nonce: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryTransactionPhase {
    Idle,
    Preparing,
    Prepared,
    Applying,
    AppliedAwaitingAdoption,
    Indeterminate,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryTransactionOutcome {
    Prepared,
    AppliedAwaitingAdoption,
    Released,
    NotApplied,
    Indeterminate,
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeometryTransactionStatus {
    pub token: Option<GeometryTransactionToken>,
    pub outcome: GeometryTransactionOutcome,
    pub boundary_seq: Option<u64>,
    pub geometry: Option<TerminalGeometry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeometryTransactionError {
    Unsupported,
    InvalidParticipants,
    InvalidGeometryRevision,
    Busy,
    TokenMismatch,
    WrongPhase,
    UnknownParticipant,
    SourceSequenceMismatch,
    GeometryRevisionMismatch,
    MissingParticipantAcknowledgement,
    AdapterFailure(String),
}

impl fmt::Display for GeometryTransactionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => f.write_str(EXACT_GEOMETRY_CUTOVER_UNAVAILABLE),
            Self::InvalidParticipants => f.write_str("invalid exact geometry participant set"),
            Self::InvalidGeometryRevision => {
                f.write_str("proposed geometry revision is not the next revision")
            }
            Self::Busy => f.write_str("another exact geometry transaction is active"),
            Self::TokenMismatch => f.write_str("exact geometry transaction token changed"),
            Self::WrongPhase => {
                f.write_str("exact geometry transaction phase does not allow this operation")
            }
            Self::UnknownParticipant => {
                f.write_str("participant is not in the frozen transaction quorum")
            }
            Self::SourceSequenceMismatch => {
                f.write_str("participant did not acknowledge the exact source boundary")
            }
            Self::GeometryRevisionMismatch => {
                f.write_str("participant adopted a different geometry revision")
            }
            Self::MissingParticipantAcknowledgement => {
                f.write_str("authoritative participant quorum is incomplete")
            }
            Self::AdapterFailure(error) => write!(f, "PTY geometry adapter failed: {error}"),
        }
    }
}

impl std::error::Error for GeometryTransactionError {}
