use super::models::{AttributionCoverage, CheckpointCommit, LocalSessionSnapshot};
use super::preserve::{content_views, preserve_unknown};
use super::projection::MachineConfiguration;
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

const SCHEMA_VERSION: i64 = 1;
static INITIALIZATION_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
const BUSY_TIMEOUT: Duration = Duration::from_millis(250);
#[derive(Clone)]
pub struct LocalStateStore {
    path: PathBuf,
}
impl LocalStateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn open(&self, write: bool) -> Result<Option<Connection>, AppError> {
        let _initialization = INITIALIZATION_GATE.lock_or_err()?;
        let exists = self.path.exists();
        if !exists && !write {
            return Ok(None);
        }
        if write {
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open_with_flags(
            &self.path,
            if write {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                    | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            } else {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            },
        )?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 0 && write {
            let unknown_tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r| r.get(0))?;
            if unknown_tables != 0 {
                return Err(AppError::Other(
                    "Unversioned local state database must be handled manually".into(),
                ));
            }
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                BEGIN IMMEDIATE;
                CREATE TABLE state_meta (id INTEGER PRIMARY KEY CHECK(id=1), session_revision INTEGER NOT NULL, machine_revision INTEGER NOT NULL, display_order TEXT NOT NULL, needs_retry INTEGER NOT NULL, ui_state TEXT NOT NULL);
                INSERT INTO state_meta VALUES (1,0,0,'[]',0,'{}');
                CREATE TABLE machine_settings (path TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE session_groups (kind TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(kind,id));
                CREATE TABLE session_panes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, group_id TEXT NOT NULL, ordinal INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, content TEXT NOT NULL, FOREIGN KEY(kind,group_id) REFERENCES session_groups(kind,id) ON DELETE CASCADE);
                CREATE TABLE session_attributions (terminal_id TEXT PRIMARY KEY, state TEXT NOT NULL, generation INTEGER, provider TEXT, session_id TEXT);
                PRAGMA user_version=1; COMMIT;")?;
        } else if version != SCHEMA_VERSION {
            return Err(AppError::Other(format!(
                "Unsupported local state schema {version}: {}",
                self.path.display()
            )));
        }
        if write {
            conn.pragma_update(None, "synchronous", "FULL")?;
        }
        Ok(Some(conn))
    }
    pub fn load_configuration(&self) -> Result<MachineConfiguration, AppError> {
        let Some(conn) = self.open(false)? else {
            return Ok(Default::default());
        };
        let mut query = conn.prepare("SELECT path,value FROM machine_settings ORDER BY path")?;
        let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|r| {
            let (key, value) = r?;
            Ok((key, serde_json::from_str(&value)?))
        })
        .collect()
    }
    pub fn save_configuration(&self, values: &MachineConfiguration) -> Result<(), AppError> {
        let mut conn = self
            .open(true)?
            .ok_or_else(|| AppError::Other("Local state connection missing".into()))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut existing = MachineConfiguration::new();
        {
            let mut query = tx.prepare("SELECT path,value FROM machine_settings")?;
            for row in
                query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (key, value) = row?;
                existing.insert(key, serde_json::from_str(&value)?);
            }
        }
        if &existing != values {
            tx.execute("DELETE FROM machine_settings", [])?;
            for (key, value) in values {
                tx.execute(
                    "INSERT INTO machine_settings VALUES (?1,?2)",
                    params![key, serde_json::to_string(value)?],
                )?;
            }
            tx.execute(
                "UPDATE state_meta SET machine_revision=machine_revision+1 WHERE id=1",
                [],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn load_session(&self) -> Result<Option<LocalSessionSnapshot>, AppError> {
        let Some(mut conn) = self.open(false)? else {
            return Ok(None);
        };
        let tx = conn.transaction()?;
        let snapshot = load_session(&tx)?;
        tx.commit()?;
        Ok(snapshot)
    }
    pub fn revision(&self) -> Result<(u64, u64), AppError> {
        let Some(conn) = self.open(false)? else {
            return Ok((0, 0));
        };
        Ok(conn.query_row(
            "SELECT session_revision,machine_revision FROM state_meta WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }
    pub fn checkpoint_needs_retry(&self, revision: u64) -> Result<bool, AppError> {
        let Some(conn) = self.open(false)? else {
            return Ok(true);
        };
        let (current, retry): (u64, bool) = conn.query_row(
            "SELECT session_revision,needs_retry FROM state_meta WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(current < revision || retry)
    }
    pub fn commit_session(
        &self,
        snapshot: &LocalSessionSnapshot,
    ) -> Result<CheckpointCommit, AppError> {
        let mut conn = self
            .open(true)?
            .ok_or_else(|| AppError::Other("Local state connection missing".into()))?;
        Self::commit_session_connection(&mut conn, snapshot)
    }
    pub(super) fn commit_session_connection(
        conn: &mut Connection,
        snapshot: &LocalSessionSnapshot,
    ) -> Result<CheckpointCommit, AppError> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = load_session(&tx)?.unwrap_or_default();
        let mut committed = snapshot.clone();
        preserve_unknown(&previous, &mut committed)?;
        let unresolved_terminal_ids: Vec<_> = committed
            .coverage
            .iter()
            .filter(|c| c.state == "unknown")
            .map(|c| c.terminal_id.clone())
            .collect();
        let needs_retry = !unresolved_terminal_ids.is_empty()
            || committed.attribution_lookup_failed
            || committed.cwd_lookup_failed;
        let mut content_ids = HashSet::new();
        for (id, _) in content_views(&committed)? {
            if id.is_empty() || !content_ids.insert(id.clone()) {
                return Err(AppError::Other(format!(
                    "Duplicate or empty local session content: {id}"
                )));
            }
        }
        tx.execute("DELETE FROM session_panes", [])?;
        tx.execute("DELETE FROM session_groups", [])?;
        tx.execute("DELETE FROM session_attributions", [])?;
        let encoded = serde_json::to_value(&committed)?;
        let mut pane_ids = HashSet::new();
        for kind in ["workspaces", "docks"] {
            for (ordinal, group) in encoded[kind].as_array().into_iter().flatten().enumerate() {
                let id = group[if kind == "workspaces" {
                    "id"
                } else {
                    "position"
                }]
                .as_str()
                .ok_or_else(|| AppError::Other("Session group identity missing".into()))?;
                let mut metadata = group.clone();
                metadata
                    .as_object_mut()
                    .ok_or_else(|| AppError::Other("Invalid session group".into()))?
                    .remove("panes");
                tx.execute(
                    "INSERT INTO session_groups VALUES (?1,?2,?3,?4)",
                    params![kind, id, ordinal as u64, serde_json::to_string(&metadata)?],
                )?;
                for (position, pane) in group["panes"].as_array().into_iter().flatten().enumerate()
                {
                    let id = pane["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| AppError::Other("Session pane identity missing".into()))?;
                    if !pane_ids.insert(id) {
                        return Err(AppError::Other(format!(
                            "Duplicate local session pane: {id}"
                        )));
                    }
                    let group_id = group[if kind == "workspaces" {
                        "id"
                    } else {
                        "position"
                    }]
                    .as_str()
                    .ok_or_else(|| AppError::Other("Session group identity missing".into()))?;
                    let geometry: Vec<f64> = ["x", "y", "w", "h"]
                        .into_iter()
                        .map(|key| {
                            pane[key]
                                .as_f64()
                                .ok_or_else(|| AppError::Other("Invalid pane geometry".into()))
                        })
                        .collect::<Result<_, _>>()?;
                    let mut content = pane.clone();
                    let metadata = content
                        .as_object_mut()
                        .ok_or_else(|| AppError::Other("Invalid pane content".into()))?;
                    for field in ["id", "x", "y", "w", "h"] {
                        metadata.remove(field);
                    }
                    tx.execute(
                        "INSERT INTO session_panes VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                        params![
                            id,
                            kind,
                            group_id,
                            position as u64,
                            geometry[0],
                            geometry[1],
                            geometry[2],
                            geometry[3],
                            serde_json::to_string(&content)?
                        ],
                    )?;
                }
            }
        }
        for coverage in &committed.coverage {
            tx.execute(
                "INSERT INTO session_attributions VALUES (?1,?2,?3,?4,?5)",
                params![
                    coverage.terminal_id,
                    coverage.state,
                    coverage.generation,
                    coverage.provider,
                    coverage.session_id
                ],
            )?;
        }
        tx.execute("UPDATE state_meta SET session_revision=session_revision+1,display_order=?1,needs_retry=?2,ui_state=?3 WHERE id=1",params![serde_json::to_string(&committed.workspace_display_order)?,needs_retry,serde_json::to_string(&committed.ui_state)?])?;
        let revision = tx.query_row(
            "SELECT session_revision FROM state_meta WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(CheckpointCommit {
            revision,
            unresolved_terminal_ids,
            needs_retry,
            snapshot: committed,
        })
    }
}
fn load_session(conn: &Connection) -> Result<Option<LocalSessionSnapshot>, AppError> {
    let (revision, order, ui_state): (u64, String, String) = conn.query_row(
        "SELECT session_revision,display_order,ui_state FROM state_meta WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if revision == 0 {
        return Ok(None);
    }
    let mut value = serde_json::json!({"workspaces":[],"docks":[],"workspaceDisplayOrder":serde_json::from_str::<Value>(&order)?,"uiState":serde_json::from_str::<Value>(&ui_state)?});
    let mut groups =
        conn.prepare("SELECT kind,id,metadata FROM session_groups ORDER BY kind,ordinal")?;
    for row in groups.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (kind, id, metadata) = row?;
        let mut group: Value = serde_json::from_str(&metadata)?;
        let mut panes=conn.prepare("SELECT id,x,y,w,h,content FROM session_panes WHERE kind=?1 AND group_id=?2 ORDER BY ordinal")?;
        let mut list = Vec::new();
        for pane in panes.query_map(params![kind, id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })? {
            let (id, x, y, w, h, view) = pane?;
            let mut pane: Value = serde_json::from_str(&view)?;
            let metadata = pane
                .as_object_mut()
                .ok_or_else(|| AppError::Other("Invalid persisted pane content".into()))?;
            for (key, value) in [
                ("id", id.into()),
                ("x", x.into()),
                ("y", y.into()),
                ("w", w.into()),
                ("h", h.into()),
            ] {
                metadata.insert(key.into(), value);
            }
            list.push(pane);
        }
        group["panes"] = Value::Array(list);
        value[&kind]
            .as_array_mut()
            .ok_or_else(|| AppError::Other("Invalid local session group kind".into()))?
            .push(group);
    }
    let mut snapshot: LocalSessionSnapshot = serde_json::from_value(value)?;
    let mut query=conn.prepare("SELECT terminal_id,state,generation,provider,session_id FROM session_attributions ORDER BY terminal_id")?;
    snapshot.coverage = query
        .query_map([], |r| {
            Ok(AttributionCoverage {
                terminal_id: r.get(0)?,
                state: r.get(1)?,
                generation: r.get(2)?,
                provider: r.get(3)?,
                session_id: r.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Some(snapshot))
}
