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
    let result = if args.first().map(String::as_str) == Some("mcp") {
        mcp(&args)
    } else {
        manage(&args)
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", serde_json::json!({"error":error}));
            std::process::exit(1);
        }
    }
}

fn mcp(args: &[String]) -> Result<serde_json::Value, String> {
    let (Some(provider), Some(operation), Some(name), Some(port), None) = (
        args.get(1),
        args.get(2),
        args.get(3),
        args.get(4),
        args.get(6),
    ) else {
        return Err("Usage: laymux-agent-hook mcp <claude|codex|grok> <status|install|remove> <name> <port> [config-directory]".into());
    };
    let port = port.parse().map_err(|_| "Invalid port".to_string())?;
    let dir = args
        .get(5)
        .filter(|s| !s.is_empty())
        .map(std::path::Path::new);
    laymux_agent_hook::mcp::manage(provider, operation, name, port, dir)
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
