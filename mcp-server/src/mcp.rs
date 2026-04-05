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
pub fn resolve_connection() -> AutomationConnection {
    let host = std::env::var("LX_AUTOMATION_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("LX_AUTOMATION_PORT").unwrap_or_else(|_| "19280".into());
    let base_url = format!("http://{}:{}", host, port);

    // Try key from env first, then discovery file
    let key = std::env::var("LX_AUTOMATION_KEY").ok().or_else(|| {
        read_discovery_key()
    });

    AutomationConnection { base_url, key }
}

/// Read the API key from the discovery file.
fn read_discovery_key() -> Option<String> {
    // Try dev discovery first, then release
    let candidates = discovery_file_candidates();
    for path in candidates {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(key) = parsed.get("key").and_then(|v| v.as_str()) {
                    return Some(key.to_string());
                }
            }
        }
    }
    None
}

/// Candidate paths for the discovery file.
fn discovery_file_candidates() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push(std::path::PathBuf::from(&appdata).join("laymux-dev").join("automation.json"));
        paths.push(std::path::PathBuf::from(&appdata).join("laymux").join("automation.json"));
    }

    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        paths.push(std::path::PathBuf::from(&home).join(".config/laymux-dev/automation.json"));
        paths.push(std::path::PathBuf::from(&home).join(".config/laymux/automation.json"));
    }

    paths
}


// -- HTTP client calls to Automation API --

/// Add Bearer authorization header if key is available.
fn auth_get(url: &str, key: Option<&str>) -> Result<ureq::Response, ureq::Error> {
    let mut req = ureq::get(url);
    if let Some(k) = key {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    req.call()
}

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
        let resp =
            handle_tools_call(&json!(6), &json!({"name": "bad"}), "http://localhost:1", None);
        assert!(resp["result"]["isError"].as_bool().unwrap_or(false));
    }
}
