use std::collections::HashSet;

use serde::Deserialize;

use crate::commands::claude_session::is_valid_session_id;

#[derive(Debug, Deserialize)]
pub(super) struct LogRow {
    pub id: i64,
    pub thread_id: Option<String>,
    pub feedback_log_body: String,
}

#[derive(Debug, PartialEq)]
pub(super) struct Selection {
    pub id: Option<String>,
    pub can_be_fresh: bool,
}

/// Input must be ordered by log id and scoped to one process incarnation.
/// First observation of a request orders transitions; late prewarm logging
/// from an older request must not select that old conversation again.
pub(super) fn select(rows: &[LogRow]) -> Option<Selection> {
    let mut seen = HashSet::new();
    let mut current_request = String::new();
    let mut selected: Option<Selection> = None;
    let mut previous_id = None;
    for row in rows {
        if previous_id.is_some_and(|id| row.id <= id) {
            return Some(Selection {
                id: None,
                can_be_fresh: false,
            });
        }
        previous_id = Some(row.id);
        let body = &row.feedback_log_body;
        let Some(rest) = body.strip_prefix("app_server.request{") else {
            continue;
        };
        let Some((header, spans)) = rest.split_once("}:") else {
            continue;
        };
        let fields: Vec<_> = header.split_whitespace().collect();
        if !fields.contains(&"app_server.client_name=\"codex-tui\"") {
            continue;
        }
        let start = fields.contains(&"rpc.method=\"thread/start\"");
        if !start && !fields.contains(&"rpc.method=\"thread/resume\"") {
            continue;
        }
        let Some(request) = fields
            .iter()
            .find_map(|f| f.strip_prefix("rpc.request_id="))
        else {
            continue;
        };
        if request.starts_with("temporary-structured-") {
            continue;
        }
        if seen.insert(request.to_owned()) {
            current_request = request.to_owned();
            selected = Some(Selection {
                id: None,
                can_be_fresh: start,
            });
        }
        if current_request != request {
            continue;
        }
        // Only session initialization evidence, never teardown or quoted body.
        let prefix = spans.split(": ").next().unwrap_or_default();
        if !(prefix.starts_with("app_server.thread_start.create_thread{")
            || prefix.starts_with("resume_thread_with_history:")
            || prefix.starts_with("thread_spawn{"))
        {
            continue;
        }
        if !prefix.contains(":session_init:") {
            continue;
        }
        let id = [
            "shell_snapshot{thread_id=",
            "startup_prewarm{otel.name=\"startup_prewarm\" thread.id=",
        ]
        .into_iter()
        .find_map(|marker| {
            prefix
                .split_once(marker)
                .and_then(|(_, rest)| rest.split_once('}').map(|(id, _)| id))
        })
        .filter(|id| is_valid_session_id(id));
        if let (Some(selection), Some(id)) = (&mut selected, id) {
            if row.thread_id.as_deref().is_some_and(|column| column != id) {
                selection.id = None;
                selection.can_be_fresh = false;
                continue;
            }
            selection.id = Some(id.to_owned());
        }
    }
    if let Some(selection) = &mut selected {
        if let Some(id) = &selection.id {
            // Any session-loop activity is stronger than absence of a rollout.
            // This deliberately includes failed/cancelled input and shutdown.
            if rows.iter().any(|r| {
                r.thread_id.as_ref() == Some(id) && r.feedback_log_body.starts_with("session_loop{")
            }) {
                selection.can_be_fresh = false;
            }
        }
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(n: i64, request: &str, method: &str, id: &str) -> LogRow {
        LogRow { id:n, thread_id:None, feedback_log_body:format!("app_server.request{{rpc.method=\"thread/{method}\" rpc.request_id={request} app_server.client_name=\"codex-tui\"}}:thread_spawn{{}}:session_init:startup_prewarm{{otel.name=\"startup_prewarm\" thread.id={id}}}: ready") }
    }
    #[test]
    fn clear_is_fresh_but_resume_is_not() {
        assert_eq!(
            select(&[row(1, "1", "start", "new-id")]),
            Some(Selection {
                id: Some("new-id".into()),
                can_be_fresh: true
            })
        );
        assert!(
            !select(&[row(1, "1", "resume", "old-id")])
                .unwrap()
                .can_be_fresh
        );
    }
    #[test]
    fn late_old_prewarm_and_title_do_not_undo_clear() {
        let rows = [
            row(1, "1", "start", "old"),
            row(2, "2", "start", "new"),
            row(3, "1", "start", "old"),
            row(4, "temporary-structured-title", "start", "title"),
        ];
        assert_eq!(select(&rows).unwrap().id.as_deref(), Some("new"));
    }
    #[test]
    fn input_or_incomplete_transition_is_not_fresh() {
        let mut input = row(2, "1", "start", "new");
        input.thread_id = Some("new".into());
        input.feedback_log_body = "session_loop{thread_id=new}: Submission op: TurnInput".into();
        assert!(
            !select(&[row(1, "1", "start", "new"), input])
                .unwrap()
                .can_be_fresh
        );
        let mut pending = row(2, "2", "start", "new");
        pending.feedback_log_body = pending
            .feedback_log_body
            .split("}:thread_spawn")
            .next()
            .unwrap()
            .to_owned()
            + "}: preparing";
        assert_eq!(
            select(&[row(1, "1", "start", "old"), pending]).unwrap().id,
            None
        );
    }
    #[test]
    fn quoted_spans_do_not_identify_a_session() {
        let mut quoted = row(1, "1", "start", "new");
        quoted.feedback_log_body =
            quoted
                .feedback_log_body
                .replacen("}:thread_spawn", "}: user said thread_spawn", 1);
        assert_eq!(select(&[quoted]).unwrap().id, None);
    }
}
