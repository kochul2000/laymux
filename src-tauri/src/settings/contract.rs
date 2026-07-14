use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::models::Settings;
use super::schema::{is_sensitive_path, metadata_for_path, metadata_json};
use super::semantic_validation;

pub const REDACTED_SETTING_VALUE: &str = "***REDACTED***";

const READ_ONLY_PATHS: &[&str] = &[
    "/workspaces",
    "/layouts",
    "/docks",
    "/workspaceDisplayOrder",
    "/remote/cloudInstanceId",
    "/remote/cloudTunnelUrl",
    "/remote/cloudServerBaseUrl",
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApplyMode {
    Live,
    NextUse,
    Restart,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsIssue {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChange {
    pub path: String,
    pub before: Value,
    pub after: Value,
    pub apply_mode: ApplyMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSettingsUpdate {
    pub valid: bool,
    pub current_revision: String,
    pub candidate_revision: Option<String>,
    pub changes: Vec<SettingsChange>,
    pub errors: Vec<SettingsIssue>,
    pub existing_issues: Vec<SettingsIssue>,
    pub restart_required: bool,
    pub next_use_required: bool,
    #[serde(skip)]
    pub candidate: Option<Settings>,
}

pub fn settings_revision(settings: &Settings) -> String {
    let mut value = serde_json::to_value(settings).unwrap_or_else(|_| json!({}));
    remove_revision_ignored_fields(&mut value);
    let bytes = serde_json::to_vec(&canonicalize_json(value)).unwrap_or_default();
    let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    format!("fnv1a64-{hash:016x}")
}

fn remove_revision_ignored_fields(value: &mut Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };
    for key in ["workspaces", "layouts", "docks", "workspaceDisplayOrder"] {
        root.remove(key);
    }
    if let Some(remote) = root.get_mut("remote").and_then(Value::as_object_mut) {
        for key in ["cloudInstanceId", "cloudTunnelUrl", "cloudServerBaseUrl"] {
            remote.remove(key);
        }
    }
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize_json).collect()),
        Value::Object(object) => {
            let sorted: BTreeSet<String> = object.keys().cloned().collect();
            let mut canonical = Map::new();
            for key in sorted {
                if let Some(value) = object.get(&key) {
                    canonical.insert(key, canonicalize_json(value.clone()));
                }
            }
            Value::Object(canonical)
        }
        primitive => primitive,
    }
}

pub fn redact_settings(settings: &Settings) -> Value {
    let mut value = serde_json::to_value(settings).unwrap_or_else(|_| json!({}));
    redact_value_at_pointer(&mut value, "/remote/authToken");
    value
}

pub fn select_settings_paths(settings: &Settings, paths: &[String]) -> Result<Value, String> {
    let redacted = redact_settings(settings);
    select_paths_from_value(&redacted, paths)
}

pub fn describe_settings(paths: &[String]) -> Result<Value, String> {
    let schema = schemars::schema_for!(Settings);
    let schema_value = serde_json::to_value(&schema).unwrap_or_else(|_| json!({}));
    let defaults = Settings::default();
    let default_values = if paths.is_empty() {
        redact_settings(&defaults)
    } else {
        select_default_paths(&redact_settings(&defaults), &schema_value, paths)?
    };
    Ok(json!({
        "schema": schema,
        "defaults": default_values,
        "metadata": metadata_json(paths),
        "pathFormat": "RFC 6901 JSON Pointer",
        "mergeSemantics": {
            "objects": "recursive merge",
            "arrays": "replace whole array",
            "null": "preserved for nullable fields; rejected for non-nullable fields",
            "redactedSensitiveValue": "***REDACTED*** preserves the existing sensitive value"
        }
    }))
}

pub fn prepare_settings_update(current: &Settings, patch: &Value) -> PreparedSettingsUpdate {
    let current_revision = settings_revision(current);
    let baseline_issues = semantic_validation::validate_settings(current);
    let mut errors = Vec::new();

    if !patch.is_object() {
        errors.push(SettingsIssue {
            code: "type_error".into(),
            path: "/".into(),
            message: "settings patch는 JSON object여야 합니다.".into(),
        });
        return invalid_result(current_revision, errors, baseline_issues);
    }

    collect_read_only_errors(patch, "", &mut errors);
    if !errors.is_empty() {
        return invalid_result(current_revision, errors, baseline_issues);
    }

    let current_value = serde_json::to_value(current).unwrap_or_else(|_| json!({}));
    let mut merged = current_value.clone();
    deep_merge(&mut merged, patch);
    preserve_redacted_sensitive_values(&mut merged, &current_value, patch);

    let serialized = match serde_json::to_vec(&merged) {
        Ok(value) => value,
        Err(error) => {
            errors.push(SettingsIssue {
                code: "serialize_error".into(),
                path: "/".into(),
                message: error.to_string(),
            });
            return invalid_result(current_revision, errors, baseline_issues);
        }
    };
    let mut ignored = Vec::new();
    let mut deserializer = serde_json::Deserializer::from_slice(&serialized);
    let candidate: Settings = match serde_ignored::deserialize(&mut deserializer, |path| {
        ignored.push(ignored_path_to_pointer(&path.to_string()));
    }) {
        Ok(settings) => settings,
        Err(error) => {
            errors.push(SettingsIssue {
                code: "type_error".into(),
                path: "/".into(),
                message: error.to_string(),
            });
            return invalid_result(current_revision, errors, baseline_issues);
        }
    };

    for path in ignored {
        errors.push(SettingsIssue {
            code: "unknown_key".into(),
            message: format!("알 수 없는 설정 키입니다: {path}"),
            path,
        });
    }
    let candidate_value = serde_json::to_value(&candidate).unwrap_or_else(|_| json!({}));
    let mut existing_issues = Vec::new();
    for issue in semantic_validation::validate_settings(&candidate) {
        if issue_is_unchanged_baseline(&issue, &baseline_issues, &current_value, &candidate_value) {
            existing_issues.push(issue);
        } else {
            errors.push(issue);
        }
    }
    if !errors.is_empty() {
        return invalid_result(current_revision, errors, existing_issues);
    }

    let before = serde_json::to_value(current).unwrap_or_else(|_| json!({}));
    let after = serde_json::to_value(&candidate).unwrap_or_else(|_| json!({}));
    let mut changes = Vec::new();
    collect_changes(&before, &after, "", &mut changes);
    let restart_required = changes
        .iter()
        .any(|change| change.apply_mode == ApplyMode::Restart);
    let next_use_required = changes
        .iter()
        .any(|change| change.apply_mode == ApplyMode::NextUse);
    let candidate_revision = settings_revision(&candidate);

    PreparedSettingsUpdate {
        valid: true,
        current_revision,
        candidate_revision: Some(candidate_revision),
        changes,
        errors: Vec::new(),
        existing_issues,
        restart_required,
        next_use_required,
        candidate: Some(candidate),
    }
}

fn invalid_result(
    current_revision: String,
    errors: Vec<SettingsIssue>,
    existing_issues: Vec<SettingsIssue>,
) -> PreparedSettingsUpdate {
    PreparedSettingsUpdate {
        valid: false,
        current_revision,
        candidate_revision: None,
        changes: Vec::new(),
        errors,
        existing_issues,
        restart_required: false,
        next_use_required: false,
        candidate: None,
    }
}

fn issue_is_unchanged_baseline(
    issue: &SettingsIssue,
    baseline_issues: &[SettingsIssue],
    current: &Value,
    candidate: &Value,
) -> bool {
    baseline_issues.iter().any(|baseline| {
        baseline == issue && current.pointer(&issue.path) == candidate.pointer(&issue.path)
    })
}

fn deep_merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                match base_map.get_mut(key) {
                    Some(base_value) => deep_merge(base_value, patch_value),
                    None => {
                        base_map.insert(key.clone(), patch_value.clone());
                    }
                }
            }
        }
        (base_value, patch_value) => *base_value = patch_value.clone(),
    }
}

fn preserve_redacted_sensitive_values(merged: &mut Value, current: &Value, patch: &Value) {
    for path in ["/remote/authToken"] {
        if patch.pointer(path).and_then(Value::as_str) == Some(REDACTED_SETTING_VALUE) {
            if let (Some(target), Some(existing)) =
                (merged.pointer_mut(path), current.pointer(path))
            {
                *target = existing.clone();
            }
        }
    }
}

fn collect_read_only_errors(value: &Value, path: &str, errors: &mut Vec<SettingsIssue>) {
    let Value::Object(map) = value else {
        return;
    };
    for (key, child) in map {
        let child_path = join_pointer(path, key);
        if READ_ONLY_PATHS.contains(&child_path.as_str()) {
            errors.push(SettingsIssue {
                code: "read_only".into(),
                path: child_path,
                message:
                    "이 설정은 전용 Automation/MCP 흐름이 소유하므로 일반 patch로 바꿀 수 없습니다."
                        .into(),
            });
            continue;
        }
        collect_read_only_errors(child, &child_path, errors);
    }
}

fn collect_changes(before: &Value, after: &Value, path: &str, changes: &mut Vec<SettingsChange>) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::Object(before_map), Value::Object(after_map)) => {
            let keys: BTreeSet<&String> = before_map.keys().chain(after_map.keys()).collect();
            for key in keys {
                collect_changes(
                    before_map.get(key).unwrap_or(&Value::Null),
                    after_map.get(key).unwrap_or(&Value::Null),
                    &join_pointer(path, key),
                    changes,
                );
            }
        }
        _ => {
            let effective_path = if path.is_empty() { "/" } else { path };
            let metadata = metadata_for_path(effective_path);
            changes.push(SettingsChange {
                path: effective_path.to_string(),
                before: redact_change_value(effective_path, before),
                after: redact_change_value(effective_path, after),
                apply_mode: metadata.apply_mode,
            });
        }
    }
}

fn redact_change_value(path: &str, value: &Value) -> Value {
    if is_sensitive_path(path) && value.as_str().is_some_and(|value| !value.is_empty()) {
        json!(REDACTED_SETTING_VALUE)
    } else {
        value.clone()
    }
}

fn redact_value_at_pointer(value: &mut Value, path: &str) {
    if let Some(secret) = value.pointer_mut(path) {
        if secret.as_str().is_some_and(|value| !value.is_empty()) {
            *secret = json!(REDACTED_SETTING_VALUE);
        }
    }
}

fn select_paths_from_value(value: &Value, paths: &[String]) -> Result<Value, String> {
    let mut selected = Map::new();
    for path in paths {
        if !path.starts_with('/') {
            return Err(format!("JSON Pointer는 '/'로 시작해야 합니다: {path}"));
        }
        let Some(found) = value.pointer(path) else {
            return Err(format!("설정 경로를 찾을 수 없습니다: {path}"));
        };
        selected.insert(path.clone(), found.clone());
    }
    Ok(Value::Object(selected))
}

fn select_default_paths(
    defaults: &Value,
    schema: &Value,
    paths: &[String],
) -> Result<Value, String> {
    let mut selected = Map::new();
    for path in paths {
        let segments = pointer_segments(path)?;
        if !schema_contains_segments(schema, schema, &segments) {
            return Err(format!("설정 schema 경로를 찾을 수 없습니다: {path}"));
        }
        selected.insert(
            path.clone(),
            defaults.pointer(path).cloned().unwrap_or(Value::Null),
        );
    }
    Ok(Value::Object(selected))
}

fn pointer_segments(path: &str) -> Result<Vec<String>, String> {
    if !path.starts_with('/') {
        return Err(format!("JSON Pointer는 '/'로 시작해야 합니다: {path}"));
    }
    Ok(path[1..]
        .split('/')
        .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
        .collect())
}

fn schema_contains_segments(root: &Value, schema: &Value, segments: &[String]) -> bool {
    if segments.is_empty() || schema.as_bool() == Some(true) {
        return true;
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let Some(target) = reference
            .strip_prefix('#')
            .and_then(|pointer| root.pointer(pointer))
        else {
            return false;
        };
        return schema_contains_segments(root, target, segments);
    }
    for keyword in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = schema.get(keyword).and_then(Value::as_array) {
            if branches
                .iter()
                .any(|branch| schema_contains_segments(root, branch, segments))
            {
                return true;
            }
        }
    }
    if let Some(property) = schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| properties.get(&segments[0]))
    {
        return schema_contains_segments(root, property, &segments[1..]);
    }
    if let Some(items) = schema.get("items") {
        if segments[0].parse::<usize>().is_ok() {
            return schema_contains_segments(root, items, &segments[1..]);
        }
    }
    schema
        .get("additionalProperties")
        .is_some_and(|additional| schema_contains_segments(root, additional, &segments[1..]))
}

fn ignored_path_to_pointer(path: &str) -> String {
    if path.is_empty() {
        return "/".into();
    }
    let normalized = path
        .replace('[', ".")
        .replace(']', "")
        .split('.')
        .filter(|segment| !segment.is_empty())
        .map(escape_pointer_segment)
        .collect::<Vec<_>>()
        .join("/");
    format!("/{normalized}")
}

fn join_pointer(base: &str, segment: &str) -> String {
    format!("{base}/{}", escape_pointer_segment(segment))
}

fn escape_pointer_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}
