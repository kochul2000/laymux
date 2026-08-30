use std::collections::HashSet;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::resolve_codex_roots;
use crate::commands::claude_session::is_valid_session_id;
use crate::constants::{
    CODEX_SESSION_DIRECTORY_DEPTH, CODEX_SESSION_META_MAX_BYTES, CODEX_SQLITE_BUSY_TIMEOUT,
    CODEX_SQLITE_LOG_PREFIX, CODEX_SQLITE_STATE_PREFIX,
};

pub(super) struct CodexSessionStore {
    codex_home: PathBuf,
    sqlite_home: PathBuf,
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

    pub(super) fn find_session_for_pid_checked(
        &self,
        pid: u32,
        max_age_hours: Option<u64>,
    ) -> Result<Option<String>, String> {
        let Some(logs_path) =
            latest_versioned_db_checked(&self.sqlite_home, CODEX_SQLITE_LOG_PREFIX)?
        else {
            return Ok(None);
        };
        let logs = open_read_only_checked(&logs_path)?;
        let Some((process_uuid, first_log_id)) = find_process_uuid_checked(&logs, pid)? else {
            return Ok(None);
        };
        for thread_id in find_process_thread_ids_checked(&logs, &process_uuid, first_log_id)? {
            if self.validate_session_checked(&thread_id, max_age_hours)? {
                return Ok(Some(thread_id));
            }
        }
        Ok(None)
    }

    fn validate_session_checked(
        &self,
        session_id: &str,
        max_age_hours: Option<u64>,
    ) -> Result<bool, String> {
        if !is_valid_session_id(session_id) {
            return Ok(false);
        }
        let cutoff = age_cutoff(max_age_hours);
        if let Some(state_db) =
            latest_versioned_db_checked(&self.sqlite_home, CODEX_SQLITE_STATE_PREFIX)?
        {
            let state = open_read_only_checked(&state_db)?;
            if let Some(state_path) = find_rollout_path_checked(&state, session_id)? {
                if parse_rollout_header_checked(&state_path, cutoff, session_id)? {
                    return Ok(true);
                }
            }
        }
        find_rollout_by_session_id_checked(&self.sessions_dir(), session_id, cutoff)
    }
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

fn find_process_uuid_checked(
    connection: &Connection,
    pid: u32,
) -> Result<Option<(String, i64)>, String> {
    let pattern = format!("pid:{pid}:*");
    let process_uuid: Option<String> = connection
        .query_row(
            "SELECT process_uuid
             FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts
             WHERE thread_id IS NULL AND process_uuid GLOB ?1
             ORDER BY id DESC
             LIMIT 1",
            [&pattern],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to query Codex process identity: {error}"))?;
    let Some(process_uuid) = process_uuid else {
        return Ok(None);
    };
    let first_log_id = connection
        .query_row(
            "SELECT MIN(id)
             FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts
             WHERE thread_id IS NULL AND process_uuid = ?1
             LIMIT 1",
            [&process_uuid],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to query Codex process start: {error}"))?;
    Ok(Some((process_uuid, first_log_id)))
}

fn find_process_thread_ids_checked(
    connection: &Connection,
    process_uuid: &str,
    first_log_id: i64,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT thread_id, MAX(id) AS last_id
             FROM logs NOT INDEXED
             WHERE id >= ?1 AND process_uuid = ?2 AND thread_id IS NOT NULL
             GROUP BY thread_id
             ORDER BY last_id DESC",
        )
        .map_err(|error| format!("failed to prepare Codex thread query: {error}"))?;
    let rows = statement
        .query_map((first_log_id, process_uuid), |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query Codex threads: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("failed to read Codex thread rows: {error}"))
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
) -> Result<bool, String> {
    let mut paths = Vec::new();
    collect_rollout_paths_checked(dir, CODEX_SESSION_DIRECTORY_DEPTH, session_id, &mut paths)?;
    for path in paths {
        if parse_rollout_header_checked(&path, cutoff, session_id)? {
            return Ok(true);
        }
    }
    Ok(false)
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
) -> Result<bool, String> {
    Ok(parse_rollout_session_id_checked(path, cutoff)?.as_deref() == Some(expected_id))
}

fn parse_rollout_session_id_checked(
    path: &Path,
    cutoff: Option<u128>,
) -> Result<Option<String>, String> {
    let modified_at = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("invalid timestamp for {}: {error}", path.display()))?
        .as_nanos();
    if cutoff.is_some_and(|minimum| modified_at < minimum) {
        return Ok(None);
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
        return Ok(None);
    }
    let Some(payload) = value.get("payload") else {
        return Ok(None);
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
        return Ok(None);
    };
    Ok(
        (is_valid_session_id(session_id) && has_cwd && !is_subagent && !is_non_interactive_exec)
            .then(|| session_id.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_A: &str = "019fc0d8-a862-7241-a0f5-b6a66ef4ef6f";
    const SESSION_B: &str = "019fc114-970b-7933-a31b-bbd53883b57e";

    fn create_logs_db(dir: &Path) -> Connection {
        let connection = Connection::open(dir.join("logs_2.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE logs (
                    id INTEGER PRIMARY KEY,
                    ts INTEGER NOT NULL,
                    ts_nanos INTEGER NOT NULL,
                    process_uuid TEXT NOT NULL,
                    thread_id TEXT
                 );
                 CREATE INDEX idx_logs_process_uuid_threadless_ts
                 ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
                 WHERE thread_id IS NULL;",
            )
            .unwrap();
        connection
    }

    fn insert_log(connection: &Connection, id: i64, process_uuid: &str, thread_id: Option<&str>) {
        connection
            .execute(
                "INSERT INTO logs(id, ts, ts_nanos, process_uuid, thread_id)
                 VALUES (?1, ?1, 0, ?2, ?3)",
                (id, process_uuid, thread_id),
            )
            .unwrap();
    }

    fn write_rollout(dir: &Path, session_id: &str, extra_payload: &str) -> PathBuf {
        let nested = dir.join("sessions").join("2000").join("01").join("01");
        std::fs::create_dir_all(&nested).unwrap();
        let path = nested.join(format!("rollout-test-{session_id}.jsonl"));
        let content = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/work/shared\"{extra_payload}}}}}\n"
        );
        std::fs::write(&path, content).unwrap();
        path
    }

    fn create_state_db(dir: &Path, session_id: &str, rollout_path: &Path) {
        let connection = Connection::open(dir.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads(id, rollout_path) VALUES (?1, ?2)",
                (session_id, rollout_path.to_string_lossy().as_ref()),
            )
            .unwrap();
    }

    #[test]
    fn pid_resolves_its_own_top_level_thread() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:101:uuid-a", None);
        insert_log(&logs, 2, "pid:101:uuid-a", Some(SESSION_A));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");

        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(101, None).as_deref(),
            Some(SESSION_A)
        );
    }

    #[test]
    fn state_database_rollout_path_is_validated_before_filename_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:105:uuid", None);
        insert_log(&logs, 2, "pid:105:uuid", Some(SESSION_A));
        let rollout_path = temp.path().join("rollout-without-id.jsonl");
        std::fs::write(
            &rollout_path,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{SESSION_A}\",\"cwd\":\"/work/shared\",\"source\":\"cli\"}}}}\n"
            ),
        )
        .unwrap();
        create_state_db(temp.path(), SESSION_A, &rollout_path);

        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(105, None).as_deref(),
            Some(SESSION_A)
        );
    }

    #[test]
    fn open_rollout_paths_select_the_unique_top_level_thread() {
        let temp = tempfile::tempdir().unwrap();
        let parent = write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        let subagent = write_rollout(
            temp.path(),
            SESSION_B,
            &format!(",\"parent_thread_id\":\"{SESSION_A}\",\"thread_source\":\"subagent\""),
        );
        assert_eq!(
            find_session_from_rollout_paths(&[subagent, parent], None).as_deref(),
            Some(SESSION_A)
        );
    }

    #[test]
    fn multiple_open_top_level_rollouts_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let first = write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        let second = write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
        assert_eq!(
            find_session_from_rollout_paths(&[first, second], None),
            None
        );
    }

    #[test]
    fn latest_process_uuid_wins_when_os_pid_was_reused() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:101:old", None);
        insert_log(&logs, 2, "pid:101:old", Some(SESSION_A));
        insert_log(&logs, 10, "pid:101:new", None);
        insert_log(&logs, 11, "pid:101:new", Some(SESSION_B));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");

        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(101, None).as_deref(),
            Some(SESSION_B)
        );
    }

    #[test]
    fn same_process_can_switch_to_a_new_top_level_thread() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:106:uuid", None);
        insert_log(&logs, 2, "pid:106:uuid", Some(SESSION_A));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(106, None).as_deref(),
            Some(SESSION_A)
        );

        insert_log(&logs, 3, "pid:106:uuid", Some(SESSION_B));
        write_rollout(temp.path(), SESSION_B, ",\"source\":\"cli\"");
        assert_eq!(
            store.find_session_for_pid(106, None).as_deref(),
            Some(SESSION_B)
        );
    }

    #[test]
    fn newer_subagent_log_does_not_replace_parent_session() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:102:uuid", None);
        insert_log(&logs, 2, "pid:102:uuid", Some(SESSION_A));
        insert_log(&logs, 3, "pid:102:uuid", Some(SESSION_B));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");
        write_rollout(
            temp.path(),
            SESSION_B,
            &format!(",\"parent_thread_id\":\"{SESSION_A}\",\"thread_source\":\"subagent\""),
        );

        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(102, None).as_deref(),
            Some(SESSION_A)
        );
    }

    #[test]
    fn recently_modified_rollout_in_old_date_directory_survives_age_filter() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:103:uuid", None);
        insert_log(&logs, 2, "pid:103:uuid", Some(SESSION_A));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"cli\"");

        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(
            store.find_session_for_pid(103, Some(6)).as_deref(),
            Some(SESSION_A)
        );
    }

    #[test]
    fn non_interactive_exec_and_missing_diagnostics_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let logs = create_logs_db(temp.path());
        insert_log(&logs, 1, "pid:104:uuid", None);
        insert_log(&logs, 2, "pid:104:uuid", Some(SESSION_A));
        write_rollout(temp.path(), SESSION_A, ",\"source\":\"exec\"");

        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());
        assert_eq!(store.find_session_for_pid(104, None), None);
        assert_eq!(store.find_session_for_pid(999, None), None);
    }

    #[test]
    fn newest_numeric_database_version_is_selected() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("logs_2.sqlite"), "two").unwrap();
        std::fs::write(temp.path().join("logs_10.sqlite"), "ten").unwrap();
        std::fs::write(temp.path().join("logs_latest.sqlite"), "ignored").unwrap();
        assert_eq!(
            latest_versioned_db(temp.path(), "logs_"),
            Some(temp.path().join("logs_10.sqlite"))
        );
    }

    #[test]
    fn corrupt_diagnostics_database_is_reported_as_lookup_failure() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("logs_1.sqlite"), "not sqlite").unwrap();
        let store = CodexSessionStore::new(temp.path().into(), temp.path().into());

        assert!(store.find_session_for_pid_checked(42, None).is_err());
    }
}
