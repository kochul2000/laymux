use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fmt;
use std::hash::BuildHasher;
use std::thread;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::Response;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::constants::{
    EVENT_REMOTE_CONTROL_CHANGED, MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS, PTY_CONTROL_JOB_TIMEOUT_MS,
    PTY_CONTROL_WAIT_POLL_MS, REMOTE_OWNER_TRANSITION_TIMEOUT_MS,
};
use crate::lock_ext::MutexExt;
use crate::pty_control::PtyControlCompletion;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

use super::access::effective_remote_settings;
use super::{internal_error, json_error};

/// Internal controller lease for Direct Remote Mode.
#[derive(Debug, Clone)]
pub struct RemoteControlLease {
    pub lease_id: String,
    pub remote_addr: String,
    pub client_name: Option<String>,
    pub last_heartbeat: Instant,
}

#[derive(Debug, Default)]
pub struct RemoteControlState {
    pub lease: Option<RemoteControlLease>,
    pub reclaim_lockout_until: Option<Instant>,
    /// Monotonic generation for the process-global human controller owner.
    pub owner_epoch: u64,
    pub transitioning: bool,
    next_operation_id: u64,
    active_operations: HashMap<u64, HumanControlOperation>,
    lease_lifecycle: Option<RemoteLeaseLifecycle>,
    claim_reservation: Option<ClaimReservation>,
    claim_token_hasher: ClaimTokenHasher,
    transition_deadline: Option<Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteLeasePhase {
    Active,
    Expiring,
}

#[derive(Debug, Clone)]
struct RemoteLeaseLifecycle {
    lease_id: String,
    deadline: Instant,
    phase: RemoteLeasePhase,
}

#[derive(Debug, Clone)]
struct ClaimReservation {
    token_hash: [u64; 2],
    owner_epoch: u64,
    expires_at: Instant,
}

#[derive(Clone, Default)]
struct ClaimTokenHasher {
    first: RandomState,
    second: RandomState,
}

impl fmt::Debug for ClaimTokenHasher {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ClaimTokenHasher(<process-random>)")
    }
}

impl ClaimTokenHasher {
    fn hash(&self, token: &str) -> [u64; 2] {
        [self.first.hash_one(token), self.second.hash_one(token)]
    }
}

fn token_hashes_equal(left: [u64; 2], right: [u64; 2]) -> bool {
    // Do not short-circuit either half. The token itself is a random UUID and
    // the two SipHash keys are process-random; only the digest is retained.
    ((left[0] ^ right[0]) | (left[1] ^ right[1])) == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimReservationAttempt {
    NoReservation,
    Busy { remaining: Duration },
    Consumed,
    Rejected { remaining: Option<Duration> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HumanControlOrigin {
    Local,
    Remote { lease_id: String },
}

#[derive(Clone)]
struct HumanControlOperation {
    owner_epoch: u64,
    origin: HumanControlOrigin,
    terminal_id: String,
    /// True only after the PTY job has been placed on the terminal FIFO while
    /// holding the owner gate. Before that point an owner transition may
    /// detach the operation immediately: no physical I/O can have started.
    pty_enqueued: bool,
    completion: Option<PtyControlCompletion>,
}

impl fmt::Debug for HumanControlOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HumanControlOperation")
            .field("owner_epoch", &self.owner_epoch)
            .field("origin", &self.origin)
            .field("terminal_id", &self.terminal_id)
            .field("pty_enqueued", &self.pty_enqueued)
            .field(
                "completion_pending",
                &self
                    .completion
                    .as_ref()
                    .is_some_and(|completion| !completion.is_complete()),
            )
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RemoteOwnerTransition {
    epoch: u64,
    deadline: Instant,
}

/// Registered owner operation. Claim cannot succeed while a local permit is
/// alive, closing the frontend-status → backend-write TOCTOU window.
pub struct HumanControlPermit<'a> {
    app_state: &'a AppState,
    operation_id: u64,
    owner_epoch: u64,
    deadline: Instant,
    origin: HumanControlOrigin,
    terminal_id: String,
    finished: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub active: bool,
    pub lease_id: Option<String>,
    pub remote_addr: Option<String>,
    pub client_name: Option<String>,
    pub heartbeat_timeout_seconds: u64,
    pub transitioning: bool,
}

pub fn get_remote_control_status(app_state: &AppState) -> Result<RemoteControlStatus, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let (transition, initial_status) = {
        let mut current = app_state.remote_control.lock_or_err()?;
        let now = Instant::now();
        if !settings.enabled {
            let transition = current.begin_remote_owner_transition(now);
            current.reclaim_lockout_until = None;
            (transition, status_from_state(&current, timeout_seconds))
        } else {
            current.observe_lease_expiry(now, Duration::from_secs(timeout_seconds));
            current.prune_expired_claim_reservation(now);
            prune_expired_reclaim_lockout(&mut current, now);
            (
                current.current_owner_transition(),
                status_from_state(&current, timeout_seconds),
            )
        }
    };
    let Some(transition) = transition else {
        return Ok(initial_status);
    };
    if wait_for_remote_owner_transition(app_state, transition).is_err() {
        return Ok(initial_status);
    }
    let mut current = app_state.remote_control.lock_or_err()?;
    current.finalize_owner_transition_if_drained(transition);
    Ok(status_from_state(&current, timeout_seconds))
}

pub fn reclaim_remote_control(
    app_state: &AppState,
    app_handle: &AppHandle,
) -> Result<RemoteControlStatus, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let (transition, status) = {
        let mut current = app_state.remote_control.lock_or_err()?;
        let now = Instant::now();
        let transition = current.begin_remote_owner_transition(now);
        start_reclaim_lockout(&mut current, Duration::from_secs(timeout_seconds), now);
        (transition, status_from_state(&current, timeout_seconds))
    };
    if let Some(transition) = transition {
        emit_remote_control_status(app_handle, &status);
        wait_for_remote_owner_transition(app_state, transition)?;
        let mut current = app_state.remote_control.lock_or_err()?;
        let finalized = current.finalize_owner_transition_if_drained(transition);
        let status = status_from_state(&current, timeout_seconds);
        if finalized {
            emit_remote_control_status(app_handle, &status);
        }
        return Ok(status);
    }
    emit_remote_control_status(app_handle, &status);
    Ok(status)
}

pub(crate) fn effective_heartbeat_timeout_seconds(settings: &RemoteSettings) -> u64 {
    settings
        .heartbeat_timeout_seconds
        .max(MIN_REMOTE_HEARTBEAT_TIMEOUT_SECONDS)
}

pub(crate) fn status_from_lease(
    lease: &Option<RemoteControlLease>,
    heartbeat_timeout_seconds: u64,
) -> RemoteControlStatus {
    match lease {
        Some(lease) => RemoteControlStatus {
            active: true,
            lease_id: Some(lease.lease_id.clone()),
            remote_addr: Some(lease.remote_addr.clone()),
            client_name: lease.client_name.clone(),
            heartbeat_timeout_seconds,
            transitioning: false,
        },
        None => RemoteControlStatus {
            active: false,
            lease_id: None,
            remote_addr: None,
            client_name: None,
            heartbeat_timeout_seconds,
            transitioning: false,
        },
    }
}

pub(crate) fn status_from_state(
    state: &RemoteControlState,
    heartbeat_timeout_seconds: u64,
) -> RemoteControlStatus {
    let mut status = status_from_lease(&state.lease, heartbeat_timeout_seconds);
    let stale_remote_lease_id = state.active_operations.values().find_map(|operation| {
        if state.operation_is_current(operation) {
            return None;
        }
        match &operation.origin {
            HumanControlOrigin::Remote { lease_id } => Some(lease_id.clone()),
            HumanControlOrigin::Local => None,
        }
    });

    // If lease cleanup invalidated an in-flight Remote permit, retain an
    // `active` owner signal until the synchronous call acknowledges completion
    // by dropping the permit. This protects older PC clients that do not yet
    // understand `transitioning` from publishing Local ownership too early.
    if status.lease_id.is_none() {
        if let Some(lease_id) = stale_remote_lease_id {
            status.active = true;
            status.lease_id = Some(lease_id);
        }
    }
    status.transitioning =
        state.transitioning || state.has_stale_operations() || state.has_pending_completions();
    status
}

fn remote_owner_transition_budget() -> Duration {
    Duration::from_millis(REMOTE_OWNER_TRANSITION_TIMEOUT_MS)
}

impl RemoteControlState {
    fn ensure_lease_lifecycle(&mut self, timeout: Duration, now: Instant) {
        let Some(lease) = self.lease.as_ref() else {
            self.lease_lifecycle = None;
            return;
        };
        if self
            .lease_lifecycle
            .as_ref()
            .is_some_and(|lifecycle| lifecycle.lease_id == lease.lease_id)
        {
            return;
        }

        // Production claim/heartbeat paths install the lifecycle eagerly. This
        // fallback keeps tests and older internal callers that assign `lease`
        // directly safe without letting the first observation extend it from
        // `now`.
        let deadline = lease.last_heartbeat.checked_add(timeout).unwrap_or(now);
        self.lease_lifecycle = Some(RemoteLeaseLifecycle {
            lease_id: lease.lease_id.clone(),
            deadline,
            phase: RemoteLeasePhase::Active,
        });
    }

    pub(crate) fn install_remote_lease(&mut self, lease: RemoteControlLease, timeout: Duration) {
        let deadline = lease
            .last_heartbeat
            .checked_add(timeout)
            .unwrap_or(lease.last_heartbeat);
        self.lease_lifecycle = Some(RemoteLeaseLifecycle {
            lease_id: lease.lease_id.clone(),
            deadline,
            phase: RemoteLeasePhase::Active,
        });
        self.lease = Some(lease);
        self.transitioning = false;
        self.transition_deadline = None;
        self.cancel_claim_reservation();
    }

    /// Observe the sticky absolute lease deadline. Once this returns `true`,
    /// the lease has irreversibly entered `Expiring`; a later timeout increase
    /// or heartbeat cannot make it Active again.
    pub(crate) fn observe_lease_expiry(&mut self, now: Instant, timeout: Duration) -> bool {
        self.prune_completed_operations();
        self.ensure_lease_lifecycle(timeout, now);
        let should_expire = self.lease_lifecycle.as_ref().is_some_and(|lifecycle| {
            lifecycle.phase == RemoteLeasePhase::Active && now >= lifecycle.deadline
        });
        if should_expire {
            if let Some(transition) = self.begin_remote_owner_transition(now) {
                self.finalize_owner_transition_if_drained(transition);
            }
        } else if let Some(transition) = self.current_owner_transition() {
            // A previous observer may have initiated expiry while a permit was
            // active. Any later owner-state entry may complete the barrier once
            // that permit or quarantined worker acknowledgement has drained.
            self.finalize_owner_transition_if_drained(transition);
        }
        should_expire
    }

    /// Refresh an Active lease using the timeout effective at this successful
    /// heartbeat. An already-observed expiry is never refreshable.
    pub(crate) fn refresh_remote_lease(
        &mut self,
        lease_id: &str,
        now: Instant,
        timeout: Duration,
    ) -> bool {
        self.observe_lease_expiry(now, timeout);
        if !self.active_lease_id_matches(lease_id) {
            return false;
        }

        let Some(deadline) = now.checked_add(timeout) else {
            return false;
        };
        if let Some(lease) = self.lease.as_mut() {
            lease.last_heartbeat = now;
        }
        if let Some(lifecycle) = self.lease_lifecycle.as_mut() {
            lifecycle.deadline = deadline;
        }
        true
    }

    fn active_lease_id_matches(&self, lease_id: &str) -> bool {
        self.lease_lifecycle.as_ref().is_some_and(|lifecycle| {
            lifecycle.lease_id == lease_id && lifecycle.phase == RemoteLeasePhase::Active
        }) && self
            .lease
            .as_ref()
            .is_some_and(|lease| lease.lease_id == lease_id)
    }

    pub(crate) fn begin_remote_owner_transition(
        &mut self,
        now: Instant,
    ) -> Option<RemoteOwnerTransition> {
        self.prune_completed_operations();
        self.cancel_claim_reservation();
        // A registered Remote request can still be waiting on protocol
        // encoding or another non-PTY gate. Such an operation is safe to
        // detach: enqueue is performed under this same owner mutex, so either
        // the FIFO submission wins first and remains a cancellation barrier,
        // or this removal wins and the request can never submit any bytes.
        self.active_operations.retain(|_, operation| {
            !matches!(operation.origin, HumanControlOrigin::Remote { .. }) || operation.pty_enqueued
        });
        if self.lease.is_none() && !self.has_any_remote_operations() {
            return None;
        }
        if let Some(lifecycle) = self.lease_lifecycle.as_mut() {
            lifecycle.phase = RemoteLeasePhase::Expiring;
        }
        if !self.transitioning {
            self.transitioning = true;
            self.advance_owner_epoch();
            self.transition_deadline = now.checked_add(remote_owner_transition_budget());
        }
        let transition = RemoteOwnerTransition {
            epoch: self.owner_epoch,
            deadline: self.transition_deadline.unwrap_or(now),
        };
        Some(transition)
    }

    pub(crate) fn current_owner_transition(&self) -> Option<RemoteOwnerTransition> {
        (self.transitioning).then_some(RemoteOwnerTransition {
            epoch: self.owner_epoch,
            deadline: self.transition_deadline.unwrap_or_else(Instant::now),
        })
    }

    pub(crate) fn prune_completed_operations(&mut self) {
        self.active_operations.retain(|_, operation| {
            operation
                .completion
                .as_ref()
                .is_none_or(|completion| !completion.is_complete())
        });
    }

    pub(crate) fn finalize_owner_transition_if_drained(
        &mut self,
        transition: RemoteOwnerTransition,
    ) -> bool {
        if !self.transitioning || self.owner_epoch != transition.epoch {
            return false;
        }
        if self.has_active_operations() {
            return false;
        }
        self.lease = None;
        self.lease_lifecycle = None;
        self.transitioning = false;
        self.transition_deadline = None;
        true
    }

    pub(crate) fn create_claim_reservation(&mut self, now: Instant, ttl: Duration) -> String {
        self.prune_expired_claim_reservation(now);
        let token = Uuid::new_v4().to_string();
        let expires_at = now.checked_add(ttl).unwrap_or(now);
        self.claim_reservation = Some(ClaimReservation {
            token_hash: self.claim_token_hasher.hash(&token),
            owner_epoch: self.owner_epoch,
            expires_at,
        });
        token
    }

    /// Validate and, when no older operation remains, consume a one-shot claim
    /// reservation. The caller keeps the owner mutex held while installing the
    /// lease immediately after `Consumed`, so Local work cannot slip between
    /// reservation consumption and the owner epoch transition.
    pub(crate) fn resume_claim_reservation(
        &mut self,
        presented_token: Option<&str>,
        now: Instant,
    ) -> ClaimReservationAttempt {
        self.prune_expired_claim_reservation(now);
        let Some(reservation) = self.claim_reservation.as_ref() else {
            return if presented_token.is_some() {
                ClaimReservationAttempt::Rejected { remaining: None }
            } else {
                ClaimReservationAttempt::NoReservation
            };
        };

        let remaining = reservation.expires_at.saturating_duration_since(now);
        if reservation.owner_epoch != self.owner_epoch {
            self.claim_reservation = None;
            return ClaimReservationAttempt::Rejected { remaining: None };
        }
        let Some(token) = presented_token else {
            return ClaimReservationAttempt::Rejected {
                remaining: Some(remaining),
            };
        };
        if !token_hashes_equal(reservation.token_hash, self.claim_token_hasher.hash(token)) {
            return ClaimReservationAttempt::Rejected {
                remaining: Some(remaining),
            };
        }
        if self.has_active_operations() {
            return ClaimReservationAttempt::Busy { remaining };
        }

        self.claim_reservation = None;
        ClaimReservationAttempt::Consumed
    }

    pub(crate) fn prune_expired_claim_reservation(&mut self, now: Instant) {
        if self
            .claim_reservation
            .as_ref()
            .is_some_and(|reservation| now >= reservation.expires_at)
        {
            self.claim_reservation = None;
        }
    }

    pub(crate) fn cancel_claim_reservation(&mut self) {
        self.claim_reservation = None;
    }

    pub(crate) fn has_claim_reservation(&self) -> bool {
        self.claim_reservation.is_some()
    }

    pub(crate) fn has_active_operations(&self) -> bool {
        !self.active_operations.is_empty()
    }

    fn has_pending_completions(&self) -> bool {
        self.active_operations
            .values()
            .any(|operation| operation.completion.is_some())
    }

    pub(crate) fn has_any_remote_operations(&self) -> bool {
        self.active_operations
            .values()
            .any(|operation| matches!(operation.origin, HumanControlOrigin::Remote { .. }))
    }

    fn origin_is_current(&self, origin: &HumanControlOrigin) -> bool {
        match origin {
            HumanControlOrigin::Local => self.lease.is_none(),
            HumanControlOrigin::Remote { lease_id } => self
                .lease
                .as_ref()
                .is_some_and(|lease| lease.lease_id == *lease_id),
        }
    }

    fn operation_is_current(&self, operation: &HumanControlOperation) -> bool {
        operation.owner_epoch == self.owner_epoch && self.origin_is_current(&operation.origin)
    }

    fn has_stale_operations(&self) -> bool {
        self.active_operations
            .values()
            .any(|operation| !self.operation_is_current(operation))
    }

    fn register_operation(
        &mut self,
        origin: HumanControlOrigin,
        terminal_id: String,
    ) -> (u64, u64) {
        self.next_operation_id = self.next_operation_id.wrapping_add(1).max(1);
        let operation_id = self.next_operation_id;
        let owner_epoch = self.owner_epoch;
        self.active_operations.insert(
            operation_id,
            HumanControlOperation {
                owner_epoch,
                origin,
                terminal_id,
                pty_enqueued: false,
                completion: None,
            },
        );
        (operation_id, owner_epoch)
    }

    pub(crate) fn advance_owner_epoch(&mut self) {
        self.owner_epoch = self.owner_epoch.wrapping_add(1);
    }
}

impl HumanControlPermit<'_> {
    /// Absolute deadline captured when this operation is registered. Queue
    /// wait, protocol encoding, and physical I/O all consume the same budget.
    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    fn is_current_in(&self, control: &RemoteControlState) -> bool {
        control.owner_epoch == self.owner_epoch
            && !control.transitioning
            && control
                .active_operations
                .get(&self.operation_id)
                .is_some_and(|operation| {
                    control.operation_is_current(operation)
                        && operation.owner_epoch == self.owner_epoch
                        && operation.origin == self.origin
                        && operation.terminal_id == self.terminal_id
                })
    }

    /// Revalidate immediately before each physical write chunk or resize.
    pub fn is_current(&self) -> bool {
        let Ok(control) = self.app_state.remote_control.lock_or_err() else {
            return false;
        };
        self.is_current_in(&control)
    }

    pub fn ensure_current(&self) -> Result<(), String> {
        self.is_current()
            .then_some(())
            .ok_or_else(|| "terminal controller ownership changed during operation".into())
    }

    /// Submit a physical PTY job at the same synchronization boundary used by
    /// owner transitions. The closure must only enqueue the job; it must not
    /// wait for completion or try to acquire the owner gate recursively.
    pub(crate) fn enqueue_pty_job<T>(
        &self,
        enqueue: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut control = self.app_state.remote_control.lock_or_err()?;
        if !self.is_current_in(&control) {
            return Err("terminal controller ownership changed before PTY enqueue".into());
        }

        let pending = enqueue()?;
        let operation = control
            .active_operations
            .get_mut(&self.operation_id)
            .ok_or_else(|| "terminal control operation is no longer registered".to_string())?;
        operation.pty_enqueued = true;
        Ok(pending)
    }

    /// Atomically validate successful completion and remove the operation from
    /// the owner-transition barrier. Either this wins the owner gate first and
    /// returns success, or an owner transition wins first and completion is
    /// reported as ambiguous.
    pub fn finish(mut self) -> Result<(), String> {
        let mut control = self.app_state.remote_control.lock_or_err()?;
        let current = self.is_current_in(&control);
        control.active_operations.remove(&self.operation_id);
        control.prune_completed_operations();
        self.finished = true;
        current
            .then_some(())
            .ok_or_else(|| "terminal controller ownership changed during operation".into())
    }

    /// Preserve the owner barrier until a faulted PTY worker acknowledges
    /// exit. The request task may return, but Local ownership cannot publish.
    pub(crate) fn quarantine(mut self, completion: PtyControlCompletion) -> Result<(), String> {
        let mut control = self.app_state.remote_control.lock_or_err()?;
        let operation = control
            .active_operations
            .get_mut(&self.operation_id)
            .ok_or_else(|| "terminal control operation is no longer registered".to_string())?;
        operation.completion = Some(completion);
        self.finished = true;
        control.prune_completed_operations();
        Ok(())
    }
}

impl Drop for HumanControlPermit<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut control) = self.app_state.remote_control.lock_or_err() {
            control.active_operations.remove(&self.operation_id);
            control.prune_completed_operations();
        }
    }
}

fn poll_remote_owner_transition(
    app_state: &AppState,
    transition: RemoteOwnerTransition,
) -> Result<bool, String> {
    let mut control = app_state.remote_control.lock_or_err()?;
    control.prune_completed_operations();
    Ok(!control.transitioning
        || control.owner_epoch != transition.epoch
        || !control.has_active_operations())
}

pub(crate) fn wait_for_remote_owner_transition(
    app_state: &AppState,
    transition: RemoteOwnerTransition,
) -> Result<(), String> {
    let poll = Duration::from_millis(PTY_CONTROL_WAIT_POLL_MS);
    loop {
        if poll_remote_owner_transition(app_state, transition)? {
            return Ok(());
        }
        let now = Instant::now();
        if now >= transition.deadline {
            return Err("terminal controller transition acknowledgement timed out".into());
        }
        thread::sleep(poll.min(transition.deadline.saturating_duration_since(now)));
    }
}

pub(crate) async fn wait_for_remote_owner_transition_async(
    app_state: &AppState,
    transition: RemoteOwnerTransition,
) -> Result<(), String> {
    let poll = Duration::from_millis(PTY_CONTROL_WAIT_POLL_MS);
    loop {
        if poll_remote_owner_transition(app_state, transition)? {
            return Ok(());
        }
        let now = Instant::now();
        if now >= transition.deadline {
            return Err("terminal controller transition acknowledgement timed out".into());
        }
        tokio::time::sleep(poll.min(transition.deadline.saturating_duration_since(now))).await;
    }
}

pub fn begin_human_control_operation<'a>(
    app_state: &'a AppState,
    origin: HumanControlOrigin,
    terminal_id: &str,
) -> Result<HumanControlPermit<'a>, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    let mut control = app_state.remote_control.lock_or_err()?;
    let now = Instant::now();
    control.observe_lease_expiry(now, Duration::from_secs(timeout_seconds));
    control.prune_expired_claim_reservation(now);
    if !settings.enabled {
        let transition = control.begin_remote_owner_transition(now);
        if matches!(origin, HumanControlOrigin::Remote { .. }) {
            return Err("remote controller access is disabled".into());
        }
        if transition.is_some() {
            return Err("terminal controller ownership is changing".into());
        }
    }
    if control.transitioning {
        return Err("terminal controller ownership is changing".into());
    }
    if control.has_stale_operations() {
        return Err("terminal controller ownership is still draining".into());
    }
    if control.has_pending_completions() {
        return Err("terminal controller operation is still cancelling".into());
    }
    if matches!(origin, HumanControlOrigin::Local) && control.has_claim_reservation() {
        return Err("remote control claim reservation is active".into());
    }

    match &origin {
        HumanControlOrigin::Local if control.lease.is_some() => {
            return Err("terminal is controlled by a remote client".into());
        }
        HumanControlOrigin::Remote { lease_id } => {
            if control
                .lease
                .as_ref()
                .is_none_or(|lease| lease.lease_id != *lease_id)
            {
                return Err("remote controller lease is not active".into());
            }
        }
        HumanControlOrigin::Local => {}
    }

    let deadline = Instant::now()
        .checked_add(Duration::from_millis(PTY_CONTROL_JOB_TIMEOUT_MS))
        .ok_or_else(|| "terminal control operation deadline overflowed".to_string())?;
    let (operation_id, owner_epoch) =
        control.register_operation(origin.clone(), terminal_id.to_string());
    Ok(HumanControlPermit {
        app_state,
        operation_id,
        owner_epoch,
        deadline,
        origin,
        terminal_id: terminal_id.to_string(),
        finished: false,
    })
}

pub(crate) fn start_reclaim_lockout(
    state: &mut RemoteControlState,
    duration: Duration,
    now: Instant,
) {
    state.reclaim_lockout_until = Some(now + duration);
}

pub(crate) fn reclaim_lockout_active(state: &mut RemoteControlState, now: Instant) -> bool {
    match state.reclaim_lockout_until {
        Some(until) if until > now => true,
        Some(_) => {
            state.reclaim_lockout_until = None;
            false
        }
        None => false,
    }
}

pub(crate) fn prune_expired_reclaim_lockout(state: &mut RemoteControlState, now: Instant) {
    if state
        .reclaim_lockout_until
        .is_some_and(|until| until <= now)
    {
        state.reclaim_lockout_until = None;
    }
}

pub(crate) fn emit_remote_control_status(app_handle: &AppHandle, status: &RemoteControlStatus) {
    if let Err(err) = app_handle.emit(EVENT_REMOTE_CONTROL_CHANGED, status) {
        tracing::warn!(error = %err, "failed to emit remote-control-changed");
    }
}

pub(crate) fn require_active_lease(
    app_state: &AppState,
    lease_id: Option<&str>,
) -> Result<(), Response> {
    let Some(lease_id) = lease_id.filter(|value| !value.is_empty()) else {
        return Err(json_error(
            StatusCode::CONFLICT,
            "remote controller lease is required",
        ));
    };

    match active_lease_matches(app_state, lease_id) {
        Ok(true) => Ok(()),
        Ok(false) => Err(json_error(
            StatusCode::CONFLICT,
            "remote controller lease is not active",
        )),
        Err(err) => Err(internal_error(err)),
    }
}

pub(crate) fn active_lease_matches(app_state: &AppState, lease_id: &str) -> Result<bool, String> {
    let settings = effective_remote_settings(app_state)?;
    let timeout_seconds = effective_heartbeat_timeout_seconds(&settings);
    active_lease_matches_with_timeout(app_state, lease_id, Duration::from_secs(timeout_seconds))
}

pub(crate) fn active_lease_matches_with_timeout(
    app_state: &AppState,
    lease_id: &str,
    timeout: Duration,
) -> Result<bool, String> {
    let mut current = app_state.remote_control.lock_or_err()?;
    let now = Instant::now();
    current.observe_lease_expiry(now, timeout);
    current.prune_expired_claim_reservation(now);
    Ok(current.active_lease_id_matches(lease_id))
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::io::Write;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use super::*;
    use serial_test::serial;

    use crate::settings::{save_settings, Settings};

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = env::var(key).ok();
            env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("APPDATA", dir)
    }

    #[cfg(not(target_os = "windows"))]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("HOME", dir)
    }

    fn save_remote_settings(enabled: bool, auth_token: &str) {
        let mut settings = Settings::default();
        settings.remote.enabled = enabled;
        settings.remote.auth_token = auth_token.into();
        save_settings(&settings).unwrap();
    }

    fn state_with_active_lease(lease_id: &str) -> AppState {
        let state = AppState::new();
        {
            let mut control = state.remote_control.lock_or_err().unwrap();
            control.lease = Some(RemoteControlLease {
                lease_id: lease_id.into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: Instant::now(),
            });
        }
        state
    }

    struct CapturingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn transition_detaches_remote_input_blocked_before_pty_enqueue() {
        let state = Arc::new(state_with_active_lease("lease-1"));
        {
            let mut runtime = state.remote_access.lock_or_err().unwrap();
            runtime.enabled = true;
            runtime.auth_token = Some("test-token".into());
        }

        let protocol_gate = crate::terminal_output::new_protocol_gate();
        state
            .terminal_protocol_states
            .lock_or_err()
            .unwrap()
            .insert("t1".into(), Arc::clone(&protocol_gate));
        let written = Arc::new(Mutex::new(Vec::new()));
        state.pty_handles.lock_or_err().unwrap().insert(
            "t1".into(),
            crate::pty::PtyHandle::from_test_writer(Box::new(CapturingWriter(Arc::clone(
                &written,
            )))),
        );

        // Hold the request after permit registration but before the PTY FIFO.
        // Transition wait/finalize must complete without releasing this gate.
        let protocol_guard = protocol_gate.lock_or_err().unwrap();
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || {
            crate::commands::write_terminal_input_inner(
                &worker_state,
                "t1",
                "must not be written",
                true,
                HumanControlOrigin::Remote {
                    lease_id: "lease-1".into(),
                },
            )
        });

        let registration_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if state
                .remote_control
                .lock_or_err()
                .unwrap()
                .has_active_operations()
            {
                break;
            }
            assert!(
                Instant::now() < registration_deadline,
                "Remote input did not register before the protocol gate"
            );
            std::thread::yield_now();
        }

        let transition_started = Instant::now();
        let transition = state
            .remote_control
            .lock_or_err()
            .unwrap()
            .begin_remote_owner_transition(transition_started)
            .expect("the active Remote lease should begin a transition");
        wait_for_remote_owner_transition(&state, transition).unwrap();
        assert!(
            transition_started.elapsed() < Duration::from_millis(500),
            "pre-enqueue detachment must drain within the bounded transition deadline"
        );
        assert!(
            state
                .remote_control
                .lock_or_err()
                .unwrap()
                .finalize_owner_transition_if_drained(transition),
            "the drained transition must publish Local ownership"
        );

        drop(protocol_guard);
        let error = worker
            .join()
            .unwrap()
            .expect_err("detached Remote input must fail closed");
        assert!(error.contains("ownership changed"));
        assert_eq!(written.lock().unwrap().len(), 0);
    }

    #[test]
    fn expired_lease_is_pruned() {
        let now = Instant::now();
        let mut control = RemoteControlState::default();
        control.install_remote_lease(
            RemoteControlLease {
                lease_id: "lease".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: now - Duration::from_secs(20),
            },
            Duration::from_secs(5),
        );
        assert!(control.observe_lease_expiry(now, Duration::from_secs(60)));
        assert!(control.lease.is_none());
    }

    #[test]
    fn heartbeat_timeout_preserves_a_reconnect_floor() {
        let mut settings = Settings::default().remote;
        settings.heartbeat_timeout_seconds = 5;
        assert_eq!(effective_heartbeat_timeout_seconds(&settings), 30);

        settings.heartbeat_timeout_seconds = 60;
        assert_eq!(effective_heartbeat_timeout_seconds(&settings), 60);
    }

    #[test]
    fn reclaim_lockout_expires_after_duration() {
        let now = Instant::now();
        let mut state = RemoteControlState::default();
        start_reclaim_lockout(&mut state, Duration::from_secs(5), now);

        assert!(reclaim_lockout_active(
            &mut state,
            now + Duration::from_secs(4)
        ));
        assert!(!reclaim_lockout_active(
            &mut state,
            now + Duration::from_secs(5)
        ));
        assert!(state.reclaim_lockout_until.is_none());
    }

    #[test]
    #[serial]
    fn remote_status_keeps_active_lease_when_enabled_with_empty_token() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "");
        let state = state_with_active_lease("lease-1");

        let status = get_remote_control_status(&state).unwrap();

        assert!(status.active);
        assert_eq!(status.lease_id.as_deref(), Some("lease-1"));
        assert!(state.remote_control.lock_or_err().unwrap().lease.is_some());
    }

    #[test]
    #[serial]
    fn remote_status_clears_active_lease_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(false, "");
        let state = state_with_active_lease("lease-1");

        let status = get_remote_control_status(&state).unwrap();

        assert!(!status.active);
        assert!(status.lease_id.is_none());
        assert!(state.remote_control.lock_or_err().unwrap().lease.is_none());
    }

    #[test]
    #[serial]
    fn local_operation_is_registered_and_blocks_remote_ownership_races() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "token");
        let state = AppState::new();

        let permit =
            begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").unwrap();

        assert!(permit.is_current());
        assert!(state
            .remote_control
            .lock_or_err()
            .unwrap()
            .has_active_operations());
        drop(permit);
        assert!(!state
            .remote_control
            .lock_or_err()
            .unwrap()
            .has_active_operations());
    }

    #[test]
    #[serial]
    fn remote_operation_requires_the_active_lease_and_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "token");
        let state = state_with_active_lease("lease-1");

        assert!(begin_human_control_operation(
            &state,
            HumanControlOrigin::Remote {
                lease_id: "wrong".into(),
            },
            "t1",
        )
        .is_err());

        let permit = begin_human_control_operation(
            &state,
            HumanControlOrigin::Remote {
                lease_id: "lease-1".into(),
            },
            "t1",
        )
        .unwrap();
        assert!(permit.is_current());

        state
            .remote_control
            .lock_or_err()
            .unwrap()
            .advance_owner_epoch();
        assert!(!permit.is_current());
    }

    #[test]
    #[serial]
    fn remote_permit_is_bound_to_the_lease_origin_and_blocks_local_until_drained() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "token");
        let state = state_with_active_lease("lease-1");

        let permit = begin_human_control_operation(
            &state,
            HumanControlOrigin::Remote {
                lease_id: "lease-1".into(),
            },
            "t1",
        )
        .unwrap();

        // Simulate an owner transition observed by a route that replaces or
        // removes the lease before the old synchronous PTY call unwinds.
        state.remote_control.lock_or_err().unwrap().lease = None;

        assert!(
            !permit.is_current(),
            "a permit must become stale when its Remote lease is no longer authoritative"
        );
        assert!(
            begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").is_err(),
            "the new owner must not overtake a stale operation that has not acknowledged completion"
        );

        assert!(
            permit.finish().is_err(),
            "stale completion must report an ambiguous owner-change failure"
        );
        assert!(begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").is_ok());
    }

    #[test]
    #[serial]
    fn disabled_access_defers_owner_publish_until_the_remote_permit_drains() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "token");
        let state = state_with_active_lease("lease-1");
        let permit = begin_human_control_operation(
            &state,
            HumanControlOrigin::Remote {
                lease_id: "lease-1".into(),
            },
            "t1",
        )
        .unwrap();
        state
            .remote_control
            .lock_or_err()
            .unwrap()
            .active_operations
            .get_mut(&permit.operation_id)
            .unwrap()
            .pty_enqueued = true;

        save_remote_settings(false, "");
        let draining = get_remote_control_status(&state).unwrap();

        assert!(
            draining.active,
            "old clients must not see Local ownership early"
        );
        assert!(draining.transitioning);
        assert!(
            !permit.is_current(),
            "access disable must invalidate the registered Remote operation"
        );

        assert!(permit.finish().is_err());
        let disabled = get_remote_control_status(&state).unwrap();
        assert!(!disabled.active);
        assert!(!disabled.transitioning);
    }

    #[test]
    #[serial]
    fn disabled_remote_access_rejects_a_remote_origin_even_if_a_stale_lease_exists() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(false, "");
        let state = state_with_active_lease("lease-1");

        assert!(begin_human_control_operation(
            &state,
            HumanControlOrigin::Remote {
                lease_id: "lease-1".into(),
            },
            "t1",
        )
        .is_err());
    }

    #[test]
    fn lease_deadline_is_sticky_until_a_successful_heartbeat() {
        let now = Instant::now();
        let mut control = RemoteControlState::default();
        control.install_remote_lease(
            RemoteControlLease {
                lease_id: "lease-1".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: now,
            },
            Duration::from_secs(30),
        );

        assert!(
            !control.observe_lease_expiry(now + Duration::from_secs(29), Duration::from_secs(5))
        );
        assert!(control.refresh_remote_lease(
            "lease-1",
            now + Duration::from_secs(29),
            Duration::from_secs(60),
        ));
        assert!(
            !control.observe_lease_expiry(now + Duration::from_secs(88), Duration::from_secs(5))
        );
        assert!(control.observe_lease_expiry(now + Duration::from_secs(89), Duration::from_secs(5)));
        assert!(control.lease.is_none());
    }

    #[test]
    fn observed_expiry_is_irreversible_while_a_remote_operation_drains() {
        let now = Instant::now();
        let mut control = RemoteControlState::default();
        control.install_remote_lease(
            RemoteControlLease {
                lease_id: "lease-1".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: now,
            },
            Duration::from_secs(30),
        );
        let (operation_id, _) = control.register_operation(
            HumanControlOrigin::Remote {
                lease_id: "lease-1".into(),
            },
            "t1".into(),
        );
        control
            .active_operations
            .get_mut(&operation_id)
            .unwrap()
            .pty_enqueued = true;

        assert!(
            control.observe_lease_expiry(now + Duration::from_secs(30), Duration::from_secs(60))
        );
        assert!(control.transitioning);
        assert!(control.lease.is_some());
        assert!(!control.refresh_remote_lease(
            "lease-1",
            now + Duration::from_secs(30),
            Duration::from_secs(60),
        ));
        assert!(!control.active_lease_id_matches("lease-1"));
    }

    #[test]
    fn forced_transition_keeps_old_remote_published_until_every_operation_drains() {
        let now = Instant::now();
        let state = AppState::new();
        let transition = {
            let mut control = state.remote_control.lock_or_err().unwrap();
            control.install_remote_lease(
                RemoteControlLease {
                    lease_id: "lease-1".into(),
                    remote_addr: "127.0.0.1:1".into(),
                    client_name: None,
                    last_heartbeat: now,
                },
                Duration::from_secs(30),
            );
            let (operation_id, _) = control.register_operation(
                HumanControlOrigin::Remote {
                    lease_id: "lease-1".into(),
                },
                "t1".into(),
            );
            control
                .active_operations
                .get_mut(&operation_id)
                .unwrap()
                .pty_enqueued = true;
            control.create_claim_reservation(now, Duration::from_secs(2));
            let transition = control
                .begin_remote_owner_transition(now)
                .expect("active operation requires a barrier");
            let status = status_from_state(&control, 30);
            assert!(status.active);
            assert!(status.transitioning);
            assert!(!control.has_claim_reservation());
            assert_eq!(
                control
                    .begin_remote_owner_transition(now + Duration::from_millis(1))
                    .unwrap()
                    .deadline,
                transition.deadline,
                "all terminal permits must share one absolute deadline"
            );
            transition
        };

        let expired = RemoteOwnerTransition {
            deadline: now,
            ..transition
        };
        assert!(wait_for_remote_owner_transition(&state, expired).is_err());
        let mut control = state.remote_control.lock_or_err().unwrap();
        assert!(control.lease.is_some());
        assert!(control.transitioning);
        control.active_operations.clear();
        drop(control);

        wait_for_remote_owner_transition(&state, transition).unwrap();
        let mut control = state.remote_control.lock_or_err().unwrap();
        assert!(control.finalize_owner_transition_if_drained(transition));
        assert!(control.lease.is_none());
        assert!(!control.transitioning);
    }

    #[test]
    fn one_shot_claim_reservation_blocks_local_work_until_matching_consume() {
        let now = Instant::now();
        let mut control = RemoteControlState::default();
        control.register_operation(HumanControlOrigin::Local, "t1".into());
        let token = control.create_claim_reservation(now, Duration::from_secs(2));

        assert!(matches!(
            control.resume_claim_reservation(Some(&token), now + Duration::from_millis(1)),
            ClaimReservationAttempt::Busy { .. }
        ));
        assert!(matches!(
            control.resume_claim_reservation(Some("wrong"), now + Duration::from_millis(1)),
            ClaimReservationAttempt::Rejected { .. }
        ));
        assert!(matches!(
            control.resume_claim_reservation(None, now + Duration::from_millis(1)),
            ClaimReservationAttempt::Rejected { .. }
        ));

        control.active_operations.clear();
        assert!(matches!(
            control.resume_claim_reservation(Some(&token), now + Duration::from_millis(2)),
            ClaimReservationAttempt::Consumed
        ));
        assert!(!control.has_claim_reservation());
        assert!(matches!(
            control.resume_claim_reservation(Some(&token), now + Duration::from_millis(3)),
            ClaimReservationAttempt::Rejected { remaining: None }
        ));
    }

    #[test]
    fn expired_claim_reservation_restores_local_progress() {
        let now = Instant::now();
        let mut control = RemoteControlState::default();
        let token = control.create_claim_reservation(now, Duration::from_millis(50));
        assert!(control.has_claim_reservation());

        assert!(matches!(
            control.resume_claim_reservation(Some(&token), now + Duration::from_millis(50)),
            ClaimReservationAttempt::Rejected { remaining: None }
        ));
        assert!(!control.has_claim_reservation());
        assert!(control.origin_is_current(&HumanControlOrigin::Local));
    }

    #[test]
    #[serial]
    fn active_claim_reservation_rejects_new_local_permits() {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        save_remote_settings(true, "token");
        let state = AppState::new();
        let now = Instant::now();
        let token = state
            .remote_control
            .lock_or_err()
            .unwrap()
            .create_claim_reservation(now, Duration::from_secs(2));

        assert!(begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").is_err());

        let mut control = state.remote_control.lock_or_err().unwrap();
        assert_eq!(
            control.resume_claim_reservation(Some(&token), now + Duration::from_millis(1)),
            ClaimReservationAttempt::Consumed
        );
        control.advance_owner_epoch();
        control.install_remote_lease(
            RemoteControlLease {
                lease_id: "lease-1".into(),
                remote_addr: "127.0.0.1:1".into(),
                client_name: None,
                last_heartbeat: now + Duration::from_millis(1),
            },
            Duration::from_secs(30),
        );
        drop(control);

        assert!(begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").is_err());
    }
}
