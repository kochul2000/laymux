use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::Deserialize;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::state::AppState;

use super::session_attribution::{provider_terminal_domains, ProviderSessionLookup};
use super::wsl_agent_session::{resolve_wsl_agent_processes, WslAgentProvider};

/// `<configured grok command> --resume <uuid>` only. Prefix is re-derived
/// from disk settings (ADR-0125 / ADR-0156).
pub(crate) fn is_valid_grok_startup_command_override(cmd: &str, configured_command: &str) -> bool {
    let agent = crate::settings::agent_command::resolve_agent_command(
        configured_command,
        crate::settings::agent_command::DEFAULT_GROK_COMMAND,
    );
    cmd.strip_prefix(&format!("{agent} --resume "))
        .is_some_and(is_valid_grok_session_id)
}

pub(crate) fn is_valid_grok_session_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let hex = byte.is_ascii_hexdigit();
        let hyphen = *byte == b'-' && matches!(index, 8 | 13 | 18 | 23);
        if !hex && !hyphen {
            return false;
        }
        if matches!(index, 8 | 13 | 18 | 23) && *byte != b'-' {
            return false;
        }
    }
    true
}

#[derive(Debug, Deserialize)]
struct ActiveGrokSession {
    session_id: String,
    pid: u32,
}

fn grok_home() -> PathBuf {
    if let Ok(home) = std::env::var("GROK_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let user_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(user_home).join(".grok")
}

#[cfg(test)]
fn read_active_sessions(home: &Path) -> Vec<ActiveGrokSession> {
    read_active_sessions_checked(home).unwrap_or_default()
}

fn read_active_sessions_checked(home: &Path) -> Result<Vec<ActiveGrokSession>, String> {
    let path = home.join("active_sessions.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(sessions) => Ok(sessions),
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                %error,
                "failed to parse Grok active_sessions.json"
            );
            Err(format!("failed to parse {}: {error}", path.display()))
        }
    }
}

fn session_summary_path_checked(home: &Path, session_id: &str) -> Result<Option<PathBuf>, String> {
    let sessions = home.join("sessions");
    let entries = match std::fs::read_dir(&sessions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", sessions.display())),
    };
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to read {}: {error}", sessions.display()))?;
        let candidate = entry.path().join(session_id).join("summary.json");
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn summary_within_age_checked(path: &Path, max_age_hours: Option<u64>) -> Result<bool, String> {
    let Some(hours) = max_age_hours.filter(|&h| h > 0) else {
        return Ok(true);
    };
    let meta = std::fs::metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    let modified = meta
        .modified()
        .map_err(|error| format!("failed to read timestamp for {}: {error}", path.display()))?;
    let age = SystemTime::now()
        .duration_since(modified)
        .map_err(|error| format!("invalid timestamp for {}: {error}", path.display()))?;
    Ok(age.as_secs() <= hours.saturating_mul(3600))
}

#[cfg(test)]
fn session_id_for_pid(home: &Path, pid: u32, max_age_hours: Option<u64>) -> Option<String> {
    session_id_for_pid_checked(home, pid, max_age_hours)
        .ok()
        .flatten()
}

fn session_id_for_pid_checked(
    home: &Path,
    pid: u32,
    max_age_hours: Option<u64>,
) -> Result<Option<String>, String> {
    let mut session_ids: Vec<String> = read_active_sessions_checked(home)?
        .into_iter()
        .filter(|entry| entry.pid == pid)
        .map(|entry| entry.session_id)
        .filter(|id| is_valid_grok_session_id(id))
        .collect();
    session_ids.sort();
    session_ids.dedup();
    // One Grok process can list multiple sessions; pick nothing rather than
    // resume the first JSON entry (ADR-0156).
    if session_ids.len() != 1 {
        return Ok(None);
    }
    let Some(session_id) = session_ids.pop() else {
        return Ok(None);
    };
    let Some(summary) = session_summary_path_checked(home, &session_id)? else {
        return Ok(None);
    };
    if !summary_within_age_checked(&summary, max_age_hours)? {
        return Ok(None);
    }
    Ok(Some(session_id))
}

#[tauri::command(async)]
pub fn get_grok_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    get_grok_session_ids_impl(session_max_age_hours, &state)
}

pub(crate) fn get_grok_session_ids_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<HashMap<String, Option<String>>, String> {
    Ok(get_grok_session_lookup_impl(session_max_age_hours, state)?.attributions)
}

pub(crate) fn get_grok_session_lookup_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<ProviderSessionLookup, String> {
    let known: Vec<String> = {
        let k = state.known_grok_terminals.lock_or_err()?;
        k.iter().cloned().collect()
    };
    let home = grok_home();
    let domains = provider_terminal_domains(&known, state)?;
    let terminal_roots = domains.native_roots;
    let native_terminal_ids: HashSet<String> = terminal_roots
        .iter()
        .map(|(terminal_id, _)| terminal_id.clone())
        .collect();
    let mut failed_terminal_ids = HashSet::new();
    let mut candidates = Vec::new();
    if !terminal_roots.is_empty() {
        match crate::process_tree::try_snapshot_processes() {
            Ok(snapshot) => {
                for (terminal_id, root_pid) in terminal_roots {
                    let Some((pid, app)) =
                        crate::process_tree::match_interactive_app_process(&snapshot, root_pid)
                    else {
                        continue;
                    };
                    if app != "Grok" {
                        continue;
                    }
                    match session_id_for_pid_checked(&home, pid, session_max_age_hours) {
                        Ok(Some(session_id)) => candidates.push((terminal_id, session_id)),
                        Ok(None) => {}
                        Err(error) => {
                            failed_terminal_ids.insert(terminal_id.clone());
                            tracing::warn!(%error, "native Grok session lookup failed");
                        }
                    }
                }
            }
            Err(error) => {
                failed_terminal_ids.extend(native_terminal_ids);
                tracing::warn!(%error, "native Grok process attribution failed");
            }
        }
    }
    let mut result = crate::process_tree::complete_agent_session_attributions(
        &known,
        crate::process_tree::reject_duplicate_session_attributions(
            candidates
                .into_iter()
                .map(|(id, session)| (id, Some(session)))
                .collect(),
            "Grok",
        )
        .into_iter()
        .filter_map(|(id, session)| session.map(|session| (id, session)))
        .collect(),
    );
    match resolve_wsl_agent_processes(state, WslAgentProvider::Grok) {
        Ok(lookup) => {
            failed_terminal_ids.extend(lookup.failed_terminal_ids);
            for (terminal_id, process) in lookup.attributions {
                let session_id = match process {
                    Some(process) => match process.grok_home_dir() {
                        Some(home) => match session_id_for_pid_checked(
                            &home,
                            process.pid,
                            session_max_age_hours,
                        ) {
                            Ok(session_id) => session_id,
                            Err(error) => {
                                failed_terminal_ids.insert(terminal_id.clone());
                                tracing::warn!(%error, "WSL Grok session lookup failed");
                                None
                            }
                        },
                        None => None,
                    },
                    None => None,
                };
                result.insert(terminal_id, session_id);
            }
        }
        Err(error) => {
            failed_terminal_ids.extend(domains.wsl_terminal_ids);
            tracing::warn!(%error, "WSL Grok attribution failed");
        }
    }
    Ok(ProviderSessionLookup {
        attributions: crate::process_tree::reject_duplicate_session_attributions(result, "Grok"),
        failed_terminal_ids,
        rollout_absence: HashMap::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    #[test]
    fn resume_override_requires_uuid() {
        assert!(is_valid_grok_startup_command_override(
            "grok --resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
            "grok"
        ));
        assert!(is_valid_grok_startup_command_override(
            "grok --yolo --resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
            "grok --yolo"
        ));
        assert!(!is_valid_grok_startup_command_override(
            "grok --resume not-a-uuid",
            "grok"
        ));
        assert!(!is_valid_grok_startup_command_override(
            "grok resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
            "grok"
        ));
        assert!(!is_valid_grok_startup_command_override(
            "grok --resume 019ffa7fb8c17511872f911e8dc8d179",
            "grok"
        ));
    }

    fn write_summary(home: &Path, session_id: &str) -> PathBuf {
        let summary = home
            .join("sessions")
            .join("proj")
            .join(session_id)
            .join("summary.json");
        std::fs::create_dir_all(summary.parent().unwrap()).unwrap();
        std::fs::write(&summary, "{}").unwrap();
        summary
    }

    #[test]
    fn session_id_for_pid_matches_live_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        write_summary(home, sid);
        assert_eq!(
            session_id_for_pid(home, 4242, Some(24)).as_deref(),
            Some(sid)
        );
    }

    #[test]
    fn session_id_for_pid_rejects_non_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::write(
            home.join("active_sessions.json"),
            r#"[{"session_id":"not-a-uuid","pid":4242}]"#,
        )
        .unwrap();
        write_summary(home, "not-a-uuid");
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_requires_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_rejects_stale_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        let summary = write_summary(home, sid);
        let file = std::fs::File::options().write(true).open(summary).unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(48 * 3600);
        file.set_modified(old).unwrap();
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_rejects_duplicate_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let first = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        let second = "019ffa7f-b8c1-7511-872f-911e8dc8d180";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(
                r#"[{{"session_id":"{first}","pid":4242}},{{"session_id":"{second}","pid":4242}}]"#
            ),
        )
        .unwrap();
        write_summary(home, first);
        write_summary(home, second);
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_accepts_duplicate_rows_of_the_same_id() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}},{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        write_summary(home, sid);
        assert_eq!(
            session_id_for_pid(home, 4242, Some(24)).as_deref(),
            Some(sid)
        );
    }

    #[test]
    fn malformed_active_sessions_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::write(home.join("active_sessions.json"), "{not json").unwrap();
        assert!(read_active_sessions(home).is_empty());
        assert!(read_active_sessions_checked(home).is_err());
    }
}
