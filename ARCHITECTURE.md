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
| 브라우저 미리보기 | WebView2 (Windows) / WebKitGTK (Linux) — 플랫폼 자동 선택 |
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
        { "x": 0.5, "y": 0.6, "w": 0.5, "h": 0.4, "viewType": "BrowserPreviewView" }
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
        { "x": 0.5, "y": 0.6, "view": { "type": "BrowserPreviewView", "url": "http://localhost:3000" } }
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
| `BrowserPreviewView` | 자유 | 브라우저 미리보기 (WebView) |
| `MemoView` | 자유 | 간단한 텍스트 메모장. 내용은 `cache/memo.json`에 pane별로 저장 |
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

### 8.3 OSC Hook

OSC hook은 TerminalView 인스턴스별로 설정한다.

```jsonc
{
  "view": "TerminalView",
  "profile": "WSL",
  "syncGroup": "프로젝트A",
  "hooks": [
    {
      // OSC 7: CWD 변경 → 그룹 동기화
      "osc": 7,
      "run": "lx sync-cwd $path"
    },
    {
      // OSC 133 D: 명령 종료 → 실패 시 알림
      "osc": 133,
      "param": "D",
      "when": "exitCode !== '0'",
      "run": "lx notify '명령 실패 (exit $exitCode)'"
    },
    {
      // OSC 133 E: 실행된 명령 감지 → git switch 시 브랜치 동기화
      "osc": 133,
      "param": "E",
      "when": "command.startsWith('git switch') || command.startsWith('git checkout')",
      "run": "lx sync-branch $(git branch --show-current)"
    }
  ]
}
```

**OSC Preset 목록**

| Preset | OSC | 동작 |
|---|---|---|
| `sync-cwd` | OSC 7 | 그룹 내 터미널 CWD 동기화 |
| `sync-branch` | OSC 133 E (git 명령 감지) | 그룹 내 터미널 브랜치 동기화 |
| `notify-on-fail` | OSC 133 D (exitCode ≠ 0) | 실패 알림 |
| `notify-on-complete` | OSC 133 D (exitCode = 0) | 성공 완료 알림 |
| `set-title-cwd` | OSC 7 | 탭 제목을 CWD로 변경 |
| `track-command` | OSC 133 E | 실행된 명령을 워크스페이스 요약에 기록 |
| `track-command-result` | OSC 133 D | 명령 종료 코드를 워크스페이스 요약에 기록 |

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

### 마지막 명령 표시

| 상태 | 아이콘 | 색상 |
|---|---|---|
| 실행 중 (`exitCode` 없음) | ⏳ | 노랑 |
| 성공 (`exitCode === 0`) | ✓ | 초록 |
| 실패 (`exitCode !== 0`) | ✗ | 빨강 |

명령 텍스트는 최대 30자로 truncate, 시간은 상대 시간(방금, N분 전, N시간 전)으로 표시.

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

**감지 방식**:
- Claude Code는 터미널 타이틀에 "Claude Code" 문자열을 설정
- 유휴 상태: 타이틀이 `✳` (U+2733) 접두어로 시작
- 작업 중: 스피너 문자(✶✻✽✢ 등) 접두어

**`! cd` 형식**: Claude Code는 프롬프트에서 `! <shell_command>` 구문으로 인라인 셸 실행을 지원. `command` 모드에서는 이 형식으로 cd를 전달하며, `LX_PROPAGATED` 래핑이 불필요하다.

---

## 11. 전체 데이터 흐름 요약

```
[Shell: cd /foo]
    │  chpwd hook → printf '\e]7;file://localhost/foo\a'
    ▼
[TerminalView: PTY 수신]
    │  OSC 7 파싱 → hook 매칭 → run: "lx sync-cwd /foo"
    ▼
[lx 바이너리]
    │  LX_SOCKET 경유 → IDE 본체에 JSON 전달
    ▼
[IDE: Terminal Manager]
    │  syncGroup 조회 → 대상 터미널 필터링
    │  LX_PROPAGATED=1 플래그 설정 (루프 방지)
    ▼
[대상 TerminalView PTY들]
    │  " cd /foo\n" write (히스토리 제외)
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

### 12.2 포트 디스커버리

- **Windows**: `%APPDATA%\laymux\automation.json`
- **Linux**: `~/.config/laymux/automation.json`
- 환경변수: `LX_AUTOMATION_PORT` (터미널 spawn 시 자동 주입)

```jsonc
{
  "port": 19280,
  "pid": 12345,
  "version": "0.1.0"
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

- `127.0.0.1` only 바인딩 (외부 접근 불가)
- v1: 인증 없음 (로컬 전용)
- 추후: 디스커버리 파일에 bearer token 포함 가능

---

## 13. Session Persistence & Cache

### 13.1 개요

앱 재시작 시 터미널의 이전 출력과 CWD를 복원한다. 프로파일 단위로 제어한다.

### 13.2 캐시 디렉터리

```
~/.config/laymux/          (Linux)
%APPDATA%/laymux/          (Windows)
├── settings.json
└── cache/
    ├── memo.json
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
