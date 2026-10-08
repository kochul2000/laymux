use crate::constants::*;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

const MAX_EVENTS: usize = 4096;
const MAX_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BusinessEvent {
    pub sequence: u64,
    pub event: String,
    pub terminal_id: String,
    pub generation: u64,
    pub payload: Value,
}

#[derive(Default)]
pub(super) struct EventJournal {
    sequence: u64,
    bytes: usize,
    events: VecDeque<(BusinessEvent, usize)>,
}
impl EventJournal {
    pub(super) fn push(
        &mut self,
        event: &str,
        id: &str,
        generation: u64,
        payload: Value,
    ) -> Result<(), AppError> {
        if !matches!(
            event,
            EVENT_SYNC_CWD
                | EVENT_SYNC_BRANCH
                | EVENT_LX_NOTIFY
                | EVENT_SET_TAB_TITLE
                | EVENT_OPEN_FILE
                | EVENT_COMMAND_STATUS
                | EVENT_CLAUDE_TERMINAL_DETECTED
                | EVENT_TERMINAL_CWD_CHANGED
                | EVENT_TERMINAL_TITLE_CHANGED
                | EVENT_CLAUDE_MESSAGE_CHANGED
                | EVENT_TERMINAL_OUTPUT_ACTIVITY
                | EVENT_TERMINAL_ACTIVITY_RECONCILED
        ) || id.is_empty()
            || generation == 0
        {
            return Ok(());
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| AppError::Other("daemon business event sequence exhausted".into()))?;
        let item = BusinessEvent {
            sequence: self.sequence,
            event: event.into(),
            terminal_id: id.into(),
            generation,
            payload,
        };
        let size = serde_json::to_vec(&item)?.len();
        self.bytes = self.bytes.saturating_add(size);
        self.events.push_back((item, size));
        while self.bytes > MAX_EVENT_BYTES || self.events.len() > MAX_EVENTS {
            if let Some((_, size)) = self.events.pop_front() {
                self.bytes -= size;
            } else {
                break;
            }
        }
        Ok(())
    }
    pub(super) fn read(&self, since: Option<u64>) -> Result<Value, AppError> {
        if since.is_some_and(|cursor| cursor > self.sequence) {
            return Err(AppError::Other(
                "daemon business event cursor is in the future".into(),
            ));
        }
        let oldest = self
            .events
            .front()
            .map(|(event, _)| event.sequence)
            .unwrap_or(self.sequence.saturating_add(1));
        let reset = since.is_none_or(|cursor| cursor.saturating_add(1) < oldest);
        let events: Vec<_> = if reset {
            Vec::new()
        } else {
            self.events
                .iter()
                .filter(|(event, _)| Some(event.sequence) > since)
                .map(|(event, _)| event)
                .collect()
        };
        Ok(serde_json::json!({"sequence":self.sequence,"reset":reset,"events":events}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::EVENT_TERMINAL_CWD_CHANGED;
    use serde_json::json;
    #[test]
    fn journal_preserves_order_generation_and_reports_future_cursors() {
        let mut journal = EventJournal::default();
        journal
            .push(
                EVENT_TERMINAL_CWD_CHANGED,
                "terminal-one",
                7,
                json!({"cwd":"/first"}),
            )
            .unwrap();
        journal
            .push(
                EVENT_TERMINAL_CWD_CHANGED,
                "terminal-one",
                8,
                json!({"cwd":"/second"}),
            )
            .unwrap();
        let result = journal.read(Some(0)).unwrap();
        assert_eq!(result["events"][0]["generation"], 7);
        assert_eq!(result["events"][1]["sequence"], 2);
        assert_eq!(result["events"][1]["payload"]["cwd"], "/second");
        assert!(journal.read(Some(3)).is_err());
        assert!(journal.read(Some(2)).unwrap()["events"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn journal_initial_attach_and_bounded_retention_require_state_resync() {
        let mut journal = EventJournal::default();
        for index in 0..5000 {
            journal
                .push(
                    EVENT_TERMINAL_CWD_CHANGED,
                    "terminal",
                    1,
                    json!({"cwd":format!("/{index}")}),
                )
                .unwrap();
        }
        assert_eq!(journal.read(None).unwrap()["reset"], true);
        let gap = journal.read(Some(0)).unwrap();
        assert_eq!(gap["reset"], true);
        assert_eq!(gap["sequence"], 5000);
        assert!(gap["events"].as_array().unwrap().is_empty());
        assert!(
            journal.read(Some(1000)).unwrap()["events"]
                .as_array()
                .unwrap()
                .len()
                <= 4096
        );
    }
    #[test]
    fn journal_does_not_forward_output_or_control_events() {
        let mut journal = EventJournal::default();
        journal
            .push(
                "terminal-output-v3-terminal",
                "terminal",
                1,
                json!({"data":"private"}),
            )
            .unwrap();
        journal
            .push(
                "automation-request",
                "terminal",
                1,
                json!({"command":"control"}),
            )
            .unwrap();
        assert_eq!(journal.read(Some(0)).unwrap()["sequence"], 0);
    }
    #[test]
    fn journal_payload_bytes_are_bounded_even_with_a_few_large_events() {
        let mut journal = EventJournal::default();
        for _ in 0..10 {
            journal
                .push(
                    EVENT_TERMINAL_CWD_CHANGED,
                    "terminal",
                    1,
                    json!({"cwd":"x".repeat(256*1024)}),
                )
                .unwrap();
        }
        assert_eq!(journal.read(Some(0)).unwrap()["reset"], true);
        assert!(
            serde_json::to_vec(&journal.read(Some(7)).unwrap())
                .unwrap()
                .len()
                <= 1024 * 1024 + 1024
        );
    }
}
