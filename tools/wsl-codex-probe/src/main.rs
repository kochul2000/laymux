use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

fn probe(
    proc_root: &Path,
    pid: u32,
    marker: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let process = proc_root.join(pid.to_string());
    let environ = std::fs::read(process.join("environ"))?;
    let env: std::collections::HashMap<&str, &str> = std::str::from_utf8(&environ)?
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .collect();
    if marker.is_empty()
        || env.get("LX_TERMINAL_ID") != Some(&marker)
        || std::fs::read_to_string(process.join("comm"))?.trim() != "codex"
    {
        return Err("Codex pane ownership changed".into());
    }
    let home = env
        .get("CODEX_SQLITE_HOME")
        .or_else(|| env.get("CODEX_HOME"))
        .map(PathBuf::from)
        .or_else(|| env.get("HOME").map(|home| Path::new(home).join(".codex")))
        .ok_or("Codex database root missing")?;
    if !home.is_absolute() {
        return Err("relative Codex database root".into());
    }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(home)? {
        let path = entry?.path();
        if let Some(version) = path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("logs_"))
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| s.parse::<u64>().ok())
        {
            paths.push((version, path));
        }
    }
    let (_, path) = paths
        .into_iter()
        .max_by_key(|(version, _)| *version)
        .ok_or("Codex diagnostics database missing")?;
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_millis(200))?;
    let tx = db.transaction()?;
    let identity: String = tx.query_row(
        "SELECT process_uuid FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts WHERE thread_id IS NULL AND process_uuid GLOB ?1 ORDER BY id DESC LIMIT 1",
        [format!("pid:{pid}:*")], |r| r.get(0))?;
    let first: i64 = tx.query_row(
        "SELECT MIN(id) FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts WHERE thread_id IS NULL AND process_uuid=?1",
        [&identity], |r| r.get(0))?;
    let mut statement = tx.prepare("SELECT id,thread_id,substr(feedback_log_body,1,2048) FROM logs WHERE id>=?1 AND process_uuid=?2 AND (feedback_log_body LIKE 'app_server.request{%rpc.method=\"thread/%' OR feedback_log_body LIKE 'session_loop{%') ORDER BY id")?;
    let rows = statement.query_map(rusqlite::params![first, identity], |row| {
        Ok(serde_json::json!({"id": row.get::<_, i64>(0)?, "thread_id": row.get::<_, Option<String>>(1)?, "feedback_log_body": row.get::<_, String>(2)?}))
    })?.collect::<Result<Vec<_>, _>>()?;
    // Reject an exit/reuse observed during the read rather than returning its old data.
    if std::fs::read(process.join("environ"))? != environ
        || std::fs::read_to_string(process.join("comm"))?.trim() != "codex"
    {
        return Err("Codex process changed during query".into());
    }
    Ok(serde_json::Value::Array(rows))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("expected PID and terminal ID".into());
    }
    let rows = probe(Path::new("/proc"), args[0].parse()?, &args[1])?;
    serde_json::to_writer(std::io::stdout().lock(), &rows)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_live_wal_without_runtime_and_rejects_wrong_pane() {
        let root = tempfile::tempdir().unwrap();
        let process = root.path().join("42");
        std::fs::create_dir(&process).unwrap();
        std::fs::write(process.join("comm"), "codex\n").unwrap();
        std::fs::write(
            process.join("environ"),
            format!(
                "LX_TERMINAL_ID=pane\0CODEX_SQLITE_HOME={}\0",
                root.path().display()
            ),
        )
        .unwrap();
        let db = rusqlite::Connection::open(root.path().join("logs_2.sqlite")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE logs(id INTEGER PRIMARY KEY,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT);
            CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid) WHERE thread_id IS NULL;
            INSERT INTO logs VALUES(1,NULL,'pid:42:old','start');
            INSERT INTO logs VALUES(2,NULL,'pid:42:new','start');
            INSERT INTO logs VALUES(3,NULL,'pid:42:new','app_server.request{rpc.method=\"thread/start\"}');
            INSERT INTO logs VALUES(4,'other','pid:43:new','session_loop{');
            INSERT INTO logs VALUES(5,'old','pid:42:old','session_loop{');").unwrap();
        let rows = probe(root.path(), 42, "pane").unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["id"], 3);
        assert!(probe(root.path(), 42, "wrong").is_err());
        std::fs::write(process.join("comm"), "sh\n").unwrap();
        assert!(probe(root.path(), 42, "pane").is_err());
    }
}
