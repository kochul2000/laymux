use std::sync::Weak;

use tokio::sync::{mpsc, watch};

use super::*;

impl TerminalOutputSession {
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

    pub(super) fn attach_and_subscribe(
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

    pub(super) fn attach_and_subscribe_from_render_checkpoint(
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

    pub(super) fn remove_subscriber(&self, subscriber_id: u64) {
        if let Ok(mut runtime) = self.runtime.lock_or_err() {
            runtime.subscribers.remove(&subscriber_id);
        }
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
