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
use std::time::UNIX_EPOCH;

use crate::conpty_runtime::CONPTY_RUNTIME_FILES;
use crate::constants::PTY_DAEMON_RUNTIME_DIR;

/// Copy `exe` and the ConPTY files next to it into
/// `<daemon dir>/runtime/<key>/` (reusing an existing copy) and return the
/// staged executable. Other runtime copies that no process is using are
/// removed.
pub(super) fn stage(exe: &Path, daemon_dir: &Path) -> io::Result<PathBuf> {
    let name = exe
        .file_name()
        .ok_or_else(|| io::Error::other("executable path has no file name"))?;
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
        if let Some(source_dir) = exe.parent() {
            for file in CONPTY_RUNTIME_FILES {
                let source = source_dir.join(file);
                if source.is_file() {
                    fs::copy(&source, temp.join(file))?;
                }
            }
        }
        // Publish complete copies only. Losing a race to another launcher
        // that published the same key is fine: its copy is identical.
        if fs::rename(&temp, &target).is_err() {
            let _ = fs::remove_dir_all(&temp);
            if !staged.is_file() {
                return Err(io::Error::other(
                    "could not publish the staged PTY daemon runtime",
                ));
            }
        }
    }
    remove_unused_runtimes(&root, &key);
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

/// A runtime copy is unused when its executable can be deleted: Windows keeps
/// a running image locked. Only then is the rest of the copy removed, so a
/// live daemon never loses the ConPTY files it still loads for new sessions.
fn remove_unused_runtimes(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_str() == Some(keep) || !path.is_dir() {
            continue;
        }
        let images: Vec<PathBuf> = fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|file| file.path())
            .filter(|file| file.extension().is_some_and(|ext| ext == "exe"))
            .collect();
        if images.iter().all(|image| fs::remove_file(image).is_ok()) {
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
        exe
    }

    #[test]
    fn staging_copies_the_runtime_once_and_drops_unused_older_copies() {
        let temp = tempfile::tempdir().unwrap();
        let daemon_dir = temp.path().join("daemon");
        let first = fake_build(&temp.path().join("build-1"), b"first build");
        let staged = stage(&first, &daemon_dir).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"first build");
        assert_eq!(
            fs::read(staged.parent().unwrap().join("conpty.dll")).unwrap(),
            b"conpty"
        );
        // Same build: the existing copy is reused.
        assert_eq!(stage(&first, &daemon_dir).unwrap(), staged);

        // A new build gets its own copy and the unused old one is removed.
        let second = fake_build(&temp.path().join("build-2"), b"second build, longer");
        let restaged = stage(&second, &daemon_dir).unwrap();
        assert_ne!(restaged, staged);
        assert!(!staged.parent().unwrap().exists());
        assert_eq!(fs::read(&restaged).unwrap(), b"second build, longer");
    }
}
