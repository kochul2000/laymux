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
    for line in io::stdin().lock().lines() {
        let command = line.unwrap();
        match command.trim() {
            "flood" => println!("{}", "x".repeat(32768)),
            "title-reset" => print!("\x1b]0;dev fixture cwd\x07"),
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
}
