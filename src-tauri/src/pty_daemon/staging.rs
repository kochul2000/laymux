//! Windows: run the daemon from a private copy of the executable (ADR-0301).
//!
//! Windows refuses to replace an image that a running process maps. A daemon
//! started straight from the install (or `target`) directory would therefore
//! block every update and every dev rebuild for as long as it lives. The
//! launcher copies the executable and the bundled ConPTY runtime into a
//! content-keyed directory under the daemon directory and starts that copy.
//! Linux replaces running binaries freely and needs no staging.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use crate::conpty_runtime::CONPTY_RUNTIME_FILES;
use crate::constants::{
    PTY_DAEMON_RUNTIME_DIR, PTY_DAEMON_RUNTIME_GC_MIN_AGE_MS, PTY_DAEMON_STAGED_IMAGE,
};

/// Copy `exe` and the ConPTY files next to it into
/// `<daemon dir>/runtime/<key>/` (reusing an existing copy) and return the
/// staged executable. Other runtime copies that no process is using are
/// removed.
pub(super) fn stage(exe: &Path, daemon_dir: &Path) -> io::Result<PathBuf> {
    stage_with_gc_age(
        exe,
        daemon_dir,
        Duration::from_millis(PTY_DAEMON_RUNTIME_GC_MIN_AGE_MS),
    )
}

fn stage_with_gc_age(exe: &Path, daemon_dir: &Path, gc_min_age: Duration) -> io::Result<PathBuf> {
    // Not the executable's own name: the update installer ends every
    // running `laymux.exe` by image name (ADR-0308).
    let name = std::ffi::OsStr::new(PTY_DAEMON_STAGED_IMAGE);
    let key = runtime_key(exe)?;
    let root = daemon_dir.join(PTY_DAEMON_RUNTIME_DIR);
    let target = root.join(&key);
    let staged = target.join(name);
    if !staged.is_file() {
        fs::create_dir_all(&root)?;
        let temp = root.join(format!("{key}.{}.tmp", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp)?;
        fs::copy(exe, temp.join(name))?;
        // The bundled ConPTY is mandatory (ADR-0067): a daemon without it
        // would silently fall back to the in-box conhost.
        let source_dir = exe
            .parent()
            .ok_or_else(|| io::Error::other("executable path has no directory"))?;
        for file in CONPTY_RUNTIME_FILES {
            fs::copy(source_dir.join(file), temp.join(file)).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("missing ConPTY runtime file {file}: {error}"),
                )
            })?;
        }
        // Publish complete copies only. Losing a race to another launcher
        // that published the same key is fine: its copy is identical.
        let mut published = fs::rename(&temp, &target).is_ok() || staged.is_file();
        if !published {
            // A partial copy without the daemon image (left by a cleanup
            // that could not finish) runs no daemon but would block this
            // rename forever; replace it once.
            let _ = fs::remove_dir_all(&target);
            published = fs::rename(&temp, &target).is_ok() || staged.is_file();
        }
        let _ = fs::remove_dir_all(&temp);
        if !published {
            return Err(io::Error::other(
                "could not publish the staged PTY daemon runtime",
            ));
        }
    }
    remove_unused_runtimes(&root, &key, name, gc_min_age);
    Ok(staged)
}

/// Size and modification time identify a build cheaply; a rebuilt or updated
/// executable gets a new key and therefore a fresh copy.
fn runtime_key(exe: &Path) -> io::Result<String> {
    let meta = fs::metadata(exe)?;
    let modified = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok(format!("{:x}-{modified:x}", meta.len()))
}

/// A runtime copy is unused when its daemon executable can be deleted:
/// Windows keeps a running image locked. That image is deleted first, and
/// only once it is gone is the rest of the copy removed, so a live daemon never
/// loses the ConPTY files it still loads for new sessions.
///
/// A copy younger than `min_age` is skipped: another launcher may have just
/// published it and not started its daemon yet, so its image is not locked.
fn remove_unused_runtimes(
    root: &Path,
    keep: &str,
    daemon_image: &std::ffi::OsStr,
    min_age: Duration,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // Skip the copy in use, and another launcher's copy in progress.
        if name == keep || name.ends_with(".tmp") || !path.is_dir() {
            continue;
        }
        let young = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .map(|modified| modified.elapsed().unwrap_or_default() < min_age)
            .unwrap_or(true);
        if young {
            continue;
        }
        // Without its image there is no lock to prove the copy unused.
        let image = path.join(daemon_image);
        if image.is_file() && fs::remove_file(&image).is_ok() {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_build(dir: &Path, content: &[u8]) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let exe = dir.join("laymux.exe");
        fs::write(&exe, content).unwrap();
        fs::write(dir.join("conpty.dll"), b"conpty").unwrap();
        fs::write(dir.join("OpenConsole.exe"), b"console").unwrap();
        exe
    }

    #[test]
    fn staging_refuses_a_build_without_the_bundled_conpty() {
        let temp = tempfile::tempdir().unwrap();
        let exe = fake_build(&temp.path().join("build"), b"build");
        fs::remove_file(temp.path().join("build").join("OpenConsole.exe")).unwrap();
        assert!(stage(&exe, &temp.path().join("daemon")).is_err());
    }

    #[test]
    fn staging_copies_the_runtime_once_and_drops_unused_older_copies() {
        let temp = tempfile::tempdir().unwrap();
        let daemon_dir = temp.path().join("daemon");
        let first = fake_build(&temp.path().join("build-1"), b"first build");
        let staged = stage_with_gc_age(&first, &daemon_dir, Duration::ZERO).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"first build");
        assert_eq!(
            fs::read(staged.parent().unwrap().join("conpty.dll")).unwrap(),
            b"conpty"
        );
        // Same build: the existing copy is reused.
        assert_eq!(
            stage_with_gc_age(&first, &daemon_dir, Duration::ZERO).unwrap(),
            staged
        );

        // A new build gets its own copy and the unused old one is removed.
        let second = fake_build(&temp.path().join("build-2"), b"second build, longer");
        let restaged = stage_with_gc_age(&second, &daemon_dir, Duration::ZERO).unwrap();
        assert_ne!(restaged, staged);
        assert!(!staged.parent().unwrap().exists());
        assert_eq!(fs::read(&restaged).unwrap(), b"second build, longer");
    }

    #[test]
    fn a_partial_copy_of_the_current_build_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let daemon_dir = temp.path().join("daemon");
        let exe = fake_build(&temp.path().join("build"), b"build");
        // What an interrupted cleanup leaves: the image is gone, the rest
        // of the directory is not.
        let partial = daemon_dir
            .join(PTY_DAEMON_RUNTIME_DIR)
            .join(runtime_key(&exe).unwrap());
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("conpty.dll"), b"stale").unwrap();

        let staged = stage_with_gc_age(&exe, &daemon_dir, Duration::ZERO).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"build");
        assert_eq!(fs::read(partial.join("conpty.dll")).unwrap(), b"conpty");
    }
}

#[cfg(test)]
mod gc_age_tests {
    use super::*;

    #[test]
    fn a_freshly_published_copy_is_not_collected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let fresh = root.join("other-key");
        fs::create_dir_all(&fresh).unwrap();
        fs::write(fresh.join("laymux.exe"), b"x").unwrap();
        remove_unused_runtimes(
            &root,
            "keep",
            "laymux.exe".as_ref(),
            Duration::from_secs(60),
        );
        assert!(fresh.join("laymux.exe").exists());
    }
}
