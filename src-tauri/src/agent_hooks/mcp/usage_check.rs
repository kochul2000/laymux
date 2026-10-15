//! Notice-only MCP checks of environments that ran Claude/Codex (ADR-0330).
use std::sync::atomic::Ordering;

use super::{manage_with, run, Key, McpInspections, McpRequest};
use crate::agent_hooks::usage::UsageTarget;
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

impl McpInspections {
    fn unchecked(&self, target: &UsageTarget) -> Result<bool, AppError> {
        let cache = self.cache.lock_or_err()?;
        let key = Key::new(&target.provider, target.distro.as_deref(), None);
        Ok(!cache.entries.contains_key(&key) && !cache.usage_checked.contains(&key))
    }
    /// Only an unchecked WSL target is worth a `wsl.exe` enumeration.
    fn needs_running_distros(&self, targets: &[UsageTarget]) -> Result<bool, AppError> {
        for target in targets.iter().filter(|target| target.distro.is_some()) {
            if self.unchecked(target)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// Usage targets still unchecked, claimed once each. WSL targets wait
    /// until their distribution is running so it is never started.
    fn claim_usage_checks(
        &self,
        targets: &[UsageTarget],
        running: &[String],
    ) -> Result<Vec<UsageTarget>, AppError> {
        let mut cache = self.cache.lock_or_err()?;
        let mut claimed = Vec::new();
        for target in targets {
            let key = Key::new(&target.provider, target.distro.as_deref(), None);
            if cache.entries.contains_key(&key)
                || cache.usage_checked.contains(&key)
                || target.distro.as_ref().is_some_and(|d| !running.contains(d))
            {
                continue;
            }
            cache.usage_checked.insert(key);
            claimed.push(target.clone());
        }
        Ok(claimed)
    }
}

/// Background pass for the default location of each usage target, once per
/// target and app run. A request arriving during a pass makes the owner run
/// again, so a target resolved meanwhile is not left unchecked. It never
/// delays the hook notice and hints it only when something was checked.
pub fn check_usage(state: &AppState, app: &tauri::AppHandle) -> Result<(), AppError> {
    let cache = &state.agent_mcp_inspections;
    cache.usage_rerun.store(true, Ordering::SeqCst);
    loop {
        if cache.usage_running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let mut checked: Result<bool, AppError> = Ok(false);
        while cache.usage_rerun.swap(false, Ordering::SeqCst) {
            checked = checked.and_then(|done| Ok(pass(state, app)? || done));
        }
        cache.usage_running.store(false, Ordering::SeqCst);
        if checked? {
            crate::agent_hooks::notify_inspection_needed(app);
        }
        // A request that saw the pass still running is served here.
        if !cache.usage_rerun.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
}

fn pass(state: &AppState, app: &tauri::AppHandle) -> Result<bool, AppError> {
    let cache = &state.agent_mcp_inspections;
    let targets = state.agent_usage.targets()?;
    #[allow(unused_mut)] // WSL enumeration fills the list only on Windows.
    let mut running = Vec::new();
    #[cfg(windows)]
    if cache.needs_running_distros(&targets)? {
        running = crate::agent_hooks::updates::running_distros().unwrap_or_default();
    }
    let claimed = cache.claim_usage_checks(&targets, &running)?;
    for target in &claimed {
        let request = McpRequest {
            provider: target.provider.clone(),
            operation: "status".into(),
            distro: target.distro.clone(),
            config_dir: None,
            cached: true,
        };
        let key = Key::new(&target.provider, target.distro.as_deref(), None);
        if let Err(error) = manage_with(cache, key, true, false, || run(&request, None, app)) {
            tracing::warn!(%error, provider = %target.provider, "MCP usage check failed");
        }
    }
    Ok(!claimed.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(distro: Option<&str>) -> UsageTarget {
        UsageTarget {
            provider: "codex".into(),
            distro: distro.map(Into::into),
        }
    }

    #[test]
    fn usage_checks_are_claimed_once_and_skip_cached_or_stopped_targets() {
        let cache = McpInspections::default();
        cache
            .record(Key::new("codex", Some("Cached"), None), &Ok(json!({})))
            .unwrap();
        let targets = [
            target(None),
            target(Some("Cached")),
            target(Some("Stopped")),
            target(Some("Ubuntu")),
        ];
        let running = ["Cached".to_string(), "Ubuntu".to_string()];
        assert_eq!(
            cache.claim_usage_checks(&targets, &running).unwrap(),
            vec![target(None), target(Some("Ubuntu"))]
        );
        assert!(cache
            .claim_usage_checks(&targets, &running)
            .unwrap()
            .is_empty());
        // A stopped distribution is checked once it is running.
        assert_eq!(
            cache
                .claim_usage_checks(&targets, &["Stopped".to_string()])
                .unwrap(),
            vec![target(Some("Stopped"))]
        );
    }

    #[test]
    fn wsl_is_enumerated_only_for_an_unchecked_wsl_target() {
        let cache = McpInspections::default();
        assert!(!cache.needs_running_distros(&[target(None)]).unwrap());
        assert!(cache
            .needs_running_distros(&[target(Some("Ubuntu"))])
            .unwrap());
        cache
            .record(Key::new("codex", Some("Ubuntu"), None), &Ok(json!({})))
            .unwrap();
        assert!(!cache
            .needs_running_distros(&[target(Some("Ubuntu"))])
            .unwrap());
    }
}
