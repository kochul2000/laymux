use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::terminal::TerminalSession;

/// Expand Windows-style environment variable references (e.g. `%USERPROFILE%`)
/// in a path string. Also expands `~` as a shorthand for the user's home directory.
fn expand_env_in_path(path: &str) -> String {
    let mut result = path.to_string();

    // Expand ~ to home directory
    if result == "~" || result.starts_with("~/") || result.starts_with("~\\") {
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            result = format!("{}{}", home, &result[1..]);
        }
    }

    // Expand %VAR% style environment variables
    let mut search_from = 0;
    while let Some(rel_start) = result[search_from..].find('%') {
        let start = search_from + rel_start;
        if let Some(end) = result[start + 1..].find('%') {
            let var_name = &result[start + 1..start + 1 + end];
            if let Ok(val) = std::env::var(var_name) {
                result = format!("{}{}{}", &result[..start], val, &result[start + 2 + end..]);
                search_from = start + val.len();
            } else {
                // Variable not found — skip past it to avoid infinite loop
                break;
            }
        } else {
            break;
        }
    }

    result
}

/// Handle to a running PTY process, providing write and resize capabilities.
pub struct PtyHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
}

impl PtyHandle {
    /// Write data (user input) to the PTY.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| format!("Lock error: {e}"))?;
        writer
            .write_all(data)
            .map_err(|e| format!("Write error: {e}"))?;
        writer.flush().map_err(|e| format!("Flush error: {e}"))
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().map_err(|e| format!("Lock error: {e}"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize error: {e}"))
    }
}

/// Spawn a PTY process for the given terminal session.
/// Returns a PtyHandle and starts a reader thread that calls `on_output` with data chunks.
pub fn spawn_pty<F>(session: &TerminalSession, on_output: F) -> Result<PtyHandle, String>
where
    F: Fn(Vec<u8>) + Send + 'static,
{
    let pty_system = native_pty_system();

    let size = PtySize {
        rows: session.config.rows,
        cols: session.config.cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Collect all env vars (config + IDE vars) for shell script injection
    let mut all_env: Vec<(String, String)> = session.config.env.clone();
    all_env.push(("LX_TERMINAL_ID".into(), session.id.clone()));
    all_env.push(("LX_GROUP_ID".into(), session.config.sync_group.clone()));

    let (cmd_path, args) = if session.config.command_line.is_empty() {
        // Fallback: legacy profile name-based resolution
        TerminalSession::profile_to_command_with_env(&session.config.profile, &all_env)
    } else {
        TerminalSession::command_line_to_command_with_startup(
            &session.config.command_line,
            &all_env,
            &session.config.startup_command,
        )
    };
    let mut cmd = CommandBuilder::new(&cmd_path);
    for arg in &args {
        cmd.arg(arg);
    }

    // Also set env vars at the Windows process level (for PowerShell/CMD)
    for (key, value) in &all_env {
        cmd.env(key, value);
    }

    // Set starting directory if configured
    if !session.config.starting_directory.is_empty() {
        let dir = expand_env_in_path(&session.config.starting_directory);
        let path = std::path::Path::new(&dir);
        if path.is_dir() {
            cmd.cwd(path);
        }
    }

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    // Drop slave — we only need master
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {e}"))?;

    let handle = PtyHandle {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
    };

    // Spawn reader thread
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    on_output(buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::TerminalConfig;
    use std::sync::mpsc;
    use std::time::Duration;

    fn make_test_session(profile: &str) -> TerminalSession {
        TerminalSession::new(
            "test-pty".into(),
            TerminalConfig {
                profile: profile.into(),
                command_line: String::new(),
                startup_command: String::new(),
                starting_directory: String::new(),
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![("TEST_VAR".into(), "hello".into())],
            },
        )
    }

    fn make_test_session_with_cwd(profile: &str, cwd: &str) -> TerminalSession {
        TerminalSession::new(
            "test-pty-cwd".into(),
            TerminalConfig {
                profile: profile.into(),
                command_line: String::new(),
                startup_command: String::new(),
                starting_directory: cwd.into(),
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![],
            },
        )
    }

    #[test]
    fn pty_handle_write_and_resize_types_exist() {
        // Verify PtyHandle has the expected interface
        fn _assert_write(handle: &PtyHandle) -> Result<(), String> {
            handle.write(b"echo hello\n")
        }
        fn _assert_resize(handle: &PtyHandle) -> Result<(), String> {
            handle.resize(120, 40)
        }
    }

    #[test]
    fn spawn_pty_with_powershell_profile() {
        let session = make_test_session("PowerShell");
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        });

        assert!(handle.is_ok(), "PTY spawn should succeed for PowerShell");
        let handle = handle.unwrap();

        // Write a command and expect output
        let _ = handle.write(b"echo PTY_TEST_OK\r\n");

        // Wait for some output
        let mut got_output = false;
        for _ in 0..20 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                if !data.is_empty() {
                    got_output = true;
                    break;
                }
            }
        }
        assert!(got_output, "Should receive output from PTY");

        // Close by writing exit
        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    fn spawn_pty_resize() {
        let session = make_test_session("PowerShell");
        let handle = spawn_pty(&session, |_| {}).unwrap();

        let result = handle.resize(120, 40);
        assert!(result.is_ok(), "Resize should succeed");

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    fn spawn_pty_with_starting_directory() {
        // Use TEMP dir which always exists on Windows
        let temp_dir = std::env::temp_dir();
        let temp_str = temp_dir.to_string_lossy().to_string();
        let session = make_test_session_with_cwd("PowerShell", &temp_str);
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        });

        assert!(
            handle.is_ok(),
            "PTY spawn should succeed with starting_directory"
        );
        let handle = handle.unwrap();

        // Ask PowerShell for its current directory
        let _ = handle.write(b"(Get-Location).Path\r\n");

        let mut output = String::new();
        for _ in 0..30 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&String::from_utf8_lossy(&data));
                // temp dir path should appear (case-insensitive check)
                if output
                    .to_lowercase()
                    .contains(&temp_str.to_lowercase().replace('\\', "\\"))
                {
                    break;
                }
            }
        }
        // The output should contain the temp directory path
        assert!(
            output.to_lowercase().contains("temp"),
            "PowerShell should start in the specified directory. Got: {output}"
        );

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    fn spawn_pty_sets_env_vars() {
        let session = make_test_session("PowerShell");
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        })
        .unwrap();

        // Check that LX_TERMINAL_ID is set
        let _ = handle.write(b"echo $env:LX_TERMINAL_ID\r\n");

        let mut output = String::new();
        for _ in 0..20 {
            if let Ok(data) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&String::from_utf8_lossy(&data));
                if output.contains("test-pty") {
                    break;
                }
            }
        }
        assert!(
            output.contains("test-pty"),
            "LX_TERMINAL_ID should be set. Got: {output}"
        );

        let _ = handle.write(b"exit\r\n");
    }

    #[test]
    fn expand_env_expands_percent_vars() {
        // %TEMP% should exist on Windows
        let result = expand_env_in_path("%TEMP%");
        assert!(!result.contains('%'), "Should expand %TEMP%. Got: {result}");
        assert!(!result.is_empty());
    }

    #[test]
    fn expand_env_expands_tilde() {
        let result = expand_env_in_path("~");
        assert!(!result.starts_with('~'), "Should expand ~. Got: {result}");
    }

    #[test]
    fn expand_env_preserves_plain_path() {
        let result = expand_env_in_path("C:\\Users\\test");
        assert_eq!(result, "C:\\Users\\test");
    }

    #[test]
    fn expand_env_handles_unknown_var() {
        let result = expand_env_in_path("%NONEXISTENT_VAR_12345%");
        // Should not panic, returns the original
        assert_eq!(result, "%NONEXISTENT_VAR_12345%");
    }
}
