//! Join GUI structure to source-only observations before a session commit.
use crate::commands::{SessionAttributionState, TerminalSessionAttribution};
use crate::constants::{
    SESSION_LAST_CLAUDE, SESSION_LAST_CODEX, SESSION_LAST_CWD, SESSION_LAST_FRESH,
    SESSION_LAST_GROK, SESSION_RESTORE_FIELDS, TERMINAL_ID_PREFIX, TERMINAL_VIEW_TYPE,
};
use crate::error::AppError;
use crate::local_state::{AttributionCoverage, LocalSessionSnapshot};
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use serde_json::Value;
use std::collections::HashMap;

pub(super) struct Observation {
    pub generations: HashMap<String, u64>,
    input_revisions: HashMap<String, u64>,
    hint_revision: u64,
    cwds: HashMap<String, String>,
    profiles: HashMap<String, String>,
    default_profile: String,
    verdicts: HashMap<String, TerminalSessionAttribution>,
    failed: bool,
}
impl Observation {
    pub(super) fn collect(state: &AppState, default_profile: String) -> Result<Self, AppError> {
        let hint_revision = state.session_checkpoint.hints.revision();
        let input_revisions = state
            .pty_handles
            .lock_or_err()?
            .iter()
            .map(|(id, handle)| (id.clone(), handle.checkpoint_input_revision()))
            .collect();
        let (verdicts, failed) = match crate::commands::get_terminal_session_attributions_impl(
            None, None, None, state,
        ) {
            Ok(verdicts) => (verdicts, false),
            Err(error) => {
                tracing::warn!(%error, "source session attribution remains unknown");
                (HashMap::new(), true)
            }
        };
        let terminals = state.terminals.lock_or_err()?;
        let generations = state
            .pty_handles
            .lock_or_err()?
            .iter()
            .map(|(id, handle)| (id.clone(), handle.terminal_generation()))
            .collect();
        let cwds = terminals
            .iter()
            .filter_map(|(id, session)| session.cwd.as_ref().map(|cwd| (id.clone(), cwd.clone())))
            .collect();
        let profiles = terminals
            .iter()
            .map(|(id, session)| (id.clone(), session.config.profile.clone()))
            .collect();
        Ok(Self {
            generations,
            input_revisions,
            hint_revision,
            cwds,
            profiles,
            default_profile,
            verdicts,
            failed,
        })
    }
    pub(super) fn validate(
        &self,
        state: &AppState,
        submitted: Option<&LocalSessionSnapshot>,
    ) -> Result<(), AppError> {
        let handles = state.pty_handles.lock_or_err()?;
        if state.session_checkpoint.hints.revision() != self.hint_revision
            || handles.iter().any(|(id, handle)| {
                self.input_revisions.get(id) != Some(&handle.checkpoint_input_revision())
            })
        {
            return Err(AppError::Other(
                "source identity changed during session observation".into(),
            ));
        }
        if handles.len() != self.generations.len() {
            return Err(AppError::Other(
                "source catalog changed during session observation".into(),
            ));
        }
        for coverage in submitted
            .into_iter()
            .flat_map(|snapshot| &snapshot.coverage)
        {
            if let Some(expected) = coverage.generation {
                if handles
                    .get(&coverage.terminal_id)
                    .map(|handle| handle.terminal_generation())
                    != Some(expected)
                {
                    return Err(AppError::Other(
                        "submitted source generation expired".into(),
                    ));
                }
            }
        }
        for (id, generation) in &self.generations {
            if handles.get(id).map(|handle| handle.terminal_generation()) != Some(*generation) {
                return Err(AppError::Other(
                    "source generation changed during session observation".into(),
                ));
            }
        }
        Ok(())
    }
    pub(super) fn project(
        &self,
        mut submitted: LocalSessionSnapshot,
        previous: Option<&LocalSessionSnapshot>,
    ) -> Result<LocalSessionSnapshot, AppError> {
        let old: HashMap<_, _> = previous
            .map(crate::local_state::content_views)
            .transpose()?
            .unwrap_or_default()
            .into_iter()
            .collect();
        let mut value = serde_json::to_value(&submitted)?;
        let mut coverage = Vec::new();
        crate::local_state::for_each_view(&mut value, |id, view| {
            let fields = view
                .as_object_mut()
                .ok_or_else(|| AppError::Other("pane view metadata must be an object".into()))?;
            if fields.get("type").and_then(Value::as_str) != Some(TERMINAL_VIEW_TYPE) {
                return Ok(());
            }
            let terminal_id = format!("{TERMINAL_ID_PREFIX}{id}");
            let profile_matches = fields
                .get("profile")
                .and_then(Value::as_str)
                .filter(|profile| !profile.is_empty())
                .or(Some(self.default_profile.as_str()))
                == self.profiles.get(&terminal_id).map(String::as_str);
            for field in SESSION_RESTORE_FIELDS {
                fields.remove(*field);
            }
            fields.remove(SESSION_LAST_CWD);
            if let Some(cwd) = self.cwds.get(&terminal_id).filter(|_| profile_matches) {
                fields.insert(SESSION_LAST_CWD.into(), Value::String(cwd.clone()));
            } else if let Some(cwd) = old
                .get(id)
                .filter(|prior| {
                    prior.get("profile") == fields.get("profile")
                        && prior.get("configDir") == fields.get("configDir")
                })
                .and_then(|prior| prior.get(SESSION_LAST_CWD))
            {
                fields.insert(SESSION_LAST_CWD.into(), cwd.clone());
            }
            let verdict = self.verdicts.get(&terminal_id).filter(|verdict| {
                profile_matches && self.generations.get(&terminal_id) == Some(&verdict.generation)
            });
            let state = verdict
                .map(|verdict| verdict.state.clone())
                .unwrap_or(SessionAttributionState::Unknown);
            let provider = verdict.and_then(|verdict| verdict.provider);
            let session_id = verdict.and_then(|verdict| verdict.session_id.clone());
            if matches!(
                state,
                SessionAttributionState::Identified | SessionAttributionState::RestorePending
            ) {
                if let (Some(field), Some(id)) = (
                    match provider {
                        Some("codex") => Some(SESSION_LAST_CODEX),
                        Some("claude") => Some(SESSION_LAST_CLAUDE),
                        Some("grok") => Some(SESSION_LAST_GROK),
                        _ => None,
                    },
                    session_id.as_ref(),
                ) {
                    fields.insert(field.into(), Value::String(id.clone()));
                }
            } else if matches!(state, SessionAttributionState::Fresh) {
                if let Some(provider) = provider {
                    fields.insert(SESSION_LAST_FRESH.into(), Value::String(provider.into()));
                }
            }
            let encoded_state = serde_json::to_value(&state)?;
            coverage.push(AttributionCoverage {
                generation: self.generations.get(&terminal_id).copied(),
                terminal_id,
                state: encoded_state
                    .as_str()
                    .ok_or_else(|| AppError::Other("invalid source attribution state".into()))?
                    .into(),
                provider: provider.map(str::to_owned),
                session_id,
            });
            Ok(())
        })?;
        submitted = serde_json::from_value(value)?;
        submitted.coverage = coverage;
        submitted.attribution_lookup_failed = self.failed;
        submitted.cwd_lookup_failed = false;
        Ok(submitted)
    }
}
