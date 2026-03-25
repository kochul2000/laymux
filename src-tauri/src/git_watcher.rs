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
}
