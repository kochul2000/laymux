//! App-lifetime installation evidence, separate from live conversation evidence.
use super::ManageRequest;
use crate::{error::AppError, lock_ext::MutexExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::constants::AGENT_HOOK_INSPECTION_MAX_TARGETS as MAX_TARGETS;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct Target {
    pub provider: String,
    pub distro: Option<String>,
    pub config_dir: Option<String>,
}

impl Target {
    pub fn new(request: &ManageRequest) -> Self {
        Self {
            provider: request.provider.clone(),
            distro: request.distro.clone(),
            config_dir: request.config_dir.as_ref().map(|path| {
                if cfg!(windows) && request.distro.is_none() {
                    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
                } else {
                    if path == "/" {
                        path.clone()
                    } else {
                        path.trim_end_matches('/').to_owned()
                    }
                }
            }),
        }
    }
}

struct Entry {
    /// Normalized keys must never become I/O paths: owned commands compare
    /// the original helper path exactly, even on Windows.
    request: ManageRequest,
    result: Option<Result<Value, String>>,
}

fn status_request(request: &ManageRequest) -> ManageRequest {
    ManageRequest {
        operation: "status".into(),
        ..request.clone()
    }
}

#[derive(Default)]
struct Cache {
    initialized: bool,
    entries: HashMap<Target, Entry>,
    aliases: HashMap<Target, Target>,
    announced: HashMap<Target, ManageRequest>,
    capacity_exceeded: bool,
    environment_error: Option<String>,
}

#[derive(Default)]
pub struct InspectionCache {
    /// Acquire before inspection/management I/O, never in the state reader.
    gate: Mutex<()>,
    /// Leaf lock; never held during filesystem/process I/O.
    cache: Mutex<Cache>,
}

impl InspectionCache {
    pub(crate) fn gate(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.gate.lock_or_err()
    }
    pub(crate) fn initialized(&self) -> Result<bool, AppError> {
        Ok(self.cache.lock_or_err()?.initialized)
    }
    pub(crate) fn initialize(&self) -> Result<(), AppError> {
        self.cache.lock_or_err()?.initialized = true;
        Ok(())
    }
    pub(crate) fn environment_error(&self, error: Option<String>) -> Result<(), AppError> {
        self.cache.lock_or_err()?.environment_error = error;
        Ok(())
    }
    pub(crate) fn discovered_requests(&self) -> Result<Vec<ManageRequest>, AppError> {
        Ok(self
            .cache
            .lock_or_err()?
            .announced
            .values()
            .cloned()
            .collect())
    }
    pub(crate) fn attempted(&self, request: &ManageRequest) -> Result<bool, AppError> {
        let cache = self.cache.lock_or_err()?;
        let target = Target::new(request);
        Ok(cache
            .entries
            .contains_key(cache.aliases.get(&target).unwrap_or(&target)))
    }
    pub(crate) fn announce(&self, request: &ManageRequest) -> Result<bool, AppError> {
        let mut cache = self.cache.lock_or_err()?;
        let target = Target::new(request);
        if cache
            .entries
            .contains_key(cache.aliases.get(&target).unwrap_or(&target))
            || cache.announced.contains_key(&target)
        {
            return Ok(false);
        }
        if cache.entries.len() + cache.announced.len() >= MAX_TARGETS {
            let first = !cache.capacity_exceeded;
            cache.capacity_exceeded = true;
            return Ok(first);
        }
        cache.announced.insert(target, status_request(request));
        Ok(true)
    }
    /// False is a bounded admission rejection, not a failed inspection.
    /// Callers must skip that new target while finishing already admitted work.
    pub(crate) fn begin(&self, request: &ManageRequest) -> Result<bool, AppError> {
        let mut cache = self.cache.lock_or_err()?;
        let target = Target::new(request);
        let key = cache.aliases.get(&target).cloned().unwrap_or(target);
        if !cache.entries.contains_key(&key) && cache.entries.len() >= MAX_TARGETS {
            cache.capacity_exceeded = true;
            cache.announced.remove(&key);
            return Ok(false);
        }
        // Keep the target's display/I/O spelling stable while an equivalent
        // path request is pending or fails.
        let io_request = cache
            .entries
            .get(&key)
            .map(|entry| entry.request.clone())
            .unwrap_or_else(|| status_request(request));
        cache.entries.insert(
            key.clone(),
            Entry {
                request: io_request,
                result: None,
            },
        );
        cache.announced.remove(&key);
        Ok(true)
    }
    pub(crate) fn record(
        &self,
        request: &ManageRequest,
        result: &Result<Value, AppError>,
    ) -> Result<Vec<Target>, AppError> {
        let mut cache = self.cache.lock_or_err()?;
        let target = Target::new(request);
        let previous = cache
            .aliases
            .get(&target)
            .cloned()
            .unwrap_or_else(|| target.clone());
        let canonical = result
            .as_ref()
            .ok()
            .and_then(|s| s["configDir"].as_str())
            .map(|path| {
                Target::new(&ManageRequest {
                    provider: request.provider.clone(),
                    operation: "status".into(),
                    distro: request.distro.clone(),
                    config_dir: Some(path.into()),
                })
            })
            .unwrap_or_else(|| previous.clone());
        let previous_entry = cache.entries.remove(&previous);
        let mut io_request = status_request(request);
        io_request.config_dir = result
            .as_ref()
            .ok()
            .and_then(|s| s["configDir"].as_str())
            .map(Into::into)
            .or_else(|| previous_entry.and_then(|entry| entry.request.config_dir))
            .or_else(|| request.config_dir.clone());
        cache.entries.insert(
            canonical.clone(),
            Entry {
                request: io_request,
                result: Some(
                    result
                        .as_ref()
                        .map(Clone::clone)
                        .map_err(ToString::to_string),
                ),
            },
        );
        for alias in cache.aliases.values_mut() {
            if *alias == previous {
                *alias = canonical.clone();
            }
        }
        if target != canonical {
            cache.aliases.insert(target.clone(), canonical.clone());
        }
        cache.announced.remove(&target);
        cache.announced.remove(&canonical);
        Ok(vec![target, canonical])
    }
    pub(crate) fn known_requests(&self) -> Result<Vec<ManageRequest>, AppError> {
        Ok(self
            .cache
            .lock_or_err()?
            .entries
            .values()
            .map(|entry| entry.request.clone())
            .collect())
    }
    pub(crate) fn enabled(
        &self,
        provider: &str,
        distro: Option<&str>,
        config_dir: Option<&str>,
        title: bool,
    ) -> Result<bool, AppError> {
        let request = ManageRequest {
            provider: provider.into(),
            operation: "status".into(),
            distro: distro.map(Into::into),
            config_dir: config_dir.map(Into::into),
        };
        let cache = self.cache.lock_or_err()?;
        let target = Target::new(&request);
        let Some(entry) = cache
            .entries
            .get(cache.aliases.get(&target).unwrap_or(&target))
        else {
            return Ok(false);
        };
        let Some(Ok(value)) = &entry.result else {
            return Ok(false);
        };
        Ok(value["installed"] == true
            && value["disabled"] == false
            && value["warning"].is_null()
            && (!title
                || (value["titleBinding"]["configured"] == true
                    && value["titleBinding"]["warning"].is_null())))
    }
    pub(crate) fn snapshot(&self) -> Result<Value, AppError> {
        let cache = self.cache.lock_or_err()?;
        let mut targets = Vec::new();
        let mut errors = Vec::new();
        for (target, entry) in &cache.entries {
            match &entry.result {
                Some(Ok(status))=>targets.push(json!({"provider":target.provider,"distro":target.distro,"status":status})),
                _=>errors.push(json!({"provider":target.provider,"distro":target.distro,"configDir":entry.request.config_dir,"message":entry.result.as_ref().and_then(|r|r.as_ref().err()).map(String::as_str).unwrap_or("Hook installation inspection has not completed")})),
            }
        }
        if cache.capacity_exceeded {
            errors.push(json!({"provider":null,"distro":null,"configDir":null,"message":"Hook installation inspection target limit reached"}));
        }
        if let Some(message) = &cache.environment_error {
            errors.push(json!({"provider":null,"distro":null,"configDir":null,"message":message}));
        }
        targets.sort_by_key(|value| value.to_string());
        errors.sort_by_key(|value| value.to_string());
        Ok(json!({"targets":targets,"errors":errors}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(root: Option<&str>, distro: Option<&str>) -> ManageRequest {
        ManageRequest {
            provider: "codex".into(),
            operation: "status".into(),
            distro: distro.map(Into::into),
            config_dir: root.map(Into::into),
        }
    }
    fn healthy(root: &str) -> Value {
        json!({"configDir":root,"installed":true,"disabled":false,"warning":null,"titleBinding":{"configured":true,"warning":null}})
    }
    #[test]
    fn discovered_requests_preserve_the_original_io_path() {
        let cache = InspectionCache::default();
        let req = request(Some("D:/Mixed/CustomRoot"), None);
        cache.announce(&req).unwrap();
        assert_eq!(
            cache.discovered_requests().unwrap()[0].config_dir,
            req.config_dir
        );
    }
    #[cfg(windows)]
    #[test]
    fn equivalent_path_error_keeps_the_targets_original_spelling() {
        let cache = InspectionCache::default();
        let original = request(Some("D:/Mixed/CustomRoot"), None);
        let equivalent = request(Some("d:\\mixed\\customroot\\"), None);
        cache.begin(&original).unwrap();
        cache
            .record(&original, &Err(AppError::Other("first error".into())))
            .unwrap();
        cache.begin(&equivalent).unwrap();
        cache
            .record(&equivalent, &Err(AppError::Other("second error".into())))
            .unwrap();
        assert_eq!(
            cache.snapshot().unwrap()["errors"][0]["configDir"],
            "D:/Mixed/CustomRoot"
        );
        assert_eq!(
            cache.known_requests().unwrap()[0].config_dir,
            original.config_dir
        );
    }
    #[cfg(windows)]
    #[test]
    fn cached_custom_root_without_recent_observation_preserves_real_owned_handlers() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("MixedCaseConfig");
        let source = fixture.path().join("laymux-agent-hook.exe");
        std::fs::write(&source, b"inspection fixture helper").unwrap();
        let manage = |root: &std::path::Path, operation| {
            laymux_agent_hook::install::manage(root, "codex", operation, &source).unwrap()
        };
        let installed = manage(&root, "install");
        assert_eq!(installed["installed"], true);
        let cache = InspectionCache::default();
        let req = request(root.to_str(), None);
        cache.begin(&req).unwrap();
        cache.record(&req, &Ok(installed)).unwrap();
        let remembered = cache.known_requests().unwrap().remove(0);
        let remembered_root = std::path::PathBuf::from(remembered.config_dir.unwrap());
        let status = manage(&remembered_root, "status");
        assert_eq!(
            status["installed"], true,
            "cached inspection must retain command ownership"
        );
        assert_eq!(status["registered"], 10);
        assert_eq!(status["ownedCommands"], 10);
        let updated = manage(&remembered_root, "update");
        assert_eq!(updated["registered"], 10);
        assert_eq!(updated["ownedCommands"], 10);
        let removed = manage(&remembered_root, "remove");
        assert_eq!(removed["registered"], 0);
        assert_eq!(removed["ownedCommands"], 0);
        assert_eq!(manage(&root, "status")["registered"], 0);
    }
    #[test]
    fn installed_evidence_is_reused_and_default_roots_alias_the_resolved_directory() {
        let cache = InspectionCache::default();
        let req = request(None, Some("Ubuntu"));
        assert!(!cache
            .enabled("codex", Some("Ubuntu"), Some("/home/u/.codex"), true)
            .unwrap());
        cache.begin(&req).unwrap();
        cache.record(&req, &Ok(healthy("/home/u/.codex"))).unwrap();
        for _ in 0..20 {
            assert!(cache
                .enabled("codex", Some("Ubuntu"), Some("/home/u/.codex"), true)
                .unwrap());
        }
        assert!(cache
            .attempted(&request(Some("/home/u/.codex"), Some("Ubuntu")))
            .unwrap());
        assert!(!cache
            .announce(&request(Some("/home/u/.codex"), Some("Ubuntu")))
            .unwrap());
        assert!(!cache
            .enabled("codex", Some("Debian"), Some("/home/u/.codex"), true)
            .unwrap());
    }
    #[test]
    fn explicit_reinspection_invalidates_the_previous_eligibility_before_io() {
        let cache = InspectionCache::default();
        let req = request(None, None);
        cache.begin(&req).unwrap();
        cache.record(&req, &Ok(healthy("/root"))).unwrap();
        cache.begin(&req).unwrap();
        assert!(!cache.enabled("codex", None, Some("/root"), false).unwrap());
        cache
            .record(&req, &Err(AppError::Other("timeout".into())))
            .unwrap();
        assert!(cache.attempted(&request(Some("/root"), None)).unwrap());
        assert!(!cache.enabled("codex", None, Some("/root"), false).unwrap());
        assert_eq!(
            cache.snapshot().unwrap()["errors"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn discovery_is_once_per_target_and_case_sensitive_in_wsl() {
        let cache = InspectionCache::default();
        let req = request(Some("/Root"), Some("Ubuntu"));
        assert!(cache.announce(&req).unwrap());
        assert!(!cache.announce(&req).unwrap());
        assert!(cache
            .announce(&request(Some("/root"), Some("Ubuntu")))
            .unwrap());
        cache.begin(&req).unwrap();
        cache
            .record(&req, &Err(AppError::Other("timeout".into())))
            .unwrap();
        assert!(!cache.announce(&req).unwrap());
    }
}
