use super::helper_path;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;

const MAX_HELPER_BYTES: u64 = 64 * 1024 * 1024;
const COMPARE_CHUNK_BYTES: usize = 16 * 1024;
mod pe;

fn same_helper(installed: &Path, bundled: &Path) -> Result<bool, String> {
    let metadata = |path: &Path| -> Result<fs::Metadata, String> {
        let meta = fs::symlink_metadata(path)
            .map_err(|e| format!("Could not inspect hook helper: {e}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_HELPER_BYTES {
            return Err("Hook helper must be a bounded regular file".into());
        }
        Ok(meta)
    };
    let installed_meta = metadata(installed)?;
    let bundled_meta = metadata(bundled)?;
    if installed_meta.len() != bundled_meta.len() {
        return Ok(false);
    }
    let mut installed =
        fs::File::open(installed).map_err(|e| format!("Could not read hook helper: {e}"))?;
    let mut source = Vec::new();
    fs::File::open(bundled)
        .map_err(|e| format!("Could not read bundled hook helper: {e}"))?
        .take(MAX_HELPER_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|e| e.to_string())?;
    if source.len() as u64 != bundled_meta.len() {
        return Err("Bundled hook helper changed while being inspected".into());
    }
    let ignored = pe::build_metadata_ranges(&source).unwrap_or_default();
    let mut left = [0; COMPARE_CHUNK_BYTES];
    for (chunk, right) in source.chunks(COMPARE_CHUNK_BYTES).enumerate() {
        let count = right.len();
        installed
            .read_exact(&mut left[..count])
            .map_err(|e| e.to_string())?;
        if left[..count] == *right {
            continue;
        }
        if !left[..count]
            .iter()
            .zip(right)
            .enumerate()
            .all(|(offset, (a, b))| {
                a == b
                    || ignored
                        .iter()
                        .any(|range| range.contains(&(chunk * COMPARE_CHUNK_BYTES + offset)))
            })
        {
            return Ok(false);
        }
    }
    if installed.read(&mut left[..1]).map_err(|e| e.to_string())? != 0 {
        return Err("Installed hook helper changed while being inspected".into());
    }
    Ok(true)
}

pub(super) fn append_status(
    result: &mut Value,
    root: &Path,
    source: &Path,
    current_count: usize,
    commands_current: bool,
) {
    let present = result["helperPresent"] == true;
    let managed = result["ownedCommands"].as_u64().unwrap_or(0) > 0 || present;
    let comparison = present.then(|| same_helper(&helper_path(root), source));
    let current = comparison.as_ref().and_then(|r| r.as_ref().ok()).copied();
    let warning = comparison.and_then(Result::err);
    let mut reasons = Vec::new();
    if managed {
        if !present {
            reasons.push("helper_missing");
        } else if current == Some(false) {
            reasons.push("helper_outdated");
        }
        if !commands_current {
            reasons.push("registrations");
        }
    }
    result["helperCurrent"] = json!(current);
    result["currentRegistered"] = json!(current_count);
    result["updateRequired"] = json!(!reasons.is_empty());
    result["updateReasons"] = json!(reasons);
    result["updateWarning"] = json!(warning);
}
