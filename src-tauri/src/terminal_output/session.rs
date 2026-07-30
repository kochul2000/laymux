use std::sync::atomic::Ordering;

use super::registry::attachment_from_snapshot;
use super::*;

impl TerminalOutputSession {
    pub(super) fn new(
        terminal_id: String,
        generation: u64,
        output: TerminalOutputBuffer,
        geometry: TerminalGeometry,
    ) -> Self {
        let desktop_delivery = DesktopOutputDelivery::new(terminal_id.clone(), generation);
        Self {
            terminal_id,
            generation,
            protocol: new_protocol_gate(),
            output,
            runtime: Mutex::new(TerminalOutputSessionRuntime::new(geometry)),
            desktop_flow: DesktopOutputFlow::new(),
            desktop_delivery,
            desktop_ingress_gate: Mutex::new(()),
            desktop_control_gate: Mutex::new(()),
            delivery_failure: Mutex::new(None),
            fail_stop_notice_sent: AtomicBool::new(false),
            fatal_teardown_requested: AtomicBool::new(false),
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
        self.desktop_flow
            .wait_for_capacity(produced_seq.saturating_add(1))
    }

    /// Cheap fail-stop guard for a PTY callback racing generation close.
    pub fn is_terminal_output_retired(&self) -> bool {
        self.desktop_flow.is_retired()
    }

    /// Claim the one automatic teardown request owned by this generation.
    /// The caller must return `PtyOutputControl::Stop` regardless of whether it
    /// won the claim; a duplicate fatal cannot resume the reader.
    pub(crate) fn request_fatal_teardown(&self) -> bool {
        self.fatal_teardown_requested
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn fatal_teardown_requested(&self) -> bool {
        self.fatal_teardown_requested.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn set_delivery_shutdown_timeout_for_test(&self, timeout: std::time::Duration) {
        self.desktop_delivery.set_shutdown_timeout_for_test(timeout);
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
        let _control = self.desktop_control_gate.lock_or_err()?;
        let current_seq = self.output.write_seq()?;
        let delivered = match self
            .desktop_delivery
            .acknowledge_parsed(generation, token, seq)
        {
            Ok(delivered) => delivered,
            Err(v3_error) => match self.desktop_delivery.acknowledge_parsed_legacy_prefix(
                generation,
                token,
                seq,
                current_seq,
            ) {
                Ok(delivered) => delivered,
                Err(legacy_error) => {
                    return self.fail_delivery_contract(format!(
                        "terminal output parsed ACK validation failed: {v3_error}; {legacy_error}"
                    ));
                }
            },
        };
        if !delivered {
            return Ok(false);
        }
        match self.desktop_flow.acknowledge(token, seq, current_seq) {
            Ok(completion) => Ok(completion),
            Err(error) => self.fail_delivery_contract(format!(
                "terminal output parsed ACK flow projection failed: {error}"
            )),
        }
    }

    pub(super) fn attach(
        &self,
        max_snapshot_bytes: usize,
    ) -> Result<TerminalOutputAttachment, String> {
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

    pub(super) fn attach_desktop(
        &self,
        max_snapshot_bytes: usize,
        window_bytes: usize,
    ) -> Result<DesktopTerminalOutputAttachment, String> {
        // Ingress is acquired before the control gate so a producer blocked on
        // parsed credit never strands the ACK that can release it. Holding it
        // through lease installation makes the snapshot/next-envelope cut
        // atomic without nesting protocol/ring locks with flow/delivery locks.
        let _ingress = self.desktop_ingress_gate.lock_or_err()?;
        let _control = self.desktop_control_gate.lock_or_err()?;
        // Snapshot capture and token replacement share the protocol/runtime
        // prefix gate. The snapshot is the exact unparsed prefix; clamping or
        // line trimming would split a terminal control sequence.
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
        let parsed_ack = self
            .desktop_flow
            .diagnostics()?
            .parsed_ack
            .unwrap_or(self.output.start_seq()?);
        let snapshot = match self
            .output
            .exact_snapshot_since(parsed_ack, max_snapshot_bytes)
        {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                drop(runtime);
                drop(protocol);
                return self.fail_delivery(
                    TerminalOutputDeliveryCloseReason::DesktopSnapshotIncomplete,
                    "desktop_snapshot_incomplete: parsed ACK fell behind the ring".into(),
                );
            }
            Err(error) => {
                drop(runtime);
                drop(protocol);
                return self.fail_delivery(
                    TerminalOutputDeliveryCloseReason::DesktopSnapshotIncomplete,
                    format!("desktop_snapshot_incomplete: {error}"),
                );
            }
        };
        let geometry = runtime.geometry;
        let protocol_snapshot = protocol.snapshot();
        drop(runtime);
        drop(protocol);
        let attachment =
            attachment_from_snapshot(self.generation, geometry, protocol_snapshot, snapshot);
        let mut flow_control = self
            .desktop_flow
            .attach(attachment.state.snapshot_start_seq, window_bytes)?;
        flow_control.next_envelope_id = match self.desktop_delivery.install_lease(
            flow_control.token.clone(),
            attachment.state.snapshot_start_seq,
            attachment.state.snapshot_seq,
        ) {
            Ok(next_envelope_id) => next_envelope_id,
            Err(error) => {
                return self.fail_delivery_contract(format!(
                    "desktop attach flow/delivery projection failed: {error}"
                ));
            }
        };
        Ok(DesktopTerminalOutputAttachment {
            attachment,
            flow_control,
        })
    }

    /// Serve the exact byte range a surface lost to a delivery gap.
    ///
    /// `terminal-output-v2` delivery is a notification, not a guarantee; the
    /// ring is the single source of truth for sequenced bytes ([ADR-0072]). A
    /// surface that observed `seqStart > expectedSeq` asks for `[seq, write_seq)`
    /// and splices it in without touching its screen.
    ///
    /// `Ok(None)` means the range is no longer bridgeable ??the generation was
    /// replaced or the ring evicted past `seq` ??and the caller must perform a
    /// fresh attach. Clamping to a shorter prefix is forbidden: it would hand
    /// back a hole disguised as a contiguous repair.
    ///
    /// [ADR-0072]: ../../docs/adr/0072-terminal-output-gap-sequence-exact-repair.md
    pub fn resume_output(
        &self,
        generation: u64,
        seq: u64,
    ) -> Result<Option<TerminalOutputDelta>, String> {
        // Same protocol ??runtime gate order as `record_output`, so the range
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

    pub(super) fn checkpoint_target(&self) -> Result<TerminalRenderCheckpointTarget, String> {
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

    pub(super) fn update_geometry(&self, cols: u16, rows: u16) -> Result<TerminalGeometry, String> {
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

    pub(super) fn commit_creation(&self) -> Result<(), String> {
        let mut runtime = self.runtime.lock_or_err()?;
        if runtime.retired {
            return Err(format!("Session '{}' not found", self.terminal_id));
        }
        runtime.creating = false;
        Ok(())
    }

    /// Publish generation retirement and wake every ordinary flow waiter.
    ///
    /// This phase is finite and may run while the registry reservation is
    /// still held. The delivery emitter barrier and worker join belong to
    /// `finish_retirement`, after every registry/protocol/runtime/output lock
    /// has been released.
    pub(super) fn begin_retirement(&self, _allow_creating: bool) {
        // Retirement discards both states, so poison is recoverable here even
        // though it is fatal on every read/write path. Recovering lets the
        // close command finish catalog cleanup and reach `PtyHandle::terminate`
        // instead of returning early while an orphan reader resumes.
        {
            let _protocol = self
                .protocol
                .lock_or_recover_for_discard("retiring terminal output protocol");
            let mut runtime = self
                .runtime
                .lock_or_recover_for_discard("retiring terminal output runtime");
            if !runtime.retired {
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
            }
        }
        // Wake ordinary credit waiters only after the generation is observably
        // retired. A callback that races close and runs again therefore sees
        // `retired`/poison and returns before OSC or legacy emission; the close
        // command can then terminate the selected PTY handle normally.
        self.desktop_flow.retire();
    }

    /// Settle the physical delivery worker after logical removal. A synchronous
    /// emitter that ignores shutdown is bounded and recorded in sticky session
    /// diagnostics, but cannot revoke the already-transferred PTY ownership or
    /// prevent its caller from completing platform cleanup.
    pub(super) fn finish_retirement(&self) {
        // Emit barriers and worker joins must never run under protocol/runtime
        // locks: an in-progress AppHandle emit is allowed to settle first.
        self.desktop_delivery
            .close(TerminalOutputDeliveryCloseReason::Retired);
        if let Err(error) = self.desktop_delivery.join() {
            tracing::error!(
                terminal_id = %self.terminal_id,
                generation = self.generation,
                %error,
                "retired terminal output delivery worker did not settle"
            );
        }
    }

    #[cfg(test)]
    pub(super) fn retire(&self, allow_creating: bool) -> Result<(), String> {
        self.begin_retirement(allow_creating);
        self.finish_retirement();
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn subscriber_count(&self) -> usize {
        self.runtime
            .lock()
            .map(|runtime| runtime.subscribers.len())
            .unwrap_or_default()
    }
}
