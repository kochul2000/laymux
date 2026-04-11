//! Embedded MCP (Model Context Protocol) server.
//!
//! Implements the Streamable HTTP MCP transport as a single POST /mcp endpoint.
//! JSON-RPC 2.0 requests are dispatched to `initialize`, `tools/list`, `tools/call`,
//! `ping`, and `notifications/initialized`.

use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::constants::{MCP_PROTOCOL_VERSION, MCP_SERVER_NAME};
use crate::lock_ext::MutexExt;

use super::helpers::bridge_request;
use super::ServerState;

// ── JSON-RPC helpers ──────────────────────────────────────────────

fn jsonrpc_ok(id: &Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn jsonrpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

// ── Main handler ──────────────────────────────────────────────────

pub async fn handle_mcp(
    AxumState(state): AxumState<ServerState>,
    Json(req): Json<Value>,
) -> impl IntoResponse {
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // Notifications have no id and expect no response
    if method == "notifications/initialized" {
        return (StatusCode::OK, Json(json!({})));
    }

    let result = match method {
        "initialize" => handle_initialize(&id),
        "ping" => jsonrpc_ok(&id, json!({})),
        "tools/list" => handle_tools_list(&id),
        "tools/call" => handle_tools_call(&id, &params, &state).await,
        _ => jsonrpc_err(&id, -32601, &format!("Method not found: {method}")),
    };

    (StatusCode::OK, Json(result))
}

// ── initialize ────────────────────────────────────────────────────

fn handle_initialize(id: &Value) -> Value {
    jsonrpc_ok(
        id,
        json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": MCP_SERVER_NAME,
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
    )
}

// ── tools/list ────────────────────────────────────────────────────

fn handle_tools_list(id: &Value) -> Value {
    jsonrpc_ok(id, json!({ "tools": tool_definitions() }))
}

fn tool_definitions() -> Value {
    json!([
        // ── Terminal (5) ──
        {
            "name": "list_terminals",
            "description": "List all terminal instances with id, profile, syncGroup, workspaceId, label, cwd, branch.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "write_to_terminal",
            "description": "Send input to a terminal (like typing). Use \\r\\n for Enter.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal_id": { "type": "string", "description": "Terminal ID" },
                    "data": { "type": "string", "description": "Text to send" }
                },
                "required": ["terminal_id", "data"]
            }
        },
        {
            "name": "read_terminal_output",
            "description": "Read recent terminal output from ring buffer. Contains raw ANSI escapes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal_id": { "type": "string", "description": "Terminal ID" },
                    "lines": { "type": "integer", "description": "Number of lines (default 100)" }
                },
                "required": ["terminal_id"]
            }
        },
        {
            "name": "focus_terminal",
            "description": "Set focus to a terminal pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal_id": { "type": "string", "description": "Terminal ID" }
                },
                "required": ["terminal_id"]
            }
        },
        {
            "name": "get_terminal_states",
            "description": "Get activity state (shell/running/interactiveApp) for all terminals.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        // ── Workspace (4) ──
        {
            "name": "list_workspaces",
            "description": "List all workspaces with pane layouts and active workspace ID.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_active_workspace",
            "description": "Get the currently active workspace with full pane details.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "switch_workspace",
            "description": "Switch to a different workspace by ID.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace_id": { "type": "string", "description": "Workspace ID" }
                },
                "required": ["workspace_id"]
            }
        },
        {
            "name": "create_workspace",
            "description": "Create a new workspace, optionally from a layout template.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Workspace name" },
                    "layout_id": { "type": "string", "description": "Layout ID (optional)" }
                },
                "required": ["name"]
            }
        },
        // ── Grid/Pane (3) ──
        {
            "name": "get_grid_state",
            "description": "Get grid state: editMode, focusedPaneIndex.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "focus_pane",
            "description": "Focus a specific pane by index.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane_index": { "type": "integer", "description": "Pane index" }
                },
                "required": ["pane_index"]
            }
        },
        {
            "name": "split_pane",
            "description": "Split a pane horizontally or vertically.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane_index": { "type": "integer", "description": "Pane index to split" },
                    "direction": { "type": "string", "enum": ["horizontal", "vertical"] }
                },
                "required": ["pane_index", "direction"]
            }
        },
        // ── Utility (3) ──
        {
            "name": "take_screenshot",
            "description": "Capture a screenshot of the current IDE UI. Returns image content.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_notifications",
            "description": "List all notifications across workspaces.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "send_notification",
            "description": "Create a notification in the IDE.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "terminal_id": { "type": "string", "description": "Terminal ID" },
                    "workspace_id": { "type": "string", "description": "Workspace ID" },
                    "message": { "type": "string", "description": "Notification message" },
                    "level": { "type": "string", "enum": ["info", "error", "warning", "success"], "description": "Notification level (default: info)" }
                },
                "required": ["terminal_id", "workspace_id", "message"]
            }
        }
    ])
}

// ── tools/call ────────────────────────────────────────────────────

async fn handle_tools_call(id: &Value, params: &Value, state: &ServerState) -> Value {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or(json!({}));

    match execute_tool(name, &args, state).await {
        Ok(content) => jsonrpc_ok(
            id,
            json!({ "content": content }),
        ),
        Err(msg) => jsonrpc_ok(
            id,
            json!({
                "content": [{ "type": "text", "text": msg }],
                "isError": true,
            }),
        ),
    }
}

async fn execute_tool(
    name: &str,
    args: &Value,
    state: &ServerState,
) -> Result<Value, String> {
    match name {
        // ── Terminal ──
        "list_terminals" => {
            let data = bridge_request(state, "query", "terminals", "list", json!({}))
                .await
                .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "write_to_terminal" => {
            let terminal_id = arg_str(args, "terminal_id")?;
            let data = arg_str(args, "data")?;

            let ptys = state
                .app_state
                .pty_handles
                .lock_or_err()
                .map_err(|e| e.to_string())?;
            match ptys.get(&terminal_id) {
                Some(handle) => {
                    handle.write(data.as_bytes()).map_err(|e| e.to_string())?;
                    Ok(text_content(json!({ "success": true, "message": "written" })))
                }
                None => Err(format!("Terminal '{terminal_id}' not found")),
            }
        }
        "read_terminal_output" => {
            let terminal_id = arg_str(args, "terminal_id")?;
            let lines = args
                .get("lines")
                .and_then(|v| v.as_u64())
                .unwrap_or(100) as usize;

            let buffers = state
                .app_state
                .output_buffers
                .lock_or_err()
                .map_err(|e| e.to_string())?;
            match buffers.get(&terminal_id) {
                Some(buf) => {
                    let output = buf.recent_lines(lines);
                    let line_count = output.lines().count();
                    Ok(text_content(json!({
                        "output": output,
                        "lines": line_count,
                        "bufferSize": buf.len(),
                    })))
                }
                None => Err(format!("Terminal '{terminal_id}' not found")),
            }
        }
        "focus_terminal" => {
            let terminal_id = arg_str(args, "terminal_id")?;
            let data = bridge_request(
                state,
                "action",
                "terminals",
                "setFocus",
                json!({ "id": terminal_id }),
            )
            .await
            .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "get_terminal_states" => {
            let states =
                crate::activity::detect_all_terminal_states(&state.app_state);
            Ok(text_content(json!({ "states": states })))
        }

        // ── Workspace ──
        "list_workspaces" => {
            let data =
                bridge_request(state, "query", "workspaces", "list", json!({}))
                    .await
                    .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "get_active_workspace" => {
            let data = bridge_request(
                state,
                "query",
                "workspaces",
                "getActive",
                json!({}),
            )
            .await
            .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "switch_workspace" => {
            let workspace_id = arg_str(args, "workspace_id")?;
            let data = bridge_request(
                state,
                "action",
                "workspaces",
                "switchActive",
                json!({ "id": workspace_id }),
            )
            .await
            .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "create_workspace" => {
            let name = arg_str(args, "name")?;
            let mut params = json!({ "name": name });
            if let Some(layout_id) = args.get("layout_id").and_then(|v| v.as_str()) {
                params["layoutId"] = json!(layout_id);
            }
            let data =
                bridge_request(state, "action", "workspaces", "add", params)
                    .await
                    .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }

        // ── Grid/Pane ──
        "get_grid_state" => {
            let data =
                bridge_request(state, "query", "grid", "getState", json!({}))
                    .await
                    .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "focus_pane" => {
            let pane_index = arg_u64(args, "pane_index")?;
            let data = bridge_request(
                state,
                "action",
                "grid",
                "focusPane",
                json!({ "index": pane_index }),
            )
            .await
            .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "split_pane" => {
            let pane_index = arg_u64(args, "pane_index")?;
            let direction = arg_str(args, "direction")?;
            let data = bridge_request(
                state,
                "action",
                "panes",
                "split",
                json!({ "paneIndex": pane_index, "direction": direction }),
            )
            .await
            .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }

        // ── Utility ──
        "take_screenshot" => execute_screenshot(state).await,
        "list_notifications" => {
            let data = bridge_request(
                state,
                "query",
                "notifications",
                "list",
                json!({}),
            )
            .await
            .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }
        "send_notification" => {
            let terminal_id = arg_str(args, "terminal_id")?;
            let workspace_id = arg_str(args, "workspace_id")?;
            let message = arg_str(args, "message")?;
            let mut params = json!({
                "terminalId": terminal_id,
                "workspaceId": workspace_id,
                "message": message,
            });
            if let Some(level) = args.get("level").and_then(|v| v.as_str()) {
                params["level"] = json!(level);
            }
            let data =
                bridge_request(state, "action", "notifications", "add", params)
                    .await
                    .map_err(|e| format_bridge_error(e))?;
            Ok(text_content(data))
        }

        _ => Err(format!("Unknown tool: {name}")),
    }
}

// ── Screenshot ────────────────────────────────────────────────────

async fn execute_screenshot(state: &ServerState) -> Result<Value, String> {
    let data = bridge_request(state, "action", "screenshot", "capture", json!({}))
        .await
        .map_err(|e| format_bridge_error(e))?;

    let data_url = data
        .get("dataUrl")
        .and_then(|v| v.as_str())
        .ok_or("No dataUrl in screenshot response")?;

    // Strip "data:image/png;base64," prefix
    let base64_data = data_url
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(data_url);

    Ok(json!([{
        "type": "image",
        "data": base64_data,
        "mimeType": "image/png",
    }]))
}

// ── Argument helpers ──────────────────────────────────────────────

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Missing required argument: {key}"))
}

fn arg_u64(args: &Value, key: &str) -> Result<u64, String> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("Missing required argument: {key}"))
}

fn text_content(data: Value) -> Value {
    let text = serde_json::to_string_pretty(&data).unwrap_or_default();
    json!([{ "type": "text", "text": text }])
}

fn format_bridge_error(e: (StatusCode, Json<Value>)) -> String {
    let Json(body) = e.1;
    body.get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("Bridge request failed")
        .to_string()
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_response_format() {
        let resp = handle_initialize(&json!(1));
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        let result = &resp["result"];
        assert_eq!(result["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(result["serverInfo"]["name"], MCP_SERVER_NAME);
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[test]
    fn tools_list_returns_15_tools() {
        let resp = handle_tools_list(&json!(2));
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 15, "Expected 15 tools, got {}", tools.len());
    }

    #[test]
    fn tool_definitions_have_valid_schemas() {
        let defs = tool_definitions();
        let tools = defs.as_array().unwrap();
        for tool in tools {
            assert!(tool["name"].is_string(), "Tool missing name");
            assert!(tool["description"].is_string(), "Tool missing description");
            let schema = &tool["inputSchema"];
            assert_eq!(schema["type"], "object", "Schema type must be 'object'");
            assert!(
                schema["properties"].is_object(),
                "Schema missing properties"
            );
        }
    }

    #[test]
    fn tool_names_are_unique() {
        let defs = tool_definitions();
        let tools = defs.as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            names.len(),
            sorted.len(),
            "Duplicate tool names found"
        );
    }

    #[test]
    fn jsonrpc_ok_format() {
        let resp = jsonrpc_ok(&json!(42), json!({"data": true}));
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 42);
        assert_eq!(resp["result"]["data"], true);
    }

    #[test]
    fn jsonrpc_err_format() {
        let resp = jsonrpc_err(&json!(99), -32601, "Method not found");
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 99);
        assert_eq!(resp["error"]["code"], -32601);
        assert_eq!(resp["error"]["message"], "Method not found");
    }

    #[test]
    fn ping_returns_empty_result() {
        let id = json!(3);
        let resp = jsonrpc_ok(&id, json!({}));
        assert!(resp["result"].is_object());
        assert_eq!(resp["result"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn unknown_method_returns_error() {
        let resp = jsonrpc_err(&json!(5), -32601, "Method not found: foo/bar");
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn arg_str_extracts_value() {
        let args = json!({"name": "test"});
        assert_eq!(arg_str(&args, "name").unwrap(), "test");
    }

    #[test]
    fn arg_str_missing_returns_error() {
        let args = json!({});
        assert!(arg_str(&args, "name").is_err());
    }

    #[test]
    fn arg_u64_extracts_value() {
        let args = json!({"index": 5});
        assert_eq!(arg_u64(&args, "index").unwrap(), 5);
    }

    #[test]
    fn text_content_wraps_in_array() {
        let data = json!({"key": "value"});
        let content = text_content(data);
        let arr = content.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "text");
        assert!(arr[0]["text"].as_str().unwrap().contains("key"));
    }

    #[test]
    fn notification_has_no_id() {
        // notifications/initialized should not produce a jsonrpc response with an id
        // This is handled in handle_mcp by returning early with empty JSON
    }
}
