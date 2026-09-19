mod reader;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

use reader::TurnReader;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnState {
    Running,
    Completed,
    Failed,
    Interrupted,
    Idle,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub state: TurnState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnSnapshot {
    generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selection_key: Option<String>,
    #[serde(flatten)]
    turn: Turn,
}

#[derive(PartialEq)]
struct Source {
    generation: u64,
    session_id: String,
    selection_key: String,
    path: Option<PathBuf>,
}

struct CacheEntry {
    source: Source,
    reader: TurnReader,
}

// Leaf lock: acquire only after provider I/O, release before any AppState lock.
// Entries are pruned on each lookup; no cache survives a lost attribution.
static READERS: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command(async)]
pub fn get_codex_turn_states(
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, CodexTurnSnapshot>, String> {
    get_codex_turn_states_impl(&state).map_err(|error| error.to_string())
}

pub(crate) fn get_codex_turn_states_impl(
    state: &AppState,
) -> Result<HashMap<String, CodexTurnSnapshot>, AppError> {
    let generations: HashMap<_, _> = state
        .pty_handles
        .lock_or_err()?
        .iter()
        .map(|(id, handle)| (id.clone(), handle.terminal_generation()))
        .collect();
    let mut sources = HashMap::new();
    let lookup = super::lookup_with_observer(None, state, |id, store, session| {
        let (Some(generation), Some(selection_key)) = (generations.get(id), &session.selection_key)
        else {
            return;
        };
        let path = if session.fresh {
            Ok(None)
        } else {
            store.rollout_path_checked(&session.id)
        };
        match path {
            Ok(path) if session.fresh || path.is_some() => {
                sources.insert(
                    id.to_owned(),
                    Source {
                        generation: *generation,
                        session_id: session.id.clone(),
                        selection_key: selection_key.clone(),
                        path,
                    },
                );
            }
            Err(error) => tracing::debug!(terminal_id = id, %error, "Codex turn path unavailable"),
            _ => {}
        }
    })?;
    sources.retain(|id, source| {
        !lookup.failed_terminal_ids.contains(id)
            && lookup.attributions.get(id).and_then(Option::as_ref) == Some(&source.session_id)
    });

    let mut snapshots = HashMap::new();
    {
        let mut readers = READERS.lock_or_err()?;
        readers.retain(|id, _| sources.contains_key(id));
        for (id, source) in sources {
            if readers.get(&id).is_none_or(|entry| entry.source != source) {
                readers.insert(
                    id.clone(),
                    CacheEntry {
                        source,
                        reader: TurnReader::default(),
                    },
                );
            }
            let Some(entry) = readers.get_mut(&id) else {
                continue;
            };
            let turn = match &entry.source.path {
                None => Turn {
                    state: TurnState::Idle,
                    turn_id: None,
                },
                Some(path) => match entry.reader.read(path) {
                    Ok(turn) => turn,
                    Err(error) => {
                        entry.reader = TurnReader::default();
                        tracing::debug!(terminal_id = id, %error, "Codex turn read unavailable");
                        Turn::default()
                    }
                },
            };
            snapshots.insert(
                id,
                CodexTurnSnapshot {
                    generation: entry.source.generation,
                    session_id: Some(entry.source.session_id.clone()),
                    selection_key: Some(entry.source.selection_key.clone()),
                    turn,
                },
            );
        }
    }
    let handles = state.pty_handles.lock_or_err()?;
    for (id, generation) in generations {
        if !lookup.attributions.contains_key(&id) {
            continue;
        }
        if handles
            .get(&id)
            .is_none_or(|handle| handle.terminal_generation() != generation)
        {
            snapshots.remove(&id);
            continue;
        }
        snapshots.entry(id).or_insert(CodexTurnSnapshot {
            generation,
            session_id: None,
            selection_key: None,
            turn: Turn::default(),
        });
    }
    Ok(snapshots)
}
