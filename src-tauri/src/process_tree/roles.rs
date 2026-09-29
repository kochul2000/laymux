//! Non-interactive roles proven by native OS command-line inspection (ADR-0280).
use super::{name_to_app, ProcessEntry};
use std::ffi::{OsStr, OsString};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub(super) fn mark_helpers(entries: &mut [ProcessEntry]) {
    let pids: Vec<_> = entries
        .iter()
        .filter(|entry| name_to_app(&entry.name) == Some("Codex"))
        .map(|entry| Pid::from_u32(entry.pid))
        .collect();
    if pids.is_empty() {
        return;
    }
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    for entry in entries {
        if name_to_app(&entry.name) != Some("Codex") {
            continue;
        }
        if let Some(process) = system.process(Pid::from_u32(entry.pid)) {
            entry.is_helper = is_same_codex_server(
                entry,
                process.name(),
                process.parent().map(Pid::as_u32),
                process.cmd(),
            );
        }
        // An unreadable/missing command line is not evidence of a helper.
        // Retain its candidacy rather than authorizing a destructive checkpoint.
    }
}

fn is_same_codex_server(
    entry: &ProcessEntry,
    observed_name: &OsStr,
    observed_parent: Option<u32>,
    arguments: &[OsString],
) -> bool {
    name_to_app(&entry.name) == Some("Codex")
        && observed_name
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(&entry.name))
        && observed_parent == Some(entry.ppid)
        && arguments.get(1).is_some_and(|arg| arg == "app-server")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_server_mode_with_matching_process_identity_is_a_helper() {
        let entry = ProcessEntry {
            pid: 42,
            ppid: 10,
            name: "codex.exe".into(),
            is_helper: false,
        };
        let args = ["C:/codex.exe".into(), "app-server".into()];
        assert!(is_same_codex_server(
            &entry,
            OsStr::new("Codex.exe"),
            Some(10),
            &args
        ));
        for (name, parent) in [
            ("claude.exe", Some(10)),
            ("codex.exe", Some(11)),
            ("codex.exe", None),
        ] {
            assert!(!is_same_codex_server(
                &entry,
                OsStr::new(name),
                parent,
                &args
            ));
        }
        for args in [
            vec![],
            vec!["codex.exe"],
            vec!["codex.exe", "app-server-extra"],
            vec!["codex.exe", "app-server\nother"],
            vec!["codex.exe", "--", "app-server"],
            vec!["codex.exe", "-c", "app-server"],
            vec!["codex.exe", "resume", "app-server"],
        ] {
            let args: Vec<_> = args.into_iter().map(OsString::from).collect();
            assert!(!is_same_codex_server(
                &entry,
                OsStr::new("codex.exe"),
                Some(10),
                &args
            ));
        }
    }
}
