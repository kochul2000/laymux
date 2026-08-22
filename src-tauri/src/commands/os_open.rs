//! Hand a verified path-link target to the host desktop (issue #687, ADR-0100).
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
//! Confirmation policy lives in the frontend (ADR-0100 Decision 4); this module
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

/// Strip trailing separators so a selected `src/` and `src` produce the same
/// argument. Roots (`/`, `D:\`, `\\host\share`) keep their separator because
/// removing it changes what they address.
pub fn normalize_target(resolved: &str) -> String {
    let trimmed = resolved.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed.ends_with(':') || parent_dir(resolved).is_none() {
        return resolved.to_string();
    }
    trimmed.to_string()
}

/// How the argument must reach the child process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OsOpenArg {
    /// Normal argument — the standard Windows/POSIX escaping is correct.
    Escaped(String),
    /// Verbatim command line. `explorer.exe` does not parse its command line
    /// with `CommandLineToArgvW`: it reads everything after `/select,` with its
    /// own rules, so the quotes must wrap the **path only**. Rust's normal
    /// escaping wraps the whole `/select,<path>` argument once the path
    /// contains a space, which explorer then fails to recognize as a switch —
    /// verified on Windows 11: it silently opens the default folder instead of
    /// the target.
    ///
    /// Only used when the path itself contains no `"`. A native Windows path
    /// cannot, but a **WSL** one can — Linux filenames allow every byte except
    /// `/` and NUL, and `\\wsl.localhost\...` carries that name through
    /// verbatim. Embedding such a path would end the quoted run early and hand
    /// the remainder to explorer's own parser, so those targets take the
    /// escaped fallback instead (see `plan_for_resolved`).
    Raw(String),
}

/// Program + argument to hand the target to the host desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsOpenPlan {
    pub program: &'static str,
    pub arg: OsOpenArg,
}

/// Rewrite a Windows-shaped path to backslash separators.
///
/// `explorer.exe` does not accept forward slashes: handed `E:/dir` it silently
/// opens the default shell folder (Documents) instead of the target — the same
/// failure mode as a misquoted `/select,`, verified on Windows 11. Terminal
/// output routinely carries the POSIX form: an agent printing `/E:/dir` becomes
/// `E:/dir` once the path-link trim drops the leading slash, and
/// `resolve_address_path` returns an already-Windows path verbatim (its other
/// callers go through `std::fs`, which accepts both separators). This is
/// therefore the last place that can normalize it.
///
/// Only drive (`X:`) and UNC (`\\`, `//`) shapes are rewritten. A leftover
/// POSIX path — resolution fell through because no WSL distro was found — is
/// left alone: rewriting cannot make it open, and keeping it verbatim keeps the
/// path the user selected recognizable.
#[cfg(target_os = "windows")]
fn to_windows_separators(path: &str) -> String {
    let bytes = path.as_bytes();
    let is_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let is_unc = path.starts_with("\\\\") || path.starts_with("//");
    if !is_drive && !is_unc {
        return path.to_string();
    }
    path.replace('/', "\\")
}

/// Build the invocation for an already-resolved **host** path.
///
/// `Reveal` uses `/select,` on Windows; when the target has no parent (drive
/// root, UNC share root) there is nothing to select inside, so it degrades to
/// `Open` (ADR-0100 Decision 2). Linux has no portable "select this entry"
/// verb, so `Reveal` opens the parent directory instead (Decision 6).
pub fn plan_for_resolved(mode: OsOpenMode, resolved: &str) -> OsOpenPlan {
    let target = normalize_target(resolved);

    #[cfg(target_os = "windows")]
    {
        // explorer.exe reads only backslash separators (see `to_windows_separators`).
        let target = to_windows_separators(&target);
        let arg = match mode {
            OsOpenMode::Open => OsOpenArg::Escaped(target),
            OsOpenMode::Reveal => match parent_dir(&target) {
                // A `"` in the name would close the quoted run early and let
                // explorer's own parser read the rest as further arguments, so
                // those targets lose the selection and just open the containing
                // folder — the safe degradation, not a silently wrong window.
                Some(parent) if target.contains('"') => OsOpenArg::Escaped(parent),
                Some(_) => OsOpenArg::Raw(format!("/select,\"{target}\"")),
                None => OsOpenArg::Escaped(target),
            },
        };
        OsOpenPlan {
            program: "explorer.exe",
            arg,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let arg = match mode {
            OsOpenMode::Open => target,
            OsOpenMode::Reveal => parent_dir(&target).unwrap_or(target),
        };
        OsOpenPlan {
            program: "xdg-open",
            arg: OsOpenArg::Escaped(arg),
        }
    }
}

/// Resolve `path` to a host path and build the invocation.
///
/// The resolution is deliberately the same call `stat_path` makes, with the
/// same `(path, wsl_distro)` pair, so the underline that lit up and the target
/// handed to the OS can never disagree (ADR-0100 Decision 1 / 7).
pub fn plan_os_open(path: &str, wsl_distro: Option<&str>, mode: OsOpenMode) -> OsOpenPlan {
    let resolved = path_utils::resolve_address_path_following_symlinks(path, wsl_distro);
    plan_for_resolved(mode, &resolved)
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
    let plan = plan_os_open(&path, wsl_distro.as_deref(), mode);

    let mut command = crate::process::headless_command(plan.program);
    match &plan.arg {
        OsOpenArg::Escaped(arg) => {
            command.arg(arg);
        }
        OsOpenArg::Raw(raw) => {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                command.raw_arg(raw);
            }
            // `Raw` only exists to work around explorer.exe's command line
            // parser, so nothing else can produce it.
            #[cfg(not(target_os = "windows"))]
            {
                unreachable!("raw command lines are Windows-only: {raw}");
            }
        }
    }
    command
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {e}", plan.program))?;

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
    fn normalize_target_drops_a_trailing_separator_but_keeps_roots() {
        // A selected `src/` and `src` must produce the same argument.
        assert_eq!(normalize_target("D:\\proj\\src\\"), "D:\\proj\\src");
        assert_eq!(normalize_target("/home/u/src/"), "/home/u/src");
        // Roots address something different without their separator.
        assert_eq!(normalize_target("D:\\"), "D:\\");
        assert_eq!(normalize_target("/"), "/");
        assert_eq!(
            normalize_target("\\\\wsl.localhost\\Ubuntu\\"),
            "\\\\wsl.localhost\\Ubuntu\\"
        );
    }

    #[cfg(target_os = "windows")]
    mod windows_plan {
        use super::*;

        #[test]
        fn open_passes_the_path_as_a_normal_argument() {
            // No shell involved: the path never reaches a command interpreter,
            // and the standard escaping quotes a spaced path correctly.
            let plan = plan_for_resolved(OsOpenMode::Open, "D:\\proj\\a b.txt");
            assert_eq!(plan.program, "explorer.exe");
            assert_eq!(plan.arg, OsOpenArg::Escaped("D:\\proj\\a b.txt".into()));
        }

        #[test]
        fn reveal_quotes_the_path_only_inside_a_raw_command_line() {
            // Verified on Windows 11: with the whole `/select,<path>` argument
            // quoted (what the normal escaping produces for a spaced path)
            // explorer opens the default folder instead of the target.
            let plan = plan_for_resolved(OsOpenMode::Reveal, "D:\\proj dir\\a b.txt");
            assert_eq!(
                plan.arg,
                OsOpenArg::Raw("/select,\"D:\\proj dir\\a b.txt\"".into())
            );
        }

        #[test]
        fn reveal_works_for_a_wsl_unc_path() {
            let plan = plan_for_resolved(
                OsOpenMode::Reveal,
                "\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt",
            );
            assert_eq!(
                plan.arg,
                OsOpenArg::Raw("/select,\"\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt\"".into())
            );
        }

        #[test]
        fn reveal_degrades_to_open_without_a_parent() {
            assert_eq!(
                plan_for_resolved(OsOpenMode::Reveal, "D:\\").arg,
                OsOpenArg::Escaped("D:\\".into())
            );
            assert_eq!(
                plan_for_resolved(OsOpenMode::Reveal, "\\\\wsl.localhost\\Ubuntu").arg,
                OsOpenArg::Escaped("\\\\wsl.localhost\\Ubuntu".into())
            );
        }

        #[test]
        fn reveal_degrades_to_the_parent_folder_for_a_quoted_wsl_name() {
            // Linux filenames may contain `"`; the raw command line cannot
            // carry one, so the selection is dropped rather than risking
            // explorer parsing the remainder as further arguments.
            let plan = plan_for_resolved(
                OsOpenMode::Reveal,
                "\\\\wsl.localhost\\Ubuntu\\home\\u\\a\",calc.exe,\".txt",
            );
            assert_eq!(
                plan.arg,
                OsOpenArg::Escaped("\\\\wsl.localhost\\Ubuntu\\home\\u".into())
            );
        }

        #[test]
        fn reveal_normalizes_a_trailing_separator() {
            assert_eq!(
                plan_for_resolved(OsOpenMode::Reveal, "D:\\proj\\src\\").arg,
                OsOpenArg::Raw("/select,\"D:\\proj\\src\"".into())
            );
        }

        #[test]
        fn plan_reuses_the_stat_path_resolution() {
            // ADR-0100 Decision 1: the argument is the host path `stat_path`
            // resolved from the same (path, distro) pair — not a second rule.
            assert_eq!(
                plan_os_open("/mnt/c/Users/u/a.txt", None, OsOpenMode::Open).arg,
                OsOpenArg::Escaped("C:\\Users\\u\\a.txt".into())
            );
            assert_eq!(
                plan_os_open("/home/u/a.txt", Some("Ubuntu"), OsOpenMode::Open).arg,
                OsOpenArg::Escaped("\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt".into())
            );
            assert_eq!(
                plan_os_open("/home/u/a.txt", Some("Ubuntu"), OsOpenMode::Reveal).arg,
                OsOpenArg::Raw("/select,\"\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt\"".into())
            );
        }

        #[test]
        fn open_rewrites_forward_slashes_for_a_drive_path() {
            // The reported failure (a terminal-printed `/E:/…` path): explorer
            // opened the Documents folder instead of the target because the
            // argument kept its forward slashes.
            let plan = plan_for_resolved(OsOpenMode::Open, "E:/Desktop/work/rec");
            assert_eq!(
                plan.arg,
                OsOpenArg::Escaped("E:\\Desktop\\work\\rec".into())
            );
        }

        #[test]
        fn reveal_rewrites_forward_slashes_inside_the_raw_command_line() {
            let plan = plan_for_resolved(OsOpenMode::Reveal, "E:/Desktop/work/rec");
            assert_eq!(
                plan.arg,
                OsOpenArg::Raw("/select,\"E:\\Desktop\\work\\rec\"".into())
            );
        }

        #[test]
        fn open_rewrites_a_forward_slash_unc_path() {
            let plan = plan_for_resolved(OsOpenMode::Open, "//wsl.localhost/Ubuntu/home/u/a.txt");
            assert_eq!(
                plan.arg,
                OsOpenArg::Escaped("\\\\wsl.localhost\\Ubuntu\\home\\u\\a.txt".into())
            );
        }

        #[test]
        fn open_keeps_a_leftover_posix_path_verbatim() {
            // Resolution fell through (no WSL distro found). Backslashes would
            // not make it open, so the selected path stays recognizable.
            let plan = plan_for_resolved(OsOpenMode::Open, "/home/u/a.txt");
            assert_eq!(plan.arg, OsOpenArg::Escaped("/home/u/a.txt".into()));
        }

        #[test]
        fn a_drive_root_keeps_its_separator_as_a_backslash() {
            assert_eq!(
                plan_for_resolved(OsOpenMode::Open, "E:/").arg,
                OsOpenArg::Escaped("E:\\".into())
            );
        }

        #[test]
        fn plan_carries_the_rewrite_through_the_resolution_step() {
            assert_eq!(
                plan_os_open("E:/Desktop/work/rec", None, OsOpenMode::Open).arg,
                OsOpenArg::Escaped("E:\\Desktop\\work\\rec".into())
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    mod posix_plan {
        use super::*;

        #[test]
        fn reveal_falls_back_to_the_parent_directory() {
            let plan = plan_for_resolved(OsOpenMode::Open, "/home/u/a.txt");
            assert_eq!(plan.program, "xdg-open");
            assert_eq!(plan.arg, OsOpenArg::Escaped("/home/u/a.txt".into()));
            assert_eq!(
                plan_for_resolved(OsOpenMode::Reveal, "/home/u/a.txt").arg,
                OsOpenArg::Escaped("/home/u".into())
            );
            assert_eq!(
                plan_for_resolved(OsOpenMode::Reveal, "/").arg,
                OsOpenArg::Escaped("/".into())
            );
        }
    }

    #[test]
    fn open_in_os_rejects_an_unknown_mode_before_touching_the_path() {
        let err = open_in_os("/home/u/a.txt".into(), None, "launch".into()).unwrap_err();
        assert!(err.contains("launch"), "unexpected error: {err}");
    }
}
