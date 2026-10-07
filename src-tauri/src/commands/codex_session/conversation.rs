//! Current conversation evidence shared by ordinary and final checkpoints.
use super::store::{CodexSessionStore, ResolvedSession};
use crate::agent_hooks::title::TitleBinding;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use std::collections::HashMap;

#[derive(PartialEq, Eq)]
struct Observation {
    generation: u64,
    title: Option<TitleBinding>,
    resume_id: Option<String>,
}

impl Observation {
    fn capture(
        handle: &crate::pty::PtyHandle,
        terminal: Option<&crate::terminal::TerminalSession>,
    ) -> Self {
        Self {
            generation: handle.terminal_generation(),
            title: terminal.map(|t| t.codex_hook_title.clone()),
            resume_id: handle
                .session_restore_request()
                .filter(|(provider, _)| *provider == "codex")
                .map(|(_, id)| id.to_owned()),
        }
    }
}

pub(super) struct ConversationLookup<'a> {
    state: &'a AppState,
    enabled: bool,
    before: HashMap<String, Observation>,
}

impl<'a> ConversationLookup<'a> {
    pub(super) fn remember_checkpoint(
        &self,
        terminal: &str,
        store: &CodexSessionStore,
        session: &ResolvedSession,
    ) {
        if session.fresh
            || self
                .state
                .session_checkpoint
                .receipts
                .lock_or_err()
                .is_ok_and(|r| !r.collecting())
        {
            return;
        }
        let Some(before) = self.before.get(terminal) else {
            return;
        };
        if let Ok(Some(path)) = store.rollout_path_checked(&session.id) {
            crate::session_checkpoint::receipt::remember_codex_file(
                self.state,
                terminal,
                before.generation,
                &session.id,
                &path,
            );
        }
    }
    pub(super) fn new(state: &'a AppState, enabled: bool) -> Result<Self, String> {
        let terminals = state.terminals.lock_or_err()?;
        let handles = state.pty_handles.lock_or_err()?;
        let before = handles
            .iter()
            .map(|(id, handle)| (id.clone(), Observation::capture(handle, terminals.get(id))))
            .collect();
        Ok(Self {
            state,
            enabled,
            before,
        })
    }

    pub(super) fn resolve(
        &self,
        terminal: &str,
        store: &CodexSessionStore,
        distro: Option<&str>,
        selected: Option<ResolvedSession>,
    ) -> Result<Option<ResolvedSession>, String> {
        if !self.enabled {
            return Ok(selected);
        }
        self.require_unchanged(terminal)?;
        let before = self
            .before
            .get(terminal)
            .ok_or("Codex terminal disappeared")?;
        let identity = before
            .title
            .as_ref()
            .filter(|title| title.generation == before.generation)
            .and_then(|title| title.identity.as_deref());
        let Some(identity) = identity else {
            if selected.is_none() && before.resume_id.is_some() {
                return Err("Codex resume is awaiting its current live title".into());
            }
            return Ok(selected);
        };
        if let Some(session) = selected {
            if !session.id.starts_with(identity) {
                return Err(
                    "Codex live title conflicts with the current process conversation".into(),
                );
            }
            return Ok(Some(session));
        }
        let hook_id = self.hook_id(identity, store, distro)?;
        let resumed = before.resume_id.as_ref().filter(|id| {
            id.starts_with(identity)
                && uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == **id)
        });
        let Some(id) = hook_id.as_ref().or(resumed) else {
            return Ok(None);
        };
        // A hook can arrive before rollout creation, or the user can delete a
        // saved conversation. Neither proves an empty, safe-to-replace thread.
        if store.verify_status_session(id)? {
            return Err("Codex current conversation has no resumable rollout yet".into());
        }
        self.require_unchanged(terminal)?;
        if hook_id.is_some()
            && self.hook_id(identity, store, distro)?.as_deref() != Some(id.as_str())
        {
            return Err("Codex hook conversation changed during attribution".into());
        }
        Ok(Some(ResolvedSession {
            id: id.clone(),
            fresh: false,
            selection_key: None,
        }))
    }

    fn hook_id(
        &self,
        identity: &str,
        store: &CodexSessionStore,
        distro: Option<&str>,
    ) -> Result<Option<String>, String> {
        let registry = self.state.agent_hook_observations.lock_or_err()?;
        Ok(registry
            .codex_conversation(identity, distro)
            .filter(|o| o.event.agent_id.is_none())
            .filter(|o| {
                o.event.config_dir.as_deref().is_some_and(|root| {
                    std::path::Path::new(&crate::path_utils::resolve_path_for_windows(root, distro))
                        == store.codex_home()
                })
            })
            .map(|o| o.event.session_id.clone()))
    }

    fn require_unchanged(&self, id: &str) -> Result<(), String> {
        let terminals = self.state.terminals.lock_or_err()?;
        let handles = self.state.pty_handles.lock_or_err()?;
        let current = handles
            .get(id)
            .map(|h| Observation::capture(h, terminals.get(id)));
        if current.as_ref() != self.before.get(id) || current.is_none() {
            return Err(
                "Codex terminal generation or live title changed during attribution".into(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
