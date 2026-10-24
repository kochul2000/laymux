use super::*;
use crate::agent_hooks::inspections::{InspectionCache, Target};

pub(super) fn run(
    cache: &InspectionCache,
    observations: &[Value],
    used: &[ManageRequest],
    automatic: bool,
    mut enumerate: impl FnMut() -> Result<Vec<String>, AppError>,
    mut inspect: impl FnMut(&ManageRequest, Duration) -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    let _gate = cache.gate()?;
    let deadline = Instant::now() + AUDIT_BUDGET;
    let first = !cache.initialized()?;
    let mut discovered = cache.discovered_requests()?;
    discovered.extend(used.iter().cloned());
    // Preserve new discovery even if its diagnostic observation expires while
    // another inspection holds the gate.
    for entry in observations {
        let (Some(provider @ ("claude" | "codex" | "grok")), Some(root)) =
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
                if !cache.begin(&request)? {
                    continue;
                }
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
    cache.initialize()?;
    let mut planned = Vec::new();
    for request in unchecked {
        if cache.begin(&request)? {
            planned.push(request);
        }
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
    fn full_cache_skips_overflow_without_leaving_healthy_targets_pending() {
        let cache = InspectionCache::default();
        // Use each request's literal root as the returned status path so a
        // capacity reservation cannot disappear through a default-root alias.
        for provider in ["claude", "codex", "grok"] {
            let r = ManageRequest {
                provider: provider.into(),
                operation: "status".into(),
                distro: None,
                config_dir: None,
            };
            cache.begin(&r).unwrap();
            cache
                .record(
                    &r,
                    &Ok(json!({"installed":true,"disabled":false,"warning":null})),
                )
                .unwrap();
        }
        for index in 0..crate::constants::AGENT_HOOK_INSPECTION_MAX_TARGETS - 3 {
            let r = ManageRequest {
                provider: "codex".into(),
                operation: "status".into(),
                distro: None,
                config_dir: Some(format!("/cached/{index}")),
            };
            cache.begin(&r).unwrap();
            cache.record(&r, &Ok(healthy(&r))).unwrap();
        }
        cache.initialize().unwrap();
        let calls = Cell::new(0);
        let observed = vec![json!({"provider":"codex","configDir":"/overflow"})];
        let result=run(&cache, &observed, &[], false,||Ok(Vec::new()),|r,_| {
            assert_ne!(r.config_dir.as_deref(),Some("/overflow"));calls.set(calls.get()+1);
            Ok(json!({"configDir":r.config_dir,"installed":true,"disabled":false,"warning":null}))
        }).unwrap();
        assert_eq!(
            calls.get(),
            crate::constants::AGENT_HOOK_INSPECTION_MAX_TARGETS
        );
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert!(cache.enabled("claude", None, None, false).unwrap());
        assert!(cache.enabled("grok", None, None, false).unwrap());
        assert!(cache
            .enabled("codex", None, Some("/cached/0"), false)
            .unwrap());
        assert!(!cache
            .enabled("codex", None, Some("/overflow"), false)
            .unwrap());
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
        run(&cache, &[], &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 3);
        for _ in 0..20 {
            run(&cache, &[], &[], true, enumerate, inspect).unwrap();
        }
        assert_eq!(calls.get(), 3);
        assert_eq!(enumerations.get(), 1);
        let observed = vec![json!({"provider":"codex","configDir":"/new"})];
        run(&cache, &observed, &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 4);
        run(&cache, &observed, &[], false, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 8);
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
        run(&cache, &[], &[], true, || Ok(Vec::new()), inspect).unwrap();
        let result = run(
            &cache,
            &[],
            &[],
            true,
            || panic!("no repeated enumeration"),
            inspect,
        )
        .unwrap();
        assert_eq!(calls.get(), 3);
        assert_eq!(result["errors"].as_array().unwrap().len(), 3);
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
        run(&cache, &[], &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 6);
        let observed = vec![json!({"provider":"codex","distro":"Ubuntu","configDir":"/codex"})];
        for _ in 0..20 {
            run(&cache, &observed, &[], true, enumerate, inspect).unwrap();
        }
        assert_eq!(calls.get(), 6);
        assert_eq!(enumerations.get(), 1);
        let stopped = vec![json!({"provider":"codex","distro":"Stopped","configDir":"/custom"})];
        run(&cache, &stopped, &[], true, enumerate, inspect).unwrap();
        run(&cache, &stopped, &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 6);
        assert_eq!(enumerations.get(), 2);
        let new = vec![json!({"provider":"codex","distro":"Ubuntu","configDir":"/new"})];
        run(&cache, &new, &[], true, enumerate, inspect).unwrap();
        assert_eq!(calls.get(), 7);
        assert_eq!(enumerations.get(), 3);
    }
    #[test]
    fn a_used_environment_default_folder_is_inspected_once_when_its_wsl_is_running() {
        let cache = InspectionCache::default();
        let inspected = std::cell::RefCell::new(Vec::new());
        let inspect = |r: &ManageRequest, _| {
            inspected.borrow_mut().push((
                r.provider.clone(),
                r.distro.clone(),
                r.config_dir.clone(),
            ));
            Ok(healthy(r))
        };
        run(&cache, &[], &[], true, || Ok(Vec::new()), inspect).unwrap();
        inspected.borrow_mut().clear();
        let used = [ManageRequest {
            provider: "claude".into(),
            operation: "status".into(),
            distro: Some("Ubuntu".into()),
            config_dir: None,
        }];
        let enumerate = || Ok(vec!["Ubuntu".into()]);
        run(&cache, &[], &used, true, enumerate, inspect).unwrap();
        let first = inspected.borrow().len();
        run(&cache, &[], &used, true, enumerate, inspect).unwrap();
        let inspected = inspected.borrow();
        assert_eq!(inspected.len(), first);
        let used = ("claude".to_string(), Some("Ubuntu".to_string()), None);
        assert_eq!(inspected.iter().filter(|r| **r == used).count(), 1);
    }
    #[test]
    fn discovery_during_io_is_not_lost_when_the_diagnostic_observation_expires() {
        let cache = InspectionCache::default();
        let count = Cell::new(0);
        run(
            &cache,
            &[],
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
