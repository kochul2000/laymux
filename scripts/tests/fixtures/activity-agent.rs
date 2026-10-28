//! Deterministic dev-only process/title/rollout fixture. Never calls a provider.
use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::PathBuf,
};

fn main() {
    let args: Vec<_> = env::args().collect();
    let provider = &args[1];
    let id = &args[2];
    let root = PathBuf::from(&args[3]);
    let directory = root.join("sessions/2026/10/27");
    fs::create_dir_all(&directory).unwrap();
    let rollout = directory.join(format!("rollout-dev-{id}.jsonl"));
    if provider == "Codex" {
        fs::write(&rollout, format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"source\":\"cli\",\"cwd\":\"/tmp\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\",\"turn_id\":\"fixture-turn\"}}}}\n")).unwrap();
        print!("\x1b]0;codex | {id} | dev fixture\x07");
    } else if provider == "Claude" {
        print!("\x1b]0;Claude Code\x07\x1b]0;✳ dev fixture\x07");
    }
    println!("ACTIVITY_FIXTURE_READY:{}", std::process::id());
    io::stdout().flush().unwrap();
    let mut owned_session = None;
    for line in io::stdin().lock().lines() {
        let command = line.unwrap();
        match command.trim() {
            "hook-start" | "hook-running" | "hook-idle" | "hook-heartbeat" | "hook-end" => {
                if provider == "Claude" && owned_session.is_none() {
                    let file = PathBuf::from(env::var("USERPROFILE").unwrap())
                        .join(".claude/sessions")
                        .join(format!("{}.json", std::process::id()));
                    fs::create_dir_all(file.parent().unwrap()).unwrap();
                    let mut output = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&file)
                        .unwrap();
                    writeln!(output, "{{\"pid\":{},\"sessionId\":\"{id}\",\"status\":\"idle\",\"startedAt\":{}}}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap();
                    fs::write(
                        root.join("owned-session-path.txt"),
                        file.to_string_lossy().as_bytes(),
                    )
                    .unwrap();
                    owned_session = Some(file);
                }
                let event = match command.trim() {
                    "hook-start" => "SessionStart",
                    "hook-running" => "UserPromptSubmit",
                    "hook-heartbeat" => "PostToolUse",
                    "hook-end" => "SessionEnd",
                    _ => "Stop",
                };
                // Standalone test fixture: launch the installed real helper as
                // a child so its actual ancestry/birth times reach the dev API.
                let mut helper =
                    std::process::Command::new(root.join("laymux-hooks/laymux-agent-hook.exe"));
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    helper.creation_flags(0x08000000);
                }
                let mut child = helper
                    .args(["emit", &provider.to_lowercase()])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                writeln!(child.stdin.take().unwrap(), "{{\"session_id\":\"{id}\",\"hook_event_name\":\"{event}\",\"source\":\"startup\",\"turn_id\":\"fixture-turn\"}}").unwrap();
                child.wait().unwrap();
                println!("ACTIVITY_HOOK_SENT:{event}");
            }
            "flood" => println!("{}", "x".repeat(32768)),
            "title-reset" => print!("\x1b]0;dev fixture cwd\x07"),
            "stale-title" => print!("\x1b]0;Claude Code\x07"),
            "restore-title" => {
                if provider == "Codex" {
                    print!("\x1b]0;codex | {id} | dev fixture\x07");
                } else {
                    print!("\x1b]0;Claude Code\x07\x1b]0;✳ dev fixture\x07");
                }
            }
            "busy" | "done" if provider == "Codex" => {
                let kind = if command.trim() == "busy" {
                    "task_started"
                } else {
                    "task_complete"
                };
                let mut file = fs::OpenOptions::new().append(true).open(&rollout).unwrap();
                writeln!(file, "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"{kind}\",\"turn_id\":\"fixture-turn\"}}}}").unwrap();
            }
            "exit" => break,
            _ => {}
        }
        io::stdout().flush().unwrap();
    }
    if let Some(path) = owned_session {
        fs::remove_file(path).unwrap();
    }
}
