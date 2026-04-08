# IDE Architecture Document
> 최종 확정본 — 2026.03.21

---

## 1. 개요

Tauri(Rust + WebView) 기반의 자유 레이아웃 IDE.
Windows 및 Linux를 지원하며, 터미널 중심의 작업 환경을 제공한다.

---

## 2. 플랫폼 및 기술 스택

| 영역 | 기술 |
|---|---|
| 프레임워크 | Tauri v2 (Rust + WebView2 / WebKitGTK) |
| 플랫폼 | Windows, Linux |
| UI | React + TypeScript |
| 스타일 | Tailwind CSS |
| 상태 관리 | Zustand |
| 터미널 | xterm.js + node-pty (Tauri sidecar) |
| 설정 | settings.json (Windows Terminal 교집합 호환) |
| IDE CLI | `lx` 바이너리 (Rust, Tauri 동봉) |

---

## 3. 레이아웃 구조

```
┌─────────────────────────────────────────┐
│               TopDock                   │
├────────┬────────────────────┬───────────┤
│        │                    │           │
│  Left  │   WorkspaceArea    │  Right    │
│  Dock  │   (Grid Layout)    │  Dock     │
│        │                    │           │
├────────┴────────────────────┴───────────┤
│              BottomDock                 │
└─────────────────────────────────────────┘
```

### 3.1 Dock

- TopDock / BottomDock / LeftDock / RightDock 4개 고정 영역
- 선택된 View 하나가 전체 영역을 채움
- Workspace 전환에 영향받지 않음 (항상 고정)
- View 전환 UI: 아이콘 사이드바 스타일

### 3.2 WorkspaceArea

- 자유 비율 그리드로 Pane 배치
- 각 Pane은 하나의 View가 전체 영역을 채움
- 선택된 Workspace에 따라 레이아웃 + View 구성 전체가 전환됨

---

## 4. Workspace & Layout 모델

Layout은 Workspace 생성 시점에만 사용된다. 생성 후 Workspace는 독립적으로 존재하며, Layout과의 영구 참조를 유지하지 않는다.

```
Layout (생성 시점에만 사용)
├── id
├── name
└── panes: [ { x, y, w, h (비율 0.0~1.0), viewType } ]

Workspace (Independent)
├── id
├── name
└── panes: [ { x, y, w, h, viewInstanceConfig } ]
```

### 4.1 Layout 액션

| 액션 | 동작 |
|---|---|
| Create from layout | Layout으로 새 Workspace 생성. 이후 연결 끊김 |
| Export as new layout | 현재 Workspace의 pane 구조를 새 Layout으로 저장 |
| Export to existing layout | 현재 Workspace의 pane 구조로 기존 Layout을 덮어쓰기 |

### 4.2 settings.json 예시

```jsonc
{
  "layouts": [
    {
      "id": "dev-split",
      "name": "Dev Split",
      "panes": [
        { "x": 0.0, "y": 0.0, "w": 1.0, "h": 0.6, "viewType": "TerminalView" },
        { "x": 0.0, "y": 0.6, "w": 0.5, "h": 0.4, "viewType": "TerminalView" },
        { "x": 0.5, "y": 0.6, "w": 0.5, "h": 0.4, "viewType": "TerminalView" }
      ]
    }
  ],
  "workspaces": [
    {
      "id": "ws-project-a",
      "name": "프로젝트A",
      "panes": [
        { "x": 0.0, "y": 0.0, "view": { "type": "TerminalView", "profile": "WSL",        "syncGroup": "ws-project-a" } },
        { "x": 0.0, "y": 0.6, "view": { "type": "TerminalView", "profile": "PowerShell", "syncGroup": "ws-project-a" } },
        { "x": 0.5, "y": 0.6, "view": { "type": "TerminalView", "profile": "PowerShell", "syncGroup": "ws-project-a" } }
      ]
    }
  ]
}
```

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

## 6. View 시스템

### 6.1 View 목록

| View | 위치 제약 | 설명 |
|---|---|---|
| `WorkspaceSelectorView` | Dock only | Workspace 목록 및 전환. cmux UI 클론 |
| `SettingsView` | Dock only (또는 모달) | 설정 화면 |
| `TerminalView` | 자유 | WSL / PowerShell 실행 |
| `MemoView` | 자유 | 간단한 텍스트 메모장. 내용은 `cache/memo.json`에 pane별로 저장 |
| `FileExplorerView` | 자유 | CWD 동기화 기반 파일 탐색기. 백그라운드 셸로 `ls` 실행, 파일 뷰어(텍스트/이미지/터미널) 지원 |
| `EmptyView` | 자유 | View 미지정 상태. 실행할 View 선택 UI |

### 6.2 EmptyView

Pane 또는 Dock에 View가 지정되지 않은 경우 표시된다.
사용 가능한 View 목록을 보여주고, 클릭하면 해당 View로 전환된다.

### 6.3 View 확장성

v1은 Built-in only. 플러그인 시스템은 추후 고려.

---

## 7. SyncGroup

터미널 간 상태(CWD, Branch 등)를 동기화하는 그룹 단위.

### 규칙

- SyncGroup은 **문자열** 하나로 식별
- 기본값: 소속 Workspace의 **ID** (자동 설정, rename에 안정적)
- 같은 syncGroup 값을 가진 모든 TerminalView가 동기화 대상
- 크로스 워크스페이스 동기화: 명시적 커스텀 syncGroup 문자열을 지정하면 Workspace를 넘나드는 동기화 가능
- 독립 터미널: `"none"` 으로 설정

```jsonc
{ "syncGroup": ""            }  // 기본값 = Workspace ID (자동)
{ "syncGroup": "shared-dev"  }  // 커스텀 그룹 (크로스 Workspace 동기화)
{ "syncGroup": "none"        }  // 독립 — 동기화 받지 않음
```

### 무한루프 방지

hook에 의해 전파된 명령은 `LX_PROPAGATED=1` 환경변수가 설정된 상태로 실행되며,
해당 플래그가 있는 경우 hook이 재발동되지 않는다.

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
- 앱 전용 분기 로직은 §15.5에 따라 격리된 모듈에 구현하고, 계산 함수에서 import하여 사용한다.

명령 텍스트는 최대 30자로 truncate, 시간은 상대 시간(방금, N분 전, N시간 전)으로 표시.

### outputActive 감지 (워크스페이스 상태 관리 원칙)

`outputActive`는 ⏳ 아이콘(우선순위 1)을 결정하는 프론트엔드 전용 상태다. **두 가지 독립된 감지 경로**가 있으며, 백엔드에서 직접 `outputActive`를 계산하지 않는다.

| 감지 경로 | 대상 | 신호 | 동작 |
|---|---|---|---|
| OSC 133 C/D | 셸 명령 (pytest, apt 등) | preexec → precmd lifecycle | `commandRunning` → `outputActive` |
| DEC 2026h | TUI 앱 (Claude Code, neovim 등) | `\x1b[?2026h` (동기화 렌더 시작) | Rust PTY 콜백에서 감지 → `terminal-output-activity` 이벤트 |
| 타이틀 스피너 | TUI 앱 thinking 단계 (§15.5) | OSC 0/2 타이틀 스피너 회전 | Rust PTY 콜백에서 `now_working` 감지 → `terminal-output-activity` 이벤트 |

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

설계 원칙: `Ctrl+단일키`는 셸(readline, vim 등)에 양보한다. IDE 단축키는 `Ctrl+Shift`, `Ctrl+Alt`, `Alt+Arrow` 조합만 사용한다. Windows Terminal 키바인딩과 최대한 일치시킨다.

| 단축키 | 동작 |
|---|---|
| `Ctrl+Alt+1~8` | 워크스페이스 1~8 이동 |
| `Ctrl+Alt+9` | 마지막 워크스페이스 |
| `Ctrl+Alt+↓` / `Ctrl+Alt+↑` | 다음 / 이전 워크스페이스 |
| `Ctrl+Shift+W` | 워크스페이스 닫기 |
| `Ctrl+Shift+R` | 워크스페이스 이름 변경 |
| `Ctrl+Shift+B` | 사이드바 토글 |
| `Ctrl+Shift+I` | 알림 패널 토글 |
| `Ctrl+Shift+U` | 가장 최근 읽지 않은 알림으로 이동 |
| `Ctrl+Alt+←` | 최근 알림 발생 Pane으로 이동 (알림 소비) |
| `Ctrl+Alt+→` | 오래된 알림 발생 Pane으로 이동 (알림 소비) |
| `Ctrl+,` | 설정 모달 토글 |
| `Alt+Arrow` | Pane 포커스 이동 (상하좌우) |
| `Delete` | 편집 모드에서 포커스된 Pane 제거 |

---

## 10. Settings

### 접근 방법

- 모달로 열기 (기본)
- SettingsView를 Dock에 배치하여 열기 (선택, Dock only)
- `settings.json` 직접 텍스트 편집

### Windows Terminal 호환 항목

| 항목 | 설명 |
|---|---|
| `colorSchemes` | 색상 스킴 정의 |
| `profiles` | 터미널 프로파일 (WSL, PowerShell 등) |
| `keybindings` | 키 바인딩 |
| `font.face` / `font.size` | 폰트 설정 (프로파일별 오버라이드, profileDefaults에서 상속) |
| `defaultProfile` | 기본 프로파일 |

우리가 구현한 기능과 교집합이 되는 항목만 호환. Windows Terminal의 settings.json을 복붙했을 때 해당 항목은 동일하게 동작한다.

### Claude Code 설정

Claude Code가 터미널에서 실행 중일 때 sync-cwd 전파를 제어한다.

```jsonc
{
  "claude": {
    "syncCwd": "skip"  // "skip" (기본) | "command"
  }
}
```

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
    "workspace": { "send": true, "receive": true },   // 기본값
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
  "version": "0.1.0",
  "key": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  // Bearer token (매 시작마다 재생성)
}
```

### 12.3 엔드포인트

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
| GET | `/api/v1/notifications` | 알림 목록 |
| GET | `/api/v1/layouts` | 레이아웃 목록 |
| POST | `/api/v1/screenshot` | 스크린샷 캡처 → `.screenshots/`에 저장 |

### 12.4 터미널 출력 버퍼

- 터미널별 1MB 링 버퍼 (AppState에 저장)
- PTY 리더 스레드에서 자동 수집
- `close_terminal_session` 시 자동 정리
- `GET /api/v1/terminals/:id/output?lines=100`으로 조회

### 12.5 스크린샷

- `POST /api/v1/screenshot` → 프론트엔드 `html2canvas`로 DOM 캡처
- `.screenshots/` 디렉터리에 `screenshot_{timestamp}.png`로 저장
- 응답: `{ "path": ".../.screenshots/screenshot_xxx.png", "size": 12345 }`
- `.screenshots/*.png`는 `.gitignore`에 의해 버전 관리 제외

### 12.6 보안

- `0.0.0.0` 바인딩 (WSL2에서 Windows 호스트 접근 허용)
- Bearer token 인증: 시작 시 랜덤 UUID 키 생성 → discovery 파일에 기록 → 모든 API 요청에 `Authorization: Bearer <key>` 필수
- `GET /api/v1/health`만 인증 없이 접근 가능
- 키는 매 시작마다 재생성되어 인스턴스 간 혼선 방지

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

### 13.6 Workspace Pane ID

- Pane ID는 `pane-{uuid8}` 형식으로 생성되며 settings.json에 저장
- 세션 간 안정적 — 캐시 파일 키로 사용
- 기존 ID 없는 설정은 마이그레이션 시 자동 생성

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
├── claude_bullet.rs          # Claude Code 상태 메시지 추출 + ANSI 스트리핑
├── state.rs                  # AppState — 전역 상태
├── commands/                 # Tauri IPC 커맨드 (프론트엔드 진입점)
│   ├── mod.rs                # pub use 허브 (로직 없음)
│   ├── terminal.rs           # 터미널 생명주기 (create/close/resize/write)
│   ├── ipc_dispatch.rs       # LX CLI 메시지 라우팅 + CWD 동기화
│   ├── claude_session.rs     # Claude Code 세션 감지 + 프로세스 트리
│   ├── file_ops.rs           # 파일 뷰어, 디렉토리 목록
│   └── misc.rs               # 설정, 알림, 클립보드, GitHub, 캐시 등
├── settings/                 # 설정 관리
│   ├── mod.rs                # pub use 허브
│   ├── models.rs             # 구조체/enum 정의
│   ├── io.rs                 # 로드/세이브, 경로 해석
│   ├── migration.rs          # 설정 마이그레이션
│   └── memo.rs               # 메모 시스템
├── automation_server/        # Automation HTTP API (axum)
│   ├── mod.rs                # 서버 시작, 라우터 빌드, 인증 미들웨어
│   ├── types.rs              # 요청/응답 타입, REGISTERED_ROUTES
│   ├── handlers_backend.rs   # 백엔드 직접 처리 핸들러
│   ├── handlers_bridge.rs    # 프론트엔드 브릿지 핸들러
│   └── helpers.rs            # bridge_request, JSON 응답 헬퍼
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
1. terminals → 2. output_buffers → 3. known_claude_terminals →
4. notifications → 5. sync_groups → 6. propagated_terminals →
7. pty_handles / automation_channels / automation_port / ipc_socket_path
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

### 15.5 앱 전용 편의 코드 격리

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
- 설정 플래그(`claude.enhancedStatus` 등)로 핸들러를 default로 폴백시킬 수 있다.
