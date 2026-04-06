//! Path conversion utilities for WSL ↔ Windows ↔ Linux path translation.
//!
//! Consolidates path-related functions from across the codebase into a single module.

use crate::lock_ext::MutexExt;
use crate::state::AppState;

/// Normalize CWD paths to a canonical Linux-native form.
/// All Windows drive paths are converted to `/mnt/x/...` so that
/// `filter_targets_needing_cd` can deduplicate OSC 7 and OSC 9;9 events.
///
/// Examples:
/// - `file://localhost/mnt/c/Users` → `/mnt/c/Users`
/// - `file://localhost/C:/Users` → `/mnt/c/Users`
/// - `C:/Users` or `C:\Users` → `/mnt/c/Users`
/// - `//wsl.localhost/Distro/home/user` → `/home/user`
/// - `/home/user` → `/home/user` (already canonical)
pub fn normalize_wsl_path(path: &str) -> String {
    // Strip PowerShell provider prefix (safety net)
    let path = if let Some(rest) =
        path.strip_prefix("file://localhost/Microsoft.PowerShell.Core/FileSystem::")
    {
        rest
    } else {
        path
    };
    let path = path
        .strip_prefix("Microsoft.PowerShell.Core/FileSystem::")
        .unwrap_or(path);

    // file://localhost/<path> (OSC 7 CWD format)
    if let Some(rest) = path.strip_prefix("file://localhost") {
        if rest.starts_with('/') {
            // /X:/ pattern — Windows drive from PowerShell OSC 7
            let rb = rest.as_bytes();
            if rb.len() >= 3 && rb[1].is_ascii_alphabetic() && rb[2] == b':' {
                let drive = rb[1].to_ascii_lowercase() as char;
                let tail = rest[3..].replace('\\', "/");
                return format!("/mnt/{drive}{tail}");
            }
            return rest.to_string();
        }
    }
    // //wsl.localhost/<distro>/<rest>
    if let Some(rest) = path.strip_prefix("//wsl.localhost/") {
        if let Some(pos) = rest.find('/') {
            return rest[pos..].to_string();
        }
    }
    // //wsl$/<distro>/<rest>
    if let Some(rest) = path.strip_prefix("//wsl$/") {
        if let Some(pos) = rest.find('/') {
            return rest[pos..].to_string();
        }
    }
    // Bare Windows path: C:\... or C:/... → /mnt/c/...
    let pb = path.as_bytes();
    if pb.len() >= 3
        && pb[0].is_ascii_alphabetic()
        && pb[1] == b':'
        && (pb[2] == b'\\' || pb[2] == b'/')
    {
        let drive = (pb[0] as char).to_ascii_lowercase();
        let tail = path[2..].replace('\\', "/");
        return format!("/mnt/{drive}{tail}");
    }
    // Bare drive root: C:\ or C:
    if pb.len() >= 2 && pb[0].is_ascii_alphabetic() && pb[1] == b':' && pb.len() <= 3 {
        let drive = (pb[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/");
    }
    path.to_string()
}

/// Normalize paths for comparison (case-insensitive on Windows, /mnt/x → X:).
pub fn normalize_path_for_comparison(path: &str) -> String {
    let p = path.trim_end_matches('/').trim_end_matches('\\');
    #[cfg(windows)]
    {
        let unified = p.to_lowercase().replace('\\', "/");
        // Convert /mnt/x/... → x:/...
        if let Some(rest) = unified.strip_prefix("/mnt/") {
            let bytes = rest.as_bytes();
            if !bytes.is_empty() && bytes[0].is_ascii_alphabetic() {
                let drive = bytes[0] as char;
                let tail = if bytes.len() > 1 && bytes[1] == b'/' {
                    &rest[1..]
                } else if bytes.len() == 1 {
                    // /mnt/c → c: (no trailing slash, matches how C:\ normalizes)
                    ""
                } else {
                    return unified;
                };
                return format!("{drive}:{tail}");
            }
        }
        unified
    }
    #[cfg(not(windows))]
    {
        p.to_string()
    }
}

/// Convert path between WSL and PowerShell formats, using a WSL distro name
/// for UNC paths when needed.
pub fn convert_path_for_target_with_distro(
    path: &str,
    target_profile: &str,
    wsl_distro: Option<&str>,
) -> Option<String> {
    let is_linux = path.starts_with('/');
    let is_windows = path.len() >= 3
        && path.as_bytes()[1] == b':'
        && (path.as_bytes()[2] == b'\\' || path.as_bytes()[2] == b'/');

    match target_profile {
        "WSL" | "wsl" => {
            if is_linux {
                Some(path.to_string())
            } else if is_windows {
                // C:\Users\... → /mnt/c/Users/...
                let drive = (path.as_bytes()[0] as char).to_ascii_lowercase();
                let rest = path[2..].replace('\\', "/");
                Some(format!("/mnt/{drive}{rest}"))
            } else {
                Some(path.to_string())
            }
        }
        "PowerShell" | "powershell" => {
            if is_windows {
                Some(path.to_string())
            } else if is_linux {
                // Check for /mnt/X/... pattern (WSL mount of Windows drive)
                if let Some(rest) = path.strip_prefix("/mnt/") {
                    if let Some(drive_byte) = rest.as_bytes().first() {
                        if drive_byte.is_ascii_alphabetic()
                            && (rest.len() == 1 || rest.as_bytes()[1] == b'/')
                        {
                            let drive = (*drive_byte as char).to_ascii_uppercase();
                            let tail = if rest.len() > 1 {
                                rest[1..].replace('/', "\\")
                            } else {
                                "\\".to_string()
                            };
                            return Some(format!("{drive}:{tail}"));
                        }
                    }
                }
                // Pure Linux path — use UNC path if distro is known
                if let Some(distro) = wsl_distro {
                    let win_path = path.replace('/', "\\");
                    Some(format!("\\\\wsl.localhost\\{distro}{win_path}"))
                } else {
                    None
                }
            } else {
                Some(path.to_string())
            }
        }
        _ => Some(path.to_string()),
    }
}

/// Resolve a Linux/WSL path to a Windows-accessible path.
pub fn resolve_path_for_windows(path: &str, wsl_distro: Option<&str>) -> String {
    // Already a Windows path
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        return path.to_string();
    }
    // UNC path
    if path.starts_with("\\\\") {
        return path.to_string();
    }
    // /mnt/x/... → X:\...
    if path.starts_with("/mnt/") && path.len() >= 6 && path.as_bytes()[5].is_ascii_alphabetic() {
        let drive = path.as_bytes()[5].to_ascii_uppercase() as char;
        let rest = if path.len() > 6 { &path[6..] } else { "" };
        return format!("{}:{}", drive, rest.replace('/', "\\"));
    }
    // Linux path with WSL distro → UNC
    if let Some(distro) = wsl_distro {
        return format!("\\\\wsl.localhost\\{}{}", distro, path.replace('/', "\\"));
    }
    // Fallback: try as-is (may fail on Windows)
    path.to_string()
}

/// Extract WSL distro name from a raw path (before normalization).
/// Handles `//wsl.localhost/<distro>/path` and `//wsl$/<distro>/path` formats.
pub fn extract_wsl_distro_from_path(path: &str) -> Option<String> {
    let rest = path
        .strip_prefix("//wsl.localhost/")
        .or_else(|| path.strip_prefix("//wsl$/"))?;
    let end = rest.find('/').unwrap_or(rest.len());
    let distro = &rest[..end];
    if distro.is_empty() {
        None
    } else {
        Some(distro.to_string())
    }
}

/// Look up the WSL distro name from any WSL terminal's stored distro info.
pub fn find_wsl_distro(state: &AppState, source_id: &str) -> Option<String> {
    let terminals = state.terminals.lock_or_err().ok()?;
    // First try the source terminal itself
    if let Some(session) = terminals.get(source_id) {
        if let Some(ref distro) = session.wsl_distro {
            return Some(distro.clone());
        }
    }
    // Try other WSL terminals
    for (_, session) in terminals.iter() {
        if session.config.profile.eq_ignore_ascii_case("wsl") {
            if let Some(ref distro) = session.wsl_distro {
                return Some(distro.clone());
            }
        }
    }
    None
}

/// Detect the default WSL distro name (cached per-call; fast because wsl.exe is local).
#[cfg(windows)]
pub fn get_default_wsl_distro() -> Option<String> {
    let output = crate::process::headless_command("wsl.exe")
        .args(["--list", "--quiet"])
        .output()
        .ok()?;
    // wsl.exe outputs UTF-16LE — decode it properly
    let text = if output.stdout.len() >= 2 && output.stdout[0] == 0xFF && output.stdout[1] == 0xFE {
        // UTF-16LE with BOM
        let u16s: Vec<u16> = output.stdout[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        // Try as UTF-16LE without BOM (common for wsl.exe)
        let u16s: Vec<u16> = output
            .stdout
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let decoded = String::from_utf16_lossy(&u16s);
        // If decoding looks like gibberish, fall back to UTF-8
        if decoded.chars().any(|c| c == '\0') {
            String::from_utf8_lossy(&output.stdout).to_string()
        } else {
            decoded
        }
    };
    // First non-empty line is the default distro
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').trim_matches('\0'))
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

#[cfg(not(windows))]
pub fn get_default_wsl_distro() -> Option<String> {
    None
}

/// Convert a Windows path (`C:\Users\...`) to a WSL path (`/mnt/c/Users/...`).
pub fn windows_to_wsl_path(win_path: &str) -> String {
    let path = win_path.replace('\\', "/");
    // Match drive letter pattern: C:/ or c:/
    if path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/' {
        let drive = (path.as_bytes()[0] as char).to_lowercase().next().unwrap();
        format!("/mnt/{}/{}", drive, &path[3..])
    } else {
        path
    }
}

/// Convert a `/mnt/x/...` path to `X:\...` Windows path.
pub fn mnt_path_to_windows(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/mnt/")?;
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let drive = bytes[0].to_ascii_uppercase() as char;
    let tail = if bytes.len() > 1 && bytes[1] == b'/' {
        rest[1..].replace('/', "\\")
    } else if bytes.len() == 1 {
        "\\".to_string()
    } else {
        return None;
    };
    Some(format!("{drive}:{tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_wsl_path_file_url() {
        assert_eq!(
            normalize_wsl_path("file://localhost/mnt/c/Users"),
            "/mnt/c/Users"
        );
    }

    #[test]
    fn normalize_wsl_path_windows_drive() {
        assert_eq!(normalize_wsl_path("C:\\Users\\test"), "/mnt/c/Users/test");
        assert_eq!(normalize_wsl_path("C:/Users/test"), "/mnt/c/Users/test");
    }

    #[test]
    fn normalize_wsl_path_wsl_localhost() {
        assert_eq!(
            normalize_wsl_path("//wsl.localhost/Ubuntu/home/user"),
            "/home/user"
        );
    }

    #[test]
    fn normalize_wsl_path_already_linux() {
        assert_eq!(normalize_wsl_path("/home/user"), "/home/user");
    }

    #[test]
    fn normalize_path_comparison_trailing_slash() {
        assert_eq!(
            normalize_path_for_comparison("/home/user/"),
            normalize_path_for_comparison("/home/user")
        );
    }

    #[test]
    fn convert_path_wsl_to_powershell() {
        let result =
            convert_path_for_target_with_distro("/mnt/c/Users", "PowerShell", None).unwrap();
        assert_eq!(result, "C:\\Users");
    }

    #[test]
    fn convert_path_powershell_to_wsl() {
        let result = convert_path_for_target_with_distro("C:\\Users\\test", "WSL", None).unwrap();
        assert_eq!(result, "/mnt/c/Users/test");
    }

    #[test]
    fn resolve_path_mnt_to_windows() {
        assert_eq!(resolve_path_for_windows("/mnt/c/Users", None), "C:\\Users");
    }

    #[test]
    fn resolve_path_linux_with_distro() {
        assert_eq!(
            resolve_path_for_windows("/home/user", Some("Ubuntu")),
            "\\\\wsl.localhost\\Ubuntu\\home\\user"
        );
    }

    #[test]
    fn extract_distro_from_wsl_localhost() {
        assert_eq!(
            extract_wsl_distro_from_path("//wsl.localhost/Ubuntu/home"),
            Some("Ubuntu".to_string())
        );
    }

    #[test]
    fn extract_distro_from_wsl_dollar() {
        assert_eq!(
            extract_wsl_distro_from_path("//wsl$/Debian/home"),
            Some("Debian".to_string())
        );
    }

    #[test]
    fn extract_distro_no_match() {
        assert_eq!(extract_wsl_distro_from_path("/home/user"), None);
    }

    #[test]
    fn windows_to_wsl() {
        assert_eq!(windows_to_wsl_path("C:\\Users\\test"), "/mnt/c/Users/test");
    }

    #[test]
    fn mnt_to_windows() {
        assert_eq!(
            mnt_path_to_windows("/mnt/c/Users"),
            Some("C:\\Users".to_string())
        );
    }

    #[test]
    fn mnt_to_windows_drive_root() {
        assert_eq!(mnt_path_to_windows("/mnt/c"), Some("C:\\".to_string()));
    }

    #[test]
    fn mnt_to_windows_invalid() {
        assert_eq!(mnt_path_to_windows("/home/user"), None);
    }
}
