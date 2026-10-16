//! Shared WSL guest observations (ADR-0335).
//!
//! Several backend readers cross the WSL boundary to look at the same guest:
//! the three provider session lookups, Codex turn polling, hook-state polling,
//! session-record polling and the Codex exit verifier. Each used to start its
//! own `wsl.exe` even when another reader had just looked at the same
//! distribution. This module makes one guest probe run shareable:
//!
//! - **Single flight.** Requests for the same run key and terminal catalog join
//!   a run that is already in progress instead of starting another.
//! - **Freshness is the caller's contract.** Display polling
//!   ([`GuestObservation::Reusable`]) accepts a run that started within
//!   `WSL_GUEST_SNAPSHOT_MAX_AGE`. Persistence and exit verification
//!   ([`GuestObservation::StartedAfter`]) accept only a run that started at or
//!   after their boundary, so a guest view taken before the boundary never
//!   speaks for it.
//! - **Catalog-bound.** A guest process names its pane only by terminal id. A
//!   run is valid only for the PTY catalog (terminal id, generation) it started
//!   under, so any create, close or respawn forces a new run.
//! - **Deadlines stay with the waiter.** A run has its own timeout and its own
//!   thread. Every caller — the one that started it included — waits only until
//!   its own deadline, so sharing never stretches a caller's budget and a short
//!   budget never truncates the run for the others.
//!
//! Lock discipline: one leaf mutex for the run table and one per run for its
//! outcome. Neither is held across guest I/O, while waiting on the other, or
//! together with an `AppState` lock.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

/// The error a waiter reports when its own deadline ends first.
const DEADLINE_EXPIRED: &str = "WSL guest observation deadline expired";

/// What a caller accepts as a current view of a WSL guest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuestObservation {
    /// Display polling. A run that started within `WSL_GUEST_SNAPSHOT_MAX_AGE`
    /// — finished or still running — is current enough.
    Reusable,
    /// Persistence, exit verification and one-shot queries: only a run that
    /// started at or after this boundary.
    StartedAfter(Instant),
}

impl GuestObservation {
    /// A boundary at this instant: the caller needs a view of the guest taken
    /// after it asked.
    pub fn starting_now() -> Self {
        Self::StartedAfter(Instant::now())
    }

    /// True for display polling, which may be served a view older than the
    /// request. Such a view must not become checkpoint evidence.
    pub fn is_reusable(self) -> bool {
        matches!(self, Self::Reusable)
    }

    /// `started_at` is taken before the run is spawned, so it never postdates
    /// the guest read itself: a boundary check against it is conservative.
    fn accepts(self, started_at: Instant, now: Instant, max_age: Duration) -> bool {
        match self {
            Self::Reusable => now.saturating_duration_since(started_at) <= max_age,
            Self::StartedAfter(boundary) => started_at >= boundary,
        }
    }
}

/// The PTY catalog a run started under: every live terminal id with its PTY
/// generation, sorted.
///
/// A marked guest process says which terminal id it belongs to, never which
/// generation. A run taken before a pane was created, closed or respawned
/// therefore cannot speak for the catalog that exists afterwards.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct TerminalCatalog(Vec<(String, u64)>);

impl TerminalCatalog {
    /// Snapshot `pty_handles`. Takes and releases that lock alone, so callers
    /// hold no other `AppState` lock and the run table is never nested in it.
    pub fn of(state: &AppState) -> Result<Self, AppError> {
        let mut entries: Vec<(String, u64)> = state
            .pty_handles
            .lock_or_err()?
            .iter()
            .map(|(terminal_id, handle)| (terminal_id.clone(), handle.terminal_generation()))
            .collect();
        entries.sort();
        Ok(Self(entries))
    }
}

/// Identity of one guest probe run: which probe, in which distribution, with
/// which argv. Two requests share a run only when all three match.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct GuestProbeKey {
    probe: &'static str,
    distro: String,
    args: Vec<String>,
}

impl GuestProbeKey {
    pub fn new(probe: &'static str, distro: &str, args: Vec<String>) -> Self {
        Self {
            probe,
            distro: distro.to_string(),
            args,
        }
    }
}

type Outcome<V> = Result<Arc<V>, String>;
type SlotKey = (GuestProbeKey, TerminalCatalog);

struct Run<V> {
    started_at: Instant,
    outcome: Mutex<Option<Outcome<V>>>,
    finished: Condvar,
}

struct Slot<V> {
    /// The most recently started run that has not finished.
    running: Option<Arc<Run<V>>>,
    /// The most recently started run that has finished, with its start time.
    completed: Option<(Instant, Outcome<V>)>,
}

impl<V> Default for Slot<V> {
    fn default() -> Self {
        Self {
            running: None,
            completed: None,
        }
    }
}

/// A request that is either already answered or waiting on a run.
pub struct Pending<V>(PendingState<V>);

enum PendingState<V> {
    Done(Outcome<V>),
    Running(Arc<Run<V>>),
}

impl<V> Pending<V> {
    /// The run's outcome, or an error once `deadline` passes first. The run
    /// itself keeps going and still publishes for later requests.
    pub fn wait(self, deadline: Instant) -> Result<Arc<V>, String> {
        let run = match self.0 {
            PendingState::Done(outcome) => return outcome,
            PendingState::Running(run) => run,
        };
        let outcome = run.outcome.lock_or_err().map_err(|e| e.to_string())?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (outcome, _) = run
            .finished
            .wait_timeout_while(outcome, remaining, |outcome| outcome.is_none())
            .map_err(|_| "WSL guest observation outcome lock poisoned".to_string())?;
        outcome
            .clone()
            .unwrap_or_else(|| Err(DEADLINE_EXPIRED.to_string()))
    }
}

/// Shared guest probe runs, keyed by [`GuestProbeKey`] and [`TerminalCatalog`].
pub struct GuestSnapshots<V> {
    max_age: Duration,
    run_timeout: Duration,
    slots: Arc<Mutex<HashMap<SlotKey, Slot<V>>>>,
    /// Runs started per probe name, for the polling replay that reports them
    /// next to the `wsl.exe` runs counted from outside. Test builds only.
    #[cfg(test)]
    runs_by_probe: Mutex<HashMap<&'static str, usize>>,
}

/// The production table: raw stdout of each probe run. Parsing stays with the
/// reader that owns the probe's format.
pub type GuestProbeCache = GuestSnapshots<Vec<u8>>;

impl<V: Send + Sync + 'static> Default for GuestSnapshots<V> {
    fn default() -> Self {
        Self::new(
            crate::constants::WSL_GUEST_SNAPSHOT_MAX_AGE,
            crate::constants::WSL_AGENT_PROBE_TIMEOUT,
        )
    }
}

impl<V: Send + Sync + 'static> GuestSnapshots<V> {
    /// `max_age` serves [`GuestObservation::Reusable`]; `run_timeout` is what
    /// every run gets, whoever starts it.
    pub fn new(max_age: Duration, run_timeout: Duration) -> Self {
        Self {
            max_age,
            run_timeout,
            slots: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            runs_by_probe: Mutex::new(HashMap::new()),
        }
    }

    /// How many runs of `probe` this table has started.
    #[cfg(test)]
    pub fn runs_started(&self, probe: &str) -> usize {
        self.runs_by_probe
            .lock()
            .map(|started| started.get(probe).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    /// Answer from a run `observation` accepts, or start one. `run` receives
    /// the table's run timeout and executes on its own thread; it is dropped
    /// unused when an existing run answers. A request whose deadline has
    /// already passed never starts a run.
    pub fn request<F>(
        &self,
        key: GuestProbeKey,
        catalog: &TerminalCatalog,
        observation: GuestObservation,
        deadline: Instant,
        run: F,
    ) -> Pending<V>
    where
        F: FnOnce(Duration) -> Result<V, String> + Send + 'static,
    {
        let now = Instant::now();
        let mut slots = match self.slots.lock_or_err() {
            Ok(slots) => slots,
            Err(error) => return Pending(PendingState::Done(Err(error.to_string()))),
        };
        let max_age = self.max_age;
        // Nothing older than the window can serve polling, and a boundary that
        // old is better served by a new run: dropping these only costs reuse.
        slots.retain(|_, slot| {
            slot.running.is_some()
                || slot.completed.as_ref().is_some_and(|(started_at, _)| {
                    now.saturating_duration_since(*started_at) <= max_age
                })
        });
        let slot_key = (key, catalog.clone());
        let slot = slots.entry(slot_key.clone()).or_default();
        if let Some((started_at, outcome)) = &slot.completed {
            if observation.accepts(*started_at, now, max_age) {
                return Pending(PendingState::Done(outcome.clone()));
            }
        }
        if let Some(running) = &slot.running {
            if observation.accepts(running.started_at, now, max_age) {
                return Pending(PendingState::Running(Arc::clone(running)));
            }
        }
        if super::remaining_timeout_at(deadline, now).is_none() {
            return Pending(PendingState::Done(Err(DEADLINE_EXPIRED.to_string())));
        }
        let started = Arc::new(Run {
            started_at: now,
            outcome: Mutex::new(None),
            finished: Condvar::new(),
        });
        let worker = Arc::clone(&started);
        let table = Arc::clone(&self.slots);
        let timeout = self.run_timeout;
        #[cfg(test)]
        let probe = slot_key.0.probe;
        let worker_key = slot_key;
        // Spawned under the table lock, so the run cannot publish before it is
        // registered as running.
        let spawned = std::thread::Builder::new()
            .name("wsl-guest-observation".into())
            .spawn(move || {
                let outcome =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(timeout)))
                        .unwrap_or_else(|_| Err("WSL guest observation panicked".to_string()))
                        .map(Arc::new);
                finish(&table, &worker_key, &worker, outcome);
            });
        match spawned {
            Ok(_) => {
                slot.running = Some(Arc::clone(&started));
                #[cfg(test)]
                if let Ok(mut counts) = self.runs_by_probe.lock() {
                    *counts.entry(probe).or_default() += 1;
                }
                Pending(PendingState::Running(started))
            }
            Err(error) => Pending(PendingState::Done(Err(format!(
                "WSL guest observation could not start: {error}"
            )))),
        }
    }
}

/// Hand the outcome to the run's waiters, then publish it to the table. The two
/// mutexes are taken one after the other, never together.
fn finish<V>(
    table: &Mutex<HashMap<SlotKey, Slot<V>>>,
    key: &SlotKey,
    run: &Arc<Run<V>>,
    outcome: Outcome<V>,
) {
    match run.outcome.lock_or_err() {
        Ok(mut slot) => *slot = Some(outcome.clone()),
        Err(error) => {
            // Waiters then fail closed at their own deadline.
            tracing::warn!(%error, "WSL guest observation outcome could not be delivered");
        }
    }
    run.finished.notify_all();
    let Ok(mut slots) = table.lock_or_err() else {
        return;
    };
    let Some(slot) = slots.get_mut(key) else {
        return;
    };
    if slot
        .running
        .as_ref()
        .is_some_and(|running| Arc::ptr_eq(running, run))
    {
        slot.running = None;
    }
    // A boundary-bound run can start after a polling run and finish first. The
    // newer start wins, so the table never moves back to an older view.
    if slot
        .completed
        .as_ref()
        .is_none_or(|(started_at, _)| *started_at <= run.started_at)
    {
        slot.completed = Some((run.started_at, outcome));
    }
}

#[cfg(test)]
mod tests;
