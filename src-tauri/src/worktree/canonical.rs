use std::path::PathBuf;

use crate::error::AppError;

#[derive(Debug, PartialEq, Eq)]
enum Location {
    Native(PathBuf),
    Wsl { distro: String, path: String },
}

/// Resolve every parent component before comparing a terminal CWD with a
/// worktree. Windows cannot follow Linux symlinks through a WSL UNC path, so
/// explicit guests resolve their own paths without consulting the default guest.
pub fn canonicalize_host_path(path: &str) -> Result<String, AppError> {
    match location(path, cfg!(windows))? {
        Location::Native(path) => canonicalize_native_path(&path),
        Location::Wsl { distro, path } => {
            let mut command = crate::process::headless_wsl_command();
            command.args(["-d", &distro, "--exec", "readlink", "-f", "--", &path]);
            let output = super::git::bounded_output(&mut command)?;
            if !output.status.success() {
                return Err(AppError::Other(format!(
                    "WSL 실제 경로를 확인할 수 없습니다: {}",
                    String::from_utf8_lossy(&output.stderr).trim(),
                )));
            }
            canonical_wsl_output(&distro, &output.stdout)
        }
    }
}

pub(super) fn canonicalize_native_path(path: &std::path::Path) -> Result<String, AppError> {
    let canonical = std::fs::canonicalize(path)?;
    let canonical = canonical
        .to_str()
        .ok_or_else(|| AppError::Other("실제 경로가 올바른 UTF-8이 아닙니다.".into()))?;
    #[cfg(windows)]
    {
        if let Some(tail) = canonical.strip_prefix("\\\\?\\UNC\\") {
            return Ok(format!("//{}", tail.replace('\\', "/")));
        }
        return Ok(canonical
            .strip_prefix("\\\\?\\")
            .unwrap_or(canonical)
            .replace('\\', "/"));
    }
    #[cfg(not(windows))]
    Ok(canonical.to_owned())
}

fn location(path: &str, windows: bool) -> Result<Location, AppError> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::Other("확인할 절대 경로가 필요합니다.".into()));
    }
    if windows {
        // A forward-slash guest path may contain a literal Linux backslash.
        // Only a native backslash UNC representation uses '\\' as separators.
        let forward = if path.starts_with("\\\\") {
            path.replace('\\', "/")
        } else {
            path.to_owned()
        };
        if let Some((host, rest)) = forward
            .strip_prefix("//")
            .and_then(|value| value.split_once('/'))
        {
            if host.eq_ignore_ascii_case("wsl.localhost") || host.eq_ignore_ascii_case("wsl$") {
                let (distro, tail) = rest.split_once('/').unwrap_or((rest, ""));
                if !crate::wsl_probe::is_safe_distro_name(distro) {
                    return Err(AppError::Other("올바르지 않은 WSL 배포판입니다.".into()));
                }
                return Ok(Location::Wsl {
                    distro: distro.to_owned(),
                    path: format!("/{tail}"),
                });
            }
        }
        if forward.starts_with('/') && !forward.starts_with("//") {
            return Err(AppError::Other(
                "WSL 실제 경로 확인에는 배포판을 포함한 UNC 경로가 필요합니다.".into(),
            ));
        }
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::Other("확인할 절대 경로가 필요합니다.".into()));
    }
    Ok(Location::Native(path))
}

fn canonical_wsl_output(distro: &str, bytes: &[u8]) -> Result<String, AppError> {
    let path = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Other("WSL 실제 경로가 올바른 UTF-8이 아닙니다.".into()))?;
    // readlink adds exactly one LF; any other whitespace belongs to the name.
    let path = path.strip_suffix('\n').unwrap_or(path);
    if !path.starts_with('/') || path.contains('\0') {
        return Err(AppError::Other(
            "WSL 실제 경로 출력을 확인할 수 없습니다.".into(),
        ));
    }
    Ok(format!("//wsl.localhost/{distro}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_canonicalization_resolves_existing_components_and_rejects_missing_paths() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("child")).unwrap();
        let direct = canonicalize_host_path(temp.path().to_str().unwrap()).unwrap();
        let traversal =
            canonicalize_host_path(temp.path().join("child/..").to_str().unwrap()).unwrap();
        assert_eq!(direct, traversal);
        assert!(canonicalize_host_path(temp.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn explicit_wsl_paths_keep_the_distribution_case_and_guest_backslashes() {
        assert_eq!(
            location("//wsl.localhost/Ubuntu/home/Repo\\name/src", true).unwrap(),
            Location::Wsl {
                distro: "Ubuntu".into(),
                path: "/home/Repo\\name/src".into(),
            }
        );
        assert_eq!(
            location("\\\\wsl$\\Debian\\home\\repo\\src", true).unwrap(),
            Location::Wsl {
                distro: "Debian".into(),
                path: "/home/repo/src".into(),
            }
        );
        assert!(location("/home/repo", true).is_err());
        assert!(location("//wsl.localhost/../home/repo", true).is_err());
    }

    #[test]
    fn readlink_output_keeps_names_and_rejects_relative_empty_and_invalid_paths() {
        assert_eq!(
            canonical_wsl_output("Ubuntu", b"/home/Real\\Name/child\n").unwrap(),
            "//wsl.localhost/Ubuntu/home/Real\\Name/child"
        );
        assert_eq!(
            canonical_wsl_output("Ubuntu", b"/home/trailing\r\n").unwrap(),
            "//wsl.localhost/Ubuntu/home/trailing\r"
        );
        for invalid in [
            b"".as_slice(),
            b"relative\n",
            b"/home/\0bad\n",
            b"/home/\xff\n",
        ] {
            assert!(canonical_wsl_output("Ubuntu", invalid).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_parent_symlinks_resolve_without_losing_literal_backslashes() {
        let temp = tempfile::tempdir().unwrap();
        let actual = temp.path().join("actual\\name");
        std::fs::create_dir(&actual).unwrap();
        std::fs::create_dir(actual.join("child")).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        assert_eq!(
            canonicalize_host_path(alias.join("child").to_str().unwrap()).unwrap(),
            actual.join("child").to_str().unwrap()
        );
    }
}
