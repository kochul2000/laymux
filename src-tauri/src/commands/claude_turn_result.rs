//! Claude turn results from the attributed transcript (ADR-0340).
//!
//! When the displayed task starts, the transcript length becomes its
//! baseline. Only complete records appended after it can decide that task's
//! result, so an earlier turn's boundary never fills a later task.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::wsl_probe::snapshot::GuestObservation;

use super::claude_session::{get_claude_session_records_impl, is_valid_session_id};
use super::session_attribution::ProviderSessionLookup;

/// Appended bytes read per lookup; the rest is read on the next poll.
const READ_LIMIT: u64 = 8 * 1024 * 1024;
/// Records kept per task to walk `parentUuid`; beyond this the task is unknown.
const MAX_NODES: usize = 200_000;
/// Ancestors walked from `turn_duration` before giving up.
const MAX_CHAIN: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTurnRequest {
    terminal_id: String,
    /// The displayed task's identity, chosen by the frontend.
    key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudeTurnOutcome {
    /// No boundary has been appended after the baseline yet.
    Pending,
    Success,
    Failure,
    Interrupted,
    /// Settled without a result: several boundaries, an unresolved chain, or
    /// an unreadable, shrunk or replaced transcript.
    Unknown,
}

#[derive(Debug)]
enum Boundary {
    Duration { parent: Option<String> },
    Interrupted,
}

#[derive(Debug)]
struct Node {
    parent: Option<String>,
    /// `Some(is_api_error)` for an assistant record.
    assistant: Option<bool>,
}

/// Only the fields the boundary rules read; everything else is dropped.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(rename = "type")]
    kind: Option<String>,
    subtype: Option<String>,
    uuid: Option<String>,
    parent_uuid: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
    #[serde(default)]
    is_api_error_message: bool,
    interrupted_message_id: Option<String>,
}

#[derive(Debug, Default)]
struct TurnScan {
    nodes: HashMap<String, Node>,
    boundaries: Vec<Boundary>,
    /// An assistant record followed a boundary: the work went on past it
    /// (e.g. Claude resuming after a background tool) under the same task.
    continued: bool,
    broken: bool,
}

impl TurnScan {
    fn push(&mut self, line: &[u8]) {
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            self.broken = true;
            return;
        };
        if record.is_sidechain {
            return;
        }
        let kind = record.kind.as_deref();
        if kind == Some("assistant") && !self.boundaries.is_empty() {
            self.continued = true;
        }
        if let Some(uuid) = record.uuid {
            if self.nodes.len() >= MAX_NODES {
                self.broken = true;
                return;
            }
            self.nodes.insert(
                uuid,
                Node {
                    parent: record.parent_uuid.clone(),
                    assistant: (kind == Some("assistant")).then_some(record.is_api_error_message),
                },
            );
        }
        match kind {
            Some("system") if record.subtype.as_deref() == Some("turn_duration") => {
                self.boundaries.push(Boundary::Duration {
                    parent: record.parent_uuid,
                })
            }
            Some("user") if record.interrupted_message_id.is_some() => {
                self.boundaries.push(Boundary::Interrupted)
            }
            _ => {}
        }
    }

    fn outcome(&self) -> ClaudeTurnOutcome {
        if self.broken || self.continued {
            return ClaudeTurnOutcome::Unknown;
        }
        match self.boundaries.as_slice() {
            [] => ClaudeTurnOutcome::Pending,
            [Boundary::Interrupted] => ClaudeTurnOutcome::Interrupted,
            [Boundary::Duration { parent }] => self.ended_by(parent.as_deref()),
            _ => ClaudeTurnOutcome::Unknown,
        }
    }

    /// The first assistant ancestor of `turn_duration` decides how it ended.
    fn ended_by<'a>(&'a self, mut parent: Option<&'a str>) -> ClaudeTurnOutcome {
        for _ in 0..MAX_CHAIN {
            let Some(node) = parent.and_then(|id| self.nodes.get(id)) else {
                break;
            };
            match node.assistant {
                Some(true) => return ClaudeTurnOutcome::Failure,
                Some(false) => return ClaudeTurnOutcome::Success,
                None => parent = node.parent.as_deref(),
            }
        }
        ClaudeTurnOutcome::Unknown
    }
}

#[derive(Debug)]
struct Tracked {
    generation: u64,
    key: String,
    path: PathBuf,
    /// Next unread byte; always at a line start once `partial` is cleared.
    offset: u64,
    /// The baseline fell inside a line still being written.
    partial: bool,
    scan: TurnScan,
    settled: Option<ClaudeTurnOutcome>,
}

impl Tracked {
    fn advance(&mut self) -> std::io::Result<()> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            self.scan.broken = true;
            return Ok(());
        }
        if len == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.take((len - self.offset).min(READ_LIMIT))
            .read_to_end(&mut bytes)?;
        self.consume(&bytes);
        Ok(())
    }

    fn consume(&mut self, bytes: &[u8]) {
        // The last line may still be being written; only complete lines count.
        let Some(end) = bytes.iter().rposition(|&byte| byte == b'\n') else {
            if bytes.len() as u64 >= READ_LIMIT {
                self.scan.broken = true;
            }
            return;
        };
        let mut lines = bytes[..end].split(|&byte| byte == b'\n');
        if std::mem::take(&mut self.partial) {
            lines.next();
        }
        for line in lines.filter(|line| !line.is_empty()) {
            self.scan.push(line);
        }
        self.offset += end as u64 + 1;
    }

    fn outcome(&mut self) -> ClaudeTurnOutcome {
        if let Some(settled) = self.settled {
            return settled;
        }
        if let Err(error) = self.advance() {
            tracing::debug!(%error, path = %self.path.display(), "Claude transcript unavailable");
            self.scan.broken = true;
        }
        let outcome = self.scan.outcome();
        if outcome != ClaudeTurnOutcome::Pending {
            // A filled result is final even if more boundaries follow.
            self.settled = Some(outcome);
            self.scan = TurnScan::default();
        }
        outcome
    }
}

/// Baselines kept per terminal: the heuristic and hook tasks of the current
/// turn plus the turn before, which may still be reading its result.
const MAX_PER_TERMINAL: usize = 4;

/// Leaf lock: never held while taking an AppState lock.
static TRACKED: LazyLock<Mutex<HashMap<String, Vec<Tracked>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTurnResult {
    terminal_id: String,
    key: String,
    outcome: ClaudeTurnOutcome,
}

/// Record the transcript baseline of each task that just started. Returns the
/// requests whose baseline was recorded.
#[tauri::command(async)]
pub fn begin_claude_turns(
    requests: Vec<ClaudeTurnRequest>,
    state: State<Arc<AppState>>,
) -> Result<Vec<ClaudeTurnRequest>, String> {
    begin_claude_turns_impl(&requests, &state)
}

pub(crate) fn begin_claude_turns_impl(
    requests: &[ClaudeTurnRequest],
    state: &AppState,
) -> Result<Vec<ClaudeTurnRequest>, String> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let generations = terminal_generations(state)?;
    let records = get_claude_session_records_impl(None, state, GuestObservation::Reusable)?;
    let mut started = Vec::new();
    for request in requests {
        let Some(&generation) = generations.get(&request.terminal_id) else {
            continue;
        };
        let Some(path) = attributed(&records.lookup, &request.terminal_id)
            .filter(|session_id| is_valid_session_id(session_id))
            .and_then(|session_id| {
                find_transcript(records.config_roots.get(session_id)?, session_id)
            })
        else {
            continue;
        };
        match baseline(&path) {
            Ok((offset, partial)) => started.push((
                request.clone(),
                Tracked {
                    generation,
                    key: request.key.clone(),
                    path,
                    offset,
                    partial,
                    scan: TurnScan::default(),
                    settled: None,
                },
            )),
            Err(error) => {
                tracing::debug!(%error, path = %path.display(), "Claude transcript baseline failed")
            }
        }
    }
    // A PTY replaced during the lookup belongs to another process.
    let current = terminal_generations(state)?;
    let mut tracked = TRACKED.lock_or_err().map_err(|error| error.to_string())?;
    tracked.retain(|id, entries| {
        entries.retain(|entry| current.get(id) == Some(&entry.generation));
        !entries.is_empty()
    });
    let mut recorded = Vec::new();
    for (request, entry) in started {
        if current.get(&request.terminal_id) != Some(&entry.generation) {
            continue;
        }
        let entries = tracked.entry(request.terminal_id.clone()).or_default();
        entries.retain(|existing| existing.key != entry.key);
        entries.push(entry);
        if entries.len() > MAX_PER_TERMINAL {
            entries.remove(0);
        }
        recorded.push(request);
    }
    Ok(recorded)
}

/// Results for tasks whose baseline was recorded under the same key. A
/// request is missing when no baseline belongs to it.
#[tauri::command(async)]
pub fn get_claude_turn_results(
    requests: Vec<ClaudeTurnRequest>,
    state: State<Arc<AppState>>,
) -> Result<Vec<ClaudeTurnResult>, String> {
    get_claude_turn_results_impl(&requests, &state)
}

pub(crate) fn get_claude_turn_results_impl(
    requests: &[ClaudeTurnRequest],
    state: &AppState,
) -> Result<Vec<ClaudeTurnResult>, String> {
    let generations = terminal_generations(state)?;
    let mut tracked = TRACKED.lock_or_err().map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for request in requests {
        let Some(entries) = tracked.get_mut(&request.terminal_id) else {
            continue;
        };
        let generation = generations.get(&request.terminal_id);
        entries.retain(|entry| generation == Some(&entry.generation));
        let Some(entry) = entries.iter_mut().find(|entry| entry.key == request.key) else {
            continue;
        };
        results.push(ClaudeTurnResult {
            terminal_id: request.terminal_id.clone(),
            key: request.key.clone(),
            outcome: entry.outcome(),
        });
    }
    tracked.retain(|_, entries| !entries.is_empty());
    Ok(results)
}

/// The transcript is `projects/<any>/<sessionId>.jsonl` under the config root
/// that attributed the session. Claude's directory naming is not derived.
fn find_transcript(root: &Path, session_id: &str) -> Option<PathBuf> {
    let name = format!("{session_id}.jsonl");
    let mut found = None;
    for entry in std::fs::read_dir(root.join("projects")).ok()?.flatten() {
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            if found.is_some() {
                return None;
            }
            found = Some(candidate);
        }
    }
    found
}

fn baseline(path: &Path) -> std::io::Result<(u64, bool)> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok((0, false));
    }
    file.seek(SeekFrom::Start(len - 1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok((len, last[0] != b'\n'))
}

fn terminal_generations(state: &AppState) -> Result<HashMap<String, u64>, String> {
    Ok(state
        .pty_handles
        .lock_or_err()
        .map_err(|error| error.to_string())?
        .iter()
        .map(|(id, handle)| (id.clone(), handle.terminal_generation()))
        .collect())
}

fn attributed<'a>(lookup: &'a ProviderSessionLookup, terminal_id: &str) -> Option<&'a str> {
    if lookup.failed_terminal_ids.contains(terminal_id) {
        return None;
    }
    lookup.attributions.get(terminal_id)?.as_deref()
}

#[cfg(test)]
mod tests;
