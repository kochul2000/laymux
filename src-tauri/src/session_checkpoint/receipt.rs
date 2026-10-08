//! In-memory receipts for a proven, committed and unchanged Codex checkpoint.
use crate::agent_hooks::title::TitleBinding;
use crate::lock_ext::MutexExt;
use crate::settings::WorkspacePane;
use crate::state::AppState;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq, Eq)]
struct TerminalStamp {
    generation: u64,
    input_revision: u64,
    title: TitleBinding,
    raw_title: String,
    command_running: bool,
    cwd: Option<String>,
    distro: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    hint_revision: u64,
    terminals: BTreeMap<String, TerminalStamp>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    length: u64,
    modified: SystemTime,
}
impl FileStamp {
    fn read(path: &Path) -> Result<Self, String> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("checkpoint file is not a regular file".into());
        }
        Ok(Self {
            path: path.into(),
            length: metadata.len(),
            modified: metadata.modified().map_err(|e| e.to_string())?,
        })
    }
    fn unchanged(&self) -> bool {
        Self::read(&self.path).is_ok_and(|current| &current == self)
    }
}
#[derive(Clone)]
struct Capture {
    token: String,
    snapshot: Snapshot,
}
#[derive(Clone)]
struct CodexProof {
    capture_token: Option<String>,
    generation: u64,
    id: String,
    file: FileStamp,
}
#[derive(Clone)]
struct Receipt {
    token: String,
    snapshot: Snapshot,
    settings: Option<FileStamp>,
    settings_path: PathBuf,
    database_path: PathBuf,
    database_revision: (u64, u64),
    files: Vec<FileStamp>,
}
#[derive(Default)]
pub(crate) struct ReceiptRegistry {
    capture: Option<Capture>,
    proofs: BTreeMap<String, CodexProof>,
    no_agents: BTreeMap<String, (String, u64)>,
    committed: Option<Receipt>,
}
impl ReceiptRegistry {
    pub(crate) fn collecting(&self) -> bool {
        self.capture.is_some()
    }
}

pub(crate) fn collection_token(state: &AppState) -> Option<String> {
    state
        .session_checkpoint
        .receipts
        .lock_or_err()
        .ok()?
        .capture
        .as_ref()
        .map(|c| c.token.clone())
}

pub(crate) fn remember_no_agent(state: &AppState, token: &str, terminal: &str, generation: u64) {
    if let Ok(mut registry) = state.session_checkpoint.receipts.lock_or_err() {
        if registry.capture.as_ref().is_some_and(|c| c.token == token) {
            registry
                .no_agents
                .insert(terminal.into(), (token.into(), generation));
        }
    }
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptCoverage {
    terminal_id: String,
    generation: Option<u64>,
    state: String,
    provider: Option<String>,
    session_id: Option<String>,
}

fn snapshot(state: &AppState) -> Result<Option<Snapshot>, String> {
    let hint_revision = state.session_checkpoint.hints.revision();
    let terminals = state.terminals.lock_or_err()?;
    let handles = state.pty_handles.lock_or_err()?;
    let mut result = BTreeMap::new();
    for (id, handle) in handles.iter() {
        // A projection has no authority over live title/input revisions.
        // Only the daemon owning the native PTY may issue its receipt.
        if handle.is_external() {
            return Ok(None);
        }
        let Some(terminal) = terminals.get(id) else {
            return Ok(None);
        };
        if !handle.checkpoint_input_healthy() {
            return Ok(None);
        }
        if terminal.codex_hook_title.generation != handle.terminal_generation() {
            return Ok(None);
        }
        result.insert(
            id.clone(),
            TerminalStamp {
                generation: handle.terminal_generation(),
                input_revision: handle.checkpoint_input_revision(),
                title: terminal.codex_hook_title.clone(),
                raw_title: terminal.title.clone(),
                command_running: terminal.command_running,
                cwd: terminal.cwd.clone(),
                distro: terminal.wsl_distro.clone(),
            },
        );
    }
    if result.is_empty() || state.session_checkpoint.hints.revision() != hint_revision {
        return Ok(None);
    }
    Ok(Some(Snapshot {
        hint_revision,
        terminals: result,
    }))
}

pub(crate) fn remember_codex_file(
    state: &AppState,
    terminal: &str,
    generation: u64,
    id: &str,
    path: &Path,
) {
    let file = FileStamp::read(path);
    if let Ok(mut registry) = state.session_checkpoint.receipts.lock_or_err() {
        registry.proofs.remove(terminal);
        if let Ok(file) = file {
            let capture_token = registry.capture.as_ref().map(|c| c.token.clone());
            registry.proofs.insert(
                terminal.into(),
                CodexProof {
                    capture_token,
                    generation,
                    id: id.into(),
                    file,
                },
            );
        }
    }
}
pub(crate) fn capture(state: &AppState) -> Result<Option<String>, String> {
    let Some(snapshot) = snapshot(state)? else {
        return Ok(None);
    };
    let token = uuid::Uuid::new_v4().to_string();
    let mut registry = state.session_checkpoint.receipts.lock_or_err()?;
    registry
        .proofs
        .retain(|id, _| snapshot.terminals.contains_key(id));
    registry
        .no_agents
        .retain(|id, _| snapshot.terminals.contains_key(id));
    registry.capture = Some(Capture {
        token: token.clone(),
        snapshot,
    });
    Ok(Some(token))
}

fn panes<'a>(
    value: &'a serde_json::Value,
    group: &str,
) -> impl Iterator<Item = &'a serde_json::Value> {
    value
        .get(group)
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .flat_map(|owner| {
            owner
                .get("panes")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
        })
}

/// Saved terminal views keyed by terminal id. Workspace slots go through
/// `WorkspacePane::content_views` so a stacked slot (ADR-0297 `layers`) and the
/// compact `id`/`view` form follow the same rule as the settings model.
/// Docks only persist the compact form. `None` when the file is ambiguous.
fn saved_views(value: &serde_json::Value) -> Option<BTreeMap<String, serde_json::Value>> {
    let mut result = BTreeMap::new();
    let mut insert = |id: &str, view: serde_json::Value| -> Option<()> {
        if view["type"].as_str() != Some("TerminalView") {
            return Some(());
        }
        if id.is_empty() || result.insert(format!("terminal-{id}"), view).is_some() {
            return None;
        }
        Some(())
    };
    for pane in panes(value, "workspaces") {
        let pane = WorkspacePane::deserialize(pane).ok()?;
        for (id, view) in pane.content_views() {
            insert(id, serde_json::to_value(view).ok()?)?;
        }
    }
    for pane in panes(value, "docks") {
        insert(
            pane["id"].as_str().unwrap_or_default(),
            pane["view"].clone(),
        )?;
    }
    Some(result)
}

pub(crate) fn commit_to_revision(
    state: &AppState,
    token: &str,
    coverage: &[ReceiptCoverage],
    path: &Path,
    expected_revision: Option<u64>,
    store: &crate::local_state::LocalStateStore,
) -> Result<Option<String>, String> {
    let (captured, proofs, no_agents) = {
        let registry = state.session_checkpoint.receipts.lock_or_err()?;
        let Some(captured) = registry
            .capture
            .as_ref()
            .filter(|c| c.token == token)
            .cloned()
        else {
            return Ok(None);
        };
        (
            captured,
            registry.proofs.clone(),
            registry.no_agents.clone(),
        )
    };
    if snapshot(state)?.as_ref() != Some(&captured.snapshot)
        || coverage.len() != captured.snapshot.terminals.len()
    {
        return Ok(None);
    }
    let settings = if path.exists() {
        Some(FileStamp::read(path)?)
    } else {
        None
    };
    let database_revision = store.revision().map_err(String::from)?;
    if expected_revision.is_some_and(|expected| expected != database_revision.0) {
        return Ok(None);
    }
    let Some(session) = store.load_session().map_err(String::from)? else {
        return Ok(None);
    };
    let value = serde_json::to_value(session).map_err(|e| e.to_string())?;
    let Some(saved) = saved_views(&value) else {
        return Ok(None);
    };
    let mut ids = HashSet::new();
    let mut sessions = HashSet::new();
    let mut files = Vec::new();
    for entry in coverage {
        let Some(current) = captured.snapshot.terminals.get(&entry.terminal_id) else {
            return Ok(None);
        };
        let Some(view) = saved.get(&entry.terminal_id) else {
            return Ok(None);
        };
        if entry.generation != Some(current.generation) || !ids.insert(&entry.terminal_id) {
            return Ok(None);
        }
        if entry.state == "noAgent" {
            if no_agents.get(&entry.terminal_id) != Some(&(token.to_owned(), current.generation))
                || entry.provider.is_some()
                || entry.session_id.is_some()
                || current.title.identity.is_some()
                || current.command_running
                || current.raw_title == "Terminal"
                || [
                    "lastCodexSession",
                    "lastClaudeSession",
                    "lastGrokSession",
                    "lastAgentFresh",
                ]
                .iter()
                .any(|key| view.get(key).is_some_and(|v| !v.is_null()))
            {
                return Ok(None);
            }
            continue;
        }
        let Some(id) = entry.session_id.as_deref() else {
            return Ok(None);
        };
        let Some(proof) = proofs.get(&entry.terminal_id) else {
            return Ok(None);
        };
        if entry.state != "identified"
            || entry.provider.as_deref() != Some("codex")
            || proof.generation != current.generation
            || proof.capture_token.as_deref() != Some(token)
            || proof.id != id
            || view["lastCodexSession"].as_str() != Some(id)
            || !current
                .title
                .identity
                .as_deref()
                .is_some_and(|prefix| id.starts_with(prefix))
            || !uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
            || !sessions.insert(id)
            || !proof.file.unchanged()
        {
            return Ok(None);
        }
        files.push(proof.file.clone());
    }
    if !configuration_unchanged(path, settings.as_ref())
        || store.revision().map_err(String::from)? != database_revision
        || snapshot(state)?.as_ref() != Some(&captured.snapshot)
    {
        return Ok(None);
    }
    let mut registry = state.session_checkpoint.receipts.lock_or_err()?;
    if registry
        .capture
        .as_ref()
        .is_none_or(|current| current.token != token)
    {
        return Ok(None);
    }
    let receipt_token = uuid::Uuid::new_v4().to_string();
    registry.capture = None;
    registry.committed = Some(Receipt {
        token: receipt_token.clone(),
        snapshot: captured.snapshot,
        settings,
        settings_path: path.into(),
        database_path: store.path().into(),
        database_revision,
        files,
    });
    Ok(Some(receipt_token))
}

pub(crate) fn reusable(state: &AppState, token: &str) -> Result<bool, String> {
    let receipt = state
        .session_checkpoint
        .receipts
        .lock_or_err()?
        .committed
        .clone();
    let Some(receipt) = receipt.filter(|r| r.token == token) else {
        return Ok(false);
    };
    if snapshot(state)?.as_ref() != Some(&receipt.snapshot)
        || !configuration_unchanged(&receipt.settings_path, receipt.settings.as_ref())
        || crate::local_state::LocalStateStore::new(&receipt.database_path)
            .revision()
            .map_err(String::from)?
            != receipt.database_revision
        || receipt.files.iter().any(|file| !file.unchanged())
    {
        return Ok(false);
    }
    Ok(snapshot(state)?.as_ref() == Some(&receipt.snapshot))
}

fn configuration_unchanged(path: &Path, stamp: Option<&FileStamp>) -> bool {
    stamp.map_or_else(|| !path.exists(), FileStamp::unchanged)
}
#[cfg(test)]
fn commit_to(
    state: &AppState,
    token: &str,
    coverage: &[ReceiptCoverage],
    path: &Path,
) -> Result<Option<String>, String> {
    commit_to_revision(
        state,
        token,
        coverage,
        path,
        None,
        &crate::settings::persistence::store_for_settings(path)?,
    )
}

#[tauri::command(async)]
pub fn capture_session_checkpoint_receipt(
    state: tauri::State<std::sync::Arc<AppState>>,
) -> Result<Option<String>, String> {
    if let Some(daemon) = state.daemon.get() {
        return serde_json::from_value(
            daemon.read_blocking(crate::daemon_requests::ReadCommand::CaptureReceipt)?,
        )
        .map_err(|error| format!("source receipt capture rejected: {error}"));
    }
    capture(&state)
}
#[tauri::command(async)]
pub fn commit_session_checkpoint_receipt(
    token: String,
    coverage: Vec<ReceiptCoverage>,
    checkpoint_revision: u64,
    state: tauri::State<std::sync::Arc<AppState>>,
) -> Result<Option<String>, String> {
    if let Some(daemon) = state.daemon.get() {
        return serde_json::from_value(daemon.read_blocking(
            crate::daemon_requests::ReadCommand::CommitReceipt {
                token,
                coverage,
                checkpoint_revision,
            },
        )?)
        .map_err(|error| format!("source receipt commit rejected: {error}"));
    }
    commit_to_revision(
        &state,
        &token,
        &coverage,
        &crate::settings::settings_path(),
        Some(checkpoint_revision),
        &crate::settings::persistence::production_store()?,
    )
}
#[cfg(test)]
mod tests;
