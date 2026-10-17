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
use std::time::{Duration, Instant};

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
/// Bytes compared before the read position to detect a replaced transcript.
const ANCHOR_LEN: usize = 256;
/// A baseline no lookup has asked for this long after its last lookup was
/// abandoned by the frontend (its result window closed).
const ABANDONED_AFTER: Duration = Duration::from_secs(60);

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
    broken: Option<&'static str>,
}

impl TurnScan {
    fn push(&mut self, line: &[u8]) {
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            self.broken = Some("unreadable record");
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
                self.broken = Some("record limit");
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
        if self.broken.is_some() || self.continued {
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
enum Location {
    File(PathBuf),
    /// The session had no transcript yet when the task started (Claude creates
    /// it with the first prompt), so the whole file appears after the baseline.
    NotYet {
        root: PathBuf,
        session_id: String,
    },
}

#[derive(Debug)]
struct Tracked {
    generation: u64,
    key: String,
    location: Location,
    /// Next unread byte; always at a line start once `partial` is cleared.
    offset: u64,
    /// The baseline fell inside a line still being written.
    partial: bool,
    /// The bytes just before `offset`. The transcript only grows, so if they
    /// differ on a later read the file was replaced.
    anchor: Vec<u8>,
    scan: TurnScan,
    settled: Option<ClaudeTurnOutcome>,
    /// Set by the first result lookup; a running task is never looked up.
    looked_up: Option<Instant>,
}

impl Tracked {
    fn new(generation: u64, key: String, location: Location, start: Baseline) -> Self {
        Self {
            generation,
            key,
            location,
            offset: start.offset,
            partial: start.partial,
            anchor: start.anchor,
            scan: TurnScan::default(),
            settled: None,
            looked_up: None,
        }
    }

    fn abandoned(&self, now: Instant) -> bool {
        self.looked_up
            .is_some_and(|at| now.duration_since(at) >= ABANDONED_AFTER)
    }

    /// Read appended complete lines. Returns whether every byte the file had
    /// at this read was examined; a capped read leaves the rest for next time.
    fn advance(&mut self) -> std::io::Result<bool> {
        if let Location::NotYet { root, session_id } = &self.location {
            match find_transcript(root, session_id) {
                Transcript::Found(path) => self.location = Location::File(path),
                Transcript::Absent => return Ok(true),
                Transcript::Unknown => {
                    self.scan.broken = Some("transcript lookup failed");
                    return Ok(true);
                }
            }
        }
        let Location::File(path) = &self.location else {
            return Ok(true);
        };
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            self.scan.broken = Some("transcript shrank");
            return Ok(true);
        }
        if !self.anchor.is_empty() {
            let mut current = vec![0u8; self.anchor.len()];
            file.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))?;
            file.read_exact(&mut current)?;
            if current != self.anchor {
                self.scan.broken = Some("transcript replaced");
                return Ok(true);
            }
        }
        if len == self.offset {
            return Ok(true);
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let available = len - self.offset;
        let mut bytes = Vec::new();
        file.take(available.min(READ_LIMIT))
            .read_to_end(&mut bytes)?;
        self.consume(&bytes);
        Ok(available <= READ_LIMIT)
    }

    fn consume(&mut self, bytes: &[u8]) {
        // The last line may still be being written; only complete lines count.
        let Some(end) = bytes.iter().rposition(|&byte| byte == b'\n') else {
            if bytes.len() as u64 >= READ_LIMIT {
                self.scan.broken = Some("line over read limit");
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
        let consumed = &bytes[..=end];
        let keep = ANCHOR_LEN
            .saturating_sub(consumed.len())
            .min(self.anchor.len());
        self.anchor.drain(..self.anchor.len() - keep);
        self.anchor
            .extend_from_slice(&consumed[consumed.len().saturating_sub(ANCHOR_LEN)..]);
        self.offset += end as u64 + 1;
    }

    fn outcome(&mut self) -> ClaudeTurnOutcome {
        self.looked_up = Some(Instant::now());
        if let Some(settled) = self.settled {
            return settled;
        }
        let caught_up = match self.advance() {
            Ok(caught_up) => caught_up,
            Err(error) => {
                tracing::debug!(%error, location = ?self.location, "Claude transcript unavailable");
                self.scan.broken = Some("transcript unreadable");
                true
            }
        };
        let mut outcome = self.scan.outcome();
        // Records past a capped read can still continue the work or add a
        // boundary, so a result waits until the whole file has been read.
        // `Unknown` cannot become a result with more records and settles now.
        if !caught_up && outcome != ClaudeTurnOutcome::Unknown {
            outcome = ClaudeTurnOutcome::Pending;
        }
        if outcome != ClaudeTurnOutcome::Pending {
            tracing::info!(
                key = %self.key,
                ?outcome,
                boundaries = self.scan.boundaries.len(),
                continued = self.scan.continued,
                broken = self.scan.broken.unwrap_or("-"),
                offset = self.offset,
                "Claude turn result settled"
            );
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
    let generations = terminal_generations(state)?;
    // A repeated request (a restarted subscription) keeps the first baseline;
    // a later one would skip records the task already wrote.
    let (known, fresh): (Vec<_>, Vec<_>) = {
        let mut tracked = TRACKED.lock_or_err().map_err(|error| error.to_string())?;
        prune(&mut tracked, &generations);
        requests.iter().partition(|request| {
            tracked.get(&request.terminal_id).is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry.key == request.key
                        && generations.get(&request.terminal_id) == Some(&entry.generation)
                })
            })
        })
    };
    let mut recorded: Vec<ClaudeTurnRequest> = known.into_iter().cloned().collect();
    if fresh.is_empty() {
        return Ok(recorded);
    }
    let records = get_claude_session_records_impl(None, state, GuestObservation::Reusable)?;
    let mut started = Vec::new();
    for request in fresh {
        let Some(&generation) = generations.get(&request.terminal_id) else {
            continue;
        };
        let Some((session_id, root)) = attributed(&records.lookup, &request.terminal_id)
            .filter(|session_id| is_valid_session_id(session_id))
            .and_then(|session_id| Some((session_id, records.config_roots.get(session_id)?)))
        else {
            continue;
        };
        let (location, start) = match find_transcript(root, session_id) {
            Transcript::Found(path) => match baseline(&path) {
                Ok(start) => (Location::File(path), start),
                Err(error) => {
                    tracing::debug!(%error, path = %path.display(), "Claude transcript baseline failed");
                    continue;
                }
            },
            Transcript::Absent => (
                Location::NotYet {
                    root: root.clone(),
                    session_id: session_id.to_owned(),
                },
                Baseline::default(),
            ),
            Transcript::Unknown => continue,
        };
        started.push((
            request.clone(),
            Tracked::new(generation, request.key.clone(), location, start),
        ));
    }
    // A PTY replaced during the lookup belongs to another process.
    let current = terminal_generations(state)?;
    let mut tracked = TRACKED.lock_or_err().map_err(|error| error.to_string())?;
    prune(&mut tracked, &current);
    for (request, entry) in started {
        if current.get(&request.terminal_id) != Some(&entry.generation) {
            continue;
        }
        let entries = tracked.entry(request.terminal_id.clone()).or_default();
        if entries.iter().any(|existing| existing.key == entry.key) {
            // A concurrent request recorded it first; keep that baseline.
            recorded.push(request);
            continue;
        }
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
    prune(&mut tracked, &generations);
    let mut results = Vec::new();
    for request in requests {
        let Some(entries) = tracked.get_mut(&request.terminal_id) else {
            continue;
        };
        let Some(index) = entries.iter().position(|entry| entry.key == request.key) else {
            continue;
        };
        let outcome = entries[index].outcome();
        if outcome != ClaudeTurnOutcome::Pending {
            // The frontend settles on this answer and never asks again.
            entries.remove(index);
        }
        results.push(ClaudeTurnResult {
            terminal_id: request.terminal_id.clone(),
            key: request.key.clone(),
            outcome,
        });
    }
    tracked.retain(|_, entries| !entries.is_empty());
    Ok(results)
}

/// Drop baselines of closed or replaced PTYs and of lookups the frontend
/// stopped making, across every terminal.
fn prune(tracked: &mut HashMap<String, Vec<Tracked>>, generations: &HashMap<String, u64>) {
    let now = Instant::now();
    tracked.retain(|id, entries| {
        entries.retain(|entry| {
            generations.get(id) == Some(&entry.generation) && !entry.abandoned(now)
        });
        !entries.is_empty()
    });
}

/// The transcript is `projects/<any>/<sessionId>.jsonl` under the config root
/// that attributed the session. Claude's directory naming is not derived.
fn find_transcript(root: &Path, session_id: &str) -> Transcript {
    let name = format!("{session_id}.jsonl");
    let entries = match std::fs::read_dir(root.join("projects")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Transcript::Absent,
        Err(_) => return Transcript::Unknown,
    };
    let mut found = None;
    for entry in entries {
        let Ok(entry) = entry else {
            return Transcript::Unknown;
        };
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            if found.is_some() {
                return Transcript::Unknown;
            }
            found = Some(candidate);
        }
    }
    found.map_or(Transcript::Absent, Transcript::Found)
}

#[derive(Debug, PartialEq, Eq)]
enum Transcript {
    Found(PathBuf),
    /// Every project directory was read and none holds the session yet.
    Absent,
    /// A directory could not be read or several files match.
    Unknown,
}

#[derive(Debug, Default)]
struct Baseline {
    offset: u64,
    partial: bool,
    anchor: Vec<u8>,
}

fn baseline(path: &Path) -> std::io::Result<Baseline> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(ANCHOR_LEN as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut anchor = Vec::new();
    file.take(len - start).read_to_end(&mut anchor)?;
    if anchor.len() as u64 != len - start {
        return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
    }
    Ok(Baseline {
        offset: len,
        partial: anchor.last().is_some_and(|&byte| byte != b'\n'),
        anchor,
    })
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
