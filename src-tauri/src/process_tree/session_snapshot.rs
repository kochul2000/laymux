//! Process ownership for display reads. Only a targeted observation may refresh
//! it; status-file polling never launches an OS enumeration (ADR-0362).
use super::ProcessEntry;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::wsl_probe::snapshot::GuestObservation;
use std::sync::Mutex;
use std::time::Instant;

type Context = Vec<(
    String,
    u64,
    u64,
    Option<u64>,
    bool,
    crate::agent_hooks::title::TitleBinding,
)>;
struct Entry {
    context: Context,
    started: Instant,
    tree: Vec<ProcessEntry>,
}

#[derive(Default)]
pub struct SessionProcessCache {
    gate: Mutex<()>,
    entry: Mutex<Option<Entry>>,
}

fn context(state: &AppState) -> Result<Context, String> {
    let epochs = crate::activity::detection_epochs(state);
    let terminals = state.terminals.lock_or_err()?;
    let handles = state.pty_handles.lock_or_err()?;
    let mut context: Context = handles
        .iter()
        .filter(|(_, h)| !h.is_wsl_backed())
        .filter_map(|(id, h)| {
            terminals.get(id).map(|s| {
                (
                    id.clone(),
                    h.terminal_generation(),
                    epochs.get(id).copied().unwrap_or(0),
                    s.last_command_at,
                    s.command_running,
                    s.codex_hook_title.clone(),
                )
            })
        })
        .collect();
    context.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(context)
}

pub(crate) fn read(
    state: &AppState,
    observation: GuestObservation,
) -> Result<Vec<ProcessEntry>, String> {
    read_with(state, observation, super::try_snapshot_processes)
}

fn read_with(
    state: &AppState,
    observation: GuestObservation,
    collect: impl FnOnce() -> Result<Vec<ProcessEntry>, String>,
) -> Result<Vec<ProcessEntry>, String> {
    let before = context(state)?;
    let pinned = !before.is_empty()
        && before.iter().all(|(id, generation, ..)| {
            crate::commands::cached_liveness(state, id, *generation).is_some()
        });
    let cache = &state.session_processes;
    // This isolated gate is entered only without AppState locks; it serializes
    // the three provider readers of one native observation.
    let _gate = cache.gate.lock_or_err()?;
    {
        let entry = cache.entry.lock_or_err()?;
        if let Some(entry) = entry.as_ref().filter(|e| e.context == before) {
            let usable = match observation {
                GuestObservation::Reusable => {
                    entry.started.elapsed() <= crate::constants::ACTIVITY_DISPLAY_RETENTION
                        || pinned
                }
                GuestObservation::StartedAfter(boundary) => entry.started >= boundary,
            };
            if usable {
                return Ok(entry.tree.clone());
            }
        }
    }
    if observation.is_reusable() {
        return Err("Native ownership awaits a targeted observation".into());
    }
    let started = Instant::now();
    let tree = collect()?;
    if before != context(state)? {
        return Err("Native ownership changed during observation".into());
    }
    *cache.entry.lock_or_err()? = Some(Entry {
        context: before,
        started,
        tree: tree.clone(),
    });
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn polling_cannot_start_an_enumeration_and_controls_require_their_own_boundary() {
        let state = AppState::new();
        let calls = Cell::new(0);
        let collect = || {
            calls.set(calls.get() + 1);
            Ok(Vec::new())
        };
        for _ in 0..10 {
            assert!(read_with(&state, GuestObservation::Reusable, collect).is_err());
        }
        assert_eq!(calls.get(), 0);
        let boundary = GuestObservation::starting_now();
        read_with(&state, boundary, collect).unwrap();
        for _ in 0..360 {
            read_with(&state, GuestObservation::Reusable, collect).unwrap();
        }
        assert_eq!(calls.get(), 1);
        read_with(&state, boundary, collect).unwrap();
        assert_eq!(calls.get(), 1);
        read_with(&state, GuestObservation::starting_now(), collect).unwrap();
        assert_eq!(calls.get(), 2);
    }
}
