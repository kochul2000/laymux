use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Barrier;

use crate::constants::{WSL_AGENT_PROBE_TIMEOUT, WSL_GUEST_SNAPSHOT_MAX_AGE};

const LONG: Duration = Duration::from_secs(5);

fn key(distro: &str) -> GuestProbeKey {
    GuestProbeKey::new("test-probe", distro, Vec::new())
}

fn catalog(entries: &[(&str, u64)]) -> TerminalCatalog {
    TerminalCatalog(
        entries
            .iter()
            .map(|(id, generation)| ((*id).to_string(), *generation))
            .collect(),
    )
}

fn deadline() -> Instant {
    Instant::now() + LONG
}

#[test]
fn cached_display_reads_never_start_runs_and_cannot_cross_a_generation() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let both = catalog(&[("a", 1), ("b", 1)]);
    assert!(cache.cached_runs("test-probe", "Ubuntu", &both).is_empty());
    assert_eq!(cache.runs_started("test-probe"), 0);
    ask(
        &cache,
        key("Ubuntu"),
        &both,
        GuestObservation::starting_now(),
        counted(&runs, Duration::ZERO),
    )
    .unwrap();
    for _ in 0..360 {
        assert_eq!(
            *cache.cached_runs("test-probe", "Ubuntu", &catalog(&[("a", 1)]))[0]
                .1
                .as_ref()
                .unwrap()
                .as_ref(),
            1
        );
    }
    assert!(cache
        .cached_runs("test-probe", "Ubuntu", &catalog(&[("a", 2)]))
        .is_empty());
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    ask(
        &cache,
        key("Ubuntu"),
        &catalog(&[("a", 1)]),
        GuestObservation::starting_now(),
        counted(&runs, Duration::ZERO),
    )
    .unwrap();
    assert_eq!(
        *cache.cached_runs("test-probe", "Ubuntu", &catalog(&[("a", 1)]))[0]
            .1
            .as_ref()
            .unwrap()
            .as_ref(),
        2
    );
    assert_eq!(
        *cache.cached_runs("test-probe", "Ubuntu", &catalog(&[("b", 1)]))[0]
            .1
            .as_ref()
            .unwrap()
            .as_ref(),
        1
    );
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn refreshed_fallback_metadata_outlives_the_slots_original_creation_time() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let c = catalog(&[("a", 1)]);
    ask(
        &cache,
        key("Ubuntu"),
        &c,
        GuestObservation::starting_now(),
        |_| Ok(1),
    )
    .unwrap();
    {
        let mut slots = cache.slots.lock_or_err().unwrap();
        let slot = slots.get_mut(&(key("Ubuntu"), c.clone())).unwrap();
        // The slot was created at t=0, reobserved at t=120, then pruned at
        // t=181 by an unrelated request. Its latest view is still only 61s old.
        slot.retained_at = Instant::now() - Duration::from_secs(181);
        slot.completed.as_mut().unwrap().0 = Instant::now() - Duration::from_secs(61);
    }
    ask(
        &cache,
        key("Debian"),
        &c,
        GuestObservation::starting_now(),
        |_| Ok(2),
    )
    .unwrap();
    let retained = cache.cached_runs("test-probe", "Ubuntu", &c);
    assert_eq!(retained.len(), 1);
    assert_eq!(**retained[0].1.as_ref().unwrap(), 1);
}

#[test]
fn a_failed_newer_display_observation_never_falls_back_to_an_older_success() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let c = catalog(&[("a", 1)]);
    ask(
        &cache,
        key("Ubuntu"),
        &c,
        GuestObservation::starting_now(),
        |_| Ok(1),
    )
    .unwrap();
    ask(
        &cache,
        key("Ubuntu"),
        &c,
        GuestObservation::starting_now(),
        |_| Err("probe failure".into()),
    )
    .unwrap_err();
    assert_eq!(
        cache.cached_runs("test-probe", "Ubuntu", &c)[0]
            .1
            .as_ref()
            .unwrap_err(),
        "probe failure"
    );
    assert_eq!(cache.runs_started("test-probe"), 2);
}

#[test]
fn retaining_a_live_roots_metadata_never_renews_observation_freshness() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let c = catalog(&[("a", 1)]);
    ask(
        &cache,
        key("Ubuntu"),
        &c,
        GuestObservation::starting_now(),
        counted(&runs, Duration::ZERO),
    )
    .unwrap();
    let original = Instant::now() - crate::constants::ACTIVITY_DISPLAY_RETENTION - LONG;
    cache
        .slots
        .lock()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
        .completed
        .as_mut()
        .unwrap()
        .0 = original;
    assert!(cache.cached_runs("test-probe", "Ubuntu", &c).is_empty());
    let retained = cache
        .cached_run_for_verified_root("test-probe", "Ubuntu", &c, &[])
        .unwrap();
    assert_eq!(*retained.1.unwrap(), 1);
    assert!(
        cache.cached_runs("test-probe", "Ubuntu", &c).is_empty(),
        "retention is not a fresh observation"
    );
    assert_eq!(
        cache
            .slots
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .completed
            .as_ref()
            .unwrap()
            .0,
        original
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert!(cache
        .cached_run_for_verified_root("test-probe", "Ubuntu", &catalog(&[("a", 2)]), &[])
        .is_none());
    assert_eq!(
        ask(
            &cache,
            key("Ubuntu"),
            &c,
            GuestObservation::starting_now(),
            counted(&runs, Duration::ZERO)
        )
        .unwrap(),
        2
    );
}

/// One request answered to completion.
fn ask<F>(
    cache: &GuestSnapshots<usize>,
    key: GuestProbeKey,
    catalog: &TerminalCatalog,
    observation: GuestObservation,
    run: F,
) -> Result<usize, String>
where
    F: FnOnce(Duration) -> Result<usize, String> + Send + 'static,
{
    cache
        .request(key, catalog, observation, deadline(), run)
        .wait(deadline())
        .map(|value| *value)
}

/// A run that counts itself, takes `delay`, and answers with its own ordinal.
fn counted(
    runs: &Arc<AtomicUsize>,
    delay: Duration,
) -> impl FnOnce(Duration) -> Result<usize, String> + Send + 'static {
    let runs = Arc::clone(runs);
    move |_| {
        let ordinal = runs.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::sleep(delay);
        Ok(ordinal)
    }
}

/// The two bounds `WSL_GUEST_SNAPSHOT_MAX_AGE` documents.
#[test]
fn reusable_run_window_is_independent_of_metadata_wakeup() {
    // A polling caller that arrives while a run is still in flight must join
    // it; otherwise slow guests would grow a second run beside the first.
    assert!(WSL_GUEST_SNAPSHOT_MAX_AGE >= WSL_AGENT_PROBE_TIMEOUT);
    // Attribution polling must not lag the liveness verdict it is combined
    // with by more than one reconcile pass.
    assert!(WSL_GUEST_SNAPSHOT_MAX_AGE < crate::constants::ACTIVITY_FALLBACK_INTERVAL);
}

#[test]
fn concurrent_reusable_requests_share_one_run() {
    let cache = Arc::new(GuestSnapshots::<usize>::new(LONG, LONG));
    let runs = Arc::new(AtomicUsize::new(0));
    let start = Arc::new(Barrier::new(8));
    let catalog = catalog(&[("terminal-a", 1)]);
    let answers: Vec<_> = (0..8)
        .map(|_| {
            let (cache, runs, start, catalog) = (
                Arc::clone(&cache),
                Arc::clone(&runs),
                Arc::clone(&start),
                catalog.clone(),
            );
            std::thread::spawn(move || {
                start.wait();
                cache
                    .request(
                        key("Ubuntu"),
                        &catalog,
                        GuestObservation::Reusable,
                        deadline(),
                        counted(&runs, Duration::from_millis(200)),
                    )
                    .wait(deadline())
                    .map(|value| *value)
            })
        })
        .collect();
    for answer in answers {
        assert_eq!(answer.join().unwrap(), Ok(1));
    }
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn reusable_requests_reuse_a_finished_run_only_inside_the_window() {
    let cache = GuestSnapshots::<usize>::new(Duration::from_millis(150), LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let catalog = catalog(&[("terminal-a", 1)]);
    let ask = || {
        cache
            .request(
                key("Ubuntu"),
                &catalog,
                GuestObservation::Reusable,
                deadline(),
                counted(&runs, Duration::ZERO),
            )
            .wait(deadline())
            .map(|value| *value)
    };
    assert_eq!(ask(), Ok(1));
    assert_eq!(ask(), Ok(1));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(ask(), Ok(2));
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn a_boundary_is_never_answered_by_a_run_that_started_before_it() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let catalog = catalog(&[("terminal-a", 1)]);
    let ask = |observation| {
        cache
            .request(
                key("Ubuntu"),
                &catalog,
                observation,
                deadline(),
                counted(&runs, Duration::ZERO),
            )
            .wait(deadline())
            .map(|value| *value)
    };
    let before_first = Instant::now();
    assert_eq!(ask(GuestObservation::Reusable), Ok(1));
    // Inside the reuse window, yet the boundary is later than the run.
    let boundary = Instant::now();
    assert_eq!(ask(GuestObservation::StartedAfter(boundary)), Ok(2));
    // A run that started after the boundary serves it, and everyone older.
    assert_eq!(ask(GuestObservation::StartedAfter(boundary)), Ok(2));
    assert_eq!(ask(GuestObservation::StartedAfter(before_first)), Ok(2));
    assert_eq!(ask(GuestObservation::Reusable), Ok(2));
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn a_boundary_joins_only_runs_that_started_after_it() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let catalog = catalog(&[("terminal-a", 1)]);
    let polling = cache.request(
        key("Ubuntu"),
        &catalog,
        GuestObservation::Reusable,
        deadline(),
        counted(&runs, Duration::from_millis(300)),
    );
    std::thread::sleep(Duration::from_millis(50));
    let boundary = Instant::now();
    let persistence = cache.request(
        key("Ubuntu"),
        &catalog,
        GuestObservation::StartedAfter(boundary),
        deadline(),
        counted(&runs, Duration::from_millis(300)),
    );
    // A second boundary-bound reader after the same boundary joins that run.
    let sibling = cache.request(
        key("Ubuntu"),
        &catalog,
        GuestObservation::StartedAfter(boundary),
        deadline(),
        counted(&runs, Duration::ZERO),
    );
    assert_eq!(polling.wait(deadline()).map(|v| *v), Ok(1));
    assert_eq!(persistence.wait(deadline()).map(|v| *v), Ok(2));
    assert_eq!(sibling.wait(deadline()).map(|v| *v), Ok(2));
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn a_changed_catalog_starts_a_new_run_inside_the_window() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let ask = |catalog: &TerminalCatalog| {
        cache
            .request(
                key("Ubuntu"),
                catalog,
                GuestObservation::Reusable,
                deadline(),
                counted(&runs, Duration::ZERO),
            )
            .wait(deadline())
            .map(|value| *value)
    };
    let before = catalog(&[("terminal-a", 1)]);
    // Same id, new PTY generation: a respawn.
    let respawned = catalog(&[("terminal-a", 2)]);
    let added = catalog(&[("terminal-a", 2), ("terminal-b", 3)]);
    assert_eq!(ask(&before), Ok(1));
    assert_eq!(ask(&respawned), Ok(2));
    assert_eq!(ask(&added), Ok(3));
    assert_eq!(ask(&added), Ok(3));
    assert_eq!(runs.load(Ordering::SeqCst), 3);
}

#[test]
fn runs_are_shared_per_probe_distribution_and_argv() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let catalog = catalog(&[("terminal-a", 1)]);
    let ask = |key: GuestProbeKey| {
        cache
            .request(
                key,
                &catalog,
                GuestObservation::Reusable,
                deadline(),
                counted(&runs, Duration::ZERO),
            )
            .wait(deadline())
            .map(|value| *value)
    };
    assert_eq!(ask(key("Ubuntu")), Ok(1));
    assert_eq!(ask(key("Debian")), Ok(2));
    assert_eq!(
        ask(GuestProbeKey::new("test-probe", "Ubuntu", vec!["1".into()])),
        Ok(3)
    );
    assert_eq!(
        ask(GuestProbeKey::new("other-probe", "Ubuntu", Vec::new())),
        Ok(4)
    );
    assert_eq!(ask(key("Ubuntu")), Ok(1));
}

#[test]
fn a_waiter_keeps_its_own_deadline_and_the_run_still_publishes() {
    let cache = GuestSnapshots::<usize>::new(LONG, Duration::from_millis(1234));
    let runs = Arc::new(AtomicUsize::new(0));
    let given = Arc::new(Mutex::new(None));
    let catalog = catalog(&[("terminal-a", 1)]);
    let recorded = Arc::clone(&given);
    let counter = Arc::clone(&runs);
    let started = Instant::now();
    let short = cache.request(
        key("Ubuntu"),
        &catalog,
        GuestObservation::Reusable,
        started + Duration::from_millis(50),
        move |timeout| {
            *recorded.lock().unwrap() = Some(timeout);
            counter.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(400));
            Ok(7)
        },
    );
    assert_eq!(
        short.wait(started + Duration::from_millis(50)),
        Err(DEADLINE_EXPIRED.to_string())
    );
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "the waiter outlived its own deadline"
    );
    // The run is not cut to the starter's budget.
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(*given.lock().unwrap(), Some(Duration::from_millis(1234)));
    std::thread::sleep(Duration::from_millis(500));
    let later = cache
        .request(
            key("Ubuntu"),
            &catalog,
            GuestObservation::Reusable,
            deadline(),
            counted(&runs, Duration::ZERO),
        )
        .wait(deadline())
        .map(|value| *value);
    assert_eq!(later, Ok(7));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn failures_are_shared_like_answers_and_a_later_boundary_retries() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let catalog = catalog(&[("terminal-a", 1)]);
    let failing = |runs: &Arc<AtomicUsize>| {
        let runs = Arc::clone(runs);
        move |_| {
            runs.fetch_add(1, Ordering::SeqCst);
            Err::<usize, _>("guest unavailable".to_string())
        }
    };
    let unavailable = Err("guest unavailable".to_string());
    assert_eq!(
        ask(
            &cache,
            key("Ubuntu"),
            &catalog,
            GuestObservation::Reusable,
            failing(&runs)
        ),
        unavailable
    );
    // A broken guest is asked again only once the window has passed.
    assert_eq!(
        ask(
            &cache,
            key("Ubuntu"),
            &catalog,
            GuestObservation::Reusable,
            failing(&runs)
        ),
        unavailable
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(
        ask(
            &cache,
            key("Ubuntu"),
            &catalog,
            GuestObservation::starting_now(),
            counted(&runs, Duration::ZERO)
        ),
        Ok(2)
    );
}

#[test]
fn a_panicking_run_fails_closed_and_the_table_keeps_working() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let catalog = catalog(&[("terminal-a", 1)]);
    let answer = cache
        .request(
            key("Ubuntu"),
            &catalog,
            GuestObservation::Reusable,
            deadline(),
            |_| -> Result<usize, String> { panic!("parser bug") },
        )
        .wait(deadline());
    assert!(answer.unwrap_err().contains("panicked"));
    let runs = Arc::new(AtomicUsize::new(0));
    let recovered = cache
        .request(
            key("Ubuntu"),
            &catalog,
            GuestObservation::starting_now(),
            deadline(),
            counted(&runs, Duration::ZERO),
        )
        .wait(deadline())
        .map(|value| *value);
    assert_eq!(recovered, Ok(1));
}

#[test]
fn an_expired_deadline_never_starts_a_run() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let expired = Instant::now();
    let answer = cache
        .request(
            key("Ubuntu"),
            &catalog(&[("terminal-a", 1)]),
            GuestObservation::Reusable,
            expired,
            counted(&runs, Duration::ZERO),
        )
        .wait(expired);
    assert_eq!(answer, Err(DEADLINE_EXPIRED.to_string()));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}

#[test]
fn an_older_run_finishing_late_never_replaces_a_newer_answer() {
    let cache = GuestSnapshots::<usize>::new(LONG, LONG);
    let runs = Arc::new(AtomicUsize::new(0));
    let catalog = catalog(&[("terminal-a", 1)]);
    let slow = cache.request(
        key("Ubuntu"),
        &catalog,
        GuestObservation::Reusable,
        deadline(),
        counted(&runs, Duration::from_millis(300)),
    );
    std::thread::sleep(Duration::from_millis(30));
    let fast = cache.request(
        key("Ubuntu"),
        &catalog,
        GuestObservation::starting_now(),
        deadline(),
        counted(&runs, Duration::ZERO),
    );
    assert_eq!(fast.wait(deadline()).map(|v| *v), Ok(2));
    assert_eq!(slow.wait(deadline()).map(|v| *v), Ok(1));
    let latest = cache
        .request(
            key("Ubuntu"),
            &catalog,
            GuestObservation::Reusable,
            deadline(),
            counted(&runs, Duration::ZERO),
        )
        .wait(deadline())
        .map(|value| *value);
    assert_eq!(latest, Ok(2));
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn catalog_lists_every_pty_generation_in_a_stable_order() {
    let state = AppState::new();
    state.pty_handles.lock().unwrap().extend([
        (
            "terminal-b".to_string(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 9),
        ),
        (
            "terminal-a".to_string(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 4)
                .with_wsl_backed(true),
        ),
    ]);
    assert_eq!(
        TerminalCatalog::of(&state).unwrap(),
        catalog(&[("terminal-a", 4), ("terminal-b", 9)])
    );
    state.pty_handles.lock().unwrap().insert(
        "terminal-a".into(),
        crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 10)
            .with_wsl_backed(true),
    );
    assert_eq!(
        TerminalCatalog::of(&state).unwrap(),
        catalog(&[("terminal-a", 10), ("terminal-b", 9)])
    );
}
