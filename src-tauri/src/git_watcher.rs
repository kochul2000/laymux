use std::fs;
use std::path::{Path, PathBuf};

/// Read the current branch from a .git/HEAD file.
/// Returns branch name (e.g., "main") or None if detached or missing.
pub fn read_git_branch(git_dir: &Path) -> Option<String> {
    let head_path = git_dir.join("HEAD");
    let content = fs::read_to_string(&head_path).ok()?;
    parse_git_head(&content)
}

/// Parse the content of a .git/HEAD file to extract the branch name.
pub fn parse_git_head(content: &str) -> Option<String> {
    let content = content.trim();
    if let Some(ref_path) = content.strip_prefix("ref: refs/heads/") {
        Some(ref_path.to_string())
    } else if content.len() == 40 && content.chars().all(|c| c.is_ascii_hexdigit()) {
        // Detached HEAD — return None for branch name
        None
    } else {
        None
    }
}

/// Find the .git directory for a given working directory.
/// Walks up from the given path to find the nearest .git directory.
pub fn find_git_dir(working_dir: &Path) -> Option<PathBuf> {
    let mut current = working_dir.to_path_buf();
    loop {
        let git_dir = current.join(".git");
        if git_dir.is_dir() {
            return Some(git_dir);
        }
        // Check for .git file (worktree/submodule)
        if git_dir.is_file() {
            if let Ok(content) = fs::read_to_string(&git_dir) {
                if let Some(path) = content.trim().strip_prefix("gitdir: ") {
                    let resolved = if Path::new(path).is_absolute() {
                        PathBuf::from(path)
                    } else {
                        current.join(path)
                    };
                    if resolved.is_dir() {
                        return Some(resolved);
                    }
                }
            }
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Locate the git `config` file for a given git dir.
///
/// A normal repo keeps `config` directly inside its `.git` dir. A linked
/// worktree's git dir (e.g. `.git/worktrees/<name>`) has *no* `config`; the
/// shared config lives in the common dir referenced by the `commondir` file
/// (relative to the worktree git dir). Handles both. (Issue #439)
pub fn find_git_config(git_dir: &Path) -> Option<PathBuf> {
    let direct = git_dir.join("config");
    if direct.is_file() {
        return Some(direct);
    }
    // Linked worktree: follow `commondir` to the shared config.
    let commondir_content = fs::read_to_string(git_dir.join("commondir")).ok()?;
    let rel = commondir_content.trim();
    let common = if Path::new(rel).is_absolute() {
        PathBuf::from(rel)
    } else {
        git_dir.join(rel)
    };
    let cfg = common.join("config");
    cfg.is_file().then_some(cfg)
}

/// Extract the `url` of `[remote "origin"]` from git config file content.
/// Returns the first url in the origin section, or None if absent.
pub fn parse_remote_origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            // Section header — normalize inner whitespace (git writes it as
            // `[remote "origin"]`, but be lenient about spacing).
            let header = trimmed
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            in_origin = header == "remote \"origin\"";
            continue;
        }
        if in_origin {
            if let Some((key, value)) = trimmed.split_once('=') {
                if key.trim() == "url" {
                    let v = value.trim();
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Strip userinfo (`user@`) and port (`:1234`) from an authority component,
/// returning just the host.
fn authority_host(authority: &str) -> &str {
    let no_user = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    no_user.split(':').next().unwrap_or(no_user)
}

/// Normalize any git remote URL to `https://github.com/{owner}/{repo}`.
///
/// Accepts scp-like (`git@github.com:owner/repo.git`), ssh
/// (`ssh://git@github.com/owner/repo.git`), and https forms (with or without
/// the trailing `.git`). Returns None when the host is not github.com or the
/// path lacks an owner/repo pair. (Issue #439)
pub fn github_base_from_remote_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    let (host, path) = if let Some((_scheme, after)) = url.split_once("://") {
        // scheme://[user@]host[:port]/path
        let (authority, path) = after.split_once('/').unwrap_or((after, ""));
        (authority_host(authority), path)
    } else if let Some((authority, path)) = url.split_once(':') {
        // scp-like: [user@]host:path
        (authority_host(authority), path)
    } else {
        return None;
    };

    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }

    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/').filter(|s| !s.is_empty());
    let owner = segments.next()?;
    let repo = segments.next()?;
    Some(format!("https://github.com/{}/{}", owner, repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_git_head_ref_branch() {
        let content = "ref: refs/heads/main\n";
        assert_eq!(parse_git_head(content), Some("main".into()));
    }

    #[test]
    fn parse_git_head_feature_branch() {
        let content = "ref: refs/heads/feature/login\n";
        assert_eq!(parse_git_head(content), Some("feature/login".into()));
    }

    #[test]
    fn parse_git_head_detached() {
        let content = "abc123def456789012345678901234567890abcd\n";
        assert_eq!(parse_git_head(content), None);
    }

    #[test]
    fn parse_git_head_empty() {
        assert_eq!(parse_git_head(""), None);
    }

    #[test]
    fn read_git_branch_from_temp_dir() {
        let dir = TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/develop\n").unwrap();

        let branch = read_git_branch(&git_dir);
        assert_eq!(branch, Some("develop".into()));
    }

    #[test]
    fn find_git_dir_in_current() {
        let dir = TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();

        let found = find_git_dir(dir.path());
        assert_eq!(found, Some(git_dir));
    }

    #[test]
    fn find_git_dir_in_parent() {
        let dir = TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        let sub_dir = dir.path().join("src").join("deep");
        fs::create_dir_all(&sub_dir).unwrap();

        let found = find_git_dir(&sub_dir);
        assert_eq!(found, Some(git_dir));
    }

    #[test]
    fn find_git_dir_nonexistent() {
        let dir = TempDir::new().unwrap();
        let found = find_git_dir(dir.path());
        assert_eq!(found, None);
    }

    // -- Issue #439: git remote → GitHub base URL --

    #[test]
    fn parse_remote_origin_url_basic() {
        let config = "\
[core]
\trepositoryformatversion = 0
[remote \"origin\"]
\turl = git@github.com:owner/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch \"main\"]
\tremote = origin
";
        assert_eq!(
            parse_remote_origin_url(config),
            Some("git@github.com:owner/repo.git".into())
        );
    }

    #[test]
    fn parse_remote_origin_url_picks_origin_not_upstream() {
        let config = "\
[remote \"upstream\"]
\turl = https://github.com/other/repo.git
[remote \"origin\"]
\turl = https://github.com/me/repo.git
";
        assert_eq!(
            parse_remote_origin_url(config),
            Some("https://github.com/me/repo.git".into())
        );
    }

    #[test]
    fn parse_remote_origin_url_missing() {
        let config = "[core]\n\tbare = false\n";
        assert_eq!(parse_remote_origin_url(config), None);
    }

    #[test]
    fn github_base_scp_like() {
        assert_eq!(
            github_base_from_remote_url("git@github.com:owner/repo.git"),
            Some("https://github.com/owner/repo".into())
        );
    }

    #[test]
    fn github_base_ssh_scheme() {
        assert_eq!(
            github_base_from_remote_url("ssh://git@github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".into())
        );
    }

    #[test]
    fn github_base_https_with_dotgit() {
        assert_eq!(
            github_base_from_remote_url("https://github.com/owner/repo.git"),
            Some("https://github.com/owner/repo".into())
        );
    }

    #[test]
    fn github_base_https_without_dotgit() {
        assert_eq!(
            github_base_from_remote_url("https://github.com/owner/repo"),
            Some("https://github.com/owner/repo".into())
        );
    }

    #[test]
    fn github_base_ssh_with_port() {
        assert_eq!(
            github_base_from_remote_url("ssh://git@github.com:22/owner/repo.git"),
            Some("https://github.com/owner/repo".into())
        );
    }

    #[test]
    fn github_base_non_github_is_none() {
        assert_eq!(
            github_base_from_remote_url("git@gitlab.com:owner/repo.git"),
            None
        );
        assert_eq!(
            github_base_from_remote_url("https://bitbucket.org/owner/repo.git"),
            None
        );
    }

    #[test]
    fn github_base_missing_repo_is_none() {
        assert_eq!(
            github_base_from_remote_url("https://github.com/owner"),
            None
        );
        assert_eq!(github_base_from_remote_url("https://github.com"), None);
        assert_eq!(github_base_from_remote_url(""), None);
    }

    #[test]
    fn find_git_config_direct() {
        let dir = TempDir::new().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir(&git_dir).unwrap();
        fs::write(git_dir.join("config"), "[core]\n").unwrap();

        assert_eq!(find_git_config(&git_dir), Some(git_dir.join("config")));
    }

    #[test]
    fn find_git_config_via_commondir_worktree() {
        // Simulate a linked worktree: git dir has `commondir` but no `config`;
        // the shared config lives in the common dir.
        let dir = TempDir::new().unwrap();
        let common = dir.path().join(".git");
        fs::create_dir(&common).unwrap();
        let config_path = common.join("config");
        fs::write(&config_path, "[remote \"origin\"]\n\turl = x\n").unwrap();

        let worktree_git = common.join("worktrees").join("wt1");
        fs::create_dir_all(&worktree_git).unwrap();
        // `commondir` is relative to the worktree git dir.
        fs::write(worktree_git.join("commondir"), "../..\n").unwrap();

        // The returned path may contain `..` components (not lexically equal to
        // `config_path`), so compare canonicalized forms.
        let found = find_git_config(&worktree_git).expect("config resolved via commondir");
        assert!(found.is_file());
        assert_eq!(
            fs::canonicalize(&found).unwrap(),
            fs::canonicalize(&config_path).unwrap()
        );
    }
}
