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

### 로딩 실패와 부분 복구

`load_settings_validated`(`settings/mod.rs`)는 파일을 4가지 상태 중 하나로 판정해 프론트엔드에 넘긴다([ADR-0119](../adr/0119-settings-type-error-partial-recovery.md)).

| status | 언제 | settings 값 | 프론트 동작 |
| --- | --- | --- | --- |
| `ok` | 문제 없음 | 파일 그대로 | 정상 |
| `repaired` | 구조 문제를 `validate_and_repair` 가 고침 | 수정본 | 모달 알림, 저장 허용 |
| `recovered` | 타입 오류 경로를 드롭하고 기본값으로 대체 | 나머지는 파일 그대로 | 모달 알림 + **저장 차단**(확인 시 해제) |
| `parse_error` | JSON 구문 오류·중복 객체 키 또는 최상위가 객체가 아님 | 전부 기본값 | 모달 알림 + 저장 영구 차단 |

**타입 오류 부분 복구.** 값 하나의 타입이 틀렸다고 파일 전체를 버리지 않는다. `settings/lenient.rs` 는 객체 키 중복을 먼저 검사해 앞 값이 `serde_json::Value` 변환에서 조용히 덮이는 일을 막고, 중복이 없을 때만 `Value` 로 읽는다. 이후 `serde_path_to_error` 로 타입 실패 경로를 얻어 그 경로를 트리에서 **제거**한 뒤 재시도한다. 제거된 필드는 자신의 `#[serde(default)]` 로 채워지므로 복구 경로는 기본값 테이블을 따로 갖지 않는다. 값 보정(`"2"` → `2`)은 하지 않는다. 객체 필드는 키를, 배열 원소는 원소를 제거하며, 기본값이 없는 필수 필드가 깨지면 손실이 부모로 번진다(예: pane 의 `view.type` 타입 오류 → 그 pane 하나가 사라짐). 배열 원소가 여러 번 제거되어도 경고 경로의 인덱스는 축소된 중간 배열이 아니라 원본 파일 위치를 가리킨다. 제거 횟수 상한은 2,000이다.

**손실 정책.** 드롭이 한 건이라도 있으면 `recovered` 상태가 되고, `useSessionPersistence` 가 `setBlockPersist(true)` 로 공유 쓰기 차단 상태를 켠 채 기동한다. `saveSettings` 경계가 세션 영속과 Automation `settings.applySnapshot`을 포함한 모든 일반 `settings.json` 쓰기에 이 상태를 강제하며, 원본을 의도적으로 대체하는 `resetSettings`만 우회한다. 사용자가 `SettingsRecoveryModal` 에서 확인을 누를 때 차단이 풀린다 — 그전까지는 레이아웃 변경도 저장되지 않으며 원본 파일은 손대지 않는다. 로더 자체는 어떤 경우에도 복구 결과를 디스크에 되쓰지 않는다. 모달은 드롭된 경로를 전부 나열한다(개수 요약만으로는 무엇을 잃었는지 알 수 없다).

### 터미널 capability 광고

```jsonc
{
  "terminal": {
    "advertiseTrueColor": true // 기본값. 새 PTY 자식에 COLORTERM=truecolor 광고
  }
}
```

`terminal.advertiseTrueColor`는 전역 Boolean 설정이며 Settings → Terminal에서 편집한다
([ADR-0052](../adr/0052-truecolor-capability-advertising-setting.md)). Rust serde와 프론트엔드
settings store 모두 누락값을 `true`로 보완한다. 저장 시점의 값은 터미널 세션 생성 때
`TerminalConfig.advertise_true_color`로 snapshot되므로 실행 중 PTY 환경은 바뀌지 않고,
저장 이후 새로 생성하거나 재시작한 PTY부터 적용된다. 프로필별 override는 없다.
Automation/MCP settings metadata의 apply mode도 이 경계를 그대로 나타내는 `nextUse`다.

`true`이면 PTY 환경 계획이 `COLORTERM=truecolor`를 Set한다. `false`이면 부모 프로세스나
명시적 세션 환경에서 상속된 값까지 Unset하여 opt-out을 결정적으로 적용한다. 어느 값이든
`TERM_PROGRAM=laymux`와 `TERM_PROGRAM_VERSION=<package version>`은 Set하고,
`WT_SESSION`/`WT_PROFILE_ID`는 Unset하며, `TERM`/`NO_COLOR`/`FORCE_COLOR`는 보존한다.
native 셸은 `CommandBuilder::env`/`env_remove`, WSL은 같은 mutation의 rcfile
`export`/`unset`을 사용한다. WSL rcfile은 `.bashrc` 전후에 계약을 적용하고 `WSLENV` 전체를
버리지 않고 제거 대상 항목만 정리한다.

### xterm parser admission 클래스 몫

```jsonc
{
  "terminal": {
    "parserAdmission": {
      "focusedShare": 5, // 활성 workspace 의 focused pane
      "visibleShare": 3, // 활성 workspace 의 나머지 visible pane 전체
      "hiddenShare": 2 // hidden pane(비활성 workspace·0 px track) 전체
    }
  }
}
```

`terminal.parserAdmission`은 앱 전역 xterm parser admission turn 을 **pane 단위가 아니라 클래스 단위**로 나누는 비율이다([ADR-0101](../adr/0101-active-workspace-weighted-parser-admission.md)). 세 값은 상대값이고 합이 한 admission cycle 이므로 기본값 `5/3/2`는 focused 50%, 활성 workspace 의 나머지 visible 30%, hidden 전체 20%를 뜻한다. 클래스 안에서는 pane 들이 round-robin 으로 돌아가므로 hidden pane 이 3개든 300개든 활성 workspace 몫은 변하지 않는다.

**Settings UI 는 없다** — settings.json 직접 편집 전용 튜닝 값이다. 각 값의 유효 범위는 `1..=1000`이고 `validate_settings`가 범위를 벗어난 값을 `/terminal/parserAdmission/<field>` 경로로 보고한다. `0`은 그 클래스의 parser 를 멈추는 뜻이 되므로 허용하지 않으며, Rust `ParserAdmissionSettings::sanitized()`와 프론트엔드 `sanitizeTerminalWriteClassShare()`가 같은 범위로 clamp 한다. 기본값·범위 상수는 Rust `constants.rs`(`PARSER_ADMISSION_*`)와 `terminal-write-fair-scheduler.ts`(`TERMINAL_WRITE_DEFAULT_CLASS_SHARE`, `TERMINAL_WRITE_MIN_CLASS_SHARE`, `TERMINAL_WRITE_MAX_CLASS_SHARE`)에 각각 한 곳씩 있다.

값 오류는 종류별로 처리가 다르다. **누락**은 `#[serde(default)]`와 프론트 기본값으로 채운다. **범위 밖 수치**는 양쪽에서 clamp 한다. **타입 오류**(`"2"`, `null`, 소수)는 이 필드만 드롭되어 기본값으로 대체되고 나머지 설정은 그대로 살아남는다 — 이 필드 전용 규칙이 아니라 `Settings` 전체에 균일하게 적용되는 로딩 정책이다(위 [로딩 실패와 부분 복구](#로딩-실패와-부분-복구), [ADR-0119](../adr/0119-settings-type-error-partial-recovery.md)). 프론트엔드 sanitizer 는 이미 로드된 snapshot 에 비수치 값이 들어 있을 때 그 항목만 기본값으로 되돌린다.

극단 비율을 넣어도 한 클래스가 무한정 밀리지 않는다. pending 클래스는 몫과 무관하게 `TERMINAL_WRITE_CLASS_MAX_SKIPPED_TURNS`(32) turn 안에 반드시 한 turn 을 받는다. 기본값에서는 몫이 만드는 간격(hidden 최대 5 turn)이 늘 먼저 도달하므로 이 floor 는 극단 설정과 클래스 drain/재진입에서만 작동한다.

적용 시점은 저장 직후 다음 admission turn 이다. 프론트엔드는 `useTerminalParserAdmissionSettings`가 store 변경을 구독해 scheduler 에 넣으며, 진행 중인 physical write 를 선점하거나 xterm 을 재생성하지 않는다. 클래스 몫이 바뀌면 이전 몫으로 계산된 balance 는 폐기해 새 비율로 다음 cycle 을 시작한다.

### 휠 스크롤 민감도

```jsonc
{
  "terminal": {
    "scrollSensitivity": 1, // 데스크톱 터미널 휠 배율. 기본 1(xterm 기본값)
    "fastScrollSensitivity": 5 // Alt 를 누른 채 굴릴 때의 배율. 기본 5
  },
  "remote": {
    "scrollSensitivity": 1, // 원격 브라우저 터미널 휠 배율
    "fastScrollSensitivity": 5,
    "touchScrollSensitivity": 1 // 손가락 드래그 스크롤백 배율. 1 = 1:1 물리 스크롤
  }
}
```

두 쌍은 **표면별로 따로 소유**한다([ADR-0142](../adr/0142-wheel-scroll-sensitivity-per-surface.md)) — `terminal.*` 는 데스크톱 xterm 만, `remote.*` 는 Remote 브라우저 xterm 만 정하며 서로 상속·동기화하지 않는다. 편집 UI 는 각각 Settings → **Terminal** 과 Settings → **Remote** 다.

유효 범위는 `0.1..=20`, 상수는 Rust `constants.rs`(`MIN/MAX/DEFAULT_SCROLL_SENSITIVITY`, `DEFAULT_FAST_SCROLL_SENSITIVITY`)와 프론트 `lib/scroll-sensitivity.ts` 에 각각 한 곳씩 있다. **비양수·비수치는 clamp 대상이 아니라 기본값 fallback 대상**이다 — xterm 이 비양수 sensitivity 에 throw 하기 때문이며, 양수인데 범위를 벗어난 값만 경계로 clamp 한다. `validate_settings` 는 범위 밖 값을 `/terminal/scrollSensitivity`·`/remote/fastScrollSensitivity` 등 경로로 `out_of_range` 보고하고, 실행 경로는 그와 별개로 항상 정규화한다(parserAdmission 과 같은 "보고 + clamp" 정책).

일반 scrollback 은 xterm viewport 가 연속 휠 델타에 배율을 적용한다. 반면 alternate buffer의 커서키 fallback과 마우스 트래킹 TUI는 행 단위 입력만 받을 수 있으므로, 고정 xterm 6.0.0 번들은 `consumeWheelEvent`가 계산한 행 수를 버리지 않고 **그 수만큼 커서키/마우스 보고를 반복**한다. `0.1` 같은 소수 배율은 pane별 remainder에 누적해 합이 한 행에 도달했을 때 전송한다. 이 보정은 postinstall exact-pattern patch로 데스크톱 ESM·CommonJS 번들과 Remote 정적 CommonJS 번들에 함께 적용하며, 패턴이 달라지면 설치를 실패시킨다. 실제 번들의 alternate-buffer·mouse-reporting 동작은 `xterm-semantics.screen.test.ts`가 고정한다.

적용 시점은 다르다. 데스크톱은 **live** — 저장 즉시 실행 중인 xterm 옵션에 반영하며 fit·레이아웃을 건드리지 않는다. Remote 는 **nextUse** 로, 값이 per-terminal `appearance` payload(§Remote terminals)에 실려 다음 attach 의 `terminalOptionsForAppearance`/`applyTerminalAppearance` 에서 적용된다. 원격 클라이언트는 필드가 없거나(구버전 데스크톱) 비정상이면 자기 기본값(1/5/1)으로 떨어진다.

`remote.touchScrollSensitivity`(기본 1)는 **xterm 옵션이 아니다**. Remote 페이지가 소유한 손가락 드래그 스크롤백의 픽셀→행 환산에서 입력 델타에 한 번 곱하며(`scrollTouchTerminal`), 하위 셀 나머지(`scrollRemainderPx`)에는 다시 곱하지 않는다. 옵션 번들 대신 페이지 지역 상태(`adoptTouchScrollSensitivity`)가 들고 있으며 appearance 가 적용되는 두 지점(터미널 생성·appearance 갱신)에서 갱신된다 — xterm 은 모르는 옵션 키를 거부한다. 한 손가락·두 손가락 드래그 모두 같은 값을 쓰고, **마우스 트래킹을 켠 전체화면 TUI 에서는 드래그가 합성 wheel 이벤트로 앱에 전달되므로 `remote.scrollSensitivity` 가 적용된다**(두 배율을 겹쳐 곱하지 않는다).

### 경로 링크의 호스트 OS 열기

```jsonc
{
  "terminal": {
    "pathLinkOsOpenEnabled": true, // 기본값. Ctrl/Ctrl+Shift 클릭으로 호스트 OS 에 위임
    "pathLinkOsOpenConfirm": true // 기본값. 파일을 연결 프로그램으로 열 때마다 확인
  }
}
```

두 Boolean 모두 Settings → Terminal → 파일 경로 링크에서 편집하며, Rust serde 와 프론트엔드
settings store 가 누락값을 `true`로 보완한다([ADR-0100](../adr/0100-path-link-host-os-open-modifier-contract.md)).
`pathLinkOsOpenEnabled` 가 꺼져 있으면 수정자 클릭도 기존 동작(파일=뷰어, 디렉터리=CWD 전파)으로
떨어진다. `pathLinkOsOpenConfirm` 은 **완화만** 할 수 있다 — 꺼도 직접 실행·설치·스크립트 호스트·
레지스트리 병합 확장자(코드 상수 `HARD_CONFIRM_EXTENSIONS`)는 계속 확인을 받는다. 이 하드 클래스는
설정 키로 노출하지 않으므로 설정 patch 로 소거할 수 없다. 확인은 실행으로 이어지는 파일 `open` 에만
적용되고 `reveal` 과 디렉터리 열기에는 적용되지 않는다.

실행 커맨드 `open_in_os(path, wslDistro, mode)` 는 데스크톱 프론트엔드 전용이며 Automation API·MCP
툴·Remote 라우트 어디에도 노출하지 않는다. 원격이 파일 읽기 권한을 호스트 프로세스 실행으로 넓히지
못하게 하는 [ADR-0045](../adr/0045-remote-path-link-reuses-desktop-parser.md) 경계를 그대로 따른다.
`mode` 는 `"open"`/`"reveal"` 두 값만 허용하고 그 외는 오류다. 호스트 경로는 `stat_path` 와 같은
`resolve_address_path_following_symlinks` 로 산출하며, 커맨드는 프로세스 spawn 실패만 오류로
보고한다(Windows `explorer.exe` 는 성공해도 0 이 아닌 종료 코드를 반환하므로 종료 코드를 보지 않는다).

### 사용량 모니터 설정

```jsonc
{
  "usage": {
    "claude": {
      "profile": "", // claude 를 실행할 터미널 프로필. 빈 값이면 defaultProfile
      "refreshSeconds": 600, // 조회 간격. 600 미만은 적용되지 않는다
      "configDirs": [], // 추가로 모니터링할 CLAUDE_CONFIG_DIR 목록 (기본 config dir 은 항상 포함)
      "visibleRows": ["session", "weekAll", "weekModel"], // 모든 UsageView에 표시할 한도 행. 하나 이상 필수
      "colors": { "used": "#d97757", "pace": "#f9e2af", "track": "#585858" }
    },
    "codex": {
      "profile": "", // Codex UsageView의 terminal font profile. 빈 값이면 defaultProfile
      "refreshSeconds": 600, // 로컬 app-server 조회 간격. 600~3600으로 적용
      "configDirs": [], // 별도 로그인한 CODEX_HOME 목록. 기본 CODEX_HOME은 항상 포함
      "visibleRows": ["weekly", "sparkWeekly"], // Weekly limit / Spark Weekly limit. 하나 이상 필수
      "colors": { "used": "#10a37f", "pace": "#f9e2af", "track": "#585858" }
    }
  }
}
```

**에이전트별 수집 경로는 분리한다.** Claude는 profile/config dir를 가진 PTY probe를 쓰며, Codex는 CLI가 제공하는 app-server 계정 API를 쓴다. 두 provider는 원시 snapshot만 만들고 화면 규칙은 공통 `UsagePresentation`이 소유한다.

Codex UsageView의 현재 rate-limit 원천은 `codex app-server`의 로컬 stdio JSON-RPC `account/rateLimits/read`다. 이 호출은 설정·네트워크 listener·사용자 대화 state를 만들지 않는다. 응답에서 직접 얻는 window와 reset epoch만 `get_codex_usage_snapshot` Tauri command로 WebView에 전달한다([ADR-0104](../adr/0104-codex-usage-app-server-probe.md)). `usage.codex.profile`은 화면의 terminal font를, `refreshSeconds`는 local app-server 재조회 간격을 정한다. `configDirs`의 각 경로는 app-server 자식 프로세스의 `CODEX_HOME`으로 전달되며, 사용자는 해당 경로에서 `codex login`을 먼저 실행한다.

`usage.claude.profile` 은 `claude` 가 설치된 셸을 고른다 — WSL 에만 설치했다면 `"WSL"`. 존재하지 않는 프로필이면 구독이 오류로 실패하고 UsageView 푸터에 그대로 표시된다.

`refreshSeconds` 는 **적용 시점에 600~3600 으로 clamp** 된다. 600 초 하한은 Anthropic 의 rate limit 때문이며 설정으로 내릴 수 없다 — 스키마는 값을 거부하지 않고 조용히 올려 적용한다([ADR-0102](../adr/0102-claude-usage-probe-headless-pty.md)). metadata apply mode 는 `nextUse` 다(다음 워커 기동부터 적용).

편집 UI 는 Settings → **Views → 사용량**이다. view 의 데이터 소스 설정이므로 Integrations 의 Claude/Codex(연동 동작) 섹션이 아니라 Views 그룹에 둔다.

`visibleRows`는 같은 provider의 사용량을 그리는 **모든 표면**(UsageView pane 과 상태 위젯)이 공유하는 표시 선택이다. Claude는 session/weekAll/weekModel, Codex는 weekly/sparkWeekly를 쓴다. UI는 마지막 행의 해제를 막고, 비어 있거나 잘못된 값은 provider별 전체 행을 표시하는 기본값으로 정규화한다([ADR-0103](../adr/0103-usage-view-visible-rows.md)).

**`usage.<agent>.colors` 는 에이전트마다 따로 소유한다**([ADR-0105](../adr/0105-widget-slots-and-status-line.md)). 한 status line 에 두 provider 의 막대가 나란히 놓이면 색이 유일한 구분 수단이므로 공통 팔레트로는 읽을 수 없다. 기본값은 각 에이전트가 앱의 다른 곳에서 이미 쓰는 색을 그대로 가져온다 — Claude `#d97757`, Codex `#10a37f`(워크스페이스 선택기의 에이전트 표기색과 같은 값). elapsed 는 provider 중립이라 두 에이전트 모두 노랑 `#f9e2af` 를 기본값으로 쓰며, 바로 위에 놓이는 consumed 막대와 혼동되지 않을 만큼 두 브랜드색과 떨어져 있다. **기본값이 같을 뿐 CSS 토큰에 묶여 있지 않다** — 사용자가 Views → 사용량에서 에이전트별로 바꿀 수 있고, 테마 전환으로는 바뀌지 않는다.

### 상태 위젯 배치 (widgets)

```jsonc
{
  "widgets": {
    "fontFamily": "", // 빈 값이면 appearance.uiFontFamily 상속
    "fontSize": 9, // 모든 위젯의 공용 글자 크기(px), 6~20
    "topBar": {
      "left": [],
      "right": [
        { "id": "w1", "type": "claudeUsage", "options": { "configDir": "", "display": "both", "barWidth": 26 } }
      ]
    },
    "statusLine": {
      "enabled": false, // 창 최하단 위젯 줄 표시 여부. 꺼도 아래 배치는 보존된다
      "left": [],
      "right": []
    },
    "overflow": "collapse" // 폭 부족 시 정책. 현재 허용값은 collapse 뿐
  }
}
```

**배치의 SoT 는 네 슬롯의 순서 배열이다**([ADR-0105](../adr/0105-widget-slots-and-status-line.md)). 좌·우 붙임은 어느 슬롯에 넣었는지로만 표현하고, 배열 순서가 화면 순서다. 상단 바 슬롯은 항상 존재하며 `statusLine.enabled` 는 하단 영역의 표시 여부만 정한다. 네 슬롯의 기본값은 빈 배열이고 metadata apply mode 는 `live` 다.

`fontFamily`와 `fontSize`는 모든 위젯 표면이 공유하는 typography다([ADR-0107](../adr/0107-widget-typography-and-usage-bar-width.md)). `fontFamily` 기본값 `""`은 인터페이스 글꼴 상속이고, `fontSize` 기본값 9px·허용 범위 6~20px다. Settings 미리보기와 실제 슬롯은 같은 값을 적용하며, 슬롯의 요구 폭 계산도 `fontSize`를 입력으로 받아 큰 글자가 콘텐츠 폭을 넘기기 전에 접힘 예산에 반영한다.

`type` 은 프론트 위젯 레지스트리(`ui/src/components/widgets/registry.ts`)가 정의하는 이름이며 정본 목록은 Rust `constants.rs::WIDGET_TYPES` 다. 두 목록의 일치는 `registry.test.ts` 가 강제한다. 쓰기 경로는 미등록 `type` 과 중복 `id` 를 [ADR-0032](../adr/0032-llm-settings-introspection-and-safe-mutation.md) 대로 거부하고, 이미 디스크에 있던 위반은 `existingIssues` 로 보고하며 값은 보존한다 — 로드는 미등록 위젯을 지우지 않고 렌더만 건너뛴다.

`options` 는 위젯 타입별 값 도메인이다. `claudeUsage` 는 `configDir`(기본 config dir 은 빈 문자열)·`display`·`barWidth`·`barHeight`·`elapsedHeight`, `codexUsage` 는 `display`(`"bar" | "number" | "both"`)·`barWidth`·`barHeight`·`elapsedHeight`, `terminalActivity` 는 `scope`(`"workspace" | "all"`) 를 갖는다. 막대 너비(`barWidth` 기본 26, 8~200px)와 두께(`barHeight` 기본 4, `elapsedHeight` 기본 2, 둘 다 1~10px)는 **인스턴스마다** 정한다 — 같은 계정이라도 상단 바와 status line 은 보는 거리가 달라 같은 크기가 맞지 않는다. `barWidth`는 consumed·elapsed 두 track과 슬롯 요구 폭 계산에 함께 적용된다([ADR-0107](../adr/0107-widget-typography-and-usage-bar-width.md)). **사용량 위젯이 어떤 한도 행을 보이는지는 위젯이 소유하지 않고** 전역 `usage.*.visibleRows` 를 따르며, 막대 색도 해당 에이전트의 `usage.<agent>.colors` 를 그대로 쓴다.

폭이 모자라면 위젯을 자르지 않는다. 상단 바의 우선순위는 **창 버튼 > 창 드래그 영역 최소 폭 > 앱 크롬 버튼·위젯** 이다([ADR-0123](../adr/0123-top-bar-window-controls-outrank-everything.md)). 창 버튼(최소화·최대화·닫기)은 어떤 폭에서도 46px 를 유지한 채 오른쪽 끝에 남고, 그 다음 드래그 최소 폭이 확보된다. 남은 폭 안에서 각 슬롯이 **화면 가장자리에서 먼 쪽부터**(left 슬롯은 배열 뒤쪽, right 슬롯은 배열 앞쪽) 오버플로 팝오버로 접는다. 앱이 소유하는 우선순위 값은 없다.

편집 UI 는 Settings → **Interface → 위젯** 한 곳이다. 위젯은 pane 에 놓는 view 가 아니라 앱 크롬이므로 Views 가 아닌 Interface 그룹에 둔다. 상단 바에는 배치 조작 버튼을 두지 않는다.

원격 클라이언트는 이 배치를 **미러**만 한다([ADR-0124](../adr/0124-remote-widget-strip-mirrors-desktop.md)). 원격 전용 배치·옵션은 없고, 데스크톱이 그리고 있는 위젯만 원격 스트립에 나타난다 — `statusLine.enabled` 가 꺼져 있으면 그 슬롯의 위젯은 원격에도 없다. 네 슬롯은 원격에서 좌(`topBar.left`+`statusLine.left`)·우(`topBar.right`+`statusLine.right`) 두 묶음으로만 접히고, 폭이 모자라면 접지 않고 가로 스크롤한다. 계약과 전송 형식은 §13.5 를 참고한다.

### GitHub 이슈/PR 목록 (GitHubView)

`GitHubView` 는 pane 이 sync group 에서 **받은 CWD** 로 대상 리포를 정한다. CWD → `owner/repo` 변환은 `git_watcher::resolve_github_base_from_working_dir` 단일 구현을 쓰며, GitHub `origin` 이 없으면 오류가 아니라 `notAGithubRepo` 표시 상태다. 이 뷰는 CWD 를 받기만 하므로 컨트롤 바에 receive 토글만 노출된다 — send/1회 전파 노출 여부는 `lib/view-cwd-capability.ts` 의 `supportsCwdSend`/`supportsCwdReceive` 가 결정한다.

Tauri command 는 두 개다([ADR-0106](../adr/0106-github-list-view-repo-registry.md)).

| Command | 인자 | 반환 |
|---|---|---|
| `get_github_repo_snapshot` | `workingDir`, `force` | `{ status, repo, repoUrl, issues[], pulls[], fetchedAtMs }` |
| `run_github_item_action` | `workingDir`, `action`, `number` | `Ok(())` 또는 `gh` 오류 메시지 |

- **스냅샷 소유자는 `owner/repo` 키 레지스트리다.** 갱신 주기는 10초이며, 그 창 안의 요청은 리포별 `fetch` 토큰으로 합쳐져 `gh` 를 한 번만 실행한다. 같은 리포를 보는 pane 이 몇 개든 비용은 동일하다. 이 레지스트리는 `AppState` 를 건드리지 않아 `state.rs` 락 순서에 참여하지 않는다.
- **만료는 캐시 미스가 아니다 — stale-while-revalidate.** 갱신 주기를 넘긴 읽기는 기억된 스냅샷을 그대로(만료 표시 없이, 저장 당시 `fetchedAtMs` 로) 즉시 반환하고 `gh` 재조회는 응답 뒤 백그라운드에서 돈다. 기억된 스냅샷이 없을 때만 인라인으로 기다린다. `force`(사용자 새로고침)는 stale 을 받지 않고 인라인 조회한다. 오랜만에 워크스페이스에 들어온 pane 이 빈 목록을 보지 않게 하는 정책이다([ADR-0110](../adr/0110-github-snapshot-stale-while-revalidate.md)).
- **토큰은 `try_lock` 으로만 잡는다 — 대기열이 없다.** 진행 중인 조회가 있으면 다른 호출자는 기다리지 않고 캐시된 스냅샷을, 캐시가 없으면 `pending` 상태를 즉시 받는다. `pending` 은 "아직 답이 없다"는 뜻이고 빈 목록이 아니다 — 프론트는 이를 표시하지 않고 1초 뒤 재조회한다(`GITHUB_PENDING_RETRY_MS`).
- **`gh` 는 마감을 넘기면 죽는다.** 목록 15초, 변경 조작 60초(`process::output_with_timeout`). 초과하면 `failed{message}` 로 내려온다.
- **행의 복사 버튼은 두 개다.** 링크 복사(`⧉`)는 모든 행에 상시 노출하고, 브랜치 복사(`⎇`)는 `headRefName` 이 있는 행 — 즉 PR — 에만 그 왼쪽에 붙는다. 이슈는 브랜치가 없어 필드가 빈 문자열이고 버튼도 그리지 않는다. 눌린 버튼만 1.2초 동안 `✓` 로 바뀐다(행 번호 + 버튼 종류로 구분).
- **조회는 항상 `gh {issue|pr} list --repo owner/repo --state open --limit 50 --json …`** 이며, PR 목록만 `isDraft`·`headRefName` 을 추가로 요청한다(둘 다 PR 전용 필드라 이슈 목록에 넣으면 `gh` 가 호출 전체를 거부한다). CWD 상속으로 실행하지 않으므로 레지스트리 키와 질의 대상이 어긋날 수 없고, `issueReporter.shell` 프리픽스(예: WSL)에서도 그대로 동작한다.
- **`action` 은 `issue.close`, `issue.closeNotPlanned`, `pr.merge`, `pr.squash`, `pr.rebase`, `pr.close` 만 허용**하며, 파싱 실패는 프로세스 기동 전에 거부된다. 머지 방식은 액션이 정하며 각각 `--merge`/`--squash`/`--rebase` 로 고정 전달한다(`gh pr merge` 는 방식 없이는 대화형이다).
- **성공한 조작은 해당 리포 캐시를 무효화**해 다음 폴링이 즉시 재조회한다. 프론트는 `⋯` 메뉴에서 조작을 장전한 뒤 별도 Confirm 클릭에서만 command 를 호출한다.
- `gh` 미설치·미인증은 각각 `ghMissing`/`unauthorized` 상태로 내려오며, 그 외 실패는 `failed{message}` 로 `gh` stderr 를 그대로 전달한다.

뷰의 기본값은 `settings.github` 이 소유한다 — `defaultTab`(`"issues"`|`"pulls"`, 기본 `issues`, 아직 탭을 고르지 않은 pane 에만 적용. 고른 뒤에는 `viewOverrides.githubTab` 이 이긴다 — [ADR-0115](../adr/0115-github-view-tab-per-pane-state.md)), `refreshSeconds`(기본 10, Settings UI 하한 10), `hideDraftPulls`(기본 false). 편집 UI 는 Settings → **Views → GitHub** 다. `refreshSeconds` 는 프론트가 폴링 간격으로만 쓰며 백엔드 갱신 창(10초 상수)은 바꾸지 않으므로, 10초 미만 값은 캐시를 다시 읽는 데 그친다. 손으로 0·음수를 넣은 settings.json 도 폴링이 타이트 루프가 되지 않도록 뷰에서 1초로 바닥을 잡는다.

행 표시도 같은 섹션이 소유한다(전역 전용 — pane 별 오버라이드 없음, [ADR-0111](../adr/0111-github-view-display-settings.md)).

| 키 | 기본 | 범위·의미 |
|---|---|---|
| `fontFamily` | `""` | 빈 문자열이면 앱 UI 글꼴(`var(--ui-font)`). 목록은 설치된 mono 글꼴 |
| `fontSize` | `11` | 번호·제목 크기(px), 8~24. 작성자·경과시각·라벨은 `fontSize - 2`(하한 7px)로 파생 |
| `numberColor` | `"yellow"` | `yellow`\|`accent`\|`green`\|`red`\|`primary`\|`secondary`\|`muted`. **이름만** 받는다 — 원시 색을 넣으면 기본값으로 되돌린다 |
| `showAuthor` | `true` | 작성자 열 |
| `showUpdated` | `true` | 경과시각 열 |
| `showDraftBadge` | `true` | DRAFT 배지. `hideDraftPulls` 는 행 자체를 없애므로 축이 다르다 |
| `labelMaxCount` | `2` | 행당 라벨 수, 0~5. **0 이 라벨 열의 off 스위치**다(별도 토글 없음) |
| `labelMaxWidth` | `80` | 라벨 한 개 최대 폭(px), 24~240 |

읽기 경로는 `lib/github-display.ts` 단일 clamp 를 지난다. 스키마는 값을 거부하지 않고 조용히 clamp 하며(`refreshSeconds` 하한 처리와 같은 방식), 뷰는 settings.json 의 원시 값을 style 로 직접 흘리지 않는다.

### Direct Remote Mode 설정

브라우저 원격 접속은 명시적 opt-in 설정이다. 기본값은 꺼짐이며, remote API는 Automation API/MCP의 IP allowlist와 별도 인증/Origin/IP 정책을 사용한다([ADR-0013](../adr/0013-direct-remote-mode.md)).

활성화에는 두 경로가 있다([ADR-0016](../adr/0016-remote-access-runtime-vs-startup-enable.md)).

- **이번 실행 동안 허용**: Remote Access 모달에서 켜는 런타임 상태다. `AppState` 에만 저장되며 앱 종료 시 사라지고 `settings.json` 에 기록하지 않는다.
- **시작 시 자동 허용**: `settings.remote.enabled` 를 `true` 로 저장하는 영속 설정이다. 다음 실행부터 remote entry 가 처음부터 열린다.

remote 의 실효 활성화 상태는 `settings.remote.enabled || runtimeRemoteAccess.enabled` 로 계산한다. 토큰은 `settings.remote.authToken` 을 우선 사용하고, 이 값이 비어 있을 때만 런타임 허용 토큰을 사용한다. IP allowlist, Origin 정책, heartbeat timeout 은 `settings.remote` 계약을 따른다.

Remote Access 모달은 런타임 성격의 조작만 담당한다: 이번 실행 동안 허용, URL/token 복사, 데스크톱 앱 내부 모바일 모드 열기, remote controller reclaim. 시작 시 자동 허용, IP allowlist, 자동 모바일 폭, 수동 호스트 목록, 기본 호스트 같은 영속 설정은 Settings → Remote 섹션에서 편집하며 기존 settings store → `persistSession()` → `save_settings` 경로로 `settings.json` 에 저장된다. 데스크톱 앱 내부의 모바일 모드는 기존 `/remote/` Direct Remote UI를 `localApp=1&autoConnect=1` iframe으로 여는 로컬 전용 표시 모드이며, 외부 브라우저 지원을 새로 의미하지 않는다. 해당 iframe은 remote lease를 잡을 수 있으므로 PC WebView의 remote-control overlay는 로컬 모바일 모드가 활성인 동안 숨긴다.

desktop WebView의 controller owner snapshot은 `lib/remote-control-status.ts` 전역 coordinator가 소유한다([ADR-0128](../adr/0128-app-global-remote-control-status-coordinator.md)). listener 설치 뒤 initial `get_remote_control_status`를 한 번 호출하고, Remote active 동안에만 이전 조회 완료 후 3초 fallback poll 하나를 예약한다. `TerminalView` 수와 무관하게 listener·조회는 window당 하나이며, 각 surface는 `useSyncExternalStore` snapshot만 구독한다. listener 또는 initial snapshot이 준비되지 않은 `null` 상태는 Local human input·resize를 fail-closed한다. event revision은 늦은 snapshot이 최신 owner event를 덮지 못하게 하고, Remote→Local `releaseRevision`은 React batch 안의 짧은 owner 전환도 terminal 복귀 reflow에 전달한다.

Remote Access 모달의 복사 URL 호스트는 `get_remote_host_candidates` Tauri IPC command가 반환하는 감지 후보와 `settings.remote.customHosts` 를 프론트엔드가 병합해 만든다([ADR-0021](../adr/0021-remote-host-candidate-discovery.md)). 감지 후보는 항상 loopback `127.0.0.1` 을 포함하고, 사용 가능하면 Tailscale IPv4/IPv6 주소와 LAN interface 주소를 추가한다. `settings.remote.preferredHost` 가 후보 목록에 있으면 URL host select 의 초기값으로 쓰고, 빈 문자열이면 첫 후보를 자동 선택한다. IPv6 host 는 복사 URL에서 `http://[addr]:port/...` 형태로 bracket 처리한다. 이 후보 목록은 URL 작성 편의용일 뿐이며 실제 접속 허용 여부는 계속 `settings.remote.allowedIps`, bearer token, Origin 정책이 결정한다.

```jsonc
{
  "remote": {
    "enabled": false,                  // 시작 시 자동 허용 여부. 기본값: 비활성화
    "bindAddress": "0.0.0.0",          // 현재 구현은 Automation 서버 listener를 공유
    "allowedOrigins": [],              // 비어 있으면 Origin 필터 없음, 값이 있으면 Origin 일치 검사
    "allowedIps": ["127.0.0.1/32", "::1/128"],
    "tailscaleOnly": false,             // true면 Direct Remote source IP를 Tailscale 대역으로 추가 제한
    "authToken": "",                   // enabled=true일 때 필수
    "heartbeatTimeoutSeconds": 45,      // 기본 45초, 최소 30초로 clamp
    "autoMobileModeMinWidth": 720,      // 앱 창 폭이 이 값 이하이거나, 휴대폰(세로 화면+짧은 변이 이 값 이하)에서 RDP 접속 시 Remote Access 모달 자동 표시. 0 = 비활성
    "snapshotMaxKib": 4,                // 원격 screen checkpoint의 scrollback 소프트 예산(KiB). 1~1024로 clamp; 현재 화면·alt buffer·mode 복원 bytes는 예산을 넘을 수 있으나 절대 상한은 1 MiB
    "preferredHost": "",               // 복사 URL 기본 호스트. 빈 값 = 자동
    "customHosts": [],                  // 감지 후보 외에 URL host select 에 표시할 수동 호스트
    "cloudEnabled": false,              // 클라우드 연결 영속 설정. pairing 전 기본값 false
    "relayBaseUrl": "https://app.laymux.com",  // 기본값: release=https://app.laymux.com, dev(debug)=http://127.0.0.1:8000. 설정에서 변경 가능
    "cloudInstanceId": null,            // relay가 발급한 instance id. 미연결이면 null
    "cloudTunnelUrl": null,             // pairing complete 응답의 WSS tunnel URL. PR3 터널에서 사용
    "cloudServerBaseUrl": null,         // pairing complete 응답의 canonical server base URL
    "cloudAutoReconnect": true,         // 원격 제어가 켜져 있고 토큰이 있으면 시작 시 WSS tunnel 자동 재연결
    "serveTerminalFont": false,         // 데스크톱 터미널 폰트 파일을 원격 브라우저로 전송(ADR-0077). 폰트 바이너리 재배포이므로 기본 off
    "scrollSensitivity": 1,             // 원격 브라우저 터미널의 휠 배율. 0.1~20, 기본 1(ADR-0142). 데스크톱 terminal.scrollSensitivity 와 별개
    "fastScrollSensitivity": 5,         // 원격에서 Alt 를 누른 채 굴릴 때의 배율. 0.1~20 으로 clamp, 기본 5
    "touchScrollSensitivity": 1,        // 손가락 드래그 스크롤백 배율. 0.1~20, 기본 1(=1:1 물리 스크롤). xterm 옵션이 아니라 Remote 페이지의 픽셀→행 환산에 곱한다
    "widgets": true                     // 데스크톱에 배치한 위젯을 원격 스트립에 미러(ADR-0124). 배치 SoT 는 settings.widgets 이며 이 값은 원격 표면 표시 여부만 정한다. 전역 게이트이고, 기기별 on/off 는 브라우저 localStorage 가 따로 갖는다(§13.5, ADR-0132)
  }
}
```

클라우드 연결은 Direct Remote Mode와 additive 관계다([ADR-0022](../adr/0022-cloud-connection-foundation.md), [ADR-0023](../adr/0023-cloud-pairing-loopback-oauth.md), [ADR-0024](../adr/0024-cloud-native-wss-tunnel.md)). Tauri IPC 계약은 `get_cloud_status() -> { connected, instanceId, lastError }`, `cloud_connect_start() -> CloudStatus`, `cloud_disconnect() -> CloudStatus` 다. `cloud_connect_start` 는 `relayBaseUrl` 의 `/pair/desktop` 으로 시스템 브라우저를 열고, `http://127.0.0.1:<ephemeral>/pair/callback` loopback callback 에서 code/state 를 수신한 뒤 `/api/desktop/pair/complete` 로 device token을 교환한다. redirect URI는 `http`, host `127.0.0.1`, path `/pair/callback`, fragment/userinfo 없음으로 고정한다. pairing 성공 후 device token은 `settings.json` 에 저장하지 않고 OS keyring service `laymux`(`debug_assertions` 빌드는 `laymux-dev`), account `device-token` 에 저장한다. `settings.remote` 에는 `cloudEnabled=true`, `cloudInstanceId`, `cloudTunnelUrl`, `cloudServerBaseUrl`, `relayBaseUrl` 만 저장한다.

Pairing 성공 후와 앱 시작 시(원격 제어가 실효적으로 켜져 있고 `cloudAutoReconnect=true`이며 keyring token이 존재할 때) desktop은 `cloudTunnelUrl` 로 native Rust WSS outbound tunnel을 연다. WSS 접속에는 `Authorization: Bearer <device-token>` 를 사용한다. 터널 연결 수명주기는 원격 제어 게이트(`settings.remote.enabled || runtimeRemoteAccess.enabled`)에 종속된다([ADR-0030](../adr/0030-cloud-tunnel-follows-remote-control-gate.md)): 게이트가 꺼져 있으면 터널을 열지 않아 relay에 online으로 보고하지 않고 인스턴스가 대시보드에 노출되지 않는다. `set_remote_runtime_access` 로 게이트가 꺼지면 살아 있는 터널을 즉시 종료하고(`connected=false`, instance id는 유지) 다시 켜지면 재접속한다. `cloud_connect_start` 도 게이트가 꺼져 있으면 브라우저를 열거나 relay에 접속하기 전에 거절하고 `lastError` 를 남긴다 — 원격 제어가 꺼진 상태에서는 클라우드에 어떤 액션도 하지 않는다. relay가 첫 `ready` frame 또는 이후 `heartbeat.ack` frame으로 `{ instanceId }` 를 보내면 `AppState.cloud.connected=true` 와 instance id를 갱신하고, socket이 끊기면 `connected=false` 로 전환한 뒤 지수 backoff로 재접속한다. 단, relay가 4001 또는 401 계열 인증 실패 close를 보내거나 WSS handshake가 401로 실패하면 자동 재접속을 중단하고 재-pair가 필요한 `lastError` 를 남긴다. `cloud_disconnect` 는 tunnel worker를 중지하고 keyring token 삭제, cloud 저장 필드 정리, `AppState.cloud` 리셋을 best-effort 로 수행한다.

Tunnel M5 frame은 text JSON `{ stream_id, type, payload }` 를 사용한다. `stream.open{kind:"http.request"}` 는 후속 `stream.data` base64 body를 모아 `remote_server::build_router(ServerState).with_state(ServerState)` 로 내부 `oneshot` dispatch 한다. 이 내부 request에는 `ConnectInfo(127.0.0.1:0)`와 크레이트 내부 전용 `TunnelAuthorized` request extension을 삽입한다. `TunnelAuthorized` 요청은 WSS device token으로 transport 인증을 마친 요청이므로 bearer token, IP allowlist, Origin 검사를 우회하지만, 사용자 제어권 토글인 enabled gate는 계속 요구한다. 나아가 터널 연결 성립 자체가 같은 게이트를 따르므로(위 문단, [ADR-0030](../adr/0030-cloud-tunnel-follows-remote-control-gate.md)), `settings.remote.enabled || runtimeRemoteAccess.enabled` 가 false인 동안에는 요청이 도달하기 전에 터널이 존재하지 않는다. `/remote`, `/remote/`, `/remote/vendor/*`처럼 `remote_guard` middleware 밖에 있는 page/vendor route도 같은 정책을 적용한다. 터널은 `set_remote_runtime_access` 를 호출하지 않으므로 cloud 연결만으로 로컬 TCP `/remote` listener가 열리거나 persistent `settings.remote.authToken` 이 재활성화되지 않는다. 외부 `Authorization` 및 hop-by-hop header는 전달하지 않는다. 응답은 `stream.open{kind:"http.response",status,headers}` + `stream.data` + `stream.close` 로 relay에 돌려준다. HTTP stream은 request `stream.close` 이후에도 response `stream.close` 또는 `stream.error` 가 끝날 때까지 active map에 `Responding` 상태로 남아 stream id, active stream slot, socket pending bytes를 예약한다. response task completion은 stream id와 response generation id가 현재 `Responding` entry와 모두 일치할 때만 stream을 정리하며, cancel 후 재open된 stream에 도착한 stale completion은 무시한다. `stream.open{kind:"websocket"}` 중 `/remote/v1/terminals/{id}/output` 은 Direct와 같은 renderer checkpoint attach를 사용한다. desktop WebView의 rendererless xterm이 생성한 screen checkpoint를 현재 generation·PTY geometry·output ring prefix와 검증한 뒤, checkpoint 이후 raw suffix와 bounded subscriber 등록을 한 session lock 구간에서 원자적으로 묶는다. desktop은 같은 `srv-*` stream id로 `stream.open{kind:"websocket.accept",outputProtocol:"laymux-terminal-output.v1",attachState}` 를 먼저 보내고, screen checkpoint와 raw suffix를 합친 snapshot을 정확히 한 개의 `stream.data{encoding:"base64",data,output:{version,phase,seqStart,seqEnd,byteLength}}`로 보낸다. 이후 delta도 같은 wire sequence offset을 적용한다. 빈 snapshot도 metadata와 빈 data frame을 보내며 새 bytes가 없을 때는 delta frame을 만들지 않는다. checkpoint race는 최대 3회 다시 캡처하고, 안정화되지 않거나 subscriber ring gap이 발생하면 retryable `terminal_output_gap` stream error로 종료한다. Active stream 수, per-stream queue/body, socket 전체 pending body 한계를 넘으면 `stream.error` 로 종료한다. Malformed frame은 연결을 끊지 않고 stream id가 식별되면 해당 stream에 `stream.error` 를 보내며, 식별할 수 없으면 경고 후 무시한다.

Tailscale 직접 접속을 허용하려면 `allowedIps`에 Tailnet 범위(예: IPv4 `100.64.0.0/10`, IPv6 `fd7a:115c:a1e0::/48`) 또는 구체적인 peer IP/CIDR를 추가하고 `authToken`을 설정한다. Tailscale은 transport 격리일 뿐 인증을 대체하지 않는다. `tailscaleOnly=true`이면 TCP Direct Remote 요청의 관측 source IP가 위 Tailscale IPv4/IPv6 대역에 포함되어야 하며 기존 `allowedIps`, token, Origin 조건도 계속 모두 적용된다. Settings UI에서 이 토글을 켜면 표준 Tailscale CIDR를 allowlist에 추가하지만 끌 때는 기존 allowlist를 보존한다. WSS device token으로 이미 transport 인증된 `TunnelAuthorized` cloud 요청은 이 Direct 전용 IP gate를 우회한다([ADR-0139](../adr/0139-cloud-tunnel-tailscale-route-advertisement-and-direct-gate.md)).

Cloud tunnel heartbeat는 선택 payload `{ "tailscaleUrl": "http://<tailscale-ip>:<19280|19281>/remote/" }`를 보낼 수 있다([ADR-0139](../adr/0139-cloud-tunnel-tailscale-route-advertisement-and-direct-gate.md)). 값은 `get_remote_host_candidates`의 Tailscale IP에서만 만들고 token·allowlist 같은 비밀은 싣지 않는다. Tailscale CLI probe는 family별 2초로 제한하고 tunnel I/O와 독립된 task에서 heartbeat 주기마다 다시 계산하며, 값이 바뀌면 즉시 갱신 frame을 보낸다. relay는 이를 현재 tunnel connection에만 보관하며, strict Tailscale IP/port/path 검증을 통과한 URL만 인스턴스 카드의 별도 Tailscale 버튼으로 노출한다. 이는 주소 가용성 광고이지 브라우저에서의 reachability 보장이 아니며 relay 자동 fallback을 만들지 않는다.

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

### File Viewer 폰트·여백 설정

`settings.viewer`(`ViewerSettings`)는 **열린 파일 내용**(FileViewer 본문)의 `fontFamily`/`fontSize`/padding 기본값을 소유한다. `settings.fileExplorer`의 `fontFamily`/`fontSize`는 디렉터리 **목록**(트리) 전용이라 서로 다른 필드다 — 하나가 다른 하나에 안 붙어 있다. 둘 다 비어 있으면 `appearance.font`(앱 기본 폰트)를 상속한다.

```jsonc
{
  "viewer": {
    "fontFamily": "",   // 빈 문자열 = appearance.font.face 상속
    "fontSize": 13,
    "paddingTop": 8,
    "paddingRight": 8,
    "paddingBottom": 8,
    "paddingLeft": 8
  }
}
```

FileViewer 안에서 Ctrl+Wheel 또는 툴바 A−/A+ 버튼으로 조정하는 폰트 줌은 이 설정값 자체가 아니라 `viewOverrides[viewerInstanceId].fontSize`(ADR-0004의 View 인스턴스 오버라이드 레이어, [overview.md](overview.md) §4.2)에 얹힌다 — TerminalView·MemoView와 같은 `settings → override` 해석 체인이다. `viewerInstanceId`는 워크스페이스/dock pane id가 아니라 파일 경로에서 파생된 값(`global-file-viewer:` 접두사, `lib/file-viewer.ts`)이라 앱 재시작 시 `gcStale`의 살아있는 pane 집합에 걸리지 않는다 — 이 접두사를 가진 `viewOverrides` 항목은 pane 생존 여부와 무관하게 gc 대상에서 예외 처리한다(`stores/overrides-store.ts`). 이미지(SVG preview 모드 포함)의 확대율(`imageZoom`, 25~400%)도 같은 맵의 같은 키에 저장되지만 대응하는 설정값은 없다 — 사진마다 "기본 줌"이라는 개념이 없기 때문이다.

html/markdown preview는 별도 문서(iframe)라 부모 페이지의 CSS를 상속하지 않으므로, 이 폰트는 `buildPreviewDocument`가 매번 iframe 자신의 `<style>`에 구워 넣는다(`lib/file-preview.ts`). 같은 이유로 iframe 안에서 발생한 Ctrl+Wheel도 부모로 버블링되지 않아 `PreviewFrame`이 `contentDocument`에 직접 `wheel` 리스너를 붙여 부모의 폰트 줌 핸들러로 전달한다.

이미지 확대는 CSS `transform: scale()`이 아니라 실측 자연 크기(`naturalWidth`/`naturalHeight`) 기반 실제 `width`/`height`로 구현한다(`components/ui/preview/ZoomableImage.tsx`) — transform은 레이아웃 박스를 키우지 않고 그리기만 키워서, 가운데 정렬된 flex 컨테이너의 위·왼쪽 오버플로가 `overflow: auto`로 스크롤 불가능한 음수 영역이 된다. 100%를 넘겨 확대하면 스크롤 컨테이너 정렬도 가운데에서 좌상단(`flex-start`)으로 전환해(`lib/image-zoom.ts`) 오버플로가 항상 한쪽 방향으로만 생기게 한다.

### Claude Code 설정

Claude Code 관련 동작(sync-cwd 전파, 세션 복원, 셀렉터 상태 메시지 구성, 세션 리미트 자동 복귀)을 제어한다.

```jsonc
{
  "claude": {
    "syncCwd": "skip",                   // "skip" (기본) | "command"
    "command": "claude",                 // Claude Code 실행 명령. 플래그 포함 가능 (기본 "claude")
    "restoreSession": true,              // 앱 재시작 시 Claude 실행 중이던 pane을 `<command> --resume <id>`로 재개 (기본 true)
    "sessionMaxAgeHours": 24,            // 이보다 오래된 세션은 복원 제외 (0 = 나이 필터 해제, 기본 24)
    "statusMessageMode": "bullet-title", // 셀렉터 상태 메시지 구성: "bullet" | "title" | "title-bullet" | "bullet-title"
    "statusMessageDelimiter": " · ",     // bullet·title 병기 시 구분자
    "sessionLimitAutoResume": true,      // 세션 리미트 reset 시각 이후 복귀 메시지 자동 전송 (기본 true)
    "sessionLimitResumeDelaySeconds": 60, // reset 시각 이후 대기 시간(초, 기본 60)
    "sessionLimitResumeMessage": "go on" // 복귀 시 전송할 메시지 (기본 "go on", 제출은 단독 CR)
  }
}
```

`command` 는 복원이 사용할 실행 명령이며 플래그를 함께 적는다(예: `"claude --dangerously-skip-permissions"`). 값은 실행 파일 이름/경로와 플래그로만 이뤄져야 하고 셸 메타문자·줄바꿈이 있으면 무시되어 기본 `claude` 가 쓰인다 — 문법과 적용 규칙은 아래 "에이전트 실행 명령"에서 다룬다([ADR-0125](../adr/0125-configurable-agent-launch-command.md)). `restoreSession`/`sessionMaxAgeHours` 는 세션 영속([data-flow.md §13](./data-flow.md)) 복원 시 startup command 를 `<command> --resume` 으로 대체하는 경로를 제어하고, `statusMessageMode`/`statusMessageDelimiter` 는 WorkspaceSelectorView 의 Claude 상태 메시지([data-flow.md §9](./data-flow.md)) 구성을 제어한다. `sessionLimit*` 3종은 세션 리미트 배너(`You've hit your session limit · resets <time>`) 감지 후 자동 복귀([data-flow.md](./data-flow.md) "세션 리미트 자동 복귀") 를 제어한다. 이하는 `syncCwd` 상세.

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

Claude session 귀속은 PTY descendant PID와 `~/.claude/sessions/<pid>.json`의 PID가 직접 일치할 때만 허용한다. 여러 pane이 같은 CWD를 쓰더라도 CWD 최신 session으로 fallback하지 않으며, 서로 다른 pane에 같은 session ID가 귀속되면 충돌한 pane은 모두 복원하지 않는다. `restoreSession`이 꺼져도 현재 정확한 ID는 저장하고 다음 terminal 시작에서 resume 실행만 억제한다([ADR-0118](../adr/0118-codex-session-pid-attribution.md)).

### Codex 설정

Codex 관련 동작(세션 복원, 셀렉터 상태 메시지 구성)을 제어한다.

```jsonc
{
  "codex": {
    "command": "codex",                  // Codex CLI 실행 명령. 플래그 포함 가능 (기본 "codex")
    "restoreSession": true,              // 앱 재시작 시 pane을 `<command> resume <id>`로 재개 (기본 true)
    "sessionMaxAgeHours": 24,            // 이보다 오래된 rollout은 복원 제외 (0 = 나이 필터 해제, 기본 24)
    "statusMessageMode": "bullet-title", // "bullet" | "title" | "title-bullet" | "bullet-title"
    "statusMessageDelimiter": " · "      // bullet·title 병기 시 구분자
  }
}
```

`restoreSession`/`sessionMaxAgeHours`는 세션 영속([data-flow.md §13](./data-flow.md))에서 검증된 Codex thread ID를 다음 시작 명령 `codex resume <id>`로 사용할지를 제어한다([ADR-0118](../adr/0118-codex-session-pid-attribution.md)). 저장 시에는 terminal PTY의 가장 얕은 Codex descendant PID를 얻고, Codex의 읽기 전용 `logs_*.sqlite`에서 그 PID의 현재 `process_uuid`와 thread ID를 연결한다. `state_*.sqlite`가 제공한 rollout 경로(없으면 정확한 ID가 파일명에 있는 rollout 검색)의 첫 `session_meta`를 대조해 최상위 interactive thread만 허용한다. terminal CWD와 최신 rollout은 귀속에 사용하지 않는다. 서로 다른 terminal이 같은 ID를 얻거나 DB·스키마·rollout 중 하나라도 검증되지 않으면 관련 pane은 복원하지 않는다.

rollout 나이 필터는 파일의 nanosecond 수정 시각만 사용하며, 생성일인 `sessions/YYYY/MM/DD` 디렉터리명으로 미리 pruning하지 않는다. 세션 ID는 영숫자로 시작하고 이후 영숫자·`-`·`_`만 허용한다. Rust의 비구조화 startup override도 `<claude.command> --resume <id>`와 `<codex.command> resume <id>` 두 형태만 허용한다. `restoreSession`은 다음 시작에서 resume할지만 제어하므로 꺼져 있어도 Claude/Codex의 현재 ID를 수집·보존한다. native host의 `CODEX_HOME`(rollout, 기본 host OS 사용자 홈의 `.codex`)과 `CODEX_SQLITE_HOME`(DB, 기본 `CODEX_HOME`)을 지원한다. Windows host의 WSL terminal은 자신의 distro 안에서 `LX_TERMINAL_ID`를 상속한 Linux provider PID를 선택한다. Claude/Codex가 중첩 실행됐으면 provider별 최상위가 아니라 두 provider 전체에서 유일한 최상위 agent 하나만 활성 provider로 인정한다. Claude는 해당 PID 세션 파일을 읽고, Codex는 해당 PID의 open FD 중 process `CODEX_HOME/sessions` 아래의 rollout header를 검증해 유일한 top-level thread만 저장한다([ADR-0120](../adr/0120-wsl-agent-session-attribution.md)). native·WSL 결과를 모두 합친 뒤 같은 session ID가 둘 이상의 terminal에 귀속되면 충돌한 terminal을 전부 `null`로 만든다. 명시 distro가 잘못됐으면 bare WSL로 재해석하지 않으며, default-distro 조회와 여러 distro probe는 하나의 3초 종료 예산을 공유한다. WSL live SQLite는 Windows UNC 경계에서 WAL lock을 안전하게 공유할 수 없으므로 귀속에 사용하지 않는다. WSL에서도 CWD·최신 파일·다른 distro fallback은 허용하지 않는다.

한 TerminalView의 `lastClaudeSession`과 `lastCodexSession`은 상호배타적으로 영속한다. 저장 시 새 Codex ID를 얻으면 stale Claude ID를 제거하고, 새 Claude ID를 얻으면 stale Codex ID를 제거한다. `get_claude_session_ids`와 `get_codex_session_ids`는 현재 provider가 실행 중이지만 정확한 ID를 증명하지 못한 terminal을 `null` 값으로 반환하며, 이 경우 저장 측은 양쪽 stale ID를 모두 제거한다. backend 결과나 손편집 설정에 두 provider가 동시에 귀속되면 provider를 추측하지 않고 둘 다 복원하지 않는다. 사용자가 누른 Restart View는 두 agent 복원을 모두 건너뛴다.

#### 에이전트 실행 명령 (`claude.command` / `codex.command`)

복원 명령의 실행부는 설정이 소유한다([ADR-0125](../adr/0125-configurable-agent-launch-command.md)). 값의 문법은 실행 파일 이름/경로 하나와 플래그이며, 허용 문자는 영숫자와 ` - _ . / \ : = ,` 뿐이고 첫 글자는 `-` 일 수 없다. 앞뒤 공백은 잘라내고 연속 공백은 하나로 접지만, 줄바꿈·탭은 접지 않고 값 전체를 거부한다. 문법을 어긴 값은 무시되어 기본 `claude`/`codex` 가 쓰이고, `validate_settings` 가 `/claude/command`·`/codex/command` 이슈로 보고하며 설정 UI 는 미리보기 대신 경고를 표시한다. 정규화는 Rust `settings/agent_command.rs` 와 프론트 `ui/src/lib/agent-command.ts` 가 같은 규칙으로 수행한다.

프론트는 이 값으로 `<command> --resume <id>` / `<command> resume <id>` 를 만들어 `startupCommandOverride` 로 보내고, Rust 는 **디스크의 settings 에서 접두어를 다시 도출해** 그 형태와만 대조한다 — 호출자가 보낸 문자열에서 접두어를 추출하지 않으므로 사용자가 설정하지 않은 플래그는 통과하지 못한다. 적용 시점은 `nextUse`(다음 터미널 생성)이며, 실행 중인 pane 의 명령은 바뀌지 않는다. 공백이 들어간 실행 파일 경로는 인용 문법을 두지 않아 지원하지 않는다. 이 설정은 세션 복원 경로에만 쓰이며 pane 신규 시작을 자동 기동하지 않는다.

metadata apply mode는 `/codex/statusMessageMode`와 `/codex/statusMessageDelimiter`가 부모 `/codex`의 `live`를 따르고, `/codex/restoreSession`·`/codex/sessionMaxAgeHours`·`/claude/command`·`/codex/command`는 `nextUse`다. `restoreSession`은 다음 terminal 생성부터, 최대 나이는 다음 세션 ID 수집부터 적용된다.

Claude의 `syncCwd: "command"`는 Claude Code가 제공하는 `! cd` 부모 세션 변경 계약에 의존한다. Codex shell mode는 부모 TUI CWD 변경 계약이 아니므로 Codex 설정에 같은 옵션을 두지 않고, 실행 중인 Codex pane은 다른 일반 interactive app처럼 CWD 수신에서 제외한다. `sessionLimit*`도 현재 Claude 고유 배너 파서 계약이므로 Codex에 복제하지 않는다.

### 절전 방지(sleep prevention) 설정

OS 절전 진입을 막는 정책이다(issue #727·#733, [ADR-0114](../adr/0114-sleep-prevention-mode.md), [ADR-0116](../adr/0116-sleep-prevention-two-axes.md)). 시스템 절전만 막고 화면 절전은 막지 않는다.

```jsonc
{
  "power": {
    // 수동 스위치: 터미널 상태와 무관하게 재우지 않는다
    "keepAwake": false,
    // 정책: 실행 중인 터미널이 있을 때만 재우지 않는다
    "keepAwakeWhenBusy": false
  }
}
```

- **두 축은 독립이다**(ADR-0116). `keepAwake` 는 세션 동안 뒤집는 수동 override 이고 `keepAwakeWhenBusy` 는 한 번 정하고 잊는 정책이다. 수명이 다르므로 컨트롤도 나눈다 — 상단 바 버튼(`sleep-prevention-btn`)은 `keepAwake` 만 토글하고 `keepAwake` 만 그린다. `keepAwakeWhenBusy` 는 Settings ▸ Interface ▸ Power 에만 있다(`keep-awake-when-busy-toggle`). 버튼 클릭은 `persistSession()` 으로 즉시 저장하며 두 필드 모두 applyMode 는 `live`.
- **버튼은 백엔드의 `held` 를 그리지 않는다.** 자동 정책이 잡아 놓은 억제까지 그리면 사용자가 누르지 않은 상태가 보이고, 눌러도 그림이 안 바뀌는 순간이 생긴다. 아이콘은 달(off)/사선 그은 달(on) 두 상태뿐이며, 표시 축과 조작 축이 같다.
- **파생**: `shouldInhibitSleep(axes, hasBusyTerminal)`(`ui/src/lib/sleep-prevention.ts`)이 두 축과 busy 상태를 하나의 boolean 으로 접는 유일한 지점이다(ADR-0005). 두 축이 독립이므로 판정은 `keepAwake || (keepAwakeWhenBusy && hasBusyTerminal)` OR 이다. busy 판정 `isTerminalWorking()`(`ui/src/lib/terminal-working.ts`)는 원시 필드를 다시 조합하지 않고 그 터미널의 `ActivityHandler.computeStatus()` 아이콘이 `STATUS_ICON_WORKING`(⏳)인지만 본다 — Claude local-agent 경로(#225)와 Codex 스피너는 `outputActive === false` 로도 모래시계를 띄우므로, 원시 필드 조합은 페인 표시와 어긋난다. `terminalActivity` 위젯도 같은 함수를 쓴다. 집계 범위는 활성 워크스페이스가 아니라 전체 터미널이다.
- **적용**: `useSleepPrevention()`(AppLayout 에서 1회 마운트)이 두 스토어를 **구독**해(셀렉터가 아니다 — 호스트 컴포넌트가 이 값을 렌더하지 않으므로 busy 플래그 토글이 트리를 재조정하면 안 된다) 파생값을 `requestSleepInhibit()` 로 넘긴다. 훅은 파생만 하고, 백엔드와의 대화는 전부 `lib/sleep-inhibit-coordinator.ts` 가 소유한다.
- **커맨드 대화는 모듈 단일 coordinator 다.** in-flight 여부·확정 상태·보류 값은 *프로세스*의 상태이지 마운트된 React 트리의 상태가 아니다. hook ref 에 두면 재마운트가 두 번째 큐를 만들어 옛 release 와 새 request 가 서로 다른 큐에서 겹친다. 규칙: 동시에 하나만 in flight(커맨드가 async 라 겹치면 순서가 뒤집힌다), 그 사이 오간 중간 값은 접는다(latest wins), 거절된 값은 원하는 값이 바뀔 때까지 보류(항상 실패하는 머신에서 스핀 방지). 보류 판정을 무효화하는 "세대"(intent)는 **희망값이 실제로 바뀌거나 호출자가 떠날 때만** 올린다 — `whenBusy` 는 출력 이벤트마다 같은 값을 다시 넘기므로, 호출마다 올리면 모든 거절이 superseded 로 보여 보류가 기록되지 않고 같은 요청이 무한 재전송된다.
- **실패는 "모름"이지 "완료"가 아니다.** 실패한 요청을 적용된 것으로 확정하면, 해제에 실패한 뒤 마지막 release 까지 중복으로 보고 건너뛰어 OS 세션 내내 억제가 남는다. 실패하면 확정 상태를 `null` 로 둔다. 커맨드가 요청과 다른 상태를 돌려줘도 같은 규칙으로 보류하고 UI 에 실패로 표시한다.
- **release 는 dedupe 를 무시하는 별도 경로다**(`releaseSleepInhibit()`). 마지막으로 놓을 기회이므로 보류를 무시하고, 자기 자신의 실패로 취소되지 않으며, 같은 큐를 통과해 in-flight 요청을 추월하지 않는다. 다만 재시도는 유한하다(3회) — 놓지 못하는 머신에서 무한 루프가 되면 안 된다. 백엔드가 이미 해제를 확정한 상태면 아무것도 보내지 않는다.
- **실패는 축이 아니라 고장이다.** 커맨드 결과는 `useSleepInhibitStore`(`active`/`failed`)에 기록한다. 버튼은 그중 `failed` 만 읽어, 원인이 수동이든 정책이든 경고색(`--claude`)과 tooltip 사유를 올린다 — 감추면 `systemd-inhibit` 이 없는 머신에서 정책이 세션 내내 조용히 실패한다. `active` 는 coordinator 의 상태 조정용이며 UI 는 읽지 않는다(ADR-0116).
- **백엔드가 스스로 바꾼 상태는 이벤트로 되돌아온다.** watchdog 이 재획득하거나 잃는 전이는 요청이 없으므로 프론트의 dedupe 로는 영영 알 수 없다. `SleepInhibitor` 의 sink 가 `sleep-inhibit-changed`(`{active, satisfied}`)를 발행하고, 훅이 그것을 `observeSleepInhibitState()` 로 coordinator·표시 상태에 반영한다. 관측 결과가 원하는 값과 다르면 일반 경로가 그대로 재요청한다.
- **백엔드**: `AppState::sleep_inhibitor`(`src-tauri/src/power/mod.rs`, 플랫폼 구현은 `power/{windows,linux,unsupported}.rs`)가 프로세스 전체에서 유일한 억제 소유자다. 멱등이며 상태가 실제로 바뀔 때만 OS 를 건드린다. `set_sleep_inhibit` 는 async 커맨드로 `spawn_blocking` 에서 돈다 — Linux 획득이 짧게 블로킹하기 때문이다.
  - **Windows**: 전용 스레드에서 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
  - **Linux**: `systemd-inhibit --what=idle:sleep --mode=block ... cat` 자식 + laymux 가 쥔 stdin 파이프(프로세스가 죽으면 EOF 로 자동 해제). `systemd-inhibit` 은 inhibit 호출이 실패해도 exec 자체는 성공하고 곧바로 종료하므로, spawn 후 300ms 동안 `try_wait()` 로 지켜본 뒤에야 lock 을 믿는다. stderr 는 전용 리더 스레드가 상한(4KiB)까지 계속 비운다 — 안 비우면 오래 사는 자식이 파이프 포화로 막히고, 실패 시점에 읽으면 억제 mutex 안에서 블로킹된다. 해제는 stdin 을 닫고 300ms 안에 정상 종료를 확인한 뒤, 안 죽으면 kill 한다. kill·wait 실패는 삼키지 않고 전파해 `held` 를 유지한다 — 자식이 살아 있는데 해제됐다고 기록하면 아무도 다시 알아차리지 못한다. 잡고 있던 자식이 나중에 죽으면 `needs_reapply()` 가 감지한다. 위 시간·크기 값은 §14.4 에 따라 `constants.rs` 의 `SLEEP_INHIBIT_SPAWN_GRACE`·`SLEEP_INHIBIT_POLL_INTERVAL`·`SLEEP_INHIBIT_RELEASE_GRACE`·`SLEEP_INHIBIT_STDERR_CAPTURE_LIMIT` 에 있다.
  - **desired 와 held 는 별개다.** `set` 은 요청을 `desired` 에 기록하고 `reconcile()` 로 실제 상태를 맞춘다. `held` 는 성공한 `apply` 에서만 바뀌므로, 획득 실패는 "안 잡힘"으로 남아 UI 가 거짓말하지 않고 watchdog 이 재시도할 거리가 된다. 해제 실패도 "아직 잡힘"으로 남는다. 커맨드는 요청값이 아니라 `held` 를 돌려준다.
  - **watchdog**: 프론트는 변화만 보고하므로 `keepAwake` 를 켠 채 두면 재확인 기회가 없다. 30초(`constants.rs` 의 `SLEEP_INHIBIT_WATCHDOG_INTERVAL`) 주기 스레드가 `reconcile()` 을 돌려 죽은 억제와 **한 번도 성공하지 못한 획득**을 모두 다시 시도한다(`SleepInhibitor::revalidate`). 앱 setup 에서 기동하고 `set_sleep_inhibit` 도 매번 `ensure_watchdog()` 을 호출한다(멱등) — 한쪽에만 묶으면 spawn 실패가 세션 내내 복구되지 않는다. 아무것도 원하지 않고 잡은 것도 없으면 no-op 이며, `Weak` 참조라 앱이 사라지면 스스로 끝난다.
  - 그 외 플랫폼은 `enabled=true` 요청에 에러를 반환한다.

### 종료 시 동작(kill-on-exit) 설정

앱 종료 시 실행 중인 터미널 작업을 정리하는 동작을 제어한다(issue #451, [ADR-0048](../adr/0048-kill-terminals-on-exit.md)). 켜면 창이 닫히는 흐름에서 모든 터미널에 Ctrl+C(ETX, `0x03`)를 여러 번 보낸다. 목적은 (A) cron/agent 등 장기 실행 작업을 우아하게 종료하고, (B) Claude Code·Codex 가 `--resume <session-id>` 힌트를 스크롤백에 출력하도록 유도하는 것이다. 출력된 힌트는 사용자 가시 기록으로 스크롤백 캐시에 남는다. 자동 복원에 쓰는 식별자는 이 텍스트를 파싱하지 않고 같은 저장 시점에 Claude session metadata 또는 Codex rollout metadata에서 별도로 조회한다(위 agent 설정, [data-flow.md §13](./data-flow.md#13-session-persistence--cache)).

```jsonc
{
  "exit": {
    "interruptTerminals": false,  // 종료 시 모든 터미널에 Ctrl+C 전송. 기본값: 꺼짐(opt-in, 파괴적)
    "interruptRounds": 3,         // 터미널당 Ctrl+C 전송 횟수. 1~10 으로 clamp
    "settleMs": 700               // 마지막 Ctrl+C 이후 창을 닫기 전 대기(ms). 0~10000 으로 clamp
  }
}
```

조율은 **프론트엔드 종료 흐름**이 담당한다([ADR-0048](../adr/0048-kill-terminals-on-exit.md)). `saveBeforeClose()` 는 스크롤백을 직렬화하기 **전에** `interruptTerminalsOnExit()`(`ui/src/lib/interrupt-terminals-on-exit.ts`)를 먼저 await 하므로, 세션 ID 가 캐시에 담긴다. 인터럽트는 종료 전용 커맨드 `interrupt_terminal_on_exit` 로 `0x03` 을 PTY FIFO 에 바로 써서 ConPTY/line discipline 이 포그라운드 앱에 실제 Ctrl+C 를 전달한다. 일반 `write_to_terminal`(`HumanControlOrigin::Local`) 경로는 원격 제어 lease/claim 활성 시 거부되므로, 종료 인터럽트는 owner 게이트를 우회하는 이 전용 경로(ETX 전용)를 쓴다. 특정 앱을 감지하지 않고 열린 모든 터미널에 보내며(유휴 셸에는 무해), 개별 write 실패는 나머지 인터럽트를 막지 않는다. Ctrl+C 사이 간격은 설정이 아니라 상수(120ms)다. Rust 는 `settings.exit` 스키마·기본값·범위 검증(applyMode `live`)만 소유하고 실제 인터럽트 실행에는 관여하지 않는다.

### 워크스페이스 터미널 클리어

Ctrl+Alt+L(및 워크스페이스 행의 지우개 버튼, `POST /api/v1/workspaces/{id}/clear`)은 한 워크스페이스의 `TerminalView` pane 전부에 Ctrl+L 키 입력 하나를 그대로 뿌린다(issue #726, [ADR-0137](../adr/0137-workspace-clear-ctrl-l-broadcast.md)) — pane 마다 손으로 Ctrl+L 을 누르는 것과 동일하고, 설정 항목은 없다.

이전에는 pane 의 activity handler 가 `clear`/`cls`/`/clear` 중 무엇을 칠지 정하고, 작업 중인 pane 을 skip/interrupt/restart 중 하나로 처리했다(`workspaceClear` 설정). 그 판정과 설정, 그리고 판정을 pane 하나에 적용하던 단일 pane 클리어(issue #741, Alt+L, [ADR-0121](../adr/0121-single-pane-clear-user-pointed-scope.md))는 모두 제거됐다 — Ctrl+L 은 어떤 앱에 보내도 안전해서 activity 별 분기가 필요 없었다.

세션이 아직 없는 pane(`notReady`)은 건너뛴다. 쓰기가 거부된 pane(원격이 제어 lease 를 쥐고 있거나 PTY 가 이미 죽은 경우)은 결과의 `failed` 에 담긴다 — 조용히 버리면 "터미널 pane 이 없는 워크스페이스"와 구분되지 않는다. dock pane 은 대상이 아니다: 워크스페이스 전환에도 살아남는 고정 surface 라 "이 워크스페이스"의 일부가 아니다.

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

**가드는 OSC 유래 CWD 에만 적용된다.** `session.cwd` 를 채우는 경로는 둘이다: ① PTY 스폰 시점 시딩(아래), ② 가드를 통과한 OSC 7 / OSC 9;9. 가드는 "이 OSC 가 사용자 의도의 `cd` 인가" 를 판정하므로, 우리가 방금 지정한 스폰 시작 디렉터리에는 적용되지 않는다.

**스폰 시점 CWD 시딩 ([ADR-0130](../adr/0130-spawn-time-cwd-seed.md)).** `spawn_pty_for_generation` 은 시작 디렉터리를 한 번 계획(`plan_start_dir`)해 명령에 적용하고, **실제로 적용된** 디렉터리를 `SpawnedPty.resolved_cwd` 로 돌려준다(`wsl --cd <dir>` 의 인자 또는 자식 프로세스 OS 작업 디렉터리, 정규형은 `normalize_wsl_path`). `create_terminal_session` 이 이 값을 `session.cwd` 에 시딩하고 create 응답의 `cwd` 필드로도 실어 보내므로, 프론트 스토어는 이벤트 없이 같은 값을 받는다(`TerminalView` → `updateInstanceInfo({cwd})`). 시작 디렉터리가 없거나 존재하지 않아 적용을 건너뛴 경우에는 시딩하지 않는다 — 자식은 상속된 CWD 에서 시작하므로 요청값은 거짓이 된다. 이 시딩이 없으면 세션 복원으로 곧바로 `claude --resume` / `codex resume` 을 실행한 pane 은 첫 바이트부터 `InteractiveApp` 이라 수용되는 OSC 7 을 영구히 발행하지 못하고, `GitHubView`·`propagate_cwd_once`·MCP 요약이 모두 디렉터리를 모른 상태로 남는다.

`do_sync_cwd`는 다음 순서로 가드를 통과해야만 전파를 진행한다:

1. `is_propagated` — 최근 전파된 터미널(에코 루프)인지
2. **소스 activity가 `Shell`인지** (= `Running` 또는 `InteractiveApp`이 아닌지)
3. `cwd_send` 플래그가 켜져 있는지
4. 대상 필터링(`cwd_receive`, 대상 activity, Claude 모드, 동일 CWD 중복)

2번 가드는 `detect_terminal_state_for_control`(= activity + 영구 추적 `known_claude_terminals`/`known_codex_terminals` + grace/exit cache + PTY process-tree registry + authoritative ring 건강성)이 `TerminalActivity::Shell`인 경우에만 통과한다. `detect_terminal_activity`만으로는 Codex 스피너(브레일 문자) 타이틀이나 Claude Code 작업 타이틀처럼 `INTERACTIVE_APP_PATTERNS`에 직접 매칭되지 않는 상태를 놓치므로, 반드시 영구 추적을 경유한다. 표시용 detector는 degraded fallback을 유지하지만 strict detector는 ring과 activity cache·PTY registry를 detection 전후에 검사한다. 이들 mutex poison은 `Shell`로 축소하지 않고 자동 IPC에서는 로컬 CWD 갱신과 전파를 명시적으로 차단하며, 오류를 반환할 수 있는 경로는 그대로 전파한다. 가드가 차단 판정하면 session.cwd 로컬 업데이트도 건너뛴다(스테일/실행 중 값을 후속 전파가 재사용하지 못하도록). `Shell`만 신뢰하는 이유는, OSC 7이 사용자 의도의 `cd`를 반영하는 시점은 셸이 프롬프트를 다시 그린 직후 — 즉 `OSC 133;D` 이후 — 뿐이기 때문이다.

**대상 필터링 (`filter_targets_not_busy`)**도 동일한 strict control detector로 판정한다 (#239). terminals/output registry 또는 개별 ring poison이면 전체 대상을 idle로 복원하지 않고 전파 자체를 오류로 중단한다:

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

`propagate_cwd_once`는 소스 터미널의 `session.cwd`가 비어 있으면(스폰 시딩도 OSC 7도 없음) no-op으로 `Ok`를 돌려준다. 세션 자체가 없으면(`file-explorer-${paneId}`) `resolve_propagate_source`가 `Err`를 반환하므로, file explorer 소스는 위 프론트 경로로만 전파한다.

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

**브리지 리스너는 핸들러 세대에 묶인다.** `useAutomationBridge` 의 effect 는 dispatch 함수(`handleAsyncAutomationRequest`) identity 를 의존성으로 갖는다. 프로덕션 번들에서는 모듈이 한 번만 평가되므로 앱 수명 동안 등록 1회다. Vite dev 에서는 이 hook 모듈이 hook 외 함수도 export 해 React Fast Refresh 경계가 아니므로, 이 모듈이나 그 import(스토어 포함)를 고치면 교체가 `App.tsx` 까지 전파되고 App 은 **remount 없이 re-render** 된다. 의존성이 `[]` 이면 effect 가 다시 돌지 않아 최초 모듈 인스턴스의 리스너가 계속 응답하고, 앱이 이미 버린 모듈 그래프의 store singleton 을 읽는다 — HTTP 는 `200` 을 내므로 조용히 stale 한 값(예: `activity`)이 에이전트에게 전달된다(issue #771). dispatch identity 를 의존성으로 두면 구독이 항상 최신 세대를 따라간다.

**브리지 마감은 요청에 실려 간다.** `bridge_request`는 event emit 직전에 monotonic absolute deadline과 wall-clock `deadlineMs`를 같은 5초(`FRONTEND_RESPONSE_TIMEOUT`) 예산으로 잡고, emit 뒤 새 timeout을 시작하지 않고 그 absolute deadline까지만 기다린다. 초과 시 `504 Frontend response timeout`을 낸다. 같은 시각을 프론트도 알아야 하므로 `automation-request` payload에 `emittedAtMs`·`deadlineMs`를 함께 싣는다([ADR-0080](../adr/0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)).

- 마감을 넘긴 **query** 는 계산하지 않고 `Frontend request expired` 로 즉시 거절한다 — 답이 닿을 상대가 없으므로 계산은 이미 밀린 메인 스레드의 시간만 빼앗고, 클라이언트 재시도가 같은 큐 뒤에 죽은 일감을 더 쌓는다.
- 마감을 넘긴 **action** 은 그대로 실행한다 — 부수효과는 여전히 호출자가 요청한 것이며, 조용히 버리면 "느린 resize" 가 "일어나지 않은 resize" 가 된다.
- 두 경우 모두 HTTP 호출자는 이미 `504` 를 받은 뒤이므로 **외부 계약은 바뀌지 않는다.**
- 프론트는 response IPC가 resolve된 뒤에만 `responsesSent`를 세고 IPC 거절은 `responsesFailed`로 센다. Rust도 map에서 sender를 찾은 것만으로 성공이라 하지 않고 oneshot send가 성공한 뒤 `responsesMatched`를 센다. receiver가 이미 없거나 send가 실패한 응답은 `responsesOrphaned`로 세고 누적 총계와 함께 경고 로그를 남긴다.

**프론트가 멈췄을 때 읽는 창구**: `GET /api/v1/diagnostics/frontend`. 이 라우트만은 브리지를 거치지 않고 Rust 상태에서 바로 서빙하므로, 다른 모든 프론트 경유 endpoint가 `Frontend response timeout`을 내는 동안에도 답한다. App-level bridge hook이 항상 켜진 250 ms self-rescheduling probe를 소유하고, 1초마다 또는 500 ms 이상 늦은 tick 직후 자기 vitals를 `report_frontend_health`로 밀어 넣는다. 첫 report 전에는 `frontend`와 report 시각/나이가 `null`이다. Rust health mutex 오류는 “아직 report 없음”으로 위장하지 않고 JSON HTTP 500으로 반환한다. 정상 응답은 이렇게 읽는다.

```jsonc
{
  "nowMs": 1780000000000,
  "lastReportAgeMs": 37421,   // null = 프론트가 아직 한 번도 보고하지 않음
  "lastReportAtMs": 1779999962579,
  "bridge": {                 // Rust 쪽 카운터
    "requestsEmitted": 128, "responsesMatched": 91,
    "responsesOrphaned": 12, "requestTimeouts": 37, "requestDisconnects": 0
  },
  "terminalOutput": [{       // Rust generation-local v3 transport/credit 상태
    "terminalId": "terminal-pane-xxxx", "generation": 7,
    "desktopOutputState": "backpressured", "reason": null,
    "leaseToken": "opaque", "parsedAck": 524288, "writeSeq": 524289,
    "ringStartSeq": 0, "ringEndSeq": 524289,
    "deliveryObservedSeq": 524289, "pendingDeliveryBytes": 1,
    "activeGrantId": null, "receiptSlot": null
  }],
  "frontend": {               // 프론트가 마지막에 보고한 내용(null 가능)
    "sentAtMs": 1779999962500,
    "probeLagMs": 0, "probeLagMaxMs": 41230, "stalls": 3,
    "bridge": { "requestsReceived": 128, "responsesSent": 91,
                "responsesFailed": 1,
                "queriesDroppedExpired": 25, "actionsRunAfterDeadline": 2,
                "maxDeliveryLagMs": 40980 },
    "pipeline": { "terminal-pane-xxxx": {
      "deltaEvents": 12000, "segmentsIn": 12000,
      "writeRequests": 11980, "xtermWrites": 340,
      "writeQueueMaxBytes": 248320, "xtermParseMaxMs": 18,
      "writeCallbackFailures": 0, "writeCallbackRefreshFailures": 0, "…": 0
    } },
    "inputDelivery": { "terminal-pane-xxxx": {
      "attempts": 12, "succeeded": 11, "failed": 1,
      "attemptedBytes": 24, "succeededBytes": 23, "failedBytes": 1
    } },
    "terminalOutputV3": { "terminal-pane-xxxx": {
      "state": "active", "reason": null, "generation": 7,
      "leaseToken": "opaque", "attachEpoch": 2,
      "snapshotSeq": 0, "admittedSeq": 524289, "parsedSeq": 524288,
      "nextEnvelopeId": 42, "activeGrantId": null
    } }
  }
}
```

판정 순서는 `lastReportAgeMs` 먼저다 — **큰 값이면 WebView 메인 스레드 자체가 멈춘 것**이고, **작은 값 옆에서 `bridge.requestTimeouts`만 오르면** 스레드는 살아 있고 `automation-request` 이벤트가 큐에 밀린 것이다. `terminalOutput[]`은 WebView를 거치지 않고 현재 Rust `TerminalOutputSession`에서 합성한 backend SoT라 프론트가 멈춰도 `healthy | backpressured | failStopped`, reason, generation/token, parsed/write/ring/delivery bounds, active grant와 receipt slot을 읽을 수 있다. `frontend.terminalOutputV3`는 마지막 health report가 전달한 mount-local surface identity/frontier이므로 report age와 함께 읽고 backend 상태를 대체하지 않는다. 두 쪽 모두 terminal payload bytes를 담지 않는다. 프론트의 `responsesSent`는 Rust가 IPC command를 받아들였다는 뜻이고 실제 HTTP waiter와의 결합은 Rust의 `responsesMatched`/`responsesOrphaned`가 구분한다. `writeBackpressure`는 xterm이 아직 받아들이지 않은 batch를 같은 byte로 재시도한 횟수이고, `writeCallbackFailures`와 source/stage별 하위 카운터는 xterm이 이미 받아들인 byte 뒤 embedder 완료 작업의 실패다. 후자는 sequence gap이 아니며 callback에서 절대 재시도하지 않는다([ADR-0084](../adr/0084-desktop-terminal-output-parsed-credit.md)). `frontend.inputDelivery`는 human raw input의 한 번 제출과 IPC completion만 기록한다. 실패는 backend 미수락의 증명이 아니므로 counter나 health report가 retry/recovery 결정을 만들지 않으며 payload는 절대 포함하지 않는다([ADR-0096](../adr/0096-terminal-human-input-write-failure-observability.md)). `frontend.pipeline`과 v3 terminal state의 나머지 terminal별 의미는 [data-flow.md §8.8](data-flow.md)이 소유한다. 응답은 identity·상태·카운터·지연·sequence 수치뿐이며 터미널 바이트·경로·설정을 담지 않고, 기존 IP allowlist 아래 있다.

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

포트가 응답한다는 사실만으로는 같은 빌드 종류의 어느 워크트리인지 알 수 없다. `/api/v1/health`는
[ADR-0083](../adr/0083-automation-health-instance-identity.md)에 따라 실제 응답 프로세스와 빌드 신원을 함께 반환한다.

```jsonc
{
  "status": "ok",
  "version": "0.8.1",
  "port": 19281,
  "instance": {
    "pid": 12345,
    "buildKind": "dev", // "dev" | "release"
    "executablePath": "D:\\trees\\laymux\\target\\debug\\laymux.exe",
    "worktreeRoot": "D:\\trees\\laymux",
    "gitCommit": "0123456789abcdef0123456789abcdef01234567",
    "gitBranch": "fix/625-dev-instance-identity"
  }
}
```

- `pid`는 이 응답을 만든 프로세스, `buildKind`는 포트와 같은 debug/release 판정이다.
- `gitCommit`은 Git checkout에서 빌드하면 dev/release 공통으로 제공하며, Git 관리 정보가 없는 source archive 빌드는 `null`이다.
- `executablePath`·`worktreeRoot`·`gitBranch`는 로컬 경로·사용자명·작업명을 포함할 수 있어 **dev에서만 값**이고 release에서는 명시적 `null`이다.
- build identity는 빌드 시점 스냅샷이다. `gitCommit`은 uncommitted diff를 나타내지 않으므로 dev 측정 도구는 기대 `worktreeRoot`·commit과 필요하면 checkout dirty 상태를 별도로 대조한다.
- 고정 포트는 발견 수단이지 인스턴스 신원이 아니다. 측정 전에 한 번의 health 응답에서 기대 PID/워크트리/commit을 검증한다.

### 12.3 엔드포인트

> **전체·정본 엔드포인트 목록은 `REGISTERED_ROUTES`(`automation_server/types.rs`)와 `GET /api/v1/docs`(JSON 자기설명)가 SoT** 다. e2e 테스트가 `build_router()` ↔ `/docs` 일치를 강제한다(현재 `REGISTERED_ROUTES` 57개 = REST 56 + `/mcp` 와일드카드). 아래 표는 대표 엔드포인트 요약이며 전수 목록이 아니다.

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/v1/docs` | API 자기 설명 (전체 엔드포인트, 파라미터, 사용법을 JSON으로 반환) |
| GET | `/api/v1/health` | 헬스체크 + 응답 프로세스·빌드 신원(`instance`) |
| GET | `/api/v1/diagnostics/frontend` | Rust terminal-output v3 상태 + 마지막 프론트엔드 vitals 합성 (브리지 미경유 — 프론트가 멈춘 동안에도 답한다) |
| GET | `/api/v1/workspaces` | 워크스페이스 목록 |
| GET | `/api/v1/workspaces/active` | 활성 워크스페이스 |
| POST | `/api/v1/workspaces/active` | 워크스페이스 전환 |
| POST | `/api/v1/workspaces` | 워크스페이스 생성 (layoutId로 Layout 지정) |
| PUT | `/api/v1/workspaces/:id` | 이름 변경 |
| DELETE | `/api/v1/workspaces/:id` | 삭제 |
| POST | `/api/v1/workspaces/:id/clear` | 워크스페이스의 모든 TerminalView pane 에 Ctrl+L 브로드캐스트. 응답은 pane 별 결과(`cleared`/`skipped`/`failed`) |
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
| GET | `/api/v1/usage` | Claude 사용량 스냅샷 목록 (config dir 당 1개 → `{ usage: [...], count }`). 각 항목은 `session` · `weekAll` · `weekModel`(+`weekModelLabel`, 예 `Fable`) 3행. 읽기 전용·부작용 없음 — probe 를 기동시키지 않으므로 빈 목록은 "구독 없음"을 뜻한다. `status.type === "ready"` 일 때만 숫자가 유효하고, `reset` 은 Claude Code 원문 그대로다 |
| GET | `/api/v1/memos` | 모든 메모 목록 조회 (`cache/memo.json` → `{ memos: [{ key, content }, ...], count }`) |
| GET | `/api/v1/memos/:key` | 특정 키의 메모 내용 조회 (없으면 404) |
| GET | `/api/v1/notifications` | 알림 목록 |
| GET | `/api/v1/layouts` | 레이아웃 목록 |
| POST | `/api/v1/screenshot` | 스크린샷 캡처 → `.screenshots/`에 저장 |
| POST | `/api/v1/ui/file-viewer` | 통합 파일 뷰어 오버레이 열기 (`path` 필수, `newWindow` 선택) — #277/#279/#404 |
| POST | `/api/v1/workspaces/reorder` | 워크스페이스 순서 변경 |
| POST | `/api/v1/grid/hover` | hover 시뮬레이션 |
| POST | `/api/v1/panes/:index/resize` | Pane 크기 조정 — 공유 경계를 이웃과 함께 이동 (`dw`/`dh` 상대 delta, 해당 축에 경계가 없으면 오류. [data-flow §5](./data-flow.md), [ADR-0071](../adr/0071-pane-resize-single-boundary-owner.md)) |
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
- 응답: `{ "path": ".../.screenshots/screenshot_xxx.png", "size": 12345, "captureStartedAtMs": 123, "terminalOutputV3AtCaptureStart": { ... } }`. `captureStartedAtMs`와 v3 frontier snapshot은 WebView main thread가 실제 capture handler에 진입한 직후, `html2canvas` 전에 함께 고정한다. 따라서 backend가 요청 전 읽은 오래된 health report가 아니라 캡처 시작 시점의 parser backlog를 판정할 수 있다. payload byte는 포함하지 않는다.
- `.screenshots/*.png`는 `.gitignore`에 의해 버전 관리 제외

### 12.6 보안

- `0.0.0.0` 바인딩 (WSL2에서 Windows 호스트 접근 허용)
- IP allowlist 미들웨어: loopback, RFC 1918 사설 대역(10.x, 172.16-31.x, 192.168.x), link-local(169.254.x, fe80::)만 허용
- 인증 헤더 불필요 — 로컬/사설 네트워크 IP 제한만으로 보안 확보 (Chrome DevTools, Jupyter 등과 동일 모델)
- 외부 공인 IP에서 접근 시 403 Forbidden 반환
- `/api/v1/health`의 dev 응답은 대상 검증을 위해 로컬 실행 파일·워크트리 절대 경로와 브랜치명을 공개한다. release 응답은 이 세 필드를 `null`로 redaction하고 PID·version·commit만 공개한다([ADR-0083](../adr/0083-automation-health-instance-identity.md)).
- IP allowlist 거절 응답은 laymux 가 관측한 클라이언트 주소를 포함한다: `{ "error": "... client IP: <ip>", "clientIp": "<ip>" }`
- **등록되지 않은 경로는 404** 다. Automation 라우터와 remote 라우터를 merge 한 뒤 서버 전체가 명시적 fallback 하나를 소유하며, 응답은 `{ "error": "no such route: <METHOD> <path>", "method", "path", "docs": "/api/v1/docs" }` 다. 라우트 인증 게이트가 미등록 경로를 대신 답하면 경로 오타가 인증 실패로 오진된다([#591](https://github.com/kochul2000/laymux/issues/591)) — `axum::Router::layer` 는 fallback 까지 감싸고 `merge` 는 그 fallback 을 합쳐진 라우터에 넘기므로, 라우트 인증은 반드시 `route_layer` 로 붙인다.
- 이 404 fallback 에도 IP allowlist 는 그대로 적용한다. IP allowlist 는 라우트 인증이 아니라 네트워크 경계이므로, 허용 밖 peer 가 404/401 차이로 라우트 존재 여부를 스캔하지 못하게 한다. 즉 허용 밖 peer 는 미등록 경로에서도 403 을 받는다.
- 합성 라우터는 fallback 을 등록한 뒤 최외곽에 `CorsLayer`를 적용한다. 따라서 등록 라우트뿐 아니라 공용 404와 allowlist 403도 `Access-Control-Allow-Origin`을 포함해 브라우저·WebView가 JSON 본문을 읽을 수 있다([ADR-0070](../adr/0070-unmatched-route-boundary-ownership.md)).

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
| `execute_command` | AppState 직접 | 명령 실행 + 출력 수집 (per-terminal 세마포어, sequence number). exec lock 획득 뒤 실제 PTY write 직전에 공용 strict activity detector로 ring·known app·grace/exit cache·PTY registry 건강성과 `Shell` 상태를 다시 검증하며, 오류/TUI/실행 중 상태는 0-byte tool error로 차단 |

`write_to_terminal`·`write_to_neighbor`·`broadcast_write`·`execute_command`는 exec lock을 선택할 때 terminal output generation을 함께 캡처한다. async lock 대기 뒤 실제 write admission은 `terminals → terminal-output session registry → pty_handles` 순서의 한 임계구역에서 generation 일치와 handle 존재를 재검증하고 그 `PtyHandle`을 clone한다. operation의 body·제출 CR은 이 clone만 사용하며 terminal id로 handle table을 다시 조회하지 않는다. admission 뒤 close가 이기면 old handle 종료로 남은 write가 실패하고, 같은 id로 생성된 새 terminal에는 입력하지 않는다([ADR-0088](../adr/0088-pty-output-fatal-generation-teardown.md)).

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
| `split_pane` | bridge_request | 팬 분할 (`ready` 필드로 렌더 완료 여부 표시). `cwd` 생략 시 분할 대상 팬의 CWD 를 상속하고, 주면 그 값이 이긴다 ([ADR-0140](../adr/0140-split-pane-inherits-source-cwd.md)) |
| `remove_pane` | bridge_request | 팬 제거 |
| `resize_pane` | bridge_request | 팬 크기 조정 — 공유 경계를 이웃과 함께 이동 (`dw`/`dh` 상대 delta, 해당 축에 경계가 없으면 오류. [ADR-0071](../adr/0071-pane-resize-single-boundary-owner.md)) |
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

**FileViewer preview 정책 (#404/#446, [ADR-0109](../adr/0109-file-viewer-typed-preview-renderers.md))** — File Explorer, `Ctrl+Shift+O`, REST `/api/v1/ui/file-viewer`, MCP `open_file_viewer`/`show_image`는 모두 `ui/src/components/ui/FileViewer.tsx`의 단일 렌더 경로를 재사용한다.

렌더러 선택은 두 축이고 소유자가 다르다. **내용 종류(`kind`)는 Rust `read_file_for_viewer`가 소유**하며 `text | image | pdf | archive | binary` 중 하나다. **preview 종류는 프론트엔드가 경로 확장자로 소유**하고(`ui/src/lib/file-preview-kind.ts`), 내용 스니핑은 하지 않는다. 둘 중 어느 쪽보다 `settings.fileExplorer.extensionViewers` 매핑이 우선하므로, 사용자가 확장자에 외부 터미널 뷰어를 걸어 두면 내장 렌더러가 그것을 빼앗지 않는다.

preview 종류는 신뢰 경계로 두 계열로 갈리고, 계열이 렌더 방식을 강제한다.

| 계열 | previewKind | 확장자 | 렌더 |
|---|---|---|---|
| document | `html`, `markdown` | `.html .htm` / `.md .markdown` | sanitizer → 제한 CSP → `sandbox` iframe `srcdoc` |
| structured | `json` | `.json .jsonc` | 접이식 트리 (React DOM) |
| structured | `jsonl` | `.jsonl .ndjson` | 행 목록, 펼치면 JSON 트리 재사용 |
| structured | `diff` | `.diff .patch` | 파일/헝크 단위 색상 diff |
| structured | `csv` | `.csv .tsv .tab` | sticky 헤더 테이블 |
| structured | `log` | `.log` | ANSI SGR 색상 + 레벨 하이라이팅 |
| structured | `code` | 문법이 있는 소스 확장자 | shiki 토큰 하이라이팅 |

**structured 계열은 HTML 문자열을 만들지 않는다.** 순수 파서(`ui/src/lib/preview/`)가 텍스트를 값으로 바꾸고 컴포넌트(`ui/src/components/ui/preview/`)가 그 값을 React 로 그린다. 이 경로에는 `dangerouslySetInnerHTML`·`innerHTML`·`DOMParser` 가 없으며, 그래서 sanitizer 도 없다. 문법 하이라이터는 토큰 배열을 돌려주는 API 로만 호출하고 HTML 을 돌려주는 API 는 쓰지 않는다. document 계열만 아래의 sanitizer/CSP 경로를 탄다.

`kind: "image"` 중 `.svg` 는 이미지↔소스 토글을 갖는다. 소스는 재요청 없이 backend 가 보낸 base64 를 디코드해 얻고, 렌더 측은 `<img>` 를 유지한다(마크업을 문서에 인라인하면 내부 스크립트가 실행된다). `kind: "pdf"` 는 blob URL 을 `<iframe>` 에 실어 호스트 WebView 의 내장 뷰어에 위임한다. `<object>` 가 아닌 이유는 실측이다 — WebView2 는 `<object>`(type 유무 무관)로는 PDF 를 렌더하지 않고 곧장 fallback 으로 떨어지지만 같은 blob 을 iframe 에 실으면 Chromium 뷰어가 뜬다. iframe 에는 fallback 슬롯이 없고 렌더 실패를 감지할 방법도 없으므로(`load` 는 양쪽에서 발화) 외부 열기 버튼을 상시 노출한다. 엔진에 PDF 뷰어가 없는 플랫폼(Linux WebKitGTK)에서는 프레임이 비고 그 버튼이 출구다 — 플랫폼 간 렌더 동등성은 비목표다. `kind: "archive"`(zip 계열·tar·tar.gz)는 압축을 풀지 않고 중앙 디렉터리/헤더 메타데이터만 나열한다.

Rust 의 `TEXT_EXTENSIONS`(`commands/file_viewer.rs`)는 표시 힌트가 아니라 **분류 게이트**다. 목록에 없는 확장자는 크기 상한(`DEFAULT_FILE_VIEWER_BYTES`, 1 MiB)을 넘는 순간 `binary` 가 되어 preview 경로에 도달하지 못하므로, 렌더러가 주장하는 확장자는 이 목록에도 있어야 한다.

모든 structured 렌더러는 표시량 상한을 가지며 **잘렸으면 화면에 전체 개수와 함께 그 사실을 표시한다**. 절단은 두 층에서 일어나며 둘 다 표시 대상이다 — 렌더러 자신의 상한(행·레코드 수)과, 그보다 앞서는 backend 의 `truncated`(읽기 바이트 상한). 후자는 렌더러가 알 수 없으므로 `FileViewer` 가 structured 분기 위에 공통 배너로 붙인다. 붙이지 않으면 잘린 CSV 가 완전한 것처럼 보이고, 잘린 JSON 은 파일에 없는 구문 오류를 보고한다(그래서 JSON 은 절단 시 오류 문구 자체를 바꾼다).

`.jsonc` 의 관용 범위는 **주석과 trailing comma 까지**다. `.json5` 는 unquoted key·single-quote 문자열·`Infinity` 등 그 범위를 넘으므로 **claim 하지 않고** plain source 로 떨어뜨린다 — claim 한 뒤 실패시키면 멀쩡한 JSON5 파일을 "invalid JSON" 이라고 고발하게 된다.

파싱 실패·손상 아카이브·하이라이터 로드 실패는 뷰어 실패가 아니라 원문 표시 폴백이며 사유를 함께 보여준다.

이하 document 계열 세부:

`.html`/`.htm`과 `.md`/`.markdown`은 기본 `preview` 모드로 열리지만, `settings.fileExplorer.extensionViewers`에 해당 확장자 매핑이 있으면 외부 터미널 뷰어가 우선한다. 이때 프론트엔드는 `create_terminal_session`에 profile과 구조화된 `viewer: { command, path }`를 전달하고, Rust가 현재 settings의 확장자·command·profile 조합 및 profile 존재를 다시 검증한다. Rust는 `profile.commandLine`의 대상 환경에 맞춰 `path_utils`로 경로를 변환하고 path 인자를 WSL/POSIX 또는 PowerShell 규칙으로 quote한다. explicit `\\wsl.localhost\<distro>` pure-Linux 경로를 WSL profile에 전달할 때는 unquoted `-d`/`--distribution` 선택 distro와 source distro가 일치해야 하며, mismatch·bare WSL·quoted distro는 거부한다(`/mnt/<drive>`는 distro 공용 예외). 일반 `startupCommandOverride`는 `<claude.command> --resume <session-id>`와 `<codex.command> resume <session-id>` 두 정확한 세션 복원 형식만 허용하며(접두어는 디스크 settings 에서 재도출, [ADR-0125](../adr/0125-configurable-agent-launch-command.md)) raw viewer 문자열은 거부한다([ADR-0117](../adr/0117-codex-session-restore.md)). 내장 preview의 `source` 토글은 Rust `read_file_for_viewer`가 반환한 기존 raw text를 그대로 표시한다. HTML preview는 `srcdoc` iframe + `sandbox="allow-same-origin"` + 제한 CSP를 사용한다. Markdown은 `marked`의 동기 GFM 모드로 HTML을 만들고 `github-markdown-css`의 `markdown-body` 스타일을 iframe 문서에 내장한 뒤, HTML preview와 동일한 sanitizer/CSP 경로를 탄다. 스크립트, 이벤트 핸들러, 폼, iframe/object/embed, 위험 URL은 제거하며, 링크 클릭은 부모가 `openExternal`로 처리한다. 상대 이미지/CSS 등 로컬 상대 리소스는 이번 설계에서 지원하지 않고 차단한다. 임의 파일 노출을 피하기 위한 보수적 기본값이며, 상대 리소스가 필요해지면 별도 allowlist/custom endpoint/custom protocol 설계와 경계 테스트를 추가한다.

**메모 (2)** — `cache/memo.json` 파일 시스템 기반, 읽기 전용:

| Tool | 구현 방식 | 설명 |
|------|-----------|------|
| `get_claude_usage` | 백엔드 상태 | Claude 사용량 스냅샷 (config dir 당 1개). 최대 10분 낡을 수 있고(`capturedAtMs`) 조회가 probe 를 기동시키지 않는다 |
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
  출력을 ANSI 제거 + tail 절단(상한 2000자)해 반환한다. 정상 성공은 `captureMs` +
  `response` + `responseTruncated`를 포함한다. pre-write registry/ring sampling 실패는 PTY write
  전에 tool error다. write 성공 뒤 capture가 실패하면 빈 성공으로 바꾸지 않고 `written=true`,
  byte count, target id, `captureFailed=true`, `captureError`, `sideEffect`를 보존한 tool error를
  반환하므로 호출자가 이미 적용된 입력을 맹목적으로 재시도하지 않는다. 대기는 exec 락 밖에서
  하므로 같은 pane의 다른 write를 블록하지 않는다.
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
| `/remote/vendor/addon-web-links.js` | GET | `/remote/` 전용 xterm 평문 URL 링크 애드온 |
| `/remote/font/{token}.{ttf\|otf}` | GET | 데스크톱 터미널 폰트 사본 (ADR-0077). `token` = 콘텐츠 sha256 앞 16 hex |
| `/remote/manifest.webmanifest` | GET | 홈 화면 설치용 web app manifest (ADR-0091) |
| `/remote/pwa/{file}` | GET | manifest launcher 아이콘과 `apple-touch-icon` PNG |
| `/remote/viewer/` | GET | 자격 증명이 없는 Remote FileViewer 새 탭 bootstrap |
| `/remote/viewer/viewer.js` | GET | Remote FileViewer 외부 script (`script-src 'self'`) |

`/remote`와 `/remote/`는 remote가 실효적으로 켜져 있고(`settings.remote.enabled || runtimeRemoteAccess.enabled`), 실효 remote token이 있으며, remote IP allowlist를 통과할 때 응답한다. Cloud tunnel 내부 요청은 크레이트 내부 전용 `TunnelAuthorized` marker가 있을 때 token/IP/Origin 검사를 우회하지만, 이 page route도 실효 enabled gate는 반드시 통과해야 한다. 이 HTML 문서 자체는 토큰 값을 요구하지 않지만, 페이지가 호출하는 `/remote/v1/*` 제어 API는 아래 인증 정책을 그대로 따른다. 사용자는 브라우저 주소창에서 `http://<laymux-host>:19280/remote/` 또는 dev의 `:19281/remote/`를 열고 remote token을 입력해 controller lease를 claim한다. 편의를 위해 `/remote/#token=<url-encoded-token>`도 허용하며, 이 값은 remote 페이지의 token 입력란을 미리 채우는 용도다. fragment는 HTTP 요청에 포함되지 않으므로 링크 공유용 prefill에는 query string보다 이 형태를 우선 사용한다.

`settings.json`은 Remote 설정의 영속 정본이다. Rust는 앱 시작 시 `settings.remote`를 `AppState.remote_access`의 메모리 snapshot으로 적재하고, `save_settings`/`reset_settings` 및 cloud pairing/disconnect 설정 저장이 디스크에 성공한 뒤 같은 snapshot을 갱신한다. `save_settings`/`reset_settings`가 실효 enabled 상태를 바꾸면 snapshot 교체와 owner gate 전환을 한 트랜잭션으로 시작하고 `remote-control-changed`를 발행하며, 전환 결과에 맞춰 cloud tunnel lifecycle도 reconcile한다. cloud pairing/disconnect는 access gate를 건드리지 않고 cloud 필드만 snapshot에 반영한다. human-control permit 생성과 resize/write 입력 핫패스는 이 snapshot에 runtime access override만 합성하며 설정 파일을 다시 읽거나 JSON migration·validation을 수행하지 않는다.

현재 브라우저 entry는 Rust remote server가 self-hosted xterm.js 자산을 `/remote/vendor/*`에서 제공하는 중간 구현이다. CDN이나 Vite dev server에 의존하지 않으며, 출력 WebSocket의 PTY byte stream을 xterm에 그대로 기록하고 xterm 입력/resize 이벤트를 Remote UI API로 다시 보낸다. ADR-0013의 최종 목표인 같은 React bundle 기반 Full UI/Focused UI 전환과 `RemoteHttpWsClient` adapter 추출은 후속 리팩터링 대상이다.

`/remote/vendor/*`도 `/remote/`와 같은 base access 조건(실효 enabled, 실효 token 존재, IP allowlist)을 통과해야 응답한다. Cloud tunnel 내부 요청은 token/IP/Origin 대신 `TunnelAuthorized` marker를 신뢰하지만, vendor route도 실효 enabled gate는 공유한다. 실제 controller 권한은 vendor asset이 아니라 `/remote/v1/*` API의 bearer token + lease 검사에서 결정된다.

`/remote/font/{token}.{ttf|otf}`는 vendor asset과 같은 gate를 쓰는 폰트 route다([ADR-0077](../adr/0077-remote-terminal-font-serving.md)). `settings.remote.serveTerminalFont`가 켜져 있을 때만 appearance payload가 이 URL을 광고하며, route 자체는 등록되지 않은 token에 `404`를 돌려준다. `token`은 폰트 콘텐츠 sha256의 앞 16 hex이므로 URL이 곧 내용이며 `Cache-Control: public, max-age=31536000, immutable`과 `Vary: Accept-Encoding`을 보낸다. `Accept-Encoding`에 `br`이 있으면 한 번 만들어 캐시한 brotli 본을 `Content-Encoding: br`로 보내고, 아니면 원본 sfnt 바이트를 그대로 보낸다. woff2 컨테이너 변환은 하지 않는다.

`/remote/manifest.webmanifest`와 `/remote/pwa/*`는 vendor asset과 같은 base access gate를 쓰는 설치 자산이다([ADR-0091](../adr/0091-remote-client-standalone-web-app-manifest.md)). manifest는 `display: standalone`과 `scope`=`start_url`=`id`=`/remote/`를 선언하고 `application/manifest+json`, `Cache-Control: no-store`로 응답한다 — 컴파일 내장이라 revalidation 근거가 없고, 이미 설치된 앱 안에 stale한 `start_url`/아이콘 목록이 남으면 안 된다. 아이콘은 `image/png`, `Cache-Control: private, max-age=86400`이며 등록되지 않은 파일 이름은 404다. `page.html`의 manifest link는 `crossorigin="use-credentials"`를 반드시 갖는다 — manifest fetch는 기본적으로 credential을 생략하므로 gate 안쪽에서는 이 속성이 없으면 401이다. iOS/iPadOS도 manifest를 지원하지만 `apple-touch-icon`이 manifest 아이콘보다 우선하고 오래된 설치 경로는 `apple-mobile-web-app-*` 메타를 사용하므로 두 계열을 함께 둔다. 아이콘 PNG는 `ui/public/logo.svg`에서 `cd ui && npm run build:pwa-icons`로 생성해 커밋한 자산이다. service worker는 등록하지 않는다(오프라인 캐싱 비목표, cloud remote origin CSP는 `worker-src 'none'`). 설치 자체는 HTTPS origin(cloud relay, 또는 HTTPS 앞단을 둔 direct)에서만 성립하며 평문 HTTP direct에서는 브라우저가 manifest를 무시한다.

설치 권유 UI는 내비게이션 드로어 최하단의 `#installSection` 하나다([ADR-0100](../adr/0099-remote-client-install-affordance-in-drawer.md)). 상시 배너나 헤더 버튼을 두지 않는다 — ADR-0091이 되찾으려던 터미널 행을 다시 먹기 때문이다. 이 섹션은 기본 `hidden`이고, `window.isSecureContext`가 참이며 standalone 실행(`display-mode: standalone` 또는 iOS `navigator.standalone`)이 아니고, Chromium이 `beforeinstallprompt`를 발생시켰거나 iOS/iPadOS로 식별될 때만 나타난다. 클릭은 보관한 `beforeinstallprompt` 이벤트의 `prompt()`를 호출하고 그 이벤트를 즉시 버린다(재사용 불가); 이벤트가 없는 iOS에서는 "공유 → 홈 화면에 추가" 안내를 토글한다. `appinstalled` 이후에는 다시 숨는다 — 단 이 이벤트는 Chromium 경로에만 오고, iOS 는 공유 시트 설치로 이를 발생시키지 않으므로 그 탭에서는 다음 방문의 standalone 판정으로만 사라진다. 프롬프트를 자동으로 띄우지 않는다.

`/remote/viewer/*`도 같은 base access gate를 공유하고 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`를 보낸다. viewer HTML은 inline script나 자격 증명을 포함하지 않으며 `script-src 'self'`, `frame-ancestors 'none'` CSP를 적용한다. 파일 내용은 이 bootstrap route가 아니라 active lease를 요구하는 §13.3.1 API로만 가져온다.

### 13.1 인증과 접근 제어

- `settings.remote.enabled` 또는 런타임 remote 허용 상태가 `true`일 때만 응답한다.
- 실효 remote token은 필수다. `settings.remote.authToken`을 우선 사용하고, 이 값이 비어 있을 때만 런타임 허용 토큰을 사용한다. HTTP 요청은 `Authorization: Bearer <token>` 또는 `X-Laymux-Remote-Token`을 사용할 수 있고, WebSocket은 브라우저 제약 때문에 URL-encoded `?token=<token>`도 허용한다.
- Cloud tunnel이 내부 `oneshot` dispatch로 삽입하는 `TunnelAuthorized` marker는 wire에서 위조할 수 없는 크레이트 내부 marker다. 이 marker가 있으면 token/IP/Origin 검사는 우회하지만, `settings.remote.enabled || runtimeRemoteAccess.enabled` enabled gate와 controller lease 검사는 그대로 적용한다.
- `settings.remote.allowedIps`는 IP/CIDR allowlist다. 기본값은 loopback only이며 Tailscale 직접 접속은 예를 들어 IPv4 `100.64.0.0/10`, IPv6 `fd7a:115c:a1e0::/48`를 명시해야 한다.
- remote IP allowlist 거절 응답은 laymux 가 관측한 주소와 현재 allowlist를 포함한다: `{ "error": "... <ip>", "remoteIp": "<ip>", "allowedIps": [...] }`
- `remote_guard` 는 등록된 `/remote/v1/*` 라우트에만 적용한다(`route_layer`). 미등록 경로는 guard 를 거치지 않고 §12.6 의 공용 404 fallback 이 답한다. cloud tunnel 이 remote 라우터를 단독으로 서빙할 때도 미등록 경로는 401 이 아니라 404 다.
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

`/remote/v1/navigation`은 bearer token과 IP/Origin gate를 통과해야 하며 lease는 요구하지 않는다. 응답의 `workspaces`는 PC WebView `WorkspaceSelectorView`와 같은 `workspaceSelector.sortOrder`/`workspaceDisplayOrder` 규칙으로 정렬된 `{id,name,isActive,hidden,collapsed,paneCount,terminalPaneCount,liveTerminalCount,unreadCount,panes}` 요약이다. ADR-0018의 remote payload 호환성과 focused remote surface를 위해 숨김 워크스페이스와 숨김 pane도 제거하지 않고 `hidden`/`collapsed` 플래그로 전달한다. 다만 desktop selector는 ADR-0033 이후 숨김 행을 DOM 목록에서 필터하고 별도 보관함에서 복원하므로, remote의 `collapsed`는 remote 전용 표시 계약이지 desktop DOM 접힘 모델과의 1:1 일치를 뜻하지 않는다. 현재 active workspace는 전환 중인 raw snapshot에서도 `collapsed=false`로 유지해 현재 터미널 문맥을 잃지 않는다. `workspaces[].panes`는 active workspace에서만 채우고 inactive workspace는 빈 배열로 둔다. 각 pane 요약은 `{id,location,workspaceId,paneIndex,paneNumber,viewType,terminalId,terminalLive,title,profile,cwd,branch,activity,outputActive,commandRunning,isFocused,unreadCount,hidden,collapsed,x,y,w,h}` 형태이며, `unreadCount`는 terminal pane에만 부여하고 non-terminal pane은 항상 `0`이다. `activeWorkspace.panes`와 active `workspaces[].panes`는 같은 pane 요약을 쓰며 PC selector와 동일하게 `paneNumber` 오름차순으로 정렬한다. 이때 `paneIndex`는 정렬 후 위치가 아니라 원본 `WorkspacePane[]` 인덱스를 유지한다. `docks[]`는 workspace 목록과 섞지 않는 앱 전역 요약이며, `docks[].panes`는 `location="dock"`과 `workspaceId=null`을 사용해 workspace 소속 pane이 아님을 명확히 한다. Dock pane의 `unreadCount`는 workspace filter 없이 `terminalId` 기준으로만 계산하고, dock pane의 `isFocused`는 terminal store의 focus flag가 아니라 desktop dock focus SoT인 `focusedDock`/`focusedDockPaneId`에서 계산한다. `visible=false` dock은 remote page의 dock panel에서 렌더하지 않고 preferred terminal 후보에서도 제외한다. 즉 `preferredTerminalId` short-circuit과 fallback 모두 active workspace pane terminal 또는 visible dock pane terminal만 메인 출력으로 열 수 있다. 다만 `terminalLive`는 진입 조건이 아니다([ADR-0138](../adr/0138-remote-opens-queued-panes-on-entry.md)) — workspace lazy mount와 직렬 startup slot([ADR-0127](../adr/0127-terminal-startup-slot-follows-eligibility.md)) 때문에 아직 데스크톱에서 열리지 않은 pane은 정상 상태에서도 `terminalLive=false`이므로, `terminalId`가 있는 pane은 모두 선택 가능하고 live는 후보 자격이 아니라 동순위 tie-breaker다. Remote 폴백 순서는 focused pane → active workspace live pane → active workspace 미시작 pane → visible dock live pane → visible dock 미시작 pane이며, 셋 다 없을 때(= terminal pane 자체가 없을 때)만 열 터미널이 없다고 표시한다. 최상위 `workspaceSelector`는 remote drawer가 PC selector의 표시 토글/경로 ellipsis와 맞출 수 있게 하는 현재 selector 설정이며, `unreadNotificationCount`는 전체 unread 수다. `terminals`는 `/remote/v1/terminals` 항목에 frontend bridge의 `workspaceId`, `paneNumber`, `activity`, `isFocused` 등 탐색에 필요한 메타데이터를 병합한 목록이다.

Remote page는 같은 HTML 문서 생명주기에서 사용자가 마지막으로 선택해 attach한 `terminalId`를 메모리 hint로 유지한다. release, disconnect, 또는 서버가 확정한 lease 상실 뒤 사용자가 다시 연결하면 이 hint를 focused pane fallback보다 먼저 검토하되, 최신 navigation snapshot에서 active workspace의 live terminal 또는 visible dock의 live terminal인 경우에만 복원한다. terminal이 종료·삭제되었거나 inactive workspace/hidden dock으로 이동했으면 위 폴백 순서를 그대로 사용한다. 기억된 hint에만 live 요구가 남는 이유는, 재접속 시 이미 종료된 terminal을 사용자가 요청하지 않았는데 다시 시작해버리지 않기 위해서다 — 사용자가 방금 탭해서 진입한 pane은 반대로 열리는 동안 pinned로 고정해, 대기 중 실행되는 navigation 재조회가 다른 pane으로 표류하지 않게 한다([ADR-0138](../adr/0138-remote-opens-queued-panes-on-entry.md)). 이 hint는 surface-local 편의 상태이므로 `localStorage`/`sessionStorage`에 저장하지 않으며 page reload 뒤에는 host navigation 상태에서 다시 선택한다.

Remote page는 이 hint의 workspace별 변형도 유지한다(issue #508). 각 workspace에서 사용자가 마지막으로 attach한 workspace terminal의 `terminalId`를 workspace ID별로 기억하고, 접힌 workspace로 진입할 때(`/remote/v1/workspaces/active` 뒤 navigation 재조회) 그 workspace의 hint를 preferred terminal로 먼저 검토해 첫 pane 대신 마지막으로 머문 pane을 복원한다. host는 여전히 workspace별이 아닌 단일 focused pane만 노출하므로(§13.3 `focusedPaneNumber`) 이 workspace별 복원은 Remote surface에서만 이뤄진다. 복원 판정은 단일 hint와 동일하게 최신 navigation snapshot에서 해당 pane이 now-active workspace의 live terminal일 때만 적용하고, hint가 없거나(최초 진입) 무효하면 위 폴백 순서를 그대로 쓴다. dock terminal(`workspaceId` 없음)은 이 map에 기록하지 않으며, 단일 hint와 마찬가지로 surface-local이고 `localStorage`/`sessionStorage`에 저장하지 않는다.

Workspace 전환의 착지 계약(issue #578, [ADR-0081](../adr/0081-pane-focus-transition-single-owner.md)). `focusedPaneIndex`는 활성 workspace를 기준으로 해석되는 단일 전역 grid 인덱스이므로 전환 시 그대로 물려받으면 대상 workspace의 엉뚱한 pane을 가리키거나(작은 workspace로 이동하면) 마지막 pane을 넘어간다. frontend bridge action `workspaces.switchActive`는 그래서 desktop selector·키보드 전환과 같은 상태 전환(`ui/src/lib/workspace-transition.ts`)을 호출하고, 그 안에서 순수 규칙(`ui/src/lib/workspace-switch.ts`의 `resolveWorkspaceLandingPane`)으로 착지 pane을 다시 계산한다 — dock focus 중이거나 focus가 없으면 첫 pane, 범위를 넘으면 마지막 pane으로 clamp, 그 밖에는 현재 위치 유지, pane이 없는 workspace는 focus 없음. 응답에 `{switched, landingPaneIndex, landingPaneNumber, landingTerminalId}`를 담아 착지 지점을 호출자가 되읽을 수 있게 한다(`workspaces.getActive`의 `focusedPaneNumber`와 일치). 존재하지 않는 workspace id는 어떤 store도 건드리지 않고 `Workspace '<id>' not found` 에러로 답한다 — 성공 응답의 `landing*` 필드가 null인 것(pane 없는 workspace로 정상 전환)과 구분되며, `workspaces.remove`/`rename`과 같은 계약이다. 또한 workspace는 lazy mount이고 terminal 시작은 직렬화되므로([ADR-0043](../adr/0043-global-terminal-ready-startup-slot.md)) 전환 직후에는 대상 workspace의 pane에 아직 세션이 없다. 그 순간 상태를 읽은 Remote client는 active workspace에 live terminal이 하나도 없다고 보고 메인 출력을 dock terminal로 폴백해버리므로, `workspaces.switchActive`는 [ADR-0039](../adr/0039-remote-spatial-notification-step-navigation.md)의 스텝 착지와 동일하게 착지 terminal의 세션 준비를 기다린 뒤 응답한다. 대기 상한은 **3.5초**(`WORKSPACE_SWITCH_LANDING_READY_TIMEOUT_MS`)로 `terminals.setFocus`(20초)보다 짧다 — Rust bridge의 요청 예산 5초(`helpers.rs`의 `FRONTEND_RESPONSE_TIMEOUT`) 안에 lazy mount·React 렌더까지 들어가야 하기 때문이다. 두 숫자는 언어가 달라 서로를 상수로 미러링하고 양쪽 테스트가 여유를 단정하므로, 한쪽만 옮기면 테스트가 깨진다. 상한을 넘겨도 전환은 이미 일어났으므로 실패로 바꾸지 않고 `landingReady`로만 알린다. `landingReady`는 3-상태다: 기다릴 세션이 없었으면(착지 pane이 terminal이 아니거나 pane이 없는 workspace) `null`, 세션이 준비됐으면 `true`, 상한을 넘겼으면 `false`.

`/remote/v1/workspaces/active` body는 `{ "id": "...", "leaseId": "..." }`, `/remote/v1/terminals/{id}/focus` body는 `{ "leaseId": "..." }`다. 둘 다 `X-Laymux-Remote-Lease` 헤더도 허용하며, 성공 시 `workspace-state-changed` event를 발행해 MCP resource 구독자와 Automation resource cache가 stale 상태에 머물지 않게 한다. Remote workspace 전환은 해당 workspace의 unread notification을 읽음 처리하고, remote terminal focus는 해당 terminal의 unread notification을 읽음 처리한다. 이 처리는 focused remote UI의 명시적 navigation action에 대한 소비 동작이며, 숨김 항목 편집 자체는 desktop WorkspaceSelectorView와 기존 Automation/MCP `ui.toggle*Hidden` 호환 경로가 담당한다.

`/remote/v1/navigation`은 최상위 `notifications` 목록도 포함한다. 각 항목은 `{id,title,message,level,createdAt,readAt,isRead,workspaceId,workspaceName,terminalId,terminalLabel,requiresAction}` 형태이며 desktop `NotificationPanel`과 같은 규칙으로 정렬한다. 즉 unread notification을 먼저 두고, unread/read 각 그룹 내부는 최신 삽입 순서를 따른다. Remote page는 이 정렬된 목록에서 처음 등장한 workspace 순서대로 그룹화해 표시한다. 알림 tap은 연관 대상이 있으면 기존 navigation action을 재사용한다: workspace 대상은 `/remote/v1/workspaces/active`, terminal 대상은 `/remote/v1/terminals/{id}/focus`를 호출하고, 대상이 없는 알림은 `/remote/v1/notifications/{id}/read`로 해당 id만 읽음 처리한다. Mark-all-read는 frontend bridge `notifications.markAllRead`를 사용하고, clear-all은 `notifications.list`로 id를 수집한 뒤 기존 `notifications.clear`에 ids를 넘긴다. 이 notification endpoint들은 remote controller action이므로 active lease를 요구하지만, `/remote/v1/navigation`은 계속 token-gated read-only query다.

`/remote/v1/navigation/spatial`과 `/remote/v1/navigation/notification`은 스텝 내비게이션 controller action이다([ADR-0039](../adr/0039-remote-spatial-notification-step-navigation.md)). 공통 body는 `{ "leaseId": "...", "direction": "..." }`이며 `X-Laymux-Remote-Lease` 헤더도 허용한다. direction은 spatial이 `"prev"|"next"`, notification이 `"recent"|"oldest"`(데스크톱 `notifications.recent/oldest` 액션과 동일 명명)이고 그 외 값·누락은 `400`이다. Spatial body는 Remote 클라이언트가 관리하는 선택적 `excludedPaneIds: string[]`와 `excludedWorkspaceIds: string[]`를 추가로 받으며 각각 누락은 빈 배열과 같다([ADR-0046](../adr/0046-remote-spatial-pane-exclusions.md), [ADR-0047](../adr/0047-remote-spatial-workspace-exclusions.md)). Rust 핸들러는 lease 검증과 중계만 수행하고, 순회 계산·store 조작은 frontend bridge action `navigation.spatialStep`/`navigation.notificationStep`이 담당한다. 공간순서는 (표시순 visible workspace) × (workspace 내 `paneNumber` 오름차순 TerminalView pane)의 순환 1D 리스트다 — hidden workspace 제외(active-hidden은 앵커로만), hidden pane 포함, non-terminal pane 제외, dock 제외, `terminalLive` 무관. Spatial step은 이 eligible 목록에서 자기 ID가 `excludedPaneIds`에 있거나 소속 workspace ID가 `excludedWorkspaceIds`에 있는 pane을 제거하며 stale/non-eligible ID는 무시한다. 두 제외 목록이 모두 없으면 모든 eligible pane이 기본 포함되고, 그 결과 남는 pane이 없으면 전체 폴백 없이 `no_included_panes` no-op을 반환한다. 알림 스텝은 제외 목록과 무관하게 데스크톱 키보드와 같은 `findNotificationNavTarget` 규칙(unread만, `createdAt` 정렬, 동일 terminal 연속 그룹 소비)을 공유한다. 성공 응답은 `{moved:true, target:{workspaceId, workspaceName, terminalId, paneId, paneIndex, paneNumber, switchedWorkspace}}`(notification은 `consumedNotificationIds` 추가)이고, 이동할 곳이 없으면 에러가 아닌 `{moved:false, reason:"no_terminal_panes"|"no_included_panes"|"no_other_target"|"no_unread_notifications"}`를 반환한다. `navigation.spatialStep`은 착지 터미널의 세션 준비를 기다린 뒤 응답하며(async bridge 경로), Rust는 spatial 성공 시 착지 터미널 unread를 `notifications.markTerminalRead`로 best-effort 읽음 처리하고 성공 시 `workspace-state-changed`를 발행한다. Remote page는 응답 `target.terminalId`로 메인 출력 attach를 follow한다.

Remote 공간순회 제외 상태의 SoT는 PC가 아니라 각 Remote 페이지의 `localStorage`다. pane 단위 제외는 키 `laymux.remote.spatialExcludedPaneIds`(Set&lt;paneId&gt;), workspace 단위 제외는 키 `laymux.remote.spatialExcludedWorkspaceIds`(Set&lt;workspaceId&gt;)에 문자열 배열로 저장하며, 저장값이 없거나 잘못되면 각각 빈 집합으로 복구해 모든 eligible pane을 포함한다. 현재 출력이 active workspace TerminalView일 때만 Remote 상단 바에 pane 건너뛰기 토글을 표시하고 pressed 상태 pane ID를 `excludedPaneIds`에 싣는다. 왼쪽 drawer의 각 workspace 행에는 같은 circle-minus 아이콘의 workspace 건너뛰기 토글을 두며(터미널 pane이 있는 workspace만), pressed 상태 workspace ID를 `excludedWorkspaceIds`에 싣는다. Dock/no-terminal 문맥에서는 pane 토글을 숨기고 PC `PaneControlBar`, `paneOverrides`, settings/layout에는 관련 상태나 표시를 두지 않는다([ADR-0047](../adr/0047-remote-spatial-workspace-exclusions.md)).

두 granularity는 승격/강등 규칙으로 일관성을 유지한다(issue #507): pane ID를 아는 active workspace에 한해 **그 workspace ID가 workspace 제외 집합에 있음 ⟺ 그 workspace의 모든 terminal pane이 pane 제외 집합에 있음**을 불변식으로 둔다. 상단 pane 토글로 마지막 남은 pane까지 제외하면 workspace가 자동 승격되고, 한 pane이라도 다시 포함하면 자동 강등된다. drawer의 workspace 토글은 active workspace의 모든 pane ID를 pane 집합에 함께 추가/제거해 반대 방향을 맞춘다. inactive workspace는 navigation snapshot이 pane 요약을 주지 않으므로(§13.3) workspace 단위로만 기록하고, 그 workspace로 진입해 active가 될 때 pane 집합으로 확장 reconcile한다. stale ID, 삭제된 pane/workspace ID는 순회에 영향이 없고 별도 호스트 정리 수명주기가 필요 없다.

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

`render`는 Rust route가 고정한 8 MiB `maxBytes`를 frontend async bridge에 전달한다. `readFileForViewer`는 image·PDF에도 상한을 적용한 bounded read를 수행한다. 일반 text 응답은 `{path,kind:"text",content,truncated}`, HTML/Markdown preview 응답은 원문 중복을 제거한 `{path,kind:"text",truncated,previewKind,previewDocument}`, 그 밖에는 `{path,kind:"image",dataUrl}`, `{path,kind:"pdf",dataUrl}`, `{path,kind:"archive",format,entries,totalEntries,totalBytes,truncated}`, `{path,kind:"binary",size}`다. HTML/Markdown `previewDocument`는 데스크톱 FileViewer와 같은 sanitizer/CSP builder의 결과이며 새 탭은 sandbox iframe `srcdoc`으로만 표시하고 `truncated=true`이면 잘림 경고를 함께 표시한다. 일반 text는 `textContent`, image는 `data:image/*`만 사용한다. Remote에서는 settings의 `extensionViewers` shell 매핑을 실행하지 않고 항상 이 built-in web renderer를 사용한다.

**Remote 는 데스크톱의 typed preview 렌더러를 확장하지 않는다([ADR-0109](../adr/0109-file-viewer-typed-preview-renderers.md)).** `previewDocument`를 만들 수 있는 것은 document 계열(`html`/`markdown`)뿐이며, bridge 는 그 판정에 데스크톱 분류기(`filePreviewKind`)가 아니라 document 전용 분류기(`documentPreviewKind`)를 쓴다. JSON/CSV/diff/log/source 같은 structured 종류는 Remote 에서 지금까지와 동일하게 원문 text 로 내려가고 새 탭이 `textContent` 로 표시한다 — structured 렌더러는 React 컴포넌트라 프레임워크 없는 임베드 자산인 `viewer_page.js` 로 옮길 수 없고, 두 벌을 동기화하는 비용이 이득을 넘는다. 데스크톱과 Remote 의 표시 능력 격차는 의도된 것이며 Remote 클라이언트 통합 시 재검토한다. 공유 커맨드가 만들어 Remote 에도 도달하는 `pdf`/`archive` 는 새 탭에서 렌더하지 않고 파일 종류와 개수를 알리는 플레이스홀더로 표시한다(알 수 없는 응답으로 실패하지 않도록).

새 탭은 반드시 사용자의 button/일반 Enter action에서 `window.open("/remote/viewer/")`으로 먼저 연다. IME 조합 중 Enter와 legacy `keyCode=229`는 제출하지 않고, host path 입력은 모바일 키보드가 대소문자를 바꾸지 않도록 자동 대문자화를 끈다. child가 exact same-origin `laymux:file-viewer-ready` 메시지를 보내면 opener는 해당 `Window` 객체가 자신이 연 pending child인지 확인하고, token·lease·fileViewerToken과 클릭 때 스냅샷한 `source="path"`/path를 `laymux:file-viewer-session` 메시지로 한 번 전달한다. child URL(query/fragment)·bootstrap DOM·localStorage/sessionStorage·문서 제목에는 token·lease·capability·path를 기록하지 않는다. 제목은 일반적인 `Laymux File Viewer`로 유지하고 path는 본문에만 표시한다. child는 exact origin과 `event.source === window.opener`를 확인해 최초 한 세션만 받고 즉시 opener 참조를 끊는다. 비동기 MCP/desktop viewer 변경은 Remote 입력을 자동 갱신하거나 popup을 만들지 않으며, 사용자가 `From host`를 다시 눌러 명시적으로 가져온다.

### 13.4 Terminal Control

Remote terminal control은 상태 소유권을 세 범주로 나눈다([ADR-0015](../adr/0015-remote-terminal-state-ownership.md)).

| 범주 | 예 | 소유/동기화 규칙 |
|---|---|---|
| PTY 전역 상태 | PTY process, stdin, output byte stream, CWD/title/activity, terminal escape state, 현재 `cols/rows` | 한 terminal session에 하나만 존재한다. 현재 controller owner만 변경할 수 있다. |
| surface 로컬 상태 | DOM pixel size, devicePixelRatio, xterm canvas/WebGL atlas, cell metrics cache, scroll viewport, selection, focus, IME/composition, drawer state | PC WebView와 browser remote가 각자 보유한다. Remote API 계약에 섞지 않는다. |
| controller owner 상태 | active input writer, active resize writer, workspace/pane focus request 권한 | active lease가 있으면 remote가 owner이고, lease가 없으면 PC가 owner다. owner가 아닌 surface는 PTY write/resize를 보내지 않는다. |

브라우저 remote의 모바일 터치 스크롤/선택은 surface-local 처리다. Remote HTML은 Pointer Events 기반 gesture layer를 두고 일반 한 손 드래그를 텍스트 선택에 쓰지 않는다. normal buffer이며 mouse tracking mode가 꺼진 shell/log 화면에서는 한 손 세로 스와이프가 xterm scrollback을 움직이고, alternate buffer 또는 mouse tracking mode에서는 한 손 스와이프를 TUI 앱 내부 스크롤 입력으로 전달한다. scrollback을 위로 올리면 데스크톱 TerminalView와 같은 하단 이동 버튼을 띄우고, 누르면 해당 remote xterm viewport만 live tail로 이동한 뒤 버튼을 숨긴다. 움직임 없이 long-press가 성립하면 선택 모드에 들어가고, 이후 드래그 또는 표시된 선택 핸들 이동만 xterm selection을 갱신한다. 첫 단일 탭은 `.xterm-screen`의 링크 hit-test로 전달하며 평문/OSC 8 HTTP(S) 링크 셀일 때만 Linkifier의 mouse down/up 활성화 경로를 합성한다. 링크가 아니면 기존 focus·선택 해제 동작을 유지한다. double tap은 단어 선택, triple tap은 줄 선택으로 처리한다. 두 손가락 세로 스와이프는 현재 surface에서 가능한 스크롤 경로로 라우팅한다. mouse tracking mode에서 선택 또는 링크 활성화 합성 이벤트를 만들면 force-selection modifier를 실어 TUI로 입력이 전달되지 않게 한다. 선택된 텍스트는 별도 버튼 없이 선택 interaction이 끝나는 시점에 브라우저 클립보드로 복사한다. 마우스 선택을 terminal 밖까지 끌고 놓는 경우도 xterm의 document-level `mouseup` 선택 확정 뒤 복사를 예약한다. Clipboard API가 거절되면 같은 user-activation task 안에서 `execCommand("copy")` fallback을 사용하고, 로컬 모바일 iframe은 `clipboard-write` 권한을 명시한다. 이 동작은 Remote API 계약이나 PTY 전역 상태를 바꾸지 않는다.

평문 `#123` GitHub 이슈/PR 링크는 [ADR-0050](../adr/0050-remote-github-reference-links.md)을 따른다. `GET /remote/v1/terminals/{id}/github-repo`는 client path를 받지 않고 server-side terminal session의 CWD를 스냅샷해 기존 git `origin` resolver로 `{cwd,repoBase}`를 반환한다. 기존 Remote bearer token/IP/Origin gate는 적용하지만 host 상태를 바꾸지 않는 observer 조회라 controller lease는 요구하지 않는다. terminal lock은 CWD 복사까지만 잡고 filesystem 조회는 blocking worker에서 수행한다. terminal 없음은 `404`, CWD 없음·비-GitHub repo·해석 실패는 `repoBase:null`이며 성공 응답은 `Cache-Control: no-store`다. 브라우저는 active terminal/CWD/request revision 및 응답 CWD가 모두 일치할 때만 base를 적용하고, 전환·실패 시 즉시 null로 복구한다.

footer의 `Keys` 토글은 소프트 키 툴바를 열고 닫는다. 이 툴바는 방향키·Tab·Esc·PgUp/PgDn·Ctrl 조합·F 키 등을 버튼으로 노출하고, 각 키는 기존 `Ctrl+C` 버튼과 동일하게 `enqueueInput` → `/remote/v1/terminals/{id}/write` 로 escape 시퀀스를 보낸다(새 endpoint 없음). 방향키·Home·End 는 `terminal.modes.applicationCursorKeysMode` 를 반영해 SS3(`\x1bO`)/CSI(`\x1b[`)를 고른다. 키 버튼(과 footer의 `Ctrl+C`·`Keys` 토글·`Keyboard` 버튼, 헤더 pane 복사 버튼)은 pointer activation의 기본 포커스 이동을 `mousedown`·`pointerdown` 양쪽에서 막아 현재 포커스된 입력 표면(composer 에디터 또는 xterm helper textarea)과 이미 열린 모바일 소프트 키보드를 유지하되, 접근성·물리 키보드 activation을 위해 실제 전송은 `click` 경로로 처리한다. WebKit/iOS 는 `pointerdown` preventDefault 로 포커스 이동을 막지 못하므로 `mousedown` 도 함께 막는 것이 핵심이다(공유 `preventFocusSteal`/`keepInputSurfaceFocus` 헬퍼, [#482](https://github.com/kochul2000/laymux/issues/482)). Navigation 세트의 `↕↔` 방향 패드는 누르는 동안 상·우·하·좌 힌트를 표시하고, 18px 이상 flick한 우세 방향을 기존 방향키 입력 경로로 보낸다. 임계거리 미만의 탭과 취소된 pointer는 입력을 보내지 않는다. 표시 여부·선택 세트(Navigation/Editing/Ctrl keys/Function)·커스텀 키·알려진 전체 키 ID의 `order`는 `localStorage` 키 `laymux.remote.keybar` 에 저장하는 surface-local UI 상태다([ADR-0028](../adr/0028-remote-soft-key-toolbar.md), [ADR-0040](../adr/0040-remote-soft-key-user-order.md)). 실제 표시 순서는 활성 세트와 커스텀 키의 합집합을 `order`로 필터링해 계산한다. 설정 팝오버의 마지막 `Key order` 섹션은 활성 키를 커스텀 팔레트 원본 키와 동일한 크기의 컴팩트 칩 그리드로 보여주며, long-press Pointer Events drag와 삽입 표시선으로 순서를 바꾼다. 칩을 탭하면 `맨 앞`·`왼쪽`·`오른쪽`·`맨 뒤` 보조 동작이 나타나고 `Reset`은 `KEY_ORDER`로 복원한다. 비활성 커스텀 키를 새로 선택하면 현재 활성 키의 맨 뒤에 추가한다. `order`가 없는 기존 저장 값은 정본 `KEY_ORDER`로 보완하고 알 수 없는 ID·중복 ID는 제거한다. 키가 화면 폭보다 많으면 키 행 내부에서만 좌우 스크롤하며 한 줄을 유지하되 scrollbar track은 노출하지 않는다. 설정 버튼도 고정된 별도 영역이 아니라 키들과 같은 스크롤 행의 첫 항목이다. 키 행의 intrinsic width가 문서 폭을 키우지 않도록 app/header/main/footer/key-bar 경계는 `min-width: 0`을 유지한다.

모바일 remote의 app 높이는 `visualViewport.height`를 CSS 변수 `--remote-viewport-height`로 반영한다. 브라우저가 지원하면 viewport meta의 `interactive-widget=resizes-content`도 함께 사용한다. 폭 520px 이하에서는 footer를 한 줄로 유지하기 위해 header와 중복되는 terminal 상태 문구를 숨긴다. 이 값들은 모두 surface-local DOM geometry이며 Remote API/PTY 소유권 계약을 바꾸지 않는다.

terminal host의 geometry 변화는 fit 정책([ADR-0038](../adr/0038-remote-height-shrink-surface-crop.md))을 거친다. xterm은 host 내부의 clipping wrapper 속 sizer 요소에 마운트되고, 폭 변경 또는 높이 증가만 fit + PTY resize를 전파한다. 폭이 그대로인 높이 축소(native keyboard 열림, composer drag, 키바 표시, URL bar)는 normal buffer에서 PTY geometry를 유지한 채 sizer를 마지막 fit 픽셀 높이로 고정해 crop한다 — scrollback reflow형 TUI(Codex CLI 0.128.0+)가 SIGWINCH마다 전체 트랜스크립트를 재출력하는 flood를 막기 위해서다. crop 창은 화면 바닥이 아니라 **live tail 행**(커서 행과, 커서 아래 마지막 비어 있지 않은 렌더 행 중 아래쪽)에 정렬한다([ADR-0056](../adr/0056-remote-crop-window-anchors-live-tail.md)). tail 아래의 빈 행은 창 밖으로 밀려나므로 출력이 화면보다 적어도 프롬프트가 composer 바로 위에 붙는다. 이동량이 잘린 높이를 넘어 sizer 상단이 host 상단보다 내려가면 clipping wrapper가 노출되므로, wrapper 배경은 활성 터미널 appearance의 xterm 테마 배경을 따르는 `--terminal-surface-bg`로 칠한다. 커서와 tail 사이가 창 높이보다 길어 tail 정렬로도 커서 행이 창 위에 남는 경우에는 커서 가시성 보정이 우선해 커서·IME UI가 화면 밖에 남지 않게 한다. tail 재계산은 crop이 활성일 때만 렌더·스크롤·커서 이동에 대해 프레임당 한 번으로 합친다. 터치 선택 핸들은 host에 직접 붙어 clipping 밖에 남는다. crop 중에도 새 attach·터미널 전환은 보존된 `cols/rows`를 PTY에 재전송한다(fit 생략과 resize 전송은 별개). alternate buffer는 scrollback flood가 없고 전체 화면 앱이 상단 행을 필요로 하므로 항상 fit을 전파하며, crop 중 buffer 전환이 일어나면 즉시 재평가한다. 높이 축소가 입력 표면이 아니라 **chrome 행**(위젯 스트립)의 등장 때문이면 crop이 아니라 fit 기준선 재설정이다([ADR-0129](../adr/0129-remote-chrome-row-rebases-fit-baseline.md)): 표시 상태가 뒤집힐 때 `fittedHostHeight`를 버리고 refit해 새 host geometry를 채택한다. 재설정하지 않으면 attach fit이 기록한 스트립 없는 높이가 기준선으로 남아, 폰트 로드처럼 나중에 도착하는 refit이 전부 crop 분기에서 막힌다.

attach 는 이 fit 정책 위에서 geometry 를 **한 번만** 게시한다([ADR-0133](../adr/0133-remote-attach-publishes-one-pty-geometry.md)). PTY geometry 변경은 앱에 창 크기 이벤트로 전달되고, 프레임을 상대 커서로 다시 그리는 TUI(Claude/Ink)는 이전 폭에서 센 줄 수만 지우므로 폭 변경마다 옛 프레임의 감싸진 나머지가 화면에 남는다. 그래서 `openOutput` 은 첫 fit 전에 늦게 도착하는 두 chrome 원인 — 원격 폰트 상태(`loading` 이 아님)와 위젯 스트립의 첫 응답 — 이 정착할 때까지 `REMOTE_ATTACH_CHROME_SETTLE_MS`(900ms) 상한으로 기다린다. 포기한 폰트·빈 스트립도 정착으로 센다. 대기 동안 `attachGeometryHolds` 가 올라가 surface fit 은 계속하되 `queueResize` 는 게시하지 않고 예약된 resize 도 취소한다. 대기가 끝나면 `fitTerminalForAttach()` 가 제안 격자가 멈출 때까지(최대 3 pass) fit 을 반복한다 — xterm 은 surface 를 열 때와 resize 할 때만 셀을 재므로 첫 fit 은 낡은 셀 크기로 격자를 제안하고, 그 fit 의 `resize()` 가 재측정을 유발해 다음 pass 에서 교정된다. 확정된 `cols/rows` 하나만 `/resize` 로 나가고 그 geometry 에서 checkpoint 를 받는다. 백엔드 `resize_terminal_inner` 는 소유권 게이트 뒤에서 요청 크기가 현재 세션 크기와 같으면 물리 resize 를 생략한다(게이트가 먼저이므로 권한 판정은 불변).

`cols/rows`는 surface 로컬 값이 아니라 SIGWINCH로 process에 반영되는 PTY 전역 상태다. 따라서 remote lease가 active인 동안 browser remote의 xterm geometry가 PTY 크기를 결정하고, PC WebView는 로컬 renderer를 유지하되 backend PTY resize를 보내지 않는다. PC가 `reclaim_remote_control`로 제어권을 회수하거나 remote lease가 끝나면 visible `TerminalView`는 공통 write-drain fit을 실행하면서 그 fit의 일반 `onResize` backend 전송을 억제하고, 최종 `cols/rows`를 명시적 resize 하나로 동기화한다. backend resize가 성공해야 pending dirty를 지우며, 거부되거나 1초 안에 완료되지 않으면 최신 geometry revision을 100ms 뒤 재시도한다. renderer atlas rebuild와 `refresh()`는 이 fit에 합쳐진다. hidden `TerminalView`는 복구를 dirty로 보류하고 다시 visible이 되는 순간 같은 경로로 소비한다.

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote/v1/terminals` | GET | 현재 backend terminal session 목록 |
| `/remote/v1/terminals/{id}/github-repo` | GET | server-side terminal CWD의 GitHub `origin` base 조회 (`{cwd,repoBase}`, observer read, no-store) |
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

`settings.remote.serveTerminalFont`가 켜져 있고 데스크톱이 해당 face 를 실제로 서빙할 수 있으면
appearance 에 선택적 `fontAssets: { family, faces: [{ url, weight, style }] }`가 추가된다
([ADR-0077](../adr/0077-remote-terminal-font-serving.md)). `family`는 `LxRemoteFont-<12 hex>` 별칭이고
`url`은 위 폰트 route, `weight`는 400/700, `style`은 `normal`/`italic`이다. regular 와 같은 파일로
해석되는 bold/italic 은 목록에 넣지 않고 브라우저 합성에 맡긴다. 토글이 꺼져 있거나 face 해석 실패·
폰트 컬렉션(`ttcf`)·페이스당 8 MiB 초과이면 필드를 생략하고 remote 는 이름-only `fontFamily` 스택으로
폴백한다. Remote 클라이언트는 `FontFace` 객체로 등록하고 실제 로드가 확인된 뒤에만 `family` 를
`fontFamily` 스택 맨 앞에 붙인다 — xterm `OptionsService`는 값이 바뀔 때만 셀을 다시 재기 때문에,
로드 완료가 곧 문자열 변경이어야 재계측과 재fit 이 일어난다. 로드 실패는 다음 navigation 갱신이나
attach 에서 재시도하며 face 당 3 회로 제한한다.

`write`/`input`/`resize`는 JSON body의 `leaseId` 또는 `X-Laymux-Remote-Lease` 헤더가 현재 active lease와 일치해야 한다. resize body는 `{leaseId,cols,rows,exact?:boolean}`이며 현재 page는 `exact:false`를 명시한다. `exact:true`도 bearer/IP/Origin 인증과 sticky-expiry를 포함한 active lease 검증을 먼저 통과해야 하며, missing/bogus/stale lease는 기존처럼 409다. 유효한 active lease일 때만 현재 backend가 HTTP 501을 반환하고, 이 fail-closed 분기는 human-control permit 등록·terminal FIFO·physical/logical resize보다 앞선다. `exact:false`의 최종 소유권 검사는 route의 선행 status 확인이 아니라 Local Tauri command와 공유하는 backend human-control operation permit 등록 시점에 수행한다. permit은 등록 시점의 absolute deadline·owner epoch·operation id와 enqueue phase를 가지며, structured input은 protocol-state gate에서 mode를 캡처한 뒤 PTY control worker 큐 진입 직전에 소유권을 재검증한다. 동일 terminal의 작업은 permit 등록 순서대로 enqueue되므로 structured input 준비 중 뒤에 등록된 raw write/resize가 먼저 PTY에 도착하지 않는다. owner 전환은 아직 enqueue되지 않은 등록 요청을 취소·분리하고, 이미 queued/running인 요청은 per-terminal worker cancel과 completion acknowledgement까지 장벽에 남긴다. PTY handle table/protocol gate/owner gate는 queue wait나 물리 write 동안 잡지 않으며, worker는 physical operation 전후에 owner token을 재검증한다. 취소 adapter가 grace 안에 종료를 증명하지 못하면 해당 PTY를 종료·input-fault 격리하고 worker lifecycle completion을 확인할 때까지 Local owner를 공개하지 않는다. 출력 WebSocket도 `leaseId` 쿼리를 요구한다.

Structured input body는 `{ "leaseId": "...", "text": "...", "submit": true|false }`다. Rust는 LF/CRLF/CR을 CR로 정규화하고 terminal별 authoritative bracketed-paste state가 켜진 경우 text 부분을 `CSI 200~`/`CSI 201~`로 감싼다. `submit=true`의 최종 CR은 bracketed envelope 뒤에 둔다. 최종 인코딩 payload는 공통 1 MiB 상한을 적용한다. Composer는 Send action 하나만 노출하며 항상 `submit=true`를 사용한다. PC WebView와 fine-pointer Remote에서는 일반 Enter가 Send이고 Shift+Enter가 textarea 줄바꿈이다. coarse-pointer Remote에서는 Enter가 줄바꿈이고 Send 버튼만 제출한다. IME 조합 중 Enter는 어느 surface에서도 action이 아니다. Remote soft key와 `Ctrl+C`는 계속 raw `/write`를 사용한다. Direct clipboard paste는 `submit=false`로 `/input`을 사용해 browser xterm의 stale bracketed-paste mirror를 권위 상태로 사용하지 않는다([ADR-0034](../adr/0034-single-send-terminal-composer.md)).

Direct WebSocket output은 첫 frame부터 공통 pair 계약을 쓴다. `TerminalOutputFrameHeaderV1 { type:"terminal.output", version:1, phase:"snapshot"|"delta", seqStart, seqEnd, byteLength, state? }` JSON text frame 바로 뒤에 정확히 한 개의 binary frame을 보낸다. snapshot만 `state { version, generation, snapshotStartSeq, snapshotSeq, sourceStartSeq, sourceSeq, snapshotKind, protocolRevision, modes:{bracketedPaste}, geometry:{revision,cols,rows} }`를 포함하고, 빈 snapshot도 길이 0 binary frame을 보낸다. Remote snapshot의 `snapshotKind`는 `screen`이다. desktop WebView의 rendererless xterm은 visible xterm과 같은 sequenced PTY bytes, authoritative PTY geometry, Unicode provider를 사용해 normal/alternate buffer·cursor·mode를 직렬화한다. Remote browser는 output WebSocket을 열기 전에 현재 viewport를 fit하고 같은 lease의 `/resize` 완료를 기다린다. attach 중 surface fit은 잠그며, snapshot은 `state.geometry`로 xterm을 먼저 resize한 뒤 reset/replay하고 나서 일반 viewport fit을 재개한다. Server는 요청 시점의 `{generation,seq,geometry}`를 frontend bridge에 제시하고, 반환 checkpoint가 같은 generation/geometry인지와 그 뒤 raw suffix가 ring에 남아 있는지를 검증한다. 검증과 suffix 캡처, bounded subscriber 등록은 같은 session lock 구간에서 원자적으로 이뤄진다. 경합하면 최대 3회 새 target으로 다시 시도하고, 안정화되지 않으면 연결을 닫아 client가 재attach하게 한다. frontend bridge가 끝난 뒤에는 첫 header/binary를 보내기 전에 active lease를 다시 검사해 attach 대기 중 release·expiry·reclaim된 controller에 화면을 보내지 않는다.

screen checkpoint의 직렬화 길이는 원본 PTY sequence에 없으므로 V1 wire sequence에는 그 길이만큼 offset을 둔다. snapshot header의 `seqEnd - seqStart`와 binary 길이는 계속 같고 후속 delta도 같은 offset을 적용한다. 원본 PTY 경계는 `sourceStartSeq`/`sourceSeq`가 따로 나타낸다. `snapshotMaxKib`는 scrollback 보존량을 고르는 소프트 예산이며 현재 viewport·alternate buffer·복원 mode를 담은 최소 checkpoint는 이를 넘을 수 있다. 모든 checkpoint에는 1 MiB 절대 상한을 적용한다. slow consumer queue overflow·generation retire·sequence gap이면 socket을 닫는다. Cloud host도 같은 checkpoint/subscription 경로와 wire offset을 쓰고 공통 계약을 relay에 전달한다. 일시적인 checkpoint bridge/race/gap은 retryable `terminal_output_gap`, terminal 소멸은 `terminal_not_found`, malformed/절대 상한 위반은 `terminal_output_unavailable`로 전달한다. Remote page는 재접속이나 workspace 전환 시작에 기존 xterm을 먼저 비우지 않고, 새 snapshot header/binary pair를 완전히 검증한 직후 reset하고 적용한다. 사용자 주도 최초 연결·pane 전환은 replay 뒤 live tail에 착지하지만, 같은 terminal의 Output WebSocket 재접속과 자동 lease reclaim은 replay 전 surface-local viewport의 live tail 기준 행 오프셋을 복원한다. 새 checkpoint가 보존한 scrollback보다 오프셋이 크면 xterm 경계에서 clamp한다. 확장 metadata가 없는 과거 raw V1 snapshot은 pre-attach resize geometry에서만 legacy 호환으로 재생하고, `snapshotKind:"screen"`은 generation/source/geometry 전체를 필수 검증한다.

Remote 입력 UI의 명시적 선호는 `laymux.remote.inputMode`에만 저장한다. 저장값이 없으면 coarse pointer는 composer, fine pointer는 direct가 기본이다. terminal별 현재 모드와 draft/revision/in-flight token은 페이지 runtime Map에만 있고 reload 시 사라진다. V1 snapshot state와 synthetic 최종 mode 적용이 끝나기 전에는 composer action과 Direct clipboard paste를 fail-closed한다. 입력 포커스는 Connect·terminal 선택·Keyboard 버튼처럼 사용자가 시작한 진입만 변경한다. Output WebSocket 재접속, snapshot replay 완료, heartbeat 만료 뒤 visible-document 자동 reclaim 같은 복구 경로는 bytes·geometry·lease만 복원하고 입력 surface를 `focus()`하지 않는다. 따라서 사용자가 시스템 키보드나 브라우저 동작으로 내린 키보드는 transport 복구 때문에 다시 열리지 않는다. PC WebView도 동일한 입력 상태 전이 계약을 사용하되 선호 키는 `laymux.desktop.inputMode`, 최초 기본값은 direct이며 Tauri `write_terminal_input`과 아래 desktop output v3 계약을 사용한다.

PC WebView는 `terminal-output-v3-{id}` listener를 `attach_terminal_output(id)`보다 먼저 등록한다. attach 응답은 raw state/snapshot과 `flowControl:{token:string,windowBytes:number,nextEnvelopeId:number}`를 함께 반환한다. token은 generation-local desktop lease의 불투명 문자열이고, `nextEnvelopeId`는 선등록 listener에 도착한 event 중 attach snapshot 다음에 소비할 첫 envelope를 지정한다. generation당 활성 desktop lease는 하나다. envelope는 `{version:3,generation,leaseToken,envelopeId,grantId,seqStart,seqEnd,data,deltaEnds,geometryRuns}` 형태이며 `data` 최대 64 KiB, `deltaEnds` 최대 8,192개, JSON wire payload 1 MiB 미만을 모두 만족해야 한다. frontend는 envelope 전체를 검증하고 backing과 descriptor를 bounded ingress/physical queue에 넘긴 뒤 `acknowledge_terminal_output_envelope(id,generation,token,envelopeId,grantId,seqEnd)`로 receipt를 보낸다. opener/closing transition을 실은 envelope는 hold/close command가 먼저 수락되어야 receipt로 다음 slot을 연다. receipt는 ownership 인수일 뿐 parsed ACK가 아니다.

parsed frontier는 visible xterm callback과 rendererless checkpoint xterm이 같은 contiguous source prefix를 모두 완료한 교집합이다. `TerminalWriteBatchQueue`가 visible physical byte FIFO, zero-copy `Uint8Array.subarray()` descriptor의 materialization, callback/discard를 계속 소유한다. 두 xterm parser lane은 pane당 하나의 app-global owner를 공유하며 focused visible 4 / visible unfocused 2 / hidden 1의 latest-state weight와 age promotion으로 admission된다. 정상 mounted 생명주기의 desktop physical parser admission은 동시에 최대 하나이며, unmount/profile replacement가 dispose한 old generation에는 상태를 바꿀 수 없는 stale callback이 최대 하나 늦게 끝나는 lifecycle 예외가 있다([ADR-0092](../adr/0092-app-wide-terminal-write-round-robin.md), [ADR-0098](../adr/0098-terminal-parser-weighted-starvation-free-admission.md)). 이 교집합만 기존 `acknowledge_terminal_output(id,generation,token,seq)`를 전진시킨다. 같은 identity/payload 재전송은 idempotent하고 stale generation/token/envelope/grant completion은 현재 slot·grant·frontier를 바꾸지 않는다.

`repair_terminal_output_envelope(terminalId,generation,token,envelopeId,grantId,seqStart)`는 receipt 전 frozen in-flight v3 envelope를 조회한다. 응답은 `{status:"idle"|"eventPending"|"exact"|"stale"|"alreadyReceipted"|"mismatch"|"exhausted",envelope?:TerminalOutputEnvelopeV3}`다. `idle`은 유효 session에 아직 다음 in-flight가 없는 정상 상태다. 여기에는 직전 receipt가 끝났지만 parsed ACK가 뒤처져 있고 다음 byte가 worker의 pending queue에서 아직 envelope로 동결되지 않은 구간도 포함하며, 이때 요청 `seqStart`는 전체 admitted tail이 아니라 첫 pending delta의 시작점과 비교한다. `eventPending`은 full identity와 sequence가 일치하지만 in-flight 생성 뒤 최대 1초이자 configured receipt timeout의 절반인 direct-event grace가 아직 남은 상태다. emit 성공 여부와 무관하며 envelope는 `null`이고 repair attempt와 receipt deadline을 바꾸지 않는다. `exact`는 grace가 끝났고 요청 identity와 sequence가 모두 같은 frozen envelope, `alreadyReceipted`는 직전 exact identity, `stale`은 retired/다른 generation 또는 token, `mismatch`는 현재 in-flight와 identity/range가 다른 경우, `exhausted`는 generation-local bounded repair 회수 소진이다. command는 event를 emit하거나 envelope ID·receipt slot·parsed frontier를 전진시키지 않는다. frontend는 production v3 활성 동안 1초 watchdog과 관측 gap/overlap에서 이 command를 하나만 in-flight로 호출한다. `exact`만 일반 v3 pipeline에 once-only splice하고 `idle`은 no-op이다. well-formed `eventPending`도 payload를 적용하지 않지만 delayed-tick grace를 해제해 다음 interval callback을 반드시 poll한다. 나머지 상태는 직전 immutable payload가 동일한 `alreadyReceipted` duplicate를 제외하고 typed fail-stop한다. `terminal-output-v2-{id}`, `resume_terminal_output`과 v2 gap repair/auto-reattach는 구 backend와 fixture를 위한 staged fallback이며 production PC v3 경로에 섞지 않는다.

base parsed credit은 512 KiB다. healthy active/re-attach surface가 live stream의 정상 DECSET 2026 opener를 관측한 경우에만 `hold_terminal_output_continuation(id,generation,token,envelopeId,grantId,frameStartSeq)`로 frame 시작부터 최대 1 MiB bounded continuation을 연다. 이때 `envelopeId`는 opener envelope다. bootstrap lease에는 surface가 없어 grant가 없다. terminator·malformed·진행할 때마다 갱신되는 5초 no-progress timeout·1 MiB+1 oversized는 bytes를 버리지 않는 fail-open이며, `close_terminal_output_continuation(id,generation,token,envelopeId,grantId,closeSeq,reason)`으로 closing envelope와 불변 payload를 결합한다. 이 5초 credit observer는 native 화면 transaction의 기존 50 ms fail-open과 별개다. close의 `envelopeId`는 active grant를 실은 closing envelope다. hold와 close는 각각 이 전체 identity를 검증한다. desktop ring과 attach snapshot 상한은 `512 KiB + 1 MiB + 2 * TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES`이고 snapshot은 `[parsedAck,writeSeq)` 전체다. capacity와 정확히 같아도 ACK 전 byte를 eviction하지 않으며 다음 append를 mutation 전에 막는다([ADR-0095](../adr/0095-terminal-output-bounded-envelope-and-frame-continuation.md)).

receipt/hold/close 호출은 각각 5초 watchdog 뒤 같은 identity/payload로만 retry한다. exact repair invoke만 일반 control과 분리된 선언 상수의 15초 watchdog을 사용한다. WebView/window-scoped registry는 세 종류가 공유하는 delivery FIFO와 terminal-local 6개·WebView-global 6개 orphan hard cap을 소유하고, attach와 parsed ACK의 기존 독립 budget은 유지한다([ADR-0086](../adr/0086-terminal-output-control-epoch-watchdog.md)). parsed ACK의 정상 composite capacity 경쟁은 같은 terminal generation·lease token의 logical sender 하나를 FIFO waiter로 유지하며, 대기 중 도착한 contiguous parsed prefix는 그 sender의 최신 prefix로 coalesce한다. slot을 얻기 전에는 command Promise나 watchdog을 만들지 않고 reset/replay/replacement attach도 하지 않는다. unmount·stale owner는 waiter와 미사용 reservation을 반환한다. 이미 호출된 command의 실제 timeout과 timed-out orphan hard cap만 비정상 fail-stop 경계이며, hard cap 도달은 capacity waiter도 깨워 즉시 다시 판정한다([ADR-0094](../adr/0094-terminal-output-control-capacity-admission.md)). orphan hard cap에는 watchdog이 실제 timeout으로 표시한 미정산 Promise만 세며, 정상 in-flight가 capacity를 점유한 경우에는 새 호출을 fail-stop하지 않고 FIFO에서 기다린다. backend는 receipt와 continuation grant의 server-side expiry를 선언 상수의 40초로, parsed-progress expiry·synchronous emitter call·delivery worker shutdown을 각각 5초로 소유하고 retire/유효 completion/expiry 때 모든 delivery·credit waiter를 깨운다([ADR-0126](../adr/0126-terminal-output-repair-timeout-budget.md)). frontend control watchdog·repair watchdog·server expiry를 분리해 한 번의 5초 WebView stall, 최대 3초 repair poll, 15초 repair invoke, 공유 FIFO의 `hold → close → receipt` 호출별 5초와 2초 scheduling margin을 수용한다. exact repair는 envelope 생성 시 정한 receipt deadline을 갱신하지 않는다. receipt의 delivery 수락 뒤 flow projection이 실패하면 그 최초 오류를 exact identity/payload의 terminal result로 보존하므로 같은 retry가 duplicate success로 바뀌지 않는다. production v3 lease의 parsed ACK range/monotonicity 검증 실패는 legacy prefix ACK로 fallback하지 않는다. v3 delivery worker가 시작되지 않은 실제 v2-only compatibility lease만 prefix ACK를 사용할 수 있다.

`fail_stop_terminal_output_surface(id,generation,token,reason)`은 frontend lifecycle owner가 판정한 surface 실패를 backend SoT에 게시한다. `reason`은 `surface_unavailable | control_orphan_cap`만 허용한다. current generation/token이면 typed delivery fail-stop 후 `true`, stale identity면 무변경 `false`, 잘못된 reason이면 오류다. delivery close owner는 이 command와 backend 자체 receipt/grant/progress/identity 실패를 모두 `terminal-output-fail-stopped` event의 camelCase `{terminalId,generation,leaseToken,reason}` payload로 정확히 한 번 알린다. attach 전 bootstrap 실패에는 lease가 없으므로 `leaseToken`은 `null`이다. listener-first frontend는 이 notice만으로 generation을 추측하지 않고 후보로 보관한다. current generation이 이미 fail-stopped여서 `attach_terminal_output`이 lease를 만들 수 없으면 command는 string reject 대신 `{kind:"failStopped",terminalId,generation,reason}`을 정상 응답한다(정상 attach 응답 shape는 유지). 이 typed 결과가 현재 generation의 SoT이며 후보 notice와 generation이 달라도 typed reason으로 수렴한다. identity conflict, orphan cap, receipt/grant/progress expiry 또는 surface unavailable은 typed fail-stop이다. PC WebView는 readiness를 false로 하고 pane 상단의 지속 경고 바에 output-stopped reason과 명시적 재시작 버튼을 표시하며 예약된 retry timer까지 취소하고 reset/replay/repair/replacement attach를 하지 않는다. 버튼은 기존 pane restart action과 같은 fresh-terminal 경로로 새 generation을 만들 뿐 자동 클릭·자동 재시도하지 않는다. 복구는 사용자가 terminal을 명시적으로 close하고 새 generation을 recreate하는 것뿐이다. 이 계약은 desktop Tauri surface에만 적용하며 Remote/Cloud screen checkpoint, 1 MiB snapshot 절대 상한, bounded subscriber overflow/gap/reconnect 계약은 변경하지 않는다.

ADR-0085가 제안하는 exact geometry cutover의 transaction ACK는 위 desktop credit ACK와 별도 계약이다. Local owner는 PC visible xterm과 rendererless checkpoint가 old `boundarySeq`를 모두 파싱한 교집합, 그리고 두 grid가 new revision을 모두 채택한 교집합을 ACK한다. Remote owner는 active lease의 Remote browser xterm과 rendererless checkpoint가 같은 두 교집합을 만들며, browser parsed ACK는 V1 wire offset이 아니라 원본 `sourceSeq`를 사용한다. Remote lease 중 PC visible xterm은 PC surface geometry를 유지하고 Remote transaction ACK에 참여하거나 Remote geometry를 채택하지 않는다([ADR-0015](../adr/0015-remote-terminal-state-ownership.md), [ADR-0069](../adr/0069-remote-render-checkpoint-attach.md)). participant 집합은 prepare 때 owner epoch와 함께 고정되며 disconnect·lease expiry·response/ACK loss로 축소하지 않는다. stored status를 사용하는 transaction-aware reattach가 동일 역할의 ACK를 완성하거나 terminal teardown이 끝날 때까지 output과 owner publication을 fail-stop한다. current Remote의 viewport fit→one-shot `/resize`→output attach 순서는 browser가 old prefix를 보지 못하므로 exact path가 아니다. exact Remote attach는 proposed viewport geometry만 계산한 뒤 current PTY geometry checkpoint+suffix에 먼저 attach하고, browser가 source prefix를 ACK해 participant가 된 뒤 prepare/apply/adoption을 수행한다.

Local `get_terminal_geometry_capabilities()`는 `{exactGeometryCutover:false,interruptibleRead:true,followUpIssue:643}`을 반환하고, `resize_terminal(id,cols,rows,exact?)`는 `exact:true`를 terminal config/geometry 변경이나 PTY enqueue 전에 오류로 거절한다. Remote `/remote/v1/terminals`의 각 terminal도 같은 `geometryCapabilities`를 포함하며 `/remote/v1/terminals/{id}/resize`의 `exact:true`는 HTTP 501이다. `exact` 생략은 기존 guarded one-shot과 호환되고 bundled page는 `exact:false`를 명시한다. 현재 Remote V1 output WebSocket에는 prepare/apply/status token, browser source-prefix ACK, adoption ACK가 없고 Automation/MCP/HTTP caller도 parser surface가 아니므로 스스로 ACK할 수 없다. `pty_geometry` pure core에는 ADR-0085의 Local/Remote participant, source boundary, phase, result, latest-token idempotence가 구현돼 있으나 production adapter는 `Unsupported`다. #636의 pinned `portable-pty` fork는 `Data | Wake(generation) | EOF | Failure` reader liveness를 Windows ConPTY와 Linux PTY에 제공한다. wake는 provenance·byte sequence·geometry revision을 만들지 않으며 terminal generation이 다른 control은 fail-closed한다. #643이 Windows OpenConsole/Linux kernel provenance를 실제로 증명하기 전에는 core를 public prepare/apply/status나 output release에 연결하지 않고 one-shot fallback으로 exact를 위장하지 않는다([ADR-0089](../adr/0089-interruptible-pty-reader-is-not-provenance.md)).

Remote composer도 데스크톱과 동일하게 두 가지 과거 입력 recall 경로를 노출한다(issues #504/#505, [data-flow §8.8](./data-flow.md)). (1) 빈·포커스 초안에서 **Tab** 은 최신순·중복 제거·blank skip·최대 N개(기본 8)로 만든 listbox 를 에디터 위에 띄우고, (2) 비어 있지 않은 초안 타이핑 중에는 prefix(대소문자 무시)·최신순·중복 제거·초안 완전 일치 제외·cap 자동완성 dropdown 을 같은 자리에 띄운다. 두 목록은 초안 길이(0 vs >0)로 상호 배타이며, keydown 에서 자동완성 블록을 Tab-open 블록보다 앞에 둬 비어 있지 않은 초안의 Tab 이 팝업을 열지 않고 추천을 채우게 한다. 자동완성은 초기 강조가 없어(activeIndex=−1) 일반 Enter 가 계속 Send 이고, ↑/↓ 로 강조가 생겨야 Enter 가 선택으로 바뀐다. **과거 입력 텍스트(history)와 초안은 페이지 runtime Map(history 는 `Map<scopeKey, string[]>`, 버킷당 최대 200개)에만 두고 `localStorage`/`sessionStorage`/디스크/네트워크 어디에도 영속하지 않는다** — ADR-0029 의 미전송·전송 문자열 비영속 경계를 Remote 로 그대로 확장한 것으로, 셸에 입력한 비밀번호 등 민감 문자열이 recall 표면이나 페이지 unload 뒤로 새지 않게 하는 보안 경계다. `commitComposer` 성공 콜백에서 전송된 텍스트만 이 Map 에 append 한다. Remote 는 host `settings.json` 을 읽지 않으므로(설정 endpoint 없음) 두 기능 on/off 는 surface-local `localStorage` 키 `laymux.remote.composerHistoryPopup`·`laymux.remote.composerAutocomplete`(기본 on, 없거나 `"0"` 이 아니면 on)에만 저장하는 설정값이고, 토글 UI 는 기존 소프트 키 `⚙` 팝오버(`keyPopover`)의 "Composer recall" 섹션에 둔다. 같은 섹션의 `History sharing` select 는 데스크톱 `terminal.composerHistoryScope` 와 같은 세 값(`global`(기본)/`workspace`/`pane`)을 `laymux.remote.composerHistoryScope` 에 저장하며([ADR-0055](../adr/0055-composer-history-scope-setting.md)), 알 수 없는 값은 `global` 로 해석한다. Remote 의 버킷 키 도출도 `composerHistoryBucketKey()` 한 곳뿐이고 workspace 를 모르는 dock 터미널은 `pane:` 키로 좁게 fallback 한다. 스코프를 바꾸면 열려 있던 recall 목록을 닫고 새 버킷에서 다시 읽는다(병합·이관 없음). 데스크톱 설정과 자동 동기화하지 않는다 — 별개 surface 계약이다. 이 recall 은 새 Remote API/endpoint 를 만들지 않고 기존 `/input` 전송 경로만 사용한다.

터미널 종료는 control worker를 먼저 닫고 graceful window 동안 PTY master close를 bounded 재시도한다. resize 같은 control 작업이 master mutex를 잠시 보유해 첫 `try_lock`이 실패해도 이후 close로 EOF/HUP를 전달할 기회를 유지하며, window 안에 child가 종료되지 않을 때만 process-tree 강제 종료로 진행한다.

Remote page는 heartbeat와 output WebSocket을 별도 failure domain으로 취급한다. Heartbeat가 `401`/`403`/`409`처럼 권한·lease 상실을 명시하면 즉시 local control로 돌려주지만, 일시적 fetch 실패는 `heartbeatTimeoutSeconds`가 지날 때까지 재시도한다. Heartbeat는 최대 5초마다 보내고 실패 시 1초 뒤 빠르게 재시도하며, 개별 request는 최대 4초에 abort하므로 pending request 하나가 lease 유예 전체를 소진하지 않는다. Output WebSocket close/error는 곧바로 lease를 반납하지 않고, heartbeat가 active lease를 유지하는 동안 같은 terminal output stream을 지수 backoff로 다시 연다. 두 경로의 일시 오류 표시는 2초간 보류해 그 안에 복구되면 기존 연결 문구와 terminal surface를 그대로 유지한다. Output 재접속 중에도 기존 surface를 보존하고, 서버가 보내는 첫 V1 snapshot header/binary pair를 검증한 뒤 적용 직전에만 reset하여 tail 중복을 막는다. 헤더/바이너리 길이·phase·state 범위·sequence가 어긋나면 stream 전체를 버리고 재attach한다. 서버가 기존 lease 상실을 확정한 뒤에는 새 lease를 자동 claim하지 않는다 — 단 **문서가 보이는 순간**은 예외다([ADR-0027](../adr/0027-remote-connection-graceful-recovery.md), [ADR-0063](../adr/0063-remote-foreground-auto-reclaim.md)). 페이지는 떠날 때 lease를 반납하고(ADR-0037) 긴 백그라운드는 어차피 만료시키므로, 복귀는 항상 끊긴 상태로 시작한다. Connect 성공이 "이 탭이 제어권을 갖겠다"는 의사를 `laymux.remote.autoConnect`(**sessionStorage** — 의도는 탭 범위다. localStorage면 다른 탭이 상속해, 살아 있는 옛 탭이 lease를 계속 재확보하고 새 진입이 `409`를 맞는다)에 남기고 Release가 철회한다. 자동 경로는 claim 전에 `session/status`를 조회해 다른 클라이언트가 제어권을 가지고 있으면(`active`) 물러나며, 예외는 이 탭이 소유했던 lease만 대체할 수 있는 resume capability를 보유한 경우다. 이 조회는 자문이므로 실패해도 claim을 막지 않으며 `401`/`403`만 의사를 해제한다. `pagehide` release는 로컬 `leaseId`도 비운다 — bfcache 복원이 문서 변수를 되살리므로 남은 `leaseId`가 복귀를 건너뛰게 만든다. 의사가 남아 있으면 `visibilitychange`(보임)·`pageshow`(bfcache 복귀)·`online` 세 신호에서 자동으로 claim을 시도하며, 배경 탭에서는 어떤 경로로도 시도하지 않는다. `401`/`403`/`409`는 확정적 거절이므로 의사를 해제하고 사용자 조작을 기다리고, 일시 오류만 1초→최대 15초 지수 backoff로 보이는 동안 재시도한다. heartbeat의 `409`("lease is not active")는 **누가 제어권을 가졌는지 말하지 않으므로** 확정으로 취급하지 않는다 — 자리를 비운 사이의 만료와 호스트 탈취가 같은 응답을 낸다. heartbeat 단계의 확정은 `401`(토큰)·`403`(원격 비활성)뿐이고, 소유권은 재claim의 응답이 판정한다. claim의 `409`는 소유권 handoff drain 중(`transitioning: true`)이면 backoff 후 재시도하고, 그 외(다른 controller 보유, PC reclaim lockout)는 의사를 해제한다. 이를 위해 conflict 본문의 `active`/`transitioning`을 클라이언트 오류 객체로 올린다. 되찾는 경로에서는 만료를 오류로 표시하지 않고 `Reconnecting...`만 보여주며(가시성과 무관하게 — 배경에서 빨간 문구·네비게이션 열기를 해두면 복귀 시 깜빡임으로만 드러난다), 만료된 lease를 반납하지 않는다 — 반납은 서버를 `transitioning` drain으로 만들어 자신의 재claim이 `409`를 받게 하고 의사가 해제된다. resume capability도 이 경로에서만 유지한다(자기 lease 대체 한정, ADR-0037).

### 13.5 Widget Strip

원격 클라이언트는 데스크톱에 배치된 위젯을 header 아래 한 줄 스트립에 미러한다([ADR-0124](../adr/0124-remote-widget-strip-mirrors-desktop.md)). 배치·옵션의 SoT 는 `settings.widgets` 하나이며(§10 상태 위젯 배치) 원격 전용 배치 설정은 없다.

| Endpoint | Method | 용도 |
|---|---|---|
| `/remote/v1/widgets` | GET | 데스크톱이 그리고 있는 위젯의 표시 모델 |

`/remote/v1/navigation` 과 같이 bearer token·IP/Origin gate 만 요구하고 **lease 는 요구하지 않는다** — 스트립은 호스트를 조작하지 않으므로 열람만 하는 접속에서도 지표가 보인다. `settings.remote.widgets` 가 `false` 면 frontend bridge 를 거치지 않고 `{"enabled": false, "items": []}` 를 돌려준다.

스트립이 실제로 보이는 조건은 **호스트 게이트 AND 기기-로컬 게이트**의 논리곱이다([ADR-0132](../adr/0132-remote-widget-strip-device-local-toggle.md)). 기기 게이트는 drawer 의 `Display` 섹션 토글(`#widgetStripToggle`)이며 브라우저별 `localStorage["laymux.remote.widgetStrip"]`(`"0"` 만 끔, 기본 켬)에 산다 — 호스트로 전송되지 않고 다른 클라이언트에 영향을 주지 않으며, 연결 전에도 조작할 수 있다. 끄면 표시뿐 아니라 **폴 자체가 멈추고**(끈 기기는 `/remote/v1/widgets` 요청을 전혀 만들지 않는다) 다시 켜면 재개한다. 반대 방향은 없다 — 호스트 게이트가 꺼져 있으면 기기 토글로 되살릴 수 없다.

응답은 `{ enabled, fontFamily, fontSize, items[] }` 다. `fontFamily`/`fontSize` 는 `widgets.fontFamily`/`widgets.fontSize` 를 그대로 미러하며(빈 `fontFamily` = 인터페이스 글꼴 상속), 각 item 은 `{ id, type, align, title, kind, ... }` 형태다. `align` 은 `"left"|"right"` 뿐이고 데스크톱의 두 표면은 여기서 사라진다 — 원격 좌측은 `topBar.left`+`statusLine.left`, 우측은 `topBar.right`+`statusLine.right` 를 각 슬롯 배열 순서대로 이어 붙인 것이다. `statusLine.enabled` 가 꺼져 있거나 `type` 이 미등록이면 데스크톱이 그리지 않으므로 item 도 만들어지지 않는다.

`kind` 는 원격이 분기하는 그리기 단위이며 `type` 보다 의도적으로 성기다 — 기존 `kind` 로 사상되는 새 위젯은 원격 코드를 바꾸지 않는다. `kind: "usage"` 는 `{ label, display, unavailable, rows[{key,text,percent,elapsed}], colors{used,pace,track}, barWidth, barHeight, elapsedHeight }`, `"activity"` 는 `{ busy, total }`, `"notifications"` 는 `{ unread }`, `"text"` 는 `{ text, copyText }` 를 갖는다. **행 선택·퍼센트 문자열·색·실패 문구·툴팁(`title`)은 모두 데스크톱이 계산해 보낸다** — 원격은 계산하지 않는다. `unavailable` 이 non-null 이면 숫자를 마지막 성공값으로 대체하지 않고 그대로 사용 불가로 표시한다([ADR-0102](../adr/0102-claude-usage-probe-headless-pty.md)).

값은 데스크톱 프론트 bridge(`query`/`widgets`/`snapshot`)에서 오며 **원격 폴은 probe 수요를 만들지 않는다**. Claude 스냅샷은 backend 가 마지막으로 캡처한 값을 읽을 뿐 probe 를 띄우지 않고, Codex 는 데스크톱의 계정별 단일 폴러가 가진 스냅샷을 공유한다([ADR-0104](../adr/0104-codex-usage-app-server-probe.md)). 폴 주기는 원격 클라이언트가 소유하며 `usage.*.refreshSeconds` 와 무관하다 — 그릴 항목이 있으면 5초, 없으면 30초로 늦추되 멈추지 않는다(배치는 데스크톱에서 언제든 늘어난다). 폴이 멈추는 경우는 셋뿐이다 — 기기 토글을 끈 경우, 연결을 해제한 경우, `401`/`403` 을 받은 경우. 문서가 숨겨진 동안에는 요청을 보내지 않는다(체인은 살아 있다). 폭이 모자라면 접지 않고 가로 스크롤한다 — `widgets.overflow` 의 `collapse` 는 데스크톱 표면 정책이다. 상호작용은 원격 자신의 표면에서 끝난다: 알림 위젯은 원격 drawer 의 알림 패널을 열고, CWD 위젯은 브라우저 클립보드에 복사한다.

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
├── activity_reconcile.rs     # 주기 재판정 + 변경분 push 워커 (ADR-0135)
├── activity_order.rs         # activity 생산자 간 파생 시점 stamp (ADR-0136)
├── process_tree.rs           # PTY 자식 프로세스 트리 liveness (ADR-0009)
├── wsl_liveness.rs           # WSL pane 게스트 프로브 liveness (ADR-0134)
├── wsl_probe.rs              # WSL distribution 해석/검증 + wsl.exe --exec 실행
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
│   ├── mod.rs                # 서버 시작, Automation 라우트 빌드
│   ├── surface_router.rs     # 표면 합성, 공용 fallback, IP allowlist, 최외곽 CORS
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

**`MutexExt` 트레이트**: 모든 `Mutex::lock()` 호출은 이름 있는 `MutexExt` 헬퍼를 사용한다. 정상 운영 경로는 `lock_or_err()`로 poison을 오류 처리한다.

```rust
// ❌ 금지 — 보일러플레이트 반복
state.terminals.lock().map_err(|e| format!("Lock error: {e}"))?;

// ✅ 사용
use crate::lock_ext::MutexExt;
state.terminals.lock_or_err()?;
```

**poison 정책**([ADR-0087](../adr/0087-mutex-poison-fail-closed-discard-only.md)):

| 분류 | helper / 형태 | 허용 동작 | 금지 동작 |
|---|---|---|---|
| 정상 운영 | `lock_or_err()` | 오류 전파, 또는 보수적 실패 결론 | 빈 값·not-found·기존 state를 성공으로 합성 |
| recoverable diagnostic | 범용 helper 없음 | 제어 경로와 분리된 소유 타입의 typed snapshot이 poison/degraded를 함께 표시하는 경우만 별도 근거로 허용 | recovered guard나 clone을 권한·sequence·credit·activity 판정에 사용 |
| discard-only cleanup | `lock_or_recover_for_discard(context)` / owner `Drop`의 `get_mut_or_recover_for_discard(context)` / Condvar의 `recover_poison_for_discard(error, context)` | explicit close·creation rollback·generation retirement에서 entry 제거, clear/overwrite, waiter wake, 추출한 OS resource terminate/drop | 새 작업 승인, 정상 registry/lease 재개, poison 해제 |

discard helper는 좁은 allowlist다. 현재 호출자는 terminal-output session registry/protocol/runtime/desktop-flow retirement, compatibility projection 제거, explicit 또는 fatal generation terminal catalog/PTY handle close, `AppState::drop`의 남은 PTY drain, 그리고 `SleepInhibitor::drop`의 OS 절전 억제 해제([ADR-0114](../adr/0114-sleep-prevention-mode.md))뿐이다. 마지막 항목은 owner `Drop`에서 보유 중인 OS 자원 하나를 해제하고 끝나며, 회수한 state 로 어떤 작업도 재개하지 않는다. fatal PTY callback은 poisoned Condvar 안에서 close를 기다리지 않고 generation-local atomic request를 claim한 뒤 reader에 `Stop`을 반환하며, cleanup coordinator가 discard-only retirement를 수행하고 독립 reaper가 handle을 종료한다([ADR-0088](../adr/0088-pty-output-fatal-generation-teardown.md)). `exec_locks` cleanup은 다른 AppState 락과 겹치지 않으며 entry generation이 retired generation과 같을 때만 제거한다. 회수 뒤에도 mutex poison은 유지되어 후속 `lock_or_err()`가 계속 실패해야 하며, 모든 회수는 정적 `context`와 `tracing::warn!`을 남긴다. sequenced output ring, MCP `exec_locks`, memo serialization gate, frontend health를 포함한 일반 읽기·쓰기는 fail-closed한다.

activity bulk snapshot은 `terminals → output_buffers → per-ring → known app/grace/exit caches → pty_handles` 순서로 읽고 오류를 `Result`로 반환한다. strict control detector는 표시용 detector 전후에 이 건강성을 검증해 registry/ring/activity cache/PTY poison을 빈 states, `Shell`, 전체 sync-CWD target 또는 MCP `null`/빈 capture로 합성하지 않는다. MCP의 PTY 존재 확인도 poison을 not-found로 바꾸지 않으며, 입력 side effect 뒤의 관찰 실패는 side-effect metadata를 가진 tool error로 구분한다.

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

terminal-output session 내부에서 둘 이상의 세부 락을 중첩할 때는 `per-terminal protocol gate → session runtime → output ring → desktop flow` 순서를 따른다. retirement처럼 일부 락을 건너뛰는 경로도 남은 락의 상대 순서는 유지한다.

poison recovery도 이 순서를 바꾸지 않는다. discard helper는 역순 획득이나 상위 registry 재진입을 허용하지 않으며, 잠재적으로 blocking인 PTY `terminate()`는 모든 AppState guard를 놓은 뒤 실행한다.

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

**Rust strict lint 게이트**: Rust 변경을 PR로 보내기 전 `src-tauri/`에서
`cargo clippy --workspace --all-targets -- -D warnings`를 실행한다. `--all-targets`는
라이브러리뿐 아니라 unit/integration test target의 lint 부채도 같은 게이트에 포함하며, 일반
`cargo clippy` 성공은 이를 대체하지 않는다. 불가피한 `#[allow(clippy::...)]`는 crate나 모듈
전체가 아니라 최소 항목에만 붙이고, 해당 위치에 구조 변경보다 예외가 적합한 구체적 이유를
남긴다. 현재 GitHub Actions는 release build만 수행하므로 이 명령은 로컬 PR 검증 의무다.
향후 일반 PR CI를 추가할 때 Rust lint job도 동일 명령을 사용하며 target 축소나 warning 허용으로
완화하지 않는다.

---

## 15. UI 코드 설계 원칙

### 15.1 스타일링

| 규칙 | 설명 |
|------|------|
| CSS 변수 우선 | 모든 공통 값(색상, 간격, 반경, 폰트 크기, hover overlay)은 `index.css` `:root`에 CSS 변수로 정의한다. 하드코딩된 매직 넘버를 직접 사용하지 않는다. |
| Tailwind + CSS 변수 하이브리드 | 레이아웃(flex, grid, spacing)은 Tailwind 유틸리티 클래스, 테마 의존 값(색상, 배경)은 `style={{ }}` 내 CSS 변수로 지정한다. |
| 인라인 스타일 제한 | 인라인 `style`은 CSS 변수 참조, 동적 계산값, 조건부 스타일에만 사용한다. 정적 값은 Tailwind 클래스 또는 CSS 클래스를 사용한다. |
| `color-mix()` 금지 | html2canvas가 파싱하지 못해 스크린샷 API가 깨진다. `var(--accent-50)` 등 사전 정의된 CSS 변수를 사용한다. 상대 색상 문법(`rgb(from …)`)도 같은 이유로 금지다. |
| 색상은 색상 코드로 | 손으로 적는 색상은 `#rrggbb`, 반투명은 8자리 `#rrggbbaa` 로만 쓴다. `rgb()`/`rgba()` 채널 표기는 쓰지 않는다 — 알파는 `round(a * 255)` 로 양자화한 한 바이트다. ([ADR-0112](../adr/0112-hex-color-code-authoring.md)) |
| **각진 모서리가 기본** | laymux 는 각진 UI 를 채용한다. 새 표면·요소는 모서리 반경 없이 그리는 것을 기본값으로 하고, 둥글릴 때만 이유가 있어야 한다. |

#### 각진 디자인

터미널 IDE 의 밀도 높은 격자와 어울리도록 **모서리는 각지게** 유지한다. 이는 취향이 아니라 제품의 시각적 정체성이므로 새 컴포넌트가 임의로 부드러운 모서리를 들여오지 않는다.

- 기본은 반경 0 이다. 사용량 막대, 위젯 표면, 상태 줄처럼 정보를 조밀하게 늘어놓는 요소는 반경을 주지 않는다.
- 반경이 정말 필요하면 `--radius-sm`(2px)·`--radius-md`(3px)·`--radius-lg`(6px) 토큰만 쓴다. 숫자 하드코딩(`borderRadius: 2`)은 금지다 — 토큰을 안 쓴 값은 나중에 정체성을 조정할 때 잡히지 않는다.
- `--radius-lg` 는 모달처럼 배경에서 확실히 떠 있어야 하는 큰 표면에 한정한다. 버튼·칩·막대에는 쓰지 않는다.

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
- **Pane 포커스 전환은 컴포넌트가 조립하지 않는다**([ADR-0081](../adr/0081-pane-focus-transition-single-owner.md)). workspace/grid/dock의 raw state SoT는 각 Zustand store에 두되, 둘 이상의 store를 함께 바꾸는 workspace pane·dock pane 전환은 `lib/workspace-transition.ts`만 소유한다. UI 이벤트, 키보드, Automation/Remote adapter와 공유 navigation은 이 액션을 호출하고 `setActiveWorkspace`·`setFocusedDock`·`setFocusedPane` 조합을 직접 만들지 않는다.

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

(과거에는 워크스페이스 클리어가 이 핸들러에게 "무엇을 칠지"·"지금 busy 한지"도 물었다 — [ADR-0113](../adr/0113-workspace-clear-activity-owned.md). [ADR-0137](../adr/0137-workspace-clear-ctrl-l-broadcast.md) 이후 클리어는 activity 판정 없이 Ctrl+L 만 보내므로 `clearInput`/`isBusy` 는 인터페이스에서 제거됐다.)

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
