use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// Detected activity state of a terminal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalActivity {
    /// At shell prompt, waiting for user input.
    Shell,
    /// A non-interactive command is running (e.g., npm build, sleep).
    Running,
    /// An interactive TUI app is running (e.g., Claude Code, vim).
    InteractiveApp { name: String },
}

/// Full terminal state snapshot for API consumers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStateInfo {
    pub activity: TerminalActivity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub profile: String,
    /// The shell command line (e.g. "wsl.exe -d Ubuntu", "powershell.exe -NoLogo").
    /// Used to detect shell type and spawn the PTY process.
    /// If empty, falls back to profile name-based resolution.
    #[serde(default)]
    pub command_line: String,
    /// Command to run after shell initialization (e.g. "cd ~/project && conda activate myenv").
    /// Appended to the shell init script for WSL/PowerShell profiles.
    #[serde(default)]
    pub startup_command: String,
    /// Starting directory for the terminal process.
    /// When non-empty, sets the working directory before spawning the shell.
    #[serde(default)]
    pub starting_directory: String,
    pub cols: u16,
    pub rows: u16,
    pub sync_group: String,
    pub env: Vec<(String, String)>,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            profile: "PowerShell".into(),
            command_line: "powershell.exe -NoLogo".into(),
            startup_command: String::new(),
            starting_directory: String::new(),
            cols: 80,
            rows: 24,
            sync_group: String::new(),
            env: Vec::new(),
        }
    }
}

/// Notification stored in the backend (single source of truth).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalNotification {
    pub id: u64,
    pub terminal_id: String,
    pub message: String,
    pub level: String, // "info" | "error" | "warning" | "success"
    pub created_at: u64,
    pub read_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalSession {
    pub id: String,
    pub title: String,
    pub config: TerminalConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// True when a command is executing in this terminal (between preexec and prompt).
    /// Used to prevent sync-cwd from injecting `cd` into interactive apps.
    #[serde(default)]
    pub command_running: bool,
    /// WSL distribution name, extracted from UNC paths (e.g., "Ubuntu-22.04").
    /// Used for cross-profile path conversion (e.g., /home/... → \\wsl.localhost\distro\...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_distro: Option<String>,
    /// Whether this terminal sends CWD changes to other terminals in the sync group.
    #[serde(default = "default_true")]
    pub cwd_send: bool,
    /// Whether this terminal accepts CWD sync from other terminals.
    #[serde(default = "default_true")]
    pub cwd_receive: bool,
    /// Last command text from OSC 133 E / SetCommandStatus.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_command: Option<String>,
    /// Exit code of the last command from OSC 133 D / SetCommandStatus.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i32>,
    /// Unix timestamp (millis) when last command status was updated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_command_at: Option<u64>,
    /// Latest white-● status message from Claude Code output.
    /// Raw value — display text is derived by frontend computation function.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_message: Option<String>,
    /// Notify gate: when false, notification actions are suppressed.
    /// Armed by OSC 133;C/E (user command execution) or fallback timer.
    /// Prevents shell-init OSC 133;D from flooding notifications on startup.
    #[serde(skip)]
    pub notify_gate_armed: bool,
    /// True when Claude Code was in "working" state (non-idle spinner title).
    /// Used to detect working→idle transition for task completion notification.
    #[serde(skip)]
    pub claude_was_working: bool,
}

fn default_true() -> bool {
    true
}

impl TerminalSession {
    pub fn new(id: String, config: TerminalConfig) -> Self {
        Self {
            id,
            title: String::from("Terminal"),
            config,
            cwd: None,
            branch: None,
            command_running: false,
            wsl_distro: None,
            cwd_send: true,
            cwd_receive: true,
            last_command: None,
            last_exit_code: None,
            last_command_at: None,
            claude_message: None,
            notify_gate_armed: false,
            claude_was_working: false,
        }
    }

    /// Legacy wrapper: resolve by profile name (for backward compat).
    pub fn profile_to_command(profile: &str) -> (String, Vec<String>) {
        Self::profile_to_command_with_env(profile, &[])
    }

    /// Legacy wrapper: resolve by profile name with env injection.
    pub fn profile_to_command_with_env(
        profile: &str,
        env: &[(String, String)],
    ) -> (String, Vec<String>) {
        let command_line = match profile {
            "WSL" | "wsl" => "wsl.exe",
            "PowerShell" | "powershell" => "powershell.exe -NoLogo",
            other => other,
        };
        Self::command_line_to_command_with_env(command_line, env)
    }

    /// Convenience wrapper without env injection.
    pub fn command_line_to_command(command_line: &str) -> (String, Vec<String>) {
        Self::command_line_to_command_with_startup(command_line, &[], "")
    }

    /// Build command with env injection (no startup command).
    pub fn command_line_to_command_with_env(
        command_line: &str,
        env: &[(String, String)],
    ) -> (String, Vec<String>) {
        Self::command_line_to_command_with_startup(command_line, env, "")
    }

    /// Build command from a command_line string, detecting shell type from the executable.
    /// Injects shell integration (OSC sequences) for known shells (WSL/bash, PowerShell).
    /// If `startup_command` is non-empty, appends it to the shell init script.
    pub fn command_line_to_command_with_startup(
        command_line: &str,
        env: &[(String, String)],
        startup_command: &str,
    ) -> (String, Vec<String>) {
        let parts: Vec<&str> = command_line.split_whitespace().collect();
        let executable = parts.first().copied().unwrap_or("powershell.exe");
        let extra_args: Vec<String> = if parts.len() > 1 {
            parts[1..].iter().map(|s| s.to_string()).collect()
        } else {
            Vec::new()
        };

        match detect_shell_type(executable) {
            ShellType::Wsl => {
                let mut init = shell_integration_bash_with_env(env);
                if !startup_command.is_empty() {
                    init.push('\n');
                    init.push_str(startup_command);
                }
                let seq = INIT_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
                let init_file = std::env::temp_dir().join(format!("laymux_bash_init_{}.sh", seq));
                let _ = std::fs::write(&init_file, &init);
                let win_path = init_file.to_string_lossy().replace('\\', "/");
                let wsl_path = if win_path.len() >= 2 && win_path.as_bytes()[1] == b':' {
                    let drive = win_path.as_bytes()[0].to_ascii_lowercase() as char;
                    format!("/mnt/{}{}", drive, &win_path[2..])
                } else {
                    win_path.to_string()
                };
                let mut args = extra_args;
                args.extend([
                    "--".into(),
                    "bash".into(),
                    "--rcfile".into(),
                    wsl_path,
                    "-i".into(),
                ]);
                (executable.into(), args)
            }
            ShellType::PowerShell => {
                let mut init = shell_integration_powershell();
                if !startup_command.is_empty() {
                    init.push('\n');
                    init.push_str(startup_command);
                }
                (
                    executable.into(),
                    vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), init],
                )
            }
            ShellType::Other => (executable.into(), extra_args),
        }
    }
}

enum ShellType {
    Wsl,
    PowerShell,
    Other,
}

/// Monotonic counter for unique bash init file names.
static INIT_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Detect shell type from the executable path/name.
/// Strips directory and .exe extension, then matches against known shells.
fn detect_shell_type(executable: &str) -> ShellType {
    let filename = executable.rsplit(&['/', '\\']).next().unwrap_or(executable);
    let name = filename
        .strip_suffix(".exe")
        .unwrap_or(filename)
        .to_lowercase();
    match name.as_str() {
        "wsl" => ShellType::Wsl,
        "powershell" | "pwsh" => ShellType::PowerShell,
        _ => ShellType::Other,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncGroup {
    pub name: String,
    pub terminal_ids: Vec<String>,
}

impl SyncGroup {
    pub fn new(name: String) -> Self {
        Self {
            name,
            terminal_ids: Vec::new(),
        }
    }

    pub fn add_terminal(&mut self, terminal_id: String) {
        if !self.terminal_ids.contains(&terminal_id) {
            self.terminal_ids.push(terminal_id);
        }
    }

    pub fn remove_terminal(&mut self, terminal_id: &str) {
        self.terminal_ids.retain(|id| id != terminal_id);
    }
}

/// PowerShell shell integration script.
/// Overrides `prompt` to emit:
/// - OSC 133;A (prompt start) — enables shadow cursor prompt boundary detection
/// - OSC 133;D (command exit code) — enables notify-on-fail
/// - OSC 7 (current working directory) — enables sync-cwd
/// - OSC 133;B (input start) — marks where user input begins (shadow cursor anchor)
///   Uses single quotes and concatenation to avoid double-quote escaping issues
///   with PowerShell's -Command parameter.
fn shell_integration_powershell() -> String {
    // PowerShell 5.1 doesn't support `e escape — use [char]27 instead.
    // OSC sequences are embedded directly in the prompt return string.
    // [Console]::Write() fails in ConPTY context, so we avoid it.
    // Avoids double quotes — they get mangled by Windows cmd-line argument escaping.
    r#"
$global:__lmx_e = [string][char]27
$global:__lmx_b = [string][char]7
$global:__lmx_f = $true
function prompt {
    $ec = $global:LASTEXITCODE; if ($null -eq $ec) { $ec = 0 }
    $e = $global:__lmx_e; $b = $global:__lmx_b
    $loc = (Get-Location).ProviderPath
    $cwd = $loc.Replace([char]92, '/')
    $r = $e + ']133;A' + $b
    if ($cwd.StartsWith('//')) { $r += $e + ']7;' + $cwd + $b }
    else { $r += $e + ']7;file://localhost/' + $cwd + $b }
    if (-not $global:__lmx_f) { $r = $e + ']133;D;' + $ec + $b + $r }
    $global:__lmx_f = $false
    $global:LASTEXITCODE = $ec
    return $r + 'PS ' + $loc + '> ' + $e + ']133;B' + $b
}
"#
    .trim()
    .to_string()
}

/// Bash shell integration script for WSL (without env injection).
#[cfg(test)]
fn shell_integration_bash() -> String {
    shell_integration_bash_with_env(&[])
}

/// Bash shell integration script for WSL.
/// Exports IDE env vars at the top so they are available inside WSL
/// even when WSL interop is disabled (Windows env vars don't propagate).
fn shell_integration_bash_with_env(env: &[(String, String)]) -> String {
    let mut script = String::new();

    // Export IDE environment variables at the top of the script
    for (key, value) in env {
        // Escape single quotes in value: replace ' with '\''
        let escaped = value.replace('\'', "'\\''");
        script.push_str(&format!("export {}='{}'\n", key, escaped));
    }

    // Set LX_AUTOMATION_HOST to the Windows host IP (gateway from WSL2 perspective)
    // so tools running inside WSL can reach the Automation API on the Windows side.
    script.push_str("export LX_AUTOMATION_HOST=$(ip route show default 2>/dev/null | awk '{print $3}' || echo '127.0.0.1')\n");

    script.push_str(
        r#"
__laymux_prompt_pre() {
    local ec=$?
    __laymux_at_prompt=0
    printf '\e]133;D;%s\a' "$ec"
    printf '\e]7;file://localhost%s\a' "$PWD"
}
__laymux_prompt_post() {
    __laymux_at_prompt=1
}
__laymux_preexec() {
    [ "$__laymux_at_prompt" != "1" ] && return
    __laymux_at_prompt=0
    printf '\e]133;C\a'
    printf '\e]133;E;%s\a' "$BASH_COMMAND"
}
[ -f ~/.bashrc ] && source ~/.bashrc
PROMPT_COMMAND="__laymux_prompt_pre;${PROMPT_COMMAND:+$PROMPT_COMMAND;}__laymux_prompt_post"
trap '__laymux_preexec' DEBUG
"#,
    );

    script.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_session_with_config() {
        let config = TerminalConfig {
            profile: "WSL".into(),
            command_line: "wsl.exe".into(),
            startup_command: String::new(),
            starting_directory: String::new(),
            cols: 120,
            rows: 40,
            sync_group: "project-a".into(),
            env: vec![("FOO".into(), "bar".into())],
        };
        let session = TerminalSession::new("t1".into(), config);
        assert_eq!(session.id, "t1");
        assert_eq!(session.title, "Terminal");
        assert_eq!(session.config.profile, "WSL");
        assert_eq!(session.config.cols, 120);
        assert_eq!(session.config.rows, 40);
        assert_eq!(session.config.sync_group, "project-a");
    }

    #[test]
    fn default_config() {
        let config = TerminalConfig::default();
        assert_eq!(config.profile, "PowerShell");
        assert_eq!(config.cols, 80);
        assert_eq!(config.rows, 24);
        assert!(config.sync_group.is_empty());
        assert!(config.starting_directory.is_empty());
    }

    #[test]
    fn config_with_starting_directory() {
        let config = TerminalConfig {
            starting_directory: "C:\\Users\\test\\project".into(),
            ..TerminalConfig::default()
        };
        assert_eq!(config.starting_directory, "C:\\Users\\test\\project");
    }

    #[test]
    fn profile_to_command_mapping() {
        let (cmd, _) = TerminalSession::profile_to_command("WSL");
        assert_eq!(cmd, "wsl.exe");

        let (cmd, args) = TerminalSession::profile_to_command("PowerShell");
        assert_eq!(cmd, "powershell.exe");
        assert!(args.contains(&"-NoLogo".to_string()));
    }

    #[test]
    fn command_line_detects_wsl() {
        let (cmd, args) = TerminalSession::command_line_to_command("wsl.exe");
        assert_eq!(cmd, "wsl.exe");
        assert!(args.contains(&"--".to_string()));
        assert!(args.contains(&"bash".to_string()));
        assert!(args.contains(&"--rcfile".to_string()));
        assert!(args.contains(&"-i".to_string()));
    }

    #[test]
    fn command_line_detects_wsl_with_distro() {
        let (cmd, args) = TerminalSession::command_line_to_command("wsl.exe -d Ubuntu");
        assert_eq!(cmd, "wsl.exe");
        // Extra args should come before --
        let dash_pos = args.iter().position(|a| a == "--").unwrap();
        let d_pos = args.iter().position(|a| a == "-d").unwrap();
        let ubuntu_pos = args.iter().position(|a| a == "Ubuntu").unwrap();
        assert!(d_pos < dash_pos, "-d should come before --");
        assert!(ubuntu_pos < dash_pos, "Ubuntu should come before --");
        assert!(args.contains(&"bash".to_string()));
        assert!(args.contains(&"--rcfile".to_string()));
    }

    #[test]
    fn command_line_detects_wsl_bare_name() {
        let (cmd, _args) = TerminalSession::command_line_to_command("wsl");
        assert_eq!(cmd, "wsl");
    }

    #[test]
    fn command_line_detects_powershell() {
        let (cmd, args) = TerminalSession::command_line_to_command("powershell.exe -NoLogo");
        assert_eq!(cmd, "powershell.exe");
        assert!(args.contains(&"-NoExit".to_string()));
        assert!(args.contains(&"-Command".to_string()));
    }

    #[test]
    fn command_line_detects_pwsh() {
        let (cmd, args) = TerminalSession::command_line_to_command("pwsh.exe");
        assert_eq!(cmd, "pwsh.exe");
        assert!(args.contains(&"-NoExit".to_string()));
        assert!(args.contains(&"-Command".to_string()));
    }

    #[test]
    fn command_line_detects_full_path_wsl() {
        let (cmd, _args) =
            TerminalSession::command_line_to_command("C:\\Windows\\System32\\wsl.exe");
        assert_eq!(cmd, "C:\\Windows\\System32\\wsl.exe");
        assert!(_args.contains(&"bash".to_string()));
    }

    #[test]
    fn command_line_unknown_passes_through() {
        let (cmd, args) = TerminalSession::command_line_to_command("cmd.exe /K echo hello");
        assert_eq!(cmd, "cmd.exe");
        assert_eq!(args, vec!["/K", "echo", "hello"]);
    }

    #[test]
    fn command_line_wsl_with_env_injects() {
        let env = vec![("LX_AUTOMATION_PORT".into(), "19280".into())];
        let (cmd, args) =
            TerminalSession::command_line_to_command_with_env("wsl.exe -d Ubuntu", &env);
        assert_eq!(cmd, "wsl.exe");
        assert!(args.contains(&"-d".to_string()));
        assert!(args.contains(&"Ubuntu".to_string()));
        assert!(args.contains(&"--rcfile".to_string()));
        // Extract rcfile path from args and verify init file contents
        let rcfile_pos = args.iter().position(|a| a == "--rcfile").unwrap();
        let rcfile_wsl_path = &args[rcfile_pos + 1];
        // Convert WSL path back to Windows path for reading
        let win_path = if rcfile_wsl_path.starts_with("/mnt/") {
            let drive = rcfile_wsl_path.chars().nth(5).unwrap();
            format!("{}:{}", drive.to_uppercase(), &rcfile_wsl_path[6..])
        } else {
            rcfile_wsl_path.clone()
        };
        let content = std::fs::read_to_string(&win_path).unwrap();
        assert!(content.contains("export LX_AUTOMATION_PORT='19280'"));
    }

    #[test]
    fn wsl_startup_command_appended_to_init() {
        let (_, args) = TerminalSession::command_line_to_command_with_startup(
            "wsl.exe",
            &[],
            "cd ~/project && conda activate myenv",
        );
        let rcfile_pos = args.iter().position(|a| a == "--rcfile").unwrap();
        let rcfile_wsl_path = &args[rcfile_pos + 1];
        let win_path = if rcfile_wsl_path.starts_with("/mnt/") {
            let drive = rcfile_wsl_path.chars().nth(5).unwrap();
            format!("{}:{}", drive.to_uppercase(), &rcfile_wsl_path[6..])
        } else {
            rcfile_wsl_path.clone()
        };
        let content = std::fs::read_to_string(&win_path).unwrap();
        assert!(
            content.contains("cd ~/project && conda activate myenv"),
            "Startup command should be at end of init script"
        );
        // Shell integration should still be present
        assert!(content.contains("PROMPT_COMMAND"));
    }

    #[test]
    fn wsl_empty_startup_command_no_extra_lines() {
        let (_, args_without) =
            TerminalSession::command_line_to_command_with_startup("wsl.exe", &[], "");
        let (_, args_with_env) = TerminalSession::command_line_to_command("wsl.exe");
        // Both should produce rcfile-based args
        assert!(args_without.contains(&"--rcfile".to_string()));
        assert!(args_with_env.contains(&"--rcfile".to_string()));
    }

    #[test]
    fn powershell_startup_command_appended() {
        let (_, args) = TerminalSession::command_line_to_command_with_startup(
            "powershell.exe",
            &[],
            "Set-Location C:\\Projects",
        );
        let cmd_arg = args.last().unwrap();
        assert!(
            cmd_arg.contains("Set-Location C:\\Projects"),
            "Startup command should be appended to PowerShell init"
        );
        assert!(
            cmd_arg.contains("prompt"),
            "Shell integration should still be present"
        );
    }

    #[test]
    fn powershell_empty_startup_command_unchanged() {
        let (_, args_with) =
            TerminalSession::command_line_to_command_with_startup("powershell.exe", &[], "");
        let (_, args_without) = TerminalSession::command_line_to_command("powershell.exe");
        // Both should have -Command with the same content
        assert_eq!(args_with.last(), args_without.last());
    }

    #[test]
    fn other_shell_startup_command_ignored() {
        // For unknown shells, startup_command has no effect (no init script to append to)
        let (cmd, args) =
            TerminalSession::command_line_to_command_with_startup("cmd.exe /K", &[], "echo hello");
        assert_eq!(cmd, "cmd.exe");
        assert_eq!(args, vec!["/K"]);
    }

    #[test]
    fn powershell_profile_injects_shell_integration() {
        let (cmd, args) = TerminalSession::profile_to_command("PowerShell");
        assert_eq!(cmd, "powershell.exe");
        assert!(args.contains(&"-NoExit".to_string()));
        assert!(args.contains(&"-Command".to_string()));
        // The command arg should contain OSC 133 and OSC 7 sequences
        let cmd_arg = args.last().unwrap();
        assert!(
            cmd_arg.contains("133"),
            "Should emit OSC 133;D for exit code"
        );
        assert!(cmd_arg.contains("file://"), "Should emit OSC 7 for CWD");
        assert!(
            cmd_arg.contains("prompt"),
            "Should define a prompt function"
        );
    }

    #[test]
    fn wsl_profile_injects_shell_integration() {
        let (cmd, args) = TerminalSession::profile_to_command("WSL");
        assert_eq!(cmd, "wsl.exe");
        // Should use --rcfile to load init and -i for interactive mode
        assert!(
            args.contains(&"--rcfile".to_string()),
            "Should use --rcfile"
        );
        assert!(args.contains(&"-i".to_string()), "Should be interactive");
        // Init file should contain PROMPT_COMMAND and preexec
        let init = shell_integration_bash();
        assert!(init.contains("PROMPT_COMMAND"));
        assert!(init.contains("__laymux_prompt_pre"));
        assert!(init.contains("__laymux_prompt_post"));
        assert!(init.contains("__laymux_preexec"));
    }

    #[test]
    fn bash_init_exports_env_vars() {
        let env = vec![
            ("LX_AUTOMATION_PORT".into(), "19280".into()),
            ("LX_TERMINAL_ID".into(), "t1".into()),
        ];
        let script = shell_integration_bash_with_env(&env);
        assert!(
            script.contains("export LX_AUTOMATION_PORT='19280'"),
            "Should export port"
        );
        assert!(
            script.contains("export LX_TERMINAL_ID='t1'"),
            "Should export terminal ID"
        );
        // Shell integration should still be present
        assert!(script.contains("PROMPT_COMMAND"));
        assert!(script.contains("__laymux_prompt_pre"));
    }

    #[test]
    fn bash_init_escapes_single_quotes_in_env() {
        let env = vec![("TEST_VAR".into(), "it's a test".into())];
        let script = shell_integration_bash_with_env(&env);
        assert!(
            script.contains(r"export TEST_VAR='it'\''s a test'"),
            "Should escape single quotes"
        );
    }

    #[test]
    fn bash_init_without_env_matches_original() {
        let with_env = shell_integration_bash_with_env(&[]);
        let without_env = shell_integration_bash();
        assert_eq!(with_env, without_env);
    }

    #[test]
    fn wsl_command_with_env_writes_init_file() {
        let env = vec![("LX_AUTOMATION_PORT".into(), "19280".into())];
        let (cmd, args) = TerminalSession::profile_to_command_with_env("WSL", &env);
        assert_eq!(cmd, "wsl.exe");
        assert!(args.contains(&"--rcfile".to_string()));
        // Extract rcfile path from args and verify init file contents
        let rcfile_pos = args.iter().position(|a| a == "--rcfile").unwrap();
        let rcfile_wsl_path = &args[rcfile_pos + 1];
        let win_path = if rcfile_wsl_path.starts_with("/mnt/") {
            let drive = rcfile_wsl_path.chars().nth(5).unwrap();
            format!("{}:{}", drive.to_uppercase(), &rcfile_wsl_path[6..])
        } else {
            rcfile_wsl_path.clone()
        };
        let content = std::fs::read_to_string(&win_path).unwrap();
        assert!(content.contains("export LX_AUTOMATION_PORT='19280'"));
    }

    #[test]
    fn session_command_running_defaults_false() {
        let session = TerminalSession::new("t1".into(), TerminalConfig::default());
        assert!(!session.command_running);
    }

    #[test]
    fn session_serializes_to_json() {
        let session = TerminalSession::new("s1".into(), TerminalConfig::default());
        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains("\"id\":\"s1\""));
        assert!(json.contains("\"profile\":\"PowerShell\""));
    }

    #[test]
    fn bash_preexec_emits_osc_133_c_and_e() {
        let init = shell_integration_bash();
        assert!(
            init.contains("__laymux_preexec"),
            "Init should have preexec function"
        );
        assert!(init.contains("133;C"), "Preexec should emit OSC 133 C");
        assert!(
            init.contains("133;E;%s"),
            "Preexec should emit OSC 133 E with command text"
        );
        assert!(
            init.contains("$BASH_COMMAND"),
            "Preexec should use $BASH_COMMAND for command text"
        );
        assert!(
            init.contains("trap") && init.contains("DEBUG"),
            "Preexec should use trap DEBUG"
        );
    }

    #[test]
    fn sync_group_manages_terminals() {
        let mut group = SyncGroup::new("test-group".into());
        assert!(group.terminal_ids.is_empty());

        group.add_terminal("t1".into());
        group.add_terminal("t2".into());
        assert_eq!(group.terminal_ids.len(), 2);

        // No duplicates
        group.add_terminal("t1".into());
        assert_eq!(group.terminal_ids.len(), 2);

        group.remove_terminal("t1");
        assert_eq!(group.terminal_ids.len(), 1);
        assert_eq!(group.terminal_ids[0], "t2");
    }
}
