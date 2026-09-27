//! Inspect the selected native TUI, never Laymux's inherited environment.
//! sysinfo owns the OS-specific process-memory/procfs reads. Environment values
//! are neither logged nor retained; only Codex's two storage paths leave here.
use crate::constants::{ENV_CODEX_HOME, ENV_CODEX_SQLITE_HOME};
use std::collections::HashMap;
use std::path::PathBuf;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub(super) struct NativeContext {
    pub codex_home: PathBuf,
    pub sqlite_home: PathBuf,
    pub cwd: PathBuf,
    pub arguments: Vec<String>,
}

pub(super) fn read(pid: u32) -> Result<NativeContext, String> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing()
            .with_environ(UpdateKind::Always)
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    let process = system.process(pid).ok_or("Codex process disappeared")?;
    let mut environment = HashMap::new();
    for entry in process.environ() {
        let entry = entry
            .to_str()
            .ok_or("Could not decode Codex process environment")?;
        if let Some((key, value)) = entry.split_once('=') {
            environment.insert(key, value);
        }
    }
    if environment.is_empty() {
        return Err("Could not inspect Codex process environment".into());
    }
    let value = |name: &str| {
        environment
            .iter()
            .find(|(key, _)| {
                if cfg!(windows) {
                    key.eq_ignore_ascii_case(name)
                } else {
                    **key == name
                }
            })
            .map(|(_, value)| *value)
            .filter(|value| !value.trim().is_empty())
    };
    let codex_home = match value(ENV_CODEX_HOME) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(
            value(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("Could not resolve the Codex process home")?,
        )
        .join(".codex"),
    };
    let sqlite_home = value(ENV_CODEX_SQLITE_HOME)
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home.clone());
    if !codex_home.is_absolute() || !sqlite_home.is_absolute() {
        return Err("Codex status verification requires absolute storage paths".into());
    }
    let cwd = process
        .cwd()
        .filter(|path| path.is_absolute())
        .ok_or("Could not inspect the Codex working directory")?
        .to_path_buf();
    let arguments: Vec<String> = process
        .cmd()
        .iter()
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or_else(|| "Could not decode Codex launch arguments".to_owned())
        })
        .collect::<Result<_, _>>()?;
    if arguments.is_empty() {
        return Err("Could not inspect Codex launch arguments".into());
    }
    Ok(NativeContext {
        codex_home,
        sqlite_home,
        cwd,
        arguments,
    })
}

#[cfg(windows)]
pub(super) fn system_config_dir() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};
    let mut raw = std::ptr::null_mut();
    // Codex uses the known folder, not an overridable PROGRAMDATA environment
    // variable. The API owns an allocated, NUL-terminated UTF-16 path on success.
    unsafe {
        if SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut raw) < 0
            || raw.is_null()
        {
            return Err("Could not inspect the Codex system configuration directory".into());
        }
        let mut len = 0;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(raw, len));
        CoTaskMemFree(raw.cast());
        Ok(PathBuf::from(path).join("OpenAI/Codex"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn uses_child_environment_even_when_laymux_has_a_different_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("codex-home");
        let sqlite = temp.path().join("sqlite-home");
        #[cfg(windows)]
        let mut command = crate::process::headless_command("cmd.exe");
        #[cfg(windows)]
        command.args(["/c", "pause"]);
        #[cfg(not(windows))]
        let mut command = crate::process::headless_command("sh");
        #[cfg(not(windows))]
        command.args(["-c", "read value"]);
        let mut child = command
            .env("CODEX_HOME", &home)
            .env("CODEX_SQLITE_HOME", &sqlite)
            .current_dir(temp.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = read(child.id());
        let _ = child.kill();
        let _ = child.wait();
        let context = result.unwrap();
        assert_eq!(context.codex_home, home);
        assert_eq!(context.sqlite_home, sqlite);
        assert_eq!(
            std::fs::canonicalize(context.cwd).unwrap(),
            std::fs::canonicalize(temp.path()).unwrap()
        );
        assert!(!context.arguments.is_empty());
    }

    #[test]
    fn missing_process_does_not_fall_back_to_laymux_environment() {
        assert!(read(u32::MAX).is_err());
    }
}
