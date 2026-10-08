use super::LocalSessionSnapshot;
use crate::error::AppError;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::constants::SESSION_RESTORE_FIELDS as SESSION_FIELDS;

pub(crate) fn for_each_view(
    value: &mut Value,
    mut visit: impl FnMut(&str, &mut Value) -> Result<(), AppError>,
) -> Result<(), AppError> {
    for kind in ["workspaces", "docks"] {
        for group in value[kind].as_array_mut().into_iter().flatten() {
            for pane in group["panes"].as_array_mut().into_iter().flatten() {
                if pane["layers"]
                    .as_array()
                    .is_some_and(|layers| !layers.is_empty())
                {
                    for layer in pane["layers"].as_array_mut().into_iter().flatten() {
                        let id = layer["id"].as_str().unwrap_or_default().to_owned();
                        visit(&id, &mut layer["view"])?;
                    }
                } else {
                    let id = pane["id"].as_str().unwrap_or_default().to_owned();
                    visit(&id, &mut pane["view"])?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn content_views(
    snapshot: &LocalSessionSnapshot,
) -> Result<Vec<(String, Value)>, AppError> {
    let mut value = serde_json::to_value(snapshot)?;
    let mut views = Vec::new();
    for_each_view(&mut value, |id, view| {
        views.push((id.to_owned(), view.clone()));
        Ok(())
    })?;
    Ok(views)
}

pub(crate) fn preserve_unknown(
    previous: &LocalSessionSnapshot,
    snapshot: &mut LocalSessionSnapshot,
) -> Result<(), AppError> {
    let old: HashMap<_, _> = content_views(previous)?.into_iter().collect();
    let unknown: HashSet<_> = snapshot
        .coverage
        .iter()
        .filter(|c| c.state == "unknown")
        .map(|c| c.terminal_id.as_str())
        .collect();
    let mut value = serde_json::to_value(&*snapshot)?;
    for_each_view(&mut value, |id, view| {
        let fields = view
            .as_object_mut()
            .ok_or_else(|| AppError::Other("Pane view metadata must be an object".into()))?;
        if fields.get("type").and_then(Value::as_str) != Some("TerminalView") {
            for field in SESSION_FIELDS {
                fields.remove(*field);
            }
            return Ok(());
        }
        let previous = old.get(id).filter(|old| {
            old["type"].as_str() == Some("TerminalView")
                && old.get("profile") == fields.get("profile")
                && old.get("configDir") == fields.get("configDir")
        });
        if snapshot.cwd_lookup_failed {
            fields.remove("lastCwd");
            if let Some(cwd) = previous.and_then(|v| v.get("lastCwd")) {
                fields.insert("lastCwd".into(), cwd.clone());
            }
        }
        if unknown.contains(format!("terminal-{id}").as_str()) || snapshot.attribution_lookup_failed
        {
            let fresh = fields
                .get("lastAgentFresh")
                .and_then(Value::as_str)
                .is_some();
            for field in SESSION_FIELDS {
                if fresh && *field == "lastAgentFresh" {
                    continue;
                }
                fields.remove(*field);
                if !fresh {
                    if let Some(value) = previous.and_then(|v| v.get(field)) {
                        fields.insert((*field).into(), value.clone());
                    }
                }
            }
        }
        Ok(())
    })?;
    *snapshot = serde_json::from_value(value)?;
    Ok(())
}
