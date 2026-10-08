//! Source-owned session persistence; GUI structure is a submission, not evidence.
use super::auth::AttachmentStamp;
use super::session_projection::Observation;
use crate::constants::SESSION_ATTRIBUTION_UNKNOWN;
use crate::error::AppError;
use crate::local_state::{CheckpointCommit, LocalSessionSnapshot, LocalStateStore};
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use std::sync::Mutex;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Ticket {
    epoch: u64,
    revision: u64,
}
struct WriterState {
    requested: Option<Ticket>,
    pending: Option<Ticket>,
    accepted: Option<Ticket>,
    structure: Option<LocalSessionSnapshot>,
    database_revision: u64,
    error: Option<String>,
}
pub(super) struct SessionWriter {
    store: LocalStateStore,
    state: Mutex<WriterState>,
}
impl SessionWriter {
    pub(super) fn store(&self) -> LocalStateStore {
        self.store.clone()
    }
    pub(super) fn new(store: LocalStateStore) -> Result<Self, AppError> {
        let structure = store.load_session()?;
        let database_revision = store.revision()?.0;
        Ok(Self {
            store,
            state: Mutex::new(WriterState {
                requested: None,
                pending: None,
                accepted: None,
                structure,
                database_revision,
                error: None,
            }),
        })
    }
    pub(super) fn load(&self) -> Result<Option<LocalSessionSnapshot>, AppError> {
        self.store.load_session()
    }
    pub(super) fn reserve(
        &self,
        stamp: &AttachmentStamp,
        revision: u64,
    ) -> Result<Ticket, AppError> {
        let mut state = self.state.lock_or_err()?;
        let ticket = Ticket {
            epoch: stamp.epoch,
            revision,
        };
        if revision == 0
            || state.requested.is_some_and(|prior| {
                (ticket.epoch, ticket.revision) <= (prior.epoch, prior.revision)
            })
        {
            return Err(AppError::Other(
                "stale daemon structure revision rejected".into(),
            ));
        }
        state.requested = Some(ticket);
        state.pending = Some(ticket);
        Ok(ticket)
    }
    pub(super) fn finish(&self, ticket: Ticket, error: Option<String>) {
        if let Ok(mut state) = self.state.lock_or_err() {
            if state.pending == Some(ticket) {
                state.pending = None;
                state.error = error;
            }
        }
    }
    pub(super) fn commit(
        &self,
        source: &AppState,
        ticket: Ticket,
        snapshot: LocalSessionSnapshot,
        observed: Observation,
    ) -> Result<CheckpointCommit, AppError> {
        let mut state = self.state.lock_or_err()?;
        if state.pending != Some(ticket) || state.requested != Some(ticket) {
            return Err(AppError::Other(
                "daemon structure submission was superseded".into(),
            ));
        }
        observed.validate(source, Some(&snapshot))?;
        let projected = observed.project(snapshot, state.structure.as_ref())?;
        let commit = self.store.commit_session(&projected)?;
        state.structure = Some(commit.snapshot.clone());
        state.database_revision = commit.revision;
        state.accepted = Some(ticket);
        state.error = None;
        Ok(commit)
    }
    pub(super) fn background_base(
        &self,
    ) -> Result<Option<(Option<Ticket>, LocalSessionSnapshot)>, AppError> {
        let state = self.state.lock_or_err()?;
        Ok(if state.pending.is_none() {
            state
                .structure
                .clone()
                .map(|snapshot| (state.accepted, snapshot))
        } else {
            None
        })
    }
    pub(super) fn refresh(
        &self,
        source: &AppState,
        version: Option<Ticket>,
        snapshot: LocalSessionSnapshot,
        observed: Observation,
    ) -> Result<bool, AppError> {
        let mut state = self.state.lock_or_err()?;
        if state.pending.is_some() || state.accepted != version {
            return Ok(false);
        }
        observed.validate(source, None)?;
        let mut projected = observed.project(snapshot, state.structure.as_ref())?;
        if let Some(previous) = &state.structure {
            crate::local_state::preserve_unknown(previous, &mut projected)?;
        }
        if state
            .structure
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?
            .as_ref()
            == Some(&serde_json::to_value(&projected)?)
        {
            return Ok(!projected.attribution_lookup_failed
                && projected
                    .coverage
                    .iter()
                    .all(|coverage| coverage.state != SESSION_ATTRIBUTION_UNKNOWN));
        }
        let commit = self.store.commit_session(&projected)?;
        state.structure = Some(commit.snapshot);
        state.database_revision = commit.revision;
        state.error = None;
        Ok(!commit.needs_retry)
    }
    pub(super) fn diagnostics(&self) -> Result<serde_json::Value, AppError> {
        let state = self.state.lock_or_err()?;
        Ok(
            serde_json::json!({"structureRevision":state.accepted.map(|ticket|ticket.revision),
            "structureEpoch":state.accepted.map(|ticket|ticket.epoch),"databaseRevision":state.database_revision,
            "pending":state.pending.is_some(),"error":state.error}),
        )
    }
    pub(super) fn background_error(&self, error: &AppError) {
        if let Ok(mut state) = self.state.lock_or_err() {
            if state.pending.is_none() {
                state.error = Some(error.to_string());
            }
        }
    }
}
