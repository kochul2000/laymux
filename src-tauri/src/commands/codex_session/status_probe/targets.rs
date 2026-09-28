use super::super::store::CodexSessionStore;
use crate::commands::wsl_agent_session::{resolve_wsl_agent_processes, WslAgentProvider};
use crate::lock_ext::MutexExt;
use crate::session_checkpoint::codex_status::{
    CodexStatusProcess, CodexStatusStep, CodexStatusTarget,
};
use crate::state::AppState;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::time::Duration;

fn processes(state: &AppState) -> Result<HashMap<String, CodexStatusProcess>, String> {
    let domains = crate::commands::session_attribution::provider_terminal_domains(state)?;
    let snapshot = crate::process_tree::try_snapshot_processes()?;
    let mut result = HashMap::new();
    for (id, root) in domains.native_roots {
        if let Some((pid, "Codex")) =
            crate::process_tree::match_interactive_app_process(&snapshot, root)
        {
            let context =
                super::process_context::read(pid).map_err(|error| format!("[{id}] {error}"))?;
            result.insert(
                id.clone(),
                CodexStatusProcess {
                    pid,
                    started_at: process_start(pid, None)
                        .map_err(|error| format!("[{id}] {error}"))?,
                    distro: None,
                    codex_home: context.codex_home,
                    sqlite_home: context.sqlite_home,
                },
            );
        }
    }
    let wsl = resolve_wsl_agent_processes(state, WslAgentProvider::Codex)?;
    if !wsl.failed_terminal_ids.is_empty() {
        let mut ids: Vec<_> = wsl
            .failed_terminal_ids
            .iter()
            .map(|id| format!("[{id}]"))
            .collect();
        ids.sort();
        return Err(format!(
            "Could not verify WSL Codex processes {}",
            ids.join(" ")
        ));
    }
    let mut ambiguous: Vec<_> = wsl
        .attributions
        .iter()
        .filter(|(_, process)| process.is_none())
        .map(|(id, _)| format!("[{id}]"))
        .collect();
    ambiguous.sort();
    if !ambiguous.is_empty() {
        return Err(format!(
            "Ambiguous WSL Codex process {}",
            ambiguous.join(" ")
        ));
    }
    for (id, process) in wsl.attributions {
        let process = process.ok_or_else(|| format!("Ambiguous WSL Codex process [{id}]"))?;
        let codex_home = process
            .codex_home_dir()
            .ok_or_else(|| format!("[{id}] Could not resolve WSL Codex home"))?;
        result.insert(
            id.clone(),
            CodexStatusProcess {
                pid: process.pid,
                started_at: process_start(process.pid, Some(&process.distro))
                    .map_err(|error| format!("[{id}] {error}"))?,
                distro: Some(process.distro),
                sqlite_home: codex_home.clone(),
                codex_home,
            },
        );
    }
    Ok(result)
}

pub(super) fn require_current_process(
    state: &AppState,
    id: &str,
    expected: &CodexStatusProcess,
) -> Result<(), String> {
    if processes(state)?.get(id) != Some(expected) {
        return Err(format!("[{id}] Codex process changed during status query"));
    }
    Ok(())
}

pub(super) fn collect_targets(
    state: &AppState,
) -> Result<HashMap<String, CodexStatusTarget>, String> {
    let candidates = processes(state)?;
    let terminals: HashMap<_, _> = state
        .terminals
        .lock_or_err()?
        .iter()
        .map(|(id, terminal)| {
            (
                id.clone(),
                (
                    terminal.cwd.clone(),
                    terminal.config.cols,
                    terminal.config.rows,
                ),
            )
        })
        .collect();
    let handles = state.pty_handles.lock_or_err()?.clone();
    let mut targets = HashMap::new();
    for (id, process) in candidates {
        let terminal = terminals
            .get(&id)
            .ok_or_else(|| format!("[{id}] Codex terminal disappeared"))?;
        let handle = handles
            .get(&id)
            .ok_or_else(|| format!("[{id}] Codex terminal disappeared"))?;
        let cwd = terminal
            .0
            .as_deref()
            .ok_or_else(|| format!("[{id}] Codex working directory is unknown"))?;
        let cwd = if let Some(distro) = &process.distro {
            PathBuf::from(crate::path_utils::resolve_path_for_windows(
                cwd,
                Some(distro),
            ))
        } else {
            PathBuf::from(cwd)
        };
        require_default_editor_config(&process, &cwd).map_err(|error| format!("[{id}] {error}"))?;
        targets.insert(
            id,
            CodexStatusTarget {
                io: std::sync::Arc::new(std::sync::Mutex::new(())),
                generation: handle.terminal_generation(),
                process,
                original_cols: terminal.1,
                original_rows: terminal.2,
                resized: false,
                dismissed: false,
                clear_batches: 0,
                next_step: Some(CodexStatusStep::Clear),
                output_start: None,
                proof: None,
            },
        );
    }
    Ok(targets)
}

pub(super) fn verify_session(process: &CodexStatusProcess, id: &str) -> Result<bool, String> {
    let store = if process.distro.is_some() {
        CodexSessionStore::for_guest(process.codex_home.clone())
    } else {
        CodexSessionStore::new(process.codex_home.clone(), process.sqlite_home.clone())
    };
    let fresh = store.verify_status_session(id)?;
    if fresh {
        if let Some(distro) = &process.distro {
            #[cfg(windows)]
            super::wsl_rollout::require_absent(distro, &process.codex_home, id)?;
            #[cfg(not(windows))]
            {
                let _ = distro;
                return Err("WSL is unavailable on this host".into());
            }
        }
    }
    Ok(fresh)
}

fn require_default_editor_config(process: &CodexStatusProcess, cwd: &Path) -> Result<(), String> {
    let args = process_arguments(process)?;
    if args.iter().skip(1).any(|arg| has_cli_override(arg)) {
        return Err(
            "Codex status verification requires the default local configuration (no CLI overrides)"
                .into(),
        );
    }
    if let Some(distro) = &process.distro {
        #[cfg(windows)]
        {
            let configs = super::wsl_config::read_editor_configs(
                distro,
                process.pid,
                &process.codex_home,
                cwd,
            )?;
            if configs.iter().any(|text| has_custom_editor_config(text)) {
                return Err("Codex status verification requires default editor keys; unsupported WSL configuration was found".into());
            }
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let _ = distro;
            return Err("WSL is unavailable on this host".into());
        }
    }
    let mut paths = vec![
        process.codex_home.join("config.toml"),
        process.codex_home.join("managed_config.toml"),
    ];
    paths.extend(cwd.ancestors().map(|path| path.join(".codex/config.toml")));
    {
        let native = super::process_context::read(process.pid)?;
        if native.codex_home != process.codex_home || native.sqlite_home != process.sqlite_home {
            return Err("Codex process storage paths changed".into());
        }
        paths.extend(
            native
                .cwd
                .ancestors()
                .map(|path| path.join(".codex/config.toml")),
        );
        #[cfg(not(windows))]
        paths.extend([
            PathBuf::from("/etc/codex/config.toml"),
            PathBuf::from("/etc/codex/managed_config.toml"),
            PathBuf::from("/etc/codex/requirements.toml"),
        ]);
        #[cfg(windows)]
        {
            let system = super::process_context::system_config_dir()?;
            paths.extend([system.join("config.toml"), system.join("requirements.toml")]);
        }
    }
    for path in paths {
        match std::fs::read_to_string(&path) {
            Ok(text) if has_custom_editor_config(&text) => return Err("Codex status verification requires default editor keys; unsupported keymap, Vim, or storage configuration was found".into()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not verify Codex editor configuration: {error}")),
        }
    }
    Ok(())
}

fn has_cli_override(arg: &str) -> bool {
    ["-c", "-p", "-C"]
        .iter()
        .any(|prefix| arg.starts_with(prefix))
        || ["--config", "--profile", "--remote", "--cd"]
            .iter()
            .any(|name| {
                arg == *name
                    || arg
                        .strip_prefix(name)
                        .is_some_and(|tail| tail.starts_with('='))
            })
}

fn has_custom_editor_config(text: &str) -> bool {
    fn custom(value: &toml::Value) -> bool {
        match value {
            toml::Value::Table(table) => table.iter().any(|(key, value)| match key.as_str() {
                "keymap" => !has_only_chat_arrow_bindings(value),
                "vim_mode" | "vim_mode_default" => value.as_bool() != Some(false),
                "include" | "sqlite_home" => true,
                _ => custom(value),
            }),
            toml::Value::Array(array) => array.iter().any(custom),
            _ => false,
        }
    }
    toml::from_str::<toml::Value>(text).map_or(true, |value| custom(&value))
}

// Chat shortcuts on arrow keys do not change the default composer/editor or
// consume Ctrl+E/U/K, paste, or Enter. Everything else requires upstream runtime
// keymap introspection and is outside this optional probe's supported scope.
fn has_only_chat_arrow_bindings(value: &toml::Value) -> bool {
    fn arrow(value: &toml::Value) -> bool {
        let Some(spec) = value.as_str() else {
            return false;
        };
        let mut parts: Vec<_> = spec.split('-').collect();
        matches!(parts.pop(), Some("up" | "down" | "left" | "right"))
            && parts
                .iter()
                .all(|part| matches!(*part, "alt" | "shift" | "ctrl" | "super" | "meta"))
    }
    value.as_table().is_some_and(|contexts| {
        contexts.iter().all(|(context, actions)| {
            context == "chat"
                && actions.as_table().is_some_and(|actions| {
                    actions.values().all(|binding| {
                        if let Some(bindings) = binding.as_array() {
                            bindings.iter().all(arrow)
                        } else {
                            arrow(binding)
                        }
                    })
                })
        })
    })
}

fn process_arguments(process: &CodexStatusProcess) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        if let Some(distro) = &process.distro {
            let mut command = crate::process::headless_command("wsl.exe");
            command.args([
                "-d",
                distro,
                "--exec",
                "cat",
                &format!("/proc/{}/cmdline", process.pid),
            ]);
            let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(3))
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err("Could not inspect Codex launch arguments".into());
            }
            return String::from_utf8(output.stdout)
                .map(|value| value.split_terminator('\0').map(str::to_owned).collect())
                .map_err(|_| "Could not decode WSL Codex launch arguments".into());
        }
    }
    Ok(super::process_context::read(process.pid)?.arguments)
}

fn process_start(pid: u32, distro: Option<&str>) -> Result<u64, String> {
    #[cfg(windows)]
    if distro.is_none() {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // A kernel creation timestamp distinguishes PID reuse during the probe.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return Err("Could not verify Codex process creation time".into());
            }
            let mut creation: FILETIME = std::mem::zeroed();
            let mut exit: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let ok = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user);
            CloseHandle(process);
            if ok == 0 {
                return Err("Could not verify Codex process creation time".into());
            }
            return Ok(
                (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime)
            );
        }
    }
    #[cfg(windows)]
    let stat = {
        let mut command = crate::process::headless_command("wsl.exe");
        command.args([
            "-d",
            distro.ok_or("Missing WSL distro")?,
            "--exec",
            "cat",
            &format!("/proc/{pid}/stat"),
        ]);
        let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not verify WSL Codex process creation time".into());
        }
        String::from_utf8(output.stdout).map_err(|e| e.to_string())?
    };
    #[cfg(not(windows))]
    let stat = {
        let _ = distro;
        std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.to_string())?
    };
    stat.rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "Invalid Codex process creation time".into())
}

#[cfg(test)]
mod tests {
    use super::has_custom_editor_config;
    #[test]
    fn attached_cli_overrides_cannot_bypass_editor_verification() {
        for arg in [
            "-ctui.keymap.composer.submit='ctrl-u'",
            "-pprofile",
            "-Celsewhere",
            "--cd=elsewhere",
            "--config=x",
            "--remote=ws://localhost",
        ] {
            assert!(super::has_cli_override(arg), "{arg}");
        }
        assert!(!super::has_cli_override("--no-alt-screen"));
    }
    #[test]
    fn custom_key_bindings_are_rejected_before_any_destructive_input() {
        assert!(has_custom_editor_config(
            "[tui.keymap.composer]\nsubmit = 'ctrl-u'"
        ));
        assert!(has_custom_editor_config(
            "tui = { keymap = { global = {} } }"
        ));
        assert!(has_custom_editor_config("[tui]\nvim_mode = true"));
        assert!(has_custom_editor_config("[tui]\nvim_mode_default = true"));
        assert!(!has_custom_editor_config("[tui]\nvim_mode_default = false"));
        assert!(!has_custom_editor_config(
            "[tui.keymap.chat]\nedit_queued_message = ['alt-shift-up', 'shift-left']"
        ));
        assert!(has_custom_editor_config(
            "[tui.keymap.chat]\nedit_queued_message = ['ctrl-u']"
        ));
        assert!(has_custom_editor_config(
            "[tui.keymap.editor]\nkill_line_start = []"
        ));
        assert!(!has_custom_editor_config(
            "# keymap example\nmodel = 'gpt-6'"
        ));
        assert!(!has_custom_editor_config(
            "developer_instructions = 'include tests for keymap support'"
        ));
        assert!(has_custom_editor_config(
            "[tui.\"key\\u006dap\".composer]\nsubmit = 'ctrl-u'"
        ));
    }
}
