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
        path: "/terminal/outputActivityBurst",
        description: "출력 활동(⏳) 감지 임계입니다. 두 검출기는 PTY 생성 시점에 터미널당 하나씩 만들어지므로, 저장 후 새로 생성한 터미널부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/terminal/advertiseTrueColor",
        description: "새 PTY 자식에 truecolor 지원을 광고합니다. 저장 후 새로 생성하거나 재시작한 터미널부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/terminal/scrollSensitivity",
        description: "데스크톱 터미널 마우스 휠 스크롤 배율(0.1~20, 기본 1)입니다. 값이 클수록 한 번 굴릴 때 더 많이 스크롤합니다. 리모트 화면은 각 기기의 로컬 표시 설정이 따로 정합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/terminal/fastScrollSensitivity",
        description: "데스크톱 터미널에서 Alt를 누른 채 휠을 굴릴 때의 스크롤 배율(0.1~20, 기본 5)입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/terminal/pathLinkOsOpenEnabled",
        description: "밑줄 친 경로를 Ctrl+클릭하면 이 PC의 연결 프로그램으로, Ctrl+Shift+클릭하면 파일 관리자에서 열도록 허용합니다. 실행에는 항상 사용자의 로컬 클릭이 필요합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/terminal/pathLinkOsOpenConfirm",
        description: "파일을 연결 프로그램으로 열 때마다 확인합니다. 끄면 확인 범위가 줄어드니 사용자가 직접 요청할 때만 끄십시오. 꺼도 실행 파일·스크립트 등 위험한 확장자는 계속 확인합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/terminal/urlLinkActivation",
        description: "URL 링크를 클릭·탭했을 때의 실행 방식입니다. \"immediate\"(기본)는 즉시 브라우저를 열고, \"chip\"은 링크 옆에 액션 칩을 띄워 사용자가 고른 뒤에만 실행합니다. 즉시 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/terminal/pathLinkActivation",
        description: "검증된 파일·디렉터리 경로 밑줄을 클릭·탭했을 때의 실행 방식입니다. \"immediate\"(기본)는 즉시 뷰어/CWD 이동을 수행하고, \"chip\"은 액션 칩을 띄웁니다. Ctrl / Ctrl+Shift 클릭은 두 모드 모두 칩 없이 호스트 OS 로 직행합니다. 즉시 적용됩니다.",
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
        path: "/usage",
        description: "사용량 모니터(UsageView) 설정입니다. 모니터 대상 에이전트별로 키가 나뉩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/usage/claude",
        description: "Claude Code 사용량 probe 및 UsageView 표시 설정입니다. profile 은 claude 를 실행할 터미널 프로필(빈 값이면 defaultProfile), refreshSeconds 는 rate limit 때문에 600초 미만으로는 적용되지 않습니다, configDirs 는 추가로 모니터링할 CLAUDE_CONFIG_DIR 목록이며 visibleRows 는 표시할 한도 행입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/usage/grok",
        description: "Grok Build 사용량 probe 및 GrokUsageView 표시 설정입니다. profile 은 grok 를 실행할 터미널 프로필(빈 값이면 defaultProfile), refreshSeconds 는 프로세스 비용 때문에 600초 미만으로는 적용되지 않습니다, configDirs 는 추가로 모니터링할 GROK_HOME 목록이며 visibleRows 는 weekly/credits/payg 입니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/widgets",
        description: "상단 바와 status line 의 위젯 배치·공용 표시 설정입니다. fontFamily(빈 값은 인터페이스 글꼴 상속)와 fontSize(6~20px)는 모든 위젯이 공유합니다. topBar/statusLine 각각 left·right 슬롯의 배열 순서가 화면 순서이며, statusLine.enabled 는 하단 영역 표시만 결정합니다(끄더라도 배치는 보존). 각 항목은 { id, type, options } 이고 type 은 등록된 위젯 이름이어야 하며, 사용량 위젯의 barWidth는 8~200px입니다.",
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
        path: "/power",
        description: "OS 절전 방지 설정입니다. 서로 독립인 두 축이며 둘 다 기본값 false 입니다. keepAwake 는 상단 바 버튼이 소유하는 수동 스위치로 터미널 상태와 무관하게 재우지 않습니다. keepAwakeWhenBusy 는 실행 중인 터미널이 있을 때만 재우지 않는 정책입니다. 시스템 절전만 막고 화면 절전은 막지 않습니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/update",
        description: "따라갈 릴리스 채널 설정입니다(ADR-0190).",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/update/channel",
        description: "업데이트를 받아올 채널입니다. stable 은 정식 릴리스만, beta 는 정식보다 먼저 나오는 테스트 릴리스까지 받습니다(기본 \"stable\"). beta 는 안정성이 보장되지 않으며, 한번 올라간 뒤 stable 로 되돌려도 정식이 그 버전을 넘어설 때까지는 업데이트가 없습니다. 채널을 바꾸면 즉시 한 번 확인합니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/workspaceSelector",
        description: "workspace selector 표시·마지막 입력 배치·정렬·파괴적 action 확인·숨김 터미널 정리 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/paneClear",
        description: "포커스된 terminal pane 하나의 activity별 실제 클리어와 busy 처리 정책입니다.",
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
        path: "/claude/command",
        description: "Claude Code 를 실행할 명령입니다(기본 \"claude\"). 플래그를 함께 적을 수 있고(예: \"claude --dangerously-skip-permissions\") 세션 복원은 여기에 `--resume <id>` 를 덧붙입니다. 실행 파일 이름/경로와 플래그만 허용하며 셸 메타문자가 있으면 무시되고 기본 명령이 쓰입니다. 다음 터미널 생성부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/codex",
        description: "Codex 세션 복원, 트랜스크립트 포인터 스크롤, 상태 메시지 표시 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/codex/command",
        description: "Codex CLI 를 실행할 명령입니다(기본 \"codex\"). 플래그를 함께 적을 수 있고(예: \"codex --yolo\") 세션 복원은 여기에 `resume <id>` 를 덧붙입니다. 실행 파일 이름/경로와 플래그만 허용하며 셸 메타문자가 있으면 무시되고 기본 명령이 쓰입니다. 다음 터미널 생성부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/codex/restoreSession",
        description: "앱 시작 시 저장된 Codex 세션 ID를 codex resume로 복원할지 정합니다. 다음 터미널 생성부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/codex/sessionMaxAgeHours",
        description: "Codex 세션 복원 후보 rollout의 최대 수정 경과 시간입니다. 0은 나이 필터를 끕니다. 다음 세션 수집부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/codex/transcriptScrollEnabled",
        description: "normal buffer Codex 트랜스크립트에서 데스크톱 마우스 휠과 Remote 터치/휠 스크롤을 방향키 입력으로 변환할지 정합니다. 즉시 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/grok",
        description: "Grok Build 세션 복원과 상태 메시지 표시 설정입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/grok/command",
        description: "Grok Build 를 실행할 명령입니다(기본 \"grok\"). 플래그를 함께 적을 수 있고 세션 복원은 여기에 `--resume <id>` 를 덧붙입니다. 실행 파일 이름/경로와 플래그만 허용하며 셸 메타문자가 있으면 무시되고 기본 명령이 쓰입니다. 다음 터미널 생성부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/grok/restoreSession",
        description: "앱 시작 시 저장된 Grok 세션 ID를 grok --resume 로 복원할지 정합니다. 다음 터미널 생성부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/grok/sessionMaxAgeHours",
        description: "Grok 세션 복원 후보 summary.json 의 최대 수정 경과 시간입니다. 0은 나이 필터를 끕니다. 다음 세션 수집부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
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
        path: "/viewer",
        description: "File Viewer(열린 파일 내용) 폰트와 여백 기본값입니다. File Explorer 목록 폰트와는 별개입니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/github",
        description: "GitHub 뷰의 기본 탭·폴링 간격·draft PR 표시 설정입니다.",
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
        path: "/remote/tailscaleOnly",
        description: "Direct Remote 요청의 관측 source IP가 Tailscale IPv4(100.64.0.0/10) 또는 IPv6(fd7a:115c:a1e0::/48) 대역이 아니면 거절합니다. 기존 allowedIps 및 bearer token 검사는 함께 유지되고 cloud tunnel 요청에는 적용하지 않습니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/remote/serveTerminalFont",
        description: "데스크톱 터미널 폰트 파일을 원격 브라우저로 전송할지 여부입니다. 폰트 바이너리를 네트워크로 내보내는 것은 재배포이므로 재배포가 허용된 폰트에만 켜세요(Consolas 등 OS 번들 독점 폰트는 허용되지 않습니다). 다음 attach부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/widgets",
        description: "데스크톱에 배치한 위젯을 원격 클라이언트 상단 스트립에도 보여줄지 여부입니다. 배치·옵션은 settings.widgets 하나가 소유하며 이 값은 원격 표면의 표시 여부만 정합니다. 끄더라도 배치는 보존됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::Live,
    },
    MetadataEntry {
        path: "/remote/attachmentMaxMib",
        description: "Remote 클라이언트가 첨부할 수 있는 최대 파일 크기(MiB, 1~10)입니다. 첨부 요청 body 상한, Android E2E RPC envelope 상한, 첨부 캐시 quota(최대 크기의 64배)가 이 값에서 유도됩니다. 다음 첨부부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/attachmentAllowAllExtensions",
        description: "모든 파일 형식을 내용 검사 없이 Remote 첨부로 받을지 여부입니다. 끄면 signature가 확인되는 이미지·PDF·DOCX·PPTX, UTF-8 텍스트, attachmentExtraExtensions만 허용합니다. 다음 첨부부터 적용됩니다.",
        sensitive: false,
        apply_mode: ApplyMode::NextUse,
    },
    MetadataEntry {
        path: "/remote/attachmentExtraExtensions",
        description: "기본 종류 외에 그대로 저장할 확장자 목록입니다(소문자, 점 없이, 영문·숫자 1~16자). 내용 검사 없이 해당 확장자로 저장합니다. 다음 첨부부터 적용됩니다.",
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
