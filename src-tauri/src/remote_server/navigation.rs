use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::terminal_info::RemoteTerminalInfo;

const TERMINAL_VIEW: &str = "TerminalView";

pub(super) fn build_remote_navigation_payload(
    workspaces_data: &Value,
    active_workspace_data: &Value,
    docks_data: &Value,
    terminal_instances_data: &Value,
    terminals: &[RemoteTerminalInfo],
) -> Value {
    let terminal_instances = terminal_instances_data
        .get("instances")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let frontend_by_id: HashMap<&str, &Value> = terminal_instances
        .iter()
        .filter_map(|terminal| string_field(terminal, "id").map(|id| (id, terminal)))
        .collect();
    let backend_by_id: HashMap<&str, &RemoteTerminalInfo> = terminals
        .iter()
        .map(|terminal| (terminal.id.as_str(), terminal))
        .collect();

    let active_workspace_id = string_field(workspaces_data, "activeWorkspaceId")
        .or_else(|| {
            active_workspace_data
                .get("workspace")
                .and_then(|workspace| string_field(workspace, "id"))
        })
        .unwrap_or_default();

    let workspaces = workspaces_data
        .get("workspaces")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|workspace| {
                    summarize_workspace(workspace, active_workspace_id, terminal_instances)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let active_workspace = active_workspace_data
        .get("workspace")
        .filter(|workspace| !workspace.is_null())
        .map(|workspace| {
            summarize_active_workspace(
                workspace,
                active_workspace_id,
                &backend_by_id,
                &frontend_by_id,
            )
        })
        .unwrap_or(Value::Null);

    let docks = docks_data
        .get("docks")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|dock| {
                    summarize_dock(dock, active_workspace_id, &backend_by_id, &frontend_by_id)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let terminals = terminals
        .iter()
        .map(|terminal| {
            terminal_summary_value(terminal, frontend_by_id.get(terminal.id.as_str()).copied())
        })
        .collect::<Vec<_>>();

    json!({
        "activeWorkspaceId": active_workspace_id,
        "workspaces": workspaces,
        "activeWorkspace": active_workspace,
        "docks": docks,
        "terminals": terminals,
    })
}

fn summarize_workspace(
    workspace: &Value,
    active_workspace_id: &str,
    terminal_instances: &[Value],
) -> Value {
    let id = string_field(workspace, "id").unwrap_or_default();
    let panes = workspace
        .get("panes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let terminal_pane_count = panes
        .iter()
        .filter(|pane| view_type(pane) == TERMINAL_VIEW)
        .count();
    let live_terminal_count = panes
        .iter()
        .filter(|pane| {
            let pane_id = string_field(pane, "id").unwrap_or_default();
            if view_type(pane) != TERMINAL_VIEW || pane_id.is_empty() {
                return false;
            }
            let terminal_id = format!("terminal-{pane_id}");
            terminal_instances
                .iter()
                .any(|terminal| string_field(terminal, "id") == Some(terminal_id.as_str()))
        })
        .count();

    json!({
        "id": id,
        "name": string_field(workspace, "name").unwrap_or("Workspace"),
        "isActive": id == active_workspace_id,
        "paneCount": panes.len(),
        "terminalPaneCount": terminal_pane_count,
        "liveTerminalCount": live_terminal_count,
    })
}

fn summarize_active_workspace(
    workspace: &Value,
    active_workspace_id: &str,
    backend_by_id: &HashMap<&str, &RemoteTerminalInfo>,
    frontend_by_id: &HashMap<&str, &Value>,
) -> Value {
    let panes = workspace
        .get("panes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, pane)| {
                    summarize_pane(
                        pane,
                        index,
                        Some(active_workspace_id),
                        "workspace",
                        backend_by_id,
                        frontend_by_id,
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "id": string_field(workspace, "id").unwrap_or(active_workspace_id),
        "name": string_field(workspace, "name").unwrap_or("Workspace"),
        "focusedPaneIndex": optional_field(workspace, "focusedPaneIndex"),
        "focusedPaneNumber": optional_field(workspace, "focusedPaneNumber"),
        "paneCount": panes.len(),
        "panes": panes,
    })
}

fn summarize_dock(
    dock: &Value,
    active_workspace_id: &str,
    backend_by_id: &HashMap<&str, &RemoteTerminalInfo>,
    frontend_by_id: &HashMap<&str, &Value>,
) -> Value {
    let panes = dock
        .get("panes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, pane)| {
                    summarize_pane(
                        pane,
                        index,
                        Some(active_workspace_id),
                        "dock",
                        backend_by_id,
                        frontend_by_id,
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "position": string_field(dock, "position").unwrap_or("unknown"),
        "visible": bool_field(dock, "visible").unwrap_or(false),
        "activeView": optional_field(dock, "activeView"),
        "views": optional_field(dock, "views"),
        "size": optional_field(dock, "size"),
        "paneCount": panes.len(),
        "panes": panes,
    })
}

fn summarize_pane(
    pane: &Value,
    fallback_index: usize,
    workspace_id: Option<&str>,
    location: &str,
    backend_by_id: &HashMap<&str, &RemoteTerminalInfo>,
    frontend_by_id: &HashMap<&str, &Value>,
) -> Value {
    let pane_id = string_field(pane, "id").unwrap_or_default();
    let view_type = view_type(pane);
    let terminal_id = string_field(pane, "terminalId")
        .map(str::to_string)
        .or_else(|| {
            if view_type == TERMINAL_VIEW && !pane_id.is_empty() {
                Some(format!("terminal-{pane_id}"))
            } else {
                None
            }
        });
    let backend = terminal_id
        .as_deref()
        .and_then(|id| backend_by_id.get(id))
        .copied();
    let frontend = terminal_id
        .as_deref()
        .and_then(|id| frontend_by_id.get(id))
        .copied();
    let title = pane_title(&view_type, backend, frontend, terminal_id.as_deref());

    json!({
        "id": pane_id,
        "location": location,
        "workspaceId": workspace_id,
        "paneIndex": optional_field(pane, "paneIndex").unwrap_or_else(|| json!(fallback_index)),
        "paneNumber": optional_field(pane, "paneNumber"),
        "viewType": view_type,
        "terminalId": terminal_id,
        "terminalLive": backend.is_some(),
        "title": title,
        "profile": terminal_profile(backend, frontend),
        "cwd": terminal_cwd(backend, frontend),
        "branch": terminal_branch(backend, frontend),
        "activity": terminal_activity(backend, frontend),
        "outputActive": frontend.and_then(|terminal| optional_field(terminal, "outputActive")),
        "commandRunning": backend.map(|terminal| terminal.command_running).unwrap_or(false),
        "x": optional_field(pane, "x"),
        "y": optional_field(pane, "y"),
        "w": optional_field(pane, "w"),
        "h": optional_field(pane, "h"),
    })
}

fn terminal_summary_value(terminal: &RemoteTerminalInfo, frontend: Option<&Value>) -> Value {
    let mut value = serde_json::to_value(terminal).unwrap_or_else(|_| Value::Object(Map::new()));
    let Some(object) = value.as_object_mut() else {
        return value;
    };

    for key in [
        "workspaceId",
        "label",
        "paneIndex",
        "paneNumber",
        "panePosition",
        "activity",
        "outputActive",
        "activityMessage",
        "isFocused",
        "lastActivityAt",
        "lastCommand",
        "lastExitCode",
        "lastCommandAt",
    ] {
        if let Some(extra) = frontend.and_then(|terminal| optional_field(terminal, key)) {
            object.insert(key.to_string(), extra);
        }
    }

    value
}

fn pane_title(
    view_type: &str,
    backend: Option<&RemoteTerminalInfo>,
    frontend: Option<&Value>,
    terminal_id: Option<&str>,
) -> String {
    string_field(frontend.unwrap_or(&Value::Null), "title")
        .or_else(|| {
            backend
                .map(|terminal| terminal.title.as_str())
                .filter(|title| !title.is_empty())
        })
        .or_else(|| string_field(frontend.unwrap_or(&Value::Null), "label"))
        .or_else(|| {
            backend
                .map(|terminal| terminal.profile.as_str())
                .filter(|profile| !profile.is_empty())
        })
        .or(terminal_id)
        .map(str::to_string)
        .unwrap_or_else(|| view_label(view_type).to_string())
}

fn terminal_profile(
    backend: Option<&RemoteTerminalInfo>,
    frontend: Option<&Value>,
) -> Option<String> {
    backend
        .map(|terminal| terminal.profile.clone())
        .or_else(|| string_field(frontend.unwrap_or(&Value::Null), "profile").map(str::to_string))
}

fn terminal_cwd(backend: Option<&RemoteTerminalInfo>, frontend: Option<&Value>) -> Option<String> {
    backend
        .and_then(|terminal| terminal.cwd.clone())
        .or_else(|| string_field(frontend.unwrap_or(&Value::Null), "cwd").map(str::to_string))
}

fn terminal_branch(
    backend: Option<&RemoteTerminalInfo>,
    frontend: Option<&Value>,
) -> Option<String> {
    backend
        .and_then(|terminal| terminal.branch.clone())
        .or_else(|| string_field(frontend.unwrap_or(&Value::Null), "branch").map(str::to_string))
}

fn terminal_activity(backend: Option<&RemoteTerminalInfo>, frontend: Option<&Value>) -> Value {
    if let Some(activity) = frontend.and_then(|terminal| optional_field(terminal, "activity")) {
        return activity;
    }
    if backend
        .map(|terminal| terminal.command_running)
        .unwrap_or(false)
    {
        return json!({ "type": "running" });
    }
    Value::Null
}

fn view_type(value: &Value) -> &str {
    value
        .get("view")
        .and_then(|view| string_field(view, "type"))
        .unwrap_or("EmptyView")
}

fn view_label(view_type: &str) -> &str {
    match view_type {
        "WorkspaceSelectorView" => "Workspace Selector",
        "SettingsView" => "Settings",
        "IssueReporterView" => "Issue Reporter",
        "MemoView" => "Memo",
        "FileExplorerView" => "File Explorer",
        "TerminalView" => "Terminal",
        _ => "Empty",
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn optional_field(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|item| !item.is_null()).cloned()
}

#[cfg(test)]
mod tests {
    use super::super::appearance::{RemoteTerminalAppearance, RemoteTerminalTheme};
    use super::*;

    fn terminal(id: &str, title: &str) -> RemoteTerminalInfo {
        RemoteTerminalInfo {
            id: id.into(),
            title: title.into(),
            profile: "PowerShell".into(),
            cwd: Some("D:\\Project".into()),
            branch: Some("main".into()),
            cols: 120,
            rows: 32,
            sync_group: "ws-1".into(),
            command_running: false,
            appearance: RemoteTerminalAppearance {
                font_family: "Cascadia Mono".into(),
                font_size: 14,
                cursor_style: "bar".into(),
                cursor_width: Some(1),
                theme: RemoteTerminalTheme::default(),
            },
        }
    }

    #[test]
    fn navigation_payload_summarizes_workspaces_panes_docks_and_terminals() {
        let workspaces_data = json!({
            "activeWorkspaceId": "ws-1",
            "workspaces": [
                {
                    "id": "ws-1",
                    "name": "Main",
                    "panes": [
                        { "id": "p1", "view": { "type": "TerminalView" }, "x": 0, "y": 0, "w": 1, "h": 1 },
                        { "id": "p2", "view": { "type": "MemoView" }, "x": 0, "y": 0, "w": 1, "h": 1 }
                    ]
                },
                { "id": "ws-2", "name": "Side", "panes": [] }
            ]
        });
        let active_workspace_data = json!({
            "workspace": {
                "id": "ws-1",
                "name": "Main",
                "focusedPaneIndex": 0,
                "focusedPaneNumber": 1,
                "panes": [
                    {
                        "id": "p1",
                        "paneIndex": 0,
                        "paneNumber": 1,
                        "terminalId": "terminal-p1",
                        "view": { "type": "TerminalView" },
                        "x": 0,
                        "y": 0,
                        "w": 1,
                        "h": 1
                    },
                    {
                        "id": "p2",
                        "paneIndex": 1,
                        "paneNumber": 2,
                        "terminalId": null,
                        "view": { "type": "MemoView" },
                        "x": 0,
                        "y": 0,
                        "w": 1,
                        "h": 1
                    }
                ]
            }
        });
        let docks_data = json!({
            "docks": [
                {
                    "position": "left",
                    "visible": true,
                    "activeView": "WorkspaceSelectorView",
                    "views": ["WorkspaceSelectorView"],
                    "size": 240,
                    "panes": [
                        { "id": "dp1", "view": { "type": "TerminalView" }, "x": 0, "y": 0, "w": 1, "h": 1 }
                    ]
                }
            ]
        });
        let terminal_instances_data = json!({
            "instances": [
                {
                    "id": "terminal-p1",
                    "workspaceId": "ws-1",
                    "label": "PowerShell",
                    "title": "frontend title",
                    "paneIndex": 0,
                    "paneNumber": 1,
                    "activity": { "type": "shell" },
                    "isFocused": true
                },
                {
                    "id": "terminal-dp1",
                    "workspaceId": "ws-1",
                    "label": "Dock shell",
                    "activity": { "type": "running" }
                }
            ]
        });
        let terminals = vec![
            terminal("terminal-p1", "backend title"),
            terminal("terminal-dp1", "dock backend"),
        ];

        let payload = build_remote_navigation_payload(
            &workspaces_data,
            &active_workspace_data,
            &docks_data,
            &terminal_instances_data,
            &terminals,
        );

        assert_eq!(payload["activeWorkspaceId"], "ws-1");
        assert_eq!(payload["workspaces"][0]["terminalPaneCount"], 1);
        assert_eq!(payload["workspaces"][0]["liveTerminalCount"], 1);
        assert_eq!(
            payload["activeWorkspace"]["panes"][0]["title"],
            "frontend title"
        );
        assert_eq!(payload["activeWorkspace"]["panes"][0]["terminalLive"], true);
        assert_eq!(
            payload["activeWorkspace"]["panes"][1]["viewType"],
            "MemoView"
        );
        assert_eq!(
            payload["docks"][0]["panes"][0]["terminalId"],
            "terminal-dp1"
        );
        assert_eq!(
            payload["docks"][0]["panes"][0]["activity"]["type"],
            "running"
        );
        assert_eq!(
            payload["terminals"][0]["appearance"]["fontFamily"],
            "Cascadia Mono"
        );
        assert_eq!(payload["terminals"][0]["paneNumber"], 1);
    }

    #[test]
    fn navigation_payload_keeps_non_terminal_view_summary_without_live_session() {
        let workspaces_data = json!({
            "activeWorkspaceId": "ws-1",
            "workspaces": [
                {
                    "id": "ws-1",
                    "name": "Main",
                    "panes": [
                        { "id": "settings", "view": { "type": "SettingsView" } }
                    ]
                }
            ]
        });
        let active_workspace_data = json!({
            "workspace": {
                "id": "ws-1",
                "name": "Main",
                "panes": [
                    { "id": "settings", "paneIndex": 0, "paneNumber": 1, "view": { "type": "SettingsView" } }
                ]
            }
        });

        let payload = build_remote_navigation_payload(
            &workspaces_data,
            &active_workspace_data,
            &json!({ "docks": [] }),
            &json!({ "instances": [] }),
            &[],
        );

        assert_eq!(
            payload["activeWorkspace"]["panes"][0]["terminalId"],
            Value::Null
        );
        assert_eq!(
            payload["activeWorkspace"]["panes"][0]["terminalLive"],
            false
        );
        assert_eq!(payload["activeWorkspace"]["panes"][0]["title"], "Settings");
    }
}
