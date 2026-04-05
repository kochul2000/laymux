//! Laymux MCP server.
//! Exposes terminal control as MCP tools over JSON-RPC 2.0 stdio.
//! Proxies to the Automation API via HTTP.

mod mcp;

use std::io::{self, BufRead, BufReader, Write};

fn main() {
    let conn = mcp::resolve_connection();
    eprintln!("laymux-mcp: connecting to {}", conn.base_url);
    if conn.key.is_some() {
        eprintln!("laymux-mcp: API key loaded from discovery");
    }

    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());
    let mut stdout = io::stdout();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let req: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("laymux-mcp: parse error: {e}");
                let err = mcp::error_response(
                    &serde_json::Value::Null,
                    -32700,
                    &format!("Parse error: {e}"),
                );
                let _ = writeln!(stdout, "{}", serde_json::to_string(&err).unwrap());
                let _ = stdout.flush();
                continue;
            }
        };

        if let Some(resp) = mcp::handle_request(&req, &conn.base_url, conn.key.as_deref()) {
            let _ = writeln!(stdout, "{}", serde_json::to_string(&resp).unwrap());
            let _ = stdout.flush();
        }
    }
}
