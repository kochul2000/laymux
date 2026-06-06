# 아키텍처 — 데이터 흐름 (런타임)

> **이 문서는 living doc 이다.** HEAD 의 현재 동작을 반영하며, 코드 변경이 서술과 어긋나면 **같은 PR 에서** 갱신한다.
> 정적 구조는 [overview.md](./overview.md), 결정 근거는 [ADR](../adr/), 계약·코드 규약은 [api-contracts.md](./api-contracts.md) 를 본다.
>
> **이 문서가 담는 범위** — laymux 의 런타임 흐름: Grid 편집 UX · TerminalView(OSC 파이프라인 · 렌더러 reflow) · WorkspaceSelectorView(상태 계산) · 전체 데이터 흐름 · 세션 영속/캐시.
> 섹션 번호(§5·§8·§9·§11·§13)는 구 `ARCHITECTURE.md` 기준을 보존한다.

---
## 5. Grid 편집 UX

### 편집 모드 토글

- 툴바에 토글 버튼 하나로 ON/OFF (사용자가 자유롭게 유지)
- **OFF (기본)**: 레이아웃 완전 잠금, 실수 변경 불가
- **ON**: 경계선 핸들 표시, 분할/병합 조작 가능

### 분할

| 방법 | 동작 |
|---|---|
| 경계선 핸들 드래그 | 드래그 방향으로 신규 분할 |
| 툴바 버튼 | 현재 포커스 Pane을 가로/세로 분할 |
| settings.json | 직접 비율 정의 |

### 크기 조절

- 경계선 드래그 (자유 비율, 0.0~1.0 백분율로 저장)
- Pane 최소 크기: 100px (이하 드래그 불가)

### 병합 (Pane 제거)

| 방법 | 동작 |
|---|---|
| 경계선 끝까지 드래그 | 인접 Pane이 흡수 |
| 경계선 더블클릭 | 작은 쪽 Pane 제거, 큰 쪽이 흡수 |
| 편집 모드에서 Pane 선택 후 Delete | 인접 Pane 중 가장 큰 것이 흡수 |

---

## 8. TerminalView

### 8.1 기능

- WSL, PowerShell 프로파일 지원
- 환경변수 접근 및 설정 가능
- xterm.js 렌더링, node-pty로 실제 PTY 연결

### 8.2 `lx` CLI

IDE가 TerminalView를 spawn할 때 아래 환경변수를 자동 주입한다.
사용자는 별도 설정 없이 쉘에서 바로 `lx` 명령을 사용할 수 있다.

```bash
# IDE가 터미널 spawn 시 자동 주입
export LX_SOCKET=/tmp/lx-{session}.sock    # IDE와 통신하는 Unix 소켓
export LX_TERMINAL_ID=terminal-{id}        # 현재 터미널 인스턴스 ID
export LX_GROUP_ID=group-{id}              # 현재 SyncGroup ID
export PATH="$PATH:/usr/local/lx/bin"      # lx 바이너리 경로
```

**커맨드 목록**

```bash
lx sync-cwd [path]                     # 그룹 내 CWD 동기화
lx sync-cwd [path] --all               # 모든 터미널에 전파
lx sync-cwd [path] --group [name]      # 특정 그룹에 전파
lx sync-branch [branch]                # 그룹 내 브랜치 동기화
lx notify "[message]"                  # IDE 알림
lx notify --level error "[message]"    # 레벨 지정 알림 (info|error|warning|success)
lx set-tab-title "[title]"             # 탭 제목 변경
lx set-command-status --command "[cmd]" # 실행 중인 명령 기록
lx set-command-status --exit-code N    # 명령 종료 코드 기록
lx open-file [path]                    # 에디터에서 파일 열기
lx send-command "[cmd]" --group [name] # 그룹 터미널에 명령 전송
lx get-cwd                             # 현재 CWD 조회
lx get-branch                          # 현재 브랜치 조회
lx get-terminal-id                     # 현재 터미널 ID 조회
```

### 8.3 OSC 처리 파이프라인

OSC 이스케이프 시퀀스는 **Rust PTY 콜백에서 단일 패스로 처리**한다. 프론트엔드는 Rust가 발행한 Tauri 이벤트만 구독하며, OSC 파싱이나 훅 매칭 로직을 포함하지 않는다.

#### 설계 원칙

- **OSC 파싱은 Rust 전용**: `osc.rs`의 `iter_osc_events()`가 PTY 출력에서 모든 OSC 시퀀스를 단일 패스로 추출한다. 프론트엔드에서 OSC regex를 사용하거나 파싱하지 않는다.
- **훅 매칭은 Rust 전용**: `osc_hooks.rs`의 선언적 `OscCondition`/`OscAction` 모델과 `match_hooks()`가 이벤트를 액션으로 변환한다. 프론트엔드에 `when` 조건 평가 로직을 두지 않는다.
- **액션 디스패치는 Rust 전용**: `dispatch_osc_action()`이 `do_sync_cwd()`, `do_notify()` 등 공유 함수를 직접 호출한다. IPC 라운드트립(프론트엔드→lx→Rust) 없이 즉시 실행된다.
- **프론트엔드는 이벤트 리스너만**: `useSyncEvents`에서 `terminal-title-changed`, `terminal-cwd-changed`, `sync-cwd`, `lx-notify` 등 구조화된 Tauri 이벤트를 구독하여 UI를 갱신한다.

#### 데이터 흐름

```
[PTY 출력]
    │
    ▼
[Rust PTY 콜백]
    │  iter_osc_events() — 단일 패스 OSC 파싱
    │  match_hooks() — 프리셋 매칭
    │  dispatch_osc_action() — do_sync_cwd/do_notify/... 직접 호출
    │  app.emit() — 구조화 이벤트 발행
    ▼
[Frontend: useSyncEvents]
    │  Tauri 이벤트 리스너 → Zustand store 갱신
    ▼
[UI 반영]
```

#### 새 OSC 동작 추가 시

1. `osc_hooks.rs`에 `OscAction` variant 추가
2. `default_presets()`에 `OscHookDef` 추가 (OSC 코드, param, 조건, 액션)
3. `commands/terminal.rs`의 `dispatch_osc_action()`에 매칭 분기 추가
4. 필요시 `commands/ipc_dispatch.rs`에 `do_*()` 공유 함수 추가
5. 프론트엔드가 새 이벤트를 소비해야 하면 `tauri-api.ts`에 리스너 추가 + `useSyncEvents`에서 구독

**금지 사항**: 프론트엔드에서 OSC regex 파싱, 훅 조건 평가(`new Function()`), IPC를 통한 라운드트립 OSC 처리를 하지 않는다.

#### Notify Gate

셸 초기화 시 발생하는 OSC 133;D가 불필요한 알림을 유발하는 것을 방지한다.

- `TerminalSession.notify_gate_armed` (기본값 `false`)로 게이팅
- OSC 133;C (preexec) 또는 133;E (command text) 수신 시 게이트 활성화
- preexec를 지원하지 않는 셸(PowerShell 등)은 `NOTIFY_GATE_FALLBACK_MS`(3초) 후 자동 활성화
- Notify 액션은 게이트가 활성화된 후에만 디스패치됨

#### 프리셋 목록

| Preset | OSC | 동작 |
|---|---|---|
| `sync-cwd` | OSC 7 | 그룹 내 터미널 CWD 동기화 |
| `set-wsl-distro` | OSC 9;9 | WSL distro 이름 추출 |
| `sync-branch` | OSC 133;E (git 명령 감지) | 그룹 내 터미널 브랜치 동기화 |
| `notify-on-fail` | OSC 133;D (exitCode ≠ 0) | 실패 알림 |
| `notify-on-complete` | OSC 133;D (exitCode = 0) | 성공 완료 알림 |
| `set-title-cwd` | OSC 7, OSC 9;9 | 탭 제목을 CWD로 변경 |
| `notify-osc9` | OSC 9 (sub-code 없음) | 터미널 알림 |
| `notify-osc99` | OSC 99 | 터미널 알림 |
| `notify-osc777` | OSC 777 | 터미널 알림 |
| `track-command` | OSC 133;E | 실행된 명령을 워크스페이스 요약에 기록 |
| `track-command-result` | OSC 133;D | 명령 종료 코드를 워크스페이스 요약에 기록 |
| `track-command-start` | OSC 133;C | 명령 시작(preexec) 기록 |

> **논리 프리셋 12종 vs 훅 13개.** `osc_hooks.rs` 의 `default_presets()` 는 **13개** `OscHookDef` 를 반환한다(테스트 `assert_eq!(default_presets().len(), 13)` 로 고정). `set-title-cwd` 가 OSC 7용·OSC 9;9용 **2개 훅**으로 등록되기 때문이며, 위 표는 이를 논리적으로 한 행에 묶었다.

### 8.4 Terminal renderer reflow / WebGL atlas 원칙

TerminalView의 xterm.js WebGL 렌더러는 **셀 geometry 변경**과 **옵션/상태 변경**을 엄격히 분리한다. WebGL texture atlas는 글리프를 현재 cell width/height 및 devicePixelRatio 기준으로 rasterize하므로, atlas invalidation은 실제 셀 geometry가 바뀌는 경우에만 수행한다.

#### Reflow 허용 조건

`fit()` + `clearTextureAtlas()` + `refresh()` 조합은 비용이 크고 WebGL renderer 내부 atlas를 재생성한다. 이 경로는 다음 경우에만 호출한다.

- `fontSize` / `fontFamily` 변경: cell width/height가 바뀌므로 `fit()` 후 atlas를 재생성한다.
- 브라우저 zoom 또는 monitor DPR 변경: glyph rasterization 해상도가 바뀌므로 atlas를 재생성한다.
- 숨김(`display: none`, 0×0) 상태에서 실제 크기로 복귀: 숨겨진 동안 stale atlas가 남을 수 있으므로 복귀 시 한 번 재생성한다.
- scrollbar mode처럼 terminal viewport geometry를 실제로 바꾸는 설정 변경.

#### Reflow 금지 조건

다음 변경은 xterm option 또는 overlay 상태만 바꾸며 cell geometry를 움직이지 않는다. 따라서 `fit()`, `clearTextureAtlas()`, `refresh()`를 직접 호출하지 않는다.

- activity 변경(Codex/Claude 시작·종료, shell 복귀)
- native cursor hidden 토글 및 overlay caret 활성화/비활성화
- cursor shape / cursor blink / cursor color 변경
- theme 색상 변경
- focus 변경 및 단순 overlay caret 위치 갱신

#### 비활성 워크스페이스의 reflow 지연 (dirty flag)

WorkspaceArea는 비활성 워크스페이스를 `display: none`으로 숨기므로 해당 TerminalView의 컨테이너는 0×0이 된다. 그러나 폰트/DPR/scrollbar 변경 effect와 matchMedia DPR 리스너는 모든 마운트된 인스턴스에서 실행되므로, 가드 없이 두면 다음 두 부작용이 발생한다.

1. `fit()`이 0×0 컨테이너에서 cols/rows=0을 계산해 `terminal.onResize` → PTY resize ioctl로 전파된다 → 비활성 워크스페이스의 셸이 잘못된 크기로 SIGWINCH를 받는다.
2. `clearTextureAtlas()` + `refresh()`는 paint가 일어나지 않는 hidden 캔버스에서 무의미하며, 진짜로 보일 때의 atlas는 여전히 stale이다.

따라서 TerminalView는 두 개의 ref로 상태를 추적한다.

- `isContainerHiddenRef` — ResizeObserver 콜백 종료 시 마지막 entry의 `isNowHidden` 값으로 갱신. 현재 hidden 여부를 폰트/DPR/scrollbar effect에서 동기적으로 조회할 수 있다.
- `reflowDirtyRef` — hidden 상태에서 위 트리거가 실행되면 즉시 reflow 대신 `true`로 마킹.

ResizeObserver의 hidden→visible 분기에서는 `recoveringFromHidden`(=기존 `prevWasHidden`)과 `reflowDirtyRef.current`를 OR로 결합해 단일 `fit() + clearTextureAtlas() + refresh()`로 소비하고, dirty를 다시 `false`로 클리어한다. 같은 integer 크기 가드도 dirty 플래그를 함께 검사해 보류된 reflow가 누락되지 않도록 한다.

이 메커니즘은 §8.4의 "0×0 hidden 상태에서 실제 크기로 복귀할 때만 atlas 재생성" 원칙을 위반하지 않는다. 오히려 hidden 동안 발생한 폰트/DPR/scrollbar 변경을 그 단일 transition에 합류시켜 reflow 호출을 추가하지 않는다.

#### Burst collision 방지

Codex/Claude 같은 TUI는 종료 시 `ESC[?1049l`, scrollback 재방출, footer repaint 등 많은 출력과 cursor/renderer 상태 전환을 짧은 시간에 발생시킨다. 이 시점에 activity 변경까지 겹쳐 `fit()` + `clearTextureAtlas()` + `refresh()`가 반복 호출되면 WebGL atlas rebuild가 TUI exit burst와 충돌하여 인접 pane의 glyph corruption으로 나타날 수 있다.

따라서 reflow 요청은 반드시 `requestAnimationFrame` 단위로 coalesce하고, 같은 tick 안에서 여러 번 발생해도 마지막 요청만 실행한다. activity/cursor/theme 변경 effect는 terminal option만 갱신하고, 필요한 overlay caret 갱신은 별도 updater로 처리한다. 셀 geometry reflow는 font/DPR/실제 size transition을 담당하는 전용 effect에만 둔다.

#### 테스트 요구사항

TerminalView renderer 경로를 수정할 때는 다음 회귀 테스트를 유지하거나 추가한다.

- font 변경은 한 프레임에 coalesce된 reflow를 예약하고 `clearTextureAtlas()`를 호출한다.
- activity 토글(Codex 시작/종료)은 reflow를 호출하지 않는다.
- cursor shape/blink 변경은 option만 갱신하고 reflow를 호출하지 않는다.
- 같은 integer size의 ResizeObserver entry는 `fit()`을 호출하지 않는다.
- 0×0 hidden 상태에서 실제 크기로 복귀할 때만 atlas를 재생성한다.
- hidden(0×0) 컨테이너에서 font/DPR/scrollbar 변경이 발생해도 `fit()` 및 `clearTextureAtlas()`를 즉시 호출하지 않는다 (dirty 마킹만 수행).
- hidden→visible 전환 시 보류된 dirty가 있으면 단일 `fit() + clearTextureAtlas() + refresh()`로 소비하고 dirty를 클리어한다.

---

## 9. WorkspaceSelectorView (cmux 클론)

### UI 구조

```
┌───────────────────────────────┐
│  + New Workspace              │
├───────────────────────────────┤
│ 🔵 프로젝트A              [2] │  ← 이름 + 읽지 않은 배지 + 알림 링
│    feature/login · ~/dev/proj │  ← 브랜치(초록) · CWD(회색) 한 줄
│    :3000  :8080               │  ← 리스닝 포트(시안, 활성 WS만)
│    ✓ npm test · 3분 전        │  ← 마지막 명령 + 결과 + 시간
│    "빌드 완료"                │  ← 최신 알림(레벨별 색상)
├───────────────────────────────┤
│    main · ~/dev/api           │  ← 비활성: 이름+브랜치+CWD만
└───────────────────────────────┘
```

### Pane 위치 미니맵

WorkspaceSelectorView에서 각 Pane(쉘) 요약 행의 왼쪽에 소형 레이아웃 미니맵을 표시한다.

#### 목적

워크스페이스 내 해당 Pane의 물리적 위치를 시각적으로 즉시 파악할 수 있게 한다.

#### 렌더링 방식

- **Canvas 또는 SVG**로 렌더링 (문자 아트 X — 실제 비율 기반 그래픽)
- 크기: 고정 `18×12px` (종횡비 3:2, 텍스트 줄 높이에 맞춤)
- 테두리: 1px 보더 — 워크스페이스 전체 WorkspaceArea를 나타냄
- 모든 Pane의 위치(x, y)와 크기(w, h)를 **워크스페이스 전체 면적 대비 정확한 비율**로 렌더링
  - 예: Pane이 `{ x: 0.0, y: 0.0, w: 0.5, h: 0.6 }` → 미니맵의 왼쪽 상단 50%×60% 영역
- 해당 Pane 영역만 액센트 색상으로 채움 (나머지 Pane은 배경색)
- Pane 간 구획선: 0.5px, `border-color` 계열 반투명

#### 데이터 소스

- Workspace의 `panes` 배열에서 각 Pane의 `{ x, y, w, h }` 비율값 사용
- Layout 데이터와 1:1 대응 — Grid 편집 시 실시간 반영

#### 시각 예시

```
 ┌────────┐
 │████    │  feature/login · ~/dev/proj
 │████    │  ✓ npm test · 3분 전
 └────────┘
 ┌────────┐
 │    ████│  main · ~/dev/api
 │    ████│  ⏳ cargo build · 방금
 └────────┘
```
(실제로는 Canvas/SVG 그래픽으로 렌더링됨. ████ 영역이 해당 Pane의 위치)

#### 스케일링

- Pane 수에 관계없이 비율 기반 렌더링으로 정확한 위치 표현
- 극단적 분할(10+ Pane)에서도 하이라이트 영역 최소 2px 보장
- Pane이 1개뿐인 경우 전체가 채워진 미니맵 표시 (생략하지 않음)

#### 배치

- 각 Pane 요약 행의 **왼쪽**에 인라인 배치
- 미니맵과 텍스트 요약 사이 간격: `8px`

### 탭 표시 정보

| 항목 | 데이터 소스 | 표시 조건 |
|---|---|---|
| Workspace 이름 | 사용자 지정 | 항상 |
| git branch | OSC 133E 감지 또는 `.git/HEAD` watch | 있을 때 |
| working directory | OSC 7 감지 | 있을 때 (브랜치와 같은 줄) |
| 리스닝 포트 | 주기적 `ss -tlnp` / `netstat` 조회 | 활성 워크스페이스만 |
| 마지막 명령 + 결과 | OSC 133 E/D → `lx set-command-status` | 있을 때 |
| 최신 알림 텍스트 | OSC 9/99/777 또는 `lx notify` | 읽지 않은 알림 있을 때 |
| 읽지 않은 알림 배지 | 알림 시스템 | 카운트 > 0 |
| 알림 링 (테두리) | 알림 발생 시 | 읽지 않은 알림 있을 때 |

### 마지막 명령 표시 (Activity-Aware Computation)

표시 항목(아이콘, 색상, 텍스트)은 **원시 상태를 변경하지 않고**, activity 타입을 추가 입력으로 받아 계산 함수에서 분기하여 도출한다.

#### 기본 (셸, activity = none)

| 우선순위 | 조건 | 아이콘 | 색상 |
|---|---|---|---|
| 1 | `outputActive === true` | ⏳ | 노랑 |
| 2 | `exitCode === 0` | ✓ | 초록 |
| 3 | `exitCode !== undefined` (≠ 0) | ✗ | 빨강 |
| 4 | 나머지 (유휴/대기) | — | 회색 |

#### Activity-Aware 분기 원칙

`computeCommandStatus(rawState, activity)` 함수는 activity 타입에 따라 **status(아이콘/색상)**, **statusMessage(텍스트)**, **notification(알림 발생 여부/내용)** 세 가지를 최적화한다.

| 항목 | 셸 (기본) | Claude Code (activity = Claude) |
|------|-----------|-------------------------------|
| **status** | OSC 133 C/D 기반 4상태 | working/idle 전환 + 합성 exitCode |
| **statusMessage** | 셸 명령 텍스트 (`npm test`) | 태스크 설명 (`Working on task`) |
| **notification** | exitCode ≠ 0 → 실패 알림 | task_completed 메시지 기반 알림 |

**설계 규칙**:
- 원시 상태(`commandText`, `exitCode`, `outputActive`, `title` 등)는 activity와 무관하게 독립 저장한다. 하나의 공유 필드를 앱별로 덮어쓰지 않는다.
- 계산 함수는 원시 상태 + activity 타입을 입력받아 최종 표시를 도출한다. activity 타입이 추가되면 계산 함수에 분기만 추가한다.
- 앱 전용 분기 로직은 [api-contracts.md](./api-contracts.md) §15.6(앱 전용 편의 코드 격리)에 따라 격리된 모듈에 구현하고, 계산 함수에서 import하여 사용한다.

명령 텍스트는 최대 30자로 truncate, 시간은 상대 시간(방금, N분 전, N시간 전)으로 표시.

### outputActive 감지 (워크스페이스 상태 관리 원칙)

`outputActive`는 ⏳ 아이콘(우선순위 1)을 결정하는 프론트엔드 전용 상태다. **두 가지 독립된 감지 경로**가 있으며, 백엔드에서 직접 `outputActive`를 계산하지 않는다.

| 감지 경로 | 대상 | 신호 | 동작 |
|---|---|---|---|
| OSC 133 C/D | 셸 명령 (pytest, apt 등) | preexec → precmd lifecycle | `commandRunning` → `outputActive` |
| DEC 2026h | TUI 앱 (Claude Code, neovim 등) | `\x1b[?2026h` (동기화 렌더 시작) | Rust PTY 콜백에서 감지 → `terminal-output-activity` 이벤트 |
| 타이틀 스피너 | TUI 앱 thinking 단계 ([api-contracts.md](./api-contracts.md) §15.6) | OSC 0/2 타이틀 스피너 회전 | Rust PTY 콜백에서 `now_working` 감지 → `terminal-output-activity` 이벤트 |

#### 설계 원칙

- **프론트엔드가 단일 소스**: `outputActive`는 Zustand store(`terminal-store`)에서만 관리한다. 백엔드 `TerminalSummaryResponse`에 `outputActive`를 포함하지 않는다.
- **DEC 2026은 TUI 전용 신호**: 일반 셸 명령(`ls`, `pytest` 등)은 DEC 2026h를 사용하지 않으므로 이 경로로 감지되지 않는다. 셸 명령의 running 상태는 OSC 133 C/D가 담당한다.
- **ANY PTY 출력 기반 판단 금지**: `output_buffer.last_output_at` 같은 "PTY에 뭐라도 출력되면 active" 방식은 셸 프롬프트 리드로에도 false positive를 유발하므로 사용하지 않는다.
- **빈도 기반 감지 (Burst Detection)**: 단일 DEC 2026h 이벤트만으로는 활성으로 판정하지 않는다. 포커스 리드로(DEC 1004 → `\x1b[I]` → 앱이 1회 리드로)나 키 입력 에코(키스트로크 → 앱이 1회 리드로)는 모두 1회성이다. **`windowMs`(기본 2초) 내에 `threshold`(기본 6회) 이상의 DEC 2026h가 감지되어야** 이벤트를 발행한다. 실제 TUI 작업(Claude 응답 생성, neovim 편집)은 초당 수십 회 프레임을 보내므로 임계값을 즉시 넘는다. 이 파라미터는 `settings.json`의 `terminal.outputActivityBurst` 섹션에서 조정할 수 있다.
- **Throttle**: 임계값 충족 후에도 이벤트는 터미널당 최대 `throttleMs`(기본 1초)로 throttle하여 이벤트 폭주를 방지한다.
- **타이머 리셋**: 프론트엔드에서 이벤트 수신 시 `outputActive=true`로 설정하고, 2초간 새 이벤트가 없으면 `false`로 리셋한다.

#### 데이터 흐름 (DEC 2026 경로)

```
[TUI 앱: Claude Code / neovim]
  │  매 프레임: \x1b[?2026h → 콘텐츠 → \x1b[?2026l
  ▼
[Rust PTY 콜백]
  │  data.windows()로 \x1b[?2026h 스캔
  │  burst_count++ (2초 윈도우 내 카운터)
  │  count ≥ threshold (기본 6)?
  │    → Yes: AtomicU64 throttle (throttleMs/터미널) 후 app.emit("terminal-output-activity")
  │    → No:  무시 (포커스 리드로 / 키 에코)
  ▼
[Frontend: useSyncEvents]
  │  outputActive=true + 2초 타이머 리셋
  ▼
[computeCommandStatus]
  │  outputActive=true → ⏳ (priority 1)
```

#### False Positive 방지

| 상황 | DEC 2026h 횟수 | 결과 |
|------|---------------|------|
| 포커스 전환 (DEC 1004 → 리드로) | 1회 | 무시 (임계값 미달) |
| 키 입력 에코 (타이핑) | 키당 1회 | 무시 (일반 타이핑 속도로는 2초 내 6회 미달) |
| Claude Code 응답 생성 | 수십~수백 회/초 | ⏳ 활성 (즉시 임계값 충족) |
| neovim 화면 갱신 | 수십 회/초 | ⏳ 활성 (즉시 임계값 충족) |

### 인터랙티브 앱 인식 — 프로세스 트리 liveness ([ADR-0009](../adr/0009-process-tree-interactive-app-liveness.md))

Claude Code·Codex 가 실행 중인지의 **권위는 PTY 자식 프로세스 트리**다. 타이틀(`Claude Code`/`OpenAI Codex` 배너·스피너)과 인메모리 캐시(`known_{claude,codex}_terminals`)는 앱 식별·작업/유휴·메시지 추출의 보조 신호일 뿐, "살아있는가/종료됐는가"의 최종 판정은 프로세스 트리가 한다.

- **오라클(3-state `PtyAppLiveness`)**: `process_tree::interactive_app_in_pty(state, terminal_id)` 가 PTY `child_pid` 의 자손 트리를 BFS 로 훑어 `claude.exe`/`codex.exe`(Linux: `claude`/`codex`)를 찾는다. `Running(app)`(가장 얕은 매치 = 포그라운드 앱) / `NoneAlive`(PID·스냅샷 성공 + 앱 없음 = 권위 있는 부재) / `Unknown`(PID 없음·serial·스냅샷 실패 = 신호 없음). 전역 스냅샷은 1초 TTL 로 캐시해 스피너 틱마다의 재열거를 막는다(종료 판정만 fresh 우회).
- **양성 권위**: `is_{claude,codex}_terminal_from_buffer` 는 오라클이 `Running(해당 앱)` 이면 타이틀/버퍼와 무관하게 `true` + 캐시 갱신. 긴 세션에서 시작 배너가 16KB 창 밖으로 밀려나고 타이틀이 스피너뿐이어도 인식이 유지된다.
- **음성 권위**: `NoneAlive`(또는 다른 앱 `Running`)는 stale 휴리스틱을 이긴다 — 캐시를 비우고 즉시 `false`, 버퍼-스캔의 배너 재고정을 건너뛴다. 이게 없으면 OSC exit title 없이 죽은 경우(SIGKILL·콜백 드롭) 16KB 의 stale 배너가 스크롤아웃까지 앱을 재고정한다. `Unknown` 만 타이틀/버퍼 휴리스틱으로 폴백한다.
- **false-exit 억제**: PTY 콜백의 타이틀 상태머신이 "비-앱 타이틀 → 종료"로 판정해도, 오라클(fresh)이 `Running` 으로 프로세스 생존을 확인하면 그 종료를 무효화한다(`claude_detected`·캐시·grace window·`claude_was_working` 보존, `interactiveAppExited` 미발행, 허위 "task completed" 미발행). 종료는 프로세스 소멸로만 확정된다.

인메모리 캐시는 영속화하지 않는다 — 앱 완전 재시작 시 PTY 가 죽어 감지 대상이 없고, webview 리로드 시 백엔드 `AppState`(캐시·버퍼·PTY)가 그대로 살아남기 때문.

### 알림 레벨별 색상

| 레벨 | 색상 |
|---|---|
| `error` | 빨강 |
| `warning` | 노랑 |
| `success` | 초록 |
| `info` (기본) | 액센트 |

### 알림 시스템

```
발생 경로:
  OSC 9 / OSC 99 / OSC 777   ← 터미널 이스케이프 시퀀스
  lx notify "메시지"           ← CLI 호출

표시:
  - Workspace 탭 파란 링 강조
  - 사이드바 읽지 않은 배지 숫자
  - 알림 패널 (모아보기)
  - OS 네이티브 알림

해제:
  - 해당 Workspace 클릭 시 읽음 처리
```

### 키보드 단축키

설계 원칙: 전역 IDE 단축키는 `Ctrl+Shift`·`Ctrl+Alt`·`Alt+Arrow` 조합을 우선해 셸(readline, vim 등)의 `Ctrl+단일키`와 충돌을 피한다. Windows Terminal 키바인딩과 최대한 일치시킨다. 일부(터미널 copy/paste·zoom)는 의도적으로 `Ctrl+단일키`를 쓰며 근거는 [api-contracts.md](./api-contracts.md) §15.5 참조.

> **정본은 `ui/src/lib/keybinding-registry.ts` 의 `DEFAULT_KEYBINDINGS`** 다. 모든 단축키는 사용자가 재바인딩할 수 있으며(SettingsView Keybindings UI), 아래는 기본값 요약이다.

| 액션 ID | 기본 단축키 | 동작 |
|---|---|---|
| `workspace.1`~`8` | `Ctrl+Alt+1`~`8` | 워크스페이스 1~8 이동 |
| `workspace.last` | `Ctrl+Alt+9` | 마지막 워크스페이스 |
| `workspace.next` / `prev` | `Ctrl+Alt+↓` / `Ctrl+Alt+↑` | 다음 / 이전 워크스페이스 |
| `workspace.new` | `Ctrl+Alt+N` | 새 워크스페이스 |
| `workspace.duplicate` | `Ctrl+Alt+D` | 워크스페이스 복제 |
| `workspace.close` | `Ctrl+Alt+W` | 워크스페이스 닫기 |
| `workspace.rename` | `Ctrl+Alt+R` | 워크스페이스 이름 변경 |
| `pane.focus` | `Alt+Arrow` | Pane 포커스 이동 (상하좌우) |
| `pane.delete` | `Delete` | 편집 모드에서 포커스된 Pane 제거 |
| `sidebar.toggle` | `Ctrl+Shift+B` | 사이드바 토글 |
| `notifications.toggle` | `Ctrl+Shift+I` | 알림 패널 토글 |
| `notifications.unread` | `Ctrl+Shift+U` | 가장 최근 읽지 않은 알림으로 이동 |
| `notifications.recent` | `Ctrl+Alt+←` | 최근 알림 발생 Pane으로 이동 (알림 소비) |
| `notifications.oldest` | `Ctrl+Alt+→` | 오래된 알림 발생 Pane으로 이동 (알림 소비) |
| `settings.open` | `Ctrl+,` | 설정 모달 토글 |
| `fileViewer.open` | `Ctrl+Shift+O` | 통합 파일 뷰어 열기 |
| `issueReporter.submit` | `Ctrl+Enter` | 이슈 리포터 제출 |
| `terminal.copy` / `paste` | `Ctrl+C` / `Ctrl+V` | 터미널 복사 / 붙여넣기 (터미널 한정 예외 — §15.5; `Ctrl+C` 는 선택 없을 때만 SIGINT 위임) |
| `terminal.zoomIn` / `zoomOut` / `zoomReset` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 터미널 폰트 확대 / 축소 / 리셋 |

---

## 11. 전체 데이터 흐름 요약

```
[Shell: cd /foo]
    │  chpwd hook → printf '\e]7;file://localhost/foo\a'
    ▼
[Rust PTY 콜백]
    │  iter_osc_events() → OSC 7 감지
    │  session.cwd 직접 갱신 (단일 진실 소스)
    │  match_hooks() → SyncCwd 액션 매칭
    │  dispatch_osc_action() → do_sync_cwd() 직접 호출
    │    → syncGroup 조회 → 대상 터미널 필터링
    │    → LX_PROPAGATED=1 플래그 설정 (루프 방지)
    │    → 대상 PTY에 " cd /foo\n" write
    │  app.emit("terminal-cwd-changed") + app.emit("sync-cwd")
    ▼
[Frontend: useSyncEvents]
    │  이벤트 리스너 → Zustand store 갱신
    ▼
[WorkspaceSelectorView]
    working directory 표시 갱신
```

**1회성 CWD 전파 (issue #293).** 위 흐름은 셸의 `cd`가 자동 전파되는 경로다. 이와 별개로, 컨트롤 패널(`PaneControlBar`)의 "Propagate CWD once" 버튼은 현재 터미널의 CWD를 sync group에 한 번만 밀어넣는다(`propagate_cwd_once` → `do_sync_cwd(force=true)`). 평소 동기화를 꺼둔 file explorer/viewer를 필요할 때만 따라오게 하는 용도다. `force=true`는 소스 측 게이트(에코 루프·소스 activity·`cwd_send`)와 대상 `cwd_receive` 필터를 우회하지만, 대상이 명령 실행 중/TUI 앱이면 cd 주입을 막는 `filter_targets_not_busy` 게이트는 유지한다. 가드 상세는 [api-contracts.md §10](api-contracts.md)의 "1회성 CWD 전파" 참조.

---

## 13. Session Persistence & Cache

### 13.1 개요

앱 재시작 시 터미널의 이전 출력과 CWD를 복원한다. 프로파일 단위로 제어한다.

### 13.2 캐시 디렉터리

```
~/.config/laymux/          (Linux, release)
~/.config/laymux-dev/      (Linux, dev)
%APPDATA%/laymux/          (Windows, release)
%APPDATA%/laymux-dev/      (Windows, dev)
├── settings.json
├── automation.json
└── cache/
    ├── memo.json
    ├── window-geometry.json
    └── terminal-output/
        ├── pane-abc12345.dat    ← xterm.js SerializeAddon 출력
        └── pane-def67890.dat
```

`cache/` 디렉터리는 향후 다른 캐시 데이터(메모 등)도 수용할 수 있도록 확장 가능한 구조.

### 13.3 프로파일 설정

```jsonc
{
  "profileDefaults": {
    "restoreCwd": true,       // 기본값: 마지막 CWD 복원
    "restoreOutput": true     // 기본값: 이전 출력 복원
  },
  "profiles": [
    {
      "name": "PowerShell",
      "restoreOutput": false   // 프로파일별 오버라이드 (Option — 없으면 defaults 상속)
    }
  ]
}
```

### 13.4 종료 시퀀스

```
[Window close-requested event]
    │  App.tsx onCloseRequested 핸들러
    ▼
[saveBeforeClose()]
    ├─ 1. 모든 TerminalView의 SerializeAddon.serialize()
    │     → cache/terminal-output/{paneId}.dat 저장
    ├─ 2. persistSession()
    │     → settings.json (lastCwd 포함)
    └─ 3. cleanTerminalOutputCache(activePaneIds)
          → 고아 캐시 파일 정리
    ▼
[appWindow.destroy()]
```

### 13.5 시작 시퀀스

```
[useSessionPersistence 로드]
    │  settings.json → stores 적용
    │  workspace pane ID 복원 (안정 ID)
    │  orphan 캐시 정리
    ▼
[TerminalView 마운트]
    │  profile restoreOutput 확인
    │  lastCwd 존재 = 복원 대상 pane
    ├─ loadTerminalOutputCache(paneId)
    │     → terminal.write(cached)
    │     → "--- session restored ---" 구분선
    └─ createTerminalSession(cwd: lastCwd)
          → PTY가 마지막 CWD에서 시작
```

**활동 상태 초기 동기화 (webview 리로드).** 백엔드 `AppState`는 webview 리로드에도 생존하므로 인터랙티브 앱 인식이 유지되지만, 프론트 활동 스토어는 리마운트로 비워진다. `useSyncEvents` 는 마운트 시 `get_terminal_states` 를 1회 호출해 살아있는 앱의 `interactiveApp` 활동을 재시드한다. 인스턴스가 늦게 등록되는 레이스는 스토어 구독으로 흡수하며, 모든 대상이 매칭되면 구독을 해제한다. 라이브 이벤트가 더 신선한 분류를 이미 적용했으면 덮어쓰지 않는다. ([ADR-0009](../adr/0009-process-tree-interactive-app-liveness.md))

### 13.6 Workspace Pane ID

- Pane ID는 `pane-{uuid8}` 형식으로 생성되며 settings.json에 저장
- 세션 간 안정적 — 캐시 파일 키로 사용
- 기존 ID 없는 설정은 마이그레이션 시 자동 생성

### 13.7 Pane 식별자 3종 (issue #256)

Pane을 가리키는 식별자는 용도가 다른 3가지가 공존한다. 혼동하지 말 것.

| 식별자 | 형식 | 용도 | 안정성 |
|---|---|---|---|
| `terminalId` | `terminal-pane-{uuid8}` | **안정 참조** — write/focus의 1차 식별자, `LX_TERMINAL_ID` env var | 세션 간 안정 |
| `paneIndex` | `WorkspacePane[]` 0-based 배열 인덱스 | **레이아웃 조작** — `focus_pane`/`split_pane`/`remove_pane`/`resize_pane`/`swap_panes` 파라미터 | split 삽입 순서에 종속 |
| `paneNumber` | 화면 읽기 순서 1..N | **표시 + 사람/AI 지칭** — 컨트롤바 배지, "N번 pane으로 보내" | 레이아웃 따라 실시간 변동 |

- `paneNumber`는 `ui/src/lib/pane-numbers.ts`의 `computePaneNumbers()` **단일 함수**에서 (y 우선, 동일 y는 x 오름차순; eps 0.01) 도출하는 **파생값**이다. 어디에도 저장/캐시하지 않으며 panes가 바뀌면 재계산된다.
- `paneIndex`(배열)와 `paneNumber`(공간)는 다를 수 있다. 예: 좌우 분할 후 왼쪽을 다시 가로 분할하면 배열은 `[좌상, 좌하, 우]`지만 읽기 순서는 `좌상=1, 우=2, 좌하=3`.
- 자동화 노출: `list_terminals`/`get_active_workspace`의 각 pane, `identify_caller`의 `pane.number`와 `neighbors.{dir}.paneNumber`, `get_grid_state`의 `focusedPaneNumber` + `panes[]` 요약(번호↔terminalId 매핑)에 포함된다.
- 번호 직접 주소 지정: `write_to_terminal`/`read_terminal_output`/`focus_terminal`는 `terminal_id` 대신 `pane_number`(+옵션 `workspace_id`)를 받을 수 있다. 브리지 `terminals.resolveByNumber`로 호출 시점에 terminalId로 해석하며, `terminal_id`가 주어지면 항상 우선한다. 번호는 휘발성이므로 지속 참조는 `terminal_id`를 쓴다.
- `paneNumber`는 spawn-time env var로 주입하지 않는다(레이아웃 변경 시 stale). 자기 번호가 필요하면 `identify_caller`의 `pane.number`를 라이브 조회한다.
- **workspace name invariant**: 신규 생성/rename 적용 시 `workspace.name`의 모든 공백류는 `-`로 치환하고 앞뒤 공백은 제거한다. 예: `"My Workspace"` → `"My-Workspace"`. 마이그레이션은 하지 않으며, 기존 데이터는 다음 rename 이후 이 규칙이 적용된다. 콜론(`:`)은 정규화하지 않으므로 이름에 남을 수 있다 — locator 파싱은 이를 고려해 마지막 `:` 기준으로 분리한다(아래).
- **배지 클릭 → 식별자 복사 (issue #276)**: 컨트롤바 `PaneNumberBadge`를 클릭하면 해당 pane의 식별자를 클립보드에 복사한다. 포맷은 `ui/src/lib/pane-numbers.ts`의 순수 함수 `formatPaneIdentifier()`가 생성하며, `lx:pane:<workspaceName>:<paneNumber>` 형태다. 예: `lx:pane:Default:1`. 이 문자열은 자동화/MCP `write_to_terminal`·`read_terminal_output`·`focus_terminal`에서 `terminal_id` 또는 `pane_ref`로 그대로 사용할 수 있다. MCP는 locator를 마지막 `:` 기준으로 분리해(`rsplit_once`) 마지막 세그먼트를 pane number, 그 앞 전체를 workspace name으로 본다(이름에 `:`가 있어도 안전). 그런 다음 workspace name을 현재 workspace 목록에서 id로 해석한 뒤 `terminals.resolveByNumber` 경로로 terminalId를 찾는다. `paneNumber`는 휘발성이므로 복사값도 시점 참조다. 배지는 `workspaceId`와 `workspaceName`이 주어진 컨트롤바 컨텍스트(PaneGrid)에서만 클릭-복사 가능하며, dock 등 번호 없는 위치에서는 비대화형 라벨로 렌더된다.

---

