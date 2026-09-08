use serde_json::{json, Map, Value};

use super::{models::Settings, schema::metadata_for_path};
use crate::constants::*;

pub(super) const GUIDE: &str = "먼저 get_settings_context로 사용자의 현재 제어 표면을 확인하세요. 대상 생략 요청은 defaultScope, 명시된 대상은 사용자 지시를 따릅니다. 변경 직전 맥락을 재조회하세요. PC 설정: describe_settings({paths:[\"/section/field\"]})로 의미·허용값 확인 → get_settings로 현재 값과 revision 조회 → validate_settings({patch:{...}}) → valid=true일 때 같은 patch와 expected_revision으로 update_settings → get_settings 재조회. 경로 생략 설명은 섹션 안내이며, schema.properties의 키는 반환되는 JSON Pointer입니다. patch는 JSON Pointer map이 아닌 중첩 객체입니다. 예: {profileDefaults:{font:{size:18}}}, {power:{keepAwake:false,keepAwakeWhenBusy:true}}. 배열은 전체 교체하므로 profiles/keybindings/widgets 배열은 현재 목록을 읽고 다른 항목을 보존하세요. PC 터미널 글꼴은 profileDefaults.font → profiles의 font → pane별 임시 override 순으로 덮어씁니다. appearance.font는 비터미널 본문용이며 메뉴 크기는 조절하지 않습니다. 메뉴 글꼴 family는 appearance.uiFontFamily, 메뉴 크기는 현재 고정입니다. 휴대폰·브라우저 글자 크기/스크롤/입력 설정은 describe_remote_settings/get_remote_settings/validate_remote_settings/update_remote_settings를 사용하세요. remote는 PC의 연결·보안 정책입니다. live=즉시, nextUse=다음 생성/사용, restart=앱 재시작 후. 읽기 전용 구조는 전용 workspace/grid 도구로 변경하세요. widgets는 catalog.widgets의 실제 옵션·기본값을 참고하세요. 입력바·플로팅·숨김 줄 수·기기 탐색 제외는 Remote 기기 도구 대상입니다. 지원하지 않는 키를 추측해 쓰지 마세요.";

pub(super) fn settings_schema() -> Value {
    let mut schema =
        serde_json::to_value(schemars::schema_for!(Settings)).unwrap_or_else(|_| json!({}));
    let cwd_pair = json!({"type":"object", "additionalProperties":false,
    "required":["send","receive"], "properties": {
        "send":{"type":"boolean","description":"이 pane의 CWD 변경을 SyncGroup으로 전송"},
        "receive":{"type":"boolean","description":"SyncGroup CWD 변경을 수신"}
    }});
    for name in ["Profile", "ProfileDefaults"] {
        if let Some(field) = schema.pointer_mut(&format!("/$defs/{name}/properties/syncCwd")) {
            *field = json!({"description":"CWD 동기화. 프로필 → 공통 프로필 → 위치별 기본값 순. default/null은 하위 기본값에 위임.",
                "anyOf":[{"type":"null"},{"type":"string","enum":["default"]},cwd_pair]});
        }
    }
    schema["properties"]["syncCwdDefaults"] = json!({
        "description":"위치별 CWD 동기화 기본값. 프로필 override가 우선. 생략 시 workspace/dock 모두 send=false, receive=true.",
        "anyOf":[{"type":"null"},{"type":"object", "additionalProperties":false,
            "properties":{"workspace":cwd_pair,"dock":cwd_pair}}]
    });
    for (path, values) in [
        ("/properties/language", SETTINGS_LANGUAGES),
        (
            "/$defs/AppearanceSettings/properties/themeId",
            APP_THEME_IDS,
        ),
        (
            "/$defs/TerminalSettings/properties/composerHistoryScope",
            COMPOSER_HISTORY_SCOPES,
        ),
        (
            "/$defs/TerminalSettings/properties/urlLinkActivation",
            LINK_ACTIVATION_MODES,
        ),
        (
            "/$defs/TerminalSettings/properties/pathLinkActivation",
            LINK_ACTIVATION_MODES,
        ),
        (
            "/$defs/PasteSettings/properties/pathSeparator",
            PASTE_PATH_SEPARATORS,
        ),
        (
            "/$defs/ControlBarSettings/properties/defaultMode",
            CONTROL_BAR_MODES,
        ),
        (
            "/$defs/NotificationSettings/properties/dismiss",
            NOTIFICATION_DISMISS_MODES,
        ),
        ("/$defs/UpdateSettings/properties/channel", UPDATE_CHANNELS),
        (
            "/$defs/WorkspaceSelectorSettings/properties/sortOrder",
            WORKSPACE_SORT_ORDERS,
        ),
        (
            "/$defs/WorkspaceSelectorSettings/properties/lastInputMode",
            WORKSPACE_LAST_INPUT_MODES,
        ),
        ("/$defs/WidgetInstance/properties/type", WIDGET_TYPES),
        (
            "/$defs/WidgetsSettings/properties/overflow",
            WIDGET_OVERFLOW_MODES,
        ),
    ] {
        if let Some(field) = schema.pointer_mut(path) {
            field["enum"] = json!(values);
        }
    }
    for name in ["Profile", "ProfileDefaults"] {
        for (field, values) in [
            ("cursorShape", PROFILE_CURSOR_SHAPES),
            ("bellStyle", PROFILE_BELL_STYLES),
            ("closeOnExit", PROFILE_CLOSE_ON_EXIT_VALUES),
            ("antialiasingMode", PROFILE_ANTIALIASING_MODES),
        ] {
            if let Some(target) = schema.pointer_mut(&format!("/$defs/{name}/properties/{field}")) {
                target["enum"] = json!(values);
            }
        }
    }
    for (name, field, min, max) in [
        ("FontSettings", "size", 6.0, 72.0),
        ("TerminalSettings", "scrollSensitivity", 0.1, 20.0),
        ("TerminalSettings", "fastScrollSensitivity", 0.1, 20.0),
        ("WidgetsSettings", "fontSize", 6.0, 20.0),
        ("Profile", "opacity", 10.0, 100.0),
        ("ProfileDefaults", "opacity", 10.0, 100.0),
        ("Profile", "scrollbackLines", 0.0, 999999.0),
        ("ProfileDefaults", "scrollbackLines", 0.0, 999999.0),
        ("TerminalSettings", "pathLinkMaxLength", 8.0, 4096.0),
        ("ExitSettings", "interruptRounds", 1.0, 10.0),
        ("ExitSettings", "settleMs", 0.0, 10000.0),
        ("PaneClearSettings", "interruptRounds", 1.0, 10.0),
        ("PaneClearSettings", "settleMs", 0.0, 10000.0),
        ("FileExplorerSettings", "fontSize", 8.0, 32.0),
        ("ViewerSettings", "fontSize", 8.0, 32.0),
        ("MemoSettings", "indentSize", 1.0, 8.0),
        ("MemoParagraphCopySettings", "minBlankLines", 1.0, 10.0),
        ("RemoteSettings", "attachmentMaxMib", 1.0, 10.0),
        ("PaddingSettings", "top", 0.0, 100.0),
        ("PaddingSettings", "right", 0.0, 100.0),
        ("PaddingSettings", "bottom", 0.0, 100.0),
        ("PaddingSettings", "left", 0.0, 100.0),
    ] {
        if let Some(target) = schema.pointer_mut(&format!("/$defs/{name}/properties/{field}")) {
            target["minimum"] = json!(min);
            target["maximum"] = json!(max);
        }
    }
    schema
}

fn resolve(root: &Value, node: &Value) -> Value {
    if let Some(target) = node
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix('#'))
        .and_then(|pointer| root.pointer(pointer))
    {
        let mut resolved = resolve(root, target);
        if let (Some(object), Some(overrides)) = (resolved.as_object_mut(), node.as_object()) {
            object.extend(
                overrides
                    .iter()
                    .filter(|(key, _)| *key != "$ref")
                    .map(|(key, value)| (key.clone(), resolve(root, value))),
            );
        }
        return resolved;
    }
    match node {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| *key != "$defs")
                .map(|(key, value)| (key.clone(), resolve(root, value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(root, item)).collect()),
        value => value.clone(),
    }
}

fn at_path<'a>(node: &'a Value, segments: &[&str]) -> Option<&'a Value> {
    if segments.is_empty() {
        return Some(node);
    }
    if let Some(property) = node.get("properties").and_then(|p| p.get(segments[0])) {
        return at_path(property, &segments[1..]);
    }
    if segments[0].parse::<usize>().is_ok() {
        if let Some(items) = node.get("items") {
            return at_path(items, &segments[1..]);
        }
    }
    for keyword in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = node.get(keyword).and_then(Value::as_array) {
            if let Some(found) = branches.iter().find_map(|branch| at_path(branch, segments)) {
                return Some(found);
            }
        }
    }
    node.get("additionalProperties").and_then(|additional| {
        if additional == &Value::Bool(true) {
            Some(additional)
        } else {
            at_path(additional, &segments[1..])
        }
    })
}

pub(super) fn select_schema(schema: &Value, paths: &[String]) -> Result<Value, String> {
    let expanded = resolve(schema, schema);
    let mut properties = Map::new();
    if paths.is_empty() {
        if let Some(sections) = expanded["properties"].as_object() {
            for (name, section) in sections {
                let path = format!("/{name}");
                properties.insert(
                    path.clone(),
                    json!({
                        "type": section.get("type"),
                        "description": metadata_for_path(&path).description,
                    }),
                );
            }
        }
    } else {
        for path in paths {
            let decoded: Vec<_> = path[1..]
                .split('/')
                .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
                .collect();
            let segments: Vec<_> = decoded.iter().map(String::as_str).collect();
            let selected = at_path(&expanded, &segments)
                .ok_or_else(|| format!("설정 schema 경로를 찾을 수 없습니다: {path}"))?;
            properties.insert(path.clone(), selected.clone());
        }
    }
    Ok(json!({"type":"object", "properties": properties}))
}

pub(super) fn metadata(schema: &Value, paths: &[String]) -> Result<Value, String> {
    let selected = select_schema(schema, paths)?;
    let mut fields = Map::new();
    if let Some(properties) = selected["properties"].as_object() {
        for (path, schema) in properties {
            collect_metadata(schema, path, &mut fields);
        }
    }
    Ok(Value::Object(fields))
}

fn collect_metadata(node: &Value, path: &str, fields: &mut Map<String, Value>) {
    let mut metadata = json!(metadata_for_path(path));
    if let Some(description) = node.get("description").and_then(Value::as_str) {
        metadata["fieldDescription"] = json!(description);
    }
    fields.insert(path.into(), metadata);
    if let Some(properties) = node.get("properties").and_then(Value::as_object) {
        for (name, child) in properties {
            collect_metadata(child, &format!("{path}/{name}"), fields);
        }
    }
}
