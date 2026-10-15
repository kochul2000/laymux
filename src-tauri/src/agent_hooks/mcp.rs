//! Laymux MCP registration (ADR-0325). Registration status follows the hook
//! inspection lifecycle (ADR-0324): checked once per app run at startup, on the
//! first view of a new target, and on explicit refresh or management. Opening
//! Settings reads the app-lifetime cache instead of touching files or WSL.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::Value;

use super::usage::{Integration, UsageTarget};
use super::{helper_directory, run_wsl_helper, MCP_WSL_TIMEOUT};
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

mod usage_check;
pub use usage_check::check_usage;

const MAX_TARGETS: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRequest {
    pub provider: String,
    pub operation: String,
    pub distro: Option<String>,
    /// CLI configuration folder (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`
    /// meaning). WSL `--exec` cannot see variables exported by shell profiles.
    pub config_dir: Option<String>,
    /// Status only: answer from this run's cache when the target was checked.
    #[serde(default)]
    pub cached: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Key {
    provider: String,
    distro: Option<String>,
    config_dir: Option<String>,
}

impl Key {
    fn new(provider: &str, distro: Option<&str>, config_dir: Option<&str>) -> Self {
        // Lookup key only; the original spelling is what the helper receives.
        let config_dir = config_dir.map(|path| {
            if cfg!(windows) && distro.is_none() {
                path.replace('\\', "/").trim_end_matches('/').to_lowercase()
            } else if path == "/" {
                path.into()
            } else {
                path.trim_end_matches('/').into()
            }
        });
        Self {
            provider: provider.into(),
            distro: distro.map(Into::into),
            config_dir,
        }
    }
}

#[derive(Default)]
struct Cache {
    warmed: bool,
    entries: HashMap<Key, Result<Value, String>>,
    /// Usage targets (ADR-0330) already checked once by the background pass.
    usage_checked: HashSet<Key>,
}

#[derive(Default)]
pub struct McpInspections {
    /// Serializes registration I/O; never held by a cache hit.
    gate: Mutex<()>,
    /// Leaf lock; never held during filesystem/process I/O.
    cache: Mutex<Cache>,
    /// One background usage pass at a time (ADR-0330).
    usage_running: AtomicBool,
    /// Set by each request; the running pass repeats while it is set.
    usage_rerun: AtomicBool,
}

impl McpInspections {
    fn gate(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.gate.lock_or_err()
    }
    fn get(&self, key: &Key) -> Result<Option<Result<Value, String>>, AppError> {
        Ok(self.cache.lock_or_err()?.entries.get(key).cloned())
    }
    fn record(&self, key: Key, result: &Result<Value, AppError>) -> Result<(), AppError> {
        let mut cache = self.cache.lock_or_err()?;
        // A bounded cache only skips memoizing extra custom folders; their
        // status is still answered, just checked again next time.
        if cache.entries.len() < MAX_TARGETS || cache.entries.contains_key(&key) {
            let result = match result {
                Ok(value) => Ok(value.clone()),
                Err(error) => Err(error.to_string()),
            };
            cache.entries.insert(key, result);
        }
        Ok(())
    }
    /// A failed change may still have been written (e.g. a timed-out WSL
    /// helper), so forget the target and check it again on the next view.
    fn invalidate(&self, key: &Key) -> Result<(), AppError> {
        self.cache.lock_or_err()?.entries.remove(key);
        Ok(())
    }
    pub(crate) fn warmed(&self) -> Result<bool, AppError> {
        Ok(self.cache.lock_or_err()?.warmed)
    }
    /// ADR-0330: only a successful "not registered" answer counts.
    pub(crate) fn registration_missing(
        &self,
        provider: &str,
        distro: Option<&str>,
    ) -> Result<bool, AppError> {
        Ok(matches!(
            self.get(&Key::new(provider, distro, None))?,
            Some(Ok(status)) if status["state"] == "missing"
        ))
    }
    fn claim_warm_up(&self) -> Result<bool, AppError> {
        let mut cache = self.cache.lock_or_err()?;
        Ok(!std::mem::replace(&mut cache.warmed, true))
    }
}

/// This build's registration: release and dev keep separate names so both can
/// stay registered side by side.
fn endpoint() -> (&'static str, u16) {
    use crate::automation_server::{automation_port, DEV_PORT};
    let port = automation_port();
    (
        if port == DEV_PORT {
            "laymux-dev"
        } else {
            "laymux"
        },
        port,
    )
}

fn config_dir(request: &McpRequest) -> Option<&str> {
    request
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub fn manage(
    request: &McpRequest,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    if !laymux_agent_hook::mcp::PROVIDERS.contains(&request.provider.as_str())
        || !matches!(request.operation.as_str(), "status" | "install" | "remove")
        || (request.cached && request.operation != "status")
    {
        return Err(AppError::Other("Invalid MCP registration request".into()));
    }
    let dir = config_dir(request);
    // Reject partial or relative folders before they take the gate or a cache
    // slot (WSL paths are Linux paths).
    if let Some(dir) = dir {
        let absolute = match request.distro {
            Some(_) => dir.starts_with('/'),
            None => std::path::Path::new(dir).is_absolute(),
        };
        if !absolute {
            return Err(AppError::Other(
                "Configuration folder must be an absolute path".into(),
            ));
        }
    }
    let key = Key::new(&request.provider, request.distro.as_deref(), dir);
    let management = request.operation != "status";
    let result = manage_with(
        &state.agent_mcp_inspections,
        key,
        request.cached,
        management,
        || run(request, dir, app),
    );
    if management && result.is_ok() {
        if dir.is_none() {
            let target = UsageTarget {
                provider: request.provider.clone(),
                distro: request.distro.clone(),
            };
            let removed = request.operation == "remove";
            state
                .agent_usage
                .set_removed(Integration::Mcp, target, removed);
        }
        super::notify_inspection_needed(app);
    }
    result
}

fn manage_with(
    cache: &McpInspections,
    key: Key,
    cached: bool,
    management: bool,
    run: impl FnOnce() -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    let hit = |cache: &McpInspections| -> Result<Option<Result<Value, AppError>>, AppError> {
        Ok(cached
            .then(|| cache.get(&key))
            .transpose()?
            .flatten()
            .map(|hit| hit.map_err(AppError::Other)))
    };
    if let Some(hit) = hit(cache)? {
        return hit;
    }
    let _gate = cache.gate()?;
    // The startup check may have filled this target while we waited.
    if let Some(hit) = hit(cache)? {
        return hit;
    }
    let result = run();
    if management && result.is_err() {
        cache.invalidate(&key)?;
    } else {
        cache.record(key, &result)?;
    }
    result
}

fn run(request: &McpRequest, dir: Option<&str>, app: &tauri::AppHandle) -> Result<Value, AppError> {
    let (name, port) = endpoint();
    match &request.distro {
        Some(distro) => {
            let port = port.to_string();
            let mut args = vec!["mcp", &request.provider, &request.operation, name, &port];
            args.extend(dir);
            run_wsl_helper(&helper_directory(app)?, distro, &args, MCP_WSL_TIMEOUT)
        }
        None => laymux_agent_hook::mcp::manage(
            &request.provider,
            &request.operation,
            name,
            port,
            dir.map(std::path::Path::new),
        )
        .map_err(AppError::Other),
    }
}

/// Startup check, once per app run (ADR-0324 lifecycle): default locations in
/// native and in WSL distributions already running. Stopped WSL is not started.
pub fn warm_up(state: &AppState, app: &tauri::AppHandle) -> Result<(), AppError> {
    let cache = &state.agent_mcp_inspections;
    if !cache.claim_warm_up()? {
        return Ok(());
    }
    let (name, port) = endpoint();
    #[allow(unused_mut)] // WSL enumeration extends the list only on Windows.
    let mut distros = vec![None];
    // Enumeration failure only skips WSL; Settings can still check it explicitly.
    #[cfg(windows)]
    distros.extend(
        super::updates::running_distros()
            .unwrap_or_default()
            .into_iter()
            .map(Some),
    );
    let mut recorded = false;
    for distro in distros {
        let _gate = cache.gate()?;
        let keys: Vec<_> = laymux_agent_hook::mcp::PROVIDERS
            .iter()
            .map(|provider| Key::new(provider, distro.as_deref(), None))
            .collect();
        let mut unchecked = Vec::new();
        for key in keys {
            if cache.get(&key)?.is_none() {
                unchecked.push(key);
            }
        }
        if unchecked.is_empty() {
            continue;
        }
        let statuses = match &distro {
            None => Ok(laymux_agent_hook::mcp::status_all(name, port)),
            Some(distro) => helper_directory(app).and_then(|directory| {
                run_wsl_helper(
                    &directory,
                    distro,
                    &["mcp", "all", "status", name, &port.to_string()],
                    MCP_WSL_TIMEOUT,
                )
            }),
        };
        for key in unchecked {
            cache.record(key.clone(), &split(&statuses, &key.provider))?;
        }
        recorded = true;
    }
    // Usage targets judged before this finished need a refreshed notice (ADR-0330).
    if recorded {
        super::notify_inspection_needed(app);
    }
    Ok(())
}

fn split(statuses: &Result<Value, AppError>, provider: &str) -> Result<Value, AppError> {
    let statuses = statuses
        .as_ref()
        .map_err(|e| AppError::Other(e.to_string()))?;
    match statuses.get(provider) {
        Some(status) => match status["error"].as_str() {
            Some(error) => Err(AppError::Other(error.into())),
            None => Ok(status.clone()),
        },
        None => Err(AppError::Other(
            "MCP status missing from helper output".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn key(dir: Option<&str>) -> Key {
        Key::new("codex", None, dir)
    }

    #[test]
    fn cached_status_reuses_one_check_until_explicit_refresh() {
        let cache = McpInspections::default();
        let calls = Cell::new(0);
        let run = || {
            calls.set(calls.get() + 1);
            Ok(json!({"state": "installed", "n": calls.get()}))
        };
        assert_eq!(
            manage_with(&cache, key(None), true, false, run).unwrap()["n"],
            1
        );
        assert_eq!(
            manage_with(&cache, key(None), true, false, run).unwrap()["n"],
            1
        );
        // Refresh and management always do I/O and update the cache.
        assert_eq!(
            manage_with(&cache, key(None), false, false, run).unwrap()["n"],
            2
        );
        assert_eq!(
            manage_with(&cache, key(None), true, false, run).unwrap()["n"],
            2
        );
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn failures_are_cached_like_hook_inspections() {
        let cache = McpInspections::default();
        let calls = Cell::new(0);
        let run = || {
            calls.set(calls.get() + 1);
            Err(AppError::Other("WSL helper failed".into()))
        };
        assert!(manage_with(&cache, key(None), true, false, run).is_err());
        assert!(manage_with(&cache, key(None), true, false, run).is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn failed_management_forgets_the_target_instead_of_caching_the_error() {
        let cache = McpInspections::default();
        let ok = || Ok(json!({"state": "installed"}));
        manage_with(&cache, key(None), true, false, ok).unwrap();
        let failed = || Err(AppError::Other("changed concurrently".into()));
        assert!(manage_with(&cache, key(None), false, true, failed).is_err());
        let calls = Cell::new(0);
        let recheck = || {
            calls.set(calls.get() + 1);
            Ok(json!({"state": "missing"}))
        };
        let status = manage_with(&cache, key(None), true, false, recheck).unwrap();
        assert_eq!(
            (status["state"].as_str(), calls.get()),
            (Some("missing"), 1)
        );
    }

    #[test]
    fn windows_folder_spelling_shares_one_target() {
        if cfg!(windows) {
            assert_eq!(
                key(Some("C:\\Users\\Me\\.codex\\")),
                key(Some("c:/users/me/.codex"))
            );
        }
        assert_ne!(
            Key::new("codex", Some("Ubuntu"), Some("/home/Me")),
            Key::new("codex", Some("Ubuntu"), Some("/home/me"))
        );
    }

    #[test]
    fn registration_missing_needs_a_successful_missing_state() {
        let cache = McpInspections::default();
        assert!(!cache.registration_missing("codex", None).unwrap());
        cache
            .record(key(None), &Ok(json!({"state": "missing"})))
            .unwrap();
        assert!(cache.registration_missing("codex", None).unwrap());
        cache
            .record(key(None), &Ok(json!({"state": "different"})))
            .unwrap();
        assert!(!cache.registration_missing("codex", None).unwrap());
        cache
            .record(key(None), &Err(AppError::Other("x".into())))
            .unwrap();
        assert!(!cache.registration_missing("codex", None).unwrap());
    }

    #[test]
    fn warm_up_is_claimed_once_per_run() {
        let cache = McpInspections::default();
        assert!(cache.claim_warm_up().unwrap());
        assert!(!cache.claim_warm_up().unwrap());
    }

    #[test]
    fn helper_status_all_is_split_per_provider() {
        let statuses = Ok(json!({
            "claude": {"state": "installed"},
            "codex": {"error": "Invalid config.toml"},
        }));
        assert_eq!(split(&statuses, "claude").unwrap()["state"], "installed");
        assert!(split(&statuses, "codex")
            .unwrap_err()
            .to_string()
            .contains("Invalid"));
        assert!(split(&statuses, "grok").is_err());
        let failed = Err(AppError::Other("WSL helper failed".into()));
        assert!(split(&failed, "grok")
            .unwrap_err()
            .to_string()
            .contains("WSL helper"));
    }
}
