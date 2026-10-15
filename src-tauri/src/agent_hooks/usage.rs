//! Heuristic evidence that Claude/Codex actually ran in a local environment
//! (ADR-0330). Missing-integration notices are limited to these targets so
//! unused CLIs and idle WSL distributions never raise one.
use std::collections::{BTreeSet, HashSet};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::{InitialExecutionHost, TerminalSession};

const MAX_OBSERVATIONS: usize = 1024;
const MAX_TARGETS: usize = 64;

/// Provider and execution environment; the default configuration folder is
/// implied because heuristic detection never knows a custom folder.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct UsageTarget {
    pub provider: String,
    pub distro: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Integration {
    Hook,
    Mcp,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Environment {
    Native,
    Wsl(String),
    /// A WSL shell that has not reported its distribution yet.
    Pending,
    /// SSH or an unclassified host: the agent did not run on this machine.
    Excluded,
}

pub fn environment(session: &TerminalSession) -> Environment {
    match (session.initial_execution_host, &session.wsl_distro) {
        (InitialExecutionHost::DirectSsh, _) => Environment::Excluded,
        (_, Some(distro)) if crate::wsl_probe::is_safe_distro_name(distro) => {
            Environment::Wsl(distro.clone())
        }
        (_, Some(_)) => Environment::Excluded,
        (InitialExecutionHost::Wsl, None) => Environment::Pending,
        (InitialExecutionHost::NativeWindows | InitialExecutionHost::NonWindows, None) => {
            Environment::Native
        }
        (InitialExecutionHost::Unknown, None) => Environment::Excluded,
    }
}

fn provider(app_name: &str) -> Option<&'static str> {
    match app_name {
        "Claude" => Some("claude"),
        "Codex" => Some("codex"),
        _ => None,
    }
}

#[derive(Default)]
struct Registry {
    seen: HashSet<(String, &'static str)>,
    pending: Vec<(String, &'static str)>,
    targets: BTreeSet<UsageTarget>,
    removed: HashSet<(Integration, UsageTarget)>,
}

/// Leaf lock: never held while taking another `AppState` lock or doing I/O.
#[derive(Default)]
pub struct AgentUsage {
    registry: Mutex<Registry>,
}

impl AgentUsage {
    /// Record one (terminal, provider) observation from the detection path.
    pub fn observe(&self, terminal_id: &str, app_name: &str) {
        let Some(provider) = provider(app_name) else {
            return;
        };
        let Ok(mut registry) = self.registry.lock_or_err() else {
            return;
        };
        let key = (terminal_id.to_owned(), provider);
        if registry.seen.contains(&key) || registry.seen.len() >= MAX_OBSERVATIONS {
            return;
        }
        registry.seen.insert(key.clone());
        registry.pending.push(key);
    }

    pub fn has_pending(&self, terminal_id: &str) -> bool {
        self.registry
            .lock_or_err()
            .is_ok_and(|registry| registry.pending.iter().any(|(id, _)| id == terminal_id))
    }

    fn take_pending(&self) -> Result<Vec<(String, &'static str)>, AppError> {
        Ok(std::mem::take(&mut self.registry.lock_or_err()?.pending))
    }

    /// `environments[i]` belongs to `pending[i]`; `None` means the terminal
    /// closed before its environment was known, so the observation is dropped.
    fn settle(
        &self,
        pending: Vec<(String, &'static str)>,
        environments: Vec<Option<Environment>>,
    ) -> Result<Vec<UsageTarget>, AppError> {
        let mut registry = self.registry.lock_or_err()?;
        for ((terminal_id, provider), environment) in pending.into_iter().zip(environments) {
            let distro = match environment {
                Some(Environment::Native) => None,
                Some(Environment::Wsl(distro)) => Some(distro),
                Some(Environment::Pending) => {
                    registry.pending.push((terminal_id, provider));
                    continue;
                }
                Some(Environment::Excluded) | None => continue,
            };
            if registry.targets.len() < MAX_TARGETS {
                registry.targets.insert(UsageTarget {
                    provider: provider.into(),
                    distro,
                });
            }
        }
        Ok(registry.targets.iter().cloned().collect())
    }

    pub fn targets(&self) -> Result<Vec<UsageTarget>, AppError> {
        Ok(self
            .registry
            .lock_or_err()?
            .targets
            .iter()
            .cloned()
            .collect())
    }

    /// Explicit removal of the default-folder integration silences its notice
    /// until reinstalled or the app restarts.
    pub fn set_removed(&self, integration: Integration, target: UsageTarget, removed: bool) {
        if let Ok(mut registry) = self.registry.lock_or_err() {
            if removed {
                registry.removed.insert((integration, target));
            } else {
                registry.removed.remove(&(integration, target));
            }
        }
    }

    fn removed(&self, integration: Integration, target: &UsageTarget) -> Result<bool, AppError> {
        Ok(self
            .registry
            .lock_or_err()?
            .removed
            .contains(&(integration, target.clone())))
    }
}

/// Resolve pending observations without nesting the registry and `terminals`.
pub fn resolve(state: &AppState) -> Result<Vec<UsageTarget>, AppError> {
    let pending = state.agent_usage.take_pending()?;
    let environments = {
        let terminals = state.terminals.lock_or_err()?;
        pending
            .iter()
            .map(|(id, _)| terminals.get(id).map(environment))
            .collect()
    };
    state.agent_usage.settle(pending, environments)
}

/// Missing judgment from the app-lifetime caches only (ADR-0330).
pub fn missing(state: &AppState, targets: &[UsageTarget]) -> Result<Value, AppError> {
    let mut entries = Vec::new();
    for target in targets {
        let distro = target.distro.as_deref();
        let hook = state
            .agent_hook_inspections
            .hook_missing(&target.provider, distro)?
            && !state.agent_usage.removed(Integration::Hook, target)?;
        let mcp = state
            .agent_mcp_inspections
            .registration_missing(&target.provider, distro)?
            && !state.agent_usage.removed(Integration::Mcp, target)?;
        if hook || mcp {
            entries.push(
                json!({"provider":target.provider,"distro":target.distro,"hook":hook,"mcp":mcp}),
            );
        }
    }
    Ok(Value::Array(entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::TerminalConfig;

    fn session(host: InitialExecutionHost, distro: Option<&str>) -> TerminalSession {
        let mut session = TerminalSession::new("pane".into(), TerminalConfig::default());
        session.initial_execution_host = host;
        session.wsl_distro = distro.map(Into::into);
        session
    }

    fn target(provider: &str, distro: Option<&str>) -> UsageTarget {
        UsageTarget {
            provider: provider.into(),
            distro: distro.map(Into::into),
        }
    }

    #[test]
    fn environment_follows_reported_distro_then_initial_host() {
        use InitialExecutionHost::*;
        assert_eq!(
            environment(&session(NativeWindows, None)),
            Environment::Native
        );
        assert_eq!(environment(&session(NonWindows, None)), Environment::Native);
        assert_eq!(environment(&session(Wsl, None)), Environment::Pending);
        assert_eq!(
            environment(&session(Wsl, Some("Ubuntu"))),
            Environment::Wsl("Ubuntu".into())
        );
        // `wsl` started by hand inside a native shell reports its distribution.
        assert_eq!(
            environment(&session(NativeWindows, Some("Debian"))),
            Environment::Wsl("Debian".into())
        );
        assert_eq!(
            environment(&session(DirectSsh, None)),
            Environment::Excluded
        );
        assert_eq!(
            environment(&session(DirectSsh, Some("Ubuntu"))),
            Environment::Excluded
        );
        assert_eq!(environment(&session(Unknown, None)), Environment::Excluded);
        assert_eq!(
            environment(&session(Wsl, Some("bad/name"))),
            Environment::Excluded
        );
    }

    #[test]
    fn each_terminal_provider_pair_is_observed_once_and_other_apps_are_ignored() {
        let usage = AgentUsage::default();
        usage.observe("a", "Claude");
        usage.observe("a", "Claude");
        usage.observe("a", "Codex");
        usage.observe("a", "Grok");
        usage.observe("a", "vim");
        let pending = usage.take_pending().unwrap();
        assert_eq!(pending, vec![("a".into(), "claude"), ("a".into(), "codex")]);
        usage.observe("a", "Claude");
        assert!(usage.take_pending().unwrap().is_empty());
    }

    #[test]
    fn settle_keeps_pending_wsl_and_drops_closed_or_excluded_terminals() {
        let usage = AgentUsage::default();
        for id in ["native", "wsl", "pending", "ssh", "closed"] {
            usage.observe(id, "Claude");
        }
        let pending = usage.take_pending().unwrap();
        let targets = usage
            .settle(
                pending,
                vec![
                    Some(Environment::Native),
                    Some(Environment::Wsl("Ubuntu".into())),
                    Some(Environment::Pending),
                    Some(Environment::Excluded),
                    None,
                ],
            )
            .unwrap();
        assert_eq!(
            targets,
            vec![target("claude", None), target("claude", Some("Ubuntu"))]
        );
        assert!(usage.has_pending("pending"));
        assert!(!usage.has_pending("ssh"));
    }

    #[test]
    fn resolved_targets_outlive_their_terminal() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "pane".into(),
                session(InitialExecutionHost::NativeWindows, None),
            );
        }
        state.agent_usage.observe("pane", "Codex");
        assert_eq!(resolve(&state).unwrap(), vec![target("codex", None)]);
        state.terminals.lock().unwrap().remove("pane");
        assert_eq!(resolve(&state).unwrap(), vec![target("codex", None)]);
    }

    #[test]
    fn heuristic_detection_paths_record_usage() {
        let state = AppState::new();
        crate::activity::record_interactive_app_detection(&state, "a", "Claude");
        crate::activity::sync_known_caches(&state, "b", "Codex");
        assert!(state.agent_usage.has_pending("a"));
        assert!(state.agent_usage.has_pending("b"));
    }

    #[test]
    fn missing_lists_inspected_used_targets_except_explicit_removals() {
        let state = AppState::new();
        let request = crate::agent_hooks::ManageRequest {
            provider: "claude".into(),
            operation: "status".into(),
            distro: None,
            config_dir: None,
        };
        let cache = &state.agent_hook_inspections;
        cache.begin(&request).unwrap();
        cache
            .record(
                &request,
                &Ok(json!({"configDir":"/c","installed":false,"helperPresent":false,"ownedCommands":0})),
            )
            .unwrap();
        // Codex was never inspected, so it is not reported.
        let used = [target("claude", None), target("codex", None)];
        assert_eq!(
            missing(&state, &used).unwrap(),
            json!([{"provider":"claude","distro":null,"hook":true,"mcp":false}])
        );
        state
            .agent_usage
            .set_removed(Integration::Hook, target("claude", None), true);
        assert_eq!(missing(&state, &used).unwrap(), json!([]));
    }

    #[test]
    fn removal_is_tracked_per_integration_until_reinstalled() {
        let usage = AgentUsage::default();
        let claude = target("claude", None);
        usage.set_removed(Integration::Hook, claude.clone(), true);
        assert!(usage.removed(Integration::Hook, &claude).unwrap());
        assert!(!usage.removed(Integration::Mcp, &claude).unwrap());
        usage.set_removed(Integration::Hook, claude.clone(), false);
        assert!(!usage.removed(Integration::Hook, &claude).unwrap());
    }
}
