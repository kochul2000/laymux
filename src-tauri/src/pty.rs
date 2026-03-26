use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::terminal::TerminalSession;

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
pub fn spawn_pty<F>(
    session: &TerminalSession,
    on_output: F,
) -> Result<PtyHandle, String>
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
                cols: 80,
                rows: 24,
                sync_group: "test-group".into(),
                env: vec![("TEST_VAR".into(), "hello".into())],
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
    fn spawn_pty_sets_env_vars() {
        let session = make_test_session("PowerShell");
        let (tx, rx) = mpsc::channel();

        let handle = spawn_pty(&session, move |data| {
            let _ = tx.send(data);
        }).unwrap();

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
}
