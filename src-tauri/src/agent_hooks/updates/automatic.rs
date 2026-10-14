use super::*;
use crate::agent_hooks::inspections::{InspectionCache, Target};

pub(super) fn run(
    cache: &InspectionCache,
    observations: &[Value],
    automatic: bool,
    mut enumerate: impl FnMut() -> Result<Vec<String>, AppError>,
    mut inspect: impl FnMut(&ManageRequest, Duration) -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    let _gate = cache.gate()?;
    let deadline = Instant::now() + AUDIT_BUDGET;
    let first = !cache.initialized()?;
    let mut discovered = cache.discovered_requests()?;
    // Preserve new discovery even if its diagnostic observation expires while
    // another inspection holds the gate.
    for entry in observations {
        let (Some(provider @ ("claude" | "codex")), Some(root)) =
            (entry["provider"].as_str(), entry["configDir"].as_str())
        else {
            continue;
        };
        if !root.is_empty() {
            discovered.push(ManageRequest {
                provider: provider.into(),
                operation: "status".into(),
                distro: entry["distro"].as_str().map(Into::into),
                config_dir: Some(root.into()),
            });
        }
    }
    let mut needs_wsl = false;
    for request in &discovered {
        if request.distro.is_some() && !cache.attempted(request)? {
            needs_wsl = true;
        }
    }
    let running = if first || !automatic || needs_wsl {
        match enumerate() {
            Ok(running) => {
                cache.environment_error(None)?;
                running
            }
            Err(error) => {
                cache.environment_error(Some(error.to_string()))?;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let mut planned = requests(&running, observations);
    discovered.extend(cache.known_requests()?);
    for request in discovered {
        if request
            .distro
            .as_ref()
            .is_some_and(|d| !running.contains(d))
        {
            // Do not start stopped WSL. A first discovery is still attempted,
            // so a repeated event cannot trigger unbounded enumeration retries.
            if !cache.attempted(&request)? {
                cache.begin(&request)?;
                cache.record(
                    &request,
                    &Err(AppError::Other(
                        "WSL hook target is not running or could not be enumerated; check manually"
                            .into(),
                    )),
                )?;
            }
            continue;
        }
        if !planned
            .iter()
            .any(|r| Target::new(r) == Target::new(&request))
        {
            planned.push(request);
        }
    }
    let mut unchecked = Vec::new();
    for request in planned {
        if !automatic || !cache.attempted(&request)? {
            unchecked.push(request);
        }
    }
    let planned = unchecked;
    cache.initialize()?;
    for request in &planned {
        cache.begin(request)?;
    }
    let mut completed = HashSet::new();
    scan_with_budget(
        &planned,
        || deadline.saturating_duration_since(Instant::now()),
        |request, timeout| {
            let result = inspect(request, timeout);
            completed.extend(cache.record(request, &result)?);
            result
        },
    );
    for request in &planned {
        if !completed.contains(&Target::new(request)) {
            cache.record(
                request,
                &Err(AppError::Other(
                    "Hook update check exceeded its time budget; target was not checked".into(),
                )),
            )?;
        }
    }
    cache.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn healthy(request: &ManageRequest) -> Value {
        json!({"configDir":request.config_dir.clone().unwrap_or_else(||format!("/{}",request.provider)),
            "installed":true,"disabled":false,"warning":null})
    }
    #[test]
    fn automatic_checks_once_then_only_new_targets_and_manual_forces_reinspection() {
        let cache = InspectionCache::default();
        let calls = Cell::new(0);
        let enumerations = Cell::new(0);
        let enumerate = || {
            enumerations.set(enumerations.get() + 1);
            Ok(Vec::new())
        };
        let inspect = |r: &ManageRequest, _| {
            calls.set(calls.get() + 1);
            Ok(healthy(r))
        };
        run(&cache, &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 2);
        for _ in 0..20 {
            run(&cache, &[], true, enumerate, inspect).unwrap();
        }
        assert_eq!(calls.get(), 2);
        assert_eq!(enumerations.get(), 1);
        let observed = vec![json!({"provider":"codex","configDir":"/new"})];
        run(&cache, &observed, true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 3);
        run(&cache, &observed, false, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 6);
        assert_eq!(enumerations.get(), 2);
    }
    #[test]
    fn failed_targets_are_not_automatically_retried() {
        let cache = InspectionCache::default();
        let calls = Cell::new(0);
        let inspect = |_: &ManageRequest, _| {
            calls.set(calls.get() + 1);
            Err(AppError::Other("invalid config".into()))
        };
        run(&cache, &[], true, || Ok(Vec::new()), inspect).unwrap();
        let result = run(
            &cache,
            &[],
            true,
            || panic!("no repeated enumeration"),
            inspect,
        )
        .unwrap();
        assert_eq!(calls.get(), 2);
        assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn wsl_checks_only_new_targets_and_never_starts_a_stopped_distribution() {
        let cache = InspectionCache::default();
        let calls = Cell::new(0);
        let enumerations = Cell::new(0);
        let enumerate = || {
            enumerations.set(enumerations.get() + 1);
            Ok(vec!["Ubuntu".into()])
        };
        let inspect = |r: &ManageRequest, _| {
            assert_ne!(r.distro.as_deref(), Some("Stopped"));
            calls.set(calls.get() + 1);
            Ok(healthy(r))
        };
        run(&cache, &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 4);
        let observed = vec![json!({"provider":"codex","distro":"Ubuntu","configDir":"/codex"})];
        for _ in 0..20 {
            run(&cache, &observed, true, enumerate, inspect).unwrap();
        }
        assert_eq!(calls.get(), 4);
        assert_eq!(enumerations.get(), 1);
        let stopped = vec![json!({"provider":"codex","distro":"Stopped","configDir":"/custom"})];
        run(&cache, &stopped, true, enumerate, inspect).unwrap();
        run(&cache, &stopped, true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 4);
        assert_eq!(enumerations.get(), 2);
        let new = vec![json!({"provider":"codex","distro":"Ubuntu","configDir":"/new"})];
        run(&cache, &new, true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 5);
        assert_eq!(enumerations.get(), 3);
    }
    #[test]
    fn discovery_during_io_is_not_lost_when_the_diagnostic_observation_expires() {
        let cache = InspectionCache::default();
        let count = Cell::new(0);
        run(
            &cache,
            &[],
            true,
            || Ok(Vec::new()),
            |r, _| {
                let new = ManageRequest {
                    provider: "codex".into(),
                    operation: "status".into(),
                    distro: None,
                    config_dir: Some("/late".into()),
                };
                cache.announce(&new).unwrap();
                Ok(healthy(r))
            },
        )
        .unwrap();
        run(
            &cache,
            &[],
            true,
            || panic!("native discovery needs no WSL enumeration"),
            |r, _| {
                assert_eq!(r.config_dir.as_deref(), Some("/late"));
                count.set(count.get() + 1);
                Ok(healthy(r))
            },
        )
        .unwrap();
        assert_eq!(count.get(), 1);
    }
}
