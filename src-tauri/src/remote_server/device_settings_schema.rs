use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::Value;

pub(super) static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../ui/src/remote/remote-settings-schema.json"
    ))
    .expect("bundled Remote settings schema must be valid JSON")
});

fn valid(field: &Value, value: &Value) -> bool {
    let kind = match field["type"].as_str() {
        Some("boolean") => value.is_boolean(),
        Some("string") => value.is_string(),
        Some("integer") => value.as_u64().is_some(),
        Some("number") => value.as_f64().is_some_and(f64::is_finite),
        Some("array") => value.as_array().is_some_and(|items| {
            field["maxItems"]
                .as_u64()
                .is_none_or(|max| items.len() as u64 <= max)
                && items.iter().all(|item| valid(&field["items"], item))
                && (field["uniqueItems"] != true
                    || items
                        .iter()
                        .enumerate()
                        .all(|(i, item)| !items[..i].contains(item)))
        }),
        Some("object") => value.as_object().is_some_and(|object| {
            field["required"].as_array().is_none_or(|keys| {
                keys.iter()
                    .all(|key| key.as_str().is_some_and(|key| object.contains_key(key)))
            }) && object.iter().all(|(key, value)| {
                field["properties"]
                    .get(key)
                    .is_some_and(|child| valid(child, value))
            })
        }),
        _ => false,
    };
    kind && field["enum"]
        .as_array()
        .is_none_or(|items| items.contains(value))
        && value.as_f64().is_none_or(|number| {
            field["minimum"].as_f64().is_none_or(|min| number >= min)
                && field["maximum"].as_f64().is_none_or(|max| number <= max)
        })
        && value.as_str().is_none_or(|text| {
            let len = text.encode_utf16().count() as u64;
            field["minLength"].as_u64().is_none_or(|min| len >= min)
                && field["maxLength"].as_u64().is_none_or(|max| len <= max)
                && field["pattern"]
                    .as_str()
                    .is_none_or(|pattern| match pattern {
                        "^u-[a-z0-9]{1,24}$" => text.strip_prefix("u-").is_some_and(|id| {
                            !id.is_empty()
                                && id
                                    .bytes()
                                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                        }),
                        "^f-[a-z0-9-]{1,50}$" => text.strip_prefix("f-").is_some_and(|id| {
                            !id.is_empty()
                                && id.bytes().all(|b| {
                                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
                                })
                        }),
                        _ => false,
                    })
        })
}

pub(super) fn prepare(current: &Value, patch: &Value) -> Result<Value, String> {
    let object = patch
        .as_object()
        .ok_or("Remote 설정 patch는 JSON object여야 합니다.")?;
    let mut candidate = current.clone();
    for (key, value) in object {
        let field = SCHEMA["properties"].get(key).ok_or_else(|| {
            format!("알 수 없는 Remote 기기 설정: {key}. describe_remote_settings를 사용하세요.")
        })?;
        if !valid(field, value) {
            return Err(format!("허용되지 않는 Remote 설정값: {key}. 제약: {field}"));
        }
        candidate[key] = value.clone();
    }
    let opacity = |key: &str| candidate[key].as_u64().unwrap_or(0);
    if opacity("composerIdleOpacity") > opacity("composerFocusedOpacity")
        || opacity("composerFocusedOpacity") > opacity("composerActiveOpacity")
    {
        return Err("입력창 불투명도는 idle ≤ focused ≤ active여야 합니다.".into());
    }
    let empty = Vec::new();
    let users = candidate["inputBarUserKeys"].as_array().unwrap_or(&empty);
    let mut user_ids = HashSet::new();
    let mut actions: HashSet<_> = SCHEMA["actionCatalog"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for user in users {
        let id = user["id"].as_str().ok_or("사용자 키 ID 누락")?;
        let label = user["label"].as_str().ok_or("사용자 키 라벨 누락")?;
        if !user_ids.insert(id) || label.trim() != label || label.trim().is_empty() {
            return Err("사용자 키 ID 중복 또는 라벨 공백 오류입니다.".into());
        }
        actions.insert(format!("soft:{id}"));
    }
    let mut placed = HashSet::new();
    for row in ["main", "expanded"] {
        for segment in ["left", "center", "right"] {
            for action in candidate["inputBarZones"][row][segment]
                .as_array()
                .unwrap_or(&empty)
            {
                let id = action.as_str().ok_or("입력바 액션 ID 누락")?;
                if !actions.contains(id) || !placed.insert(id) || (id == "keys" && row != "main") {
                    return Err(format!("입력바 액션 배치 오류: {id}"));
                }
            }
        }
    }
    let mut button_ids = HashSet::new();
    for button in candidate["floatingButtons"].as_array().unwrap_or(&empty) {
        let id = button["id"].as_str().ok_or("플로팅 버튼 ID 누락")?;
        let action = button["actionId"].as_str().ok_or("플로팅 액션 누락")?;
        if !button_ids.insert(id)
            || !actions.contains(action)
            || ["soft:dpad", "soft:navPad"].contains(&action)
        {
            return Err(
                "플로팅 버튼 ID·액션이 올바르지 않습니다. 패드는 전용 설정을 사용하세요.".into(),
            );
        }
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn nested_layout_contract_rejects_unknown_and_duplicate_actions_without_losing_other_keys() {
        let defaults: Value = SCHEMA["properties"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v["default"].clone()))
            .collect();
        assert!(prepare(&json!({}), &defaults).is_ok());
        for patch in [
            json!({"inputBarZones":{}}),
            json!({"floatingButtons":[{"id":"bad"}]}),
            json!({"inputBarUserKeys":[{"id":"u-x","label":" X ","seq":"x"}]}),
            json!({"spatialExcludedPaneIds":["a","a"]}),
            json!({"floatingDpadOpacity":2}),
            json!({"composerHiddenClaudeLines":25}),
        ] {
            assert!(prepare(&defaults, &patch).is_err(), "{patch}");
        }
        let mut zones = defaults["inputBarZones"].clone();
        zones["main"]["center"] = json!(["keys"]);
        assert!(prepare(&defaults, &json!({"inputBarZones":zones})).is_err());
        let candidate = prepare(&defaults, &json!({"inputBarUserKeys":[{"id":"u-x","label":"X","seq":"\u{1b}"}], "floatingButtons":[{"id":"f-x","actionId":"soft:u-x","enabled":true,"size":64,"opacity":0.5,"x":0.5,"y":0.5}]})).unwrap();
        assert_eq!(candidate["inputBarZones"], defaults["inputBarZones"]);
    }
}
