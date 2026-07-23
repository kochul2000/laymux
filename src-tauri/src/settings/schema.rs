use serde::Serialize;
use serde_json::{json, Map, Value};

use super::contract::ApplyMode;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMetadata {
    pub description: &'static str,
    pub writable: bool,
    pub sensitive: bool,
    pub apply_mode: ApplyMode,
}

struct MetadataEntry {
    path: &'static str,
    description: &'static str,
    sensitive: bool,
    apply_mode: ApplyMode,
}

/// Settings fields owned by dedicated lifecycle APIs rather than generic patches.
///
/// This is also the revision-ignore contract passed to the frontend concurrency guard.
pub const READ_ONLY_SETTINGS_PATHS: &[&str] = &[
    "/workspaces",
    "/layouts",
    "/docks",
    "/workspaceDisplayOrder",
    "/remote/cloudInstanceId",
    "/remote/cloudTunnelUrl",
    "/remote/cloudServerBaseUrl",
];

const ENTRIES: &[MetadataEntry] = &[
    MetadataEntry {
        path: "/language",
        description: "앱 UI 언어. system은 OS 언어를 따르며 ko/en을 직접 선택할 수 있습니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/appearance",
        description: "앱 테마와 터미널 외 UI의 기본 폰트 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/appearance/themeId",
        description: "앱 UI 테마 ID입니다. 터미널 colorScheme과는 별개입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/profiles",
        description: "터미널 프로필 목록입니다. 배열 patch는 목록 전체를 교체합니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/profileDefaults",
        description: "개별 프로필이 덮어쓰지 않은 터미널 기본값입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/defaultProfile",
        description: "새 터미널에 사용할 기본 프로필 이름입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/colorSchemes",
        description: "Windows Terminal 호환 터미널 색상 스킴 목록입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/keybindings",
        description: "재바인딩 가능한 키 조합과 command 목록입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/terminal",
        description: "터미널 렌더링·선택·스크롤 동작 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/paste",
        description: "클립보드와 smart paste 동작 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/controlBar",
        description: "pane control bar의 기본 표시 방식과 idle 동작입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/dock",
        description: "구조적 docks 배열과 별개인 dock 동작 기본값입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/notifications",
        description: "알림을 읽음 처리하는 시점 등 알림 동작 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/workspaceSelector",
        description: "workspace selector 표시·정렬·숨김 터미널 정리 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/claude",
        description: "Claude Code CWD·세션 복원·상태 메시지·자동 resume 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/codex",
        description: "Codex 상태 메시지 표시 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/exit",
        description: "앱 종료 시 터미널에 Ctrl+C를 보내 실행 중인 작업을 정리하고 Claude/Codex가 재개 세션 ID를 출력하도록 유도하는 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/memo",
        description: "MemoView 폰트·여백·문단 복사 동작 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/issueReporter",
        description: "Issue Reporter의 저장소·shell·표시 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/fileExplorer",
        description: "File Explorer 표시와 확장자별 외부 viewer 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/remote",
        description: "Direct Remote와 cloud 연결의 영속 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/bindAddress",
        description: "원격 listener bind 주소입니다. 현재 프로세스에서는 재시작 후 반영됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::Restart,
    },
    MetadataEntry {
        path: "/remote/snapshotMaxKib",
        description: "원격 접속·터미널 전환 시 재생하는 최근 출력 스냅샷 상한(KiB, 1~1024)입니다. 다음 attach부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/authToken",
        description: "Direct Remote browser가 사용하는 bearer token입니다. 응답에는 원문을 노출하지 않으며 ***REDACTED***를 다시 보내면 기존 값을 유지합니다.",
        sensitive: true,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/cloudInstanceId",
        description: "cloud pairing이 발급한 instance ID입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/cloudTunnelUrl",
        description: "cloud pairing이 발급한 WSS tunnel URL입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/cloudServerBaseUrl",
        description: "cloud pairing 응답의 canonical server base URL입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/syncCwdDefaults",
        description: "터미널 위치별 CWD 송수신 기본 정책입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/viewOrder",
        description: "View 선택 UI의 사용자 정의 표시 순서입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/workspaces",
        description: "workspace 구조 상태입니다. 일반 patch 대신 workspace/grid MCP를 사용합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/layouts",
        description: "저장된 layout 구조입니다. 일반 patch 대신 workspace/grid MCP를 사용합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/docks",
        description: "dock pane 구조 상태입니다. 일반 patch 대신 dock MCP를 사용합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/workspaceDisplayOrder",
        description: "workspace 구조의 표시 순서입니다. workspace reorder MCP를 사용합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
];

pub fn metadata_for_path(path: &str) -> FieldMetadata {
    let entry = ENTRIES
        .iter()
        .filter(|entry| path == entry.path || path.starts_with(&format!("{}/", entry.path)))
        .max_by_key(|entry| entry.path.len());

    match entry {
        Some(entry) => FieldMetadata {
            description: entry.description,
            writable: !is_read_only_path(path),
            sensitive: entry.sensitive,
            apply_mode: entry.apply_mode,
        },
        None => FieldMetadata {
            description: "settings.json의 타입화된 설정 필드입니다.",
            writable: !is_read_only_path(path),
            sensitive: false,
            apply_mode: ApplyMode::NextUse,
        },
    }
}

pub fn metadata_json(paths: &[String]) -> Value {
    let selected: Vec<String> = if paths.is_empty() {
        ENTRIES.iter().map(|entry| entry.path.to_string()).collect()
    } else {
        paths.to_vec()
    };
    let mut values = Map::new();
    for path in selected {
        values.insert(path.clone(), json!(metadata_for_path(&path)));
    }
    Value::Object(values)
}

pub fn is_sensitive_path(path: &str) -> bool {
    metadata_for_path(path).sensitive
}

pub fn sensitive_settings_paths() -> impl Iterator<Item = &'static str> {
    ENTRIES
        .iter()
        .filter(|entry| entry.sensitive)
        .map(|entry| entry.path)
}

pub fn is_read_only_path(path: &str) -> bool {
    READ_ONLY_SETTINGS_PATHS
        .iter()
        .any(|read_only| path == *read_only || path.starts_with(&format!("{read_only}/")))
}
