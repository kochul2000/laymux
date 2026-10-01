fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("emit") {
        if let Some(provider) = args.get(1) {
            let _ = laymux_agent_hook::runtime::emit(provider);
        }
        // Observational only: never block a CLI decision or inject model context.
        println!("{{}}");
        return;
    }
    let result = manage(&args);
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", serde_json::json!({"error":error}));
            std::process::exit(1);
        }
    }
}

fn manage(args: &[String]) -> Result<serde_json::Value, String> {
    if args.len() < 3 || args[0] != "manage" {
        return Err("Usage: laymux-agent-hook manage <claude|codex> <status|install|remove|update> [config-directory]".into());
    }
    let root = match args.get(3).filter(|s| !s.is_empty()) {
        Some(path) => std::path::PathBuf::from(path),
        None => laymux_agent_hook::install::default_root(&args[1])?,
    };
    laymux_agent_hook::install::manage(
        &root,
        &args[1],
        &args[2],
        &std::env::current_exe().map_err(|e| e.to_string())?,
    )
}
