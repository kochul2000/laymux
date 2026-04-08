//! MCP (Model Context Protocol) server module.
//! Exposes laymux Automation API as MCP tools over JSON-RPC 2.0 stdio.

use serde_json::{json, Value};

/// MCP protocol version.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// Tool definitions for MCP tools/list response.
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_terminals",
            "description": "List all active terminal panes with their IDs, profiles, working directories, and sync groups",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "write_to_terminal",
            "description": "Send input (keystrokes/commands) to a terminal pane. Append \\n to execute a command.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal_id": {
                        "type": "string",
                        "description": "Terminal ID from list_terminals"
                    },
                    "data": {
                        "type": "string",
                        "description": "Data to write (e.g. \"ls -la\\n\")"
                    }
                },
                "required": ["terminal_id", "data"]
            }
        },
        {
            "name": "read_terminal_output",
            "description": "Read recent output from a terminal pane",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal_id": {
                        "type": "string",
                        "description": "Terminal ID from list_terminals"
                    },
                    "lines": {
                        "type": "integer",
                        "description": "Number of recent lines to read (default: 100)"
                    }
                },
                "required": ["terminal_id"]
            }
        }
    ])
}

/// Build the response for `initialize` method.
pub fn handle_initialize(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "laymux-mcp",
                "version": "0.1.0"
            }
        }
    })
}

/// Build the response for `notifications/initialized`.
pub fn handle_initialized() -> Option<Value> {
    None
}

/// Build the response for `tools/list` method.
pub fn handle_tools_list(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": tool_definitions()
        }
    })
}

/// Execute a tool call via the Automation API.
pub fn handle_tools_call(id: &Value, params: &Value, base_url: &str, key: Option<&str>) -> Value {
    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let result = match tool_name {
        "list_terminals" => call_list_terminals(base_url, key),
        "write_to_terminal" => call_write_to_terminal(base_url, &args, key),
        "read_terminal_output" => call_read_terminal_output(base_url, &args, key),
        _ => Err(format!("Unknown tool: {tool_name}")),
    };

    match result {
        Ok(text) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": text }]
            }
        }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "content": [{ "type": "text", "text": format!("Error: {e}") }],
                "isError": true
            }
        }),
    }
}

/// Build a JSON-RPC error response.
pub fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

/// Route a JSON-RPC request to the appropriate handler.
pub fn handle_request(req: &Value, base_url: &str, key: Option<&str>) -> Option<Value> {
    let id = req.get("id").unwrap_or(&Value::Null);
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "initialize" => Some(handle_initialize(id)),
        "notifications/initialized" => handle_initialized(),
        "tools/list" => Some(handle_tools_list(id)),
        "tools/call" => Some(handle_tools_call(id, &params, base_url, key)),
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        _ => {
            if id.is_null() {
                None
            } else {
                Some(error_response(
                    id,
                    -32601,
                    &format!("Method not found: {method}"),
                ))
            }
        }
    }
}

/// Resolved connection info for the Automation API.
pub struct AutomationConnection {
    pub base_url: String,
    pub key: Option<String>,
}

/// Resolve the Automation API connection from env vars or discovery file.
///
/// Priority: env vars (`LX_AUTOMATION_PORT`, `LX_AUTOMATION_KEY`) first,
/// then discovery file. When using discovery file, port and key are read
/// from the same file to avoid cross-instance mismatch.
///
/// When running inside WSL and the discovery file is found via a Windows
/// path (`/mnt/c/...`), the host is automatically resolved to the WSL
/// gateway IP so that requests reach the Windows-side Automation API.
pub fn resolve_connection() -> AutomationConnection {
    let host = std::env::var("LX_AUTOMATION_HOST").unwrap_or_else(|_| "127.0.0.1".into());

    // If both env vars are set, use them directly (injected by terminal spawn)
    if let (Ok(port), Ok(key)) = (
        std::env::var("LX_AUTOMATION_PORT"),
        std::env::var("LX_AUTOMATION_KEY"),
    ) {
        return AutomationConnection {
            base_url: format!("http://{}:{}", host, port),
            key: Some(key),
        };
    }

    // Fall back to discovery file (port + key read together)
    if let Some(discovery) = read_discovery_file() {
        // If host was not explicitly set via env var AND the file was found
        // on a Windows mount path, use the WSL gateway IP instead of 127.0.0.1.
        let effective_host = if std::env::var("LX_AUTOMATION_HOST").is_err()
            && discovery.from_windows_mount
        {
            #[cfg(not(target_os = "windows"))]
            {
                wsl_gateway_ip().unwrap_or_else(|| host.clone())
            }
            #[cfg(target_os = "windows")]
            {
                host.clone()
            }
        } else {
            host.clone()
        };
        return AutomationConnection {
            base_url: format!("http://{}:{}", effective_host, discovery.port),
            key: Some(discovery.key),
        };
    }

    // Last resort: env port only, no key
    let port = std::env::var("LX_AUTOMATION_PORT").unwrap_or_else(|_| "19280".into());
    AutomationConnection {
        base_url: format!("http://{}:{}", host, port),
        key: None,
    }
}

/// Result of reading a discovery file.
struct DiscoveryResult {
    port: String,
    key: String,
    /// True when the file was found under a `/mnt/` Windows mount path (WSL).
    from_windows_mount: bool,
}

/// Read port and key from the discovery file (both from the same file).
fn read_discovery_file() -> Option<DiscoveryResult> {
    let candidates = discovery_file_candidates();
    for (path, from_windows_mount) in candidates {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                let port = parsed.get("port").and_then(|v| v.as_u64());
                let key = parsed.get("key").and_then(|v| v.as_str());
                if let (Some(port), Some(key)) = (port, key) {
                    eprintln!("laymux-mcp: discovery file found at {}", path.display());
                    return Some(DiscoveryResult {
                        port: port.to_string(),
                        key: key.to_string(),
                        from_windows_mount,
                    });
                }
            }
        }
    }
    None
}

/// Candidate paths for the discovery file (dev first, then release).
/// Returns (path, from_windows_mount) tuples.
fn discovery_file_candidates() -> Vec<(std::path::PathBuf, bool)> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push((
            std::path::PathBuf::from(&appdata)
                .join("laymux-dev")
                .join("automation.json"),
            false,
        ));
        paths.push((
            std::path::PathBuf::from(&appdata)
                .join("laymux")
                .join("automation.json"),
            false,
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Native Linux paths first
        if let Ok(home) = std::env::var("HOME") {
            paths.push((
                std::path::PathBuf::from(&home).join(".config/laymux-dev/automation.json"),
                false,
            ));
            paths.push((
                std::path::PathBuf::from(&home).join(".config/laymux/automation.json"),
                false,
            ));
        }

        // WSL: try Windows APPDATA via /mnt/c mount
        // WSLENV or /proc/version containing "microsoft" indicates WSL
        if is_wsl() {
            if let Some(appdata) = resolve_windows_appdata_in_wsl() {
                paths.push((
                    std::path::PathBuf::from(&appdata)
                        .join("laymux-dev")
                        .join("automation.json"),
                    true,
                ));
                paths.push((
                    std::path::PathBuf::from(&appdata)
                        .join("laymux")
                        .join("automation.json"),
                    true,
                ));
            }
        }
    }

    paths
}

/// Detect if running inside WSL.
#[cfg(not(target_os = "windows"))]
fn is_wsl() -> bool {
    // WSLENV is set by WSL for interop
    if std::env::var("WSLENV").is_ok() {
        return true;
    }
    // /proc/version contains "microsoft" or "Microsoft" on WSL
    if let Ok(ver) = std::fs::read_to_string("/proc/version") {
        if ver.to_lowercase().contains("microsoft") {
            return true;
        }
    }
    false
}

/// Resolve the Windows APPDATA path as seen from WSL (e.g., /mnt/c/Users/<user>/AppData/Roaming).
#[cfg(not(target_os = "windows"))]
fn resolve_windows_appdata_in_wsl() -> Option<String> {
    // Try APPDATA env var if WSL interop passes it through
    if let Ok(appdata) = std::env::var("APPDATA") {
        // Convert Windows path (C:\Users\...) to WSL path (/mnt/c/Users/...)
        if let Some(wsl_path) = windows_to_wsl_path(&appdata) {
            return Some(wsl_path);
        }
    }

    // Try wslvar (from wslu package) to get Windows APPDATA
    let output = std::process::Command::new("wslvar")
        .arg("APPDATA")
        .output();
    if let Ok(out) = output {
        if out.status.success() {
            let win_path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(wsl_path) = windows_to_wsl_path(&win_path) {
                return Some(wsl_path);
            }
        }
    }

    // Last resort: guess from /mnt/c/Users
    if let Ok(home) = std::env::var("HOME") {
        // e.g., /home/kochul → try /mnt/c/Users/kochul/AppData/Roaming
        if let Some(user) = home.strip_prefix("/home/") {
            let guess = format!("/mnt/c/Users/{}/AppData/Roaming", user);
            if std::path::Path::new(&guess).is_dir() {
                return Some(guess);
            }
        }
    }

    None
}

/// Convert a Windows path like `C:\Users\foo\AppData\Roaming` to `/mnt/c/Users/foo/AppData/Roaming`.
fn windows_to_wsl_path(win_path: &str) -> Option<String> {
    // Expected: "X:\..." or "X:/..."
    let bytes = win_path.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && (bytes[1] == b':') {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = &win_path[2..].replace('\\', "/");
        Some(format!("/mnt/{}{}", drive, rest))
    } else {
        None
    }
}

/// Get the WSL gateway IP (Windows host) from the default route.
#[cfg(not(target_os = "windows"))]
fn wsl_gateway_ip() -> Option<String> {
    // Method 1: default route gateway
    if let Ok(output) = std::process::Command::new("ip")
        .args(["route", "show", "default"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // "default via 172.23.48.1 dev eth0"
            if let Some(ip) = stdout.split_whitespace().nth(2) {
                if ip.contains('.') {
                    return Some(ip.to_string());
                }
            }
        }
    }

    // Method 2: /etc/resolv.conf nameserver
    if let Ok(content) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("nameserver") {
                let ip = rest.trim();
                if ip.contains('.') && ip != "127.0.0.1" {
                    return Some(ip.to_string());
                }
            }
        }
    }

    None
}

// -- HTTP client calls to Automation API --

/// Add Bearer authorization header if key is available.
#[allow(clippy::result_large_err)]
fn auth_get(url: &str, key: Option<&str>) -> Result<ureq::Response, ureq::Error> {
    let mut req = ureq::get(url);
    if let Some(k) = key {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    req.call()
}

#[allow(clippy::result_large_err)]
fn auth_post(url: &str, body: Value, key: Option<&str>) -> Result<ureq::Response, ureq::Error> {
    let mut req = ureq::post(url);
    if let Some(k) = key {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    req.send_json(body)
}

fn call_list_terminals(base_url: &str, key: Option<&str>) -> Result<String, String> {
    let url = format!("{}/api/v1/terminals", base_url);
    let resp = auth_get(&url, key).map_err(|e| format!("HTTP error: {e}"))?;
    let body: Value = resp.into_json().map_err(|e| format!("JSON error: {e}"))?;
    Ok(serde_json::to_string_pretty(&body).unwrap_or_default())
}

fn call_write_to_terminal(
    base_url: &str,
    args: &Value,
    key: Option<&str>,
) -> Result<String, String> {
    let terminal_id = args
        .get("terminal_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing terminal_id")?;
    let data = args
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or("Missing data")?;

    let url = format!("{}/api/v1/terminals/{}/write", base_url, terminal_id);
    let resp =
        auth_post(&url, json!({ "data": data }), key).map_err(|e| format!("HTTP error: {e}"))?;
    let body: Value = resp.into_json().map_err(|e| format!("JSON error: {e}"))?;
    Ok(serde_json::to_string_pretty(&body).unwrap_or_default())
}

fn call_read_terminal_output(
    base_url: &str,
    args: &Value,
    key: Option<&str>,
) -> Result<String, String> {
    let terminal_id = args
        .get("terminal_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing terminal_id")?;
    let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(100);

    let url = format!(
        "{}/api/v1/terminals/{}/output?lines={}",
        base_url, terminal_id, lines
    );
    let resp = auth_get(&url, key).map_err(|e| format!("HTTP error: {e}"))?;
    let body: Value = resp.into_json().map_err(|e| format!("JSON error: {e}"))?;

    if let Some(output) = body.get("output").and_then(|v| v.as_str()) {
        Ok(output.to_string())
    } else {
        Ok(serde_json::to_string_pretty(&body).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_has_three_tools() {
        let tools = tool_definitions();
        let arr = tools.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["name"], "list_terminals");
        assert_eq!(arr[1]["name"], "write_to_terminal");
        assert_eq!(arr[2]["name"], "read_terminal_output");
    }

    #[test]
    fn tool_definitions_have_input_schemas() {
        let tools = tool_definitions();
        for tool in tools.as_array().unwrap() {
            assert!(tool.get("inputSchema").is_some());
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn handle_initialize_returns_capabilities() {
        let resp = handle_initialize(&json!(1));
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["result"]["serverInfo"]["name"], "laymux-mcp");
    }

    #[test]
    fn handle_tools_list_returns_all_tools() {
        let resp = handle_tools_list(&json!(2));
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
    }

    #[test]
    fn handle_initialized_returns_none() {
        assert!(handle_initialized().is_none());
    }

    #[test]
    fn handle_request_routes_initialize() {
        let req = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
        let resp = handle_request(&req, "http://localhost:19280", None).unwrap();
        assert_eq!(resp["result"]["serverInfo"]["name"], "laymux-mcp");
    }

    #[test]
    fn handle_request_routes_tools_list() {
        let req = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}});
        let resp = handle_request(&req, "http://localhost:19280", None).unwrap();
        assert!(resp["result"]["tools"].is_array());
    }

    #[test]
    fn handle_request_unknown_method_returns_error() {
        let req = json!({"jsonrpc": "2.0", "id": 3, "method": "nonexistent"});
        let resp = handle_request(&req, "http://localhost:19280", None).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn handle_request_notification_no_response() {
        let req = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        assert!(handle_request(&req, "http://localhost:19280", None).is_none());
    }

    #[test]
    fn handle_request_ping() {
        let req = json!({"jsonrpc": "2.0", "id": 4, "method": "ping"});
        let resp = handle_request(&req, "http://localhost:19280", None).unwrap();
        assert!(resp["result"].is_object());
    }

    #[test]
    fn error_response_format() {
        let resp = error_response(&json!(5), -32600, "Invalid Request");
        assert_eq!(resp["error"]["code"], -32600);
    }

    #[test]
    fn tools_call_unknown_tool_returns_error() {
        let resp = handle_tools_call(
            &json!(6),
            &json!({"name": "bad"}),
            "http://localhost:1",
            None,
        );
        assert!(resp["result"]["isError"].as_bool().unwrap_or(false));
    }

    #[test]
    fn windows_to_wsl_path_backslash() {
        let result = windows_to_wsl_path(r"C:\Users\kochul\AppData\Roaming");
        assert_eq!(
            result,
            Some("/mnt/c/Users/kochul/AppData/Roaming".to_string())
        );
    }

    #[test]
    fn windows_to_wsl_path_forward_slash() {
        let result = windows_to_wsl_path("D:/Projects/test");
        assert_eq!(result, Some("/mnt/d/Projects/test".to_string()));
    }

    #[test]
    fn windows_to_wsl_path_invalid() {
        assert_eq!(windows_to_wsl_path("/home/user"), None);
        assert_eq!(windows_to_wsl_path(""), None);
        assert_eq!(windows_to_wsl_path("ab"), None);
    }

    #[test]
    fn resolve_connection_env_vars_take_priority() {
        // When both env vars are set, they should be used directly
        std::env::set_var("LX_AUTOMATION_PORT", "19999");
        std::env::set_var("LX_AUTOMATION_KEY", "test-key-123");
        std::env::set_var("LX_AUTOMATION_HOST", "10.0.0.1");

        let conn = resolve_connection();
        assert_eq!(conn.base_url, "http://10.0.0.1:19999");
        assert_eq!(conn.key.as_deref(), Some("test-key-123"));

        // Clean up
        std::env::remove_var("LX_AUTOMATION_PORT");
        std::env::remove_var("LX_AUTOMATION_KEY");
        std::env::remove_var("LX_AUTOMATION_HOST");
    }

    #[test]
    fn discovery_file_json_parsing() {
        let json_str = r#"{"port": 19281, "key": "abc-def", "pid": 1234, "version": "0.1.0"}"#;
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        let port = parsed.get("port").and_then(|v| v.as_u64());
        let key = parsed.get("key").and_then(|v| v.as_str());

        assert_eq!(port, Some(19281));
        assert_eq!(key, Some("abc-def"));
    }
}
