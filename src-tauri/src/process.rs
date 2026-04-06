/// Headless process spawning utilities.
///
/// On Windows, console applications (cmd.exe, powershell.exe, netstat.exe, etc.)
/// briefly flash a console window when spawned via `std::process::Command`.
/// This module provides a helper that applies `CREATE_NO_WINDOW` automatically
/// so all call sites get consistent headless behavior.
use std::process::Command;

/// Create a [`Command`] that will not show a console window on Windows.
///
/// On non-Windows platforms this is identical to `Command::new(program)`.
pub fn headless_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[allow(unused_mut)] // mut needed on Windows for creation_flags()
    let mut cmd = Command::new(program);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000): prevents a console window from flashing
        cmd.creation_flags(0x08000000);
    }

    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_command_returns_valid_command() {
        // Should not panic and produce a usable Command
        let cmd = headless_command("echo");
        // We can't inspect creation_flags, but we can verify the command is constructible
        let output = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(output, "echo");
    }

    #[test]
    fn headless_command_accepts_args() {
        let mut cmd = headless_command("echo");
        cmd.arg("hello");
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["hello"]);
    }
}
