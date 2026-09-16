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
    // Threadless retention is independent of per-thread retention. It cannot
    // identify the latest incarnation or bound that incarnation's first log.
    let identity: String = tx.query_row(
        "SELECT process_uuid FROM logs NOT INDEXED WHERE process_uuid GLOB ?1 ORDER BY id DESC LIMIT 1",
        [format!("pid:{pid}:*")], |r| r.get(0))?;
    let first: i64 = tx.query_row(
        "SELECT MIN(id) FROM logs NOT INDEXED WHERE process_uuid=?1",
        [&identity],
        |r| r.get(0),
    )?;
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
    fn retention_and_fault_matrix() {
        let mut checks = 0;
        for _ in 0..5 {
            for journal in ["DELETE", "WAL"] {
                for retention in [
                    "0",
                    "id=2",
                    "id IN (2,5)",
                    "thread_id IS NULL",
                    "thread_id IS NULL AND id<10",
                ] {
                    let root = tempfile::tempdir().unwrap();
                    let process = root.path().join("42");
                    std::fs::create_dir(&process).unwrap();
                    let environ = format!(
                        "LX_TERMINAL_ID=matrix\0CODEX_SQLITE_HOME={}\0",
                        root.path().display()
                    );
                    std::fs::write(process.join("environ"), &environ).unwrap();
                    std::fs::write(process.join("comm"), "codex\n").unwrap();
                    let db = Connection::open(root.path().join("logs_2.sqlite")).unwrap();
                    db.pragma_update(None, "journal_mode", journal).unwrap();
                    db.execute_batch("CREATE TABLE logs(id INTEGER PRIMARY KEY,thread_id TEXT,process_uuid TEXT,feedback_log_body TEXT);
                        CREATE INDEX idx_logs_process_uuid_threadless_ts ON logs(process_uuid) WHERE thread_id IS NULL;
                        INSERT INTO logs VALUES(1,NULL,'pid:42:old','old process');
                        INSERT INTO logs VALUES(2,NULL,'pid:42:new','startup');
                        INSERT INTO logs VALUES(3,'a','pid:42:new','app_server.request{rpc.method=\"thread/start\"}');
                        INSERT INTO logs VALUES(4,'other','pid:43:other','session_loop{');
                        INSERT INTO logs VALUES(5,NULL,'pid:42:new','middle');
                        INSERT INTO logs VALUES(6,'b','pid:42:new','app_server.request{rpc.method=\"thread/start\"}');
                        INSERT INTO logs VALUES(7,'b','pid:42:new','session_loop{');
                        INSERT INTO logs VALUES(8,'a','pid:42:new','app_server.request{rpc.method=\"thread/resume\"}');
                        INSERT INTO logs VALUES(9,'b','pid:42:new','quoted app_server.request{rpc.method=\"thread/start\"}');
                        INSERT INTO logs VALUES(10,NULL,'pid:42:new','late');").unwrap();
                    let expected = probe(root.path(), 42, "matrix").unwrap();
                    assert_eq!(
                        expected
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|r| r["id"].as_i64().unwrap())
                            .collect::<Vec<_>>(),
                        [3, 6, 7, 8]
                    );
                    db.execute(
                        &format!(
                            "DELETE FROM logs WHERE process_uuid='pid:42:new' AND ({retention})"
                        ),
                        [],
                    )
                    .unwrap();
                    assert_eq!(probe(root.path(), 42, "matrix").unwrap(), expected);
                    for invalid in ["", "other-pane"] {
                        assert!(probe(root.path(), 42, invalid).is_err());
                    }
                    std::fs::write(process.join("comm"), "sh\n").unwrap();
                    assert!(probe(root.path(), 42, "matrix").is_err());
                    std::fs::write(process.join("comm"), "codex\n").unwrap();
                    let corrupt = root.path().join("logs_99.sqlite");
                    std::fs::write(&corrupt, "corrupt").unwrap();
                    assert!(probe(root.path(), 42, "matrix").is_err());
                    std::fs::remove_file(corrupt).unwrap();
                    assert_eq!(probe(root.path(), 42, "matrix").unwrap(), expected);
                    if journal == "DELETE" {
                        db.execute_batch("BEGIN EXCLUSIVE").unwrap();
                        assert!(probe(root.path(), 42, "matrix").is_err());
                        db.execute_batch("ROLLBACK").unwrap();
                        assert_eq!(probe(root.path(), 42, "matrix").unwrap(), expected);
                    }
                    db.execute("DELETE FROM logs", []).unwrap();
                    assert!(probe(root.path(), 42, "matrix").is_err());
                    checks += 1;
                }
            }
        }
        assert_eq!(checks, 50);
    }

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
            INSERT INTO logs VALUES(3,'current','pid:42:new','app_server.request{rpc.method=\"thread/start\"}');
            INSERT INTO logs VALUES(4,'other','pid:43:new','session_loop{');
            INSERT INTO logs VALUES(5,'old','pid:42:old','session_loop{');
            INSERT INTO logs VALUES(6,NULL,'pid:42:new','later threadless log');
            INSERT INTO logs VALUES(7,'current','pid:42:new','current thread log');").unwrap();
        let rows = probe(root.path(), 42, "pane").unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["id"], 3);
        for id in [2, 6] {
            db.execute("DELETE FROM logs WHERE id=?1", [id]).unwrap();
            assert_eq!(probe(root.path(), 42, "pane").unwrap(), rows);
        }
        assert!(probe(root.path(), 42, "wrong").is_err());
        std::fs::write(process.join("comm"), "sh\n").unwrap();
        assert!(probe(root.path(), 42, "pane").is_err());
    }
}
