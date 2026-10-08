use crate::lock_ext::MutexExt;
use crate::state::AppState;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Renderer retirement and source destruction are different lifecycle actions.
#[tauri::command]
pub async fn release_terminal_surface(
    id: String,
    generation: Option<u64>,
    preserve_source: bool,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let state = state.inner().clone();
    let _permit = if preserve_source && state.daemon.get().is_some()
        || state.session_checkpoint.close_cleanup_allowed()
    {
        None
    } else {
        Some(
            state
                .session_checkpoint
                .begin_mutation_after_finalization()
                .await,
        )
    };
    let worker_state = state.clone();
    tokio::task::spawn_blocking(move || {
        let state = worker_state;
        // A late renderer cleanup must never resolve a replacement by id.
        if let Some(expected) = generation {
            if state
                .pty_handles
                .lock_or_err()?
                .get(&id)
                .map(|handle| handle.terminal_generation())
                != Some(expected)
            {
                return Ok(());
            }
        }
        if preserve_source && state.daemon.get().is_some() {
            super::terminal::release_terminal_surface_inner(&id, generation, &state, &app)
        } else {
            super::terminal::close_terminal_generation_inner(&id, generation, &state, &app)
        }
    })
    .await
    .map_err(|_| "terminal surface release worker failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_surface_release_cannot_remove_a_replacement_delivery() {
        let state = AppState::new();
        let id = "terminal-replacement";
        let handle = crate::pty::PtyHandle::from_external(
            7,
            Arc::new(|_, _, _, _| panic!("renderer cleanup must not write to source")),
        )
        .unwrap();
        handle.bind_delivery_generation(42);
        state.terminals.lock().unwrap().insert(
            id.into(),
            crate::terminal::TerminalSession::new(id.into(), Default::default()),
        );
        state.pty_handles.lock().unwrap().insert(id.into(), handle);
        let emitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = emitted.clone();
        let events = crate::terminal_events::TerminalEvents::new(move |_, _| {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        });
        super::super::terminal::release_terminal_surface_inner(id, Some(41), &state, &events)
            .unwrap();
        super::super::terminal::close_terminal_generation_inner(id, Some(41), &state, &events)
            .unwrap();
        assert!(state.terminals.lock().unwrap().contains_key(id));
        assert_eq!(
            state
                .pty_handles
                .lock()
                .unwrap()
                .get(id)
                .unwrap()
                .terminal_generation(),
            42
        );
        assert_eq!(emitted.load(std::sync::atomic::Ordering::Relaxed), 0);
        super::super::terminal::release_terminal_surface_inner(id, Some(42), &state, &events)
            .unwrap();
        assert!(!state.terminals.lock().unwrap().contains_key(id));
        assert!(!state.pty_handles.lock().unwrap().contains_key(id));
        assert_eq!(emitted.load(std::sync::atomic::Ordering::Relaxed), 1);
    }
}
