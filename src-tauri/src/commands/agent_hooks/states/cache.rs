//! Verified ownership is retained; reading it never renews its proof time.
use super::{HookStateSnapshot, Observation, TitleBinding};
use crate::activity::PtyCallbackState;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use laymux_agent_hook::runtime::ProcessIdentity;
use std::collections::{HashMap, HashSet};
use std::sync::{atomic::Ordering, Arc};

#[path = "root.rs"]
mod root;

#[derive(Clone)]
struct Binding {
    snapshot: HookStateSnapshot,
    root: ProcessIdentity,
    owner: ProcessIdentity,
    callback: Arc<PtyCallbackState>,
    epoch: u64,
    title: Option<TitleBinding>,
    event_at: u64,
    live: bool,
}

#[derive(Default)]
pub(crate) struct HookStateCache {
    bindings: HashMap<String, Binding>,
    attempts: HashMap<String, String>,
}

pub(super) fn now_ms() -> Result<u64, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64)
}

fn advance(binding: &mut Binding, observation: &Observation, now: u64) -> bool {
    let event = &observation.event;
    if event.config_dir != binding.snapshot.config_dir
        || event.event == "SessionEnd"
        || !root::identity(event).is_some_and(|p| root::same(&binding.root, p))
    {
        return false;
    }
    if observation.sequence > binding.snapshot.sequence {
        if let Some(phase) = observation.phase {
            binding.snapshot.state = phase;
            binding.snapshot.result = observation.result;
            binding.snapshot.task_id = observation.task.to_string();
            binding.snapshot.turn_id.clone_from(&observation.turn);
            binding.snapshot.sequence = observation.sequence;
            binding.snapshot.observed_at_ms = observation.phase_at_ms;
            if event.emitted_at_ms > binding.event_at {
                binding.event_at = event.emitted_at_ms;
                if event
                    .ancestors
                    .iter()
                    .any(|ancestor| root::same(&binding.owner, ancestor))
                {
                    binding.snapshot.verified_at_ms = event.emitted_at_ms.min(now);
                    binding.live = true;
                }
            }
        }
    }
    true
}

pub(super) fn read(
    state: &AppState,
    providers: &[String],
) -> Result<HashMap<String, HookStateSnapshot>, String> {
    let now = now_ms()?;
    // Never nest the cache/registry with catalog locks or I/O.
    let terminals = state
        .terminals
        .lock_or_err()?
        .iter()
        .map(|(id, s)| {
            (
                id.clone(),
                (s.codex_hook_title.clone(), s.agent_hook.clone()),
            )
        })
        .collect::<HashMap<_, _>>();
    let generations = state
        .pty_handles
        .lock_or_err()?
        .iter()
        .map(|(id, h)| (id.clone(), h.terminal_generation()))
        .collect::<HashMap<_, _>>();
    #[cfg(windows)]
    let distros: HashMap<_, _> = crate::wsl_probe::wsl_terminal_targets(
        state,
        std::time::Instant::now() + std::time::Duration::from_secs(1),
    )?
    .targets
    .into_iter()
    .collect();
    #[cfg(not(windows))]
    let distros: HashMap<String, Option<String>> = HashMap::new();
    let candidates = {
        let registry = state.agent_hook_observations.lock_or_err()?;
        terminals
            .iter()
            .map(|(id, (title, reported))| {
                let candidate = title
                    .identity
                    .as_deref()
                    .and_then(|identity| {
                        registry.by_codex_title(
                            identity,
                            distros.get(id).and_then(|d| d.as_deref()),
                            now,
                        )
                    })
                    .map(|o| o.event.clone())
                    .or_else(|| reported.clone());
                (id.clone(), candidate)
            })
            .collect::<HashMap<_, _>>()
    };
    let cached = state.agent_hook_bindings.lock_or_err()?.bindings.clone();
    let enabled = cached
        .iter()
        .map(|(id, b)| {
            state
                .agent_hook_inspections
                .enabled(
                    &b.snapshot.provider,
                    b.snapshot.distro.as_deref(),
                    b.snapshot.config_dir.as_deref(),
                    b.title.is_some(),
                )
                .map(|enabled| (id.clone(), enabled))
                .map_err(|e| e.to_string())
        })
        .collect::<Result<HashMap<_, _>, _>>()?;
    let observations = {
        let registry = state.agent_hook_observations.lock_or_err()?;
        cached
            .iter()
            .map(|(id, b)| {
                (
                    id.clone(),
                    registry
                        .binding(
                            &b.snapshot.provider,
                            &b.snapshot.session_id,
                            b.snapshot.distro.as_deref(),
                        )
                        .cloned(),
                )
            })
            .collect::<HashMap<_, _>>()
    };
    let mut pending = HashSet::new();
    let mut result = HashMap::new();
    let mut cache = state.agent_hook_bindings.lock_or_err()?;
    cache
        .bindings
        .retain(|id, b| generations.get(id) == Some(&b.snapshot.generation));
    cache.attempts.retain(|id, _| generations.contains_key(id));
    for (id, (title, _)) in &terminals {
        let event = candidates.get(id).and_then(Option::as_ref);
        let Some(generation) = generations.get(id) else {
            continue;
        };
        if let Some(binding) = cache.bindings.get_mut(id) {
            let replacement = event.as_ref().is_some_and(|e| {
                e.emitted_at_ms > binding.event_at
                    && (e.session_id != binding.snapshot.session_id
                        || e.provider != binding.snapshot.provider)
            });
            let title_matches = binding.snapshot.provider != "codex"
                || title
                    .identity
                    .as_deref()
                    .is_none_or(|identity| binding.snapshot.session_id.starts_with(identity));
            let domain_matches =
                binding.snapshot.distro.as_deref() == distros.get(id).and_then(|d| d.as_deref());
            let valid = !replacement
                && domain_matches
                && title_matches
                && enabled.get(id) == Some(&true)
                && binding.callback.detection_epoch.load(Ordering::Acquire) == binding.epoch
                && binding.title.as_ref().is_none_or(|proof| proof == title)
                && observations
                    .get(id)
                    .and_then(Option::as_ref)
                    .is_some_and(|o| advance(binding, o, now));
            if valid {
                if providers.contains(&binding.snapshot.provider) {
                    result.insert(id.clone(), binding.snapshot.clone());
                }
                continue;
            }
            binding.live = false;
            let key = format!(
                "invalid:{generation}:{:?}",
                observations
                    .get(id)
                    .and_then(Option::as_ref)
                    .map(|o| o.sequence)
            );
            if cache.attempts.get(id) != Some(&key) {
                cache.attempts.insert(id.clone(), key);
                pending.insert(id.clone());
            }
            continue;
        }
        // This is a request to verify, never permission to bind the reported id.
        // A changed candidate is retried once; failed reads do not spin at 2s.
        if let Some(event) = event.filter(|e| providers.contains(&e.provider)) {
            let key = format!(
                "{generation}:{}:{}:{:?}:{:?}",
                event.provider,
                event.session_id,
                event.config_dir,
                root::identity(event).map(|p| (p.pid, p.start_time))
            );
            if cache.attempts.get(id) != Some(&key) {
                cache.attempts.insert(id.clone(), key);
                pending.insert(id.clone());
            }
        }
    }
    drop(cache);
    state.activity_reconcile.request(pending);
    Ok(result)
}

pub(super) fn publish(
    state: &AppState,
    ids: &HashSet<String>,
    snapshots: &HashMap<String, HookStateSnapshot>,
) -> Result<(), String> {
    let callbacks = state.pty_callback_states.lock_or_err()?.clone();
    let titles = state
        .terminals
        .lock_or_err()?
        .iter()
        .map(|(id, s)| (id.clone(), s.codex_hook_title.clone()))
        .collect::<HashMap<_, _>>();
    let observations = {
        let registry = state.agent_hook_observations.lock_or_err()?;
        snapshots
            .iter()
            .filter_map(|(id, s)| {
                registry
                    .binding(&s.provider, &s.session_id, s.distro.as_deref())
                    .cloned()
                    .map(|o| (id.clone(), o))
            })
            .collect::<HashMap<_, _>>()
    };
    let events = observations
        .iter()
        .map(|(id, o)| (id.clone(), o.event.clone()))
        .collect();
    let owned = root::verify_many(state, &events)?;
    let mut verified = Vec::new();
    for (id, snapshot) in snapshots {
        let (Some(observation), Some(callback)) = (observations.get(id), callbacks.get(id)) else {
            continue;
        };
        let Some(root) = root::identity(&observation.event) else {
            continue;
        };
        let Some(owner) = owned.get(id) else { continue };
        verified.push((
            id.clone(),
            Binding {
                snapshot: snapshot.clone(),
                root: root.clone(),
                owner: owner.clone(),
                callback: callback.clone(),
                epoch: callback.detection_epoch.load(Ordering::Acquire),
                title: (snapshot.binding_source == "title")
                    .then(|| titles.get(id).cloned())
                    .flatten(),
                event_at: observation.event.emitted_at_ms,
                live: true,
            },
        ));
    }
    let handles = state.pty_handles.lock_or_err()?;
    let mut cache = state.agent_hook_bindings.lock_or_err()?;
    for id in ids {
        if let Some(b) = cache.bindings.get_mut(id) {
            b.live = false;
        }
    }
    for (id, binding) in verified {
        if handles
            .get(&id)
            .is_some_and(|h| h.terminal_generation() == binding.snapshot.generation)
            && binding.callback.detection_epoch.load(Ordering::Acquire) == binding.epoch
        {
            cache.bindings.insert(id, binding);
        }
    }
    let mut claims: HashMap<(String, String, Option<String>), usize> = HashMap::new();
    cache.bindings.retain(|id, b| {
        handles
            .get(id)
            .is_some_and(|h| h.terminal_generation() == b.snapshot.generation)
            && b.callback.detection_epoch.load(Ordering::Acquire) == b.epoch
    });
    for b in cache.bindings.values() {
        *claims
            .entry((
                b.snapshot.provider.clone(),
                b.snapshot.session_id.clone(),
                b.snapshot.distro.clone(),
            ))
            .or_default() += 1;
    }
    cache.bindings.retain(|_, b| {
        claims.get(&(
            b.snapshot.provider.clone(),
            b.snapshot.session_id.clone(),
            b.snapshot.distro.clone(),
        )) == Some(&1)
    });
    Ok(())
}

pub(crate) fn cached_liveness(state: &AppState, id: &str, generation: u64) -> Option<&'static str> {
    let now = now_ms().ok()?;
    let cache = state.agent_hook_bindings.lock_or_err().ok()?;
    let binding = cache.bindings.get(id)?;
    if !binding.live
        || binding.snapshot.generation != generation
        || binding.callback.detection_epoch.load(Ordering::Acquire) != binding.epoch
        || now.saturating_sub(binding.snapshot.verified_at_ms) > 60_000
    {
        return None;
    }
    match binding.snapshot.provider.as_str() {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
        "grok" => Some("Grok"),
        _ => None,
    }
}

pub(crate) fn suspend(state: &AppState, ids: &HashSet<String>) {
    if let Ok(mut cache) = state.agent_hook_bindings.lock_or_err() {
        for id in ids {
            if let Some(b) = cache.bindings.get_mut(id) {
                b.live = false;
            }
        }
    }
}

/// Hooks update previously verified roots even when no UI selected hook mode.
/// Incoming metadata can invalidate a binding but cannot establish a new one.
pub(crate) fn receive_hook_observation(
    state: &AppState,
    event: &laymux_agent_hook::runtime::HookEvent,
) {
    let Ok(now) = now_ms() else { return };
    let observation = state
        .agent_hook_observations
        .lock_or_err()
        .ok()
        .and_then(|registry| {
            registry
                .binding(&event.provider, &event.session_id, event.distro.as_deref())
                .cloned()
        });
    let Ok(mut cache) = state.agent_hook_bindings.lock_or_err() else {
        return;
    };
    let mut pending = Vec::new();
    for (id, binding) in &mut cache.bindings {
        if binding.snapshot.provider != event.provider
            || binding.snapshot.session_id != event.session_id
            || binding.snapshot.distro != event.distro
        {
            continue;
        }
        let valid = binding.callback.detection_epoch.load(Ordering::Acquire) == binding.epoch
            && observation
                .as_ref()
                .is_some_and(|o| advance(binding, o, now));
        if !valid {
            binding.live = false;
            pending.push(id.clone());
        }
    }
    drop(cache);
    state.activity_reconcile.request(pending);
}

pub(crate) fn cached_root_pid(
    state: &AppState,
    id: &str,
    generation: u64,
    provider: &str,
    distro: Option<&str>,
) -> Option<u32> {
    let now = now_ms().ok()?;
    let cache = state.agent_hook_bindings.lock_or_err().ok()?;
    let b = cache.bindings.get(id)?;
    (b.live
        && b.snapshot.generation == generation
        && b.snapshot.provider == provider
        && b.snapshot.distro.as_deref() == distro
        && b.callback.detection_epoch.load(Ordering::Acquire) == b.epoch
        && now.saturating_sub(b.snapshot.verified_at_ms) <= 60_000)
        .then_some(b.owner.pid)
}

#[cfg(test)]
mod tests;

pub(crate) fn forget(state: &AppState, id: &str, app: &str) {
    if let Ok(mut cache) = state.agent_hook_bindings.lock_or_err() {
        if cache
            .bindings
            .get(id)
            .is_some_and(|b| app.is_empty() || b.snapshot.provider.eq_ignore_ascii_case(app))
        {
            cache.bindings.remove(id);
        }
        cache.attempts.remove(id);
    }
}
