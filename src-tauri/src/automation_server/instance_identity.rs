use std::path::Path;

use super::types::{HealthBuildKind, HealthInstanceIdentity};

pub fn current() -> HealthInstanceIdentity {
    compose(
        cfg!(debug_assertions),
        std::process::id(),
        std::env::current_exe().ok().as_deref(),
        non_empty(option_env!("LAYMUX_BUILD_WORKTREE_ROOT")),
        non_empty(option_env!("LAYMUX_BUILD_GIT_COMMIT")),
        non_empty(option_env!("LAYMUX_BUILD_GIT_BRANCH")),
    )
}

fn compose(
    is_dev: bool,
    pid: u32,
    executable_path: Option<&Path>,
    worktree_root: Option<&str>,
    git_commit: Option<&str>,
    git_branch: Option<&str>,
) -> HealthInstanceIdentity {
    HealthInstanceIdentity {
        pid,
        build_kind: if is_dev {
            HealthBuildKind::Dev
        } else {
            HealthBuildKind::Release
        },
        executable_path: is_dev
            .then(|| executable_path.map(|path| path.to_string_lossy().into_owned()))
            .flatten(),
        worktree_root: is_dev
            .then(|| worktree_root.map(ToOwned::to_owned))
            .flatten(),
        git_commit: git_commit.map(ToOwned::to_owned),
        git_branch: is_dev.then(|| git_branch.map(ToOwned::to_owned)).flatten(),
    }
}

fn non_empty(value: Option<&'static str>) -> Option<&'static str> {
    value.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_dev_identity_matches_the_running_test_binary_and_build_root() {
        let identity = current();
        let expected_executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let expected_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let direct_metadata = crate::build_metadata::discover(Path::new(&expected_root));

        assert_eq!(identity.pid, std::process::id());
        assert!(matches!(identity.build_kind, HealthBuildKind::Dev));
        assert_eq!(
            identity.executable_path.as_deref(),
            Some(expected_executable.as_str())
        );
        assert_eq!(
            identity.worktree_root.as_deref(),
            Some(expected_root.as_str())
        );
        assert_eq!(
            identity.git_commit.as_deref(),
            direct_metadata.git_commit.as_deref()
        );
        assert_eq!(
            identity.git_branch.as_deref(),
            direct_metadata.git_branch.as_deref()
        );
        if let Some(commit) = identity.git_commit {
            assert!(matches!(commit.len(), 40 | 64));
            assert!(commit.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
        if let Some(branch) = identity.git_branch {
            assert!(!branch.is_empty());
        }
    }

    #[test]
    fn dev_identity_exposes_local_paths_and_branch() {
        let identity = compose(
            true,
            42,
            Some(Path::new(r"D:\trees\laymux\target\debug\laymux.exe")),
            Some(r"D:\trees\laymux"),
            Some("0123456789abcdef"),
            Some("fix/625"),
        );

        assert_eq!(identity.pid, 42);
        assert!(matches!(identity.build_kind, HealthBuildKind::Dev));
        assert!(identity.executable_path.is_some());
        assert!(identity.worktree_root.is_some());
        assert_eq!(identity.git_branch.as_deref(), Some("fix/625"));
    }

    #[test]
    fn release_identity_redacts_local_paths_and_branch_but_keeps_commit() {
        let identity = compose(
            false,
            42,
            Some(Path::new(r"C:\Users\builder\target\release\laymux.exe")),
            Some(r"C:\Users\builder\private-checkout"),
            Some("0123456789abcdef"),
            Some("users/alice/private-ticket"),
        );

        assert!(matches!(identity.build_kind, HealthBuildKind::Release));
        assert_eq!(identity.executable_path, None);
        assert_eq!(identity.worktree_root, None);
        assert_eq!(identity.git_commit.as_deref(), Some("0123456789abcdef"));
        assert_eq!(identity.git_branch, None);

        let json = serde_json::to_value(identity).unwrap();
        assert_eq!(json["buildKind"], "release");
        assert!(json["executablePath"].is_null());
        assert!(json["worktreeRoot"].is_null());
        assert!(json["gitBranch"].is_null());
    }
}
