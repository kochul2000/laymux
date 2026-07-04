use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::terminal_info::RemoteTerminalInfo;

const TERMINAL_VIEW: &str = "TerminalView";

pub(super) fn build_remote_navigation_payload(
    workspaces_data: &Value,
    active_workspace_data: &Value,
    docks_data: &Value,
    terminal_instances_data: &Value,
    notifications_data: &Value,
    ui_state_data: &Value,
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
    let hidden_workspace_ids = string_set(ui_state_data, "hiddenWorkspaceIds");
    let hidden_pane_ids = string_set(ui_state_data, "hiddenPaneIds");
    let workspace_display_order = string_vec(workspaces_data, "workspaceDisplayOrder");
    let workspace_selector = ui_state_data
        .get("workspaceSelector")
        .unwrap_or(&Value::Null);
    let workspace_sort_order = string_field(workspace_selector, "sortOrder").unwrap_or("manual");
    let notifications = notifications_data
        .get("notifications")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let workspaces = workspaces_data
        .get("workspaces")
        .and_then(Value::as_array)
        .map(|items| {
            ordered_workspaces(
                items,
                workspace_sort_order,
                &workspace_display_order,
                notifications,
            )
            .into_iter()
            .map(|workspace| {
                summarize_workspace(
                    workspace,
                    active_workspace_id,
                    terminal_instances,
                    notifications,
                    &hidden_workspace_ids,
                    &hidden_pane_ids,
                    &backend_by_id,
                    &frontend_by_id,
                )
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
                notifications,
                &hidden_pane_ids,
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
        "workspaceSelector": workspace_selector,
        "unreadNotificationCount": unread_count(notifications, None, None),
    })
}

fn summarize_workspace(
    workspace: &Value,
    active_workspace_id: &str,
    terminal_instances: &[Value],
    notifications: &[Value],
    hidden_workspace_ids: &HashSet<String>,
    hidden_pane_ids: &HashSet<String>,
    backend_by_id: &HashMap<&str, &RemoteTerminalInfo>,
    frontend_by_id: &HashMap<&str, &Value>,
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
    let pane_summaries = summarize_workspace_panes(
        panes,
        id,
        backend_by_id,
        frontend_by_id,
        notifications,
        hidden_pane_ids,
    );
    let hidden = hidden_workspace_ids.contains(id);

    json!({
        "id": id,
        "name": string_field(workspace, "name").unwrap_or("Workspace"),
        "isActive": id == active_workspace_id,
        "hidden": hidden,
        "collapsed": hidden && id != active_workspace_id,
        "paneCount": panes.len(),
        "terminalPaneCount": terminal_pane_count,
        "liveTerminalCount": live_terminal_count,
        "unreadCount": unread_count(notifications, Some(id), None),
        "panes": pane_summaries,
    })
}

fn summarize_active_workspace(
    workspace: &Value,
    active_workspace_id: &str,
    backend_by_id: &HashMap<&str, &RemoteTerminalInfo>,
    frontend_by_id: &HashMap<&str, &Value>,
    notifications: &[Value],
    hidden_pane_ids: &HashSet<String>,
) -> Value {
    let panes = workspace
        .get("panes")
        .and_then(Value::as_array)
        .map(|items| {
            summarize_workspace_panes(
                items,
                active_workspace_id,
                backend_by_id,
                frontend_by_id,
                notifications,
                hidden_pane_ids,
            )
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

fn summarize_workspace_panes(
    panes: &[Value],
    workspace_id: &str,
    backend_by_id: &HashMap<&str, &RemoteTerminalInfo>,
    frontend_by_id: &HashMap<&str, &Value>,
    notifications: &[Value],
    hidden_pane_ids: &HashSet<String>,
) -> Vec<Value> {
    panes
        .iter()
        .enumerate()
        .map(|(index, pane)| {
            let pane_id = string_field(pane, "id").unwrap_or_default();
            summarize_pane(
                pane,
                index,
                Some(workspace_id),
                "workspace",
                backend_by_id,
                frontend_by_id,
                notifications,
                hidden_pane_ids.contains(pane_id),
            )
        })
        .collect()
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
                        &[],
                        false,
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
    notifications: &[Value],
    hidden: bool,
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
        "profile": terminal_profile(pane, backend, frontend),
        "cwd": terminal_cwd(pane, backend, frontend),
        "branch": terminal_branch(backend, frontend),
        "activity": terminal_activity(backend, frontend),
        "outputActive": frontend.and_then(|terminal| optional_field(terminal, "outputActive")),
        "commandRunning": backend.map(|terminal| terminal.command_running).unwrap_or(false),
        "unreadCount": unread_count(notifications, workspace_id, terminal_id.as_deref()),
        "hidden": hidden,
        "collapsed": hidden,
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
    pane: &Value,
    backend: Option<&RemoteTerminalInfo>,
    frontend: Option<&Value>,
) -> Option<String> {
    backend
        .map(|terminal| terminal.profile.clone())
        .or_else(|| string_field(frontend.unwrap_or(&Value::Null), "profile").map(str::to_string))
        .or_else(|| {
            pane.get("view")
                .and_then(|view| string_field(view, "profile"))
                .map(str::to_string)
        })
}

fn terminal_cwd(
    pane: &Value,
    backend: Option<&RemoteTerminalInfo>,
    frontend: Option<&Value>,
) -> Option<String> {
    backend
        .and_then(|terminal| terminal.cwd.clone())
        .or_else(|| string_field(frontend.unwrap_or(&Value::Null), "cwd").map(str::to_string))
        .or_else(|| {
            pane.get("view")
                .and_then(|view| string_field(view, "lastCwd"))
                .map(str::to_string)
        })
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

fn ordered_workspaces<'a>(
    workspaces: &'a [Value],
    sort_order: &str,
    display_order: &[String],
    notifications: &[Value],
) -> Vec<&'a Value> {
    let mut indexed = workspaces.iter().enumerate().collect::<Vec<_>>();

    if sort_order == "notification" {
        let latest_by_workspace = latest_unread_by_workspace(notifications);
        indexed.sort_by(|(left_index, left), (right_index, right)| {
            let left_id = string_field(left, "id").unwrap_or_default();
            let right_id = string_field(right, "id").unwrap_or_default();
            let left_latest = latest_by_workspace.get(left_id).copied().unwrap_or(0);
            let right_latest = latest_by_workspace.get(right_id).copied().unwrap_or(0);
            right_latest
                .cmp(&left_latest)
                .then_with(|| left_index.cmp(right_index))
        });
        return indexed
            .into_iter()
            .map(|(_, workspace)| workspace)
            .collect();
    }

    if display_order.is_empty() {
        return indexed
            .into_iter()
            .map(|(_, workspace)| workspace)
            .collect();
    }

    let order_index = display_order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<HashMap<_, _>>();
    indexed.sort_by(|(left_index, left), (right_index, right)| {
        let left_id = string_field(left, "id").unwrap_or_default();
        let right_id = string_field(right, "id").unwrap_or_default();
        let left_order = order_index.get(left_id).copied();
        let right_order = order_index.get(right_id).copied();
        match (left_order, right_order) {
            (Some(left_order), Some(right_order)) => left_order
                .cmp(&right_order)
                .then_with(|| left_index.cmp(right_index)),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => left_index.cmp(right_index),
        }
    });
    indexed
        .into_iter()
        .map(|(_, workspace)| workspace)
        .collect()
}

fn latest_unread_by_workspace(notifications: &[Value]) -> HashMap<&str, i64> {
    let mut latest = HashMap::new();
    for notification in notifications {
        if notification
            .get("readAt")
            .is_some_and(|value| !value.is_null())
        {
            continue;
        }
        let Some(workspace_id) = string_field(notification, "workspaceId") else {
            continue;
        };
        let created_at = number_field(notification, "createdAt").unwrap_or_default();
        let entry = latest.entry(workspace_id).or_insert(0);
        if created_at > *entry {
            *entry = created_at;
        }
    }
    latest
}

fn string_set(value: &Value, key: &str) -> HashSet<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn string_vec(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(|item| {
            item.as_i64()
                .or_else(|| item.as_u64().map(|value| value as i64))
        })
        .or_else(|| {
            value.get(key).and_then(|item| {
                item.as_f64().and_then(|value| {
                    if value.is_finite() {
                        Some(value as i64)
                    } else {
                        None
                    }
                })
            })
        })
}

fn unread_count(
    notifications: &[Value],
    workspace_id: Option<&str>,
    terminal_id: Option<&str>,
) -> usize {
    notifications
        .iter()
        .filter(|notification| {
            if notification
                .get("readAt")
                .is_some_and(|value| !value.is_null())
            {
                return false;
            }
            if let Some(workspace_id) = workspace_id {
                if string_field(notification, "workspaceId") != Some(workspace_id) {
                    return false;
                }
            }
            if let Some(terminal_id) = terminal_id {
                if string_field(notification, "terminalId") != Some(terminal_id) {
                    return false;
                }
            }
            true
        })
        .count()
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
            &json!({ "notifications": [] }),
            &json!({ "hiddenWorkspaceIds": [], "hiddenPaneIds": [] }),
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
            &json!({ "notifications": [] }),
            &json!({ "hiddenWorkspaceIds": [], "hiddenPaneIds": [] }),
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

    #[test]
    fn navigation_payload_collapses_hidden_state_and_counts_unread_notifications() {
        let workspaces_data = json!({
            "activeWorkspaceId": "ws-1",
            "workspaces": [
                {
                    "id": "ws-1",
                    "name": "Main",
                    "panes": [
                        { "id": "p1", "view": { "type": "TerminalView" } },
                        { "id": "p2", "view": { "type": "TerminalView" } }
                    ]
                },
                {
                    "id": "ws-hidden",
                    "name": "Hidden",
                    "panes": [
                        { "id": "p3", "view": { "type": "TerminalView" } }
                    ]
                },
                { "id": "ws-visible", "name": "Visible", "panes": [] }
            ]
        });
        let active_workspace_data = json!({
            "workspace": {
                "id": "ws-1",
                "name": "Main",
                "panes": [
                    { "id": "p1", "view": { "type": "TerminalView" } },
                    { "id": "p2", "view": { "type": "TerminalView" } }
                ]
            }
        });
        let notifications = json!({
            "notifications": [
                {
                    "id": "n1",
                    "terminalId": "terminal-p1",
                    "workspaceId": "ws-1",
                    "message": "waiting",
                    "level": "info",
                    "createdAt": 1,
                    "readAt": null
                },
                {
                    "id": "n2",
                    "terminalId": "terminal-p3",
                    "workspaceId": "ws-hidden",
                    "message": "old",
                    "level": "info",
                    "createdAt": 2,
                    "readAt": null
                },
                {
                    "id": "n3",
                    "terminalId": "terminal-p2",
                    "workspaceId": "ws-1",
                    "message": "read",
                    "level": "info",
                    "createdAt": 3,
                    "readAt": 4
                }
            ]
        });
        let ui_state = json!({
            "hiddenWorkspaceIds": ["ws-hidden"],
            "hiddenPaneIds": ["p2"]
        });

        let payload = build_remote_navigation_payload(
            &workspaces_data,
            &active_workspace_data,
            &json!({ "docks": [] }),
            &json!({ "instances": [] }),
            &notifications,
            &ui_state,
            &[],
        );

        let workspace_ids = payload["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|workspace| workspace["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(workspace_ids, vec!["ws-1", "ws-hidden", "ws-visible"]);
        assert_eq!(payload["workspaces"][0]["unreadCount"], 1);
        assert_eq!(payload["workspaces"][1]["hidden"], true);
        assert_eq!(payload["workspaces"][1]["collapsed"], true);
        assert_eq!(payload["unreadNotificationCount"], 2);

        let pane_ids = payload["activeWorkspace"]["panes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pane| pane["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(pane_ids, vec!["p1", "p2"]);
        assert_eq!(payload["activeWorkspace"]["panes"][0]["unreadCount"], 1);
        assert_eq!(payload["activeWorkspace"]["panes"][1]["hidden"], true);
        assert_eq!(payload["activeWorkspace"]["panes"][1]["collapsed"], true);
    }

    #[test]
    fn navigation_payload_matches_workspace_selector_ordering() {
        let base_workspaces = json!([
            { "id": "ws-a", "name": "A", "panes": [] },
            { "id": "ws-b", "name": "B", "panes": [] },
            { "id": "ws-c", "name": "C", "panes": [] }
        ]);
        let active_workspace_data = json!({ "workspace": null });
        let notifications = json!({
            "notifications": [
                { "id": "n1", "workspaceId": "ws-c", "terminalId": "terminal-c", "createdAt": 100, "readAt": null },
                { "id": "n2", "workspaceId": "ws-a", "terminalId": "terminal-a", "createdAt": 200, "readAt": null }
            ]
        });

        let manual_payload = build_remote_navigation_payload(
            &json!({
                "activeWorkspaceId": "ws-a",
                "workspaceDisplayOrder": ["ws-c", "ws-a", "ws-b"],
                "workspaces": base_workspaces
            }),
            &active_workspace_data,
            &json!({ "docks": [] }),
            &json!({ "instances": [] }),
            &notifications,
            &json!({
                "hiddenWorkspaceIds": [],
                "hiddenPaneIds": [],
                "workspaceSelector": { "sortOrder": "manual" }
            }),
            &[],
        );
        let manual_ids = manual_payload["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|workspace| workspace["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(manual_ids, vec!["ws-c", "ws-a", "ws-b"]);

        let notification_payload = build_remote_navigation_payload(
            &json!({
                "activeWorkspaceId": "ws-a",
                "workspaceDisplayOrder": ["ws-c", "ws-a", "ws-b"],
                "workspaces": [
                    { "id": "ws-a", "name": "A", "panes": [] },
                    { "id": "ws-b", "name": "B", "panes": [] },
                    { "id": "ws-c", "name": "C", "panes": [] }
                ]
            }),
            &active_workspace_data,
            &json!({ "docks": [] }),
            &json!({ "instances": [] }),
            &notifications,
            &json!({
                "hiddenWorkspaceIds": [],
                "hiddenPaneIds": [],
                "workspaceSelector": { "sortOrder": "notification" }
            }),
            &[],
        );
        let notification_ids = notification_payload["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|workspace| workspace["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(notification_ids, vec!["ws-a", "ws-c", "ws-b"]);
    }
}
