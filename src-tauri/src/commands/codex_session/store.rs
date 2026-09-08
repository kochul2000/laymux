#[cfg(test)]
use std::collections::HashSet;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

mod diagnostics;
use diagnostics::{
    find_process_thread_ids_checked, find_process_uuid_checked, is_temporary_thread_checked,
};

use super::resolve_codex_roots;
use crate::commands::claude_session::is_valid_session_id;
use crate::constants::{
    CODEX_SESSION_DIRECTORY_DEPTH, CODEX_SESSION_META_MAX_BYTES, CODEX_SQLITE_BUSY_TIMEOUT,
    CODEX_SQLITE_LOG_PREFIX, CODEX_SQLITE_STATE_PREFIX,
};

pub(super) struct CodexSessionStore {
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    guest: bool,
}

pub(super) struct ResolvedSession {
    pub id: String,
    pub fresh: bool,
}

impl CodexSessionStore {
    pub(super) fn resolve() -> Self {
        let (codex_home, sqlite_home) = resolve_codex_roots();
        Self::new(codex_home, sqlite_home)
    }

    pub(super) fn new(codex_home: PathBuf, sqlite_home: PathBuf) -> Self {
        Self {
            codex_home,
            sqlite_home,
            guest: false,
        }
    }

    pub(super) fn for_guest(codex_home: PathBuf) -> Self {
        Self {
            sqlite_home: codex_home.clone(),
            codex_home,
            guest: true,
        }
    }

    pub(super) fn sessions_dir(&self) -> PathBuf {
        self.codex_home.join("sessions")
    }

    #[cfg(test)]
    pub(super) fn sqlite_home(&self) -> &Path {
        &self.sqlite_home
    }

    #[cfg(test)]
    pub(super) fn find_session_for_pid(
        &self,
        pid: u32,
        max_age_hours: Option<u64>,
    ) -> Option<String> {
        self.find_session_for_pid_checked(pid, max_age_hours)
            .ok()
            .flatten()
    }

    #[cfg(test)]
    pub(super) fn find_session_for_pid_checked(
        &self,
        pid: u32,
        max_age_hours: Option<u64>,
    ) -> Result<Option<String>, String> {
        Ok(self
            .find_selection_for_pid_checked(pid, max_age_hours)?
            .filter(|s| !s.fresh)
            .map(|s| s.id))
    }

    pub(super) fn find_selection_for_pid_checked(
        &self,
        pid: u32,
        max_age_hours: Option<u64>,
    ) -> Result<Option<ResolvedSession>, String> {
        let Some(logs_path) =
            latest_versioned_db_checked(&self.sqlite_home, CODEX_SQLITE_LOG_PREFIX)?
        else {
            return Ok(None);
        };
        let logs = open_read_only_checked(&logs_path)?;
        let Some((process_uuid, first_log_id)) = find_process_uuid_checked(&logs, pid)? else {
            return Ok(None);
        };
        let rows = read_lifecycle_rows(&logs, &process_uuid, first_log_id)?;
        if let Some(selection) = super::lifecycle::select(&rows) {
            return self.resolve_selection(selection, max_age_hours);
        }
        for thread_id in find_process_thread_ids_checked(&logs, &process_uuid, first_log_id)? {
            if is_temporary_thread_checked(&logs, &process_uuid, first_log_id, &thread_id)? {
                continue;
            }
            match self.validate_session_checked(&thread_id, max_age_hours)? {
                Some(true) => {
                    return Ok(Some(ResolvedSession {
                        id: thread_id,
                        fresh: false,
                    }))
                }
                // Only a positively identified auxiliary thread can be skipped.
                Some(false) => continue,
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    pub(super) fn resolve_selection(
        &self,
        selection: super::lifecycle::Selection,
        age: Option<u64>,
    ) -> Result<Option<ResolvedSession>, String> {
        let Some(id) = selection.id else {
            return Ok(None);
        };
        match self.validate_session_checked(&id, age)? {
            Some(true) => return Ok(Some(ResolvedSession { id, fresh: false })),
            Some(false) => return Ok(None),
            None => {}
        }
        if selection.can_be_fresh {
            let mut paths = Vec::new();
            collect_rollout_paths_checked(
                &self.sessions_dir(),
                CODEX_SESSION_DIRECTORY_DEPTH,
                &id,
                &mut paths,
            )?;
            if paths.is_empty() {
                // A state row with a missing rollout is an I/O error in validation,
                // never fresh. Invalid/expired/auxiliary files also cannot get here.
                return Ok(Some(ResolvedSession { id, fresh: true }));
            }
        }
        Ok(None)
    }

    /// Some(true): exact interactive session; Some(false): proven auxiliary;
    /// None: unverifiable candidate, which must stop fallback to older IDs.
    fn validate_session_checked(
        &self,
        session_id: &str,
        max_age_hours: Option<u64>,
    ) -> Result<Option<bool>, String> {
        if !is_valid_session_id(session_id) {
            return Ok(None);
        }
        let cutoff = age_cutoff(max_age_hours);
        if let Some(state_db) = if self.guest {
            None
        } else {
            latest_versioned_db_checked(&self.sqlite_home, CODEX_SQLITE_STATE_PREFIX)?
        } {
            let state = open_read_only_checked(&state_db)?;
            if let Some(state_path) = find_rollout_path_checked(&state, session_id)? {
                return parse_rollout_header_checked(&state_path, cutoff, session_id);
            }
        }
        find_rollout_by_session_id_checked(&self.sessions_dir(), session_id, cutoff)
    }
}

fn read_lifecycle_rows(
    connection: &Connection,
    process: &str,
    first: i64,
) -> Result<Vec<super::lifecycle::LogRow>, String> {
    let mut statement = connection.prepare("SELECT id, thread_id, substr(feedback_log_body,1,2048) FROM logs WHERE id>=?1 AND process_uuid=?2 AND (feedback_log_body LIKE 'app_server.request{%rpc.method=\"thread/%' OR feedback_log_body LIKE 'session_loop{%') ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map((first, process), |r| {
            Ok(super::lifecycle::LogRow {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                feedback_log_body: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn open_read_only_checked(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_millis(CODEX_SQLITE_BUSY_TIMEOUT))
        .map_err(|error| format!("failed to configure {}: {error}", path.display()))?;
    Ok(connection)
}

#[cfg(test)]
fn latest_versioned_db(dir: &Path, prefix: &str) -> Option<PathBuf> {
    latest_versioned_db_checked(dir, prefix).ok().flatten()
}

fn latest_versioned_db_checked(dir: &Path, prefix: &str) -> Result<Option<PathBuf>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", dir.display())),
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
        if !entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        let Some(candidate) = (|| {
            let name = path.file_name()?.to_str()?;
            let version = name.strip_prefix(prefix)?.strip_suffix(".sqlite")?;
            Some((version.parse::<u64>().ok()?, path))
        })() else {
            continue;
        };
        candidates.push(candidate);
    }
    Ok(candidates
        .into_iter()
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path))
}

fn find_rollout_path_checked(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    connection
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map(|path| path.map(PathBuf::from))
        .map_err(|error| format!("failed to query Codex rollout path: {error}"))
}

fn age_cutoff(max_age_hours: Option<u64>) -> Option<u128> {
    max_age_hours.filter(|hours| *hours > 0).and_then(|hours| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|now| {
                now.as_nanos().saturating_sub(
                    u128::from(hours)
                        .saturating_mul(3600)
                        .saturating_mul(1_000_000_000),
                )
            })
    })
}

fn find_rollout_by_session_id_checked(
    dir: &Path,
    session_id: &str,
    cutoff: Option<u128>,
) -> Result<Option<bool>, String> {
    let mut paths = Vec::new();
    collect_rollout_paths_checked(dir, CODEX_SESSION_DIRECTORY_DEPTH, session_id, &mut paths)?;
    if let [path] = paths.as_slice() {
        return parse_rollout_header_checked(path, cutoff, session_id);
    }
    Ok(None)
}

#[cfg(test)]
pub(super) fn find_session_from_rollout_paths(
    paths: &[PathBuf],
    max_age_hours: Option<u64>,
) -> Option<String> {
    find_session_from_rollout_paths_checked(paths, max_age_hours)
        .ok()
        .flatten()
}

#[cfg(test)]
pub(super) fn find_session_from_rollout_paths_checked(
    paths: &[PathBuf],
    max_age_hours: Option<u64>,
) -> Result<Option<String>, String> {
    let cutoff = age_cutoff(max_age_hours);
    let mut sessions = HashSet::new();
    for path in paths {
        if let Some(session_id) = parse_rollout_session_id_checked(path, cutoff)? {
            sessions.insert(session_id);
        }
    }
    Ok((sessions.len() == 1)
        .then(|| sessions.into_iter().next())
        .flatten())
}

fn collect_rollout_paths_checked(
    dir: &Path,
    depth: u8,
    session_id: &str,
    paths: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read {}: {error}", dir.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", entry.path().display()))?;
        let path = entry.path();
        if file_type.is_dir() && depth > 0 {
            collect_rollout_paths_checked(&path, depth - 1, session_id, paths)?;
        } else if file_type.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("rollout-")
                        && name.ends_with(".jsonl")
                        && name.contains(session_id)
                })
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn parse_rollout_header_checked(
    path: &Path,
    cutoff: Option<u128>,
    expected_id: &str,
) -> Result<Option<bool>, String> {
    Ok(match parse_rollout_identity_checked(path, cutoff)? {
        RolloutIdentity::TopLevel(id) if id == expected_id => Some(true),
        RolloutIdentity::Auxiliary(id) if id == expected_id => Some(false),
        _ => None,
    })
}

#[cfg(test)]
fn parse_rollout_session_id_checked(
    path: &Path,
    cutoff: Option<u128>,
) -> Result<Option<String>, String> {
    Ok(match parse_rollout_identity_checked(path, cutoff)? {
        RolloutIdentity::TopLevel(id) => Some(id),
        _ => None,
    })
}

enum RolloutIdentity {
    TopLevel(String),
    Auxiliary(String),
    Rejected,
}

fn parse_rollout_identity_checked(
    path: &Path,
    cutoff: Option<u128>,
) -> Result<RolloutIdentity, String> {
    let modified_at = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("invalid timestamp for {}: {error}", path.display()))?
        .as_nanos();
    if cutoff.is_some_and(|minimum| modified_at < minimum) {
        return Ok(RolloutIdentity::Rejected);
    }

    let file = std::fs::File::open(path)
        .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let mut header = String::new();
    let mut limited = std::io::BufReader::new(file).take((CODEX_SESSION_META_MAX_BYTES + 1) as u64);
    limited
        .read_line(&mut header)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if header.len() > CODEX_SESSION_META_MAX_BYTES {
        return Err(format!(
            "Codex rollout header is too large: {}",
            path.display()
        ));
    }

    let value = serde_json::from_str::<serde_json::Value>(&header)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return Ok(RolloutIdentity::Rejected);
    }
    let Some(payload) = value.get("payload") else {
        return Ok(RolloutIdentity::Rejected);
    };
    let is_subagent = payload
        .get("parent_thread_id")
        .is_some_and(|parent| !parent.is_null())
        || payload
            .get("thread_source")
            .and_then(serde_json::Value::as_str)
            == Some("subagent")
        || payload
            .get("source")
            .and_then(|source| source.get("subagent"))
            .is_some();
    let is_non_interactive_exec =
        payload.get("source").and_then(serde_json::Value::as_str) == Some("exec");
    let has_cwd = payload
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|cwd| !cwd.is_empty());
    let Some(session_id) = payload.get("id").and_then(serde_json::Value::as_str) else {
        return Ok(RolloutIdentity::Rejected);
    };
    Ok(if !is_valid_session_id(session_id) || !has_cwd {
        RolloutIdentity::Rejected
    } else if is_subagent || is_non_interactive_exec {
        RolloutIdentity::Auxiliary(session_id.to_string())
    } else {
        RolloutIdentity::TopLevel(session_id.to_string())
    })
}

#[cfg(test)]
mod tests;
