# 아키텍처 — 계약 · 규약 · 설계 원칙

> **이 문서는 living doc 이다.** HEAD 의 현재 계약을 반영하며, 모델·REST 경로·tool 이름·설정 키가 코드와 어긋나면 **같은 PR 에서** 갱신한다. 계약은 issue 가 아니라 **코드에서 떠라**.
> 정적 구조는 [overview.md](./overview.md), 런타임 흐름은 [data-flow.md](./data-flow.md), 결정 근거는 [ADR](../adr/) 를 본다.
>
> **이 문서가 담는 범위** — laymux 의 계약과 코드 규약: Settings(settings.json 계약) · Automation API(REST + 내장 MCP tool) · Rust 코드 설계 원칙 · UI 코드 설계 원칙.
> 섹션 번호(§10·§12·§14·§15)는 구 `ARCHITECTURE.md` 기준을 보존한다.

---
## 10. Settings

`settings.json`은 **사용자가 의도적으로 편집·공유하는 구성**만 담는다. 재시작 간 유지돼야 하지만 구성이 아닌 UI 상태(컨트롤 바 모드, 폰트 줌 등)는 localStorage에 저장되는 인스턴스 오버라이드 레이어([overview.md](./overview.md) §4.2)에 들어간다.

### 다국어(i18n) — 언어 설정

UI 다국어는 **react-i18next** 로 구현한다(이슈 #350).

- **설정 키:** `settings.json` 의 최상위 `language: "system" | "ko" | "en"` (Rust `Settings.language: String`, camelCase). 첫 실행 기본값은 `"system"`. serde `#[serde(default = "default_language")]` 로 구버전(키 없음) settings.json 도 `"system"` 으로 파싱된다(하위호환 목적 default 만 유지). 프론트 SSOT 는 `settings-store` 의 `language` 필드 + `setLanguage` 액션.
- **로케일 해석:** `ui/src/i18n/resolve-language.ts` 의 순수 함수 `resolveLanguage(setting, navigatorLang)` 가 단일 진실원. `"system"` 이면 `navigator.language` 가 `ko*` (대소문자 무시)일 때 한글, 그 외/빈 값은 영어로 폴백. `"ko"`/`"en"` 은 그대로. 명시적 시작 모달은 두지 않는다.
- **초기화/동기화:** `ui/src/i18n/index.ts` 가 import 시점에 i18next 를 동기 초기화(resources 번들, `fallbackLng:"ko"`, `interpolation.escapeValue:false`). 실제 언어는 설정 로드 후 `useLanguageSync` 훅이 `language` 변경을 구독해 `applyLanguage()`(→ `i18n.changeLanguage()`)로 적용. `main.tsx` 가 `import "./i18n"` 로 부트.
- **사전 구조:** `ui/src/i18n/locales/{ko,en}.json`. 네임스페이스 `common` · `settings` · `workspace`. 키는 `t("ns:path.to.key")`, 보간은 `{{name}}`.
- **누락 키 감지(dev):** `import.meta.env.DEV` 일 때만 i18next `saveMissing` + `missingKeyHandler` 활성화(`reportMissingKey()` 순수 함수). prod 번들에서는 트리셰이킹으로 제거. `locale-parity.test.ts` 가 ko/en 키 집합 대칭을 강제. 보간 변수는 i18next 예약어 `count` 대신 `num` 등 비예약어를 쓴다(불필요한 복수형 처리·거짓 누락키 경고 회피).
- **현재 번역 범위:** `WorkspaceSelectorView`, `SettingsView`(전체), `SettingsRecoveryModal`, `TerminalView`(붙여넣기 확인·스크롤 버튼). 나머지 뷰의 하드코딩 영어 라벨까지 ko 로 보이게 하는 완전 양방향 번역은 후속 작업.
- **번역 용어 정책(글로사리):** ko 값은 (1) 자연스러운 한국어 우선(모양/커서/여백/불투명도/선택 시 복사 등), (2) 굳어진 IT 외래어는 음차(폰트·프로필·워크스페이스·독·테마), (3) 영어 유지 = ANSI 색상명(Black/Red/…)·브랜드/표준/포맷 고유명사(Claude Code·Codex·ANSI·ClearType·Grayscale·Aliased·settings.json)·제품 약어(Pane·CWD·Git). 외래어 표기는 국립국어원 기준(프로필/셸/디렉터리). 제목과 설명문은 같은 개념을 동일 용어로 표기한다. en 값은 일관된 Title Case.

### 접근 방법

- 모달로 열기 (기본)
- SettingsView를 Dock에 배치하여 열기 (선택, Dock only)
- `settings.json` 직접 텍스트 편집

### Direct Remote Mode 설정

브라우저 원격 접속은 명시적 opt-in 설정이다. 기본값은 꺼짐이며, remote API는 Automation API/MCP의 IP allowlist와 별도 인증/Origin/IP 정책을 사용한다([ADR-0013](../adr/0013-direct-remote-mode.md)).

활성화에는 두 경로가 있다([ADR-0016](../adr/0016-remote-access-runtime-vs-startup-enable.md)).

- **이번 실행 동안 허용**: Remote Access 모달에서 켜는 런타임 상태다. `AppState` 에만 저장되며 앱 종료 시 사라지고 `settings.json` 에 기록하지 않는다.
- **시작 시 자동 허용**: `settings.remote.enabled` 를 `true` 로 저장하는 영속 설정이다. 다음 실행부터 remote entry 가 처음부터 열린다.

remote 의 실효 활성화 상태는 `settings.remote.enabled || runtimeRemoteAccess.enabled` 로 계산한다. 토큰은 `settings.remote.authToken` 을 우선 사용하고, 이 값이 비어 있을 때만 런타임 허용 토큰을 사용한다. IP allowlist, Origin 정책, heartbeat timeout 은 `settings.remote` 계약을 따른다.

Remote Access 모달은 런타임 성격의 조작만 담당한다: 이번 실행 동안 허용, URL/token 복사, 데스크톱 앱 내부 모바일 모드 열기, remote controller reclaim. 시작 시 자동 허용, IP allowlist, 자동 모바일 폭, 수동 호스트 목록, 기본 호스트 같은 영속 설정은 Settings → Remote 섹션에서 편집하며 기존 settings store → `persistSession()` → `save_settings` 경로로 `settings.json` 에 저장된다. 데스크톱 앱 내부의 모바일 모드는 기존 `/remote/` Direct Remote UI를 `localApp=1&autoConnect=1` iframe으로 여는 로컬 전용 표시 모드이며, 외부 브라우저 지원을 새로 의미하지 않는다. 해당 iframe은 remote lease를 잡을 수 있으므로 PC WebView의 remote-control overlay는 로컬 모바일 모드가 활성인 동안 숨긴다.

Remote Access 모달의 복사 URL 호스트는 `get_remote_host_candidates` Tauri IPC command가 반환하는 감지 후보와 `settings.remote.customHosts` 를 프론트엔드가 병합해 만든다([ADR-0021](../adr/0021-remote-host-candidate-discovery.md)). 감지 후보는 항상 loopback `127.0.0.1` 을 포함하고, 사용 가능하면 Tailscale IPv4/IPv6 주소와 LAN interface 주소를 추가한다. `settings.remote.preferredHost` 가 후보 목록에 있으면 URL host select 의 초기값으로 쓰고, 빈 문자열이면 첫 후보를 자동 선택한다. IPv6 host 는 복사 URL에서 `http://[addr]:port/...` 형태로 bracket 처리한다. 이 후보 목록은 URL 작성 편의용일 뿐이며 실제 접속 허용 여부는 계속 `settings.remote.allowedIps`, bearer token, Origin 정책이 결정한다.

```jsonc
{
  "remote": {
    "enabled": false,                  // 시작 시 자동 허용 여부. 기본값: 비활성화
    "bindAddress": "0.0.0.0",          // 현재 구현은 Automation 서버 listener를 공유
    "allowedOrigins": [],              // 비어 있으면 Origin 필터 없음, 값이 있으면 Origin 일치 검사
    "allowedIps": ["127.0.0.1/32", "::1/128"],
    "authToken": "",                   // enabled=true일 때 필수
    "heartbeatTimeoutSeconds": 45,      // 기본 45초, 최소 30초로 clamp
    "autoMobileModeMinWidth": 720,      // 앱 창 폭이 이 값 이하이면 Remote Access 모달 자동 표시. 0 = 비활성
    "snapshotMaxKib": 16,               // 원격 attach 시 재생하는 최근 출력 스냅샷 상한(KiB). 1~1024로 clamp, 절단 시 개행 경계로 정렬
    "preferredHost": "",               // 복사 URL 기본 호스트. 빈 값 = 자동
    "customHosts": [],                  // 감지 후보 외에 URL host select 에 표시할 수동 호스트
    "cloudEnabled": false,              // 클라우드 연결 영속 설정. pairing 전 기본값 false
    "relayBaseUrl": "https://app.laymux.com",  // 기본값: release=https://app.laymux.com, dev(debug)=http://127.0.0.1:8000. 설정에서 변경 가능
    "cloudInstanceId": null,            // relay가 발급한 instance id. 미연결이면 null
    "cloudTunnelUrl": null,             // pairing complete 응답의 WSS tunnel URL. PR3 터널에서 사용
    "cloudServerBaseUrl": null,         // pairing complete 응답의 canonical server base URL
    "cloudAutoReconnect": true          // 원격 제어가 켜져 있고 토큰이 있으면 시작 시 WSS tunnel 자동 재연결
  }
}
```

클라우드 연결은 Direct Remote Mode와 additive 관계다([ADR-0022](../adr/0022-cloud-connection-foundation.md), [ADR-0023](../adr/0023-cloud-pairing-loopback-oauth.md), [ADR-0024](../adr/0024-cloud-native-wss-tunnel.md)). Tauri IPC 계약은 `get_cloud_status() -> { connected, instanceId, lastError }`, `cloud_connect_start() -> CloudStatus`, `cloud_disconnect() -> CloudStatus` 다. `cloud_connect_start` 는 `relayBaseUrl` 의 `/pair/desktop` 으로 시스템 브라우저를 열고, `http://127.0.0.1:<ephemeral>/pair/callback` loopback callback 에서 code/state 를 수신한 뒤 `/api/desktop/pair/complete` 로 device token을 교환한다. redirect URI는 `http`, host `127.0.0.1`, path `/pair/callback`, fragment/userinfo 없음으로 고정한다. pairing 성공 후 device token은 `settings.json` 에 저장하지 않고 OS keyring service `laymux`(`debug_assertions` 빌드는 `laymux-dev`), account `device-token` 에 저장한다. `settings.remote` 에는 `cloudEnabled=true`, `cloudInstanceId`, `cloudTunnelUrl`, `cloudServerBaseUrl`, `relayBaseUrl` 만 저장한다.

Pairing 성공 후와 앱 시작 시(원격 제어가 실효적으로 켜져 있고 `cloudAutoReconnect=true`이며 keyring token이 존재할 때) desktop은 `cloudTunnelUrl` 로 native Rust WSS outbound tunnel을 연다. WSS 접속에는 `Authorization: Bearer <device-token>` 를 사용한다. 터널 연결 수명주기는 원격 제어 게이트(`settings.remote.enabled || runtimeRemoteAccess.enabled`)에 종속된다([ADR-0030](../adr/0030-cloud-tunnel-follows-remote-control-gate.md)): 게이트가 꺼져 있으면 터널을 열지 않아 relay에 online으로 보고하지 않고 인스턴스가 대시보드에 노출되지 않는다. `set_remote_runtime_access` 로 게이트가 꺼지면 살아 있는 터널을 즉시 종료하고(`connected=false`, instance id는 유지) 다시 켜지면 재접속한다. `cloud_connect_start` 도 게이트가 꺼져 있으면 브라우저를 열거나 relay에 접속하기 전에 거절하고 `lastError` 를 남긴다 — 원격 제어가 꺼진 상태에서는 클라우드에 어떤 액션도 하지 않는다. relay가 첫 `ready` frame 또는 이후 `heartbeat.ack` frame으로 `{ instanceId }` 를 보내면 `AppState.cloud.connected=true` 와 instance id를 갱신하고, socket이 끊기면 `connected=false` 로 전환한 뒤 지수 backoff로 재접속한다. 단, relay가 4001 또는 401 계열 인증 실패 close를 보내거나 WSS handshake가 401로 실패하면 자동 재접속을 중단하고 재-pair가 필요한 `lastError` 를 남긴다. `cloud_disconnect` 는 tunnel worker를 중지하고 keyring token 삭제, cloud 저장 필드 정리, `AppState.cloud` 리셋을 best-effort 로 수행한다.

Tunnel M5 frame은 text JSON `{ stream_id, type, payload }` 를 사용한다. `stream.open{kind:"http.request"}` 는 후속 `stream.data` base64 body를 모아 `remote_server::build_router(ServerState).with_state(ServerState)` 로 내부 `oneshot` dispatch 한다. 이 내부 request에는 `ConnectInfo(127.0.0.1:0)`와 크레이트 내부 전용 `TunnelAuthorized` request extension을 삽입한다. `TunnelAuthorized` 요청은 WSS device token으로 transport 인증을 마친 요청이므로 bearer token, IP allowlist, Origin 검사를 우회하지만, 사용자 제어권 토글인 enabled gate는 계속 요구한다. 나아가 터널 연결 성립 자체가 같은 게이트를 따르므로(위 문단, [ADR-0030](../adr/0030-cloud-tunnel-follows-remote-control-gate.md)), `settings.remote.enabled || runtimeRemoteAccess.enabled` 가 false인 동안에는 요청이 도달하기 전에 터널이 존재하지 않는다. `/remote`, `/remote/`, `/remote/vendor/*`처럼 `remote_guard` middleware 밖에 있는 page/vendor route도 같은 정책을 적용한다. 터널은 `set_remote_runtime_access` 를 호출하지 않으므로 cloud 연결만으로 로컬 TCP `/remote` listener가 열리거나 persistent `settings.remote.authToken` 이 재활성화되지 않는다. 외부 `Authorization` 및 hop-by-hop header는 전달하지 않는다. 응답은 `stream.open{kind:"http.response",status,headers}` + `stream.data` + `stream.close` 로 relay에 돌려준다. HTTP stream은 request `stream.close` 이후에도 response `stream.close` 또는 `stream.error` 가 끝날 때까지 active map에 `Responding` 상태로 남아 stream id, active stream slot, socket pending bytes를 예약한다. response task completion은 stream id와 response generation id가 현재 `Responding` entry와 모두 일치할 때만 stream을 정리하며, cancel 후 재open된 stream에 도착한 stale completion은 무시한다. `stream.open{kind:"websocket"}` 중 `/remote/v1/terminals/{id}/output` 은 generation-scoped output session에 bounded subscriber를 먼저 등록한 뒤 같은 락 구간에서 protocol-state/output-ring snapshot을 캡처하고, subscriber delta 수신과 500ms lease 재검증을 수행한다. desktop은 같은 `srv-*` stream id로 `stream.open{kind:"websocket.accept",outputProtocol:"laymux-terminal-output.v1",attachState}` 를 먼저 보내고, snapshot을 포함한 각 output payload를 `stream.data{encoding:"base64",data,output:{version,phase,seqStart,seqEnd,byteLength}}`로 보낸다. 빈 snapshot도 metadata와 빈 data frame을 보내며 새 bytes가 없을 때는 delta frame을 만들지 않는다. ring gap은 clamp하지 않고 retryable `terminal_output_gap` stream error로 종료한다. Active stream 수, per-stream queue/body, socket 전체 pending body 한계를 넘으면 `stream.error` 로 종료한다. Malformed frame은 연결을 끊지 않고 stream id가 식별되면 해당 stream에 `stream.error` 를 보내며, 식별할 수 없으면 경고 후 무시한다.

Tailscale 직접 접속을 허용하려면 `allowedIps`에 Tailnet 범위(예: IPv4 `100.64.0.0/10`, IPv6 `fd7a:115c:a1e0::/48`) 또는 구체적인 peer IP/CIDR를 추가하고 `authToken`을 설정한다. Tailscale은 transport 격리일 뿐 인증을 대체하지 않는다.

### Windows Terminal 호환 항목

| 항목 | 설명 |
|---|---|
| `colorSchemes` | 색상 스킴 정의 |
| `profiles` | 터미널 프로파일 (WSL, PowerShell 등) |
| `keybindings` | 키 바인딩 |
| `font.face` / `font.size` | 폰트 설정 (프로파일별 오버라이드, profileDefaults에서 상속) |
| `defaultProfile` | 기본 프로파일 |

우리가 구현한 기능과 교집합이 되는 항목만 호환. Windows Terminal의 settings.json을 복붙했을 때 해당 항목은 동일하게 동작한다.

### File Explorer 외부 뷰어 설정

`settings.fileExplorer.extensionViewers`의 각 항목은 `{ extensions: string[], command: string, profile: string }` 계약을 사용한다. `profile`은 `settings.profiles[].name`을 명시적으로 참조하며 파일 경로나 기본 profile로 추론하지 않는다. 이전 설정의 역직렬화 호환을 위해 Rust serde는 누락된 `profile`을 빈 문자열로 읽지만, Settings UI와 실행 경로는 빈 값 또는 삭제·변경된 profile 참조를 명시 오류로 표시한다. 내부 개발 단계 정책에 따라 자동 마이그레이션은 제공하지 않는다([ADR-0031](../adr/0031-extension-viewer-profile-path-conversion.md)).

```jsonc
{
  "fileExplorer": {
    "extensionViewers": [
      { "extensions": [".md", ".markdown"], "command": "vi", "profile": "WSL" },
      { "extensions": [".log"], "command": "notepad", "profile": "PowerShell" }
    ]
  }
}
```

### Claude Code 설정

Claude Code 관련 동작(sync-cwd 전파, 세션 복원, 셀렉터 상태 메시지 구성, 세션 리미트 자동 복귀)을 제어한다.

```jsonc
{
  "claude": {
    "syncCwd": "skip",                   // "skip" (기본) | "command"
    "restoreSession": true,              // 앱 재시작 시 Claude 실행 중이던 pane을 `claude --resume <id>`로 재개 (기본 true)
    "sessionMaxAgeHours": 24,            // 이보다 오래된 세션은 복원 제외 (0 = 나이 필터 해제, 기본 24)
    "statusMessageMode": "bullet-title", // 셀렉터 상태 메시지 구성: "bullet" | "title" | "title-bullet" | "bullet-title"
    "statusMessageDelimiter": " · ",     // bullet·title 병기 시 구분자
    "sessionLimitAutoResume": true,      // 세션 리미트 reset 시각 이후 복귀 메시지 자동 전송 (기본 true)
    "sessionLimitResumeDelaySeconds": 60, // reset 시각 이후 대기 시간(초, 기본 60)
    "sessionLimitResumeMessage": "go on" // 복귀 시 전송할 메시지 (기본 "go on", 제출은 단독 CR)
  }
}
```

`restoreSession`/`sessionMaxAgeHours` 는 세션 영속([data-flow.md §13](./data-flow.md)) 복원 시 startup command 를 `claude --resume` 으로 대체하는 경로를 제어하고, `statusMessageMode`/`statusMessageDelimiter` 는 WorkspaceSelectorView 의 Claude 상태 메시지([data-flow.md §9](./data-flow.md)) 구성을 제어한다. `sessionLimit*` 3종은 세션 리미트 배너(`You've hit your session limit · resets <time>`) 감지 후 자동 복귀([data-flow.md](./data-flow.md) "세션 리미트 자동 복귀") 를 제어한다. 이하는 `syncCwd` 상세.

| 모드 | 동작 |
|---|---|
| `skip` | Claude Code 감지 시 cd 전파하지 않음 (기본값) |
| `command` | Claude Code가 유휴(idle) 상태일 때 `! cd /path` 형식으로 전송 |

**감지 방식 (타이틀 접두사 기반)**:

Claude Code 실행 여부는 **터미널 타이틀(OSC 0/2)의 접두사**로 판단한다. Claude Code는 타이틀을 다음 패턴으로 설정한다:

| 상태 | 타이틀 패턴 | 예시 |
|------|------------|------|
| 초기 진입 | `"Claude Code"` 문자열 포함 | `Claude Code` |
| 유휴 (idle) | `✳` (U+2733) 접두어 | `✳ Claude Code` |
| 작업 중 | 스피너 문자 접두어 (`✶✻✽✢` 또는 Braille U+2800..U+28FF) | `✢ Working on task`, `⠐ Task description` |

**종료 판단**: 타이틀에 `"Claude Code"` 문자열이 없고 **동시에** 스피너 접두사 문자(`✶✻✽✢✳` 또는 Braille 패턴 U+2800..U+28FF)로도 시작하지 않을 때만 Claude Code가 종료된 것으로 판단한다. Claude Code v2.1+는 Braille 문자(`⠂⠐⠋⠙` 등)를 애니메이션 스피너로 사용한다. 스피너 접두사만 있는 타이틀(예: `✢ Working`, `⠐ Task`)은 여전히 Claude Code 실행 중이다.

**`known_claude_terminals` 폴백**: 최초 `"Claude Code"` 타이틀 감지 시 `known_claude_terminals` 집합에 등록한다. 이후 스피너 타이틀이 오더라도 이 집합에 있으면 `interactiveApp: "Claude"`를 유지한다. 종료 판단 시에만 집합에서 제거한다.

**`! cd` 형식**: Claude Code는 프롬프트에서 `! <shell_command>` 구문으로 인라인 셸 실행을 지원. `command` 모드에서는 이 형식으로 cd를 전달하며, `LX_PROPAGATED` 래핑이 불필요하다.

### CWD 동기화 기본값

위치(workspace/dock)별로 CWD sync의 send/receive 기본값을 설정한다. 프로파일별 오버라이드도 지원한다.

**해상도 우선순위** (높은 순):
1. 개별 프로파일 `syncCwd`
2. `profileDefaults.syncCwd`
3. 위치별 `syncCwdDefaults` (workspace / dock)

값이 `"default"`이면 다음 단계로 위임한다.

```jsonc
{
  "syncCwdDefaults": {
    "workspace": { "send": false, "receive": false },  // 기본값
    "dock": { "send": false, "receive": false }        // 기본값
  },
  "profileDefaults": {
    "syncCwd": "default"    // "default" | { "send": bool, "receive": bool }
  },
  "profiles": [
    { "name": "WSL", "syncCwd": "default" },
    { "name": "Monitor", "syncCwd": { "send": false, "receive": false } }
  ]
}
```

per-pane `cwdSend`/`cwdReceive` 오버라이드는 cascade 결과보다 우선한다.

### CWD 전파 가드: 소스 activity 조건

OSC 7은 일부 셸(예: PowerShell의 `prompt` 함수)이 프롬프트가 재렌더될 때마다 재발행한다. 이 경우 interactive TUI 앱(OpenAI Codex, Claude Code, vim 등)이 활성 상태에서도 OSC 7이 흘러나올 수 있다. 또한 비대화형 명령이 실행 중일 때(`Running`)도 명령 자체가 OSC 7을 발행할 수 있다. 두 경우 모두 사용자가 직접 실행한 `cd`의 결과가 아니므로 그룹 터미널로 전파하지 않는다.

`do_sync_cwd`는 다음 순서로 가드를 통과해야만 전파를 진행한다:

1. `is_propagated` — 최근 전파된 터미널(에코 루프)인지
2. **소스 activity가 `Shell`인지** (= `Running` 또는 `InteractiveApp`이 아닌지)
3. `cwd_send` 플래그가 켜져 있는지
4. 대상 필터링(`cwd_receive`, 대상 activity, Claude 모드, 동일 CWD 중복)

2번 가드는 `detect_terminal_state`(= activity + 영구 추적 `known_claude_terminals`/`known_codex_terminals`)가 `TerminalActivity::Shell`이 아닌 모든 상태(`Running`, `InteractiveApp { .. }`)를 거짓으로 평가한다. `detect_terminal_activity`만으로는 Codex 스피너(브레일 문자) 타이틀이나 Claude Code 작업 타이틀처럼 `INTERACTIVE_APP_PATTERNS`에 직접 매칭되지 않는 상태를 놓치므로, 반드시 영구 추적을 경유하는 `detect_terminal_state`를 사용한다. 가드가 차단 판정하면 session.cwd 로컬 업데이트도 건너뛴다(스테일/실행 중 값을 후속 전파가 재사용하지 못하도록). `Shell`만 신뢰하는 이유는, OSC 7이 사용자 의도의 `cd`를 반영하는 시점은 셸이 프롬프트를 다시 그린 직후 — 즉 `OSC 133;D` 이후 — 뿐이기 때문이다.

**대상 필터링 (`filter_targets_not_busy`)**도 동일한 `detect_terminal_state`로 판정한다 (#239):

| 대상 activity | 처리 |
|---|---|
| `InteractiveApp { name: "Claude" }` | `claude.syncCwd`에 따름 — `skip`이면 제외, `command`이면 idle일 때만 `! cd '/path'` 주입 |
| `InteractiveApp { name: other }` (vim/codex/nvim...) | 제외 — `LX_PROPAGATED=1 cd`가 TUI 입력 버퍼에 타이핑되는 것을 방지 |
| `Running` | 제외 — 명령 실행 중 |
| `Shell` | 포함 — `cd` 전파 |

기존에는 대상 판정을 `is_claude_terminal_from_buffer` + `is_terminal_at_prompt_from_buffer` 조합으로 수행했지만, Claude 타이틀이 스캔 윈도우를 벗어나거나 `known_claude_terminals` 등록이 지연되면 누락이 발생했다. `detect_terminal_state`로 통일하여 모든 감지 경로(제목 패턴, 영구 추적, 전체 버퍼 스캔)가 한 곳에서 평가된다.

#### 1회성 CWD 전파 (`force` 경로, issue #293)

`do_sync_cwd`는 `force: bool` 인자를 받는다. 평소 동기화를 꺼둔 file explorer/viewer 등을 *지금 이 순간의* CWD로 한 번만 따라오게 만드는 것이 목적이다.

프론트 진입점은 두 가지로, 모두 `propagateCwdOnceForPane()`(`ui/src/lib/propagate-cwd-once.ts`) 한 경로를 거친다 (issue #324): ① 컨트롤 패널의 "Propagate CWD once" 버튼(좌측, pane 번호 배지 우측), ② `pane.propagateCwdOnce` 키바인딩(기본 `Ctrl+Alt+P`, 포커스 pane 대상 — Settings Keybindings UI에서 재바인딩 가능).

**소스가 무엇이냐에 따라 트리거 경로가 갈린다 (issue #293 리뷰 반영):**

- **TerminalView 소스** — 컨트롤 패널 버튼이 `propagate_cwd_once` 커맨드를 `terminal-${paneId}`로 호출 → `do_sync_cwd(force=true)`. 터미널은 PTY 세션이 있어 `session.cwd`를 백엔드가 안다.
- **FileExplorerView 소스** — file explorer는 PTY 세션이 없어 `propagate_cwd_once`가 `Session not found`로 실패한다(무음 no-op이었던 버그). 따라서 버튼은 백엔드 커맨드를 호출하지 않고, 프론트 요청 버스(`cwd-propagate-store`)를 통해 `FileExplorerView`가 자신이 아는 `currentCwd`로 `handleLxMessage({action:"sync-cwd", force:true})`를 직접 디스패치한다. `LxMessage::SyncCwd`는 `force: bool` 필드를 받는다(`lx` CLI는 항상 false).

`force=true`는 **소스 측 게이트만 우회**한다 — 위 가드 목록의 1(에코 루프), 2(소스 activity=Shell), 3(`cwd_send`). 즉 사용자가 직접 누른 명시적 의도이므로, 소스 측 자동 전파의 노이즈 차단 게이트는 적용하지 않는다.

**대상 측 게이트는 `force` 여부와 무관하게 항상 유지한다.** 여기에는 `filter_targets_not_busy`(`Running`/`InteractiveApp` 제외 — 입력 버퍼 오염 방지), `filter_targets_needing_cd`(동일 CWD 중복 제외), 그리고 **`filter_targets_cwd_receive`(각 대상의 `cwd_receive` 의사 존중)**가 포함된다. `cwd_receive`는 그 pane(특히 dock pane)이 "나는 CWD를 받지 않겠다"고 선언한 것이므로 force 1회 전파라도 존중해야 한다(**issue #375**). 옛 동작(issue #293)은 force 시 `cwd_receive` 필터를 우회했으나, dock 등 receive=off pane에도 강제 전파해 사용자 의사를 무시하는 버그가 되었다. 이제 force/non-force가 동일한 대상 필터 경로(`filter_targets_cwd_receive`)를 거친다.

**대상이 file explorer일 때의 추종(프론트 경로).** file explorer의 CWD 추종은 백엔드 `cd` 주입이 아니라 순수 프론트 경로다. `FileExplorerView`는 이벤트 리스너를 항상 등록하되 두 이벤트 모두 자신의 `cwdReceive` 게이트 뒤에서 처리한다: ① `terminal-cwd-changed`(일반 OSC 변경)는 `cwdReceive on` + 소스 `cwdSend !== false`일 때만 추종, ② `sync-cwd` 페이로드의 `force === true`이고 `groupId`가 자신의 syncGroup과 같으면 추종하되 **`cwdReceive`가 off면 force라도 무시**한다(백엔드 `filter_targets_cwd_receive`와 동일한 정책 — issue #375). `do_sync_cwd`는 `EVENT_SYNC_CWD` 페이로드에 `force`를 실어 보낸다.

`propagate_cwd_once`는 소스 터미널의 `session.cwd`가 비어 있으면(OSC 7 미발행) no-op으로 `Ok`를 돌려준다. 세션 자체가 없으면(`file-explorer-${paneId}`) `resolve_propagate_source`가 `Err`를 반환하므로, file explorer 소스는 위 프론트 경로로만 전파한다.

**상태 갱신·이벤트 대상 = `arrived` = `written ∪ already_at_cwd` (3차 리뷰 P1, issue #296).** `do_sync_cwd`가 backend `session.cwd`를 갱신하고 `EVENT_SYNC_CWD.targets`에 싣는 집합은 "실제로 목적 CWD에 도착이 보장된 대상(`arrived`)"이다:

- `written` — `write_cd_to_group_terminals`가 **실제로 `cd`를 주입(write 성공)한 대상**. 이 함수는 ① PTY 핸들이 없는 대상(`file-explorer-*`처럼 백엔드 세션이 없는 경우), ② 대상 프로파일로 경로 변환이 불가능한 대상(예: file explorer의 순수 Linux `/home/...` 경로 → distro 미상의 PowerShell 대상 → `convert_path_for_target_with_distro` == `None`)을 조용히 스킵하고, 그 둘을 반환 집합에서 제외한다.
- `already_at_cwd` — `filter_targets_needing_cd`가 "이미 같은 CWD"라 제외한 대상(`idle_targets − target_terminals`). 새 `cd`는 안 나갔지만 이미 그 경로에 있으므로 도착 상태.

`mark_propagated`(에코 가드)는 실제로 새 `cd`를 주입한 `written`에만 적용한다(`already_at_cwd`는 새 명령을 안 보냈으므로 에코될 것이 없다).

이전(2차 리뷰)에는 도착 집합을 `idle_targets` 전체로 잡았는데, 이는 "idle이면 `cd`가 항상 도착한다"는 잘못된 전제였다. PTY 부재·경로 변환 실패로 실제 `cd`가 안 나간 대상을 도착으로 오기록하면, 그 대상이 같은 경로로 재시도해도 `filter_targets_needing_cd`가 "이미 동일 CWD"로 보고 `cd`를 영구히 건너뛴다. busy(`Running`/`InteractiveApp`)로 `filter_targets_not_busy`에서 제외된 대상은 애초에 `idle_targets`에 들지 않아 도착 집합에서 자동 제외된다. `FileExplorer(WSL/순수 Linux 경로) → PowerShell` 변환 불가는 "미적용 → 상태 미갱신 → 재시도 가능"으로 처리한다(distro를 프론트에서 넘기는 enhancement는 별도 범위).

**1회성 전파의 sync group 권위 소스 = `state.sync_groups` (2차 리뷰 P2, issue #293).** `resolve_propagate_source`는 그룹을 `session.config.sync_group`(stale 가능)이 아니라 멤버십의 권위 소스인 `state.sync_groups`에서 현재 그룹을 조회한다. `update_terminal_sync_group`은 `state.sync_groups` membership만 옮기고 `session.config.sync_group`은 갱신하지 않으므로, config를 읽으면 런타임에 그룹이 바뀐 터미널이 옛 그룹으로 전파되거나 no-op이 된다. 락 순서는 `terminals`(1) → `sync_groups`(10).

---

## 12. Automation API

외부 도구(Claude Code CLI 등)가 IDE를 프로그래밍 방식으로 제어할 수 있는 HTTP REST API.

### 12.1 아키텍처

```
[External Tool (curl)]
    │  HTTP request
    ▼
[Rust axum HTTP Server :19280]
    │
    ├─ Backend-only (터미널 write/output)
    │   → AppState 직접 접근
    │
    └─ Frontend 상태 필요 (워크스페이스, 그리드, 독)
        │  app.emit("automation-request")
        ▼
    [useAutomationBridge hook]
        │  Zustand store 조회/액션 실행
        │  invoke("automation_response")
        ▼
    [oneshot channel → HTTP response]
```

### 12.2 포트 규칙

**고정 포트**: release = `19280`, dev = `19281`. 각 빌드 타입은 하나의 인스턴스만 실행 가능하며, 포트 충돌 시 시작 실패한다.

- **Windows**: `%APPDATA%\laymux\automation.json` (dev: `%APPDATA%\laymux-dev\automation.json`)
- **Linux**: `~/.config/laymux/automation.json` (dev: `~/.config/laymux-dev/automation.json`)
- 환경변수: `LX_AUTOMATION_PORT` (터미널 spawn 시 자동 주입)

```jsonc
{
  "port": 19280,  // release=19280, dev=19281
  "pid": 12345,
  "version": "0.1.0"
}
```

Bearer 토큰(`key`) 필드는 없다 — 인증은 IP allowlist 미들웨어가 대체한다(§12.6, [ADR-0002](../adr/0002-automation-api-fixed-port-ip-allowlist.md)).

### 12.3 엔드포인트

> **전체·정본 엔드포인트 목록은 `REGISTERED_ROUTES`(`automation_server/types.rs`)와 `GET /api/v1/docs`(JSON 자기설명)가 SoT** 다. e2e 테스트가 `build_router()` ↔ `/docs` 일치를 강제한다(현재 `REGISTERED_ROUTES` 53개 = REST 52 + `/mcp` 와일드카드). 아래 표는 대표 엔드포인트 요약이며 전수 목록이 아니다.

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/v1/docs` | API 자기 설명 (전체 엔드포인트, 파라미터, 사용법을 JSON으로 반환) |
| GET | `/api/v1/health` | 헬스체크 |
| GET | `/api/v1/workspaces` | 워크스페이스 목록 |
| GET | `/api/v1/workspaces/active` | 활성 워크스페이스 |
| POST | `/api/v1/workspaces/active` | 워크스페이스 전환 |
| POST | `/api/v1/workspaces` | 워크스페이스 생성 (layoutId로 Layout 지정) |
| PUT | `/api/v1/workspaces/:id` | 이름 변경 |
| DELETE | `/api/v1/workspaces/:id` | 삭제 |
| POST | `/api/v1/layouts/export` | 현재 워크스페이스를 레이아웃으로 내보내기 (새로 생성 또는 덮어쓰기) |
| GET | `/api/v1/grid` | 그리드 상태 |
| POST | `/api/v1/grid/edit-mode` | 편집 모드 설정 |
| POST | `/api/v1/grid/focus` | Pane 포커스 |
| POST | `/api/v1/panes/split` | Pane 분할 |
| DELETE | `/api/v1/panes/:index` | Pane 제거 |
| PUT | `/api/v1/panes/:index/view` | View 변경 |
| GET | `/api/v1/docks` | 독 상태 |
| PUT | `/api/v1/docks/:position/active-view` | 독 View 변경 |
| POST | `/api/v1/docks/:position/toggle` | 독 가시성 토글 |
| PUT | `/api/v1/docks/:position/size` | 독 크기 설정 (px) |
| PUT | `/api/v1/docks/:position/views` | 독 View 목록 설정 |
| GET | `/api/v1/terminals` | 터미널 목록 |
| POST | `/api/v1/terminals/:id/write` | 터미널 입력 |
| GET | `/api/v1/terminals/:id/output?lines=N` | 터미널 출력 읽기 |
| GET | `/api/v1/memos` | 모든 메모 목록 조회 (`cache/memo.json` → `{ memos: [{ key, content }, ...], count }`) |
| GET | `/api/v1/memos/:key` | 특정 키의 메모 내용 조회 (없으면 404) |
| GET | `/api/v1/notifications` | 알림 목록 |
| GET | `/api/v1/layouts` | 레이아웃 목록 |
| POST | `/api/v1/screenshot` | 스크린샷 캡처 → `.screenshots/`에 저장 |
| POST | `/api/v1/ui/file-viewer` | 통합 파일 뷰어 오버레이 열기 (`path` 필수, `newWindow` 선택) — #277/#279/#404 |
| POST | `/api/v1/workspaces/reorder` | 워크스페이스 순서 변경 |
| POST | `/api/v1/grid/hover` | hover 시뮬레이션 |
| POST | `/api/v1/panes/:index/resize` | Pane 크기 조정 (상대 delta) |
| POST | `/api/v1/docks/:position/split` | 독 분할 |
| GET | `/api/v1/terminals/:id/buffer` | 터미널 출력 버퍼 덤프 |
| POST | `/api/v1/terminals/:id/focus` | 터미널 포커스 |
| GET | `/api/v1/terminals/states` | 전 터미널 활동 상태 |
| POST | `/api/v1/notifications` | 알림 생성 |
| DELETE | `/api/v1/notifications` | 알림 제거 (`ids` 또는 `before`) |
| POST | `/api/v1/ui/settings` | 설정 모달 토글 |
| POST | `/api/v1/ui/remote-access` | Remote Access 모달 토글. `{ "open": true/false }` 로 상태를 강제할 수 있음 |
| POST | `/api/v1/ui/settings/navigate` | 설정 화면 내비게이션 |
| PUT | `/api/v1/settings/app-theme` | 앱 테마 설정 |
| POST | `/api/v1/ui/hidden-items` | 숨긴 항목 보관함 open 상태 설정. body는 `{ "open": true/false }`의 strict boolean 필수 |

> 위 표 외에도 `docks/{position}/active-view·toggle·panes/{paneId}`, `settings/profile-defaults·profiles/{i}`, `workspaces/{id}/summary`, `ui/notifications`, `ui/hidden/{workspace,pane}/{id}/toggle` 등이 등록돼 있다. 전수는 위 각주의 정본을 본다.

### 12.4 터미널 출력 버퍼

- 터미널별 1MB 링 버퍼 (AppState에 저장)
- PTY 리더 스레드에서 자동 수집
- `close_terminal_session` 시 자동 정리
- `GET /api/v1/terminals/:id/output?lines=100`으로 조회

### 12.5 스크린샷

- `POST /api/v1/screenshot` → 프론트엔드 `html2canvas`로 DOM 캡처
- xterm WebGL canvas는 후처리로 합성하되, `data-screenshot-occluder="true"` 오버레이와 겹치는 canvas는 다시 그리지 않는다
- `.screenshots/` 디렉터리에 `screenshot_{timestamp}.png`로 저장
- 응답: `{ "path": ".../.screenshots/screenshot_xxx.png", "size": 12345 }`
- `.screenshots/*.png`는 `.gitignore`에 의해 버전 관리 제외

### 12.6 보안

- `0.0.0.0` 바인딩 (WSL2에서 Windows 호스트 접근 허용)
- IP allowlist 미들웨어: loopback, RFC 1918 사설 대역(10.x, 172.16-31.x, 192.168.x), link-local(169.254.x, fe80::)만 허용
- 인증 헤더 불필요 — 로컬/사설 네트워크 IP 제한만으로 보안 확보 (Chrome DevTools, Jupyter 등과 동일 모델)
- 외부 공인 IP에서 접근 시 403 Forbidden 반환
- IP allowlist 거절 응답은 laymux 가 관측한 클라이언트 주소를 포함한다: `{ "error": "... client IP: <ip>", "clientIp": "<ip>" }`

### 12.7 내장 MCP 서버

공식 `rmcp` SDK를 사용하여 MCP (Model Context Protocol) 서버를 Automation API에 직접 내장한다. 별도 바이너리 없이 `/mcp` 엔드포인트로 Streamable HTTP MCP 프로토콜을 제공한다. Stateful 세션 기반으로, `POST`(JSON-RPC 요청), `GET`(SSE 알림 스트림), `DELETE`(세션 종료)를 지원하며, `initialize` 후 `Mcp-Session-Id` 헤더를 유지해야 한다.

#### 아키텍처

```
변경 전: Claude Code (WSL) → stdio → laymux-mcp 바이너리 (빌드 필요) → HTTP → axum
변경 후: Claude Code (WSL) → HTTP → axum /mcp (빌드 불필요)
```

#### 기술 스택

| 항목 | 선택 |
|------|------|
| SDK | `rmcp` v1.4 (공식 MCP Rust SDK) |
| 프로토콜 | Streamable HTTP (JSON-RPC 2.0) |
| 라우팅 | `nest_service("/mcp", StreamableHttpService)` |
| Tool 정의 | `#[tool]` derive 매크로 — JSON Schema 자동 생성 |
| 인증 | IP allowlist 미들웨어 자동 적용 (인증 헤더 불필요) |

#### Tool 노출 정책

MCP handler 는 `automation_port()` 결과로 dev 여부를 주입받는다. release(`19280`)에서는 운영·사용자 상태 조작에 필요한 안정 툴만 노출하고, laymux-dev(`19281`)에서는 UI 검증/설정 모달/hover 시뮬레이션처럼 기능 개발 e2e 구동에 필요한 dev 전용 툴을 추가 노출한다. dev 전용 툴은 release 의 `tools/list` 결과에서 숨기며, 이름을 직접 호출해도 `tool not found` 로 거부한다([ADR-0017](../adr/0017-mcp-dev-only-tools.md)).

#### Tool 목록 (release 37개 + dev 전용 19개)

**설정 (4)** — release/dev 공통, frontend snapshot bridge 기반([ADR-0032](../adr/0032-llm-settings-introspection-and-safe-mutation.md)):

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `get_settings` | `settings.getSnapshot` bridge | 현재 store에서 합성한 설정과 revision 조회. `paths`는 RFC 6901 JSON Pointer 배열이며, `remote.authToken`은 항상 마스킹 |
| `describe_settings` | Rust settings contract | JSON Schema·기본값·의미·쓰기 가능 여부·민감 여부·적용 시점(`live`/`nextUse`/`restart`) 조회 |
| `validate_settings` | snapshot bridge + Rust strict validator | 부분 patch dry-run. 객체는 재귀 병합, 배열은 전체 교체하며 오류·기존 위반(`existingIssues`)·diff·후보 revision을 반환하고 저장하지 않음 |
| `update_settings` | strict validator → `settings.applySnapshot` bridge | 검증된 후보만 `settings.json`에 저장하고 store에 적용. 선택적 `expected_revision`/`expectedRevision` 충돌 검사 지원 |

일반 설정 patch에서 `workspaces`·`layouts`·`docks`·`workspaceDisplayOrder`와 cloud pairing 소유 필드는 읽기 전용이다. revision도 이 필드를 제외한 쓰기 가능한 구성만 해시한다. 이 경로 집합은 Rust metadata의 단일 상수에서 읽기 전용 판정·revision 계산·frontend `revisionIgnoredPaths`를 모두 파생한다. 알 수 없는 키, 타입/범위/enum 오류, profile 등 교차 참조 오류는 자동 보정하지 않고 거부한다. 단, 현재 설정부터 존재하고 후보에서도 값·오류가 변하지 않은 의미 위반은 무관한 patch를 막지 않고 `existingIssues`로 보고하며, 새 위반 또는 기존 값을 다른 잘못된 값으로 바꾼 경우만 `errors`로 거부한다. 민감값 전체 응답·diff·마스킹 sentinel 보존은 metadata의 `sensitive` 경로 목록을 공통 사용한다. `remote.authToken`의 `***REDACTED***` 값은 기존 secret 유지 표식이며 새 문자열 또는 빈 문자열만 실제 값을 변경한다. 쓰기 요청은 `AppState` 공용 설정 락으로 snapshot 조회부터 적용까지 직렬화하고, frontend가 저장 전후 기대 snapshot을 재검사해 Settings UI와의 경쟁도 충돌로 반환한다. 비교용 frontend snapshot은 CWD·Claude session IPC를 생략한다. 이 충돌 정책은 기존 app-theme/profile-defaults/profile REST·MCP setter에도 의도적으로 적용되며, 경쟁 시 REST는 `409 Conflict`, MCP는 tool error를 반환하므로 호출자는 최신 설정을 다시 읽고 재시도해야 한다.

**터미널 (8)**:

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `list_terminals` | bridge_request | 터미널 목록 조회 (워크스페이스 필터) |
| `identify_caller` | bridge_request | 터미널 위치·이웃 정보 조회 (단일 터미널 상세는 `list_terminals`/`terminal://{id}` 리소스로 대체) |
| `write_to_terminal` | AppState 직접 | PTY 입력 전송 (기본 `enter: true`로 제출, 타이핑만 하려면 `enter: false`). 에이전트 간 메시징은 `reply_to`에 발신자 terminal ID를 주면 표준 회신 푸터를 본문 뒤에 부착 |
| `write_to_neighbor` | bridge + AppState | 방향 기반 이웃 팬에 입력 전송 (identify + write 단축). `reply_to` 동일 지원 |
| `read_terminal_output` | AppState 직접 | 출력 버퍼 읽기 (raw/text 포맷) |
| `focus_terminal` | bridge_request | 터미널 포커스 — `terminal_id`/`pane_ref`/`pane_number` 해석 후 `terminals.setFocus` (안정 식별자·공간 번호 기반) |
| `get_terminal_states` | AppState 직접 | 전 터미널 활동 상태 감지 |
| `execute_command` | AppState 직접 | 명령 실행 + 출력 수집 (per-terminal 세마포어, sequence number) |

**워크스페이스 (6)**:

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `list_workspaces` | bridge_request | 워크스페이스 목록 (summary 옵션) |
| `get_active_workspace` | bridge_request | 활성 워크스페이스 상세 |
| `switch_workspace` | bridge_request | 워크스페이스 전환 |
| `create_workspace` | bridge_request | 워크스페이스 생성 (레이아웃/프로필 지정) |
| `delete_workspace` | bridge_request | 워크스페이스 삭제 |
| `rename_workspace` | bridge_request | 워크스페이스 이름 변경 |

**그리드/팬 (7)**:

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `get_grid_state` | bridge_request | 그리드 상태 조회 (`editMode`, `focusedPane`, `activeWorkspaceId`) |
| `focus_pane` | bridge_request | 인덱스 기반 팬 포커스 |
| `split_pane` | bridge_request | 팬 분할 (`ready` 필드로 렌더 완료 여부 표시) |
| `remove_pane` | bridge_request | 팬 제거 |
| `resize_pane` | bridge_request | 팬 크기 조정 (상대 delta) |
| `swap_panes` | bridge_request | 두 팬 위치 교환 (atomic 단일 상태 업데이트) |
| `list_layouts` | bridge_request | 저장된 레이아웃 목록 |

**유틸리티 (10)**:

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `take_screenshot` | bridge_request → image content | 스크린샷 캡처 (팬 단위 가능) |
| `list_notifications` | bridge_request | 알림 목록 (최신순 정렬, limit 지원) |
| `send_notification` | bridge_request | 알림 생성 (terminal→workspace 자동 매핑) |
| `clear_notifications` | bridge_request | 알림 제거 — `ids` 또는 `before`(타임스탬프) 중 정확히 하나, `read_only` 옵션 (읽음 처리만) |
| `search_terminal_output` | AppState 직접 | 출력 패턴 검색 (`max_lines` 조절 가능) |
| `broadcast_write` | AppState 직접 | 다중 터미널 동시 입력 — 각 터미널을 `write_to_terminal`과 동일 경로(`write_input`)로 전송하므로 `enter`(기본 true) 제출 시 #314 paste-burst 방지 body→CR 지연·per-terminal 직렬화 적용 |
| `list_profiles` | AppState 직접 | 사용 가능한 터미널 프로필 목록 |
| `open_file_viewer` | bridge_request | 통합 파일 뷰어 오버레이 열기 (`path` 필수, `new_window` 선택). File Explorer·Ctrl+Shift+O와 동일한 뷰어 (#277/#279) |
| `show_image` | base64 디코드 → 임시 파일 → bridge_request | MCP 클라이언트가 메모리에 가진 이미지를 바로 표시 (`data` 필수: base64 또는 `data:` URI, `mime_type`·`new_window` 선택). cache `mcp-images/`에 임시 저장 후 `open_file_viewer`와 동일 뷰어 재사용 (#287) |
| `close_file_viewer` | bridge_request | 파일 뷰어 오버레이 닫기 (`ui.closeFileViewer`). 열려 있지 않으면 no-op — `open_file_viewer`/`show_image`와 짝 |

**FileViewer preview 정책 (#404/#446)** — File Explorer, `Ctrl+Shift+O`, REST `/api/v1/ui/file-viewer`, MCP `open_file_viewer`/`show_image`는 모두 `ui/src/components/ui/FileViewer.tsx`의 단일 렌더 경로를 재사용한다. `.html`/`.htm`과 `.md`/`.markdown`은 기본 `preview` 모드로 열리지만, `settings.fileExplorer.extensionViewers`에 해당 확장자 매핑이 있으면 외부 터미널 뷰어가 우선한다. 이때 프론트엔드는 `create_terminal_session`에 profile과 구조화된 `viewer: { command, path }`를 전달하고, Rust가 현재 settings의 확장자·command·profile 조합 및 profile 존재를 다시 검증한다. Rust는 `profile.commandLine`의 대상 환경에 맞춰 `path_utils`로 경로를 변환하고 path 인자를 WSL/POSIX 또는 PowerShell 규칙으로 quote한다. explicit `\\wsl.localhost\<distro>` pure-Linux 경로를 WSL profile에 전달할 때는 unquoted `-d`/`--distribution` 선택 distro와 source distro가 일치해야 하며, mismatch·bare WSL·quoted distro는 거부한다(`/mnt/<drive>`는 distro 공용 예외). 일반 `startupCommandOverride`는 `claude --resume <session-id>`만 허용하며 raw viewer 문자열은 거부한다. 내장 preview의 `source` 토글은 Rust `read_file_for_viewer`가 반환한 기존 raw text를 그대로 표시한다. HTML preview는 `srcdoc` iframe + `sandbox="allow-same-origin"` + 제한 CSP를 사용하고, Markdown은 프론트에서 HTML로 변환한 뒤 동일 sanitizer/iframe 경로를 탄다. 스크립트, 이벤트 핸들러, 폼, iframe/object/embed, 위험 URL은 제거하며, 링크 클릭은 부모가 `openExternal`로 처리한다. 상대 이미지/CSS 등 로컬 상대 리소스는 이번 설계에서 지원하지 않고 차단한다. 임의 파일 노출을 피하기 위한 보수적 기본값이며, 상대 리소스가 필요해지면 별도 allowlist/custom endpoint/custom protocol 설계와 경계 테스트를 추가한다.

**메모 (2)** — `cache/memo.json` 파일 시스템 기반, 읽기 전용:

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `list_memos` | 파일 시스템 | `cache/memo.json`의 모든 `{ key, content }` 항목 (key 알파벳 정렬) |
| `read_memo` | 파일 시스템 | 특정 키의 메모 내용 조회 (없으면 에러) |

**Dev 전용 (19)** — laymux-dev(`19281`)에서만 `tools/list`와 `tools/call`에 노출:

| Tool | bridge method | 설명 |
|------|---------------|------|
| `set_app_theme` | 공통 settings snapshot/apply 경로 | 앱 테마 변경 |
| `update_profile` | 공통 settings snapshot/apply 경로 | 특정 프로필 부분 갱신 |
| `set_profile_defaults` | 공통 settings snapshot/apply 경로 | 프로필 기본값 부분 갱신 |
| `open_settings` | `ui.openSettings` | Settings 모달 열기 |
| `close_settings` | `ui.closeSettings` | Settings 모달 닫기 |
| `toggle_settings` | `ui.toggleSettings` | Settings 모달 토글 |
| `navigate_settings` | `ui.navigateSettings` | Settings 내부 섹션 이동 |
| `toggle_remote_access` | `ui.toggleRemoteAccess` | Remote Access 모달 토글 |
| `open_remote_access` | `ui.openRemoteAccess` | Remote Access 모달 열기 |
| `close_remote_access` | `ui.closeRemoteAccess` | Remote Access 모달 닫기 |
| `toggle_notification_panel` | `ui.toggleNotificationPanel` | 알림 패널 토글 |
| `set_hidden_items_open` | `ui.setHiddenItemsOpen` | 숨긴 항목 보관함 open 상태를 strict boolean으로 설정 |
| `toggle_pane_hidden` | `ui.togglePaneHidden` | pane hide 상태 토글 |
| `toggle_workspace_hidden` | `ui.toggleWorkspaceHidden` | workspace hide 상태 토글 |
| `simulate_hover` | `grid.simulateHover` | hover UI 검증용 pane hover 상태 시뮬레이션 |
| `set_edit_mode` | `grid.setEditMode` | grid edit mode 설정 |
| `set_pane_view` | `panes.setView` | pane view config 직접 변경 |
| `scroll_terminal` | `terminals.scroll` | live xterm viewport 상대 스크롤. PTY 입력 없이 `cols`/`rows`/`baseY`/`viewportY`/`isAtBottom` 반환 ([ADR-0025](../adr/0025-dev-terminal-viewport-automation.md)) |
| `dump_terminal_buffer` | `terminals.dumpBuffer` | live xterm의 reflow 완료 line model(`text`, `isWrapped`) 조회. WebGL 화면과 실제 버퍼 손상을 분리 진단 ([ADR-0025](../adr/0025-dev-terminal-viewport-automation.md)) |

#### MCP Resources — 구독형 read-only 상태 (issue #202)

tool 폴링 대신 구독 가능한 read-only 상태를 MCP Resources 로 노출한다. 구현은 `automation_server/mcp_resources.rs`(URI 모델·구독 레지스트리) + `mcp.rs`(list/read/subscribe 핸들러).

| URI | 내용 |
|---|---|
| `workspace://active` | 활성 워크스페이스 (panes + activity) |
| `workspace://list` | 워크스페이스 요약 목록 |
| `profile://list` | 터미널 프로파일 목록 |
| `terminal://{id}` | 단일 터미널 상태 |
| `terminal://{id}/output` | 최근 터미널 출력 (ANSI 제거 텍스트) |

- `resources/subscribe` 를 지원한다(`ServerCapabilities.enable_resources_subscribe`). 백킹 상태가 바뀌면 `notifications/resources/updated` 가 GET SSE 스트림으로 발행된다.
- `terminal://{id}` 계열은 resource template 로 노출된다. 대응하는 `list_*` tool 은 하위 호환으로 유지한다.

#### 구현 패턴

```rust
#[derive(Clone)]
pub struct McpHandler {
    state: ServerState,           // Arc<AppState> + AppHandle
    tool_router: ToolRouter<Self>,
    is_dev: bool,                 // release/dev tool gating
    exec_locks: Arc<TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>>,  // per-terminal 세마포어
}

#[tool_router]
impl McpHandler {
    // 공용 헬퍼: 입력 본문 준비 (escape 변환 + enter 시 후행 개행 제거).
    // 제출용 CR은 포함하지 않는다 — write_input이 별도 write로 보낸다(#314).
    // 후행 개행을 제거하는 이유: 남으면 별도 CR과 합쳐져 `...\n\r`가 되어
    // Windows ConPTY/PSReadLine에서 줄바꿈만 되고 제출 안 됨. 내부 개행은 보존.
    fn prepare_input_body(data: &str, escape: bool, enter: bool) -> String { ... }
    // 공용 헬퍼: 입력 전송 — 본문 write 후, enter면 ENTER_CR_DELAY_MS(300ms)
    // 지연 뒤 제출용 CR(\r)을 별도 write. Codex TUI는 텍스트+CR을 한 번에 받으면
    // paste로 간주해 CR을 줄바꿈 처리하므로, CR을 분리해 보내야 Enter로 제출된다
    // (#314). WSL PTY는 ~40ms로도 됐으나 Windows ConPTY는 더 큰 간격이 필요.
    // 쓰기 직전 pane activity 와 (capture 시) 출력 버퍼 seq 를 per-terminal exec
    // 락 안에서 원자적으로 샘플링해 WriteOutcome{ bytes, activity, before_seq }로
    // 반환한다. 락 밖 샘플링이면 같은 세션의 다른 write 가 끼어들어 판정이 오염된다.
    async fn write_input(&self, terminal_id: &str, data: &str, escape: bool, enter: bool,
                         reply_to: Option<&str>, capture: bool)
        -> Result<WriteOutcome, CallToolResult> { ... }
    // 공용 헬퍼: PTY 쓰기
    fn write_pty(&self, terminal_id: &str, data: &[u8]) -> Result<usize, CallToolResult> { ... }

    // bridge 패턴: 프론트엔드 상태 조회/변경
    #[tool]
    async fn list_terminals(&self) -> Result<CallToolResult, ErrorData> {
        self.bridge("query", "terminals", "list", json!({})).await
    }

    // AppState 직접 접근 패턴: PTY 입력
    #[tool]
    async fn write_to_terminal(&self, p: WriteTerminalParam) -> Result<CallToolResult, ErrorData> {
        // 리턴: { written, bytes, terminalId, activity, (capture_ms 시) captureMs/response/responseTruncated }
        let out = self.write_input(&p.terminal_id, &p.data, p.escape, p.enter,
                                   p.reply_to.as_deref(), p.capture_ms.is_some()).await...
    }
}
```

**`write_to_terminal` / `write_to_neighbor` 리턴 계약** (#426):
- 대상 `terminalId`가 workspace layout에는 할당됐지만 전역 terminal startup queue 뒤에 있어
  PTY가 아직 없으면 404로 실패하지 않는다. 프론트엔드 내부
  `terminals.prepareForAutomation` 브리지가 해당 pane을 다음 순서로 우선하고, 필요하면 대상
  workspace를 PTY 생성 동안만 활성화한 뒤 원래 workspace로 복원한다. REST
  `POST /terminals/{id}/write`와 MCP `write_to_terminal` 모두 세션 준비를 최대 20초 기다린 뒤 쓴다.
  이미 시작 중인 terminal은 선점하지 않으며 Automation 요청도 전역 동시 시작 수를 늘리지
  않는다([ADR-0043](../adr/0043-global-terminal-ready-startup-slot.md)).
- `focus_terminal`은 terminal store 등록 전에도 deterministic terminal id를 workspace
  layout에서 해석해 workspace 전환 + pane focus를 먼저 적용하고, PTY 준비 완료 후
  응답한다. 따라서 여러 pane을 순차 시작하는 중이거나 시작 완료 전에 다른
  workspace로 전환한 경우에도 focus/write 계약이 유지된다.
- `activity`: 쓰기 **직전** 대상 pane 상태. `{"type":"shell"}` | `{"type":"running"}` |
  `{"type":"interactiveApp","name":"Codex"}`. codex/claude 인 줄 알고 보냈는데 shell 로
  빠진 경우를 호출 즉시 감지하기 위한 필드. 락 안에서 샘플링해 write 와 원자적.
- `capture_ms`(opt-in): 주면 write 후 그만큼(상한 10000ms) 대기했다가 대상이 새로 낸
  출력을 ANSI 제거 + tail 절단(상한 2000자)해 반환. `capture_ms` 를 준 호출은 **항상**
  `captureMs` + `response`(문자열, 캡처 불가 시 `""`) + `responseTruncated`(bool)를 포함
  — 계약 안정성. 대기는 exec 락 밖에서 하므로 같은 pane 의 다른 write 를 블록하지 않는다.
- 교차 MCP 세션 write 직렬화는 `exec_locks` 가 세션별 handler 소유라 보장되지 않음(선존 한계).

#### Tool 추가 시

1. `mcp.rs`에 파라미터 구조체 추가 (`#[derive(Deserialize, JsonSchema)]`)
2. `#[tool_router] impl McpHandler` 블록에 `#[tool(description = "...")]` 메서드 추가
3. bridge_request 또는 AppState 직접 접근으로 구현
4. JSON Schema가 매크로에 의해 자동 생성됨 — 수동 정의 불필요

#### 설정

`scripts/setup-mcp.sh` (WSL/Linux) 또는 `scripts/setup-mcp.ps1` (Windows PowerShell)을 실행하면 `claude mcp add-json`으로 MCP 설정을 자동 등록한다. 인증 불필요 — URL만 등록하면 영구 유효 (laymux 재시작해도 재등록 불필요).

```bash
# 전역 등록
./scripts/setup-mcp.sh

# 프로젝트별 등록
./scripts/setup-mcp.sh --project

# dev 인스턴스 대상
./scripts/setup-mcp.sh --dev

# laymux가 꺼져있어도 강제 등록
./scripts/setup-mcp.sh --force
```

#### Troubleshooting

**WSL에서 MCP 연결 안 됨**

WSL2 네트워킹 모드에 따라 Windows 호스트 접근 IP가 다르다:

| WSL2 모드 | Windows 호스트 IP | `ip route` 게이트웨이 |
|-----------|-------------------|----------------------|
| NAT (기본) | `172.x.x.x` (Hyper-V 게이트웨이) | `172.x.x.x` ✅ |
| 미러링 (networkingMode=mirrored) | `127.0.0.1` | 공유기 IP (192.168.0.1 등) ❌ |

`setup-mcp.sh`는 `127.0.0.1` → 게이트웨이 → 네임서버 순으로 health check하여 연결 가능한 IP를 자동 선택한다. 수동 확인:

```bash
# WSL에서 직접 연결 테스트
curl -s http://127.0.0.1:19280/api/v1/health    # 미러링 모드
curl -s http://$(ip route show default | awk '{print $3}'):19280/api/v1/health  # NAT 모드
```

연결 가능한 IP를 확인한 후 수동 등록:

```bash
claude mcp add-json -s user laymux '{"type":"http","url":"http://<IP>:19280/mcp"}'
```

**Windows에서 MCP 연결 안 됨**

1. laymux가 실행 중인지 확인: `curl -s http://127.0.0.1:19280/api/v1/health`
2. Claude Code에서 `/mcp`로 등록 상태 확인
3. `~/.claude.json`의 `mcpServers.laymux` 항목에 불필요한 `headers` 필드가 있으면 제거

**공통 체크리스트**

- 포트: release=19280, dev=19281 (고정)
- URL 형식: `http://<IP>:<PORT>/mcp` (trailing slash 없음)
- 인증 헤더 불필요 — `headers` 필드가 있으면 오히려 문제 가능
- Claude Code 재시작 필요 (MCP 설정 변경 후)

## 13. Remote UI API

Remote UI API는 사람이 브라우저에서 laymux를 조작하기 위한 Direct Remote Mode 계약이다. 같은 axum 서버에 붙지만 Automation API/MCP와 route namespace, 인증, Origin/CORS, 세션 모델을 분리한다([ADR-0013](../adr/0013-direct-remote-mode.md)). Automation API의 `REGISTERED_ROUTES`/docs 검증 대상이 아니며 브라우저 entry는 `/remote/`, 제어 API는 `/remote/v1/*` 네임스페이스를 사용한다.

### 13.0 Browser Entry

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote` | GET | `/remote/`로 redirect |
| `/remote/` | GET | 브라우저에서 직접 여는 Direct Remote Mode entry |
| `/remote/vendor/xterm.css` | GET | `/remote/` 전용 xterm.js 스타일 |
| `/remote/vendor/xterm.js` | GET | `/remote/` 전용 xterm.js 브라우저 빌드 |
| `/remote/vendor/addon-fit.js` | GET | `/remote/` 전용 xterm fit 애드온 |
| `/remote/viewer/` | GET | 자격 증명이 없는 Remote FileViewer 새 탭 bootstrap |
| `/remote/viewer/viewer.js` | GET | Remote FileViewer 외부 script (`script-src 'self'`) |

`/remote`와 `/remote/`는 remote가 실효적으로 켜져 있고(`settings.remote.enabled || runtimeRemoteAccess.enabled`), 실효 remote token이 있으며, remote IP allowlist를 통과할 때 응답한다. Cloud tunnel 내부 요청은 크레이트 내부 전용 `TunnelAuthorized` marker가 있을 때 token/IP/Origin 검사를 우회하지만, 이 page route도 실효 enabled gate는 반드시 통과해야 한다. 이 HTML 문서 자체는 토큰 값을 요구하지 않지만, 페이지가 호출하는 `/remote/v1/*` 제어 API는 아래 인증 정책을 그대로 따른다. 사용자는 브라우저 주소창에서 `http://<laymux-host>:19280/remote/` 또는 dev의 `:19281/remote/`를 열고 remote token을 입력해 controller lease를 claim한다. 편의를 위해 `/remote/#token=<url-encoded-token>`도 허용하며, 이 값은 remote 페이지의 token 입력란을 미리 채우는 용도다. fragment는 HTTP 요청에 포함되지 않으므로 링크 공유용 prefill에는 query string보다 이 형태를 우선 사용한다.

`settings.json`은 Remote 설정의 영속 정본이다. Rust는 앱 시작 시 `settings.remote`를 `AppState.remote_access`의 메모리 snapshot으로 적재하고, `save_settings`/`reset_settings` 및 cloud pairing/disconnect 설정 저장이 디스크에 성공한 뒤 같은 snapshot을 갱신한다. `save_settings`/`reset_settings`가 실효 enabled 상태를 바꾸면 snapshot 교체와 owner gate 전환을 한 트랜잭션으로 시작하고 `remote-control-changed`를 발행하며, 전환 결과에 맞춰 cloud tunnel lifecycle도 reconcile한다. cloud pairing/disconnect는 access gate를 건드리지 않고 cloud 필드만 snapshot에 반영한다. human-control permit 생성과 resize/write 입력 핫패스는 이 snapshot에 runtime access override만 합성하며 설정 파일을 다시 읽거나 JSON migration·validation을 수행하지 않는다.

현재 브라우저 entry는 Rust remote server가 self-hosted xterm.js 자산을 `/remote/vendor/*`에서 제공하는 중간 구현이다. CDN이나 Vite dev server에 의존하지 않으며, 출력 WebSocket의 PTY byte stream을 xterm에 그대로 기록하고 xterm 입력/resize 이벤트를 Remote UI API로 다시 보낸다. ADR-0013의 최종 목표인 같은 React bundle 기반 Full UI/Focused UI 전환과 `RemoteHttpWsClient` adapter 추출은 후속 리팩터링 대상이다.

`/remote/vendor/*`도 `/remote/`와 같은 base access 조건(실효 enabled, 실효 token 존재, IP allowlist)을 통과해야 응답한다. Cloud tunnel 내부 요청은 token/IP/Origin 대신 `TunnelAuthorized` marker를 신뢰하지만, vendor route도 실효 enabled gate는 공유한다. 실제 controller 권한은 vendor asset이 아니라 `/remote/v1/*` API의 bearer token + lease 검사에서 결정된다.

`/remote/viewer/*`도 같은 base access gate를 공유하고 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`를 보낸다. viewer HTML은 inline script나 자격 증명을 포함하지 않으며 `script-src 'self'`, `frame-ancestors 'none'` CSP를 적용한다. 파일 내용은 이 bootstrap route가 아니라 active lease를 요구하는 §13.3.1 API로만 가져온다.

### 13.1 인증과 접근 제어

- `settings.remote.enabled` 또는 런타임 remote 허용 상태가 `true`일 때만 응답한다.
- 실효 remote token은 필수다. `settings.remote.authToken`을 우선 사용하고, 이 값이 비어 있을 때만 런타임 허용 토큰을 사용한다. HTTP 요청은 `Authorization: Bearer <token>` 또는 `X-Laymux-Remote-Token`을 사용할 수 있고, WebSocket은 브라우저 제약 때문에 URL-encoded `?token=<token>`도 허용한다.
- Cloud tunnel이 내부 `oneshot` dispatch로 삽입하는 `TunnelAuthorized` marker는 wire에서 위조할 수 없는 크레이트 내부 marker다. 이 marker가 있으면 token/IP/Origin 검사는 우회하지만, `settings.remote.enabled || runtimeRemoteAccess.enabled` enabled gate와 controller lease 검사는 그대로 적용한다.
- `settings.remote.allowedIps`는 IP/CIDR allowlist다. 기본값은 loopback only이며 Tailscale 직접 접속은 예를 들어 IPv4 `100.64.0.0/10`, IPv6 `fd7a:115c:a1e0::/48`를 명시해야 한다.
- remote IP allowlist 거절 응답은 laymux 가 관측한 주소와 현재 allowlist를 포함한다: `{ "error": "... <ip>", "remoteIp": "<ip>", "allowedIps": [...] }`
- `settings.remote.allowedOrigins`가 비어 있지 않으면 `Origin` 헤더가 존재할 때 정확히 일치해야 한다. 브라우저의 same-origin fetch가 `Origin`을 생략한 경우에 한해 `Sec-Fetch-Site: same-origin`과 `Host`가 허용 origin의 authority와 맞으면 허용한다. 이 예외는 브라우저 호환성용이며 보안 경계는 IP allowlist와 bearer token이다.

### 13.2 Controller Lease

원격 제어는 다중 클라이언트 동기화가 아니라 exclusive controller lease다.

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote/v1/session/status` | GET | 현재 lease 상태 조회 |
| `/remote/v1/session/claim` | POST | remote controller lease 획득. active lease·reclaim lockout·input reservation 충돌은 `409`. optional `resumeToken`(비밀 capability)이 현재 lease의 것과 일치하면 같은 컨트롤러의 takeover/handoff로 통과 |
| `/remote/v1/session/heartbeat` | POST | lease heartbeat 갱신 |
| `/remote/v1/session/release` | POST | remote가 lease 반납. pagehide beacon 경로는 `token` query parameter 인증 사용 |

`claim` 성공 응답의 `leaseId`가 이후 제어 요청의 권한이다. 기존 Local input permit이 아직 남아 있으면 server는 `409 { code:"input_busy", claimReservationId, retryAfterMs, reservationTtlMs }`를 반환하고 one-shot reservation을 설치한다. 예약은 짧은 bounded TTL을 가지며, active Local 작업이 남은 동안 인증된 client가 같은 `claimReservationId`로 재시도할 때만 TTL을 다시 시작한다. 따라서 긴 PTY 작업은 연속 재시도로 기다릴 수 있지만 탭 종료·네트워크 단절로 claimant가 사라지면 새 Local 입력 차단은 마지막 재시도 뒤 한 TTL 이내에 끝난다. reservation이 살아 있는 동안 새 Local permit과 다른 claim은 앞지르지 못한다. Remote page는 이 `input_busy` 응답만 동일 token으로 자동 재시도하고 서버가 갱신해 준 만료 시각을 사용하며, 다른 `409`는 자동 재 claim하지 않는다.

claim 성공 응답은 status에 더해 비밀 `resumeToken`을 포함한다([ADR-0037](../adr/0037-remote-lease-takeover-and-pagehide-release.md)). 서버는 토큰 원문이 아니라 process-random 키의 이중 SipHash digest만 lease 옆에 보관하며, status·충돌 응답 어디에도 이 값을 노출하지 않는다 — 공개 `leaseId`는 takeover 증명이 될 수 없다. claim body의 optional `resumeToken`이 현재 **Active** lease의 capability와 일치하면(owner transition 없음) 기존 lease가 있어도 claim이 통과하고, reclaim lockout·input-busy reservation·owner epoch 전진을 기존 경로 그대로 거쳐 lease를 교체한 뒤 새 `leaseId`/`resumeToken`을 발급한다(옛 capability는 즉시 무효). 자발적 release의 owner transition은 만료·reclaim·disable과 달리 capability를 revoke하지 않고 drain 동안 유지하므로, drain 중 도착한 claim이 올바른 `resumeToken`을 제시하면 서버가 bounded transition budget 안에서 drain 완료를 기다린 뒤 이어서 처리한다(handoff). capability가 없거나 틀리면 기존대로 `409`이고, reclaim lockout은 takeover/handoff보다 우선하며, 만료·reclaim·disable로 시작된 transition은 capability를 즉시 revoke한다.

claim 성공 응답은 FileViewer 전용 비밀 `fileViewerToken`도 포함한다([ADR-0042](../adr/0042-remote-file-viewer-secret-capability.md)). 이 값도 원문 대신 process-random keyed digest만 현재 lease id와 결합해 저장하고 status·충돌 응답에는 노출하지 않는다. 새 claim과 모든 owner transition은 이를 즉시 revoke하며, `resumeToken`과 달리 자발적 release handoff 중에도 보존하지 않는다.

Remote page에서 `resumeToken`은 문서가 살아 있는 동안 메모리에만 존재한다. `pagehide` 시점에만 탭 단위 `sessionStorage`(`laymux.remote.resumeToken`)에 stash하고 문서 load·bfcache 복원(`pageshow`)에서 즉시 consume(get+remove)하므로, Duplicate Tab/`window.open`이 복제하는 살아 있는 원본의 저장소는 항상 비어 있어 복제 탭이 capability를 제시할 수 없다. 서버가 lease 상실을 확정하면(`401`/`403`/`409`) 메모리와 저장소의 capability를 모두 폐기한다. 또한 `pagehide`에서 `navigator.sendBeacon`(불가 시 keepalive fetch)으로 `/remote/v1/session/release`를 호출해 lease를 즉시 반납한다. beacon은 헤더를 실을 수 없으므로 WebSocket과 동일한 `token` query parameter 인증을 사용한다.

PC WebView는 `remote-control-changed` Tauri event를 받아 local input overlay를 표시하고, `reclaim_remote_control` Tauri command로 언제든 lease 종료를 요청할 수 있다. reclaim·Remote release·access disable·heartbeat expiry는 owner epoch을 먼저 전환해 새 양쪽 permit을 막고, 기존 Remote I/O의 bounded cancellation acknowledgement 후에만 Local owner를 공개한다. 이 동안 status는 `active=true, transitioning=true`로 fail-closed한다. PC reclaim 완료 후에는 `heartbeatTimeoutSeconds` 동안 새 remote claim을 `409`로 거절한다. Lease timeout 기본값은 45초이고 30초 미만의 설정도 런타임에서는 30초로 clamp한다. 성공한 claim/heartbeat 시점에 현재 timeout으로 absolute monotonic deadline을 고정하며, 만료가 한 번 관측된 lease는 timeout 증가나 늦은 heartbeat로 부활하지 않는다([ADR-0027](../adr/0027-remote-connection-graceful-recovery.md), [ADR-0029](../adr/0029-detached-terminal-input-composer.md)).

### 13.3 Navigation Metadata

Focused remote UI는 전체 React layout을 복제하지 않고, workspace/dock/pane 요약과 single terminal stream을 분리한다. 이 요약은 frontend Zustand store가 알고 있는 workspace/dock 구조를 Rust remote server가 bridge로 조회한 뒤 remote 전용 계약으로 축약한 값이다. Remote client는 raw settings나 전체 store를 직접 읽지 않는다.

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote/v1/navigation` | GET | workspace 목록, active workspace pane 요약, dock pane 요약, terminal 표시 메타데이터 |
| `/remote/v1/notifications/{id}/read` | POST | active `leaseId`로 단일 notification id를 읽음 처리 |
| `/remote/v1/notifications/mark-all-read` | POST | active `leaseId`로 모든 unread notification을 읽음 처리 |
| `/remote/v1/notifications` | DELETE | active `leaseId`로 모든 notification 제거 |
| `/remote/v1/workspaces/active` | POST | active `leaseId`로 PC WebView의 active workspace 전환 |
| `/remote/v1/terminals/{id}/focus` | POST | active `leaseId`로 PC WebView의 terminal focus 전환 |
| `/remote/v1/navigation/spatial` | POST | active `leaseId`로 공간순서 스텝 이동 (`direction: "prev"\|"next"`) |
| `/remote/v1/navigation/notification` | POST | active `leaseId`로 알림순서 스텝 이동 (`direction: "recent"\|"oldest"`) |

`/remote/v1/navigation`은 bearer token과 IP/Origin gate를 통과해야 하며 lease는 요구하지 않는다. 응답의 `workspaces`는 PC WebView `WorkspaceSelectorView`와 같은 `workspaceSelector.sortOrder`/`workspaceDisplayOrder` 규칙으로 정렬된 `{id,name,isActive,hidden,collapsed,paneCount,terminalPaneCount,liveTerminalCount,unreadCount,panes}` 요약이다. ADR-0018의 remote payload 호환성과 focused remote surface를 위해 숨김 워크스페이스와 숨김 pane도 제거하지 않고 `hidden`/`collapsed` 플래그로 전달한다. 다만 desktop selector는 ADR-0033 이후 숨김 행을 DOM 목록에서 필터하고 별도 보관함에서 복원하므로, remote의 `collapsed`는 remote 전용 표시 계약이지 desktop DOM 접힘 모델과의 1:1 일치를 뜻하지 않는다. 현재 active workspace는 전환 중인 raw snapshot에서도 `collapsed=false`로 유지해 현재 터미널 문맥을 잃지 않는다. `workspaces[].panes`는 active workspace에서만 채우고 inactive workspace는 빈 배열로 둔다. 각 pane 요약은 `{id,location,workspaceId,paneIndex,paneNumber,viewType,terminalId,terminalLive,title,profile,cwd,branch,activity,outputActive,commandRunning,isFocused,unreadCount,hidden,collapsed,x,y,w,h}` 형태이며, `unreadCount`는 terminal pane에만 부여하고 non-terminal pane은 항상 `0`이다. `activeWorkspace.panes`와 active `workspaces[].panes`는 같은 pane 요약을 쓰며 PC selector와 동일하게 `paneNumber` 오름차순으로 정렬한다. 이때 `paneIndex`는 정렬 후 위치가 아니라 원본 `WorkspacePane[]` 인덱스를 유지한다. `docks[]`는 workspace 목록과 섞지 않는 앱 전역 요약이며, `docks[].panes`는 `location="dock"`과 `workspaceId=null`을 사용해 workspace 소속 pane이 아님을 명확히 한다. Dock pane의 `unreadCount`는 workspace filter 없이 `terminalId` 기준으로만 계산하고, dock pane의 `isFocused`는 terminal store의 focus flag가 아니라 desktop dock focus SoT인 `focusedDock`/`focusedDockPaneId`에서 계산한다. `visible=false` dock은 remote page의 dock panel에서 렌더하지 않고 preferred terminal 후보에서도 제외한다. 즉 `preferredTerminalId` short-circuit과 fallback 모두 active workspace pane terminal 또는 visible dock pane terminal만 메인 출력으로 열 수 있다. 최상위 `workspaceSelector`는 remote drawer가 PC selector의 표시 토글/경로 ellipsis와 맞출 수 있게 하는 현재 selector 설정이며, `unreadNotificationCount`는 전체 unread 수다. `terminals`는 `/remote/v1/terminals` 항목에 frontend bridge의 `workspaceId`, `paneNumber`, `activity`, `isFocused` 등 탐색에 필요한 메타데이터를 병합한 목록이다.

`/remote/v1/workspaces/active` body는 `{ "id": "...", "leaseId": "..." }`, `/remote/v1/terminals/{id}/focus` body는 `{ "leaseId": "..." }`다. 둘 다 `X-Laymux-Remote-Lease` 헤더도 허용하며, 성공 시 `workspace-state-changed` event를 발행해 MCP resource 구독자와 Automation resource cache가 stale 상태에 머물지 않게 한다. Remote workspace 전환은 해당 workspace의 unread notification을 읽음 처리하고, remote terminal focus는 해당 terminal의 unread notification을 읽음 처리한다. 이 처리는 focused remote UI의 명시적 navigation action에 대한 소비 동작이며, 숨김 항목 편집 자체는 desktop WorkspaceSelectorView와 기존 Automation/MCP `ui.toggle*Hidden` 호환 경로가 담당한다.

`/remote/v1/navigation`은 최상위 `notifications` 목록도 포함한다. 각 항목은 `{id,title,message,level,createdAt,readAt,isRead,workspaceId,workspaceName,terminalId,terminalLabel,requiresAction}` 형태이며 desktop `NotificationPanel`과 같은 규칙으로 정렬한다. 즉 unread notification을 먼저 두고, unread/read 각 그룹 내부는 최신 삽입 순서를 따른다. Remote page는 이 정렬된 목록에서 처음 등장한 workspace 순서대로 그룹화해 표시한다. 알림 tap은 연관 대상이 있으면 기존 navigation action을 재사용한다: workspace 대상은 `/remote/v1/workspaces/active`, terminal 대상은 `/remote/v1/terminals/{id}/focus`를 호출하고, 대상이 없는 알림은 `/remote/v1/notifications/{id}/read`로 해당 id만 읽음 처리한다. Mark-all-read는 frontend bridge `notifications.markAllRead`를 사용하고, clear-all은 `notifications.list`로 id를 수집한 뒤 기존 `notifications.clear`에 ids를 넘긴다. 이 notification endpoint들은 remote controller action이므로 active lease를 요구하지만, `/remote/v1/navigation`은 계속 token-gated read-only query다.

`/remote/v1/navigation/spatial`과 `/remote/v1/navigation/notification`은 스텝 내비게이션 controller action이다([ADR-0039](../adr/0039-remote-spatial-notification-step-navigation.md)). body는 `{ "leaseId": "...", "direction": "..." }`이며 `X-Laymux-Remote-Lease` 헤더도 허용한다. direction은 spatial이 `"prev"|"next"`, notification이 `"recent"|"oldest"`(데스크톱 `notifications.recent/oldest` 액션과 동일 명명)이고 그 외 값·누락은 `400`이다. Rust 핸들러는 lease 검증과 중계만 수행하고, 순회 계산·store 조작은 frontend bridge action `navigation.spatialStep`/`navigation.notificationStep`이 담당한다. 공간순서는 (표시순 visible workspace) × (workspace 내 `paneNumber` 오름차순 TerminalView pane)의 순환 1D 리스트다 — hidden workspace 제외(active-hidden은 앵커로만), hidden pane 포함, non-terminal pane 제외, dock 제외, `terminalLive` 무관. 알림 스텝은 데스크톱 키보드와 같은 `findNotificationNavTarget` 규칙(unread만, `createdAt` 정렬, 동일 terminal 연속 그룹 소비)을 공유한다. 성공 응답은 `{moved:true, target:{workspaceId, workspaceName, terminalId, paneId, paneIndex, paneNumber, switchedWorkspace}}`(notification은 `consumedNotificationIds` 추가)이고, 이동할 곳이 없으면 에러가 아닌 `{moved:false, reason:"no_terminal_panes"|"no_other_target"|"no_unread_notifications"}`를 반환한다. `navigation.spatialStep`은 착지 터미널의 세션 준비를 기다린 뒤 응답하며(async bridge 경로), Rust는 spatial 성공 시 착지 터미널 unread를 `notifications.markTerminalRead`로 best-effort 읽음 처리하고 성공 시 `workspace-state-changed`를 발행한다. Remote page는 응답 `target.terminalId`로 메인 출력 attach를 follow한다.

Remote page는 workspace navigation과 dock navigation을 별도 토글 패널로 렌더한다. Dock terminal 선택은 workspace 전환을 수행하지 않고 `/remote/v1/terminals/{id}/focus`만 호출한다. 이 endpoint의 frontend bridge `terminals.setFocus`는 dock terminal을 감지하면 desktop dock과 같은 전역 focus(`focusedDock`, `focusedDockPaneId`)를 설정하고 grid focus를 비운다. workspace terminal focus나 workspace 전환 경로는 dock focus를 비워 workspace pane focus가 dock focus에 의해 억제되지 않게 한다. 이어서 기존 remote terminal focus 경로와 동일하게 `notifications.markTerminalRead`로 해당 terminal unread를 읽음 처리한다.

### 13.3.1 Remote File Viewer

Remote drawer의 File viewer는 host file path 입력, 명시적 `From host`, `Open viewer` action으로 결과를 별도 브라우저 탭에 표시한다([ADR-0042](../adr/0042-remote-file-viewer-secret-capability.md), [ADR-0044](../adr/0044-remote-file-viewer-explicit-host-path.md)). 연결·heartbeat는 FileViewer status를 자동 조회하거나 입력을 변경하지 않는다. 사용자가 `From host`를 누르면 그때 `/status`를 조회해 데스크톱에서 현재 열린 파일 path를 입력에 넣으며, 요청 중 입력 revision이 바뀌면 늦은 응답을 적용하지 않는다. `Open viewer`와 일반 Enter는 클릭 시점의 trim된 입력값을 exact path snapshot으로 전달하며 데스크톱 FileViewer store를 변경하지 않는다. Remote terminal의 선택 파일 링크도 사용자 selection/click을 명시적 host path action으로 취급하고 desktop parser를 재사용해 같은 viewer로 연다([ADR-0045](../adr/0045-remote-path-link-reuses-desktop-parser.md)).

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote/v1/file-viewer/status` | GET | active lease + FileViewer capability로 데스크톱 `useFileViewerStore`의 `{open,path}` 조회 |
| `/remote/v1/file-viewer/render` | POST | active lease + FileViewer capability로 현재 viewer 파일 또는 명시한 호스트 경로를 bounded web payload로 렌더 |
| `/remote/v1/file-viewer/path-link` | POST | active lease + FileViewer capability로 terminal 선택 원문을 desktop path-link parser/CWD/stat 경로에서 검증 |

세 endpoint 모두 Remote bearer token/IP/Origin gate와 active controller lease에 더해 claim 성공자 전용 FileViewer capability를 요구한다. lease는 `X-Laymux-Remote-Lease`, capability는 `X-Laymux-Remote-File-Viewer` 헤더로 전달하며 둘 다 현재 lease에 결합돼 일치해야 한다. 누락·오류 capability는 동일한 `403`으로 실패한다. 서버는 frontend bridge를 호출하기 전과 완료 후 응답 직전에 같은 lease/capability를 검증한다. 그 사이 expiry·release·reclaim·disable·새 claim으로 capability가 폐기 또는 회전되면 bridge 결과를 버리고 `403`으로 fail closed한다. bridge 이후 성공·실패 응답은 `Cache-Control: no-store`를 보낸다. render body는 `{ "source": "current" }` 또는 `{ "source": "path", "path": "..." }`다. `current`는 client가 보낸 path를 무시하고 desktop `useFileViewerStore`의 현재 path만 사용한다. 닫힌 current viewer, 빈 path, 알 수 없는 source는 실패한다.

`path-link` body는 `{ "terminalId": "...", "selection": "..." }`이며 client CWD·path·좌표는 받지 않는다. Rust는 빈 필드, Unicode scalar 256자 초과 terminal id, 4096자 초과 selection을 `400`으로 거르고 `fileViewer.pathLink` async bridge에 원문을 전달한다. frontend는 해당 terminal의 최신 store CWD와 `terminal.pathLinkEnabled`/`pathLinkMaxLength`를 읽어 desktop `isWithinPathLengthLimit`·`trimSelectionToPath`·`joinCwdPath`·`statPath`를 그대로 사용한다. 설정 off, 부적합/초과 선택, CWD 없음, 없는 path, 디렉터리는 `{valid:false}`이고 존재하는 일반 파일만 `{valid:true,token,path}`다. token은 선택 밑줄 좌표 보정용으로만, path는 기존 새 탭 handshake의 `source="path"` 입력으로만 쓴다. 브라우저는 드래그 중 selection 변화를 trailing debounce하고 새 선택에서 진행 중 요청을 취소한다. 요청 당시 selection revision·terminal·lease·capability가 하나라도 바뀐 응답은 버리며, 응답 시점의 최신 xterm selection 좌표로 밑줄 범위를 다시 계산한다. 좌표/decoration은 ADR-0015의 surface-local 상태로 유지한다. 검증은 stat만 수행하며 파일 내용은 prefetch하지 않는다.

`render`는 Rust route가 고정한 8 MiB `maxBytes`를 frontend async bridge에 전달한다. `readFileForViewer`는 image에도 상한을 적용한 bounded read를 수행한다. 일반 text 응답은 `{path,kind:"text",content,truncated}`, HTML/Markdown preview 응답은 원문 중복을 제거한 `{path,kind:"text",truncated,previewKind,previewDocument}`, 그 밖에는 `{path,kind:"image",dataUrl}` 또는 `{path,kind:"binary",size}`다. HTML/Markdown `previewDocument`는 데스크톱 FileViewer와 같은 sanitizer/CSP builder의 결과이며 새 탭은 sandbox iframe `srcdoc`으로만 표시하고 `truncated=true`이면 잘림 경고를 함께 표시한다. 일반 text는 `textContent`, image는 `data:image/*`만 사용한다. Remote에서는 settings의 `extensionViewers` shell 매핑을 실행하지 않고 항상 이 built-in web renderer를 사용한다.

새 탭은 반드시 사용자의 button/일반 Enter action에서 `window.open("/remote/viewer/")`으로 먼저 연다. IME 조합 중 Enter와 legacy `keyCode=229`는 제출하지 않고, host path 입력은 모바일 키보드가 대소문자를 바꾸지 않도록 자동 대문자화를 끈다. child가 exact same-origin `laymux:file-viewer-ready` 메시지를 보내면 opener는 해당 `Window` 객체가 자신이 연 pending child인지 확인하고, token·lease·fileViewerToken과 클릭 때 스냅샷한 `source="path"`/path를 `laymux:file-viewer-session` 메시지로 한 번 전달한다. child URL(query/fragment)·bootstrap DOM·localStorage/sessionStorage·문서 제목에는 token·lease·capability·path를 기록하지 않는다. 제목은 일반적인 `Laymux File Viewer`로 유지하고 path는 본문에만 표시한다. child는 exact origin과 `event.source === window.opener`를 확인해 최초 한 세션만 받고 즉시 opener 참조를 끊는다. 비동기 MCP/desktop viewer 변경은 Remote 입력을 자동 갱신하거나 popup을 만들지 않으며, 사용자가 `From host`를 다시 눌러 명시적으로 가져온다.

### 13.4 Terminal Control

Remote terminal control은 상태 소유권을 세 범주로 나눈다([ADR-0015](../adr/0015-remote-terminal-state-ownership.md)).

| 범주 | 예 | 소유/동기화 규칙 |
|---|---|---|
| PTY 전역 상태 | PTY process, stdin, output byte stream, CWD/title/activity, terminal escape state, 현재 `cols/rows` | 한 terminal session에 하나만 존재한다. 현재 controller owner만 변경할 수 있다. |
| surface 로컬 상태 | DOM pixel size, devicePixelRatio, xterm canvas/WebGL atlas, cell metrics cache, scroll viewport, selection, focus, IME/composition, drawer state | PC WebView와 browser remote가 각자 보유한다. Remote API 계약에 섞지 않는다. |
| controller owner 상태 | active input writer, active resize writer, workspace/pane focus request 권한 | active lease가 있으면 remote가 owner이고, lease가 없으면 PC가 owner다. owner가 아닌 surface는 PTY write/resize를 보내지 않는다. |

브라우저 remote의 모바일 터치 스크롤/선택은 surface-local 처리다. Remote HTML은 Pointer Events 기반 gesture layer를 두고 일반 한 손 드래그를 텍스트 선택에 쓰지 않는다. normal buffer이며 mouse tracking mode가 꺼진 shell/log 화면에서는 한 손 세로 스와이프가 xterm scrollback을 움직이고, alternate buffer 또는 mouse tracking mode에서는 한 손 스와이프를 TUI 앱 내부 스크롤 입력으로 전달한다. scrollback을 위로 올리면 데스크톱 TerminalView와 같은 하단 이동 버튼을 띄우고, 누르면 해당 remote xterm viewport만 live tail로 이동한 뒤 버튼을 숨긴다. 움직임 없이 long-press가 성립하면 선택 모드에 들어가고, 이후 드래그 또는 표시된 선택 핸들 이동만 xterm selection을 갱신한다. double tap은 단어 선택, triple tap은 줄 선택으로 처리한다. 두 손가락 세로 스와이프는 현재 surface에서 가능한 스크롤 경로로 라우팅한다. mouse tracking mode에서 선택을 시작하면 합성 이벤트에 force-selection modifier를 실어 TUI로 입력이 전달되지 않게 한다. 선택된 텍스트는 별도 버튼 없이 선택 interaction이 끝나는 시점에 브라우저 클립보드로 복사한다. 마우스 선택을 terminal 밖까지 끌고 놓는 경우도 xterm의 document-level `mouseup` 선택 확정 뒤 복사를 예약한다. Clipboard API가 거절되면 같은 user-activation task 안에서 `execCommand("copy")` fallback을 사용하고, 로컬 모바일 iframe은 `clipboard-write` 권한을 명시한다. 이 동작은 Remote API 계약이나 PTY 전역 상태를 바꾸지 않는다.

footer의 `Keys` 토글은 소프트 키 툴바를 열고 닫는다. 이 툴바는 방향키·Tab·Esc·PgUp/PgDn·Ctrl 조합·F 키 등을 버튼으로 노출하고, 각 키는 기존 `Ctrl+C` 버튼과 동일하게 `enqueueInput` → `/remote/v1/terminals/{id}/write` 로 escape 시퀀스를 보낸다(새 endpoint 없음). 방향키·Home·End 는 `terminal.modes.applicationCursorKeysMode` 를 반영해 SS3(`\x1bO`)/CSI(`\x1b[`)를 고른다. 키 버튼(과 footer의 `Ctrl+C`·`Keys` 토글·`Keyboard` 버튼, 헤더 pane 복사 버튼)은 pointer activation의 기본 포커스 이동을 `mousedown`·`pointerdown` 양쪽에서 막아 현재 포커스된 입력 표면(composer 에디터 또는 xterm helper textarea)과 이미 열린 모바일 소프트 키보드를 유지하되, 접근성·물리 키보드 activation을 위해 실제 전송은 `click` 경로로 처리한다. WebKit/iOS 는 `pointerdown` preventDefault 로 포커스 이동을 막지 못하므로 `mousedown` 도 함께 막는 것이 핵심이다(공유 `preventFocusSteal`/`keepInputSurfaceFocus` 헬퍼, [#482](https://github.com/kochul2000/laymux/issues/482)). Navigation 세트의 `↕↔` 방향 패드는 누르는 동안 상·우·하·좌 힌트를 표시하고, 18px 이상 flick한 우세 방향을 기존 방향키 입력 경로로 보낸다. 임계거리 미만의 탭과 취소된 pointer는 입력을 보내지 않는다. 표시 여부·선택 세트(Navigation/Editing/Ctrl keys/Function)·커스텀 키·알려진 전체 키 ID의 `order`는 `localStorage` 키 `laymux.remote.keybar` 에 저장하는 surface-local UI 상태다([ADR-0028](../adr/0028-remote-soft-key-toolbar.md), [ADR-0040](../adr/0040-remote-soft-key-user-order.md)). 실제 표시 순서는 활성 세트와 커스텀 키의 합집합을 `order`로 필터링해 계산한다. 설정 팝오버의 마지막 `Key order` 섹션은 활성 키를 커스텀 팔레트 원본 키와 동일한 크기의 컴팩트 칩 그리드로 보여주며, long-press Pointer Events drag와 삽입 표시선으로 순서를 바꾼다. 칩을 탭하면 `맨 앞`·`왼쪽`·`오른쪽`·`맨 뒤` 보조 동작이 나타나고 `Reset`은 `KEY_ORDER`로 복원한다. 비활성 커스텀 키를 새로 선택하면 현재 활성 키의 맨 뒤에 추가한다. `order`가 없는 기존 저장 값은 정본 `KEY_ORDER`로 보완하고 알 수 없는 ID·중복 ID는 제거한다. 키가 화면 폭보다 많으면 키 행 내부에서만 좌우 스크롤하며 한 줄을 유지하되 scrollbar track은 노출하지 않는다. 설정 버튼도 고정된 별도 영역이 아니라 키들과 같은 스크롤 행의 첫 항목이다. 키 행의 intrinsic width가 문서 폭을 키우지 않도록 app/header/main/footer/key-bar 경계는 `min-width: 0`을 유지한다.

모바일 remote의 app 높이는 `visualViewport.height`를 CSS 변수 `--remote-viewport-height`로 반영한다. 브라우저가 지원하면 viewport meta의 `interactive-widget=resizes-content`도 함께 사용한다. 폭 520px 이하에서는 footer를 한 줄로 유지하기 위해 header와 중복되는 terminal 상태 문구를 숨긴다. 이 값들은 모두 surface-local DOM geometry이며 Remote API/PTY 소유권 계약을 바꾸지 않는다.

terminal host의 geometry 변화는 fit 정책([ADR-0038](../adr/0038-remote-height-shrink-surface-crop.md))을 거친다. xterm은 host 내부의 clipping wrapper 속 sizer 요소에 마운트되고, 폭 변경 또는 높이 증가만 fit + PTY resize를 전파한다. 폭이 그대로인 높이 축소(native keyboard 열림, composer drag, 키바 표시, URL bar)는 normal buffer에서 PTY geometry를 유지한 채 sizer를 마지막 fit 픽셀 높이로 고정하고 host 하단에 정렬해 crop한다 — scrollback reflow형 TUI(Codex CLI 0.128.0+)가 SIGWINCH마다 전체 트랜스크립트를 재출력하는 flood를 막기 위해서다. 커서 행이 crop 창 밖이면 커서가 보일 만큼 sizer를 아래로 이동시켜 커서·IME UI가 화면 밖에 남지 않게 한다. 터치 선택 핸들은 host에 직접 붙어 clipping 밖에 남는다. crop 중에도 새 attach·터미널 전환은 보존된 `cols/rows`를 PTY에 재전송한다(fit 생략과 resize 전송은 별개). alternate buffer는 scrollback flood가 없고 전체 화면 앱이 상단 행을 필요로 하므로 항상 fit을 전파하며, crop 중 buffer 전환이 일어나면 즉시 재평가한다.

`cols/rows`는 surface 로컬 값이 아니라 SIGWINCH로 process에 반영되는 PTY 전역 상태다. 따라서 remote lease가 active인 동안 browser remote의 xterm geometry가 PTY 크기를 결정하고, PC WebView는 로컬 renderer를 유지하되 backend PTY resize를 보내지 않는다. PC가 `reclaim_remote_control`로 제어권을 회수하거나 remote lease가 끝나면 visible `TerminalView`는 공통 write-drain fit을 실행하면서 그 fit의 일반 `onResize` backend 전송을 억제하고, 최종 `cols/rows`를 ConPTY repaint filter로 보호하는 명시적 resize 하나로 동기화한다. backend resize가 성공해야 pending dirty를 지우며, 거부되거나 1초 안에 완료되지 않으면 최신 geometry revision을 100ms 뒤 재시도한다. renderer atlas rebuild와 `refresh()`는 이 fit에 합쳐진다. hidden `TerminalView`는 복구를 dirty로 보류하고 다시 visible이 되는 순간 같은 경로로 소비한다.

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote/v1/terminals` | GET | 현재 backend terminal session 목록 |
| `/remote/v1/terminals/{id}/write` | POST | active `leaseId`로 raw key/protocol/soft-key bytes 전송 |
| `/remote/v1/terminals/{id}/input` | POST | active `leaseId`로 `{text, submit}` structured input 전송 |
| `/remote/v1/terminals/{id}/resize` | POST | active `leaseId`로 PTY 크기 변경 |
| `/remote/v1/terminals/{id}/output?leaseId=...&token=...` | WS | V1 snapshot header/binary pair + sequenced delta pair |

`/remote/v1/terminals` 응답의 각 terminal 항목은 `appearance`를 포함한다. 이 값은 remote
브라우저가 settings 전체를 직접 읽지 않도록 backend가 profile/profileDefaults/colorSchemes에서
해석한 표시 전용 계약이다. 포함 범위는 xterm option으로 바로 적용 가능한 `fontFamily`,
`fontSize`, `cursorStyle`, 선택적 `cursorWidth`, `theme`이며, Windows Terminal 색상 스킴의
`purple`/`brightPurple`은 xterm.js의 `magenta`/`brightMagenta`로 매핑한다. 색상 스킴을 찾을 수
없으면 로컬 `TerminalView`의 기본 테마와 동일한 CampbellClear 기반 fallback을 사용한다.

`write`/`input`/`resize`는 JSON body의 `leaseId` 또는 `X-Laymux-Remote-Lease` 헤더가 현재 active lease와 일치해야 한다. 이 검사는 route의 선행 status 확인이 아니라 Local Tauri command와 공유하는 backend human-control operation permit 등록 시점에 수행한다. permit은 등록 시점의 absolute deadline·owner epoch·operation id와 enqueue phase를 가지며, structured input은 protocol-state gate에서 mode를 캡처한 뒤 PTY control worker 큐 진입 직전에 소유권을 재검증한다. 동일 terminal의 작업은 permit 등록 순서대로 enqueue되므로 structured input 준비 중 뒤에 등록된 raw write/resize가 먼저 PTY에 도착하지 않는다. owner 전환은 아직 enqueue되지 않은 등록 요청을 취소·분리하고, 이미 queued/running인 요청은 per-terminal worker cancel과 completion acknowledgement까지 장벽에 남긴다. PTY handle table/protocol gate/owner gate는 queue wait나 물리 write 동안 잡지 않으며, worker는 physical operation 전후에 owner token을 재검증한다. 취소 adapter가 grace 안에 종료를 증명하지 못하면 해당 PTY를 종료·input-fault 격리하고 worker lifecycle completion을 확인할 때까지 Local owner를 공개하지 않는다. 출력 WebSocket도 `leaseId` 쿼리를 요구한다.

Structured input body는 `{ "leaseId": "...", "text": "...", "submit": true|false }`다. Rust는 LF/CRLF/CR을 CR로 정규화하고 terminal별 authoritative bracketed-paste state가 켜진 경우 text 부분을 `CSI 200~`/`CSI 201~`로 감싼다. `submit=true`의 최종 CR은 bracketed envelope 뒤에 둔다. 최종 인코딩 payload는 공통 1 MiB 상한을 적용한다. Composer는 Send action 하나만 노출하며 항상 `submit=true`를 사용한다. PC WebView와 fine-pointer Remote에서는 일반 Enter가 Send이고 Shift+Enter가 textarea 줄바꿈이다. coarse-pointer Remote에서는 Enter가 줄바꿈이고 Send 버튼만 제출한다. IME 조합 중 Enter는 어느 surface에서도 action이 아니다. Remote soft key와 `Ctrl+C`는 계속 raw `/write`를 사용한다. Direct clipboard paste는 `submit=false`로 `/input`을 사용해 browser xterm의 stale bracketed-paste mirror를 권위 상태로 사용하지 않는다([ADR-0034](../adr/0034-single-send-terminal-composer.md)).

Direct WebSocket output은 첫 frame부터 공통 pair 계약을 쓴다. `TerminalOutputFrameHeaderV1 { type:"terminal.output", version:1, phase:"snapshot"|"delta", seqStart, seqEnd, byteLength, state? }` JSON text frame 바로 뒤에 정확히 한 개의 binary frame을 보낸다. snapshot만 `state { version, snapshotStartSeq, snapshotSeq, protocolRevision, modes:{bracketedPaste} }`를 포함하고, 빈 snapshot도 길이 0 binary frame을 보낸다. Server는 generation-scoped output session에 bounded subscriber를 먼저 등록하고 같은 락 구간에서 state/snapshot을 캡처한다. 그 뒤 polling 없이 subscriber delta를 순서대로 보내며, slow consumer queue overflow·generation retire·sequence gap이면 socket을 닫아 client가 새 snapshot으로 attach하게 한다. Cloud host도 같은 output session subscription을 쓰고 M5 metadata로 공통 계약을 relay에 전달한다.

Remote 입력 UI의 명시적 선호는 `laymux.remote.inputMode`에만 저장한다. 저장값이 없으면 coarse pointer는 composer, fine pointer는 direct가 기본이다. terminal별 현재 모드와 draft/revision/in-flight token은 페이지 runtime Map에만 있고 reload 시 사라진다. V1 snapshot state와 synthetic 최종 mode 적용이 끝나기 전에는 composer action과 Direct clipboard paste를 fail-closed한다. PC WebView도 동일한 상태 전이 계약을 사용하되 선호 키는 `laymux.desktop.inputMode`, 최초 기본값은 direct이며 Tauri `write_terminal_input`/`attach_terminal_output`/`terminal-output-v2-{id}` 계약을 사용한다.

터미널 종료는 control worker를 먼저 닫고 graceful window 동안 PTY master close를 bounded 재시도한다. resize 같은 control 작업이 master mutex를 잠시 보유해 첫 `try_lock`이 실패해도 이후 close로 EOF/HUP를 전달할 기회를 유지하며, window 안에 child가 종료되지 않을 때만 process-tree 강제 종료로 진행한다.

Remote page는 heartbeat와 output WebSocket을 별도 failure domain으로 취급한다. Heartbeat가 `401`/`403`/`409`처럼 권한·lease 상실을 명시하면 즉시 local control로 돌려주지만, 일시적 fetch 실패는 `heartbeatTimeoutSeconds`가 지날 때까지 재시도한다. Heartbeat는 최대 5초마다 보내고 실패 시 1초 뒤 빠르게 재시도하며, 개별 request는 최대 4초에 abort하므로 pending request 하나가 lease 유예 전체를 소진하지 않는다. Output WebSocket close/error는 곧바로 lease를 반납하지 않고, heartbeat가 active lease를 유지하는 동안 같은 terminal output stream을 지수 backoff로 다시 연다. 두 경로의 일시 오류 표시는 2초간 보류해 그 안에 복구되면 기존 연결 문구와 terminal surface를 그대로 유지한다. Output 재접속 중에도 기존 surface를 보존하고, 서버가 보내는 첫 V1 snapshot header/binary pair를 검증한 뒤 적용 직전에만 reset하여 tail 중복을 막는다. 헤더/바이너리 길이·phase·state 범위·sequence가 어긋나면 stream 전체를 버리고 재attach한다. 서버가 기존 lease 상실을 확정한 뒤에는 새 lease를 자동 claim하지 않는다([ADR-0027](../adr/0027-remote-connection-graceful-recovery.md)).

---

## 14. Rust 코드 설계 원칙
> 추가: 2026.04.05

### 14.1 모듈 구조 원칙

**단일 책임**: 하나의 파일은 하나의 명확한 책임을 갖는다. 파일이 500줄을 넘으면 분할을 고려한다.

**디렉토리 = 도메인**: 관련 코드가 3개 이상의 파일로 분할될 때 디렉토리로 승격한다. `mod.rs`는 `pub use` 재수출 허브로만 사용하며, 로직을 포함하지 않는다.

**의존 방향**: 유틸리티(`error`, `lock_ext`, `constants`, `path_utils`, `osc`) → 도메인(`terminal`, `settings`, `activity`) → 진입점(`commands`, `automation_server`). 역방향 의존 금지.

> **목표 구조**: 리팩토링 완료 후 최종 형태. 현재 코드베이스는 이 구조로 점진적으로 전환 중이다.

```
src-tauri/src/
├── lib.rs                    # Tauri 앱 초기화, 모듈 선언
├── error.rs                  # AppError — 통합 에러 타입
├── lock_ext.rs               # MutexExt — 락 헬퍼
├── constants.rs              # 이벤트명, 환경변수명, 공통 상수
├── path_utils.rs             # 경로 변환 (WSL ↔ Windows ↔ Linux)
├── osc.rs                    # OSC 이스케이프 시퀀스 파싱 (iter_osc_events)
├── osc_hooks.rs              # OSC 훅 시스템 (조건/액션 모델, 프리셋, match_hooks)
├── activity.rs               # 터미널 활동 상태 감지
├── claude_activity.rs        # Claude 앱 전용 활동 분기 (타이틀 상태머신 등)
├── codex_activity.rs         # Codex 앱 전용 활동 분기
├── claude_bullet.rs          # Claude Code 상태 메시지 추출 + ANSI 스트리핑
├── process_tree.rs           # PTY 자식 프로세스 트리 liveness (ADR-0009)
├── pty_trace.rs              # PTY/커서 트레이스 (LAYMUX_PTY_TRACE / LAYMUX_CURSOR_TRACE)
├── crash_reporter.rs         # 크래시 리포트
├── state.rs                  # AppState — 전역 상태
├── cli/                      # lx CLI 서브커맨드 파서/로직
├── bin/lx.rs                 # lx CLI 바이너리 진입점
├── commands/                 # Tauri IPC 커맨드 (프론트엔드 진입점)
│   ├── mod.rs                # pub use 허브 (로직 없음)
│   ├── terminal.rs           # 터미널 생명주기 (create/close/resize/write)
│   ├── viewer_startup.rs     # 외부 viewer 매핑 검증·경로 변환·shell quoting
│   ├── ipc_dispatch.rs       # LX CLI 메시지 라우팅 + CWD 동기화
│   ├── claude_session.rs     # Claude Code 세션 감지 + 프로세스 트리
│   ├── file_ops.rs           # 파일 뷰어, 디렉토리 목록
│   └── misc.rs               # 설정, 알림, 클립보드, GitHub, 캐시 등
├── settings/                 # 설정 모델·로드 복구·LLM용 엄격 쓰기 계약
│   ├── mod.rs                # pub use 허브 (io/migration/memo 로직 일부 포함)
│   ├── models.rs             # 구조체/enum 정의
│   ├── validation.rs         # 기존 settings.json 로드 복구·경고
│   ├── contract.rs           # patch 병합·revision·diff·마스킹·schema 응답
│   ├── schema.rs             # 의미·권한·민감도·적용 시점 메타데이터
│   ├── semantic_validation.rs # MCP/Automation 쓰기용 엄격 의미 검증
│   └── (목표) io.rs · migration.rs · memo.rs  # 아직 분할 전 — 점진 전환 대상
├── automation_server/        # Automation HTTP API (axum)
│   ├── mod.rs                # 서버 시작, 라우터 빌드, IP allowlist 미들웨어
│   ├── types.rs              # 요청/응답 타입, REGISTERED_ROUTES
│   ├── handlers_backend.rs   # 백엔드 직접 처리 핸들러
│   ├── handlers_bridge.rs    # 프론트엔드 브릿지 핸들러
│   ├── helpers.rs            # bridge_request, JSON 응답 헬퍼
│   ├── settings_bridge.rs    # frontend settings snapshot/apply 공통 브리지·쓰기 직렬화
│   ├── mcp.rs                # 내장 MCP 서버 (release tool 37종 + resource 핸들러, §12.7)
│   └── mcp_resources.rs      # MCP Resources URI 모델·구독 레지스트리
├── terminal/mod.rs           # 터미널 모델 (TerminalSession, Config, Notification)
├── pty.rs                    # PTY 스폰 및 I/O
├── clipboard.rs              # 클립보드 (smart paste, 이미지)
├── ipc_server.rs             # IPC 소켓 (lx CLI ↔ IDE)
├── output_buffer.rs          # 터미널 출력 링 버퍼
├── port_detect.rs            # 리스닝 포트 감지
├── git_watcher.rs            # Git 브랜치 감지
└── process.rs                # headless_command (Windows CREATE_NO_WINDOW)
```

### 14.2 에러 처리

**통합 에러 타입**: `AppError` enum을 사용한다. `thiserror`로 파생하며, Tauri command 호환을 위해 `Into<String>` 변환을 제공한다.

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Lock poisoned: {0}")]
    Lock(String),
    #[error("Session '{0}' not found")]
    SessionNotFound(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}
```

**`unwrap()` 정책**:
- 프로덕션 코드: `unwrap()` 금지. `?` 연산자 또는 `unwrap_or_default()` 사용
- 테스트 코드: `unwrap()` 허용 (실패 시 명확한 panic이 테스트 의도)
- 초기화 코드(lib.rs setup): `expect("이유 설명")` 허용 (복구 불가능한 상태)

### 14.3 락 관리

**`MutexExt` 트레이트**: 모든 `Mutex::lock()` 호출은 `lock_or_err()` 헬퍼를 사용한다.

```rust
// ❌ 금지 — 보일러플레이트 반복
state.terminals.lock().map_err(|e| format!("Lock error: {e}"))?;

// ✅ 사용
use crate::lock_ext::MutexExt;
state.terminals.lock_or_err()?;
```

**락 획득 순서**: `state.rs`에 문서화된 번호 순서를 반드시 따른다. 역순 획득은 데드락을 유발한다.

```
1. terminals → 2. terminal-output session registry →
3. terminal_protocol_states / per-terminal protocol gate →
4. output_buffers / per-terminal output ring →
5. known_claude_terminals → 6. known_codex_terminals →
7. last_detected_interactive_app → 8. recently_exited_interactive_app →
9. notifications → 10. sync_groups → 11. propagated_terminals →
12. pty_handles / automation_channels / automation_port / ipc_socket_path →
13. remote_access → 14. remote_control → 15. cloud_tunnel →
16. cloud → 17. exec_locks(table mutex only)
```

**콜백 내 락**: PTY 콜백 등 비동기 콜백에서는 독립적으로 락을 획득한다. 호출자의 락을 전달하지 않는다.

### 14.4 상수 관리

**`constants.rs`에 중앙화**: Tauri 이벤트명, 환경변수명, 타임아웃, 버퍼 크기 등 모든 매직 값을 `constants.rs`에 정의한다.

```rust
// ❌ 금지 — 문자열 리터럴 직접 사용
app.emit("terminal-cwd-changed", payload);
env.push(("LX_SOCKET".to_string(), path));

// ✅ 사용
use crate::constants::*;
app.emit(EVENT_TERMINAL_CWD_CHANGED, payload);
env.push((ENV_LX_SOCKET.to_string(), path));
```

**예외**: 해당 모듈에서만 사용되는 내부 상수는 모듈 내에 정의해도 된다.

### 14.5 코딩 스타일

**네이밍**:
- 모듈/파일: `snake_case` (Rust 표준)
- 구조체/enum: `PascalCase`
- 함수/변수: `snake_case`
- 상수: `SCREAMING_SNAKE_CASE`

**Serde 규칙**:
- 프론트엔드와 교환하는 모든 타입에 `#[serde(rename_all = "camelCase")]` 적용
- Option 필드에 `#[serde(skip_serializing_if = "Option::is_none")]`
- 기본값이 있는 필드에 `#[serde(default)]` 또는 `#[serde(default = "fn_name")]`

**플랫폼 분기**: `#[cfg(target_os = "windows")]` / `#[cfg(not(target_os = "windows"))]`를 사용한다. 긴 플랫폼별 코드는 별도 함수로 추출하고 `cfg` 어트리뷰트를 함수 수준에 적용한다.

**프로세스 실행**: `std::process::Command::new()` 대신 반드시 `crate::process::headless_command()`를 사용한다. (Windows 콘솔 창 깜빡임 방지)

**로깅**: `eprintln!()` 대신 `tracing` 매크로를 사용한다.
```rust
// ❌ 금지
eprintln!("[claude-session] PID tree match failed: {e}");

// ✅ 사용
tracing::warn!(terminal_id, error = %e, "PID tree match failed, using CWD fallback");
```

### 14.6 Tauri Command 패턴

**반환 타입**: 모든 `#[tauri::command]`는 `Result<T, String>`을 반환한다. 내부에서 `AppError`를 사용하되, Tauri 경계에서 `String`으로 변환한다.

**State 접근**: `State<Arc<AppState>>`로 받는다. 커맨드 함수는 얇은 진입점으로, 핵심 로직은 `&AppState`를 받는 내부 함수로 분리하여 테스트 가능하게 한다.

```rust
// Tauri command — 얇은 진입점
#[tauri::command]
pub fn get_terminal_summaries(
    terminal_ids: Vec<String>,
    state: State<Arc<AppState>>,
) -> Result<Vec<TerminalSummaryResponse>, String> {
    get_terminal_summaries_inner(&terminal_ids, &state)
        .map_err(|e| e.to_string())
}

// 내부 함수 — 테스트 가능
pub fn get_terminal_summaries_inner(
    terminal_ids: &[String],
    state: &AppState,
) -> Result<Vec<TerminalSummaryResponse>, AppError> { ... }
```

**`pub use` 재수출**: `commands/mod.rs`는 서브모듈을 `pub use *`로 재수출하여, `lib.rs`의 `generate_handler![]` 매크로가 `commands::function_name`으로 참조할 수 있게 한다. 서브모듈 분할 시에도 외부 인터페이스는 변하지 않는다.

### 14.7 Automation API 패턴

**핸들러 분류**:
- **Backend-only**: AppState를 직접 조작 (터미널 write/output, 헬스체크)
- **Frontend-bridge**: Tauri 이벤트로 프론트엔드에 위임 후 oneshot 채널로 응답 수신

**응답 헬퍼**: `ok_json()`, `err_json()`, `ok_json_data()` 헬퍼를 사용하여 응답 형식을 통일한다.

**라우트 등록**: `REGISTERED_ROUTES` 상수와 `build_router()`의 라우트가 1:1 대응해야 한다. e2e 테스트로 이 일치를 검증한다.

### 14.8 테스트 전략

**단위 테스트**: 각 모듈 파일 하단의 `#[cfg(test)] mod tests` 블록에 작성한다. 모듈이 분할되면 테스트도 해당 모듈로 이동한다.

**e2e 테스트**: `src-tauri/tests/` 디렉토리에 작성한다. Settings round-trip, 터미널 상태, 클립보드 등 통합 시나리오를 검증한다.

**테스트 격리**: `tempfile::tempdir()`로 파일시스템 테스트를 격리한다. 전역 상태에 의존하는 테스트는 `#[serial_test::serial]`을 사용한다.

---

## 15. UI 코드 설계 원칙

### 15.1 스타일링

| 규칙 | 설명 |
|------|------|
| CSS 변수 우선 | 모든 공통 값(색상, 간격, 반경, 폰트 크기, hover overlay)은 `index.css` `:root`에 CSS 변수로 정의한다. 하드코딩된 매직 넘버를 직접 사용하지 않는다. |
| Tailwind + CSS 변수 하이브리드 | 레이아웃(flex, grid, spacing)은 Tailwind 유틸리티 클래스, 테마 의존 값(색상, 배경)은 `style={{ }}` 내 CSS 변수로 지정한다. |
| 인라인 스타일 제한 | 인라인 `style`은 CSS 변수 참조, 동적 계산값, 조건부 스타일에만 사용한다. 정적 값은 Tailwind 클래스 또는 CSS 클래스를 사용한다. |
| `color-mix()` 금지 | html2canvas가 파싱하지 못해 스크린샷 API가 깨진다. `var(--accent-50)` 등 사전 정의된 CSS 변수를 사용한다. |

### 15.2 호버/인터랙션

- `onMouseEnter`/`onMouseLeave`에서 `e.currentTarget.style.background`를 직접 조작하지 않는다.
- CSS 호버 클래스(`.hover-bg`, `.hover-bg-strong` 등)를 사용한다.
- 상태 기반 스타일(active, selected 등)은 조건부 className 또는 CSS 변수로 처리한다.

### 15.3 공유 컴포넌트

- 재사용 가능한 UI 요소(Modal, FormControls, Separator 등)는 `components/ui/`에 배치한다.
- **3곳 이상** 동일 패턴이 반복되면 공통 컴포넌트로 추출한다.
- 새 View 추가 시 기존 공유 컴포넌트를 우선 검토하고, 없으면 인라인으로 작성 후 반복이 확인되면 추출한다.

### 15.4 컴포넌트 설계

- View 내부의 로컬 서브 컴포넌트(`BarBtn`, `Sep` 등)는 같은 파일 내에 정의한다. 단, 2개 이상의 파일에서 사용되면 공유 모듈로 승격한다.
- Props에 `data-testid`를 전달할 수 있도록 `testId` prop을 지원한다.
- 스타일 상수(높이, 반경 등)는 컴포넌트 파일 상단에 `const`로 선언하되, CSS 변수로 정의된 토큰이 있으면 그것을 사용한다.

### 15.5 키보드 단축키 설계 원칙

**기능 구현에 키 조합을 하드코딩하지 않는다.** 단축키는 사용자가 언제든 재바인딩할 수 있으므로, 기능 코드에서 특정 키 조합(예: `e.ctrlKey && e.key === 'c'`)을 직접 검사하면 커스터마이징이 불가능해진다.

| 규칙 | 설명 |
|------|------|
| 이벤트/액션 기반 설계 | 기능은 **액션(이벤트)에 반응**하도록 구현한다. 키 입력 → 액션 변환은 중앙 키바인딩 시스템(`useKeyboardShortcuts`, `lx-shortcuts`)이 담당한다. |
| 컴포넌트 내 `e.key` 직접 검사 금지 | `onKeyDown`에서 `e.ctrlKey && e.key === 'x'` 같은 수정자+키 조합을 직접 검사하지 않는다. 네비게이션 키(`ArrowUp/Down`, `Enter`, `Escape`, `Tab`)만 컴포넌트 내에서 허용한다. |
| 새 단축키 추가 시 | `settings.json`의 `keybindings` 배열에 기본값을 등록하고, 키바인딩 시스템에서 액션을 디스패치한다. 컴포넌트는 그 액션만 구독한다. |
| 모든 단축키는 오버라이드 가능 | 모든 단축키는 `settings.json`의 `keybindings`에서 사용자가 재바인딩할 수 있어야 한다. 새 단축키 추가 시 **SettingsView의 Keybindings UI에도 반드시 반영**한다 (`defaultKeybindings` 배열 + 표시 라벨). Settings UI에 나타나지 않는 단축키는 존재하지 않는 것과 같다. |

#### 키바인딩 vs 시스템 이벤트 구분

입력을 처리할 때 **키바인딩**과 **시스템 이벤트**를 구분한다. 두 가지는 설계 경로가 완전히 다르다.

| 구분 | 키바인딩 | 시스템 이벤트 |
|------|---------|-------------|
| 결정 주체 | 사용자 (오버라이드 가능) | OS (오버라이드 대상 아님) |
| 구현 | `keybinding-registry` + `matchesKeybinding()` | 브라우저 이벤트 리스너 (`copy`, `paste` 등) |
| Settings UI | 반드시 표시 | 표시하지 않음 |
| 예시 | `Ctrl+Enter` 이슈 제출, `Ctrl+Alt+N` 새 워크스페이스 | 복사(`copy` event), 붙여넣기(`paste` event) |

```typescript
// ❌ 금지 — 키 조합으로 시스템 동작 감지
if (e.ctrlKey && e.key === "v") { smartPaste(); }
if (e.ctrlKey && e.key === "c") { copySelectedPaths(); }

// ✅ 시스템 이벤트 — OS가 트리거하는 이벤트를 리슨
container.addEventListener("paste", (e) => { smartPaste(); });
container.addEventListener("copy", (e) => { copySelectedPaths(); });

// ✅ 키바인딩 — 레지스트리에 등록, Settings UI에 반영
if (matchesKeybinding(e, "issueReporter.submit")) { handleSubmit(); }
```

##### 예외: 터미널 copy/paste는 키바인딩으로 통합

터미널(xterm.js)에서는 전통적으로 Linux 환경에서 `Ctrl+Shift+C`/`Ctrl+Shift+V`를
복사/붙여넣기로 쓰는 관행이 있어, 복사/붙여넣기도 **키바인딩으로 재바인딩할 수
있어야 한다**. 따라서 터미널은 시스템 `copy`/`paste` 이벤트 리스너를 두지 않고,
`terminal.copy` / `terminal.paste` 키바인딩 한 경로로 통합한다.

- `terminal.copy`/`terminal.paste`를 키바인딩 레지스트리에 등록(기본 `Ctrl+C`/`Ctrl+V`).
- `attachCustomKeyEventHandler`에서 `matchesKeybinding("terminal.copy/paste")`로
  감지하여 `smartPaste`/`clipboardWriteText`를 직접 호출한다 — 기본값/오버라이드
  구분 없이 동일 경로.
- `Ctrl+C`는 선택 영역이 없을 때만 xterm에 위임해 SIGINT를 그대로 전달한다(선택 상태로만
  판단, 키 조합을 하드코딩하지 않음).
- 우클릭 경로(`handleContextMenu`)도 같은 헬퍼(`runTerminalPaste`)를 재사용한다.
- **다중 파일 붙여넣기 (#325):** 클립보드에 파일이 여러 개(CF_HDROP)면 Rust
  `smart_paste`가 `SmartPasteResult.paths`로 전체 경로 목록(WSL 프로파일이면 경로
  변환 적용)을 반환하고, 프론트(`formatPastePaths`)가
  `paste.pathSeparator`("space" 기본 | "newline" | "comma" |
  "semicolon") 구분자로 연결한다. `paste.pathQuote`가 켜져 있으면 각
  경로를 큰따옴표로 감싼다(공백 포함 경로 대응). 두 설정 모두 Settings UI
  Paste 섹션에 노출된다.
- 이 예외는 터미널에 한정한다. 파일 탐색기 등 다른 컴포넌트의 copy/paste는 여전히
  시스템 이벤트 전용이다.

### 15.6 앱 전용 편의 코드 격리

각 앱 activity 타입별로 **ActivityHandler** 클래스를 구현하여 notification, status, statusMessage 계산을 분기한다. 원시 상태는 공통으로 저장하고, activity 타입에 따라 해당 핸들러가 최종 표시를 도출한다.

#### ActivityHandler 인터페이스

```typescript
interface ActivityHandler {
  computeStatus(raw: RawTerminalState): StatusResult;        // 아이콘, 색상
  computeStatusMessage(raw: RawTerminalState): string;       // 표시 텍스트
  computeNotification(raw: RawTerminalState): Notification | null;  // 알림 발생 여부/내용
}
```

#### 핸들러 등록

```typescript
const handlers: Record<string, ActivityHandler> = {
  default: new ShellActivityHandler(),     // 셸 기본 (OSC 133 기반)
  Claude: new ClaudeActivityHandler(),     // Claude Code 최적화
  // 향후: neovim, htop 등 추가 가능
};

function getHandler(activity?: Activity): ActivityHandler {
  return handlers[activity?.name] ?? handlers.default;
}
```

#### 격리 규칙

- 각 핸들러는 독립 모듈 파일에 구현한다 (`shell-activity-handler.ts`, `claude-activity-handler.ts`).
- 핸들러를 import하지 않으면 해당 앱 전용 로직이 완전히 제거되어야 한다.
- 핸들러 추가 시 기존 핸들러의 테스트가 깨지지 않아야 한다.
- 핸들러 동작은 설정으로 조절 가능하게 한다 — 현재는 Claude 상태 메시지 구성을 `claude.statusMessageMode`/`statusMessageDelimiter`(§10)가 제어한다. 핸들러 전체를 default 로 폴백시키는 플래그는 아직 없다(필요해지면 추가).
