//! Lx CLI binary — communicates with the running Laymux IDE via IPC.
//!
//! Usage:
//!   lx sync-cwd [path]
//!   lx sync-branch [branch]
//!   lx notify "[message]"
//!   lx set-tab-title "[title]"
//!   lx get-cwd
//!   lx get-branch
//!   lx get-terminal-id
//!   lx send-command "[cmd]" --group [name]

use std::env;

use laymux_lib::constants::ENV_LX_ENDPOINT_FILE;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        eprintln!("Usage: lx <command> [args...]");
        eprintln!("Commands: sync-cwd, sync-branch, notify, set-tab-title, open-file, get-cwd, get-branch, get-terminal-id, send-command");
        std::process::exit(1);
    }

    // Parse the command
    let message = match laymux_lib::cli::cli::parse_args(&args) {
        Ok(msg) => msg,
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    };

    // Find the running IDE through the endpoint file (ADR-0304): the GUI
    // that started this shell may have been replaced since.
    let endpoint_file = env::var(ENV_LX_ENDPOINT_FILE).ok();
    let endpoint = laymux_lib::lx_endpoint::resolve(endpoint_file.as_deref()).unwrap_or_else(|e| {
        eprintln!("Error: {e}");
        std::process::exit(1);
    });
    let (mut reader, mut writer) = match laymux_lib::lx_endpoint::connect(&endpoint) {
        Ok(connection) => connection,
        Err(e) => {
            eprintln!("Error: Could not connect to IDE at {endpoint}: {e}");
            std::process::exit(1);
        }
    };

    match laymux_lib::cli::cli::send_message(&message, &mut reader, &mut writer) {
        Ok(response) => {
            if response.success {
                if let Some(data) = response.data {
                    println!("{data}");
                }
            } else {
                eprintln!(
                    "Error: {}",
                    response.error.unwrap_or_else(|| "Unknown error".into())
                );
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }
}
