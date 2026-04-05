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
use std::io::BufReader;
use std::net::TcpStream;

use laymux_lib::constants::ENV_LX_SOCKET;

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

    // Connect to IDE via IPC socket
    let socket_addr = env::var(ENV_LX_SOCKET).unwrap_or_else(|_| {
        eprintln!("Error: LX_SOCKET not set. Are you running inside a Laymux terminal?");
        std::process::exit(1);
    });

    // On Windows, LX_SOCKET is a TCP address (127.0.0.1:port)
    let stream = match TcpStream::connect(&socket_addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Error: Could not connect to IDE at {socket_addr}: {e}");
            std::process::exit(1);
        }
    };

    let mut reader = BufReader::new(&stream);
    let mut writer = stream.try_clone().expect("Failed to clone stream");

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
