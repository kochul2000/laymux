use super::{atomic_write, read_config, MAX_CONFIG_BYTES, OWNED_DIRECTORY};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::Path};
use toml_edit::{Array, DocumentMut, Item};

const RECORD: &str = "codex-title.json";
const CONFIG: &str = "config.toml";

#[derive(Serialize, Deserialize)]
struct Ownership {
    previous: Option<String>,
    installed: String,
}

fn document(bytes: Option<&[u8]>) -> Result<DocumentMut, String> {
    std::str::from_utf8(bytes.unwrap_or_default())
        .map_err(|e| e.to_string())?
        .parse()
        .map_err(|e| format!("Invalid Codex config.toml: {e}"))
}

fn items(doc: &DocumentMut) -> Result<Option<Vec<String>>, String> {
    let Some(tui) = doc.get("tui") else {
        return Ok(None);
    };
    if !tui.is_table_like() {
        return Err("Codex tui must be a table".into());
    }
    let Some(title) = tui.get("terminal_title") else {
        return Ok(None);
    };
    title
        .as_array()
        .ok_or("Codex terminal_title must be an array")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Codex title items must be strings".into())
        })
        .collect::<Result<Vec<_>, String>>()
        .map(Some)
}

fn configured(items: Option<&[String]>) -> bool {
    items.is_some_and(|v| {
        v.first().is_some_and(|s| s == "app-name")
            && v.get(1)
                .is_some_and(|s| matches!(s.as_str(), "thread-id" | "session-id"))
    })
}

fn read_record(root: &Path) -> Result<Option<Ownership>, String> {
    read_config(&root.join(OWNED_DIRECTORY).join(RECORD))?
        .map(|b| {
            serde_json::from_slice(&b).map_err(|e| format!("Invalid title ownership record: {e}"))
        })
        .transpose()
}

pub(super) fn status(root: &Path) -> Value {
    match (|| {
        let doc = document(read_config(&root.join(CONFIG))?.as_deref())?;
        let current = items(&doc)?;
        let record = read_record(root)?;
        Ok::<_, String>((configured(current.as_deref()), record.is_some()))
    })() {
        Ok((configured, managed)) => {
            json!({"configured":configured,"managed":managed,"warning":null})
        }
        Err(warning) => json!({"configured":false,"managed":false,"warning":warning}),
    }
}

fn serialized_title(doc: &DocumentMut) -> Option<String> {
    let item = doc.get("tui")?.get("terminal_title")?;
    let mut fragment = DocumentMut::new();
    fragment["value"] = item.clone();
    Some(fragment.to_string())
}

fn restore_title(doc: &mut DocumentMut, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        if doc.get("tui").is_none() {
            doc["tui"] = Item::Table(toml_edit::Table::new());
        }
        let fragment = document(Some(value.as_bytes()))?;
        doc["tui"]["terminal_title"] = fragment
            .get("value")
            .ok_or("Invalid title ownership value")?
            .clone();
    } else if let Some(tui) = doc.get_mut("tui").and_then(Item::as_table_like_mut) {
        tui.remove("terminal_title");
    }
    Ok(())
}

pub(super) struct Change {
    original: Option<Vec<u8>>,
    document: DocumentMut,
    ownership: Ownership,
}

pub(super) fn prepare(root: &Path) -> Result<Change, String> {
    let original = read_config(&root.join(CONFIG))?;
    let mut document = document(original.as_deref())?;
    let current_items = items(&document)?;
    let current = serialized_title(&document);
    let ownership = match read_record(root)? {
        // Includes recovery after the ownership record was written but config was not.
        Some(record)
            if current.as_ref() == Some(&record.installed) || current == record.previous =>
        {
            record
        }
        _ => {
            if !configured(current_items.as_deref()) {
                if document.get("tui").is_none() {
                    document["tui"] = Item::Table(toml_edit::Table::new());
                }
                if current_items.is_none() {
                    document["tui"]["terminal_title"] = Item::Value(toml_edit::Value::Array(
                        ["spinner", "project"].into_iter().collect::<Array>(),
                    ));
                }
                let array = document["tui"]["terminal_title"]
                    .as_array_mut()
                    .ok_or("Invalid title array")?;
                // Insert without rebuilding user values: their inner comments and
                // quoting belong to the user, including duplicate custom items.
                array.insert(0, "thread-id");
                array.insert(0, "app-name");
            }
            let installed = serialized_title(&document).ok_or("Missing installed title")?;
            Ownership {
                previous: current,
                installed,
            }
        }
    };
    restore_title(&mut document, Some(&ownership.installed))?;
    if serde_json::to_vec(&ownership)
        .map_err(|e| e.to_string())?
        .len() as u64
        > MAX_CONFIG_BYTES
    {
        return Err("Codex title ownership record is too large".into());
    }
    Ok(Change {
        original,
        document,
        ownership,
    })
}

impl Change {
    pub(super) fn apply(self, root: &Path) -> Result<(), String> {
        let path = root.join(CONFIG);
        if read_config(&path)? != self.original {
            return Err("Codex settings changed concurrently; retry".into());
        }
        let record = root.join(OWNED_DIRECTORY).join(RECORD);
        // The helper installer validated and created this directory under the same lock.
        atomic_write(
            &record,
            &serde_json::to_vec(&self.ownership).map_err(|e| e.to_string())?,
        )?;
        atomic_write(&path, self.document.to_string().as_bytes())
    }
}

pub(super) fn remove(root: &Path) -> Result<(), String> {
    let directory = root.join(OWNED_DIRECTORY);
    if fs::symlink_metadata(&directory).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Title settings retained: helper directory is a symlink".into());
    }
    let Some(record) = read_record(root)? else {
        return Ok(());
    };
    let path = root.join(CONFIG);
    let original = read_config(&path)?;
    let mut doc = document(original.as_deref())?;
    items(&doc)?;
    let current = serialized_title(&doc);
    let changed = current.as_ref() != Some(&record.installed) && current != record.previous;
    if current.as_ref() == Some(&record.installed) {
        restore_title(&mut doc, record.previous.as_deref())?;
        if read_config(&path)? != original {
            return Err("Title settings changed concurrently; retry removal".into());
        }
        atomic_write(&path, doc.to_string().as_bytes())?;
    }
    fs::remove_file(directory.join(RECORD)).map_err(|e| e.to_string())?;
    if changed {
        Err("User-edited Codex terminal_title was retained".into())
    } else {
        Ok(())
    }
}
