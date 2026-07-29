use std::collections::HashSet;

use super::boundary::GeometryBoundaryTracker;
use super::types::*;

struct ActiveTransaction {
    request: GeometryPrepareRequest,
    token: GeometryTransactionToken,
    boundary_seq: u64,
    prefix_acks: HashSet<String>,
    adoption_acks: HashSet<String>,
}

impl ActiveTransaction {
    fn status(&self, outcome: GeometryTransactionOutcome) -> GeometryTransactionStatus {
        let geometry = matches!(
            outcome,
            GeometryTransactionOutcome::AppliedAwaitingAdoption
                | GeometryTransactionOutcome::Released
        )
        .then_some(self.request.proposed_geometry);
        GeometryTransactionStatus {
            token: Some(self.token),
            outcome,
            boundary_seq: Some(self.boundary_seq),
            geometry,
        }
    }

    fn participant(&self, id: &str) -> Result<&GeometryParticipant, GeometryTransactionError> {
        self.request
            .participants
            .iter()
            .find(|participant| participant.id == id)
            .ok_or(GeometryTransactionError::UnknownParticipant)
    }

    fn quorum_complete(&self, acknowledgements: &HashSet<String>) -> bool {
        self.request
            .participants
            .iter()
            .all(|participant| acknowledgements.contains(&participant.id))
    }
}

pub struct PtyGeometryCoordinator<A> {
    adapter: A,
    phase: GeometryTransactionPhase,
    next_nonce: u64,
    active: Option<ActiveTransaction>,
    last_status: Option<GeometryTransactionStatus>,
    boundary_tracker: GeometryBoundaryTracker,
}

impl<A: PtyGeometryProvenanceAdapter> PtyGeometryCoordinator<A> {
    pub fn new(adapter: A) -> Self {
        Self {
            adapter,
            phase: GeometryTransactionPhase::Idle,
            next_nonce: 0,
            active: None,
            last_status: None,
            boundary_tracker: GeometryBoundaryTracker::default(),
        }
    }

    pub fn adapter(&self) -> &A {
        &self.adapter
    }

    pub fn phase(&self) -> GeometryTransactionPhase {
        self.phase
    }

    pub fn observe_old_output(&mut self, data: &[u8]) {
        self.boundary_tracker.feed(data);
    }

    pub fn prepare(
        &mut self,
        request: GeometryPrepareRequest,
        mut on_old_output: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        if !self.adapter.capability().supports_exact() {
            return Err(GeometryTransactionError::Unsupported);
        }
        if self.phase == GeometryTransactionPhase::Retired {
            return Err(GeometryTransactionError::WrongPhase);
        }
        if self.active.is_some() {
            return Err(GeometryTransactionError::Busy);
        }
        validate_request(&request)?;

        self.next_nonce = self.next_nonce.wrapping_add(1).max(1);
        let token = GeometryTransactionToken {
            generation: request.generation,
            owner_epoch: request.owner_epoch,
            nonce: self.next_nonce,
        };
        self.phase = GeometryTransactionPhase::Preparing;
        let tracker = &mut self.boundary_tracker;
        let mut delivered_boundary = request.source_seq;
        let mut callback = |chunk: &[u8]| {
            on_old_output(chunk)?;
            tracker.feed(chunk);
            delivered_boundary = delivered_boundary
                .checked_add(
                    u64::try_from(chunk.len())
                        .map_err(|_| "PTY source sequence overflow".to_string())?,
                )
                .ok_or_else(|| "PTY source sequence overflow".to_string())?;
            Ok(())
        };
        let boundary_seq = match self
            .adapter
            .freeze_and_drain(request.source_seq, &mut callback)
        {
            Ok(boundary_seq) => boundary_seq,
            Err(_error) => {
                let transaction = ActiveTransaction {
                    request,
                    token,
                    boundary_seq: delivered_boundary,
                    prefix_acks: HashSet::new(),
                    adoption_acks: HashSet::new(),
                };
                return match self.adapter.abort_prepared() {
                    Ok(()) => {
                        self.phase = GeometryTransactionPhase::Idle;
                        let status = transaction.status(GeometryTransactionOutcome::NotApplied);
                        self.last_status = Some(status.clone());
                        Ok(status)
                    }
                    Err(_abort_error) => {
                        self.phase = GeometryTransactionPhase::Indeterminate;
                        let status = transaction.status(GeometryTransactionOutcome::Indeterminate);
                        self.active = Some(transaction);
                        Ok(status)
                    }
                };
            }
        };
        if boundary_seq != delivered_boundary {
            let transaction = ActiveTransaction {
                request,
                token,
                boundary_seq: delivered_boundary,
                prefix_acks: HashSet::new(),
                adoption_acks: HashSet::new(),
            };
            return match self.adapter.abort_prepared() {
                Ok(()) => {
                    self.phase = GeometryTransactionPhase::Idle;
                    Err(GeometryTransactionError::AdapterFailure(
                        "adapter boundary does not match the delivered old prefix".into(),
                    ))
                }
                Err(_abort_error) => {
                    self.phase = GeometryTransactionPhase::Indeterminate;
                    let status = transaction.status(GeometryTransactionOutcome::Indeterminate);
                    self.active = Some(transaction);
                    Ok(status)
                }
            };
        }

        let transaction = ActiveTransaction {
            request,
            token,
            boundary_seq,
            prefix_acks: HashSet::new(),
            adoption_acks: HashSet::new(),
        };
        if !self.boundary_tracker.is_neutral() {
            return match self.adapter.abort_prepared() {
                Ok(()) => {
                    self.phase = GeometryTransactionPhase::Idle;
                    let status = transaction.status(GeometryTransactionOutcome::NotApplied);
                    self.last_status = Some(status.clone());
                    Ok(status)
                }
                Err(_abort_error) => {
                    self.phase = GeometryTransactionPhase::Indeterminate;
                    let status = transaction.status(GeometryTransactionOutcome::Indeterminate);
                    self.active = Some(transaction);
                    Ok(status)
                }
            };
        }

        self.phase = GeometryTransactionPhase::Prepared;
        let status = transaction.status(GeometryTransactionOutcome::Prepared);
        self.active = Some(transaction);
        Ok(status)
    }

    pub fn ack_old_prefix(
        &mut self,
        token: GeometryTransactionToken,
        participant_id: &str,
        source_seq: u64,
    ) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        if self.phase != GeometryTransactionPhase::Prepared {
            return Err(GeometryTransactionError::WrongPhase);
        }
        let transaction = self.active_for_token_mut(token)?;
        transaction.participant(participant_id)?;
        if source_seq != transaction.boundary_seq {
            return Err(GeometryTransactionError::SourceSequenceMismatch);
        }
        transaction.prefix_acks.insert(participant_id.into());
        Ok(transaction.status(GeometryTransactionOutcome::Prepared))
    }

    pub fn apply(
        &mut self,
        token: GeometryTransactionToken,
    ) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        if self.phase == GeometryTransactionPhase::AppliedAwaitingAdoption {
            let transaction = self.active_for_token(token)?;
            return Ok(transaction.status(GeometryTransactionOutcome::AppliedAwaitingAdoption));
        }
        if self.phase == GeometryTransactionPhase::Indeterminate {
            let transaction = self.active_for_token(token)?;
            return Ok(transaction.status(GeometryTransactionOutcome::Indeterminate));
        }
        if self.phase != GeometryTransactionPhase::Prepared {
            return self.status(token);
        }
        let transaction = self.active_for_token(token)?;
        if !transaction.quorum_complete(&transaction.prefix_acks) {
            return Err(GeometryTransactionError::MissingParticipantAcknowledgement);
        }
        let proposed = transaction.request.proposed_geometry;
        self.phase = GeometryTransactionPhase::Applying;
        match self.adapter.apply_resize(proposed) {
            PhysicalResizeOutcome::Applied => {
                self.phase = GeometryTransactionPhase::AppliedAwaitingAdoption;
                Ok(self
                    .active_for_token(token)?
                    .status(GeometryTransactionOutcome::AppliedAwaitingAdoption))
            }
            PhysicalResizeOutcome::NotApplied => match self.adapter.abort_prepared() {
                Ok(()) => self.complete_current(GeometryTransactionOutcome::NotApplied),
                Err(_error) => {
                    self.phase = GeometryTransactionPhase::Indeterminate;
                    Ok(self
                        .active_for_token(token)?
                        .status(GeometryTransactionOutcome::Indeterminate))
                }
            },
            PhysicalResizeOutcome::Indeterminate => {
                self.phase = GeometryTransactionPhase::Indeterminate;
                Ok(self
                    .active_for_token(token)?
                    .status(GeometryTransactionOutcome::Indeterminate))
            }
        }
    }

    pub fn ack_adoption(
        &mut self,
        token: GeometryTransactionToken,
        participant_id: &str,
        revision: u64,
    ) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        if let Some(status) = self.last_for_token(token) {
            if status.outcome == GeometryTransactionOutcome::Released {
                return Ok(status);
            }
        }
        if self.phase != GeometryTransactionPhase::AppliedAwaitingAdoption {
            return Err(GeometryTransactionError::WrongPhase);
        }
        let transaction = self.active_for_token_mut(token)?;
        transaction.participant(participant_id)?;
        if revision != transaction.request.proposed_geometry.revision {
            return Err(GeometryTransactionError::GeometryRevisionMismatch);
        }
        transaction.adoption_acks.insert(participant_id.into());
        if !transaction.quorum_complete(&transaction.adoption_acks) {
            return Ok(transaction.status(GeometryTransactionOutcome::AppliedAwaitingAdoption));
        }
        if let Err(error) = self.adapter.release() {
            self.phase = GeometryTransactionPhase::Indeterminate;
            return Err(GeometryTransactionError::AdapterFailure(error));
        }
        self.complete_current(GeometryTransactionOutcome::Released)
    }

    pub fn status(
        &self,
        token: GeometryTransactionToken,
    ) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        if let Some(transaction) = self.active.as_ref() {
            if transaction.token == token {
                let outcome = match self.phase {
                    GeometryTransactionPhase::Prepared => GeometryTransactionOutcome::Prepared,
                    GeometryTransactionPhase::AppliedAwaitingAdoption => {
                        GeometryTransactionOutcome::AppliedAwaitingAdoption
                    }
                    GeometryTransactionPhase::Indeterminate => {
                        GeometryTransactionOutcome::Indeterminate
                    }
                    _ => return Err(GeometryTransactionError::WrongPhase),
                };
                return Ok(transaction.status(outcome));
            }
        }
        self.last_for_token(token)
            .ok_or(GeometryTransactionError::TokenMismatch)
    }

    /// Caller deadline changes only the waiter. It never releases the owner
    /// publication barrier or mutates participant quorum.
    pub fn request_waiter_timed_out(
        &self,
        token: GeometryTransactionToken,
    ) -> Result<(), GeometryTransactionError> {
        self.status(token).map(|_| ())
    }

    pub fn retire(&mut self) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        self.adapter
            .teardown()
            .map_err(GeometryTransactionError::AdapterFailure)?;
        let token = self
            .active
            .as_ref()
            .map(|transaction| transaction.token)
            .or_else(|| self.last_status.as_ref().and_then(|status| status.token));
        let status = GeometryTransactionStatus {
            token,
            outcome: GeometryTransactionOutcome::Retired,
            boundary_seq: self
                .active
                .as_ref()
                .map(|transaction| transaction.boundary_seq),
            geometry: None,
        };
        self.active = None;
        self.phase = GeometryTransactionPhase::Retired;
        self.last_status = Some(status.clone());
        Ok(status)
    }

    fn active_for_token(
        &self,
        token: GeometryTransactionToken,
    ) -> Result<&ActiveTransaction, GeometryTransactionError> {
        self.active
            .as_ref()
            .filter(|transaction| transaction.token == token)
            .ok_or(GeometryTransactionError::TokenMismatch)
    }

    fn active_for_token_mut(
        &mut self,
        token: GeometryTransactionToken,
    ) -> Result<&mut ActiveTransaction, GeometryTransactionError> {
        self.active
            .as_mut()
            .filter(|transaction| transaction.token == token)
            .ok_or(GeometryTransactionError::TokenMismatch)
    }

    fn last_for_token(&self, token: GeometryTransactionToken) -> Option<GeometryTransactionStatus> {
        self.last_status
            .as_ref()
            .filter(|status| status.token == Some(token))
            .cloned()
    }

    fn complete_current(
        &mut self,
        outcome: GeometryTransactionOutcome,
    ) -> Result<GeometryTransactionStatus, GeometryTransactionError> {
        let transaction = self
            .active
            .take()
            .ok_or(GeometryTransactionError::WrongPhase)?;
        let status = transaction.status(outcome);
        self.phase = GeometryTransactionPhase::Idle;
        self.last_status = Some(status.clone());
        Ok(status)
    }
}

fn validate_request(request: &GeometryPrepareRequest) -> Result<(), GeometryTransactionError> {
    if request.proposed_geometry.revision != request.old_geometry.revision.wrapping_add(1) {
        return Err(GeometryTransactionError::InvalidGeometryRevision);
    }
    let mut ids = HashSet::new();
    let mut roles = HashSet::new();
    for participant in &request.participants {
        if participant.id.is_empty()
            || !ids.insert(participant.id.as_str())
            || !roles.insert(participant.role)
        {
            return Err(GeometryTransactionError::InvalidParticipants);
        }
    }
    let expected = match request.owner_kind {
        GeometryOwnerKind::Local => HashSet::from([
            GeometryParticipantRole::PcVisible,
            GeometryParticipantRole::RendererCheckpoint,
        ]),
        GeometryOwnerKind::Remote => HashSet::from([
            GeometryParticipantRole::RemoteBrowser,
            GeometryParticipantRole::RendererCheckpoint,
        ]),
    };
    if roles != expected {
        return Err(GeometryTransactionError::InvalidParticipants);
    }
    Ok(())
}
