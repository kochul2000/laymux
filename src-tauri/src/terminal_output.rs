//! Generation-scoped terminal protocol state, output ring, and atomic attach.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, watch};

pub use crate::constants::{
    EVENT_TERMINAL_OUTPUT_V3_PREFIX as TERMINAL_OUTPUT_V3_EVENT_PREFIX,
    TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES, TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS,
    TERMINAL_OUTPUT_ENVELOPE_MAX_WIRE_BYTES,
};
use crate::lock_ext::MutexExt;
use crate::output_buffer::{TerminalOutputBuffer, TerminalOutputSlice};
use crate::terminal_protocol::{TerminalProtocolSnapshot, TerminalProtocolState};

mod desktop_flow;
use desktop_flow::DesktopOutputFlow;
pub use desktop_flow::TerminalOutputFlowControl;
mod delivery_contract;
pub use delivery_contract::{
    TerminalOutputContinuationCompletion, TerminalOutputControlCompletion,
    TerminalOutputDeliveryAdmission, TerminalOutputDeliveryCloseHook,
    TerminalOutputDeliveryCloseReason, TerminalOutputDeltaEnvelopeV3,
    TerminalOutputEnvelopeEmitter, TerminalOutputEnvelopeGeometryRun,
    TerminalOutputEnvelopeIdentity, TerminalOutputEnvelopeRepairResponse,
    TerminalOutputEnvelopeRepairStatus, TerminalOutputReceiptCompletion,
    TERMINAL_OUTPUT_ENVELOPE_VERSION,
};
mod delivery;
pub use delivery::DesktopOutputDelivery;
mod delivery_continuation;
mod delivery_deadline;
mod delivery_support;
mod delivery_worker;
mod session;
mod subscription;
mod surface_fail_stop;
pub use subscription::{TerminalOutputSubscribedAttachment, TerminalOutputSubscription};
mod types;
pub use types::*;

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
    desktop_delivery: DesktopOutputDelivery,
    /// Serializes one PTY producer's pre-admission through delivery enqueue.
    desktop_ingress_gate: Mutex<()>,
    /// Serializes attach, parsed ACK, receipt, hold and close projections.
    desktop_control_gate: Mutex<()>,
    delivery_failure: Mutex<Option<TerminalOutputDeliveryCloseReason>>,
    /// A desktop generation publishes at most one terminal fail-stop event,
    /// even if later retirement discovers a second shutdown symptom.
    fail_stop_notice_sent: AtomicBool,
    /// Generation-local, exactly-once handoff from the PTY reader callback to
    /// the asynchronous catalog/OS-resource teardown worker.
    fatal_teardown_requested: AtomicBool,
}

/// Rollback guard for the create path. Until committed, every error (including
/// PTY spawn failure) conditionally retires only this generation and removes
/// its compatibility projections.
mod registry;
use registry::attachment_from_snapshot;
pub use registry::*;
mod registry_retirement;
pub use registry_retirement::*;

mod attach_outcome;
mod desktop_integration;
mod desktop_integration_api;
pub use desktop_integration_api::{
    acknowledge_desktop_terminal_output_envelope, close_desktop_terminal_output_continuation,
    fail_stop_desktop_terminal_output_surface, hold_desktop_terminal_output_continuation,
    repair_desktop_terminal_output_envelope, terminal_output_diagnostics,
};

#[cfg(test)]
mod attach_outcome_tests;
#[cfg(test)]
mod delivery_tests;
#[cfg(test)]
mod desktop_integration_tests;
#[cfg(test)]
mod tests;
