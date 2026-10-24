//! Heuristic evidence that Claude/Codex/Grok actually ran in a local environment
//! (ADR-0330). Missing-integration notices are limited to these targets so
//! unused CLIs and idle WSL distributions never raise one.
use std::collections::{BTreeSet, HashSet};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::constants::{
    AGENT_USAGE_MAX_OBSERVATIONS as MAX_OBSERVATIONS, AGENT_USAGE_MAX_TARGETS as MAX_TARGETS,
};
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::{InitialExecutionHost, TerminalSession};

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
        "Grok" => Some("grok"),
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
    /// Wakes the notice when a new observation arrives. The detection path may
    /// hold other locks, so the hint is emitted on a separate thread.
    notifier: OnceLock<Sender<()>>,
}

/// Coalesces a burst of first sightings into one hint.
const NOTIFY_COALESCE: Duration = Duration::from_millis(100);

impl AgentUsage {
    /// Start the hint thread once; later calls are ignored.
    pub fn start_notifier(&self, notify: impl Fn() + Send + 'static) {
        self.start_notifier_with(NOTIFY_COALESCE, notify);
    }

    fn start_notifier_with(&self, coalesce: Duration, notify: impl Fn() + Send + 'static) {
        let (sender, receiver) = channel::<()>();
        if self.notifier.set(sender).is_err() {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("agent-usage-notifier".into())
            .spawn(move || {
                while receiver.recv().is_ok() {
                    std::thread::sleep(coalesce);
                    while receiver.try_recv().is_ok() {}
                    notify();
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "Could not start the agent usage notifier");
        }
    }

    /// Record one (terminal, provider) observation from the detection path.
    pub fn observe(&self, terminal_id: &str, app_name: &str) {
        let Some(provider) = provider(app_name) else {
            return;
        };
        {
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
        if let Some(notifier) = self.notifier.get() {
            let _ = notifier.send(());
        }
    }

    /// A closed terminal's observations stop counting toward the bound;
    /// resolved targets stay for the app run.
    pub fn forget(&self, terminal_id: &str) {
        if let Ok(mut registry) = self.registry.lock_or_err() {
            registry.seen.retain(|(id, _)| id != terminal_id);
            registry.pending.retain(|(id, _)| id != terminal_id);
        }
    }

    pub fn has_pending(&self, terminal_id: &str) -> bool {
        self.registry
            .lock_or_err()
            .is_ok_and(|registry| registry.pending.iter().any(|(id, _)| id == terminal_id))
    }

    /// Copy, not take: a distribution report racing with resolution must still
    /// find the observation pending.
    fn pending_snapshot(&self) -> Result<Vec<(String, &'static str)>, AppError> {
        Ok(self.registry.lock_or_err()?.pending.clone())
    }

    /// `environments[i]` belongs to `pending[i]`; `None` (session not
    /// registered yet) and `Pending` stay queued, since a closed terminal is
    /// already removed by `forget`.
    fn settle(
        &self,
        pending: Vec<(String, &'static str)>,
        environments: Vec<Option<Environment>>,
    ) -> Result<Vec<UsageTarget>, AppError> {
        let mut registry = self.registry.lock_or_err()?;
        for (key, environment) in pending.into_iter().zip(environments) {
            let distro = match environment {
                Some(Environment::Pending) | None => continue,
                Some(Environment::Native) => None,
                Some(Environment::Wsl(distro)) => Some(distro),
                Some(Environment::Excluded) => {
                    registry.pending.retain(|queued| *queued != key);
                    continue;
                }
            };
            registry.pending.retain(|queued| *queued != key);
            if registry.targets.len() < MAX_TARGETS {
                registry.targets.insert(UsageTarget {
                    provider: key.1.into(),
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
    let pending = state.agent_usage.pending_snapshot()?;
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
        let pending = usage.pending_snapshot().unwrap();
        assert_eq!(
            pending,
            vec![
                ("a".into(), "claude"),
                ("a".into(), "codex"),
                ("a".into(), "grok")
            ]
        );
        usage.observe("a", "Claude");
        assert_eq!(usage.pending_snapshot().unwrap().len(), 3);
    }

    #[test]
    fn settle_keeps_unresolved_terminals_queued_and_drops_excluded_ones() {
        let usage = AgentUsage::default();
        for id in ["native", "wsl", "pending", "ssh", "unregistered"] {
            usage.observe(id, "Claude");
        }
        let pending = usage.pending_snapshot().unwrap();
        let targets = usage
            .settle(
                pending,
                vec![
                    Some(Environment::Native),
                    Some(Environment::Wsl("Ubuntu".into())),
                    Some(Environment::Pending),
                    Some(Environment::Excluded),
                    // Spawned but not registered in `terminals` yet.
                    None,
                ],
            )
            .unwrap();
        assert_eq!(
            targets,
            vec![target("claude", None), target("claude", Some("Ubuntu"))]
        );
        assert!(usage.has_pending("pending"));
        assert!(usage.has_pending("unregistered"));
        assert!(!usage.has_pending("ssh"));
        assert!(!usage.has_pending("native"));
        assert_eq!(usage.pending_snapshot().unwrap().len(), 2);
    }

    #[test]
    fn a_distribution_report_during_resolution_still_finds_the_observation() {
        let usage = AgentUsage::default();
        usage.observe("wsl", "Codex");
        let pending = usage.pending_snapshot().unwrap();
        // The shell reports its distribution between snapshot and settle.
        assert!(usage.has_pending("wsl"));
        usage
            .settle(pending, vec![Some(Environment::Pending)])
            .unwrap();
        assert!(usage.has_pending("wsl"));
    }

    #[test]
    fn closing_a_terminal_frees_its_observations_but_keeps_resolved_targets() {
        let usage = AgentUsage::default();
        usage.observe("a", "Claude");
        let pending = usage.pending_snapshot().unwrap();
        usage
            .settle(pending, vec![Some(Environment::Native)])
            .unwrap();
        usage.observe("b", "Codex");
        usage.forget("a");
        usage.forget("b");
        assert!(usage.pending_snapshot().unwrap().is_empty());
        assert!(usage.registry.lock().unwrap().seen.is_empty());
        assert_eq!(usage.targets().unwrap(), vec![target("claude", None)]);
    }

    #[test]
    fn a_new_observation_wakes_the_notice_once_per_burst() {
        let usage = AgentUsage::default();
        let (sender, receiver) = std::sync::mpsc::channel();
        // A long window keeps the burst inside it even under test load.
        usage.start_notifier_with(Duration::from_secs(1), move || {
            let _ = sender.send(());
        });
        usage.observe("a", "Claude");
        usage.observe("a", "Codex");
        usage.observe("a", "Claude");
        assert!(receiver.recv_timeout(Duration::from_secs(10)).is_ok());
        assert!(receiver.recv_timeout(Duration::from_millis(300)).is_err());
        usage.observe("b", "vim");
        assert!(receiver.recv_timeout(Duration::from_millis(1500)).is_err());
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
