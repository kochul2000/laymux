# 아키텍처 — 개요 (구조 · 모델)

> **이 문서는 living doc 이다.** HEAD 의 현재 구조를 반영하며, 코드 변경이 서술과 어긋나면 **같은 PR 에서** 갱신한다.
> "왜 그렇게 정했나" 의 불변 기록은 [ADR](../adr/), 런타임 흐름은 [data-flow.md](./data-flow.md), 설정·REST·MCP 계약과 코드 설계 원칙은 [api-contracts.md](./api-contracts.md) 를 본다.
>
> **이 문서가 담는 범위** — laymux 의 구조와 정적 모델: 개요 · 기술 스택 · 레이아웃 · Workspace/Layout 모델 · View 시스템 · SyncGroup.
> 섹션 번호(§1·§2·§3·§4·§6·§7)는 구 `ARCHITECTURE.md` 기준을 보존한다. 빠진 번호(§5·§8 등)는 다른 living doc 으로 이동한 섹션이다.

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
- **Lazy mount**: 한 번이라도 활성화된 워크스페이스만 마운트되며, 비활성 워크스페이스는 `display: none`으로 유지된다(PTY/WebGL 보존).

#### Terminal startup coordinator (흰 화면 방지)

여러 `TerminalView`가 한꺼번에 마운트되면 `terminal.open()`·PTY 생성·canvas 초기화가 겹쳐 메인 스레드와 GPU에 순간 부하를 만들고, pane 콘텐츠가 자기 배경을 칠하기 전에 빈 영역이 노출될 수 있다. `AppLayout`에서 한 번 구동하는 전역 시작 조정기가 활성 워크스페이스, 보이는 dock, terminal-backed FileViewer overlay를 함께 직렬화한다([ADR-0043](../adr/0043-global-terminal-ready-startup-slot.md)).

- **흰색 backstop**: `PaneGrid` 의 위치 지정 pane `<div>` 는 항상 `background: var(--bg-base)` 를 가진다. 콘텐츠 마운트 전에도 어두운 배경 → 흰 번쩍임 없음.
- **전역 단일 슬롯**: `useTerminalStartupCoordinator`가 workspace·dock의 terminal pane과 terminal-backed FileViewer를 `terminal-startup-store` 한 곳에서 조정한다. 시작 슬롯을 받은 terminal 하나만 `ViewRenderer`/`TerminalView`를 마운트하고 나머지는 `PaneLoadingPlaceholder`를 렌더한다. non-terminal view는 즉시 마운트한다.
- **준비 완료 경계**: 슬롯은 backend `createTerminalSession` 성공과 xterm 첫 `onRender`가 모두 관측된 뒤 다음 terminal로 넘어간다. 생성 실패는 즉시 다음 슬롯을 열고, 어느 한 신호가 오지 않는 결함에는 10초 watchdog이 liveness를 보장한다. 슬롯을 받은 terminal은 계속 마운트하며(add-only), focus나 workspace 전환으로 진행 중 시작을 선점하지 않는다.
- **대상과 우선순위**: 활성 workspace, visible dock, 현재 열린 terminal-backed FileViewer가 새 시작 후보가 된다. Automation 요청 → 전경 FileViewer terminal → 현재 focused pane terminal → 활성 workspace 배열 순서 → visible dock 순서로 대기열을 계산한다. 비활성 workspace와 숨은 dock은 보류하지만 이미 시작한 PTY는 기존 lazy-mount/persist 정책에 따라 유지한다. `prefers-reduced-motion`은 spinner 애니메이션만 멈추며 리소스 안전 경계인 직렬화는 우회하지 않는다.
- **Automation 대기**: 아직 마운트되지 않은 deterministic terminal id도 layout에서 찾아 요청 우선순위를 올린다. 비활성 workspace 대상이면 세션 생성 동안 활성화한 뒤 원래 workspace로 복원하며, focus/write 응답은 PTY 등록을 최대 20초 기다린다. 요청은 진행 중 슬롯을 선점하거나 동시 시작시키지 않는다.
- **WebGL 예약 타임라인**: 기존 전역 150ms WebGL 예약 간격은 별도 2차 안전장치로 유지한다. 시작 슬롯은 PTY+xterm 준비를, WebGL 타임라인은 GPU context 생성 간격을 각각 책임진다.

#### 숨김 터미널 자동 종료 (issue #269)

WorkspaceSelectorView의 평상시 목록에서 quick-hide한 워크스페이스, 또는 pane 컨트롤바 토글로 숨긴 Pane이 일정 시간 이상 계속 숨겨져 있으면 해당 터미널(PTY)을 자동 종료하여 메모리/CPU를 절약한다. 숨긴 workspace는 목록 헤더의 유효 개수 chip 아래 보관함에서, 숨긴 Pane은 해당 pane 컨트롤바 토글로 복원한다([ADR-0033](../adr/0033-hidden-items-shelf-set-contract.md), [ADR-0035](../adr/0035-workspace-only-shelf-per-pane-hide-toggle.md)).

- **설정**: `workspaceSelector.hiddenAutoCloseSeconds`(초, `0` = 비활성화). Rust `WorkspaceSelectorSettings`와 프론트 settings-store 양쪽에 존재하며 `settings.json`에 영구 저장된다.
- **판정/타이머**: `lib/hidden-auto-close.ts`의 순수 함수(`computeHiddenPaneIds`, `advanceHiddenTimers`)가 "현재 숨김인 Pane"과 "타임아웃 경과 여부"를 계산한다. **활성 워크스페이스의 Pane은 절대 종료 대상이 아니다.**
- **오케스트레이션**: `useHiddenTerminalAutoClose` 훅(AppLayout에서 1회 구동)이 hidden/active/settings raw state 변경을 즉시 평가하고, 5초 interval은 타임아웃 만료 판정에만 사용한다. 타임아웃이 지난 Pane id는 `uiStore.evictedPaneIds`에 기록하며 비활성화(`0`) 시 타이머와 기존 eviction을 즉시 클리어한다.
- **정밀도**: 숨김 시작·해제 stamp는 raw state 전환을 구독해 즉시 기록·초기화한다. 만료 판정만 5초(`TICK_INTERVAL_MS`) tick 경계에서 수행하므로 실제 종료 시점은 설정한 타임아웃보다 최대 ~1틱(약 5초) 늦을 수 있다(리소스 절약이 목적이라 지연 자체는 무해). 또한 `Date.now()` 벽시계 기준이므로 시스템 절전→복귀 시 숨김 경과 시간을 한꺼번에 인식해 복귀 직후 evict될 수 있다(역시 의도된 동작).
- **실제 종료 경로**: WorkspaceArea는 비활성 워크스페이스에서 `evictedPaneIds`에 포함된 Pane을 렌더 목록에서 제외한다 → 해당 `TerminalView`가 언마운트되며 기존 언마운트 클린업(`closeTerminalSession`)이 PTY를 정리한다. 다시 표시(un-hide)하면 eviction에서 빠지고 재마운트되어 새 PTY가 생성된다. 별도의 종료 IPC를 추가하지 않고 검증된 unmount→close 경로를 재사용한다.

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

### 4.2 인스턴스 오버라이드 레이어 (Pane / View)

사용자 구성(`settings.json`)과 UI 상태(localStorage)를 엄격히 분리한다.

- **구성 (settings.json)**: 사용자가 의도적으로 편집·유지하는 값. 프로파일, ProfileDefaults, 키바인딩, 워크스페이스 레이아웃(pane 위치/view 타입) 등.
- **UI 상태 (localStorage)**: 재시작 간 보존되지만 "구성"은 아닌 값. 휠 줌, 컨트롤 바 모드 등. 사용자가 설정 UI를 거치지 않고 즉흥적으로 바꾸는 값은 대부분 여기에 속한다.

이 구분 아래 두 개의 일급 오버라이드 공간을 둔다. 둘 다 `useOverridesStore`(`ui/src/stores/overrides-store.ts`)에서 관리.

#### 해석 계층 (낮음 → 높음 우선)

```
글로벌:    profileDefaults              (settings.json)
프로파일:  profile.<field>              (settings.json, INHERITABLE_KEYS만 오버라이드 가능)
Pane:     paneOverrides[paneId]        (localStorage: "laymux-pane-overrides")
View:     viewOverrides[paneId]        (localStorage: "laymux-view-overrides")
```

#### Pane 인스턴스 오버라이드 (`paneOverrides`)

**의미론**: 레이아웃 슬롯 자체에 귀속. 슬롯 안에 어떤 view가 들어있든 무관하게 유지.

| 필드 | 타입 | 설명 |
|---|---|---|
| `controlBarMode` | `"hover" \| "pinned" \| "minimized"` | 해당 pane의 컨트롤 바 표시 모드. `settings.controlBar.defaultMode`를 개별 덮어쓰기. |

> `controlBar.defaultMode` 는 Rust `ControlBarSettings`(`settings/models.rs`) + 프론트 settings-store 양쪽에 존재하며 `settings.json` 에 영속된다. pane 단위 `paneOverrides` 는 localStorage 로 유지되어 이를 개별 덮어쓴다.

#### View 인스턴스 오버라이드 (`viewOverrides`)

**의미론**: 슬롯 내 콘텐츠(view)에 귀속. view 타입이 바뀌면 의미가 사라지므로 자동 리셋.

| 필드 | 타입 | 적용 view | 설명 |
|---|---|---|---|
| `fontSize` | `number` | `TerminalView` · `MemoView` | 줌 키바인딩으로 조정되는 폰트 크기. TerminalView 는 `terminal.zoomIn/zoomOut/zoomReset`, MemoView 는 `memo.zoomIn/zoomOut/zoomReset` (둘 다 기본 `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, 포커스된 view 타입에 따라 분기). `zoomReset` 은 override 를 제거해 기본값 체인으로 복귀 — TerminalView 는 `profile → profileDefaults` 폰트의 `size` 만 덮어쓰고(face/weight 유지), MemoView 는 `settings.memo.fontSize → appearance.font.size` 체인 위에 덮어쓴다. 범위 6–72. |

#### 생명주기

- **Pane 삭제 시** (`workspace-store.removePane`, `dock-store.removeDockPane`, `workspace-store.removeWorkspace`):
  `overridesStore.clearAll(paneId)` — pane/view 오버라이드 동시 제거.
- **View 타입 전환 시** (`workspace-store.setPaneView`, `dock-store.setDockPaneView`):
  새 view.type ≠ 이전 view.type이면 `overridesStore.clearViewOverride(paneId)`. pane 오버라이드는 유지.
- **앱 기동 시** (`useSessionPersistence`):
  워크스페이스/독 복원 완료 후 살아있는 paneId 집합을 만들어 `overridesStore.gcStale(aliveSet)` — 과거 세션의 stale 엔트리 제거.

#### 새 필드 추가 가이드

"사용자가 설정 UI 없이 직접 조작해 즉흥적으로 바꾸는 값"이면 오버라이드 레이어 후보다. 다음 질문 순서로 결정:

1. 슬롯 속성인가, 콘텐츠 속성인가? → `PaneOverrides` vs `ViewOverrides`
2. 설정 UI에도 기본값이 있는가? → 있으면 해석 체인에 기본값 경로를 둔다 (`settings → override`).
3. View 타입 전환 시 초기화돼야 하는가? → 그렇다면 `ViewOverrides` 쪽.

`ViewOverrides`에 추가하는 필드는 특정 view 타입에만 의미 있을 수 있다. 현재 필드는 `fontSize` 하나이며 TerminalView·MemoView 가 각자의 기본값 체인 위에서 공유한다. 향후 view 전용 필드가 추가돼도 동일 슬롯에 공존한다 — view 타입이 바뀌면 전부 리셋되므로 충돌 없음.

### 4.3 settings.json 예시

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

## 6. View 시스템

### 6.1 View 목록

| View | 위치 제약 | 설명 |
|---|---|---|
| `WorkspaceSelectorView` | Dock only | Workspace 목록 및 전환. cmux UI 클론 |
| `SettingsView` | Dock only (또는 모달) | 설정 화면 |
| `TerminalView` | 자유 | WSL / PowerShell 실행. xterm 직접 입력과 분리된 native textarea composer를 terminal별로 토글 |
| `MemoView` | 자유 | 간단한 텍스트 메모장. 내용은 `cache/memo.json`에 pane별로 저장 |
| `FileExplorerView` | 자유 | CWD 동기화 기반 파일 탐색기. Rust `list_directory`로 디렉터리 나열, 편집 가능한 주소창(경로 직접 입력/붙여넣기 → `stat_path`로 검증 후 디렉터리 이동 또는 파일이면 부모 이동+통합 뷰어 open, #278), 파일 뷰어(텍스트/이미지/HTML·Markdown preview/source/터미널) 지원. `.html`·`.md`는 기본 preview와 source 토글을 제공하되, `extensionViewers`에 해당 확장자·command·profile 매핑이 있으면 그 명시적 터미널 프로필의 외부 뷰어를 우선한다(#404/#446, [ADR-0031](../adr/0031-extension-viewer-profile-path-conversion.md)). Remote Focused UI는 현재 데스크톱 viewer 파일 또는 직접 입력한 호스트 경로를 active lease와 claim 전용 FileViewer capability로 읽어 별도 브라우저 탭의 안전한 웹 renderer로 표시한다([ADR-0041](../adr/0041-remote-served-file-viewer.md), [ADR-0042](../adr/0042-remote-file-viewer-secret-capability.md)). |
| `IssueReporterView` | 자유 | GitHub 이슈 리포터. 제출은 `issueReporter.submit` 키바인딩(기본 `Ctrl+Enter`) |
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
