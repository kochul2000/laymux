use super::{
    diagnostics::{
        find_process_thread_ids_checked, find_process_uuid_checked, is_temporary_thread_checked,
    },
    latest_versioned_db_checked, open_read_only_checked, read_lifecycle_rows, CodexSessionStore,
    ResolvedSession,
};
use crate::commands::codex_session::lifecycle::{self, ProcessRows};
use crate::constants::CODEX_SQLITE_LOG_PREFIX;

/// An observed rejection is a veto, never permission to use an older title.
pub(in crate::commands::codex_session) enum SelectionProbe {
    Missing,
    Selected(ResolvedSession),
    Blocked,
}

impl SelectionProbe {
    pub(in crate::commands::codex_session) fn into_session(self) -> Option<ResolvedSession> {
        match self {
            Self::Selected(session) => Some(session),
            Self::Missing | Self::Blocked => None,
        }
    }
}

impl CodexSessionStore {
    pub(in crate::commands::codex_session) fn probe_process_rows(
        &self,
        process: &ProcessRows,
    ) -> Result<SelectionProbe, String> {
        let session = self.resolve_process_rows(process)?;
        Ok(match session {
            Some(session) => SelectionProbe::Selected(session),
            None if lifecycle::select(&process.rows).is_some()
                || process
                    .rows
                    .iter()
                    .any(|r| r.feedback_log_body.starts_with("session_loop{")) =>
            {
                SelectionProbe::Blocked
            }
            None => SelectionProbe::Missing,
        })
    }

    pub(in crate::commands::codex_session) fn probe_selection_for_pid_checked(
        &self,
        pid: u32,
        max_age_hours: Option<u64>,
    ) -> Result<SelectionProbe, String> {
        let Some(logs_path) =
            latest_versioned_db_checked(&self.sqlite_home, CODEX_SQLITE_LOG_PREFIX)?
        else {
            return Ok(SelectionProbe::Missing);
        };
        let mut connection = open_read_only_checked(&logs_path)?;
        let logs = connection.transaction().map_err(|e| e.to_string())?;
        let Some((process_uuid, first_log_id)) = find_process_uuid_checked(&logs, pid)? else {
            return Ok(SelectionProbe::Missing);
        };
        let rows = read_lifecycle_rows(&logs, &process_uuid, first_log_id)?;
        if lifecycle::select(&rows).is_some()
            || rows
                .iter()
                .any(|r| r.feedback_log_body.starts_with("session_loop{"))
        {
            return self.probe_process_rows(&ProcessRows { process_uuid, rows });
        }
        for thread_id in find_process_thread_ids_checked(&logs, &process_uuid, first_log_id)? {
            if is_temporary_thread_checked(&logs, &process_uuid, first_log_id, &thread_id)? {
                continue;
            }
            match self.validate_session_checked(&thread_id, max_age_hours)? {
                Some(true) => {
                    return Ok(SelectionProbe::Selected(ResolvedSession {
                        id: thread_id,
                        fresh: false,
                        selection_key: None,
                    }))
                }
                Some(false) => continue,
                None => return Ok(SelectionProbe::Blocked),
            }
        }
        Ok(SelectionProbe::Missing)
    }
}
