//! Hand a verified path-link target to the host desktop (issue #687, ADR-0099).
//!
//! The terminal path-link feature validates a selected path with `stat_path`
//! and underlines it. `Ctrl`/`Ctrl+Shift` clicking that underline asks the host
//! OS to open the target or to show it in the file manager. The meaning is
//! always the *host* context: a `.txt` inside WSL opens with the Windows file
//! association, never with a guest-side handler.
//!
//! Path resolution is not reimplemented here — `resolve_address_path_following_symlinks`
//! is the same function `stat_path`/`list_directory`/`read_file_for_viewer` use,
//! so `/home/... → \\wsl.localhost\<distro>\...` and `/mnt/c/... → C:\...` stay
//! in one place (ADR-0031: the host path is Rust's responsibility).
//!
//! Confirmation policy lives in the frontend (ADR-0099 Decision 4); this module
//! performs the requested action without knowing whether a dialog was shown.
//! The command is intentionally **not** exposed to Automation, MCP or Remote —
//! remote file access must not widen into host process execution (ADR-0045).

use crate::path_utils;

/// What the host should do with the resolved path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsOpenMode {
    /// Open the target itself — file association for files, file manager for directories.
    Open,
    /// Show the target inside its parent directory, selected.
    Reveal,
}

/// Parse the IPC `mode` argument. Unknown values are rejected rather than
/// defaulting, so a typo cannot silently turn a reveal into an execution.
pub fn parse_os_open_mode(raw: &str) -> Result<OsOpenMode, String> {
    match raw {
        "open" => Ok(OsOpenMode::Open),
        "reveal" => Ok(OsOpenMode::Reveal),
        other => Err(format!("Unknown OS open mode: {other}")),
    }
}

/// Parent directory of `path`, or `None` when the path is already a root.
///
/// Pure string logic on purpose: it must behave identically on every host
/// (tests run on Linux CI too) and must not touch the filesystem. Handles
/// POSIX roots, Windows drive roots and UNC share roots — `\\wsl.localhost\Ubuntu`
/// is a share root, so a file directly under it has no reveal-able parent.
pub fn parent_dir(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None; // "/" or "\" — already a root.
    }

    // UNC prefix: \\host\share is the shallowest addressable directory.
    let unc_rest = trimmed
        .strip_prefix("\\\\")
        .or_else(|| trimmed.strip_prefix("//"));
    if let Some(rest) = unc_rest {
        let depth = rest.split(['/', '\\']).filter(|s| !s.is_empty()).count();
        if depth <= 2 {
            return None;
        }
    }

    let idx = trimmed.rfind(['/', '\\'])?;
    if idx == 0 {
        return Some("/".to_string()); // "/etc" → "/"
    }
    let head = &trimmed[..idx];
    if head.ends_with(':') {
        return Some(format!("{head}\\")); // "D:\proj" → "D:\"
    }
    Some(head.to_string())
}

/// Arguments for `explorer.exe`.
///
/// `Reveal` uses `/select,<path>`; when the target has no parent (drive root,
/// UNC share root) there is nothing to select inside, so it degrades to `Open`
/// (ADR-0099 Decision 2).
pub fn explorer_args(mode: OsOpenMode, resolved: &str) -> Vec<String> {
    match mode {
        OsOpenMode::Open => vec![resolved.to_string()],
        OsOpenMode::Reveal => match parent_dir(resolved) {
            Some(_) => vec![format!("/select,{resolved}")],
            None => vec![resolved.to_string()],
        },
    }
}

/// Target for `xdg-open`. Linux has no portable "select this entry" verb, so
/// `Reveal` opens the parent directory instead (ADR-0099 Decision 6).
pub fn xdg_open_target(mode: OsOpenMode, resolved: &str) -> String {
    match mode {
        OsOpenMode::Open => resolved.to_string(),
        OsOpenMode::Reveal => parent_dir(resolved).unwrap_or_else(|| resolved.to_string()),
    }
}

/// Hand `path` to the host desktop. `mode` is `"open"` or `"reveal"`.
///
/// Only a spawn failure is an error. `explorer.exe` returns a non-zero exit
/// code even on success, so the child is never waited on and its status is
/// never inspected — everything after the spawn is the OS's business (an
/// unknown extension showing the "How do you want to open this file?" dialog is
/// the expected behavior, not a failure).
#[tauri::command]
pub fn open_in_os(path: String, wsl_distro: Option<String>, mode: String) -> Result<(), String> {
    let mode = parse_os_open_mode(&mode)?;
    let resolved =
        path_utils::resolve_address_path_following_symlinks(&path, wsl_distro.as_deref());

    #[cfg(target_os = "windows")]
    {
        crate::process::headless_command("explorer.exe")
            .args(explorer_args(mode, &resolved))
            .spawn()
            .map_err(|e| format!("Failed to launch explorer.exe: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        crate::process::headless_command("xdg-open")
            .arg(xdg_open_target(mode, &resolved))
            .spawn()
            .map_err(|e| format!("Failed to launch xdg-open: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mode_accepts_the_two_documented_values() {
        assert_eq!(parse_os_open_mode("open"), Ok(OsOpenMode::Open));
        assert_eq!(parse_os_open_mode("reveal"), Ok(OsOpenMode::Reveal));
    }

    #[test]
    fn parse_mode_rejects_anything_else() {
        assert!(parse_os_open_mode("Open").is_err());
        assert!(parse_os_open_mode("execute").is_err());
        assert!(parse_os_open_mode("").is_err());
    }

    #[test]
    fn parent_dir_handles_posix_paths() {
        assert_eq!(
            parent_dir("/home/user/notes.txt").as_deref(),
            Some("/home/user")
        );
        assert_eq!(parent_dir("/home/user/").as_deref(), Some("/home"));
        assert_eq!(parent_dir("/etc").as_deref(), Some("/"));
        assert_eq!(parent_dir("/"), None);
    }

    #[test]
    fn parent_dir_handles_windows_drive_paths() {
        assert_eq!(parent_dir("D:\\proj\\a.txt").as_deref(), Some("D:\\proj"));
        assert_eq!(parent_dir("D:\\proj").as_deref(), Some("D:\\"));
        assert_eq!(parent_dir("D:\\"), None);
        assert_eq!(parent_dir("D:"), None);
    }

    #[test]
    fn parent_dir_stops_at_the_unc_share_root() {
        // \\wsl.localhost\Ubuntu is the share itself — nothing to reveal it in.
        assert_eq!(parent_dir("\\\\wsl.localhost\\Ubuntu"), None);
        assert_eq!(
            parent_dir("\\\\wsl.localhost\\Ubuntu\\home").as_deref(),
            Some("\\\\wsl.localhost\\Ubuntu")
        );
        assert_eq!(
            parent_dir("\\\\wsl.localhost\\Ubuntu\\home\\user\\a.txt").as_deref(),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\user")
        );
    }

    #[test]
    fn explorer_open_passes_the_path_as_a_single_argument() {
        // No shell involved: the path never reaches a command interpreter.
        assert_eq!(
            explorer_args(OsOpenMode::Open, "D:\\proj\\a b.txt"),
            vec!["D:\\proj\\a b.txt".to_string()]
        );
    }

    #[test]
    fn explorer_reveal_uses_select() {
        assert_eq!(
            explorer_args(
                OsOpenMode::Reveal,
                "\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt"
            ),
            vec!["/select,\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt".to_string()]
        );
    }

    #[test]
    fn explorer_reveal_degrades_to_open_without_a_parent() {
        assert_eq!(
            explorer_args(OsOpenMode::Reveal, "D:\\"),
            vec!["D:\\".to_string()]
        );
        assert_eq!(
            explorer_args(OsOpenMode::Reveal, "\\\\wsl.localhost\\Ubuntu"),
            vec!["\\\\wsl.localhost\\Ubuntu".to_string()]
        );
    }

    #[test]
    fn xdg_open_reveal_falls_back_to_the_parent_directory() {
        assert_eq!(
            xdg_open_target(OsOpenMode::Open, "/home/u/a.txt"),
            "/home/u/a.txt"
        );
        assert_eq!(
            xdg_open_target(OsOpenMode::Reveal, "/home/u/a.txt"),
            "/home/u"
        );
        assert_eq!(xdg_open_target(OsOpenMode::Reveal, "/"), "/");
    }

    #[test]
    fn open_in_os_rejects_an_unknown_mode_before_touching_the_path() {
        let err = open_in_os("/home/u/a.txt".into(), None, "launch".into()).unwrap_err();
        assert!(err.contains("launch"), "unexpected error: {err}");
    }
}
