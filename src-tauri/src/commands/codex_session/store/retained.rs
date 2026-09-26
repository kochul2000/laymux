use std::collections::{BTreeMap, HashSet};

use super::{CodexSessionStore, ResolvedSession};
use crate::commands::claude_session::is_valid_session_id;
use crate::commands::codex_session::lifecycle::{self, LogRow, ProcessRows};

#[derive(Default)]
struct LoopEvidence {
    last: i64,
    closed: Option<i64>,
}

fn loops<'a>(
    store: &CodexSessionStore,
    rows: &'a [LogRow],
) -> Result<BTreeMap<&'a str, LoopEvidence>, String> {
    let mut evidence = BTreeMap::<&str, LoopEvidence>::new();
    let mut auxiliary = HashSet::new();
    for row in rows {
        if !row.feedback_log_body.starts_with("session_loop{") {
            continue;
        }
        let id = row
            .feedback_log_body
            .strip_prefix("session_loop{thread_id=")
            .and_then(|body| body.split_once('}').map(|(id, _)| id))
            .filter(|id| is_valid_session_id(id))
            .ok_or("unverifiable Codex session-loop identity")?;
        if row.thread_id.as_deref() != Some(id) {
            let column = row
                .thread_id
                .as_deref()
                .ok_or("Codex session-loop thread missing")?;
            if !auxiliary.contains(column) {
                // Nested subagent initialization carries the parent's outer
                // loop span and the child's DB identity. It is not ownership
                // evidence for either loop. Age cannot change an auxiliary role.
                if store.validate_session_checked(column, None)? != Some(false) {
                    return Err("unverifiable Codex session-loop identity mismatch".into());
                }
                auxiliary.insert(column);
            }
            continue;
        }
        let entry = evidence.entry(id).or_default();
        entry.last = row.id;
        if row.feedback_log_body == format!("session_loop{{thread_id={id}}}: Agent loop exited")
            || lifecycle::submission_operation(&row.feedback_log_body, id).is_some_and(
                |operation| operation.starts_with("Shutdown, ") || operation == "Shutdown }",
            )
        {
            entry.closed = Some(row.id);
        }
    }
    Ok(evidence)
}

impl CodexSessionStore {
    /// Resolve the same process-scoped snapshot on native and WSL. Never use
    /// latest activity to choose among top-level conversations (ADR-0258).
    /// A proven live conversation does not expire with its rollout (ADR-0267).
    pub(in crate::commands::codex_session) fn resolve_process_rows(
        &self,
        process: &ProcessRows,
    ) -> Result<Option<ResolvedSession>, String> {
        if process.process_uuid.is_empty() {
            return Err("Codex process identity missing".into());
        }
        let selected = lifecycle::select(&process.rows);
        let loops = loops(self, &process.rows)?;
        let mut boundary = None;
        if let Some(selection) = selected {
            let Some(id) = &selection.id else {
                // An incomplete transition must not fall back to an older loop.
                return Ok(None);
            };
            let closed = loops
                .get(id.as_str())
                .and_then(|e| e.closed)
                .filter(|shutdown| *shutdown > selection.epoch);
            if closed.is_none() {
                return self.resolve_selection(selection);
            }
            // Codex may defer the old thread's shutdown until after the new
            // thread has already completed a turn. Its exit is not the start
            // boundary of the new conversation.
            boundary = Some(selection.epoch);
        }
        let mut candidate = None;
        for (id, evidence) in loops {
            if evidence.closed.is_some() || boundary.is_some_and(|n| evidence.last <= n) {
                continue;
            }
            // File age cannot invalidate process-scoped ownership or an
            // auxiliary role. Still validate the exact, unique rollout header.
            match self.validate_session_checked(id, None)? {
                Some(false) => continue,
                None => return Ok(None),
                Some(true) => {
                    if candidate.is_some() {
                        return Ok(None);
                    }
                    candidate = Some(ResolvedSession {
                        id: id.to_owned(),
                        fresh: false,
                        selection_key: Some(format!("retained:{}:{id}", process.process_uuid)),
                    });
                }
            }
        }
        Ok(candidate)
    }
}
