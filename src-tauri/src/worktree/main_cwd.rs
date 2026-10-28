use super::git::Git;
use crate::error::AppError;
use std::time::Duration;

/// None means the existing CWD should be kept (main/bare or unavailable main checkout).
pub fn main_worktree_cwd(working_dir: &str) -> Result<Option<String>, AppError> {
    let git = Git::with_timeout(working_dir, Duration::from_secs(2))?;
    let root = git.text(&git.cwd, &["rev-parse", "--show-toplevel"])?;
    let main = git
        .worktrees()?
        .into_iter()
        .find(|entry| entry.is_main && !entry.bare);
    let Some(main) = main else {
        return Ok(None);
    };
    if git.same_path(&root, &main.path) {
        return Ok(None);
    }
    let prefix = git.text(&git.cwd, &["rev-parse", "--show-prefix"])?;
    let candidate = format!(
        "{}/{}",
        main.path.trim_end_matches('/'),
        prefix.trim_end_matches('/')
    );
    if git.directory_exists(&candidate)? {
        Ok(Some(git.host_path(&candidate)))
    } else if git.directory_exists(&main.path)? {
        Ok(Some(git.host_path(&main.path)))
    } else {
        Ok(None)
    }
}
