use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use super::{Turn, TurnState};

const READ_LIMIT: usize = 1024 * 1024;
const ANCHOR_LEN: usize = 64;

#[derive(Default)]
pub(super) struct TurnReader {
    initialized: bool,
    offset: u64,
    pending: Vec<u8>,
    skip_line: bool,
    anchor: Vec<u8>,
    created: Option<std::time::SystemTime>,
    modified: Option<std::time::SystemTime>,
    turn: Turn,
}

impl TurnReader {
    pub(super) fn read(&mut self, path: &Path) -> std::io::Result<Turn> {
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        let len = metadata.len();
        let created = metadata.created().ok();
        let modified = metadata.modified().ok();
        if self.initialized {
            let mut anchor = vec![0; self.anchor.len()];
            if len < self.offset
                || created != self.created
                || (len == self.offset && modified != self.modified)
            {
                *self = Self::default();
            } else {
                file.seek(SeekFrom::Start(self.offset - anchor.len() as u64))?;
                file.read_exact(&mut anchor)?;
                if anchor != self.anchor {
                    *self = Self::default();
                }
            }
        }
        if !self.initialized {
            // ponytail: bound initial history to 1 MiB. Without a lifecycle in
            // that window report unknown; do not scan an unbounded transcript.
            self.offset = len.saturating_sub(READ_LIMIT as u64);
            self.skip_line = self.offset > 0;
            self.initialized = true;
        }
        self.created = created;
        self.modified = modified;
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        (&mut file)
            .take((len - self.offset).min(READ_LIMIT as u64))
            .read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        for byte in bytes {
            if byte == b'\n' {
                if !self.skip_line && !self.pending.is_empty() {
                    self.consume_line();
                }
                self.pending.clear();
                self.skip_line = false;
            } else if !self.skip_line {
                self.pending.push(byte);
                if self.pending.len() >= READ_LIMIT {
                    self.pending.clear();
                    self.skip_line = true;
                    self.turn = Turn::default();
                }
            }
        }
        let anchor_len = self.offset.min(ANCHOR_LEN as u64) as usize;
        self.anchor.resize(anchor_len, 0);
        file.seek(SeekFrom::Start(self.offset - anchor_len as u64))?;
        file.read_exact(&mut self.anchor)?;
        // A partial new start or unread backlog must not leave an old success
        // authoritative. Keep parser state so the next append can complete it.
        if self.offset < len || !self.pending.is_empty() || self.skip_line {
            return Ok(Turn::default());
        }
        Ok(self.turn.clone())
    }

    fn consume_line(&mut self) {
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(&self.pending) else {
            self.turn = Turn::default();
            return;
        };
        if record["type"] != "event_msg" {
            return;
        }
        let payload = &record["payload"];
        let Some(kind) = payload["type"].as_str() else {
            self.turn = Turn::default();
            return;
        };
        let state = match kind {
            "task_started" | "turn_started" => TurnState::Running,
            // /review forwards the delegate's start but completes the parent.
            // Restore the parent at its structured boundary in either rollout
            // format; exiting review alone is not success (it also precedes abort).
            "entered_review_mode" | "exited_review_mode" => TurnState::Running,
            "item_completed"
                if matches!(
                    payload["item"]["type"].as_str(),
                    Some("EnteredReviewMode" | "ExitedReviewMode")
                ) =>
            {
                TurnState::Running
            }
            "task_complete" | "turn_complete" => {
                if payload.get("error").is_some_and(|error| !error.is_null()) {
                    TurnState::Failed
                } else {
                    TurnState::Completed
                }
            }
            "turn_aborted" => TurnState::Interrupted,
            "thread_rolled_back" => {
                self.turn = Turn::default();
                return;
            }
            _ if kind.starts_with("task_") || kind.starts_with("turn_") => {
                self.turn = Turn::default();
                return;
            }
            _ => return,
        };
        let Some(id) = payload["turn_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
        else {
            self.turn = Turn::default();
            return;
        };
        if state != TurnState::Running
            && self
                .turn
                .turn_id
                .as_deref()
                .is_some_and(|current| current != id)
        {
            return;
        }
        self.turn = Turn {
            state,
            turn_id: Some(id.to_owned()),
        };
    }
}

#[cfg(test)]
mod tests;
