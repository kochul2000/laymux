use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::settings::contract::{prepare_settings_update, PreparedSettingsUpdate};
use crate::settings::models::Settings;

use super::helpers::bridge_request;
use super::ServerState;

pub type SettingsBridgeError = (StatusCode, Json<Value>);

pub async fn get_settings_snapshot(state: &ServerState) -> Result<Settings, SettingsBridgeError> {
    let data = bridge_request(state, "query", "settings", "getSnapshot", json!({})).await?;
    ensure_frontend_success(&data)?;
    let value = data.get("settings").cloned().ok_or_else(|| {
        error(
            StatusCode::BAD_GATEWAY,
            "프런트 설정 snapshot 응답에 settings가 없습니다.",
            None,
        )
    })?;
    parse_settings_snapshot(value)
}

pub async fn validate_settings_patch(
    state: &ServerState,
    patch: &Value,
) -> Result<(Settings, PreparedSettingsUpdate), SettingsBridgeError> {
    let current = get_settings_snapshot(state).await?;
    let prepared = prepare_settings_update(&current, patch);
    Ok((current, prepared))
}

pub async fn apply_settings_patch(
    state: &ServerState,
    patch: &Value,
    expected_revision: Option<&str>,
) -> Result<PreparedSettingsUpdate, SettingsBridgeError> {
    let _update_guard = state.app_state.settings_update_lock.lock().await;
    let current = get_settings_snapshot(state).await?;
    apply_settings_patch_to_current(state, &current, patch, expected_revision).await
}

pub async fn apply_profile_patch(
    state: &ServerState,
    index: usize,
    patch: &Value,
) -> Result<PreparedSettingsUpdate, SettingsBridgeError> {
    if !patch.is_object() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "profile patch는 JSON object여야 합니다.",
            None,
        ));
    }

    let _update_guard = state.app_state.settings_update_lock.lock().await;
    let current = get_settings_snapshot(state).await?;
    let mut profiles = serde_json::to_value(&current.profiles).map_err(|error_value| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "profile 설정을 직렬화하지 못했습니다.",
            Some(json!({ "cause": error_value.to_string() })),
        )
    })?;
    let profile = profiles
        .as_array_mut()
        .and_then(|items| items.get_mut(index))
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                &format!("profile index {index}를 찾을 수 없습니다."),
                None,
            )
        })?;
    deep_merge(profile, patch);

    apply_settings_patch_to_current(state, &current, &json!({ "profiles": profiles }), None).await
}

async fn apply_settings_patch_to_current(
    state: &ServerState,
    current: &Settings,
    patch: &Value,
    expected_revision: Option<&str>,
) -> Result<PreparedSettingsUpdate, SettingsBridgeError> {
    let mut prepared = prepare_settings_update(current, patch);
    if let Some(expected) = expected_revision {
        if expected != prepared.current_revision {
            return Err(error(
                StatusCode::CONFLICT,
                "설정 revision이 변경되었습니다. get_settings 후 다시 시도하세요.",
                Some(json!({
                    "expectedRevision": expected,
                    "currentRevision": prepared.current_revision,
                })),
            ));
        }
    }
    if !prepared.valid {
        let details = serde_json::to_value(&prepared).unwrap_or_else(|_| json!({}));
        return Err(error(
            StatusCode::BAD_REQUEST,
            "설정 patch 검증에 실패했습니다.",
            Some(details),
        ));
    }

    let candidate = prepared.candidate.take().ok_or_else(|| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "검증된 설정 후보가 없습니다.",
            None,
        )
    })?;
    let data = bridge_request(
        state,
        "action",
        "settings",
        "applySnapshot",
        json!({ "settings": candidate, "expectedSettings": current }),
    )
    .await?;
    ensure_frontend_success(&data)?;
    prepared.candidate = Some(candidate);
    Ok(prepared)
}

fn parse_settings_snapshot(value: Value) -> Result<Settings, SettingsBridgeError> {
    let serialized = serde_json::to_vec(&value).map_err(|error_value| {
        error(
            StatusCode::BAD_GATEWAY,
            "프런트 설정 snapshot을 직렬화하지 못했습니다.",
            Some(json!({ "cause": error_value.to_string() })),
        )
    })?;
    let mut ignored = Vec::new();
    let mut deserializer = serde_json::Deserializer::from_slice(&serialized);
    let settings = serde_ignored::deserialize(&mut deserializer, |path| {
        ignored.push(path.to_string());
    })
    .map_err(|error_value| {
        error(
            StatusCode::BAD_GATEWAY,
            "프런트 설정 snapshot 형식이 올바르지 않습니다.",
            Some(json!({ "cause": error_value.to_string() })),
        )
    })?;
    if !ignored.is_empty() {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            "프런트와 Rust 설정 모델이 일치하지 않습니다.",
            Some(json!({ "unknownSettingsPaths": ignored })),
        ));
    }
    Ok(settings)
}

fn ensure_frontend_success(data: &Value) -> Result<(), SettingsBridgeError> {
    if data.get("success").and_then(Value::as_bool) == Some(false) {
        let message = data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("프런트 설정 요청이 실패했습니다.");
        let status = if message.contains("Settings revision conflict") {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_GATEWAY
        };
        return Err(error(status, message, None));
    }
    Ok(())
}

fn error(status: StatusCode, message: &str, details: Option<Value>) -> SettingsBridgeError {
    let mut body = json!({ "success": false, "error": message });
    if let (Some(object), Some(details)) = (body.as_object_mut(), details) {
        object.insert("details".into(), details);
    }
    (status, Json(body))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_snapshot_parser_rejects_unknown_frontend_fields() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["futureSetting"] = json!(true);

        let (status, Json(body)) = parse_settings_snapshot(value).unwrap_err();
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body["details"]["unknownSettingsPaths"][0], "futureSetting");
    }

    #[test]
    fn profile_patch_merge_keeps_unmentioned_fields() {
        let mut profile = json!({
            "name": "PowerShell",
            "font": { "family": "Cascadia Mono", "size": 12 }
        });
        deep_merge(&mut profile, &json!({ "font": { "size": 15 } }));

        assert_eq!(profile["name"], "PowerShell");
        assert_eq!(profile["font"]["family"], "Cascadia Mono");
        assert_eq!(profile["font"]["size"], 15);
    }

    #[test]
    fn frontend_revision_conflict_maps_to_http_conflict() {
        let (status, Json(body)) = ensure_frontend_success(&json!({
            "success": false,
            "error": "Settings revision conflict: settings changed while saving"
        }))
        .unwrap_err();

        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("revision conflict"));
    }
}
