use std::process::{Command, Stdio};

// Tests run the same shell boundary as each CLI, with no visible Windows console.
fn headless_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.stdin(Stdio::null());
    command
}

#[test]
fn readable_commands_execute_from_special_character_paths() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp
        .path()
        .join("한글 space ' $name `echo` %LAYMUX_HOOK_QUOTE_TEST% & (x)");
    for provider in ["codex", "claude"] {
        let status = laymux_agent_hook::install::manage(
            &root,
            provider,
            "install",
            std::path::Path::new(env!("CARGO_BIN_EXE_laymux-agent-hook")),
        )
        .unwrap();
        assert_eq!(status["installed"], true);
        let handler = laymux_agent_hook::install::handler(&root, provider).unwrap();
        let text = handler["command"].as_str().unwrap();
        assert!(!text.contains("EncodedCommand"));
        #[cfg(windows)]
        let mut command = if provider == "codex" {
            use std::os::windows::process::CommandExt;
            let mut command = headless_command("cmd.exe");
            command.arg("/C").raw_arg(format!("\"{text}\""));
            command
        } else {
            let mut command = headless_command("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", text]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = headless_command("/bin/sh");
            command.args(["-c", text]);
            command
        };
        let output = command
            .env_remove("LX_AGENT_HOOK_TOKEN")
            .env_remove("LX_TERMINAL_ID")
            .env("LAYMUX_HOOK_QUOTE_TEST", "should-not-expand")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{provider}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "{}");
        laymux_agent_hook::install::manage(
            &root,
            provider,
            "remove",
            std::path::Path::new("unused"),
        )
        .unwrap();
    }
}
