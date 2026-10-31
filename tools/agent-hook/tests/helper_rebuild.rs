use laymux_agent_hook::install::{config_name, manage};
use std::{fs, path::PathBuf};

#[test]
#[ignore = "requires LAYMUX_TEST_HOOK_OLD and LAYMUX_TEST_HOOK_NEW released PE helper files"]
fn released_metadata_only_rebuild_is_current_and_detection_remains_read_only() {
    let old = PathBuf::from(std::env::var_os("LAYMUX_TEST_HOOK_OLD").expect("old helper path"));
    let new = PathBuf::from(std::env::var_os("LAYMUX_TEST_HOOK_NEW").expect("new helper path"));
    let old_bytes = fs::read(&old).unwrap();
    let new_bytes = fs::read(&new).unwrap();
    assert_ne!(
        old_bytes, new_bytes,
        "fixture must include a real rebuild difference"
    );
    for provider in ["claude", "codex", "grok"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("isolated-config");
        manage(&root, provider, "install", &old).unwrap();
        let config = root.join(config_name(provider).unwrap());
        let before = fs::read(&config).unwrap();
        let status = manage(&root, provider, "status", &new).unwrap();
        assert_eq!(status["installed"], true, "{provider}: {status}");
        assert_eq!(status["helperCurrent"], true, "{provider}: {status}");
        assert_eq!(status["updateRequired"], false, "{provider}: {status}");
        assert_eq!(fs::read(&config).unwrap(), before);
        assert_eq!(fs::read(&old).unwrap(), old_bytes);
        assert_eq!(fs::read(&new).unwrap(), new_bytes);
    }
}
