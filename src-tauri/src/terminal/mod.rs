use serde::{Deserialize, Serialize};

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
    /// True if terminal has received output recently (screen is updating).
    pub output_active: bool,
    /// Milliseconds since last output from the terminal PTY.
    pub last_output_ms_ago: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub profile: String,
    pub cols: u16,
    pub rows: u16,
    pub sync_group: String,
    pub env: Vec<(String, String)>,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            profile: "PowerShell".into(),
            cols: 80,
            rows: 24,
            sync_group: String::new(),
            env: Vec::new(),
        }
    }
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
    /// Whether this terminal accepts CWD sync from other terminals.
    #[serde(default = "default_true")]
    pub cwd_receive: bool,
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
            cwd_receive: true,
        }
    }

    pub fn profile_to_command(profile: &str) -> (String, Vec<String>) {
        Self::profile_to_command_with_env(profile, &[])
    }

    /// Build command for the given profile, injecting env vars into the shell init script.
    /// For WSL, env vars are exported inside the bash init script so they are visible
    /// even when WSL interop is disabled.
    pub fn profile_to_command_with_env(profile: &str, env: &[(String, String)]) -> (String, Vec<String>) {
        match profile {
            "WSL" | "wsl" => {
                let init = shell_integration_bash_with_env(env);
                // Write init script to a temp file and use --rcfile to load it.
                // The old approach (`bash -c "INIT; exec bash -i"`) lost the functions
                // because `exec` replaced the process. Writing to a file and using
                // --rcfile ensures the integration persists in the interactive session.
                let init_file = std::env::temp_dir().join("laymux_bash_init.sh");
                let _ = std::fs::write(&init_file, &init);
                let win_path = init_file.to_string_lossy().replace('\\', "/");
                let wsl_path = if win_path.len() >= 2 && win_path.as_bytes()[1] == b':' {
                    let drive = win_path.as_bytes()[0].to_ascii_lowercase() as char;
                    format!("/mnt/{}{}", drive, &win_path[2..])
                } else {
                    win_path.to_string()
                };
                (
                    "wsl.exe".into(),
                    vec![
                        "--".into(),
                        "bash".into(),
                        "--rcfile".into(),
                        wsl_path,
                        "-i".into(),
                    ],
                )
            }
            "PowerShell" | "powershell" => {
                let init = shell_integration_powershell();
                (
                    "powershell.exe".into(),
                    vec![
                        "-NoLogo".into(),
                        "-NoExit".into(),
                        "-Command".into(),
                        init,
                    ],
                )
            }
            _ => ("powershell.exe".into(), vec!["-NoLogo".into()]),
        }
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
/// - OSC 133;D (command exit code) — enables notify-on-fail
/// - OSC 7 (current working directory) — enables sync-cwd
/// Uses single quotes and concatenation to avoid double-quote escaping issues
/// with PowerShell's -Command parameter.
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
    if ($cwd.StartsWith('//')) { $r = $e + ']7;' + $cwd + $b }
    else { $r = $e + ']7;file://localhost/' + $cwd + $b }
    if (-not $global:__lmx_f) { $r = $e + ']133;D;' + $ec + $b + $r }
    $global:__lmx_f = $false
    $global:LASTEXITCODE = $ec
    return $r + 'PS ' + $loc + '> '
}
"#
    .trim()
    .to_string()
}

/// Bash shell integration script for WSL (without env injection).
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

    // Set IDE_AUTOMATION_HOST to the Windows host IP (gateway from WSL2 perspective)
    // so tools running inside WSL can reach the Automation API on the Windows side.
    script.push_str("export IDE_AUTOMATION_HOST=$(ip route show default 2>/dev/null | awk '{print $3}' || echo '127.0.0.1')\n");

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
    fn powershell_profile_injects_shell_integration() {
        let (cmd, args) = TerminalSession::profile_to_command("PowerShell");
        assert_eq!(cmd, "powershell.exe");
        assert!(args.contains(&"-NoExit".to_string()));
        assert!(args.contains(&"-Command".to_string()));
        // The command arg should contain OSC 133 and OSC 7 sequences
        let cmd_arg = args.last().unwrap();
        assert!(cmd_arg.contains("133"), "Should emit OSC 133;D for exit code");
        assert!(cmd_arg.contains("file://"), "Should emit OSC 7 for CWD");
        assert!(cmd_arg.contains("prompt"), "Should define a prompt function");
    }

    #[test]
    fn wsl_profile_injects_shell_integration() {
        let (cmd, args) = TerminalSession::profile_to_command("WSL");
        assert_eq!(cmd, "wsl.exe");
        // Should use --rcfile to load init and -i for interactive mode
        assert!(args.contains(&"--rcfile".to_string()), "Should use --rcfile");
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
            ("IDE_AUTOMATION_PORT".into(), "19280".into()),
            ("IDE_TERMINAL_ID".into(), "t1".into()),
        ];
        let script = shell_integration_bash_with_env(&env);
        assert!(script.contains("export IDE_AUTOMATION_PORT='19280'"), "Should export port");
        assert!(script.contains("export IDE_TERMINAL_ID='t1'"), "Should export terminal ID");
        // Shell integration should still be present
        assert!(script.contains("PROMPT_COMMAND"));
        assert!(script.contains("__laymux_prompt_pre"));
    }

    #[test]
    fn bash_init_escapes_single_quotes_in_env() {
        let env = vec![("TEST_VAR".into(), "it's a test".into())];
        let script = shell_integration_bash_with_env(&env);
        assert!(script.contains(r"export TEST_VAR='it'\''s a test'"), "Should escape single quotes");
    }

    #[test]
    fn bash_init_without_env_matches_original() {
        let with_env = shell_integration_bash_with_env(&[]);
        let without_env = shell_integration_bash();
        assert_eq!(with_env, without_env);
    }

    #[test]
    fn wsl_command_with_env_writes_init_file() {
        let env = vec![("IDE_AUTOMATION_PORT".into(), "19280".into())];
        let (cmd, args) = TerminalSession::profile_to_command_with_env("WSL", &env);
        assert_eq!(cmd, "wsl.exe");
        assert!(args.contains(&"--rcfile".to_string()));
        // Verify the init file contains the env export
        let init_file = std::env::temp_dir().join("laymux_bash_init.sh");
        let content = std::fs::read_to_string(&init_file).unwrap();
        assert!(content.contains("export IDE_AUTOMATION_PORT='19280'"));
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
        assert!(
            init.contains("133;C"),
            "Preexec should emit OSC 133 C"
        );
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
