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
fn absent(root: &str) -> Value {
    json!({"configDir":root,"installed":false,"helperPresent":false,"ownedCommands":0,"disabled":false,"warning":null})
}
fn inspect(cache: &InspectionCache, req: &ManageRequest, status: Result<Value, AppError>) {
    cache.begin(req).unwrap();
    cache.record(req, &status).unwrap();
}
#[test]
fn hook_missing_requires_a_successful_default_inspection_without_ownership() {
    let cache = InspectionCache::default();
    assert!(!cache.hook_missing("codex", None).unwrap());
    inspect(&cache, &request(None, None), Ok(absent("/home/u/.codex")));
    assert!(cache.hook_missing("codex", None).unwrap());
    assert!(!cache.hook_missing("claude", None).unwrap());
    assert!(!cache.hook_missing("codex", Some("Ubuntu")).unwrap());

    let failed = InspectionCache::default();
    inspect(
        &failed,
        &request(None, None),
        Err(AppError::Other("x".into())),
    );
    assert!(!failed.hook_missing("codex", None).unwrap());

    let partial = InspectionCache::default();
    let mut stale = absent("/home/u/.codex");
    stale["helperPresent"] = json!(true);
    inspect(&partial, &request(None, None), Ok(stale));
    assert!(!partial.hook_missing("codex", None).unwrap());
}
#[test]
fn the_resolved_default_path_counts_as_the_default_folder() {
    let cache = InspectionCache::default();
    assert!(cache.is_default_folder(&request(None, None)).unwrap());
    assert!(!cache
        .is_default_folder(&request(Some("/home/u/.codex"), None))
        .unwrap());
    inspect(&cache, &request(None, None), Ok(absent("/home/u/.codex")));
    assert!(cache
        .is_default_folder(&request(Some("/home/u/.codex"), None))
        .unwrap());
    assert!(!cache
        .is_default_folder(&request(Some("/work/codex"), None))
        .unwrap());
    assert!(!cache
        .is_default_folder(&request(Some("/home/u/.codex"), Some("Ubuntu")))
        .unwrap());
}
#[test]
fn a_custom_folder_with_laymux_hooks_suppresses_the_default_missing_notice() {
    let cache = InspectionCache::default();
    inspect(&cache, &request(None, None), Ok(absent("/home/u/.codex")));
    inspect(
        &cache,
        &request(Some("/work/codex"), None),
        Ok(healthy("/work/codex")),
    );
    assert!(!cache.hook_missing("codex", None).unwrap());
    // Another environment's installation is not evidence for this one.
    inspect(
        &cache,
        &request(None, Some("Ubuntu")),
        Ok(absent("/home/u/.codex")),
    );
    assert!(cache.hook_missing("codex", Some("Ubuntu")).unwrap());
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
