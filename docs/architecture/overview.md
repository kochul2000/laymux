# 아키텍처 — 개요 (구조 · 모델)

> **이 문서는 living doc 이다.** HEAD 의 현재 구조를 반영하며, 코드 변경이 서술과 어긋나면 **같은 PR 에서** 갱신한다.
> "왜 그렇게 정했나" 의 불변 기록은 [ADR](../adr/), 런타임 흐름은 [data-flow.md](./data-flow.md), 설정·REST·MCP 계약과 코드 설계 원칙은 [api-contracts.md](./api-contracts.md) 를 본다.
>
> **이 문서가 담는 범위** — laymux 의 구조와 정적 모델: 개요 · 기술 스택 · 레이아웃 · Workspace/Layout 모델 · View 시스템 · SyncGroup.
> 섹션 번호(§1·§2·§3·§4·§6·§7)는 구 `ARCHITECTURE.md` 기준을 보존한다. 빠진 번호(§5·§8 등)는 다른 living doc 으로 이동한 섹션이다.

---
## 1. 개요

Tauri(Rust + WebView) 기반의 자유 레이아웃 IDE.
Windows 및 Linux 데스크톱을 지원하며, 터미널 중심의 작업 환경을 제공한다. Android는
데스크톱 backend를 이식하지 않고 원격 E2E 연결을 위한 독립 하이브리드 클라이언트를
같은 리포의 `apps/android`에서 개발한다([ADR-0144](../adr/0144-android-signed-hybrid-client-e2e-foundation.md)).

---

## 2. 플랫폼 및 기술 스택

| 영역 | 기술 |
|---|---|
| 프레임워크 | Tauri v2 (Rust + WebView2 / WebKitGTK) |
| 데스크톱 플랫폼 | Windows, Linux |
| Android 원격 클라이언트 | Kotlin 네이티브 셸 + APK 내장 WebView 자산 (`apps/android`) |
| 네이티브 대화상자 | `rfd 0.15.4`; Windows native backend / Linux GTK3 backend |
| UI | React + TypeScript |
| 스타일 | Tailwind CSS |
| 상태 관리 | Zustand |
| 터미널 | xterm.js + node-pty (Tauri sidecar) |
| 설정 | settings.json (Windows Terminal 교집합 호환) |
| IDE CLI | `lx` 바이너리 (Rust, Tauri 동봉) |

Linux의 `rfd`는 default feature를 끄고 `gtk3` backend만 target dependency로
활성화한다([ADR-0090](../adr/0090-linux-native-dialog-gtk3-backend.md)). 현재 사용처는
crash reporter의 `MessageDialog`이며, headless test에서는 대화상자를 열지 않는다.
GTK3 개발·런타임 라이브러리는 Tauri/WebKitGTK의 기존 Linux prerequisite를 그대로
재사용한다. Windows dependency에는 Linux backend feature를 전달하지 않는다.

Android 앱은 Cargo/Tauri workspace 구성원이 아니다. QR·Keystore·향후 암호화 transport는
Kotlin 계층이 소유하고, 표시 UI는 `WebViewAssetLoader`의 로컬 HTTPS origin에서 APK 내장
자산만 실행한다. 서버가 제공하는 `/remote/` 문서나 외부 script를 WebView에 적재하지 않는다.
pairing seed wrapping key는 기본적으로 강한 생체 인증을 암호 연산마다 요구하며, 명시적으로
끄는 경우에만 별도 Keystore-only key를 사용한다. 상태 UI는 비밀이 아닌 pairing metadata만
읽으므로 앱을 열거나 상태를 표시할 때는 생체 인증을 띄우지 않는다.
데스크톱 Remote Access 모달은 cloud identity에 결합된 seed를 Rust에서 만들고 OS keyring에
보관한 뒤 5분짜리 QR SVG만 표시한다. Android는 seed로 서명한 ACK를 cloud public origin의
고정 relay route로 보내고, relay는 이를 해당 instance의 기존 WSS tunnel과 고정 desktop route로만
전달한다. desktop은 첫 client nonce 하나를 확정하고 상호 HMAC proof를 반환한다
([ADR-0145](../adr/0145-android-pairing-authenticated-one-time-ack.md)). 새 발급은 기존 seed를
회전하고 명시적 폐기와 cloud disconnect는 record를 삭제한다. 이 단계는 pairing confirmation까지며
Android 셸은 terminal data plane에 아직 연결되지 않았다. 기존 브라우저 Remote UI API도
별도로 평문 payload를 사용하므로 E2E 완료 상태가 아니다.

---

## 3. 레이아웃 구조

```
┌─────────────────────────────────────────┐
│  GridEditToolbar (위젯 슬롯 좌/우 포함)  │
├─────────────────────────────────────────┤
│               TopDock                   │
├────────┬────────────────────┬───────────┤
│        │                    │           │
│  Left  │   WorkspaceArea    │  Right    │
│  Dock  │   (Grid Layout)    │  Dock     │
│        │                    │           │
├────────┴────────────────────┴───────────┤
│              BottomDock                 │
├─────────────────────────────────────────┤
│  StatusLine (선택, dock 격자 바깥 최하단) │
└─────────────────────────────────────────┘
```

`GridEditToolbar` 와 `StatusLine` 은 dock 격자 바깥에 있는 **위젯 슬롯 영역**이다([ADR-0105](../adr/0105-widget-slots-and-status-line.md)). StatusLine 은 격자 다음 형제로 렌더되므로 BottomDock 보다 아래에 창 전체 폭으로 놓이며, dock 의 분할·포커스·리사이즈 계약을 상속하지 않는다. 표시 여부는 `widgets.statusLine.enabled` 가 정한다.

`GridEditToolbar` 우측 클러스터에는 위젯이 아닌 액션 버튼도 놓인다 — 파일 뷰어, 절전 방지 토글([ADR-0114](../adr/0114-sleep-prevention-mode.md)), Remote Access, 설정. 위젯은 알리고 이 버튼들은 동작시킨다. 그 오른쪽 끝의 창 버튼(최소화·최대화·닫기)은 상단 바의 다른 모든 점유자보다 우선하며 어떤 창 폭에서도 온전히 남는다 — 좌·우 크롬 클러스터가 화면 가장자리에서 먼 쪽부터 잘려 자리를 내준다([ADR-0123](../adr/0123-top-bar-window-controls-outrank-everything.md)).

원격 클라이언트는 이 두 표면을 header 아래 한 줄 스트립으로 접어 미러한다([ADR-0124](../adr/0124-remote-widget-strip-mirrors-desktop.md)). 데스크톱이 그리고 있는 위젯만 나타나고 배치·값은 모두 데스크톱이 소유하며, 원격은 `/remote/v1/widgets` 가 준 표시 모델을 그리기만 한다.

두 표면의 위젯은 `widgets.fontFamily`·`fontSize`를 공용으로 적용한다. 사용량 위젯의 막대 너비는 배치 인스턴스의 `options.barWidth`가 소유하며, 실제 track과 슬롯 접힘용 요구 폭이 같은 값에서 계산된다([ADR-0107](../adr/0107-widget-typography-and-usage-bar-width.md)).

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
- **준비 완료 경계**: 슬롯은 backend `createTerminalSession` 성공과 xterm 첫 `onRender`가 모두 관측된 뒤 다음 terminal로 넘어간다. 생성 실패는 즉시 다음 슬롯을 열고, 어느 한 신호가 오지 않는 결함에는 10초 watchdog이 liveness를 보장한다. 준비 전 slot owner가 workspace 전환·dock 숨김 등으로 현재 후보 eligibility를 잃으면 같은 상태 전이에서 즉시 다음 eligible terminal로 slot을 넘긴다. 이전 terminal은 reveal 집합에 남고 늦은 settle은 현재 slot을 바꾸지 않는다([ADR-0127](../adr/0127-terminal-startup-slot-follows-eligibility.md)).
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

### 4.1.1 터미널 클리어

| 동작                | 진입점                                                                                                                 | 범위                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 워크스페이스 클리어 | `Ctrl+Alt+L`(`workspace.clearTerminals`), WorkspaceSelectorView 행의 빗자루 버튼, `POST /api/v1/workspaces/{id}/clear` | 그 워크스페이스 **격자**의 `TerminalView` pane 전부. Dock 은 제외 ([ADR-0137](../adr/0137-workspace-clear-ctrl-l-broadcast.md)) |

pane 마다 `Ctrl+L`(`\x0c`) 하나를 그대로 브로드캐스트한다 — activity 판정도, 설정도 없다. 세션이 아직 없는 pane(`notReady`)만 건너뛰고, 작업 중인 pane 에도 그대로 보낸다(Ctrl+L 은 언제 보내도 안전하다). 실행은 `ui/src/lib/workspace-clear.ts` 의 `clearWorkspace()` 한 함수다.

이전에는 이 동작이 pane 의 activity handler 에게 "무엇을 칠지"(`clear`/`/clear`)와 "작업 중이면 어떻게 할지"(`settings.workspaceClear.busyPolicy`: skip/interrupt/restart)를 물었고, 포커스된 pane 하나만 지우는 `Alt+L`(`pane.clearTerminal`) 단축키도 따로 있었다. 둘 다 [ADR-0137](../adr/0137-workspace-clear-ctrl-l-broadcast.md) 로 폐기됐다 — `Alt+L` 은 포커스된 pane 에서 그냥 `Ctrl+L` 을 누르는 것과 동일해 무의미했고, activity 판정은 `Ctrl+L` 이 애초에 안전한 입력이라 불필요했다.

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
| `githubTab` | `"issues" \| "pulls"` | `GitHubView` | 헤더에서 마지막으로 고른 목록 탭. 없을 때만 `settings.github.defaultTab` 이 씨앗값으로 읽히며, 한 번 고른 pane 은 이후 `defaultTab` 변경에 따라 움직이지 않는다. `paneId` 없이 렌더된 인스턴스는 보존하지 않는다 ([ADR-0115](../adr/0115-github-view-tab-per-pane-state.md)). |
| `fontSize` | `number` | `TerminalView` · `MemoView` · `FileViewer` | TerminalView·MemoView는 줌 키바인딩(`terminal.zoomIn/zoomOut/zoomReset`, `memo.zoomIn/zoomOut/zoomReset`, 둘 다 기본 `Ctrl+=` / `Ctrl+-` / `Ctrl+0`)으로 조정하고, FileViewer는 뷰어 안 Ctrl+Wheel 또는 툴바 A−/A+ 버튼으로 조정한다(리셋 바인딩 없음 — 재조정으로 되돌린다). 기본값 체인: TerminalView 는 `profile → profileDefaults` 폰트의 `size` 만 덮어쓰고(face/weight 유지), MemoView 는 `settings.memo.fontSize → appearance.font.size`, FileViewer 는 `settings.viewer.fontSize → appearance.font.size` 위에 덮어쓴다. 범위 6–72 (FileViewer 는 `FONT_ZOOM_MIN/MAX` 공유). |
| `imageZoom` | `number` (%) | `FileViewer` | 이미지(SVG preview 모드 포함)를 뷰어 안 Ctrl+Wheel 또는 툴바 −/+ 버튼으로 확대·축소한 값. 대응하는 설정 기본값은 없다 — 사진마다 "기본 줌" 개념이 없어 항상 100 이 시작값이다. 범위 25–400, 스텝 25(`IMAGE_ZOOM_MIN/MAX/STEP`). |

#### 생명주기

- **Pane 삭제 시** (`workspace-store.removePane`, `dock-store.removeDockPane`, `workspace-store.removeWorkspace`):
  `overridesStore.clearAll(paneId)` — pane/view 오버라이드 동시 제거.
- **View 타입 전환 시** (`workspace-store.setPaneView`, `dock-store.setDockPaneView`):
  새 view.type ≠ 이전 view.type이면 `overridesStore.clearViewOverride(paneId)`. pane 오버라이드는 유지.
- **앱 기동 시** (`useSessionPersistence`):
  워크스페이스/독 복원 완료 후 살아있는 paneId 집합을 만들어 `overridesStore.gcStale(aliveSet)` — 과거 세션의 stale 엔트리 제거.
  - **예외 — FileViewer**: `viewOverrides`의 키가 워크스페이스/dock pane id 가 아니라 파일 경로에서 파생된 `viewerInstanceId`(`global-file-viewer:` 접두사, `lib/file-viewer.ts`)인 항목은 이 GC에서 제외한다. 파일 뷰어는 열려 있을 때만 존재해 애초에 `aliveSet`에 나타날 수 없으므로, 예외가 없으면 재시작마다 사용자가 조정한 폰트/이미지 줌이 전부 삭제된다.

#### 새 필드 추가 가이드

"사용자가 설정 UI 없이 직접 조작해 즉흥적으로 바꾸는 값"이면 오버라이드 레이어 후보다. 다음 질문 순서로 결정:

1. 슬롯 속성인가, 콘텐츠 속성인가? → `PaneOverrides` vs `ViewOverrides`
2. 설정 UI에도 기본값이 있는가? → 있으면 해석 체인에 기본값 경로를 둔다 (`settings → override`).
3. View 타입 전환 시 초기화돼야 하는가? → 그렇다면 `ViewOverrides` 쪽.

`ViewOverrides`에 추가하는 필드는 특정 view 타입에만 의미 있을 수 있다. `fontSize` 는 TerminalView·MemoView 가 각자의 기본값 체인 위에서 공유하고, `usageLayout` 은 UsageView 전용이다. 서로 다른 view 전용 필드가 동일 슬롯에 공존해도 무해하다 — view 타입이 바뀌면 전부 리셋되므로 충돌 없음.

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
| `MemoView` | 자유 | 간단한 텍스트 메모장. 내용은 `cache/memo.json`에 pane별로 저장. `memo.copyOnSelect` 는 **lazy** 다 — 선택은 pending 으로만 잡아두고, **선택이 사라질 때만** 클립보드로 flush 한다: pane 안에서 선택이 붕괴하거나(타이핑·화살표·클릭), 메모가 포커스를 잃거나(textarea blur·다른 pane mousedown·window blur). 마우스 릴리즈는 트리거가 아니다 — 드래그가 pane 밖에서 끝나는 건 흔한 일이고, 선택이 살아 있는 동안은 사용자가 아직 그 영역을 Ctrl+V 로 치환할 수 있어야 하기 때문. paste 이벤트는 pending 을 폐기한다 (#307, #710) |
| `UsageView` | 자유 | Claude Code 사용량 모니터. Rust `usage_probe` 가 숨은 PTY 로 `claude` 를 띄워 `/usage` 화면을 파싱한 스냅샷(세션 · 주간 all models · 주간 모델별)을 표시하고, pane 종횡비에 따라 stacked / columns / compact 배치를 자동 선택한다(`viewOverrides.usageLayout` 으로 고정 가능). 모니터링 대상 `CLAUDE_CONFIG_DIR` 은 pane view config 의 `configDir` 이며 컨트롤 바의 view 선택에서 `settings.usage.claude.configDirs` 항목으로 전환한다. 전역 설정은 Settings → Views → 사용량. pace(창 경과율)는 프론트 `lib/usage-pace.ts` 단일 구현 ([ADR-0102](../adr/0102-claude-usage-probe-headless-pty.md)) |
| `FileExplorerView` | 자유 | CWD 동기화 기반 파일 탐색기. Rust `list_directory`로 디렉터리 나열, 편집 가능한 주소창(경로 직접 입력/붙여넣기 → `stat_path`로 검증 후 디렉터리 이동 또는 파일이면 부모 이동+통합 뷰어 open, #278), 파일 뷰어(텍스트/이미지/HTML·Markdown preview/source/터미널) 지원. `.html`·`.md`는 기본 preview와 source 토글을 제공하되, `extensionViewers`에 해당 확장자·command·profile 매핑이 있으면 그 명시적 터미널 프로필의 외부 뷰어를 우선한다(#404/#446, [ADR-0031](../adr/0031-extension-viewer-profile-path-conversion.md)). Remote Focused UI는 host path 입력과 현재 데스크톱 viewer path를 명시적으로 가져오는 `From host` action을 제공하고, `Open viewer` 클릭 시점의 exact path를 active lease와 claim 전용 FileViewer capability로 읽어 별도 브라우저 탭의 안전한 웹 renderer로 표시한다([ADR-0041](../adr/0041-remote-served-file-viewer.md), [ADR-0042](../adr/0042-remote-file-viewer-secret-capability.md)). |
| `IssueReporterView` | 자유 | GitHub 이슈 리포터. 제출은 `issueReporter.submit` 키바인딩(기본 `Ctrl+Enter`) |
| `GitHubView` | 자유 | 현재 CWD 리포의 열린 이슈/PR 목록. sync group CWD 를 **수신만** 하며(컨트롤 바에 receive 토글만 노출), 백엔드의 `owner/repo` 레지스트리가 10초 주기로 `gh issue/pr list` 결과를 공유하고, 주기가 지난 요청에는 기억된 목록을 먼저 내려준 뒤 뒤에서 갱신한다([ADR-0110](../adr/0110-github-snapshot-stale-while-revalidate.md)). 행 클릭은 브라우저 열기, 링크 복사 버튼은 상시 노출(PR 행은 그 옆에 브랜치 복사 버튼 추가), `⋯` 메뉴는 이슈 close(completed/not planned)·PR merge/squash/rebase/close 를 2단계 확인으로 실행한다. `#숫자` 는 title 과 같은 크기·강조 색으로 그리며, 글꼴·크기·번호 색·표시 열·라벨 개수/폭은 전역 `settings.github` 이 소유한다([ADR-0111](../adr/0111-github-view-display-settings.md)). Issues/PRs 탭 선택은 반대로 pane 인스턴스 UI 상태(`viewOverrides.githubTab`)이고 `settings.github.defaultTab` 은 아직 고르지 않은 pane 의 씨앗값이다([ADR-0115](../adr/0115-github-view-tab-per-pane-state.md)) (#708, [ADR-0106](../adr/0106-github-list-view-repo-registry.md)) |
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
