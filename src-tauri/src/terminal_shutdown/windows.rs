use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, STILL_ACTIVE},
    System::{
        Console::{
            AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, GetConsoleProcessList,
            SetConsoleCtrlHandler, CTRL_C_EVENT,
        },
        Threading::{
            GetCurrentProcessId, GetExitCodeProcess, GetProcessTimes, OpenProcess,
            QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

use crate::constants::{
    TERMINAL_CLOSE_CONSOLE_CLI_FLAG, TERMINAL_CLOSE_GRACE_MS, TERMINAL_CLOSE_HELPER_TIMEOUT_MS,
};

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: this type owns exactly one successful OpenProcess handle.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
impl Process {
    fn open(pid: u32) -> Result<Self, String> {
        // SAFETY: OpenProcess copies a scalar PID and returns an owned handle.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(Self(handle))
        }
    }
    fn birth(&self) -> Result<u64, String> {
        let blank = || FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut ended, mut kernel, mut user) = (blank(), blank(), blank(), blank());
        // SAFETY: all output pointers address initialized FILETIME values.
        if unsafe { GetProcessTimes(self.0, &mut created, &mut ended, &mut kernel, &mut user) } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
    fn running(&self) -> bool {
        let mut code = 0;
        // SAFETY: the owned handle and output pointer stay valid for this call.
        unsafe { GetExitCodeProcess(self.0, &mut code) != 0 && code == STILL_ACTIVE as u32 }
    }
    fn shell(&self) -> bool {
        let mut text = [0u16; 32768];
        let mut count = text.len() as u32;
        // SAFETY: count is the writable capacity of text, in wide characters.
        if unsafe { QueryFullProcessImageNameW(self.0, 0, text.as_mut_ptr(), &mut count) } == 0 {
            return false;
        }
        let image = String::from_utf16_lossy(&text[..count as usize]).to_ascii_lowercase();
        matches!(
            image.rsplit(['/', '\\']).next(),
            Some("powershell.exe" | "pwsh.exe" | "cmd.exe" | "bash.exe" | "sh.exe")
        )
    }
}

#[derive(Clone)]
pub(super) struct Target {
    pid: u32,
    birth: u64,
}
impl Target {
    pub(super) fn new(pid: u32) -> Result<Self, String> {
        Ok(Self {
            pid,
            birth: Process::open(pid)?.birth()?,
        })
    }
    pub(super) fn request(&self) -> Result<(), String> {
        let mut command =
            crate::process::headless_command(std::env::current_exe().map_err(|e| e.to_string())?);
        command.args([
            TERMINAL_CLOSE_CONSOLE_CLI_FLAG,
            &self.pid.to_string(),
            &self.birth.to_string(),
        ]);
        let output = crate::process::output_with_timeout(
            &mut command,
            Duration::from_millis(TERMINAL_CLOSE_HELPER_TIMEOUT_MS),
        )
        .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Windows console shutdown failed: {}",
                String::from_utf8_lossy(&output.stdout).trim()
            ))
        }
    }
}

unsafe extern "system" fn ignore_control(_event: u32) -> i32 {
    1
}

fn console_pids() -> Result<Vec<u32>, String> {
    let mut pids = vec![0u32; 32];
    loop {
        // SAFETY: the vector has the declared writable capacity.
        let count = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) };
        if count == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if count as usize <= pids.len() {
            pids.truncate(count as usize);
            return Ok(pids);
        }
        if count > 4096 {
            return Err("target console process list is too large".into());
        }
        pids.resize(count as usize, 0);
    }
}

pub(super) fn signal_console(pid: u32, birth: u64) -> Result<(), String> {
    let root = Process::open(pid)?;
    if root.birth()? != birth || !root.running() {
        return Ok(());
    }
    // This helper owns no GUI. The open root handle pins its Windows PID across
    // validation, attach and signal, so reuse cannot redirect it to another pane.
    // SAFETY: these process-global operations affect only this short-lived helper.
    unsafe {
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if SetConsoleCtrlHandler(Some(ignore_control), 1) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    let own = unsafe { GetCurrentProcessId() };
    let root_is_shell = root.shell();
    let jobs = console_pids()?
        .into_iter()
        .filter(|p| *p != own && (!root_is_shell || *p != pid))
        .filter_map(|p| Process::open(p).ok())
        .collect::<Vec<_>>();
    if jobs.is_empty() {
        return Ok(());
    }
    // SAFETY: the helper is attached to this validated child's private PTY
    // console; group zero broadcasts only inside that console, not other panes.
    if unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let deadline = Instant::now() + Duration::from_millis(TERMINAL_CLOSE_GRACE_MS);
    while jobs.iter().any(Process::running) {
        if Instant::now() >= deadline {
            return Err("Windows console shutdown deadline expired".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
