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

| 방법               | 동작                              |
| ------------------ | --------------------------------- |
| 경계선 핸들 드래그 | 드래그 방향으로 신규 분할         |
| 툴바 버튼          | 현재 포커스 Pane을 가로/세로 분할 |
| settings.json      | 직접 비율 정의                    |

### 크기 조절

- 경계선 드래그 (자유 비율, 0.0~1.0 백분율로 저장)
- Pane 최소 크기: 100px (이하 드래그 불가)

**리사이즈는 언제나 "공유 경계를 옮기는 것"이고 판정은 `ui/src/hooks/usePaneResize.ts` 한 곳이 소유한다**([ADR-0071](../adr/0071-pane-resize-single-boundary-owner.md)). 경계선 드래그(`PaneBoundaryHandles`)와 Automation `panes.resize`(`POST /api/v1/panes/:index/resize`, MCP `resize_pane`)가 같은 순수 함수를 부르며, 각자의 산술을 갖지 않는다.

- `boundaryResizeUpdates(boundary, rawDelta, panes)` 가 단위 연산이다. `calcResizeDelta` 로 `PANE_MIN_RATIO` 클램프를 건 뒤 경계의 left/top 그룹에 `w+delta`(`h+delta`), right/bottom 그룹에 `x+delta, w-delta`(`y+delta, h-delta`) 를 담은 절대 rect 목록을 만든다. 양쪽이 같은 델타를 쓰므로 두 면이 항상 맞닿아 겹침·틈이 생기지 않는다. 클램프 후 델타가 무시할 수준이면 빈 목록이다.
- 경계는 `findPaneBoundaries` 가 만든 **병합된 세그먼트**다. T-junction(한 이웃이 여러 pane 에 걸친 경우)에서는 한쪽 그룹에 여러 인덱스가 들어가고 그 pane 들이 함께 움직인다.
- Automation 의 `dw`/`dh` 는 `planPaneResize` 가 축→경계로 해석한다. 대상 pane 의 **trailing 경계**(오른쪽/아래)를 먼저 쓰고, 그리드 끝에 붙어 없으면 **leading 경계**(왼쪽/위)를 부호 반전해 쓴다. 두 축은 독립이며 두 번째 축은 첫 축을 반영한 상태에서 경계를 다시 찾는다. 해당 축에 경계가 하나도 없으면(그 축으로 그리드 전체를 차지) 조용히 깨뜨리지 않고 **오류를 반환**한다.
- `workspace-store.resizePane` 은 계산하지 않는 setter 다 — 인덱스 하나에 절대 rect 를 쓰는 것이 전부이고, 불변식 보장은 호출자(위 함수)의 몫이다.

### 병합 (Pane 제거)

| 방법                              | 동작                            |
| --------------------------------- | ------------------------------- |
| 경계선 끝까지 드래그              | 인접 Pane이 흡수                |
| 경계선 더블클릭                   | 작은 쪽 Pane 제거, 큰 쪽이 흡수 |
| 편집 모드에서 Pane 선택 후 Delete | 인접 Pane 중 가장 큰 것이 흡수  |

### 위치 교환 (드래그&드롭, issue #377, 재설계 #386)

- **Pane 컨트롤바(PaneControlBar)의 버튼 없는 빈 영역을 드래그**해 다른 Pane 위로 드롭하면 두 Pane의 `{ x, y, w, h }` 가 교환된다(view/콘텐츠는 그대로, 슬롯 위치만 swap). 별도 드래그 핸들 요소는 두지 않는다 — 좌하단/우상단 floating 핸들은 콘텐츠와 겹쳐(issue #386) 폐기했다.
- 바 컨테이너 자체가 `draggable` 이며, `onDragStart` 에서 `e.target !== e.currentTarget` 이면(= 버튼/select 등 자식 위에서 시작) `preventDefault` 로 드래그를 취소한다 — 빈 영역(바 배경)에서 시작한 드래그만 swap 으로 처리하고, 버튼 클릭/포커스는 정상 동작한다.
- 컨트롤바는 모드별로 다른 바(hover 오버레이 / pinned / narrow / minimized)와 ViewHeader 기반 바를 렌더하므로, 동일한 draggable 속성을 공통 헬퍼(`barDragProps`)로 만들어 현재 보이는 바 컨테이너에 일관 적용한다. ViewHeader 를 쓰는 View 는 `PaneControlContext.barDragProps` 로 전달받아 자기 바에 펼친다.
- 네이티브 HTML5 DnD(`draggable` + `dataTransfer`)를 사용 — WorkspaceSelectorView 의 워크스페이스 재정렬과 동일 패턴. 별도 DnD 라이브러리 없음.
- UI(`PaneGrid`)는 `onSwapPanes(srcPaneId, tgtPaneId)` 콜백만 노출하고, 실제 교환은 기존 `workspace-store.swapPanes(srcIndex, tgtIndex)`(MCP `swap_panes` 와 공유) 한 곳에서 수행한다. `WorkspaceArea` 가 paneId→paneIndex 로 변환해 연결.
- 드래그는 활성 워크스페이스(`dndEnabled = isActive && !!onSwapPanes`)에서 바가 보일 때만 동작하며, dock(PaneGrid 재사용)은 `onSwapPanes` 미제공으로 비활성. 같은 Pane 위로 드롭하면 무시. minimized(버튼 1개)처럼 빈 영역이 거의 없는 모드는 swap 시작점이 사실상 없다.
- 드래그 페이로드는 `lib/pane-dnd.ts`(MIME `application/x-laymux-pane`, paneId 만 적재)로 공유한다 — 같은 드래그 소스가 swap·move 두 drop 타겟을 모두 먹인다.

### 다른 워크스페이스로 이동 (드래그&드롭, issue #380)

- 같은 드래그(컨트롤바 빈 영역에서 시작)를 **WorkspaceSelectorView 의 워크스페이스 항목** 위로 드롭하면, 그 Pane 이 원래 워크스페이스에서 제거되고 대상 워크스페이스로 이동(추가)된다.
- 소스 제거는 `removePane` 과 동일한 `removePaneAndRedistribute`(인접 Pane 이 공간 흡수). 대상 추가는 대상의 **가장 큰 Pane 을 반으로 분할**(긴 축 기준)해 그 자리에 옮겨온 Pane 을 둔다 — Pane id 와 view 설정은 보존.
- 실제 이동은 `workspace-store.movePaneToWorkspace(paneId, targetWorkspaceId)` 한 곳에서 수행한다. 소스가 Pane 1개뿐이면(워크스페이스가 비게 됨) 무시하고, 같은 워크스페이스·미존재 paneId/대상도 무시.
- 워크스페이스 항목은 재정렬(reorder, `text/plain`)과 이동(move, `application/x-laymux-pane`) drop 을 같은 핸들러에서 MIME(`isPaneDrag`)으로 분기한다. 이동 drop 은 sort 모드와 무관하게 항상 동작하며, 끌어온 워크스페이스는 액센트 링으로 하이라이트된다.

---

## 8. TerminalView

### 8.1 기능

- WSL, PowerShell 프로파일 지원
- 환경변수 접근 및 설정 가능
- xterm.js 렌더링, node-pty로 실제 PTY 연결
- PTY 생성 시 `TerminalEnvPlan`이 laymux 소유 환경변수의 `Set`/`Unset`을 한 번 계산한다. native
  `CommandBuilder`와 WSL rcfile은 같은 계획을 적용하며, `terminal.advertiseTrueColor`는 세션
  생성 시 `TerminalConfig`에 snapshot되어 새 PTY에만 반영된다([ADR-0052](../adr/0052-truecolor-capability-advertising-setting.md)).
- Windows 자식은 in-box conhost 가 아니라 실행 파일 옆에 배치한 Microsoft ConPTY
  재배포본(`conpty.dll` + `OpenConsole.exe`)으로 뜬다. `portable-pty` 가
  `LoadLibrary("conpty.dll")` 로 사이드로드본을 kernel32 보다 먼저 찾으므로 PTY 코드에는
  분기가 없다. 벤더 트리 `src-tauri/vendor/conpty/<version>/`가 정본이고, `build.rs`가
  dev·`cargo run`용 `target/<profile>/`과 installer용 `gen/conpty/`에 바이트가 정확히
  같은 파일만 배치한다. build script 내부의 `tauri-build` resource 재복사는 제외하고
  부모 Tauri CLI bundling만 `tauri.windows.conf.json` resource map을 사용한다. 지원하지
  않는 Windows 아키텍처나 벤더 누락은 빌드 실패이며 in-box conhost로 조용히 폴백하지
  않는다. in-box conhost는 자식이 보낸 `OSC 10/11` 색상 질의를 소비하고 응답하지 않아
  WSL 안의 앱이 터미널 색을 알 방법이 없었다. 사이드로드본에서는 질의가 xterm까지
  도달하며, 같은 이유로 `CSI 6n`·`CSI c` 응답 주체도 conhost가 아닌 xterm.js다
  ([ADR-0067](../adr/0067-bundled-conpty-output-and-staging-contract.md), issue #580).

### 8.2 `lx` CLI

IDE가 TerminalView를 spawn할 때 아래 환경변수를 자동 주입한다(`commands/terminal.rs` + `pty.rs`).
`lx` 는 이 변수들로 현재 터미널/그룹과 IDE 엔드포인트를 식별한다.

```bash
# IDE가 터미널 spawn 시 자동 주입
LX_SOCKET=...            # IDE IPC 엔드포인트 — Linux: /tmp/lx-{session}.sock (Unix socket) / Windows: 127.0.0.1:{port} (TCP)
LX_TERMINAL_ID=...       # 현재 터미널 인스턴스 ID (terminal-pane-{uuid8})
LX_GROUP_ID=...          # 현재 SyncGroup ID
LX_AUTOMATION_PORT=...   # Automation API 포트 (release 19280 / dev 19281)
TERM_PROGRAM=laymux      # 실제 terminal emulator 정체성
TERM_PROGRAM_VERSION=... # 현재 laymux package version
COLORTERM=truecolor      # terminal.advertiseTrueColor=true(기본값)일 때만 광고
```

PATH 는 수정하지 않는다 — `lx` 바이너리(진입점 `src-tauri/src/bin/lx.rs`, 파서 `src-tauri/src/cli/`)는 셸의 PATH 에서 찾을 수 있게 별도로 배치돼 있어야 한다.

`TERM_PROGRAM`/`TERM_PROGRAM_VERSION`은 설정과 무관하게 laymux 값으로 덮어쓰고, 바깥
Windows Terminal에서 상속될 수 있는 `WT_SESSION`/`WT_PROFILE_ID`는 제거한다.
`terminal.advertiseTrueColor=false`이면 `COLORTERM`을 단순 미주입하지 않고 부모·세션 환경의
기존 값까지 제거한다. `TERM`, `NO_COLOR`, `FORCE_COLOR`는 보존한다. WSL은 Windows 환경
전체를 복사하지 않고 같은 mutation만 rcfile에서 `.bashrc` 전후로 `export`/`unset`하며,
`WSLENV`에서는 제거 대상 두 키의 항목만 대소문자·flag를 고려해 정리한다.

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
- **터미널 에뮬레이터 응답은 xterm.js 책임**: Rust 단일 패스는 laymux가 의미를 부여하는
  semantic 훅·액션의 소유권이다. OSC 10/11 색상 질의처럼 terminal emulator가 생성하는
  응답은 xterm.js core가 처리하고 기존 PTY 입력 경로로 돌려보내며, Rust에 중복 응답기를
  추가하지 않는다([ADR-0052](../adr/0052-truecolor-capability-advertising-setting.md)).

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

| Preset                 | OSC                       | 동작                                      |
| ---------------------- | ------------------------- | ----------------------------------------- |
| `sync-cwd`             | OSC 7                     | 그룹 내 터미널 CWD 동기화                 |
| `set-wsl-distro`       | OSC 9;9                   | WSL distro 이름 추출                      |
| `sync-branch`          | OSC 133;E (git 명령 감지) | 그룹 내 터미널 브랜치 동기화              |
| `notify-on-fail`       | OSC 133;D (exitCode ≠ 0)  | 실패 알림                                 |
| `notify-on-complete`   | OSC 133;D (exitCode = 0)  | 성공 완료 알림                            |
| `set-title-cwd`        | OSC 7, OSC 9;9            | 탭 제목을 CWD로 변경                      |
| `notify-osc9`          | OSC 9 (sub-code 없음)     | 터미널 알림                               |
| `notify-osc99`         | OSC 99                    | 터미널 알림                               |
| `notify-osc777`        | OSC 777                   | 터미널 알림                               |
| `track-command`        | OSC 133;E                 | 실행된 명령을 워크스페이스 요약에 기록    |
| `track-command-result` | OSC 133;D                 | 명령 종료 코드를 워크스페이스 요약에 기록 |
| `track-command-start`  | OSC 133;C                 | 명령 시작(preexec) 기록                   |

> **논리 프리셋 12종 vs 훅 13개.** `osc_hooks.rs` 의 `default_presets()` 는 **13개** `OscHookDef` 를 반환한다(테스트 `assert_eq!(default_presets().len(), 13)` 로 고정). `set-title-cwd` 가 OSC 7용·OSC 9;9용 **2개 훅**으로 등록되기 때문이며, 위 표는 이를 논리적으로 한 행에 묶었다.

### 8.4 Terminal renderer reflow / WebGL atlas 원칙

TerminalView의 xterm.js WebGL 렌더러는 **셀 geometry 변경**과 **옵션/상태 변경**을 엄격히 분리한다. WebGL texture atlas는 글리프를 현재 cell width/height 및 devicePixelRatio 기준으로 rasterize하므로, atlas invalidation은 실제 셀 geometry가 바뀌는 경우에만 수행한다.

atlas 는 이 pane 만의 것이 아니다 — 같은 render config 의 터미널끼리 공유되므로 아래의 모든 `clearTextureAtlas()` 는 **다른 pane 의 렌더 모델까지 무효화한다.** 그 파급 처리는 §8.20 이 소유한다.

#### Reflow 허용 조건

`fit()` + `clearTextureAtlas()` + `refresh()` 조합은 비용이 크고 WebGL renderer 내부 atlas를 재생성한다. 이 경로는 다음 경우에만 호출한다.

- `fontSize` / `fontFamily` 변경: cell width/height가 바뀌므로 `fit()` 후 atlas를 재생성한다.
- 브라우저 zoom 또는 monitor DPR 변경: glyph rasterization 해상도가 바뀌므로 atlas를 재생성한다.
- 숨김(`display: none`, 0×0) 상태에서 실제 크기로 복귀: 숨겨진 동안 남은 stale canvas를 `clearTextureAtlas()` + `refresh()`로 즉시 복구한다. `FitAddon.proposeDimensions()`가 현재 xterm `cols/rows`와 같고 hidden 중 보류된 reflow가 없으면 buffer를 건드리는 `fit()`은 수행하지 않는다. geometry 변경이나 보류된 reflow가 있으면 guarded fit 뒤 새 geometry용 atlas를 한 번 더 재생성한다.
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

ResizeObserver의 hidden→visible 분기에서는 `FitAddon.proposeDimensions()`가 계산한 grid와 dirty 상태를 먼저 구분한다. 제안된 `cols/rows`가 현재 xterm grid와 같고 `reflowDirtyRef` 및 remote-return backend dirty가 없으면 `clearTextureAtlas()` + `refresh()`만 동기적으로 수행한다. 이 경로는 xterm buffer/PTY 크기를 바꾸지 않으며 Windows output quiet gate도 기다리지 않는다. 제안 grid가 달라졌거나 hidden 중 font/DPR/scrollbar reflow가 보류됐으면 stale canvas를 `clearTextureAtlas()` + `refresh()`로 먼저 제거하되, buffer를 바꾸는 `fit()`은 write queue drain과 기존 ConPTY quiet window를 모두 거친 뒤 단일 atlas 재생성과 함께 수행한다. 늦게 도착한 이전 폭의 ConPTY repaint를 새 grid에 파싱하지 않기 위해서다. reflow dirty는 fit이 끝난 뒤 `false`로 클리어한다. 같은 integer 크기 가드도 dirty 플래그를 함께 검사해 보류된 reflow가 누락되지 않도록 한다. 이 복구 요청의 atlas 재생성 플래그는 queue drain을 기다리는 동안 뒤의 일반 resize 요청과 OR 병합되므로 유실되지 않는다. 대기 중 다시 hidden으로 전환되면 atlas 재생성과 remote-return backend resize 플래그를 각각 dirty ref로 이관한 뒤 fit 요청만 취소한다. remote-return backend dirty는 resize가 성공한 뒤에만 지우며, 거부 또는 timeout이면 visible 상태에서 최신 geometry로 재시도한다.

이 메커니즘은 §8.4의 "0×0 hidden 상태에서 실제 크기로 복귀할 때만 atlas 재생성" 원칙을 위반하지 않는다. 오히려 hidden 동안 발생한 폰트/DPR/scrollbar 변경을 그 단일 transition에 합류시켜 reflow 호출을 추가하지 않는다.

**워크스페이스 전환은 remount 가 아니다.** `WorkspaceArea` 는 한 번 활성화된 워크스페이스를 계속 마운트해 둔 채 `display:none` 으로만 감추고(`PaneGrid` 도 pane 박스에 같은 처리), `TerminalView` 의 xterm/PTY 수명은 `[instanceId, profile, …]` 에 달려 있으며 `resizePane` 은 pane id 를 보존한다. 따라서 전환도 pane resize 도 `TerminalView` 를 unmount 하지 않고, `TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES` snapshot replay 는 두 경로 어디에도 없다 — 남는 것은 위 hide→show 복귀의 atlas 재생성과 공통 스케줄러를 통과하는 fit 하나다. 실제로 remount 하는 경로는 profile 변경, hidden pane 회수(#269), `movePaneToWorkspace` 뿐이다. 폭주 중 레이아웃 변경이 프론트를 수십 초 무응답으로 만드는 비용은 이 replay 가 아니라 §8.8 의 출력 백로그이며, `attaches`/`attachReplayBytes` 카운터가 이 판정을 실기에서도 반증 가능하게 한다([ADR-0080](../adr/0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)).

Windows output quiet window 는 **delta 도착 시각**으로 잰다. "최근에 PTY 출력이 도착하지 않았다"는 뜻이므로 write 시점이 아니라 `applyOutputSegments` 진입에서 기록한다 — write 시점에 기록하면 stabilizer나 §8.8의 physical write FIFO에 붙들린 byte가 침묵으로 읽힌다. grid를 바꾸는 fit은 quiet window뿐 아니라 attach parser·exact repair·native stabilizer transaction과 open lexical sequence·in-flight/queued xterm write가 모두 끝날 때까지 기다린다. standalone split ESC/CSI prefix는 완결 byte가 오거나 lifecycle reset이 일어날 때까지 보류하고, xterm에 fail-open된 partial sequence도 실제 final/terminator가 올 때까지 fit barrier로 남긴다. 유한 timeout으로 한 제어 시퀀스를 old grid와 new grid 사이에 쪼개지 않는다. 이전 grid용 byte가 FIFO에 남은 채 새 grid로 넘어가는 것보다 fit 지연을 우선하므로 불완전한 시퀀스나 sustained flood에서는 fit이 오래 굶을 수 있다. exact physical boundary의 선택 설계는 [ADR-0085](../adr/0085-provenance-barrier-three-phase-geometry-cutover.md)에 있다. `pty_geometry`의 platform-independent core는 provenance capability, 고정 participant quorum, prepare/apply/adoption phase, token/status/idempotence와 lexical-neutral gate를 실행한다. 이 gate는 bundled xterm의 streaming `Utf8ToUtf32` 규칙(불완전 scalar 보류, invalid sequence 폐기·재동기화)을 먼저 적용한 codepoint만 VT transition에 넘긴다. 따라서 `ESC ] 0 ; 한`의 마지막 raw continuation `9C`는 ST가 아니고 BEL/encoded U+009C/7-bit ST만 OSC를 닫으며, decoded non-ASCII의 CSI·DCS·SOS/PM/APC 전이는 xterm VT500 table과 같은 상태를 따른다. 현재 pinned `portable-pty` fork는 Windows 전용 Read thread+`CancelSynchronousIo` handshake와 Linux PTY fd+wake pipe `poll`로 generation-scoped interruptible reader를 제공한다. native event는 `Data | Wake(generation) | EOF | Failure`를 구분하고 callback `Stop` 또는 handle teardown은 idle read를 먼저 깨운 뒤 그 terminal generation의 reader completion을 기다린다. wake는 control liveness일 뿐 byte provenance나 geometry revision을 만들지 않는다. 실제 ConPTY/Linux PTY 대조군에서도 resize 전에 이미 queued 된 byte가 resize/get-size 뒤 도착하고, `PeekNamedPipe`/`poll`이 empty를 관측한 뒤에도 보유 중인 writer가 새 byte를 만들 수 있으므로 quiet/empty는 producer barrier가 아니다. 모든 producer freeze+authoritative drain 또는 kernel byte epoch는 여전히 증명되지 않아 `exactGeometryCutover`는 false이고, Windows OpenConsole/Linux kernel 수준의 exact primitive는 issue [#643](https://github.com/kochul2000/laymux/issues/643)이 추적한다. pinned reader seam의 upstream 제안과 fork 제거는 별도 issue [#657](https://github.com/kochul2000/laymux/issues/657)이 추적한다([ADR-0089](../adr/0089-interruptible-pty-reader-is-not-provenance.md)).

#### Burst collision 방지

Codex/Claude 같은 TUI는 종료 시 `ESC[?1049l`, scrollback 재방출, footer repaint 등 많은 출력과 cursor/renderer 상태 전환을 짧은 시간에 발생시킨다. 이 시점에 activity 변경까지 겹쳐 `fit()` + `clearTextureAtlas()` + `refresh()`가 반복 호출되면 WebGL atlas rebuild가 TUI exit burst와 충돌하여 인접 pane의 glyph corruption으로 나타날 수 있다.

따라서 reflow 요청은 반드시 `requestAnimationFrame` 단위로 coalesce하고, 같은 tick 안에서 여러 번 발생해도 마지막 요청만 실행한다. activity/cursor/theme 변경 effect는 terminal option만 갱신하고, 필요한 overlay caret 갱신은 별도 updater로 처리한다. 셀 geometry reflow는 font/DPR/실제 size transition을 담당하는 전용 effect에만 둔다.

Pane divider의 ResizeObserver burst는 80ms trailing debounce로 한 번의 `fit()`으로 합친다. ResizeObserver뿐 아니라 폰트, DPR, scrollbar, remote control 복귀를 포함해 geometry를 바꾸는 모든 fit은 공통 스케줄러를 통과한다. PTY 출력과 세션 복원을 포함해 `terminal.write(data, callback)`로 전달할 데이터는 single-flight FIFO를 거친다. 모든 non-stabilized `Uint8Array`는 live/replay source와 무관하게 최대 64 KiB 조각으로 enqueue한다. 단독 live owner는 compatible 조각을 최대 256 KiB로 다시 합치되 다른 owner가 기다리는 turn은 최대 64 KiB만 합친다. replay는 각 64 KiB entry가 callback barrier라 단독이어도 합치지 않는다. cursor 안정화가 원자성을 부여한 frame은 자체 1 MiB 상한 안에서 한 write로 유지하고 string도 기존 원자 경계를 유지한다. xterm parser callback, 재시도 batch, native stabilizer transaction deadline/open lexical sequence, attach parser, exact repair가 남아 있으면 reflow를 실행하지 않고, 모두 끝나면 보류된 최신 fit을 한 번 실행한다. xterm이 backlog 제한으로 write를 동기 거부하면 materialize된 같은 batch와 buffer를 FIFO 선두에 그대로 유지하고 16ms 뒤 재시도한다. 구 v2 fallback의 screen-losing reattach는 queued old-epoch request를 폐기하고 그 waiter를 `onDiscard`로 종결하되 이미 수락된 parse callback은 기다린 뒤 `reset()`한다. production v3 fail-stop은 이 경로를 호출하지 않는다. checkpoint await 뒤 visible enqueue 전에도 attach epoch를 재검사하므로 clear 이후 stale segment가 다시 들어오지 않는다. 대기 중 fit 요청의 atlas 재생성 및 backend resize 플래그는 OR 병합한다. Windows에서는 이전 폭을 기준으로 만들어진 ConPTY 청크가 끝나도록 마지막 PTY 출력 뒤 최대 120ms의 quiet window를 추가하며, quiet-window 조건 자체만 최초 보류 시점부터 500ms 뒤 완화한다. 이 500ms는 parser/stabilizer/repair/FIFO 정확성 gate를 우회하는 전체 resize deadline이 아니다. Linux는 quiet window만 생략하고 같은 정확성 gate를 사용한다. 이는 xterm buffer reflow와 write parser가 서로 다른 grid에서 같은 active buffer를 갱신하는 충돌을 피하기 위한 순서다.

Remote control 복귀 fit은 `onResize`가 만드는 일반 backend 전송을 잠시 억제하고, fit이 확정한 최종 `cols/rows`를 명시적 resize 하나로 보낸다. backend resize가 성공해야 remote-return dirty를 지운다. resize가 거부되거나 1초 동안 pending이면 in-flight 상태를 해제하고 100ms 뒤 최신 geometry revision을 재시도한다. 재시도 대기 중 폰트나 container 크기가 다시 바뀌면 이전 geometry가 아니라 가장 최근 revision을 동기화한다.

`FileViewer`는 두 축으로 렌더러를 고른다([ADR-0109](../adr/0109-file-viewer-typed-preview-renderers.md)). Rust `read_file_for_viewer`가 바이트에서 정한 `kind`(`text | image | pdf | archive | binary`)와, 프론트엔드가 경로 확장자에서 정한 preview 종류다. preview 종류는 다시 두 계열로 갈린다 — document(`html`/`markdown`)는 sanitizer+CSP+sandbox iframe 을 타고, structured(`json`/`jsonl`/`diff`/`csv`/`log`/`code`)는 `ui/src/lib/preview/`의 순수 파서가 만든 값을 `ui/src/components/ui/preview/`의 컴포넌트가 React DOM 으로 그린다. structured 경로는 HTML 문자열을 만들지 않으므로 sanitizer 가 없다. 아래 확장자 외부 뷰어 매핑은 두 축 모두보다 우선한다.

`FileViewer`의 확장자 외부 뷰어는 `ExtensionViewer { extensions, command, profile }` 매핑에서 실행 프로필을 명시적으로 선택한다([ADR-0031](../adr/0031-extension-viewer-profile-path-conversion.md)). 프론트엔드는 shell 문자열을 조립하지 않고 `{ command, path }` 구조화 요청과 선택된 profile 이름을 `create_terminal_session`에 전달한다. Rust는 확장자·command·profile이 현재 settings 매핑과 정확히 일치하고 profile이 존재하는지 검증한 뒤, `profile.commandLine`으로 WSL/PowerShell 환경을 판별한다. Windows drive ↔ `/mnt/<drive>` 및 Linux path ↔ `\\wsl.localhost\<distro>` 변환은 `path_utils`에서 수행하고, 대상 shell 규칙으로 path 인자 하나를 quote한 뒤 startup command를 만든다. explicit WSL pure-Linux UNC를 WSL profile의 로컬 경로로 축약할 때는 `commandLine`의 unquoted distro 선택과 source distro가 일치해야 하며, mismatch·bare WSL·quoted distro는 오류로 거부한다. `/mnt/<drive>`는 distro 공용이므로 이 검증에서 제외하고 Windows profile에는 explicit UNC distro를 보존한다. profile 누락·삭제 또는 startup 주입을 지원하지 않는 shell은 추론 없이 오류로 종료하며, 일반 문자열 `startupCommandOverride`는 `claude --resume <id>`와 `codex resume <id>` 두 정확한 세션 복원 형식만 허용한다([ADR-0117](../adr/0117-codex-session-restore.md)).

Remote FileViewer는 데스크톱 overlay를 복제하거나 외부 프로세스를 실행하지 않는다([ADR-0042](../adr/0042-remote-file-viewer-secret-capability.md), [ADR-0044](../adr/0044-remote-file-viewer-explicit-host-path.md), [ADR-0045](../adr/0045-remote-path-link-reuses-desktop-parser.md)). 연결·heartbeat는 FileViewer status를 자동 조회하지 않는다. 사용자가 명시적으로 `From host`를 누를 때만 active lease와 claim 성공 때 발급된 `fileViewerToken`으로 `fileViewer.status`를 조회해 `useFileViewerStore`의 현재 path를 host file path 입력에 반영한다. 요청 시작 때 입력 revision을 스냅샷하고 응답 시점에 다시 비교하므로, 조회 중 사용자가 입력을 편집했다면 늦은 host path를 적용하지 않는다. 사용자가 `Open viewer` action을 실행하면 클릭 시점의 trim된 경로를 스냅샷으로 고정하고, child bootstrap에 메모리상의 token/lease/fileViewerToken과 `source="path"`를 same-origin `postMessage`로 전달한다. child의 `/remote/v1/file-viewer/render` 요청은 Rust가 lease-bound capability를 확인한 뒤 frontend async bridge `fileViewer.render`로 이어지며, bridge 완료 뒤 응답 직전에 같은 lease/capability를 다시 확인한다. owner transition이나 새 claim으로 capability가 폐기·회전되면 이미 계산한 payload도 버리고 `403`으로 fail closed하며 bridge 이후 응답은 `Cache-Control: no-store`를 사용한다. bridge는 `readFileForViewer(path, 8 MiB)`를 호출하고 HTML/Markdown이면 기존 `file-preview.ts` sanitizer로 완성된 preview document를 만든다. Markdown은 데스크톱과 Remote 모두 같은 `marked` 동기 GFM 렌더러와 내장된 `github-markdown-css`를 사용한다. Preview 응답은 원문 `content`를 중복하지 않으며, 새 탭은 일반 text를 `textContent`, image를 제한된 data URL, preview document를 sandbox iframe `srcdoc`으로만 렌더하고 잘린 preview에는 경고를 함께 표시한다. 문서 제목은 host path를 포함하지 않는 일반 이름으로 유지하고, 직접 경로 입력은 모바일 자동 대문자화를 끈다. Remote 표면은 `extensionViewers` 매핑을 의도적으로 무시한다. 호스트 터미널에서 실행되는 외부 viewer는 독립 브라우저 탭으로 투영할 수 없고, remote 파일 읽기가 새 호스트 프로세스 실행 권한으로 확장되어서는 안 되기 때문이다.

Remote xterm의 선택 파일 링크도 같은 FileViewer 권한 경계와 명시적 host path action을 사용한다. 브라우저는 선택 원문과 active terminal id만 `/remote/v1/file-viewer/path-link`로 보내며 CWD나 조합된 path를 제안하지 않는다. `fileViewer.pathLink` frontend bridge가 desktop `useTerminalStore`의 최신 CWD와 `useSettingsStore.terminal` 설정을 읽고, 위 §8.6의 동일한 `isWithinPathLengthLimit` → `trimSelectionToPath` → `joinCwdPath` → `statPath` 흐름을 실행한다. 존재하는 일반 파일만 정리된 token과 절대 path를 반환하고 디렉터리는 Remote 링크로 활성화하지 않는다. Remote page는 드래그 중 selection 변화를 trailing debounce하고 pointer-up에서 최종 선택을 즉시 검증하며, 새 선택·terminal/lease 전환·xterm reset·resize/reflow에서는 진행 중 요청과 marker를 폐기한다. 응답 token은 응답 시점에 다시 읽은 surface-local xterm 선택 좌표에 매핑해 `registerMarker`+`registerDecoration`으로 밑줄을 그리고, 그 사각형의 primary pointer click에서 `openFileViewerTab(path)`를 호출한다. selection revision·terminal·lease·capability가 바뀐 늦은 bridge 응답은 표시되지 않는다. 실제 파일 내용은 클릭 뒤 child의 기존 render 요청에서만 읽는다.

`FileViewer`의 외부 터미널 뷰어 root는 flex 부모 안에서 `min-width: 0`과 `flex: 1`을 유지해 초기 관찰 폭이 0으로 축소되지 않게 한다(#446). 이 폭이 0이면 `TerminalView`의 `ResizeObserver`가 세션 spawn 조건인 nonzero 분기에 진입하지 못해 vi 프로세스 자체가 시작되지 않는다. `PaneControlBar`의 root/content slot, `ViewRenderer`의 terminal wrapper, `TerminalView`의 최상위 wrapper도 모두 `min-width: 0`과 overflow clipping을 유지한다. xterm canvas의 이전 고정 폭이 flex item의 intrinsic minimum으로 역전파되면 pane이 좁아져도 관찰 대상 host가 줄지 않아 `ResizeObserver`와 `fit()`이 새 열 수를 계산하지 못하고, 오래된 넓은 canvas가 잘리면서 scrollback이 좌우에 반복된 것처럼 보인다. 각 flex 경계가 실제 pane 폭까지 줄어들어야 buffer reflow와 renderer 크기 갱신이 같은 geometry를 사용한다.

Legacy in-box ConPTY는 폭 변경 뒤 현재 화면을 `ESC[?25l (ESC[8;<rows>;<cols>t)? ESC[H ... ESC[?25h` 프레임으로 다시 출력했지만, 번들 `1.23.251008001`은 normal buffer+scrollback 폭 변경에서도 이 host repaint를 내보내지 않는다. 지원 Windows 빌드는 번들 배치를 필수로 하므로 legacy 런타임은 제품 경로에서 도달할 수 없고, ADR-0026의 resize repaint 필터와 그 arm 배선은 제거했다. live PTY 출력은 어떤 repaint 필터도 거치지 않고 xterm write FIFO로 들어간다. legacy in-box 런타임을 명시적으로 다시 지원한다면 스트리밍 필터 알고리즘을 git 이력(`ui/src/lib/conpty-resize-repaint-filter.ts`)에서 되살리는 것이 선행 작업이다. Rust OSC 파이프라인과 raw output ring, Linux와 alternate buffer 동작은 변경하지 않는다([ADR-0067](../adr/0067-bundled-conpty-output-and-staging-contract.md)).

xterm 6.0.0의 wider reflow는 제거된 soft-wrap 행 주변에 stale `isWrapped`를 남길 수 있다. dependency는 6.0.0으로 고정하고 upstream commit `e9c648f`의 수정 패치를 `postinstall`에서 적용한다. patch target이 달라지면 설치를 실패시켜 검토 없이 다른 bundle에 부분 적용되지 않게 한다.

#### Native Windows synchronized-output transaction / WSL strict park metadata

PC WebView의 live PTY 출력은 공통 tracked xterm write FIFO에 들어가기 직전에 terminal별 host 정책을 적용한다([ADR-0076](../adr/0076-codex-in-frame-cursor-park.md), [ADR-0078](../adr/0078-wsl-in-frame-cursor-park-metadata.md), 선행 [ADR-0053](../adr/0053-native-windows-synchronized-output-cursor-transaction.md)). Rust는 실제 PTY spawn에 사용한 `cmd_path`의 basename과 target OS로 `InitialExecutionHost`를 한 번 분류해 `create_terminal_session` 결과의 `initialExecutionHost`로 반환한다. `nativeWindows`만 byte stabilizer를 활성화한다. `wsl`은 byte-for-byte pass-through를 유지하면서 아래 strict in-frame park의 reset metadata만 판정하고, `directSsh`, `nonWindows`, `unknown` 및 별도 browser Remote renderer는 metadata 판정도 하지 않는 pass-through다. UI가 user agent·profile 이름·런타임 activity로 이 값을 재추론하지 않는다.

stabilizer는 문자열 디코딩이나 정규식 치환이 아니라 `Uint8Array` 스트림 상태 머신이다. 7-bit `CSI ? 2026 h/l`, `CSI ? 25 h/l`, CUP/HVP(`H`/`f`), CHA(`G`)만 의미 토큰으로 분류하고, OSC(BEL/ST)와 DCS/APC/PM/SOS(ST)는 framing만 추적해 payload 안의 CSI 모양 바이트를 해석하지 않는다. singleton `?2026h`부터 출력 후보를 보류하고 두 개의 완결 문법만 성공으로 인정한다.

- **legacy out-of-frame restore**: `?2026l` 직후 정확한 `?25l` → 하나 이상의 CUP/HVP/CHA → `?25h`. frame 안의 singleton `?25h`만 제거한 frame+restore를 **tracked write 하나**로 enqueue한다.
- **Codex 0.145 in-frame park**: 열린 frame의 singleton `?25h` 뒤에 하나 이상의 CUP/HVP/CHA가 연속하고 `?2026l`로 즉시 닫힌다. final show는 xterm의 앱 DECTCEM 상태를 위해 보존하고 frame을 즉시 **tracked write 하나**로 enqueue하며, `frameEndCursorAuthoritative` metadata를 함께 보낸다. show/position/reset 사이에 다른 byte·control·CSI가 끼면 이 문법으로 인정하지 않는다.

두 정상 transaction은 이미 1 MiB 상한으로 제한되므로 일반 tracked writer의 청크 분할을 적용하지 않고 `terminal.write` 한 번으로 전달한다. legacy는 frame end와 restore 사이, in-frame park는 final show와 position 사이에 parser callback 경계가 생기지 않는다. cache·snapshot·복원 구분선·backend mode 합성은 stabilizer를 통과하지 않는다.

WSL의 terminal별 `WslInFrameCursorParkRecognizer`는 두 번째 strict 문법만 읽기 전용으로 판정한다. 청크 사이에는 CSI/control-string lexical state만 유지하고, 바이트를 보류·삭제·치환·재정렬하지 않으며 받은 모든 바이트를 같은 호출에서 반환한다. strict `?2026l`이 완결되면 그 token만 별도 tracked write가 되도록 현재 청크를 나누고 해당 write에 `frameEndCursorAuthoritative`를 붙인다. 따라서 같은 PTY 청크 안의 앞선 legacy reset까지 metadata가 번지지 않으며, split CSI는 다음 write의 parser 연속 상태에서 정확한 reset handler가 metadata를 소비한다. 불완전 문법은 metadata 없이 즉시 fail-open하고 legacy out-of-frame restore는 원자화하지 않는다. 최초 attach, 사용자 terminal recreate, unmount와 구 v2 fallback 재부착은 partial token과 열린 frame을 폐기한다. production v3 transport/credit failure는 stream 교체 없이 fail-stop한다.

첫 frame-start 바이트의 monotonic 시각부터 50ms인 `D_hold`를 frame body와 restore 대기가 공유하며 `?2026l`에서 다시 시작하지 않는다. 보류 상한은 1 MiB다. 문법 불일치·timeout·상한 초과는 보류한 원본을 순서와 바이트 그대로 fail-open한다. 이때 OSC/DCS/APC/PM/SOS 내부였다면 해당 control string의 실제 terminator까지 추가 바이트를 보류 없이 통과시키면서 lexical state만 유지하고, 끝난 뒤에만 새 transaction을 탐색한다. 최초 attach·사용자 recreate·unmount와 구 v2 fallback의 gap/교체는 이전 generation의 보류 바이트, parsed callback, timeout, 후속 animation frame을 폐기한다. 폐기된 parsed callback은 실행하지 않되 이전 attach 체인이 영구 대기하지 않도록 별도 lifecycle 취소 waiter만 해제한다.

정상 transaction write callback 뒤에는 public `terminal.refresh(0, rows - 1)`를 즉시 한 번, 다음 `requestAnimationFrame`에 한 번 더 호출한다. 이 settle은 geometry를 바꾸지 않으므로 `fit()`, `clearTextureAtlas()`, xterm private renderer API를 호출하지 않는다. xterm의 helper textarea와 composition view는 기존 `CompositionHelper`/public render 경로가 계속 소유하며 stabilizer가 DOM 위치·focus·value·composition event를 조작하지 않는다.

#### 테스트 요구사항

TerminalView renderer 경로를 수정할 때는 다음 회귀 테스트를 유지하거나 추가한다.

- font 변경은 한 프레임에 coalesce된 reflow를 예약하고 `clearTextureAtlas()`를 호출한다.
- activity 토글(Codex 시작/종료)은 reflow를 호출하지 않는다.
- cursor shape/blink 변경은 option만 갱신하고 reflow를 호출하지 않는다.
- 같은 integer size의 ResizeObserver entry는 `fit()`을 호출하지 않는다.
- 0×0 hidden 상태에서 제안 xterm grid가 현재 `cols/rows`와 같게 복귀하면 `fit()`/PTY resize 없이 atlas clear + refresh만 수행한다.
- hidden(0×0) 컨테이너에서 font/DPR/scrollbar 변경이 발생해도 `fit()` 및 `clearTextureAtlas()`를 즉시 호출하지 않는다 (dirty 마킹만 수행).
- hidden→visible 전환 시 stale canvas는 즉시 atlas clear + refresh하고, 실제 geometry 변경 또는 보류된 dirty는 guarded 단일 `fit() + clearTextureAtlas() + refresh()`로 소비한다. 뒤의 일반 fit이 합류하거나 대기 중 다시 hidden이 되어도 atlas/backend sync 요구를 유지한다.
- PTY 출력 또는 세션 복원 write callback이 남아 있는 동안 ResizeObserver, font, DPR, scrollbar reflow를 실행하지 않고, queue drain 뒤 누적 플래그를 포함한 fit을 정확히 한 번 실행한다.
- xterm backlog가 write를 동기 거부하면 거부된 원본 청크를 유실하지 않고 parser 진행 뒤 재시도하며, 그동안 fit을 차단한다.
- 구 v2 fallback의 screen-losing reattach는 queued old-epoch write를 폐기하면서 parsed/replay waiter를 종결하고, checkpoint await 뒤 epoch를 재검사하며, accepted in-flight parse가 끝난 뒤에만 reset하여 snapshot byte를 중복 적용하거나 attach chain을 멈추지 않는다. production v3 fail-stop은 이 reset 경로를 사용하지 않는다.
- Windows의 120ms output quiet 조건은 최초 보류 뒤 500ms에 완화하지만 parser/stabilizer/repair/FIFO가 남아 있으면 fit을 계속 차단한다. Linux는 quiet 조건만 생략하고 같은 정확성 gate를 적용한다.
- remote control 복귀는 visible/hidden과 same/changed geometry 모두에서 최종 크기를 보호된 backend resize 하나로 동기화하고, 거부·1초 timeout·in-flight geometry 변경 시 dirty를 유지해 최신 revision을 재시도한다.
- Windows normal buffer의 scrollback 폭을 줄이거나 넓힐 때 청크 경계에서 분할된 직접 home marker와 `CSI 8;<rows>;<cols>t` 삽입형 marker를 인식하고, 탐색 창 끝에서 start marker가 완성된 frame에도 별도 완료 창을 적용한다. fit 중 `baseY`가 1에서 0으로 줄어드는 얕은 scrollback도 보호한다. start 전 또는 split start 보류 중 여러 번 재무장하면 arm 수만큼 frame을 제거하고, 제거 중 재무장하면 현재 frame의 완료 또는 만료 뒤 다음 frame을 탐색한다. 실패한 backend resize의 arm을 취소해도 앞선 arm의 자체 deadline은 유지한다.
- Native Windows live delta만 DEC 2026 transaction으로 안정화한다. WSL은 byte-for-byte pass-through를 유지하면서 Codex 0.145의 `?25h` → position → `?2026l` strict tail reset에만 metadata를 붙이고 legacy frame은 보류하지 않는다. 직접 SSH/Linux/unknown, cache/snapshot replay는 metadata 없는 pass-through다. native legacy exact restore 성공 시 transient in-frame singleton `?25h`만 빠지고, strict tail은 final show를 보존한 채 다음 청크 대기 없이 즉시 방출한다. native의 두 정상 transaction은 일반 write 청크보다 큰 frame도 `terminal.write` 한 번으로 전달되며 write callback 뒤 public refresh가 정확히 두 번 실행된다. 활성 IME preedit의 focus/value는 유지되고 composition commit은 human-input 경로로 정확히 한 번만 전달되며, in-frame park의 final buffer cursor가 IME 앵커로 채택된다. WSL 통합 테스트는 strict reset이 legacy settle timeout을 만들지 않는지 고정한다.
- split CSI/control string, payload 안의 fake marker, 문법 불일치, 50ms timeout, 1 MiB 초과, unterminated control string, attach generation 교체를 각각 회귀 테스트로 고정한다. fail-open 결과는 원본 바이트와 순서가 같아야 한다. transaction 밖 standalone lone ESC/partial CSI도 50ms 뒤 fail-open하고 fit을 깨우며, prefix를 이미 방출한 뒤 timeout·상한 fail-open이 발생하면 재출력하지 않는 `passEscape`/`passCsi`/`passControl` lexical 상태로 이어가 실제 terminator/final까지 payload 안의 marker 모양 바이트를 다시 해석하지 않는다. WSL recognizer는 one-chunk/split strict tail, interruption, 같은 청크의 legacy+strict reset metadata 범위와 lifecycle reset을 별도로 고정한다.
- terminal을 감싼 각 flex 경계는 `min-width: 0`과 overflow clipping을 가져 xterm canvas의 intrinsic width가 pane 축소를 막지 않는다.

### 8.5 Shadow cursor / DECTCEM 주차 상태

Codex overlay caret의 DEC 2026 프레임 안/밖 판정은 xterm.js 렌더 모드가 아니라 parser 경계가 권위 소스다.

- `CSI ? 2026 h/l` parser handler가 activity 분류와 무관하게 `ShadowCursorState.isDec2026FrameOpen`을 열고 닫는다. 웹뷰 리로드나 초기 감지 중 `?2026h`가 shell/미분류 상태에서 먼저 와도 같은 프레임의 `?25h`를 park로 오인하지 않는다.
- `terminal.modes.synchronizedOutputMode`와 `syncOutputActiveRef`는 xterm의 표준 렌더 억제 구간 판정, 헬퍼 textarea caret 숨김, 중복 repaint 차단에 사용한다. 별도 `syncOutputCursorGateActive`는 DOM focus·blur·selection의 직접 renderer 우회가 프레임 내부 cursor를 그리지 못하게 raw gate reason을 유지한다(§8.22, [ADR-0079](../adr/0079-dec2026-cursor-gate-lifecycle-bypass.md)). xterm.js는 1초 safety timeout 뒤 mode를 `false`로 바꿀 수 있으므로 DECTCEM `?25h` 주차 분류나 parser frame-open settle 판정에는 사용하지 않는다.
- 프레임 set 시 기존 trusted shadow가 있으면 그대로 유지하고, 없으면 pre-frame buffer 좌표를 임시 `hasSyncFramePosition`으로 승격한다. safety timeout 뒤 overlay가 다시 그려져도 frame body의 footer 좌표를 live buffer에서 읽지 않게 하기 위함이다.
- `isDectcemShowPark()`는 `isDec2026FrameOpen === false`이고 normal buffer일 때만 참이다. 따라서 장시간 프레임에서 모드 timeout이 발생해도 프레임 안 `?25h`는 visibility-only repaint tail로 남는다.
- native Windows stabilizer 또는 WSL metadata-only recognizer가 strict in-frame park를 확인한 write에는 `frameEndCursorAuthoritative`가 붙는다. 이 경우 `?2026l` handler 시점의 buffer cursor는 바로 앞 final position을 이미 적용했으므로 pre-frame snapshot보다 우선하고, `parkPending`을 세우지 않으며 남은 settle timer를 해제한다. metadata가 없는 legacy frame은 pre-frame snapshot을 fallback으로 쓰고 out-of-frame park 또는 timeout을 기다린다.
- settle 재무장 상한은 `parkPending` fallback 동결만 해제한다. `isDec2026FrameOpen`은 타이머나 activity 전환이 닫지 않으며 실제 `?2026l` parser 경계에서만 닫힌다.
- **`ShadowCursorState` 는 xterm 에 밀어넣는 바이트 스트림 소유다 — 스트림이 교체되면 상태도 다시 세운다**(issue #596). 구 v2 fallback에서 `TerminalOutputAttachCoordinator.consume` 이 `seqStart > expectedSeq` 로 gap 을 내면 프론트는 먼저 잃어버린 구간을 ring 에서 당겨와 이어 붙이고, ring 이 그 구간을 더 이상 보존하지 못하거나 구간이 resize 를 가로지를 때만 `terminal.reset()` + snapshot replay 로 재부착한다([ADR-0072](../adr/0072-terminal-output-gap-sequence-exact-repair.md)). 그래서 `terminal.reset()` 바로 옆에서 `createShadowCursorState()` 로 상태를 다시 만들고, park settle 타이머를 해제한다. production v3는 이 gap-repair/재부착 경로를 쓰지 않고 §8.8의 typed fail-stop을 사용한다. 조합 스크롤 회계는 여기서 손대지 않는다 — reset 이 이미 동기 `onScroll` 을 발행하고 지나간 뒤라 여기서의 재시드는 fallback 경로의 no-op 이고, 그 창의 소유자는 §8.15 아래 #602 항목의 재구축 창이다. 초기 부착에서도 같은 코드가 돌지만 그때는 상태가 이미 초기값이라 무해하다 — live 바이트는 attach 완료까지 coordinator 가 붙들고 있으므로 reset 앞에서 프레임이 열릴 수 없다.
  - **테스트는 이 "coordinator 가 붙들어 준다" 전제를 못 쓴다.** `TerminalView.test.tsx` 는 parser handler(`csiHandlers`/`oscHandlers`/`escHandlers`)를 직접 호출해 shadow 상태를 심으므로 attach reset 과 순서 경쟁을 한다. 그래서 개별 테스트가 대기를 기억하는 대신 **xterm mock 이 등록된 모든 handler 를 attach reset 게이트로 감싼다**(issue #603). 게이트는 event-loop turn 수를 세지 않고 `terminal.reset()` 호출 자체로 열리므로 attach 경로의 await 개수가 바뀌어도 유효하다. 게이트 자체는 `holds parser handlers until the stream attach reset lands` 테스트가 attach 를 인위적으로 붙들어 고정한다. 재무장은 **파일 수준 `beforeEach`** 다 — 플래그가 모듈 전역이라 `describe` 단위로 걸면 나중에 추가된 `describe` 가 이미 열린 게이트를 물려받아 규칙이 조용히 사라진다. 1초 bail 로 떨어진 경우도 조용히 통과시키지 않고 `afterEach` 가 그 테스트를 실패시킨다(이 프로젝트의 vitest 실행은 테스트측 console 출력을 표면화하지 않으므로 경고로는 드러나지 않는다).
  - **반대로 복구(repair) 경로는 이 상태를 절대 다시 세우지 않는다.** 복구는 visible 버퍼를 보존하고 스트림을 byte-exact 로 유지하므로 `cursorAbsY`·`commandStartLine`·프레임 snapshot 이 모두 살아 있는 행을 계속 가리킨다. `isDec2026FrameOpen` 도 열린 채 유지해야 맞다 — 프레임의 `?2026l` 은 파괴된 것이 아니라 전달되지 않았을 뿐이고 복구 구간 안에 실재하므로, 같은 parser handler 에 도달해 gap 이 없었을 때와 똑같이 래치를 닫는다. 여기서 상태를 다시 세우면 프레임 안 `?25h` 가 권위 cursor park 로 승격되는 정반대 결함이 생긴다. 이 불변식은 `TerminalView.test.tsx` 의 "keeps the shadow cursor across a repaired sequence gap" 가 고정한다.
  - 구 v2 fallback 재부착이 남기는 스테일 값 두 종류가 각각 다른 방식으로 문다. `isDec2026FrameOpen` 은 재부착이 프레임의 `?2026l` 을 버리면 위 규칙 때문에 되돌릴 방법이 없어 **영구**다 — 이후 모든 sync 가 `dec-2026-frame-open` 으로 막히고, Codex 의 권위 park 가 `isDectcemShowPark === false` 로 visibility-only 로 격하되고, `getSettledCursor()` 가 계속 `null` 을 돌려주며, overlay caret 이 프레임이 열린 열에 박힌다(실측: 한글 확정 직후 열 20 에 고정, 실제 커서는 열 39). `cursorAbsY` 는 reset 이 지운 scrollback 행을 가리켜 무효다. 이것이 production v3가 reset/replay/replacement attach를 liveness 수단으로 금지하는 직접적인 이유다.
  - **팩토리는 optional 필드까지 전부 열거해야 한다.** 적용이 `Object.assign` 이라 빠뜨린 키는 지워지지 않고 reset 이전 값을 유지한다. replay 되는 링 snapshot 은 줄 경계에서 잘려 그 첫 `?2026l` 이 고아 reset 이므로, `applyDec2026ResetToShadowCursor` 의 `state.frameSavedCursorX ?? bufferCursorX` 가 gap 이전 프레임 snapshot 을 채택해 `hasSyncFramePosition` + 존재하지 않는 행을 세우고 이후 sync 를 `row-mismatch` 로 막는다(Codex 다음 park 가 덮으므로 1프레임 과도 현상). 필드 집합은 `shadow-cursor-state.test.ts` 가 `toStrictEqual` 로 고정한다 — `toEqual` 은 값이 `undefined` 인 속성과 없는 속성을 같다고 보므로 누락을 못 잡는다.
- `?2026l` 뒤 `parkPending`이면 overlay 좌표 repaint를 동결하지만, IME composition이 종료되어 `active=false`가 되면 프리뷰 DOM의 opacity와 text를 동결 검사 전에 즉시 정리한다. 완료된 조합 문자열이 settle timeout까지 화면에 남아서는 안 된다.
- 활성 IME composition preview는 터미널 셀 행별 fragment로 렌더링한다. 첫 fragment는 조합 anchor 열에서 시작하고 soft-wrap 이후 fragment는 다음 버퍼 행의 0열에서 시작한다. 폭 2 문자가 남은 한 셀에 걸치지 않도록 preview 행 배치와 composition caret 좌표는 같은 셀 폭 순회를 사용하며, xterm helper textarea의 focus·value·composition lifecycle 소유권은 변경하지 않는다. 이 순회의 폭·grapheme 경계는 §8.10 의 단일 provider 에서 온다.
- **조합 체인의 확정 접두부는 preview 에 남기지 않는다**(issue #546). CJK IME 는 다음 음절을 시작하는 자모가 앞 음절을 확정하기도 하므로 `compositionend` → `compositionstart` 가 **같은 틱**에 온다. 지연 finalize 가 `setTimeout(0)` 이라 이 carry-over 는 평범한 타이핑에서 발동한다. 이때 확정된 음절은 이미 xterm finalizer 가 PTY 로 보냈으므로, carry-over 시 `compositionBaseText` 를 현재 textarea 값으로 재기준화해 preview 가 **활성 음절만** 담게 한다. 재기준화하지 않으면 확정 텍스트가 계속 밑줄로 남고 preview 폭이 문장 전체로 자라 실제 버퍼 내용을 덮어 그린다.
- carry-over 앵커는 **shadow cursor 가 echo 했는지**로 결정한다. 판정 기준은 `compositionAnchor` 가 아니라 **직전에 실제로 읽은 `getAnchor()` 값**이다 — `compositionAnchor` 는 앞선 carry-over 의 산술값일 수 있어 그것과 비교하면 "PTY 가 echo 했나" 와 "앵커가 산술값인가" 가 한 식에 엉킨다. 값이 바뀌었으면 echo 된 것이므로 live 를 채택하고(방향 무관 — 스크롤·clear 로 뒤로 간 경우도 권위다), 안 바뀌었으면 확정 텍스트의 셀 폭만큼 산술 전진한다. 같은 틱에는 PTY 왕복이 없어 shadow cursor 가 확정 전 셀을 보고하므로 그것을 그대로 쓰면 새 음절을 앞 음절 위에 그린다.
- **교정 시점은 다음 음절이다.** `getAnchor()` 는 fresh start 와 carry-over 두 곳에서만 호출되고 `syncPreview` 는 앵커를 재조회하지 않는다. 따라서 산술 앵커의 오차는 프레임 단위가 아니라 **음절 단위**로 남고, 체인의 마지막 음절에는 교정 기회가 없다(다음 이벤트가 finalize). wide glyph 가 행 끝에 들어가지 않아 xterm 이 클러스터를 통째로 다음 행으로 밀는 경우가 그 예다 — 산술값은 `cols` 를 넘고 레이아웃이 다음 행 0열로 정규화하는데 실제 커서는 다음 행 2열이라 2셀 왼쪽으로 어긋난다. 다음 carry-over 에서 shadow cursor 가 이미 다른 행이므로 live 채택으로 교정된다.
- carry-over 시점의 `update` 는 텍스트도 함께 비운다. 이전 음절이 `state` 에 남은 채 **새 앵커**로 한 프레임 그려지면 확정 텍스트가 실제 위치보다 한 음절 오른쪽에 나타난다.
- legacy 문법은 stabilizer가 `?2026l`을 관찰한 시각으로 `D_park = frameEndAt + 50ms`를 write metadata에 기록한다. parser hook이 늦게 frame end를 보더라도 park settle은 이 deadline까지의 **남은 시간**만 사용하며 새 50ms를 시작하지 않고, 같은 write 안의 최종 out-of-frame `?25h`가 권위 park를 확정해 timer를 즉시 해제한다. strict in-frame park는 reset 시 이미 권위 좌표가 있으므로 `D_park`나 settle timer를 만들지 않는다. stabilizer를 거치지 않은 출력의 기존 parser settle 동작은 그대로 유지한다.
- normal buffer의 `viewportY < baseY`이면 사용자가 scrollback을 보는 중이므로 Codex overlay caret과 composition preview를 숨긴다. shadow cursor 좌표 자체는 유지하고, `terminal.onScroll`에서 표시 상태만 다시 계산해 live bottom으로 복귀하면 즉시 복원한다. live 화면 기준 shadow 좌표를 과거 viewport에 고정 표시하지 않기 위함이다.

상태 전이는 `ui/src/lib/shadow-cursor-state.ts`, parser hook·settle timer·overlay paint 순서는 `TerminalView.tsx`가 담당한다.

### 8.6 링크 활성화 (평문 / OSC 8 / TUI 우회)

데스크톱 터미널 내 URL 클릭은 모두 `openExternal`(`@/lib/tauri-api`)로 OS 브라우저를 연다(webview 내 `window.open` 금지).

- **평문 URL** — `WebLinksAddon`의 핸들러가 `openExternal`로 라우팅.
- **OSC 8 hyperlink** — xterm `Terminal.linkHandler.activate`가 `openExternal`로 라우팅(#345). `WebLinksAddon`은 정적 import.
- **Remote 브라우저 URL**(#516) — self-hosted `WebLinksAddon`이 평문 HTTP(S) URL을, xterm `linkHandler`가 OSC 8 HTTP(S) URL을 활성화하며 둘 다 `openRemoteUrl`로 라우팅한다. 마우스 클릭뿐 아니라 터치·펜 단일 탭도 Pointer Events 선택 브리지가 `.xterm-screen`에 `mousemove` hit-test를 먼저 전달하고, 실제 링크 셀일 때만 xterm Linkifier가 요구하는 `mousedown`→`mouseup`을 같은 user activation 안에서 합성해 동일 경로를 사용한다. 터치에는 지속 hover가 없으므로 활성화 직후 합성 `mouseleave`로 underline/cursor 상태를 지운다. `openRemoteUrl`은 URL을 다시 파싱해 `http:`/`https:`만 `_blank` + `noopener,noreferrer`로 열고, 비-HTTP 스킴과 잘못된 URL은 무시한다. 들여쓰기 하드랩(#145)과 TUI 마우스 트래킹 우회(#352)는 기존 데스크톱 전용 동작을 복제하지 않는다.
- **들여쓰기 하드랩 URL**(Claude OAuth 등) — `createIndentedLinkProvider`가 인접 동일 들여쓰기 줄을 결합해 탐지(설정 `paste.linkJoin`). 링크 범위는 셀 좌표로 낸다(#696, 아래 §8.6 와이드 문자 항목).
- **평문 `#123` 이슈/PR 참조**(#439, [ADR-0050](../adr/0050-remote-github-reference-links.md)) — codex는 `#123`을 OSC 8로 감싸 xterm이 네이티브로 클릭 가능하게 만들지만, Claude Code는 **평문**으로 출력해 링크가 없다. desktop `createPrLinkProvider`(`ui/src/lib/pr-link-provider.ts`)와 Remote `createRemotePrLinkProvider`가 같은 `(?<!\w)#(\d+)\b` 의미로 탐지해(색상 `#fff`·`abc#12`·`v1.2#3` 오탐 회피), 해당 terminal의 GitHub repo를 `{repoBase}/issues/{n}`로 연다(GitHub이 issues↔pull을 번호로 리다이렉트하므로 이슈·PR 모두 열림). 공용 Rust `resolve_github_base_from_working_dir`가 CWD의 git `origin`을 `https://github.com/{owner}/{repo}`로 정규화한다. desktop은 CWD effect가 `repoBaseRef`를 채우고, Remote는 path를 client에서 받지 않는 `GET /remote/v1/terminals/{id}/github-repo`로 server-side terminal CWD와 함께 조회한다. Remote는 terminal/CWD/revision이 모두 일치한 응답만 메모리에 적용하고 전환 즉시 이전 base를 비운다. GitHub repo가 아니면 링크를 만들지 않으며 별도 설정 토글은 없다. 두 provider 모두 wide cell 이전의 offset→column 보정을 수행한다.
- **TUI 마우스 트래킹 우회**(#352) — codex 등 풀스크린 TUI가 마우스 리포팅을 켜면 클릭이 앱으로 전달되어 위 경로들이 트리거되지 않는다. 다수 터미널의 관례대로 **Shift 또는 Alt + 좌클릭**(Ctrl이 함께 눌린 조합은 제외 — path-link의 호스트 OS 열기가 소유한다, [ADR-0100](../adr/0100-path-link-host-os-open-modifier-contract.md)) 시 wrapper DOM의 capture-phase `mousedown` 리스너가 가로채, 좌표를 셀로 변환해 OSC 8 → 들여쓰기 결합 → 평문 URL → `#123` 이슈/PR(repoBase 있을 때) 순으로 링크를 찾아 `openExternal`로 연다. 링크를 찾으면 `stopImmediatePropagation`으로 클릭이 TUI에 전달되지 않게 막고, 없으면 그대로 흘려보내 기존 선택/드래그를 해치지 않는다.
  - 순수 탐지 로직은 `ui/src/lib/terminal-link-click.ts`(`resolveLinkAtCell`/`findPlainUrlAtCol`/`isModifierLinkClick`). 평문 URL 정규식은 `WebLinksAddon`과 동일하게 유지하고, `#123` 판별은 `pr-link-provider`의 `findPrTokens`를 재사용한다.
  - 좌표→셀 변환(`_mouseService.getCoords`)과 OSC 8 uri 조회(`_oscLinkService.getLinkData`)는 xterm 코어 내부 API이므로 `TerminalView.tsx`에서 try/catch + optional 접근으로 감싼다. 평문·들여쓰기 경로는 공개 buffer API만으로 동작하므로 내부 접근이 실패해도 폴백된다.
- **파일/디렉토리 경로 → viewer·cwd 전파**(#363, **선택 기반·데코레이션**) — URL이 아닌 "스킴 없는 파일/디렉토리 경로"(예: `ui/src/index.css`, `Cargo.toml`, `/etc/hosts`, `laymux`, `v3`)는 `createPathLinkController`(`ui/src/lib/path-link-provider.ts`)가 처리한다. **사용자가 드래그로 선택한 한 덩어리만** 대상으로 한다(기존의 hover 줄 전체 토큰 stat 방식은 제거 — 느리고 Windows에서 동작 안 함).
  - 검증 흐름은 `TerminalView`의 `onSelectionChange`/드래그 종료 `pointerup` 시점에 1회 수행한다: ① 설정 `terminal.pathLinkEnabled` off면 종료 ② 선택이 비었거나 `terminal.pathLinkMaxLength`(기본 256) 초과면 종료 ③ `trimSelectionToPath`로 단일 토큰 추출(공백 끼면 제외, URL 스킴 제외, 후행 `:line:col`·문장부호·따옴표/괄호 제거). **선택 기반이라 슬래시·확장자 없는 맨이름(디렉토리/확장자 없는 파일)도 후보로 받는다** — 존재 검증이 실질 게이트이므로 형태 휴리스틱으로 거르지 않는다(URL 스킴만 제외) ④ `joinCwdPath`로 cwd와 조합(없으면 종료) ⑤ **`stat_path`를 선택당 1회만** 호출 ⑥ `decidePathLinkAction`으로 분기 — 존재 안 함=밑줄 없음, 파일=`openFile`, 디렉토리=`changeDir`.
  - **밑줄은 xterm 데코레이션으로 직접 그린다**(linkifier hover 의존 안 함). xterm `ILinkProvider`/Linkifier는 mousemove 시점에만, 같은 셀이면 재질의를 건너뛰어, 비동기 stat 검증이 끝난 뒤 마우스가 정지해 있으면 밑줄/클릭이 안 켜졌다("나갔다 돌아와야 동작"). 그래서 검증되면 `setVerifiedSelection`이 `registerMarker`+`registerDecoration`(둘 다 xterm **proposed API** → `Terminal` 생성 시 `allowProposedApi: true` 필수)으로 그 범위에 밑줄 요소를 만든다. 선택 좌표는 `mapSelectionToPathRange`가 `getSelectionPosition()`의 **0-based·end exclusive** 모델 좌표를 데코레이션의 **1-based 절대 버퍼 좌표**로 보정한다(미보정 시 밑줄이 한 행 위·한 칸 왼쪽). 선택이 바뀌거나 해제되면 `clear()`가 데코레이션·마커를 dispose한다.
  - **커서·클릭은 `TerminalView`가 hit-test로 처리한다.** 데코레이션 요소는 `pointer-events: none`(순수 시각)이라 클릭·드래그가 그대로 xterm으로 전달된다 → ⓐ 포인터(손가락) 커서는 `mousemove` 시 `hitTest(clientX,clientY)`로 **밑줄 사각형 안일 때만** 켜고(벗어나면 원래 커서), ⓑ 클릭은 `mousedown`(capture) 시점에 경로를 캡처해 두고 이동 없이 `mouseup`이면 `activate`로 연다 — 클릭 시 xterm이 선택을 지워 `current`가 비기 때문. **드래그면 무시**해 일반 재선택이 되게 두고, 새 선택은 `onSelectionChange`가 재평가한다.
  - **수정자 클릭 → 호스트 OS 위임**(#687, [ADR-0100](../adr/0100-path-link-host-os-open-modifier-contract.md)) — 밑줄 사각형 안에서 **Ctrl+좌클릭**은 대상을 호스트 OS로 넘기고(파일=연결 프로그램, 디렉토리=파일 관리자), **Ctrl+Shift+좌클릭**은 파일 관리자에서 부모 폴더를 열고 대상을 선택 표시한다(부모가 없는 드라이브/공유 루트는 열기로 낮춘다). WSL 경로도 호스트 맥락으로 열린다 — 백엔드 `open_in_os`가 `stat_path`와 같은 `resolve_address_path_following_symlinks`로 호스트 경로를 만든다.
    - 이 두 조합만은 **관찰이 아니라 소유**다. mousedown(capture)에서 `preventDefault` + `stopImmediatePropagation`으로 종결해 xterm 선택 확장·TUI 마우스 리포팅 전달·#352 우회가 같은 클릭을 함께 처리하지 못하게 한다. `isModifierLinkClick`이 Ctrl 조합을 배제하는 것과 이중 안전이다. Alt나 Meta가 끼면(`Ctrl+Alt`/`Ctrl+Meta`) 소유하지 않는다 — 정확히 `Ctrl`과 `Ctrl+Shift` 두 조합만 소유한다.
    - 액션은 mousedown 시점에 `decidePathLinkClickAction`으로 확정하고, mouseup에서 확인 판정 후 실행한다. 확인은 실행으로 이어지는 **파일 `open`** 에만 적용된다 — `terminal.pathLinkOsOpenConfirm`(기본 켬)이면 확장자 무관 매번, 꺼도 하드 클래스(`HARD_CONFIRM_EXTENSIONS`: 직접 실행·설치·스크립트 호스트·레지스트리 병합. Windows가 WSH로 실행하는 `.js` 포함)는 계속 확인한다. `reveal`과 디렉토리 열기는 확인하지 않는다. `terminal.pathLinkOsOpenEnabled`가 꺼져 있으면 수정자 클릭도 아래 기본 분기로 떨어진다.
    - 순수 로직은 `ui/src/lib/path-link-os-open.ts`(`decidePathLinkClickAction`/`isOsHandoffAction`/`requiresHardConfirm`/`needsOsOpenConfirm`/`pathLinkHintKey`), mousedown·mouseup 상태 기계는 주입형 `createPathLinkClickHandlers`(`path-link-click.ts`), 라우팅은 `createPathLinkController.activate(sel, action)`, 실행은 데스크톱 전용 커맨드 `open_in_os`다(Automation/MCP/Remote 미노출). `TerminalView`는 스토어·i18n·포커스만 주입해 배선한다.
    - **발견성**: 밑줄 위에 포인터가 있는 동안 `createPathLinkHint`(`path-link-hint.ts`)가 `Ctrl`/`Ctrl+Shift`로 무엇을 할 수 있는지 라벨(`.terminal-path-link-hint`)로 알린다. 라벨은 `pointer-events: none`이고 위쪽 공간이 없으면 아래로 뒤집으며 host 폭 안으로 클램프한다. `pathLinkOsOpenEnabled`가 꺼져 있으면 표시하지 않는다.
    - **Windows `explorer.exe` 인자**: `reveal`은 `/select,"<path>"` 형태를 **raw 커맨드라인**으로 넘긴다. explorer는 `CommandLineToArgvW`를 쓰지 않아 표준 이스케이프가 `/select,<공백 포함 경로>` 전체를 따옴표로 묶으면 스위치를 인식하지 못하고 기본 폴더를 연다(실기 확인). `open`은 인자 하나뿐이라 표준 이스케이프로 충분하다. 후행 구분자는 `normalize_target`이 루트를 제외하고 정리한다.
  - 클릭 분기(수정자 없음): 파일이면 `useFileViewerStore.openFileViewer`로 통합 뷰어를 연다. 디렉토리면 그 경로를 새 cwd로 **제안**해 기존 중앙화 전파 경로(`do_sync_cwd`)에 그대로 태운다 — `FileExplorer.navigateTo`와 동일하게 ① origin으로 **비-터미널 sentinel**(`${instanceId}__pathlink`)을 넘겨 백엔드가 소스의 tracked cwd를 발명(`ipc_dispatch.rs`의 `update_terminal_cwd`)하거나 소스를 대상에서 제외하지 않게 하고(클릭한 pane도 특별취급 없이 일반 대상), ② **`force`를 넣지 않아** `filter_targets_cwd_receive`가 적용되어 **`cwd_receive`를 켠 pane(클릭한 pane 포함)만** 이동한다(dock·다른 pane 동일 정책). `force: true`는 `cwd_receive`를 무시하므로 쓰지 않는다. 셸별 경로 변환(POSIX↔UNC↔Windows)은 백엔드 `write_cd_to_group_terminals`가 프로파일별로 처리한다.
  - 순수 로직은 `ui/src/lib/path-link-detect.ts`(`trimSelectionToPath`/`isWithinPathLengthLimit`/`joinCwdPath`/`normalizeMsysCwd`/`mapSelectionToPathRange`/`decidePathLinkAction`)에 분리해 단위 테스트로 덮는다.
  - **Windows cwd 처리**: git-bash/MSYS 셸이 cwd를 `/d/PycharmProjects/...` 형태로 보고하면, 상대경로 조합 후 백엔드 `resolve_address_path`가 선행 `/`를 WSL로 오인(`\\wsl.localhost\...`)해 검증이 실패한다. 이를 막기 위해 `joinCwdPath`가 조합 직전 `normalizeMsysCwd`로 MSYS cwd(`^/<drive>/...`, 단 `/mnt/` 제외)를 Windows 드라이브 경로(`X:\...`)로 변환한다(백엔드 전역 동작은 변경하지 않음). PowerShell cwd(`D:\...`)·POSIX(`/home/...`)·WSL UNC(`\\wsl.localhost\...`)는 그대로 동작한다(단위 테스트로 보장).
  - **와이드 문자 보정**(#691) — 밑줄 폭의 단위는 문자 수가 아니라 **셀 수**다. 한글·CJK·전각은 한 글자가 2셀, 이모지는 UTF-16 2칸이 1셀 쌍이라 UTF-16 길이로 계산하면 밑줄이 절반만 그어지거나(경로가 한글일 때) 왼쪽으로 밀린다(앞에 한글이 있을 때). `TerminalView`가 선택 시작 줄의 실제 셀(`readLineCells`)을 `mapSelectionToPathRange`에 넘기고, 그 안에서 `reconstructLine`의 `columns`(시작 셀)·`endColumns`(끝 셀, 와이드는 +1)로 범위를 잡는다. 같은 토큰이 한 줄에 여러 번 나오면 선택 시작 셀 이후의 것을 고른다(앞쪽 인스턴스로 되돌아가는 재검색은 두지 않는다 — 실패를 오답으로 바꾼다). 검색 앵커는 `endColumns` 로 잡는다: xterm 은 와이드 문자의 **뒷칸**을 선택 시작으로 보고할 수 있어서(`Mouse.getCoords` 가 셀 중앙 기준으로 반올림) 끝 컬럼으로 비교해야 그 문자 자신의 오프셋에서 검색이 시작된다.
  - **하드랩 선택은 미보정**이다. xterm `selectionText` 는 `isWrapped` 물리 행을 개행 없이 이어 붙이므로, 좁은 pane 에서 줄바꿈된 경로를 선택하면 토큰이 시작 행의 셀에 없어 문자열 계산으로 폴백하고 #691 증상(절반 폭·밀림)이 그대로 남는다. 고치려면 `isWrapped` 체인을 따라 셀을 이어 읽고 범위를 여러 행에 걸쳐 계산해야 한다.
  - 셀↔오프셋 매핑은 `ui/src/lib/terminal-cell-map.ts`(`CellInfo`/`reconstructLine`/`readLineCells`)가 단일 소유자이며 `pr-link-provider`(#441)·`indented-link-provider`(#696)와 공유한다. 실제 xterm 이 어느 셀에 무엇을 놓는지는 폭 판정 provider(ADR-0058) 소관이므로, 밑줄 범위는 `path-link-wide-cell.screen.test.ts`·`indented-link-wide-cell.screen.test.ts`(ADR-0074 화면 스위트)에서 진짜 터미널 버퍼로 검증한다.
  - **들여쓰기 하드랩 URL 도 같은 보정을 쓴다**(#696). 이 provider 는 여러 줄을 결합하므로 매핑도 **행별**로 필요하다: `readIndentedLine`이 줄마다 `reconstructLine` 결과(`text`/`columns`/`endColumns`)를 `IndentedLineInfo` 에 담고, 결합할 때 문자열과 함께 오프셋마다의 `(행, 시작 셀, 끝 셀)`을 같은 루프에서 쌓아 둔다. `ILink.range.start` 는 `columns`, `end` 는 `endColumns`(와이드는 +1)를 쓴다. 결합 문자열은 줄 끝 패딩을 뗀 내용을 이어 붙이므로 좌표도 같은 내용 기준으로 쌓아야 끝점이 마지막 행에 찍힌다 — 패딩 포함 길이로 세면 오프셋이 첫 줄 안에서 소진된다. 줄을 만드는 곳은 provider 와 `TerminalView` 의 #352 우회 경로 둘 다 `readIndentedLine` 을 쓴다.
  - #352 우회 경로의 **평문 URL·`#123`** 판정은 여전히 문자열 오프셋을 클릭 셀 컬럼과 비교한다(`terminal-link-click.ts`). 그 경로는 마우스 트래킹 TUI 전용이고 codex 는 두 형태를 OSC 8 로 이미 링크하므로 실질 트리거가 드물다 — 필요해지면 `IndentedLineInfo` 가 이미 들고 있는 컬럼 맵으로 보정한다.

### 8.7 맨 아래로 이동 버튼 (issue #349)

사용자가 스크롤백 위로 올라가 있을 때 우측 하단에 플로팅 "맨 아래로 이동" 버튼(`.terminal-scroll-to-bottom`)을 띄운다.

- 표시 판정은 `isTerminalScrolledUp(terminal)` 순수 함수로 도출한다. xterm `buffer.active.viewportY < baseY`이면 스크롤백을 보는 중이므로 버튼을 노출하고, 같으면(또는 `viewportY` 미제공 시) 라이브 최하단으로 보고 숨긴다.
- viewport 상태 갱신은 `terminal.onScroll` 단일 소스에서 일어난다. 휠 스크롤·`scrollToBottom()`·출력 추가 모두 xterm의 onScroll을 발생시키므로 별도 폴링 없이 버튼 표시와 §8.5 overlay caret 표시를 함께 다시 계산한다. disposable은 메인 effect cleanup에서 해제한다.
- 클릭 시 `terminal.scrollToBottom()`을 호출하고 즉시 버튼을 숨긴다(후속 onScroll이 동일 결론을 재확인).
- laymux-dev MCP의 `scroll_terminal`은 같은 live xterm에 `scrollLines(lines)`를 호출해 viewport를 상대 이동하고 현재 `baseY`/`viewportY`를 반환한다. PTY 입력을 합성하지 않으며 release MCP에는 노출하지 않는다([ADR-0025](../adr/0025-dev-terminal-viewport-automation.md)).
- 버튼은 overlay caret / loading 레이어보다 위(`z-index: 5`)에 두어 클릭 가능성을 보장하고, overlay 스크롤바 거터를 피해 우측 16px 여백을 둔다.

### 8.8 분리 입력 컴포저와 sequenced output attach

Remote controller owner의 frontend 배포는 `lib/remote-control-status.ts` 하나가 소유한다([ADR-0128](../adr/0128-app-global-remote-control-status-coordinator.md)). 첫 React 구독자가 window 전역 listener를 설치한 뒤 initial snapshot을 요청하고, Remote active 동안 이전 조회가 끝난 뒤에만 3초 fallback poll을 하나 예약한다. inactive workspace의 `TerminalView`를 포함한 모든 surface는 같은 `useSyncExternalStore` snapshot을 읽으므로 pane 수가 늘어도 Tauri listener·status invoke 수는 늘지 않는다. event revision은 owner event 뒤 늦게 끝난 query를 버리고, Remote→Local `releaseRevision`은 같은 React batch 안에서 active/inactive가 연속돼도 각 terminal의 protected reflow·resize를 한 번 깨운다. 마지막 구독자가 사라지면 listener와 timer를 정리한다.

Terminal surface는 [ADR-0029](../adr/0029-detached-terminal-input-composer.md)와 이를 대체한 [ADR-0034](../adr/0034-single-send-terminal-composer.md)에 따라 `direct`와 `composer` 두 입력 모드를 가진다. Direct는 xterm helper textarea와 raw `terminal.onData` 경로를 유지한다. Composer는 output viewport 아래의 네이티브 textarea가 아직 전송하지 않은 초안의 진실원이며, 사용자 action은 text 뒤에 CR 제출 의도를 보내는 Send 하나만 제공한다. 전송 gesture는 [ADR-0036](../adr/0036-remote-composer-layout-rule.md)의 layout 규칙 `mobileLayout = (pointer: coarse) || localApp=1`을 따른다. desktop layout(PC WebView, fine-pointer 웹 Remote)에서는 일반 Enter가 Send이고 Shift+Enter가 textarea 줄바꿈이다. mobile layout(터치 기기, PC 앱 임베드 모바일 뷰)에서는 Enter가 줄바꿈이며 footer 우측의 Send 버튼만 제출하고, keybinding 시스템 밖의 키보드 전송 단축키는 두지 않는다. 모든 surface에서 IME 조합 중 Enter는 제출하지 않는다. Composer가 차지하는 높이는 xterm host와 겹치지 않고 flex sibling으로 배치되며 모드 전환 뒤 공통 guarded fit을 실행한다. Composer 중에는 xterm native cursor, shadow overlay caret, composition preview를 숨기고 xterm keyboard event를 차단하지만, xterm이 생성한 protocol reply용 `onData`는 유지한다.

PC의 명시적 기본 모드 선호만 `laymux.desktop.inputMode`에 저장하고 최초 기본값은 `direct`다. 현재 모드와 `ComposerDraftState { text, revision, inFlight }`는 terminal id별 runtime Map에만 둔다. Send 시작 시 `{ terminalId, revision, text, token }`을 캡처하고 같은 terminal의 중복 action을 막는다. 전송 중 textarea 편집은 허용하며 성공 응답도 현재 text/revision이 캡처와 같을 때만 비운다. 실패·결과 불명확·stale token은 초안을 보존한다. 데스크톱 surface는 이 runtime Map 을 React state 로 복제하지 않고 `useSyncExternalStore`로 직접 구독한다(현재 모드는 `subscribeRuntimeInputMode`, 초안은 `subscribeRuntimeComposerDraft`). 따라서 `instanceId` 가 바뀌면 재구독 한 번으로 모드·초안이 새 terminal 것으로 갈아끼워지고, 별도의 seeding effect 가 없다. `laymux.desktop.inputMode` 기본값은 terminal 별 **최초 읽기 시점에 고정**된다 — 다른 pane 에서 기본값을 바꿔도 이미 살아 있는 pane 의 모드를 소급해서 뒤집지 않으며, 외부 store snapshot 이 render 마다 흔들리지 않는다. output protocol readiness 도 boolean 이 아니라 "준비를 알린 terminal id" 로 들고 있어 terminal 을 갈아끼우면 파생으로 곧바로 미준비가 된다(issue #567). Remote page는 별도 키 `laymux.remote.inputMode`를 사용하고 저장값이 없으면 coarse pointer는 composer, fine pointer는 direct를 기본으로 하며, 초안/현재 모드는 마찬가지로 runtime terminal Map에만 둔다.

전송한 초안은 `pushComposerHistory`로 **scope 버킷별** runtime Composer history(oldest→newest, runtime Map, 버킷당 최대 200개)에 쌓인다. 버킷 키는 `composerHistoryScopeKey(scope, { terminalId, workspaceId })` 한 곳에서만 도출하며([ADR-0055](../adr/0055-composer-history-scope-setting.md)), `settings.json` 의 `terminal.composerHistoryScope`(`global`(기본)/`workspace`/`pane`)가 스코프를 고른다 — `global` → 고정 키 `global`, `workspace` → `ws:{workspaceId}`(데스크톱은 `resolveWorkspaceId` 로 해석), `pane` → `pane:{terminalId}`. workspace 를 해석할 수 없으면(dock 등) 공유 버킷으로 승격하지 않고 `pane:` 키로 좁게 fallback 한다. 읽기 세 경로와 쓰기가 모두 이 함수를 거치므로 쓰기와 읽기가 다른 버킷을 보는 일이 없다. 스코프를 바꿔도 병합·이관은 없고 다른 버킷을 읽기 시작할 뿐이며, 열려 있던 recall 목록은 버킷 키에 태깅된 상태 파생으로 자동 닫힌다(`historyScopeKey` prop). 수명은 pane 종료 시 그 pane 버킷만(`clearRuntimeComposerState(terminalId)`), 워크스페이스 삭제 시 그 워크스페이스 버킷만(`clearComposerHistoryForWorkspace`), reload 시 전부다. `global` 은 앱 전체가 200 cap 을 공유하므로 오래된 항목이 더 빨리 밀린다. cap 은 스코프와 무관하게 버킷당 200 이다. **입력 내용(초안 텍스트·history 항목·자동완성 후보)은 비밀번호 등 민감정보 누출 방지를 위해 엄격히 in-memory only 다.** 이 history 는 draft 와 마찬가지로 `settings.json`·`localStorage`·`sessionStorage`·서버·로그 어디에도 영속·전송하지 않으며, WebView reload(= `clearRuntimeComposerState`)로 흔적 없이 사라진다([ADR-0029](../adr/0029-detached-terminal-input-composer.md)의 미전송 문자열 비영속 경계 유지). 이 비영속 불변식은 시크릿 문자열이 어떤 web storage/설정 스냅샷에도 새지 않음을 단언하는 회귀 테스트(`terminal-input-composer-state.test.ts`)로 고정했다. 리모트 대응판도 같은 in-memory only 원칙을 따른다. 세 가지 recall 경로가 이 history 를 읽는다. (1) shell prompt 에서 초안 edge 의 ↑/↓ 는 항목을 하나씩 draft 로 불러온다. (2) issue #504: 비어 있고 포커스된 초안에서 **Tab** 을 누르면 `selectComposerHistoryEntries`(최신순·중복 제거·최대 N개, 기본 8)로 만든 목록을 composer 위에 뜨는 listbox 로 보여준다. 각 항목은 한 줄 ellipsis 이고 목록은 `max-h` 로 제한해 화면을 과하게 가리지 않는다. 목록이 열린 동안 ↑/↓·Tab 은 선택 이동, Enter/클릭은 선택 항목을 draft 로 채우기, Escape·편집·blur 는 닫기이며, 이 동안 edge ↑/↓ recall·passthrough·Send 로 키가 새지 않는다. history 가 없으면 Tab 은 기존대로 통과한다. 이 팝업은 `settings.json`의 `terminal.composerHistoryPopup`(기본 on, 설정 UI 토글 제공)로 끌 수 있다. (3) issue #505: 비어 있지 **않은** 초안을 타이핑하는 동안 `selectComposerAutocompleteSuggestions`(prefix 대소문자 무시·최신순·중복 제거·초안과 완전 일치 제외·최대 N개, 기본 8)가 만든 자동완성 dropdown 을 같은 자리에 띄운다. 초기에는 강조 항목이 없어(activeIndex=−1) 일반 Enter 는 계속 Send 로 동작하고, **Tab** 은 강조 항목(없으면 첫 항목)을 draft 로 채운다. ↑/↓ 로 항목을 오가며 강조가 생기면 그때만 Enter 가 선택으로 바뀌고, 강조가 없는 ↑ 는 소비하지 않아 edge recall 로 넘어간다. Escape·편집·blur 는 닫기이며, mouse 클릭도 채우기다. (2)의 Tab 팝업(빈 초안)과 (3)의 자동완성(비어 있지 않은 초안)은 초안 길이로 상호 배타이므로 키/포커스가 충돌하지 않는다. 자동완성은 `settings.json`의 `terminal.composerAutocomplete`(기본 on, 설정 UI 토글 제공)로 끌 수 있다. history 데이터 자체는 설정이 아니므로 두 키 모두 기능 on/off 만 담고 기록은 runtime 에 남긴다. Remote 정적 페이지도 (2)·(3) 두 recall 경로를 동일 설계로 이식했다. 추가로 Remote 는 소프트 키보드에 Tab 키가 없는 터치 기기를 위해, 비어 있는 초안 editor 를 탭/클릭해도 (2)와 같은 recall 팝업을 연다(포인터 제스처라 키바인딩 규칙([api-contracts §15.5](./api-contracts.md)) 밖이고, history 가 없거나 토글 off 면 no-op). 다만 Remote 는 host `settings.json` 을 읽지 않으므로 두 토글과 공유 스코프는 surface-local `localStorage`(`laymux.remote.composerHistoryPopup`/`laymux.remote.composerAutocomplete`, 기본 on / `laymux.remote.composerHistoryScope`, 기본 `global`)에 두고, history 는 페이지 runtime Map 에만 유지해 데스크톱과 동일하게 in-memory only 로 어떤 storage 에도 영속·전송하지 않는다([api-contracts §13.4](./api-contracts.md)).

PTY output callback은 `TerminalProtocolState`로 전체 output의 `CSI ? 2004 h/l`과 reset을 chunk 경계에 걸쳐 추적한다. callback은 terminal별 protocol gate 뒤 generation-scoped sequenced ring과 desktop delivery ledger에 같은 source bytes를 한 번만 기록하고, production PC surface에는 `terminal-output-v3-{id}` bounded envelope를 발행한다([ADR-0095](../adr/0095-terminal-output-bounded-envelope-and-frame-continuation.md)). 현재 guarded one-shot resize 경로는 logical `{revision,cols,rows}`를 갱신한 뒤 별도 control worker에서 physical `MasterPty::resize()`를 호출한다. 그러므로 callback 진입 순서에 대한 logical geometry는 제공하지만, queued-but-unread bytes와 concurrent producer를 포함한 exact physical provenance boundary는 보장하지 않는다. 이 한계의 three-phase 계약과 pure transaction core는 [ADR-0085](../adr/0085-provenance-barrier-three-phase-geometry-cutover.md)/`pty_geometry`가 소유하고 실제 production adapter는 OS/OpenConsole primitive를 추적하는 #643 전까지 fail-closed한다. #636의 interruptible reader는 `Data | Wake(generation) | EOF | Failure`를 구별해 idle control liveness를 제공하지만 provenance boundary나 geometry revision을 만들지 않는다([ADR-0089](../adr/0089-interruptible-pty-reader-is-not-provenance.md)). desktop create는 PTY spawn 전에 sequence 0의 512 KiB bootstrap credit lease를 활성화하고 bootstrap에는 surface가 없으므로 continuation grant를 발급하지 않는다. Remote-only session에는 desktop lease가 없어 기존 bounded subscriber 동작을 유지한다.

ADR-0085의 exact transaction은 resize owner를 고정한 시점의 권위 parser 집합 전체가 old prefix와 new geometry adoption을 각각 ACK해야 한다. Local owner에서는 source PTY stream을 실제 소비하는 PC visible xterm과 rendererless checkpoint의 교집합이 ACK이고, Remote owner에서는 active Remote browser xterm과 rendererless checkpoint의 교집합이 ACK이다. Remote browser ACK는 checkpoint 직렬화 길이가 더해진 wire sequence가 아니라 원본 `sourceSeq`를 사용한다. `PtyGeometryCoordinator`는 owner kind별 정확히 이 두 role만 허용하고 participant disconnect·waiter timeout으로 quorum을 줄이지 않으며, apply/adoption ACK 재전송과 stored latest status를 idempotent하게 처리한다. split ESC/CSI/OSC/DCS/APC/PM/SOS, incomplete UTF-8 scalar 또는 열린 DECSET 2026 frame이면 physical call 없이 `NotApplied`로 abort한다. physical adapter가 `Applied`를 증명한 뒤에는 별도 `commit_authoritative_geometry` seam이 terminal config와 output geometry revision을 권위 있게 commit해야만 `AppliedAwaitingAdoption`으로 간다. 이 logical commit이 실패하면 이미 적용된 physical resize를 rollback했다고 가장하지 않고 즉시 best-effort teardown 후 `Indeterminate` transaction을 quarantine하며, 동일 apply/status 재시도는 physical 또는 logical call을 반복하지 않는다. `NotApplied`는 logical commit을 호출하지 않는다. exact Remote 최초 연결은 현재의 viewport fit→one-shot resize→attach 순서를 사용할 수 없고, Remote lease 중 PC visible xterm도 Remote participant로 승격할 수 없다. production adapter capability가 false인 동안 Local/Remote public `exact` 요청은 logical/physical resize 전에 거절되고 기존 guarded request만 `exact:false`로 동작한다. Remote `exact:true`도 active lease를 먼저 검증하지만 operation permit/FIFO는 만들지 않는다. #643이 양 플랫폼의 실제 provenance primitive를 증명하기 전에는 prepare/apply/status surface protocol과 output release를 production에 연결하지 않는다.

protocol/runtime/ring 기록이 실패하면 그 byte에는 sequence가 없어서 repair할 수 없다. callback은 legacy event·activity·OSC로 우회하지 않고 generation-local fatal request를 claim한 뒤 reader loop에 `Stop`을 반환한다. `AppState` 생성 때 선기동한 cleanup coordinator가 해당 generation만 discard-only retirement하고 handle을 분리하며, reaper coordinator가 handle별 독립 thread에서 모든 락 밖 종료를 수행한다([ADR-0088](../adr/0088-pty-output-fatal-generation-teardown.md)). 정상 attach·ACK·capacity 경로와 authoritative ring의 읽기·쓰기는 mutex poison을 성공 상태로 복구하지 않는다. close/creation rollback/fatal teardown의 retirement는 `lock_or_recover_for_discard`로 poisoned guard를 회수해 `retired`를 공표하고 subscriber/lease와 compatibility projection을 폐기한다([api-contracts §14.3](./api-contracts.md), [ADR-0087](../adr/0087-mutex-poison-fail-closed-discard-only.md)). 회수한 mutex의 poison은 지우지 않아 운영 경로가 조용히 재개되지 않는다.

`attach_terminal_output`은 같은 protocol → runtime 경계에서 raw `{ state: { version, generation, snapshotStartSeq, snapshotSeq, sourceStartSeq, sourceSeq, snapshotKind:"raw", protocolRevision, modes, geometry }, snapshot, flowControl:{token,windowBytes,nextEnvelopeId} }`을 원자 캡처하고 bootstrap/이전 desktop lease를 교체한다. generation당 활성 desktop lease는 하나뿐이고 동일 terminal의 복수 desktop surface는 지원하지 않는다. `token`은 JavaScript `number`로 바꾸지 않는 불투명 문자열이며 `nextEnvelopeId`는 listener가 attach 전에 받아 둔 v3 event와 attach snapshot의 정확한 인계 경계다. recent ring이 오래된 DECSET을 버려도 backend protocol state는 유지된다.

PC attach 순서는 다음과 같다.

```
terminal-output-v3 listener 등록
    → PTY session 생성 + cache load 병렬 시작
    → create 결과의 immutable initialExecutionHost로 renderer gate 확정
    → attach_terminal_output
    → 새 flow token + nextEnvelopeId 설치 → xterm reset
    → cache → restored 구분선 → 한 화면 CRLF → CUP 1;1 → live snapshot
    → visible + rendererless checkpoint가 snapshotSeq까지 parse → parsed ACK
    → backend bracketed-paste state를 xterm parser에 최종 합성
    → nextEnvelopeId 이전 buffered envelope 정리
    → contiguous v3 envelope ownership 인수(receipt)
    → visible + rendererless checkpoint 교집합 parse → parsed ACK
```

네이티브 Windows Codex 세션 복귀에는 startup 색상 응답 guard가 붙는다([ADR-0131](../adr/0131-native-windows-codex-startup-color-reply-guard.md)). Rust는 settings에서 재검증한 exact Codex 복귀 override, 바깥 PTY spawn 대상 `nativeWindows`, configured Codex launcher의 첫 실행 대상 `nativeWindows`가 함께 성립할 때만 공유 guard를 PTY spawn 전에 만들고 명령은 기존처럼 즉시 실행한다. guard는 output callback과 그 generation의 `PtyHandle`에 결합하며 terminal catalog·직렬화 상태에는 넣지 않는다. output callback은 desktop delivery에 bytes를 게시하기 전에 raw stream에서 chunk 경계를 넘는 exact OSC 10/11 `?` query를 코드별로 관측한다. 이후 ADR-0054가 live parser의 non-human data로 확정한 `write_terminal_protocol_reply(id, generation, data)` ingress에서 frontend가 physical live parse generation을 보내고, Rust는 기존 PTY handle lookup의 generation이 일치할 때만 관측된 코드에 대응하는 well-formed RGB reply를 최초 한 번 제거한다. stale reply는 guard 접근과 PTY write 전에 거절하고 한 callback에 섞인 다른 bytes는 보존한다. 두 query/reply 쌍을 모두 소비하면 atomic inactive가 되어 이후 응답에는 내부 lock을 잡지 않는다. fixed color 값·wall-clock cutoff·attach readiness는 판정에 쓰지 않고, guard lock 손상은 reply를 통과시키지 않는 fail-closed 오류다. xterm은 계속 현재 renderer 색상의 유일한 응답 생성자이며 Rust는 색상을 합성하지 않는다. WSL·SSH·비-Windows Codex launcher, Claude, viewer, 일반 profile startup에는 guard가 없다.

cache는 과거 출력이며 새 PTY의 현재 화면 좌표를 소유하지 않는다([ADR-0075](../adr/0075-session-restore-live-screen-origin.md)). 복원 구분선 뒤에 현재 `rows`만큼 CRLF를 써서 cache viewport를 scrollback으로 완전히 밀고 `CUP 1;1`로 xterm cursor를 새 PTY의 화면 원점에 맞춘 뒤 live snapshot을 쓴다. 따라서 ConPTY나 셸이 1행을 절대 좌표로 다시 그려도 복원 프롬프트와 입력 echo가 갈라지지 않는다. 이 합성 blank screen은 runtime 경계이므로 cache serializer는 normal buffer의 live cursor 또는 그 아래 마지막 의미 있는 행까지만 명시적 range로 저장한다. alternate buffer와 live terminal mode는 계속 제외하며, 이미 저장된 cache 내부의 반복 구분선·빈 줄은 사용자 출력과 구분할 metadata가 없어 파괴적으로 정리하지 않는다.

attach snapshot과 각 v3 envelope는 generation/token/source sequence를 clamp하거나 보간하지 않는다. envelope는 physical bytes 최대 64 KiB, logical delta 최대 8,192개, 직렬화 payload 1 MiB 미만을 모두 만족해야 하고 하나라도 넘거나 metadata·geometry·sequence가 모순이면 그 generation을 typed fail-stop한다. frontend ingress는 envelope backing과 logical descriptor를 bounded ownership 안으로 넘긴 뒤 receipt를 보내지만, opener/closing transition이 있으면 해당 hold/close가 먼저 수락되어야 receipt로 다음 envelope slot을 열 수 있다. receipt는 parser 완료를 뜻하지 않는다. 원래 delta 경계는 native Windows stabilizer, WSL recognizer, §8.5 cursor/OSC/alternate-buffer/activity 경로에 그대로 전달하고 rendererless checkpoint만 같은 generation과 동일한 geometry(`revision`·`cols`·`rows`)의 contiguous segment를 최대 256 KiB까지 합친다. 같은 revision에 서로 다른 dimensions가 오면 합치지 않아 checkpoint validation의 typed fail-stop을 보존한다([ADR-0080](../adr/0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)).

Rust delivery worker는 receipt 전 envelope 전체(`data`, `deltaEnds`, `geometryRuns`, envelope/grant identity)를 frozen in-flight 값으로 보존하고 그동안 다음 envelope를 만들지 않는다. bounded event emit 재시도가 실패하거나 emit 성공 뒤 WebView callback이 유실돼도 이 값을 폐기하지 않는다. frontend의 1초 low-frequency watchdog과 관측된 v3 gap/overlap은 `(generation,token,expectedEnvelopeId,grantId,expectedSeqStart)`로 `repair_terminal_output_envelope`를 호출한다. production repair invoke는 일반 control watchdog과 분리된 선언 상수의 15초 deadline을 사용한다. watchdog은 500 ms 이상 늦은 tick을 관측하면 같은 main-thread stall 동안 queued된 Tauri event보다 timer repair가 앞서지 않도록 그 시점부터 정상 watchdog 한 주기의 grace를 둔다. 다만 grace deadline은 직전 관측 tick에서 3초를 넘지 않게 고정한다. `setInterval`의 기존 위상 때문에 grace 안에 일찍 도착한 callback도 deadline을 연장하지 않고 보류하며, deadline 뒤 첫 tick은 반드시 poll한다. 따라서 관측 poll 간격은 최대 3초이고 server-side receipt expiry는 40초라 정상 timer 구간에 최소 37초의 여유를 남긴다. 정상 idle은 아무 작업도 하지 않는다. 특히 receipt 완료 뒤 parsed ACK가 느려 producer pending queue가 쌓인 동안 worker가 아직 다음 envelope를 동결하지 않은 상태도 정상 idle이며, 이 구간의 next frontier는 pending queue tail인 `observedSeq`가 아니라 첫 pending delta의 `seqStart`다. 반대로 emit edge가 실제로 유실됐다면 frozen in-flight가 남으므로 같은 요청은 `exact`를 반환한다. `exact` 응답만 동일 preflight·continuation·queue·visible/checkpoint parser 경로에 정확히 한 번 적용한다. 현재와 직전 immutable envelope만 보관하는 bounded ledger가 event/repair 중복을 byte·delta geometry까지 비교해 dedupe하며 payload가 다르면 identity conflict다. stale session, 현재 in-flight와의 mismatch, malformed 응답 또는 bounded repair 회수 소진은 reset/replay/replacement attach 없이 typed fail-stop한다. exact repair는 생성 시 정한 receipt deadline을 갱신하지 않고 generation당 회수 횟수도 제한하며, receipt 또는 생성 시점 기준 유한 expiry가 delivery/credit waiter를 깨운다. production v3 repair는 기존 raw v2 `resume_terminal_output`을 섞지 않는다. `terminal-output-v2`, `acknowledge_terminal_output`, `resume_terminal_output`과 그 gap-repair/auto-reattach 로직은 구 backend와 fixture를 위한 staged fallback일 뿐 production v3의 liveness 또는 정확성 경로가 아니다([ADR-0126](../adr/0126-terminal-output-repair-timeout-budget.md)).

새 frozen in-flight envelope는 생성 시점부터 최대 1초이자 configured receipt timeout의 절반인 direct-event grace를 가진다. 이 grace 안에서 full identity와 `seqStart`가 일치하는 repair 요청은 emit 성공 여부와 무관하게 typed `eventPending`을 반환한다. 이는 build→emit과 emit→WebView listener 사이에서 watchdog이 정상 event를 선점하지 않게 하며, envelope·repair attempt·receipt deadline을 전혀 바꾸지 않는다. worker는 synchronous emitter 호출 직전 같은 state lock에서 current identity를 재검증하고 독립적인 5초 emitter-call deadline을 arm한 경우에만 호출한다. receipt가 먼저 slot을 비우면 emit을 생략하고, arm 뒤 receipt가 이기면 이미 설치한 deadline이 hung emitter를 유한하게 닫는다. frontend는 `eventPending`을 받으면 보류 중인 delayed-tick grace를 해제하고 다음 interval callback을 반드시 poll한다. 정상 1초 timer 위상에서는 실제 유실이 생성 뒤 2초 이내 `exact`로 복구되어 production 40초 receipt expiry에 약 38초가 남는다. main thread 자체가 지연되면 복귀한 첫 callback이 즉시 poll하며, server-side expiry는 한 번의 5초 stall·최대 3초 repair poll·15초 repair invoke·공유 FIFO의 `hold → close → receipt` 호출별 5초와 2초 scheduling margin을 수용한다([ADR-0126](../adr/0126-terminal-output-repair-timeout-budget.md)). grace가 끝난 뒤 같은 요청은 `exact`이고 mismatch/stale 판정은 grace보다 먼저다.

visible xterm 앞의 `TerminalWriteBatchQueue`는 계속 pane-local single-flight physical byte FIFO, batch materialization, callback과 discard의 유일한 소유자다([ADR-0092](../adr/0092-app-wide-terminal-write-round-robin.md), [ADR-0098](../adr/0098-terminal-parser-weighted-starvation-free-admission.md)). v3 ingress는 backing을 semantic pipeline에 넘기고 queue에는 그 backing의 zero-copy `Uint8Array.subarray()` descriptor를 전달한다. rendererless checkpoint도 pane-local Promise FIFO를 유지하되 physical `xterm.write`는 아래 같은 parser admission을 통과하고, 경쟁 중에는 최대 64 KiB·단독일 때는 최대 256 KiB로 나눈다. queue가 materialize한 visible write와 checkpoint write가 모두 같은 contiguous source prefix를 완료했을 때만 parsed ACK가 전진한다. native stabilizer가 bytes를 보류하면 parsed ACK도 보류되고, receipt나 queue enqueue만으로 ACK하지 않는다. replay/string, stabilized frame, cursor park deadline, authoritative frame end, composition-active write는 barrier이며, hard 상한 128 part·256 KiB와 경쟁 시 64 KiB fairness quantum은 유지된다.

여러 pane의 visible FIFO와 rendererless checkpoint FIFO는 앱 전역 `TerminalWriteFairScheduler`(`terminal-write-fair-scheduler.ts`)에서 physical parser turn을 얻는다([ADR-0092](../adr/0092-app-wide-terminal-write-round-robin.md), [ADR-0098](../adr/0098-terminal-parser-weighted-starvation-free-admission.md)). owner key는 `instanceId`가 아니라 xterm 생성 effect마다 새로 만드는 opaque `Symbol`이며 pane당 하나다. `TerminalParserAdmission`이 이 owner 아래 visible/checkpoint 두 lane을 각각 future callback 하나로 dedupe하고, 둘 다 계속 pending이면 교대한다. 따라서 checkpoint도 global gate를 우회하지 않으며 pane 지분을 두 배로 만들지 않는다. profile 변경으로 같은 id의 replacement effect가 생겨도 old effect의 늦은 callback·pending 취소·unmount release는 새 세대 turn을 건드리지 않는다.

정상 mounted 생명주기의 active admission lease는 앱 전체에 하나다. visible lane의 한 turn은 physical batch 하나이고, checkpoint lane의 한 turn은 Promise FIFO의 인접한 작은 segment callback을 합계 byte quantum과 128-callback 상한 안에서 하나 이상 처리할 수 있다. owner 선택은 dequeue 시점의 최신 committed raw state를 읽는다. owner 선택은 **2단**이다([ADR-0101](../adr/0101-active-workspace-weighted-parser-admission.md)). 1단은 클래스 선택이고 2단은 그 클래스 안의 pane 선택이다. 클래스는 실제 container가 `display:none` 또는 0 px이면 focus 표시보다 우선해 background, 보이면서 focused면 focused, 그 밖의 visible pane은 foreground다. 1단은 pending pane이 있는 클래스만 참여하는 smooth weighted round-robin이며 몫은 `terminal.parserAdmission`(기본 focused 5 · visible 3 · hidden 2, 합이 한 cycle)이다. 2단은 그 클래스의 pending FIFO 선두 pane을 고르고 서비스된 pane은 꼬리로 돌아간다. 따라서 클래스 몫은 pane 수와 무관하고 pane 수는 그 클래스 안에서만 몫을 나눈다 — 비활성 workspace의 pane은 `WorkspaceArea`가 `display:none`으로 두므로 hidden 몫이 곧 "비활성 workspace 전체"의 몫이다. 이전 pane 단위 가중치(4:2:1 + 등급 무관 age promotion)는 hidden pane이 많을수록 활성 workspace 몫이 희석되고 floor가 배분을 지배해 균등 round-robin으로 무력화됐다(issue #686). starvation floor는 두 겹이며 둘 다 클래스 단위다 — 경쟁 클래스 집합이 고정된 구간에서는 몫이 bound를 만들고(pane 최대 대기 `ceil(cycle / 자기 클래스 몫) × 자기 클래스 pane 수`, 기본값에서 hidden N개면 `5N`), 그와 별도로 pending 클래스는 몫과 무관하게 32 turn 안에 반드시 한 turn을 받는다. 절대 floor는 클래스 drain/재진입 구간과 설정이 허용하는 극단 비율(`1000/1000/1`)에서 몫 bound가 성립하지 않기 때문에 필요하다. floor로 구제된 클래스는 balance를 0으로 되돌리고, 경쟁에서 빠진 클래스는 balance·skip 카운터를 버려 재진입이 다른 클래스의 bound를 깨지 않게 한다. pane 단위 age promotion은 없다. 몫 변경은 다음 dequeue부터 반영되며 이전 몫으로 계산된 클래스 balance는 폐기한다. 두 local lane이 모두 saturated이면 특정 lane은 첫 owner 대기 `B`, sibling 한 turn, 다시 owner 대기 `B`를 거칠 수 있으므로 보수적 최대 대기는 `2B + 1` turn이다. 이미 active인 write는 priority 변경으로 선점하지 않는다. checkpoint physical callback 뒤 pane-local host-task lease 안에서 같은 owner가 다시 pending이 되면 두 quantum의 남은 범위에서 즉시 이어 처리하고 weighted balance를 유지한다. byte 또는 callback quantum을 먼저 소진한 owner는 같은 microtask에서 future turn을 requeue한 뒤 global lease를 반환하며, pending이 없는 drained owner만 과거 debt와 owner `Symbol`을 제거한다.

scheduler는 turn을 꺼낸 뒤 **다른 pane owner**가 pending인지 함께 알려 준다. 다른 owner가 기다리면 non-stabilized fresh visible dequeue와 checkpoint turn의 누적 callback bytes는 64 KiB fairness quantum을 사용하고, 없으면 compatible live/checkpoint bytes를 256 KiB까지 처리해 단독 pane 처리량을 유지한다. checkpoint lease는 contention과 무관하게 최대 128 physical callback이며 byte/callback 상한 중 먼저 닿는 경계에서 handoff한다. replay entry는 이 contention 판정과 무관하게 항상 64 KiB 이하의 한 callback barrier다. stabilized string/frame의 최대 1 MiB 원자 write와 materialized retry는 경쟁 중에도 다시 자르지 않는 기존 예외다. 전역 idle 최초 request는 기존 대화형 latency를 보존하려 즉시 제출하지만 active write 뒤의 다음 owner/lane은 새 macrotask에서 시작한다. 브라우저 scheduler는 재사용 `MessageChannel`에서 메시지 하나당 callback 하나를 FIFO로 실행해 xterm parser timer와의 timer nesting clamp를 피하고, 채널이 없거나 생성에 실패하면 `setTimeout(0)`으로 폴백한다. checkpoint Promise chain의 다음 operation이 callback 직후 microtask에서야 보이면 pane-local admission이 global lease를 한 host-task edge 동안 유지한다. visible sibling이 이미 pending이어도 그 sibling은 다음 owner turn에 남겨 두고, 현재 checkpoint turn은 남은 byte·callback quantum에 operation 전체가 들어갈 때만 같은 lease에서 계속한다. byte 수가 불명확하거나 일부만 들어가거나 quantum을 소진하면 same-owner future turn을 먼저 requeue한 뒤 lease를 반환한다. lease를 재사용할 때는 보류한 release timer를 취소해 다음 xterm parser timer 앞에 stale no-op task를 남기지 않는다. 동기 backpressure면 이미 만든 같은 visible batch/buffer를 local FIFO head에 복원하고 전역 lease를 반환한 뒤 16 ms 후 새 turn으로 재시도한다. 전역 scheduler는 payload를 읽지 않고 owner와 contention만 소유하며, pane-local admission이 checkpoint의 실제 requested byte 수와 callback 수를 quantum에서 차감한다. 따라서 v3 ingress와 attach가 정한 byte 전순서 및 local batch barrier는 그대로다. 최초 attach, 사용자 recreate와 구 v2 fallback reattach는 아직 제출하지 않은 old-epoch turn/request를 폐기하되 accepted write의 전역 lease와 parse callback은 유지하고, unmount만 active lease까지 취소한다. unmount/profile replacement에서는 이미 dispose한 old xterm의 accepted callback이 generation마다 최대 하나 늦게 끝날 수 있지만 그 idempotent release는 replacement owner를 건드리지 않는다. production v3 fail-stop은 replacement turn을 만들지 않는다. parsed/replay waiter는 `onDiscard`로 종결하고 이미 drain된 stabilizer callback 묶음도 parsed와 discard 중 하나로만 정확히 한 번 settle한다.

연속 `MessageChannel` handoff가 Tauri event·input·paint task source를 장시간 추월하지 않도록 scheduler는 7개 handoff 뒤 여덟 번째를 `setTimeout(0)` gate를 거쳐 다시 `MessageChannel`로 제출한다. timer는 parser turn을 직접 실행하지 않아 실제 xterm write와 그 내부 parser timer가 non-timer task에서 시작한다. timer fallback은 채널을 사용할 수 없는 경우 모든 handoff에 적용하지만, 정상 browser의 주기적 gate는 channel queue를 비운 채 한 번만 삽입되어 timer nesting clamp를 연속시키지 않는다.

xterm 6.0.0은 accepted write의 callback을 호출한 **뒤에** 내부 pending byte를 차감하고 다음 parser drain을 예약한다. 따라서 callback은 예외가 xterm으로 빠져나가지 않는 완료 경계다([ADR-0084](../adr/0084-desktop-terminal-output-parsed-credit.md)). parse metric, sync-output monitor, logical `onParsed`, stabilized refresh, 다음 FIFO/fit hand-off는 단계별로 독립 실행하며 한 단계 실패가 나머지를 막지 않는다. callback 뒤 실패는 이미 파싱된 byte를 다시 쓰거나 `onDiscard`로 바꾸지 않는다. 실패는 전체·`live`/`replay` source·단계별 카운터에 모두 누적하고, 같은 pane mount의 동일 source+stage 경고는 최초 한 번만 남겨 출력 폭주가 console 폭주로 증폭되지 않게 한다.

desktop producer credit은 coordinator의 `expectedSeq`가 아니라 위 **실제 parse 완료 교집합**이다. 기본 credit `B=512 KiB`를 유지하고, healthy active/re-attach surface가 live stream에서 정상 DECSET 2026 opener를 관측한 경우에만 그 frame의 `frameStartSeq`부터 최대 `F=1 MiB`까지 단 하나의 bounded continuation을 허용한다. bootstrap snapshot에는 surface가 없으므로 grant가 없고 base credit만 쓴다. terminator, malformed, 진행할 때마다 갱신되는 5초 no-progress timeout, `F+1` oversized는 raw bytes를 버리지 않는 fail-open으로 frame 추적을 닫되 다른 frame으로 grant를 옮기지 않는다. 이 credit observer의 5초는 §8.4 native 화면 transaction의 기존 50 ms fail-open과 별개다. surface가 unavailable이거나 grant가 열린 채 dispose/parser failure/stale identity가 되면 reset/replay/replacement attach를 시도하지 않고 generation을 fail-stop한다.

surface 상태의 진실원은 mount-local lifecycle owner 하나다. 같은 generation/token의 visible xterm과 rendererless checkpoint가 모두 alive/ready이고 dispose·parser failure·explicit fail-stop이 없을 때만 `healthy`다. stabilizer hold나 bounded capacity 대기는 healthy backpressure이지 unavailable이 아니다. dispose, 어느 parser의 failure, stale generation/token, delivery-control fail-stop은 `unavailable`이며 backend registry나 queue 길이 같은 간접 신호로 이 판정을 덮어쓰지 않는다.

desktop retained ring과 attach snapshot 상한은 `M = B + F + 2 * R`(`R = TERMINAL_OUTPUT_MAX_READ_CHUNK_BYTES`, 현재 `PTY_READ_BUFFER_BYTES`와 같음) 하나에서 파생한다. active/re-attach snapshot은 정확한 `[parsedAck, writeSeq)` 전체이며 tail clamp나 frame 중간 절단을 하지 않는다. retained length가 `M`과 정확히 같을 때도 ACK 전 oldest byte를 eviction하지 않고 다음 append를 mutation 전에 막는다. eviction은 parsed ACK보다 작은 prefix에만 허용한다. Remote의 screen-checkpoint snapshot, 1 MiB 절대 상한, subscriber overflow/gap/reconnect 계약은 이 desktop 상한과 별개이며 변경하지 않는다.

receipt·hold·close는 모두 `(terminal id,generation,lease token,envelope id,grant id)` 전체 identity와 immutable payload를 사용한다. hold는 DECSET opener를 실은 envelope와 `frameStartSeq`에 결합하고, close는 active grant를 실은 closing envelope와 `closeSeq`·reason에 결합한다. 같은 identity/payload retry는 idempotent하며 stale completion은 현재 receipt slot, grant, parsed frontier를 바꾸지 않는다. 같은 identity의 다른 payload, 잘못된 opener/closing envelope 또는 sequence 범위는 typed identity conflict다. frontend는 호출마다 5초 watchdog을 두고 같은 identity/payload로만 retry한다. WebView/window-scoped registry가 receipt/hold/close의 공유 delivery FIFO와 terminal-local 6개·WebView-global 6개 orphan hard cap을 소유하며, attach와 parsed ACK의 기존 독립 budget은 유지한다([ADR-0086](../adr/0086-terminal-output-control-epoch-watchdog.md)). parsed ACK sender는 정상 composite capacity가 찼을 때 generation/token을 바꾸지 않는 logical waiter 하나로 FIFO에 남고, 대기 중 contiguous parsed prefix를 최신 prefix까지 coalesce한다. slot 전에는 command watchdog을 시작하지 않으며 screen reset/replay나 replacement attach를 만들지 않는다. registry는 unmount·stale owner의 waiter와 미사용 reservation을 반환하고 다음 eligible waiter를 깨운다. 실제 command timeout과 timed-out orphan hard cap은 기존 fail-stop 경계를 유지하며, cap 도달도 waiter를 깨워 정상 포화와 구분한다([ADR-0094](../adr/0094-terminal-output-control-capacity-admission.md)). cap의 orphan 수에는 watchdog이 실제 timeout으로 표시한 미정산 Promise만 포함한다. 정상 in-flight가 capacity를 채운 동안 새 호출은 fail-stop하지 않고 공유 FIFO에서 lease 반환을 기다린다. backend는 receipt와 active grant의 server-side expiry를 각각 선언 상수의 40초로, synchronous emitter call·delivery worker shutdown·hard ceiling에서의 parsed-progress expiry를 각각 5초로 소유하고 expiry·retire·유효 ACK/close 때 delivery·credit waiter를 반드시 깨운다([ADR-0126](../adr/0126-terminal-output-repair-timeout-budget.md)). 어떤 hard ceiling도 영구 대기가 될 수 없다.

contract violation, receipt/grant/progress expiry, control orphan cap 또는 surface unavailable은 `healthy | backpressured | failStopped` backend 상태와 reason, generation/token, ring/delivery/parsed bounds로 남고 pane readiness를 false로 만든다. mount-local lifecycle owner가 `unavailable`을 확정하면 current generation/token과 허용 reason만 `fail_stop_terminal_output_surface`로 backend SoT에 게시한다. stale identity는 상태를 바꾸지 않고 `false`, 잘못된 reason은 오류다. backend가 receipt/grant/progress/identity 실패를 먼저 확정한 경우에도 같은 delivery close owner가 `terminal-output-fail-stopped`를 camelCase `{terminalId,generation,leaseToken,reason}`로 정확히 한 번 emit한다. UI는 pane 상단의 지속 경고 바로 명시적인 “output stopped” 상태와 typed reason을 표시하며 자동 screen reset, snapshot replay, replacement attach로 숨기지 않는다. 경고 바의 재시작 버튼은 pane 소유자의 기존 fresh-terminal restart 경로를 호출해 현재 runtime CWD를 우선 보존한 새 generation을 만들며, 사용자가 누르기 전에는 아무 복구도 시작하지 않는다. 복구 계약은 이처럼 사용자가 해당 terminal을 명시적으로 close/recreate하는 것뿐이다. 이 fail-stop은 transport/credit 경계이고 authoritative protocol/ring 기록 자체가 실패한 경우에는 ADR-0088의 generation teardown을 따른다.

production v3 lease의 parsed ACK 검증 실패는 구 v2 prefix ACK로 보간하지 않고 identity fail-stop한다. v2-only backend처럼 v3 delivery worker가 시작되지 않은 compatibility lease만 legacy ring prefix ACK를 사용할 수 있다. receipt는 delivery ownership 수락 뒤 flow projection까지 하나의 terminal result를 가진다. 두 번째 projection이 실패하면 그 오류를 exact receipt identity에 보존하고 delivery를 fail-stop하며, 이후 같은 payload retry도 성공 duplicate가 아니라 최초와 같은 오류를 반환한다.

파이프라인 비용은 `terminal-output-pipeline-metrics.ts`의 terminal별 카운터로 센다(`deltaEvents`·`deltaBytes`·`segmentsIn`·`writeRequests`·`xtermWrites`·`xtermWriteBytes`·`writeQueueMaxDepth`·`writeQueueMaxBytes`·`writeBatchMaxParts`·`writeBackpressure`·`writeCallback*Failures`·`writeSubmitMaxMs`·`xtermParseMaxMs`·`checkpointApplies`·`fits`·`fitDeferredMaxMs`·`atlasRebuilds`·`attaches`·`attachReplayBytes`). callback failure 묶음은 전체와 source(`live`/`replay`), stage(`metrics`/`monitor`/`consumer`/`refresh`/`drain`/`unknown`)를 각각 센다. 이 값은 진단 전용이고 수명은 백엔드 세션 하나다. 읽는 곳은 `GET /api/v1/diagnostics/frontend`이며, 그 경로는 프론트를 경유하지 않으므로 **메인 스레드가 멈춰 있는 동안에도 답한다**([api-contracts.md §12](api-contracts.md)). `writeRequests / xtermWrites`와 `writeBatchMaxParts`가 visible batching 효과, queue depth/bytes와 submit/parse max가 stall 위치, `writeBackpressure`가 미수락 batch 재시도, `writeCallback*Failures`가 accepted byte 뒤 embedder 완료 실패, `attachReplayBytes`/`attaches`가 "레이아웃 변경이 snapshot replay를 유발하는가"의 직접 반증, `fitDeferredMaxMs`가 정확성 gate 뒤에서 fit이 기다린 시간이다.

기존 v2 fallback의 gap/repair/re-attach 카운터와 screen test는 구 backend/fixture 호환성만 검증한다. production v3 완료 판정은 envelope/receipt/parsed frontier, frozen-envelope exact repair와 once-only dedupe, retention equality, continuation 정상/timeout/malformed/oversized, fail-stop reason을 직접 검증한다. event를 한 번 버린 fault injection에서도 repair 후 marker·retained ring·visible/checkpoint cell grid와 serialized screen state가 lossless 경로와 같은 source prefix와 내용을 가리키는지 실제 xterm screen tier에서 비교하고, 같은 repair를 두 번 적용하는 sabotage가 양성 대조로 실패해야 한다([ADR-0074](../adr/0074-xterm-cell-grid-screen-test-tier.md)). 실제 앱 screenshot은 hidden parser의 source-prefix oracle이 아니라 active-flood 중 현재 workspace의 응답성·blank/reset/foreign-pane 표시를 확인하는 별도 observer이며 [ADR-0098](../adr/0098-terminal-parser-weighted-starvation-free-admission.md)의 capture-start frontier와 시각 검토 계약을 따른다.

tracked xterm write는 각 요청에 `replay` 또는 `live` source를 붙이고 xterm callback FIFO와 같은 순서로 parse context와 output generation을 유지한다. cache·snapshot·복원용 합성 write 중 xterm이 만든 terminal reply는 폐기하고, contiguous live PTY delta를 parse하며 만든 reply만 Tauri `write_terminal_protocol_reply(id, generation, data)`로 같은 generation의 PTY FIFO에 전달한다. backend는 현재 `PtyHandle` generation과 다른 요청을 write 전에 거절한다. 이 전용 경로는 human-control owner permit을 요구하지 않으므로 Remote lease가 활성 또는 Local owner 상태가 아직 unknown이어도 OSC 10/11 같은 emulator response가 유실되지 않는다. Rust가 같은 query에 중복 응답하거나 response byte allowlist로 출처를 추정하지 않는다. 단, ADR-0131의 backend-validated native Windows Codex 복귀 guard는 이 origin 분류가 끝난 전용 경로에서만 선행 exact startup query와 대응하는 최초 OSC 10/11 RGB reply를 제거한다. 이는 출처 추정이나 대체 응답 생성이 아니라 Codex의 만료된 Win32 input wait로 늦은 reply가 재진입하지 못하게 하는 generation-local lifecycle 예외다.

Remote 브라우저 xterm은 display mirror이고 PC xterm만 terminal protocol query에 응답할 수 있다([ADR-0068](../adr/0068-remote-terminal-query-single-responder.md)). snapshot·replay 중 생긴 `onData`는 전부 폐기하고, live output의 CSI DSR·DA·DECRQM·XTVERSION과 query slot을 하나라도 포함한 OSC 4/10/11/12 색상 payload는 parser handler가 원천 차단한다. Remote lease·input mode와 무관하게 reply를 `/write`로 보내지 않는다. PC xterm surface가 unmount된 동안에는 responder가 0개일 수 있으며, backend surface election을 도입하기 전까지 duplicate stdin 방지를 우선한다. OSC parser handler는 payload 전체를 claim해야 하므로 혼합 payload의 query slot만 제거하고 setter slot은 고정 xterm 6.0.0의 private color setter handler를 현재 parser 위치에서 동기 호출한다. 색상 index·target offset·상대 순서를 보존하며 `terminal.write()` 재진입은 금지하므로 같은 delta 뒤쪽의 setter/reset이 항상 이긴다. setter-only payload는 xterm 기본 handler로 넘기고, 혼합 payload에서 private adapter가 없으면 reply 또는 비동기 재생으로 fallback하지 않고 loud failure로 처리한다.

keyboard·IME·paste·mouse·focus에서 생기는 human input은 xterm data emission 전에 막는다. remote owner snapshot을 알기 전과 Remote 활성 중에는 xterm `disableStdin`을 켠다. 고정 버전 xterm 6.0.0의 ESM·CommonJS 번들은 postinstall에서 gate를 `disableStdin && wasUserInput`으로 좁혀 human data만 차단하고 parser-generated reply는 유지하며, exact pattern이 바뀌면 설치를 실패시킨다. custom key handler와 structured paste/composer도 같은 fail-closed 상태를 확인한다. 공개 `onData`가 버리는 `wasUserInput` origin은 고정 버전 private `CoreService.onUserInput` 동기 신호로 복원해 timer로 지연된 IME commit도 human으로 분류하고, wrapper capture event는 xterm이 user bit 없이 만드는 focus/mouse report를 보완한다. private origin adapter가 없으면 ambiguous live data도 human으로 fail-closed한다. replay reply는 폐기하고 신뢰 가능한 live parser reply만 전용 `write_terminal_protocol_reply`를 사용한다. human route는 전송 직전에 Local owner 상태를 다시 확인한 뒤 owner-gated `write_to_terminal`을 사용하며 backend permit이 최종 권한 경계다([ADR-0054](../adr/0054-xterm-human-and-protocol-data-origin.md)).

Composer와 clipboard paste는 Tauri `write_terminal_input(id, text, submit)` 또는 Remote `/remote/v1/terminals/{id}/input`으로 intent만 보낸다. Composer Send는 항상 `submit=true`, Direct clipboard paste는 `submit=false`다. 비동기 smart-paste 결과를 PTY로 보내기 직전에도 현재 모드가 `direct`인지 다시 확인하므로, clipboard 조회 중 Composer로 전환된 입력은 draft 경계를 우회하지 않는다. Rust가 줄바꿈을 CR로 정규화하고 authoritative bracketed-paste 상태가 켜져 있으면 text 부분만 `CSI 200~`/`CSI 201~`로 감싼 뒤 선택적 submit CR을 붙인다. 사용자 키·mouse/focus reporting·Remote soft key는 기존 raw write 경로를 사용한다. Local/Remote raw write, structured write, resize는 모두 backend human-control owner permit을 등록한 뒤 PTY table lock을 놓고 실제 I/O를 수행하므로 frontend lease status는 UX fail-closed 장벽이고 backend permit이 최종 권한 경계다. live parser가 생성한 terminal protocol reply만 위 전용 non-human 경로를 사용한다.

terminal output의 생성·attach·retire는 id-only table 조합이 아니라 generation-scoped `TerminalOutputSession` 하나가 protocol state, sequenced ring, authoritative geometry, subscriber 목록, retirement를 함께 소유한다. PC `TerminalView`는 visible renderer와 별도로 open하지 않은 rendererless xterm checkpoint model을 등록하고, raw attach가 seq 0부터 재구성 가능한 경우에만 동일 snapshot/delta와 geometry를 순서대로 적용한다. 모델은 visible renderer와 동일한 Unicode provider를 사용한다.

PTY output callback은 `PtyOutputControl::Continue | Stop`을 reader loop에 명시적으로 반환한다([ADR-0088](../adr/0088-pty-output-fatal-generation-teardown.md)). authoritative protocol/runtime/ring 기록이 실패하면 캡처한 `TerminalOutputSession`의 generation-local atomic request를 정확히 한 번 claim하고 `Stop`을 즉시 반환하므로 이후 master read, legacy event, activity·OSC 처리가 없다. desktop transport·credit·timeout 실패는 해당 output surface를 관측 가능한 fail-stop으로 만들고 reader를 중단하지만 정상 capacity 문제를 데이터 손상으로 승격해 terminal generation을 자동 삭제하지 않는다. attach 전 실패는 lease token 없는 backend notice와 current-generation typed attach 결과로 수렴하고, frontend는 후자를 확인하면 대기 중인 retry timer를 취소해 구 v2 replacement attach를 시작하지 않는다. cleanup coordinator가 terminal catalog 락 아래 current session의 `Arc` identity를 확인한 뒤 그 generation의 registry/protocol/ring compatibility projection과 PTY handle만 분리하고, handle별 독립 reaper가 `PtyHandle::terminate()`를 callback과 모든 AppState 락 밖에서 수행한다. reaper thread 생성 실패는 handle을 잃지 않고 재시도하며 하나의 platform terminate 지연은 다른 terminal cleanup/reaper를 막지 않는다. handle 설치 전 fatal은 registration retirement와 create rollback이 아직 미설치 handle을 종료하고, 설치 후 fatal은 cleanup이 map에서 handle을 한 번 추출한다. `exec_locks`는 generation을 entry identity에 포함하므로 모든 AppState 락을 놓은 뒤 old generation entry만 지워 같은 id의 새 generation을 건드리지 않는다. write/execute는 async exec lock 선택 때의 generation을 끝까지 보존하고, 실제 write 직전 `terminals → output session registry → pty_handles` 임계구역에서 generation을 재검증해 해당 handle을 clone한다. 이후 body·CR은 clone만 사용하므로 close 뒤 same-id generation이 생겨도 id 재조회로 입력이 전이되지 않는다. explicit close·rollback·stale job은 같은 조건부 retirement로 수렴한다. sequenced ring에 기록된 뒤의 v3 event emit 실패는 frozen in-flight envelope의 exact pull로 복구하는 delivery loss라 이 fatal 경로에 들어가지 않는다.

Remote Direct/Cloud attach 순서는 다음과 같다([ADR-0069](../adr/0069-remote-render-checkpoint-attach.md)).

```
Remote가 xterm을 현재 viewport에 fit
    → 같은 lease로 PTY resize 완료를 기다린 뒤 output attach 요청
    → backend가 현재 { generation, source seq, geometry } target 캡처
    → frontend bridge가 checkpoint model의 write FIFO가 target까지 도달하기를 기다림
    → xterm SerializeAddon으로 screen checkpoint 생성
       (normal/alternate buffer + viewport + cursor/mode, scrollback은 soft budget)
    → backend가 generation/geometry/ring suffix를 검증
    → 같은 session lock에서 checkpoint 뒤 raw suffix 캡처 + subscriber 등록
    → frontend bridge 대기 동안 lease가 유지됐는지 재검증
    → screen checkpoint + raw suffix를 첫 snapshot으로 전송
    → browser가 attach state geometry에서 reset + replay한 뒤 viewport fit 재개
    → checkpoint byte 길이를 더한 wire sequence로 contiguous live delta 전송
```

checkpoint가 캡처되는 동안 resize·출력·재생성이 경계를 바꾸면 최대 3회 새 target으로 재시도한다. raw suffix가 ring에서 밀렸거나 안정화되지 않으면 부분 화면을 보내지 않고 stream을 닫아 새 attach를 유도한다. Remote 브라우저는 WebSocket을 열기 전에 자신이 사용할 `cols/rows`의 `/resize`가 끝나기를 기다리고, attach 중 ResizeObserver fit을 보류한다. snapshot geometry가 그 사이 viewport와 달라져도 serialized ANSI를 반드시 `state.geometry`에서 먼저 파싱한 뒤 일반 fit을 재개한다. checkpoint bridge는 최대 수 초가 걸릴 수 있으므로 Direct와 Cloud 모두 subscriber를 얻은 직후 첫 snapshot을 보내기 전에 active lease를 다시 확인하며, 이 사이 release·expiry·reclaim이 이기면 생성한 attachment를 폐기한다. `snapshotMaxKib`는 scrollback의 소프트 예산이고 현재 viewport·alternate buffer·복원 mode는 최소 checkpoint로 보존하며, 전체 직렬화에는 1 MiB 절대 상한을 둔다. Direct와 Cloud는 이 단일 attach 경로를 공유하고 Cloud도 첫 snapshot을 한 data frame으로 유지한다. Cloud에서 checkpoint 준비·geometry/ring 경합 같은 일시 오류는 retryable `terminal_output_gap`, terminal 소멸은 non-retryable `terminal_not_found`, malformed/상한 초과는 non-retryable `terminal_output_unavailable`로 구분한다. 큐 overflow는 `Gap`, terminal close/재생성은 `Retired`로 전달되며 consumer는 두 경우 모두 기존 stream을 닫고 새 generation snapshot에 attach한다. terminal create는 session generation을 먼저 reserve하고 PTY spawn·table install 후 commit하며, 생성 중 close가 들어오면 reservation을 취소해 뒤늦은 commit이 고아 PTY를 남기지 못하게 한다.

human-control permit은 등록 시점의 owner epoch·absolute deadline·operation id와 pre-enqueue/enqueued phase를 가진다. 같은 terminal의 PTY enqueue는 permit 등록 순서를 따르므로, 먼저 등록된 structured input이 protocol mode를 캡처하는 동안 뒤의 raw Enter·Ctrl+C·soft key·resize가 FIFO를 앞지를 수 없다. Structured input이 protocol gate를 기다리는 동안 owner 전환이 시작되면 아직 물리 큐에 들어가지 않은 permit을 취소·분리해 transition barrier가 protocol lock 소유자를 기다리지 않는다. PTY enqueue는 owner gate에서 phase 전환과 함께 직렬화하여 transition이 pre-enqueue 취소와 queued cancellation 중 하나를 반드시 선택한다. 이미 queued/running인 작업은 terminal별 bounded FIFO worker가 owner token을 각 physical operation 전후에 확인하고, 취소가 grace를 넘기면 PTY를 input-fault 격리한 뒤 worker completion을 owner barrier에 quarantine한다. reclaim·release·access disable·sticky lease expiry는 epoch을 먼저 올리고 이 acknowledgement가 drain된 뒤에만 lease를 제거해 Local owner를 공개한다.

### 8.9 앱 blur/focus 왕복의 helper textarea focus 소유권 (issue #530)

pane focus 는 store 가 소유하고 `TerminalView` 의 focus effect 는 `isFocused` **변화**에만 `terminal.focus()`/`blur()` 를 호출한다. 앱이 Alt-Tab 으로 비활성화되면 WebView 가 xterm helper textarea 의 실제 DOM focus 를 `body`/`null` 로 떨어뜨릴 수 있는데, store 값은 그대로이므로 복귀 시 어떤 effect 도 재실행되지 않아 첫 키/첫 한글 조합이 유실된다. 이를 pane-local focus 소유권 기록으로 좁혀 복구한다([ADR-0057](../adr/0057-terminal-helper-focus-ownership.md)).

- 판정 로직은 `ui/src/lib/terminal-focus-ownership.ts` 의 `createTerminalFocusOwnership` 이 전부 소유한다(DOM 이벤트 등록 없음, 순수 컨트롤러). `TerminalView` 는 window `blur`/`focus`/capture `pointerdown` + surface `focusout` 배선, helper의 입력 활동 통지, helper 재바인딩·pane focus 해제 통지만 담당하며, IME 조합 컨트롤러(`ime-composition-controller.ts`)는 focus 소유권을 알지 않는다.
- **기록(window blur)**: `document.activeElement` 가 helper textarea 이고 그 helper 가 이 pane 의 surface(`wrapperRef`) 안에 있을 때 identity 를 기억한다. store 의 pane focus 만으로는 기록하지 않으므로 composer 모드(focus 가 composer textarea)는 이 경로가 no-op 다.
- **blur 이전 focus 소실 순서**: webview 가 window `blur` 보다 먼저 DOM focus 를 `body` 로 되돌리는 순서도 있어, surface `focusout` 중 `relatedTarget` 이 없는 것만 fallback 후보로 들고 있다가 blur 시점 focus 가 주인 없는 상태일 때 채택한다. `relatedTarget` 이 실제 요소인 focusout(다른 pane·composer 로의 이동)은 후보로 남기지 않고, surface 밖 pointer press·helper 교체·dispose 에서 후보를 버린다. 실기에서 어느 순서인지 미확인이므로 양쪽을 방어한다.
- **복원(window focus)**: focus 시점에 다른 요소가 focus 를 쥐고 있으면 기록을 버리고 아무것도 하지 않는다. focus가 주인 없는 상태(`null`/`body`/`documentElement`)이면 다른 UI가 focus를 정할 시간을 주도록 다음 animation frame에 재확인한 뒤 `helper.focus({ preventScroll: true })`로 복원한다. Windows WebView2에서 helper가 여전히 `activeElement`면 same-helper `blur()` → `focus()`가 DOM에서는 성공해도 네이티브 IME/TSF 문맥이 stale인 재발 경로가 실측됐다. 이 stale-active 분기는 다음 물리 입력 task보다 앞선 window-focus microtask에서 helper를 blur하고, 같은 surface의 tab/pointer 비접근 빈 textarea `.terminal-ime-focus-relay`가 실제 focus를 한 번 소유했다가 놓은 뒤 원래 helper로 돌아온다([ADR-0108](../adr/0108-windows-ime-editable-focus-relay.md), [ADR-0082](../adr/0082-terminal-helper-ime-focus-refresh.md) 대체). 이는 Alt+방향키 pane 왕복에서 회복을 만든 **서로 다른 editable identity** 전환만 재현하며 store pane focus는 바꾸지 않는다. relay는 평소 disabled + `aria-hidden`이고 handoff 중에만 enabled + 접근 가능한 이름 상태가 된다. helper/relay focus 이벤트마다 generation·dispose·현재 surface의 helper/relay identity와 연결을 다시 확인하며, pane 전환·unmount·모달·검색창·설정 입력·다른 pane helper가 끼어들면 기술 focus를 놓고 복원을 취소한다. 같은 window-focus 호출 스택에서 합성 입력이 이미 시작된 경우만 예약을 취소하고, handoff 진입 뒤 기술 blur/focus가 만든 동기 input 통지는 자기 복구를 취소하지 않으며, 다음 task의 실제 입력 이벤트는 stale 문맥이 건강하다는 증거로 취급하지 않는다. Linux의 DOM-active helper는 cycle하지 않고, 진행 중 조합은 §8.16의 기존 blur 확정 경로가 소유한다 — 앱 활성화 시 전역 `terminal.focus()` 는 어디에서도 호출하지 않는다.
- **stale 정리**: helper 미연결/surface 밖, xterm 의 helper 교체(`bindHelperTextareaEvents`), pane focus 해제(다른 pane·워크스페이스 전환·앱 비활성 중 automation 변경), surface 밖 pointer press(재활성화 클릭의 handoff), unmount(dispose) 중 하나라도 발생하면 기록을 버리고 되살리지 않는다. 멀티-pane 에서는 각 pane 이 자기 helper 만 복원하므로 DOM 순서상 첫 helper 로 잘못 돌아가지 않는다.
- **같은 pane의 view/profile 전환**: `PaneControlBar`의 native view selector는 option 확정 직후에도 DOM focus를 계속 소유하므로, 선택값을 store에 반영하기 전에 selector를 blur한다. 같은 pane에서 profile만 바뀌면 grid의 `isFocused`가 변하지 않은 채 xterm과 PTY가 재생성되므로 새 `TerminalView`가 open 시 helper를 다시 focus하고, 중립값으로 다시 등록된 terminal-store의 `isFocused` projection도 현재 pane focus에서 즉시 복원한다. selector에 focus가 남거나 다음 pane focus transition만 기다리면 새 WSL shell은 준비됐어도 실제 키보드 입력을 받지 못한다.
- **진단**: `focus-ownership-captured`/`-reclaim-scheduled`/`-reclaimed`/`-reclaim-declined`/`-relay-skipped`/`-cleared` 이벤트를 기존 cursor-trace 채널(§8.5 와 동일 sink)에 `activeElement` 문자열과 함께 남긴다. `-reclaimed`는 DOM-active helper cycle 여부(`refreshedActiveHelper`)와 distinct relay의 실제 focus 소유 여부(`usedFocusRelay`)를 구분한다. helper blur·relay focus/blur 중 다른 UI가 focus를 얻으면 단계별 reason으로 거절한다. DOM trace만으로 네이티브 IME 복구를 확정하지 않고, 외부 foreground 탈취 뒤의 headful Windows 조합까지 확인한다.

### 8.10 Unicode 셀 폭 / grapheme 계약

터미널 셀 폭과 grapheme 클러스터 경계는 `ui/src/lib/terminal-unicode-width.ts` 한 곳이 소유한다([ADR-0058](../adr/0058-single-terminal-cell-width-provider.md)). 이 모듈이 xterm 의 `IUnicodeVersionProvider`(`wcwidth` + `charProperties`)를 구현하고, `TerminalView` 는 `new Terminal()` 직후 — `terminal.open()`·PTY write·세션 restore write 보다 앞에서 — `activateTerminalUnicodeProvider(terminal)` 로 등록·활성화한다. `allowProposedApi` 가 필요하며 실패를 삼켜 기본 provider 로 되돌아가지 않는다. 프로덕션 xterm 인스턴스는 `TerminalView` 한 곳에서만 만들어지므로 모든 데스크톱 pane 이 같은 provider 를 쓴다.

IME composition preview 는 같은 모듈의 `stringCellWidth`(총 폭)와 `splitCellClusters`(클러스터+폭)만 사용한다. `getCompositionPreviewLayout` 은 코드포인트가 아니라 이 클러스터를 분할 단위로 삼으므로 ZWJ sequence·variation selector·combining mark·skin tone modifier·regional indicator pair 가 행 경계에서 쪼개지지 않고, 남은 셀보다 넓은 클러스터는 통째로 다음 행으로 내려간다. 정확히 줄을 채운 폭 2 문자는 같은 행에 남고 caret 만 다음 행 0열로 정규화하는 기존 규칙은 유지한다.

폭 규칙: Unicode 11 기준 East Asian Wide/Fullwidth = 2, `\p{Mn}`/`\p{Me}`/`\p{Cf}` 와 conjoining Hangul jamo(`U+1160`–`U+11FF`) = 0, ambiguous = 1. **`\p{Mc}` 는 zero-width 집합에 넣지 않는다** — `Mc` 는 Spacing_Combining_Mark 라 정의상 커서를 전진시키고, wcwidth 관례도 `Mn`/`Me` 만 0 으로 둔다. 실측: `Mc` 471개 중 467개가 폭 1 이고 xterm V6 와 정확히 일치한다(데바나가리 `U+0903`/`U+093B`/`U+093E`, 타이 `U+0E33`, 라오 `U+0EB3`, 발리 `U+1B44` 등). 나머지 4개(`U+302E`/`U+302F` Hangul tone mark, `U+16FF0`/`U+16FF1` Vietnamese reading mark)는 EAW W 로 `WIDE_RANGES` 안에 있어 폭 2 다 — V6 는 `U+302A`–`U+302F` 를 `Mn`/`Mc` 구분 없이 뭉텅이로 0 처리해 이 둘에서 갈린다. V6 에 맞추려고 `Mc` 를 0 으로 접으면 467개 Indic/SEA 마크의 폭이 조용히 바뀌므로 하지 않는다. 네 개를 테스트가 고정한다(issue #547).

이 판정을 지배하는 기준은 정의(`Mc` = spacing)가 아니라 **ADR-0058 의 불변식 — PTY 반대편 프로그램이 계산하는 폭과 같은가**다.
Kuhn/glibc 계열 `wcwidth` 는 combining 테이블에 `Mn`/`Me` 만 담고 나머지는 EAW 로 넘기므로 셸·TUI 는 `Mc` 를 EAW 값으로 센다 —
우리 답이 그쪽과 같고 xterm V6 의 0 이 이상치다. 폰트가 이 글리프를 advance 0 으로 그리는 것은 **다른 축**이다:
글리프는 어긋나 보여도 열 산술은 셸과 일치하고, 폰트에 맞춰 폭을 0 으로 접으면 오히려 그 일치가 깨진다.
폰트 확인은 시각 QA 이고 폭 결정을 뒤집는 근거가 아니다.

`WIDE_RANGES` 는 UCD 대조로 **`EastAsianWidth=W ∪ F` 의 부분집합**임이 확인됐다 — 멤버 전부가 Unicode 17 에서 W/F 이고,
W/F 이면서 `gc=Mc` 인데 테이블에 없는 코드포인트는 0개다. `Mc` 근거가 이 부분집합 성질에 의존하므로 테이블을 편집할 때 지켜야 하는 불변식이다.
헤더 주석이 한때 "Unicode 11 baseline plus later emoji blocks" 라고 적었는데 **틀렸다** — 719개가 Unicode 11 에서 W/F 가 아니고 전부 emoji 도 아니다
(IDC `U+2FFC`–`U+2FFF`, `U+31BB`–`U+31BF`, `U+16FE2`–`U+16FE4`, `U+16FF0`–`U+16FF1`, Tangut Components, Khitan, Kana Ext-B, Nushu/Kana).
특히 `U+16FF0`/`U+16FF1` 은 Unicode 13 의 비-emoji 추가라 그 주석으로는 자기 존재가 설명되지 않는다.
반대로 Unicode 17 에서 W/F 인데 테이블에 없는 349개(Yijing `U+4DC0`–`U+4DFF`, Tai Xuan Jing, trigram, counting rod)는 EAW 값이 11 이후 바뀐 것이며,
추가는 별 결정이다 — 코드포인트를 넓히면 모든 표면의 wrap 열이 한꺼번에 바뀐다. `emoji + VS16` 은 클러스터 폭 2 로 승격하고 VS15 는 승격하지 않는다.

extender 승격·결합은 **앞 셀의 base 속성을 본다**. VS16 은 앞이 `\p{Emoji}` 일 때만 폭 2 로 승격하고(키캡 base 인 ASCII 숫자·`#`·`*` 가 여기 들어오므로 `\p{Extended_Pictographic}` 이 아니라 `\p{Emoji}` 다), 그 밖에서는 폭 0 selector 로 결합만 한다 — `a` + VS16 은 1 셀이다. 스킨톤 modifier 는 앞이 `\p{Emoji_Modifier_Base}` 일 때만 결합하고, 아니면 자기 몫 2 셀을 갖는 독립 클러스터가 된다(`a` + 스킨톤 = 3 셀). 이 판정에 필요한 앞 코드포인트 속성은 property value 의 state 필드 상위 비트로 실어 보낸다 — `charProperties` 는 앞 코드포인트 자체를 받지 않기 때문이다.

grapheme 결합은 별도 segmenter 없이 `charProperties` 의 `shouldJoin` 비트로만 표현하며, property value 비트 배치는 xterm 내부 `UnicodeService` 와 호환을 유지해야 한다(xterm 버전 상향 시 확인 대상). `charProperties` 는 출력 코드포인트마다 호출되므로 조회는 Unicode 전 범위를 덮는 lazy `Uint8Array` 캐시(엔트리당 폭 + emoji base 속성)로 상시 O(1) 을 유지한다. 캐시 상한을 SMP 아래로 두면 CJK 확장 B–D 가 캐시를 우회해 코드포인트마다 정규식을 돌게 된다. 판정 순서는 **zero-width 카테고리 먼저, wide 나중**이어야 한다 — 두 집합은 서로소가 아니고 `U+302A`–`U+302D`·`U+3099`·`U+309A`·`U+16FE4` 7개가 `Mn` 이면서 wide 구간 안에 있다(`U+3099`/`U+309A` 는 NFD 일본어의 濁点/半濁点이다). wide 를 먼저 보면 이 7개가 폭 2 가 되고 `charProperties` 의 `width === 0` 결합 조건도 통과하지 못해 독립 클러스터가 된다. 순서를 바꿔 얻을 성능 이득은 없다 — `computeCacheEntry` 가 폭 0 이 아닌 엔트리마다 emoji property escape 2개를 무조건 돌아 wide 코드포인트는 어느 순서에서도 first touch 에 정규식을 내고, 전 범위 캐시가 코드포인트당 1회로 묶는다. 교차 집합은 unit test 가 전수 순회로 고정한다.

Direct Remote Mode 의 브라우저 클라이언트도 **같은 provider 를 받는다**(issue #538). 브라우저는 TypeScript 를 import 할 수 없고 Rust 서버는 asset 을 `include_str!` 로 임베드하므로, `ui/src/remote/unicode-provider-entry.ts` 를 `npm run build:remote-provider` 로 빌드해 `src-tauri/src/remote_server/assets/unicode-provider.js` 로 커밋하고 `/remote/vendor/unicode-provider.js` 로 서빙한다. `page.html` 은 xterm 다음에 이 스크립트를 로드하고 `ensureTerminal` 에서 **첫 write 보다 앞에** `unicode.register` + `activeVersion` 을 세팅한다. asset 이 없으면 xterm 기본 폭으로 degrade 하되 터미널은 계속 쓸 수 있다.

폭 테이블을 `page.html` 에 복제하지 않는다 — 그러면 ADR-0058 이 없애려던 이중 진실원이 되살아난다. 생성 asset 은 커밋되므로 소스만 고치고 재빌드하지 않으면 조용히 갈릴 수 있어, `remote-unicode-provider.test.ts` 가 **커밋된 asset 을 실행해** TS 소스와 폭·`charProperties` 결과를 비교한다(바이트 비교가 아니라 동작 비교라 번들러 상향에 깨지지 않는다). 수정 전 실측 불일치는 BMP 89개(Unicode 9+ 기호 + `U+A960`–`U+A97C` Hangul Jamo Extended-A)와 보조 평면 emoji 사실상 전부였다.

remote 표면은 composition preview overlay 를 쓰지 않는다.

회귀 테스트는 `terminal-unicode-width.test.ts`(폭·클러스터 경계, provider 등록)와 `ime-composition-controller.test.ts`(실제 `Terminal` 에 같은 텍스트를 write 해 buffer 커서와 preview layout 을 직접 비교), `TerminalView.test.tsx`(open/write 앞 활성화 순서)로 나눠 고정한다.

### 8.11 OS 입력 소스 전환 chord 와 PTY 입력 분리 (issue #533)

OS 입력 소스(키보드 레이아웃) 전환 chord 는 키바인딩 레지스트리의 `terminal.osInputSourceSwitch` 액션 하나로 표현하고 **기본값은 미할당**이다. 사용자가 실제로 바인딩한 경우에만 그 물리 키에서 파생된 이벤트를 xterm 에 넘기지 않는다([ADR-0059](../adr/0059-os-input-source-chord-pty-exclusion.md)).

- 판정은 `ui/src/lib/os-input-source-chord.ts` 의 `createOsInputSourceChordGuard` 가 전부 소유한다(DOM 이벤트 등록 없음, 순수 상태 기계). `TerminalView` 는 xterm 키 핸들러와 helper `beforeinput`/`blur` 배선만 한다.
- **왜 keydown 만으로는 부족한가**: 설치된 xterm 은 `attachCustomKeyEventHandler` 를 `_keyDown`·`_keyPress`·`_keyUp` 모두에서 호출하는데 기존 핸들러는 `e.type !== "keydown"` 에서 즉시 `true` 를 반환한다. 그래서 (a) `_keyPress` 가 `triggerDataEvent` 로 literal Space/숫자를 보내고(우리가 keydown 에 `false` 를 반환하면 `_keyDownHandled` 가 `false` 로 남아 keypress 가 계속 진행된다), (b) textarea `input` 게이트 `(!e.composed || !_keyDownSeen)` 는 `_keyUp` 이 `_keyDownSeen` 을 커스텀 핸들러보다 **먼저** 내리므로 keyup 이후 삽입을 통과시킨다. guard 는 `e.type !== "keydown"` 조기 반환보다 **앞**에 놓인다.
- **물리 키 범위**: 매칭된 keydown 에서 `code` 와 `key` 를 둘 다 기억하고(어느 쪽이든 일치하면 같은 press) 같은 press 의 keypress·keyup 만 삼킨다.
- **해제는 keydown 쪽에만**: 수식키를 먼저 떼면 DOM 이 그 키의 keyup 을 발행하는데 우리 것도 아니고 해제 신호도 아니다(chord 키는 아직 눌려 있다). 같은 물리 키의 non-matching keydown(Shift 를 뗀 뒤의 auto-repeat)도 같은 press 의 연속이다. 소유권을 버리는 것은 다른 물리 키의 keydown + blur·helper 교체·unmount 뿐이다.
- **preventDefault 경계**: 키 이벤트에는 걸지 않는다(OS 가 전환을 수행해야 한다). helper `beforeinput` 은 `inputType === "insertText"` + `data` 가 무장된 press 자신의 문자일 때만 취소한다 — 무장 구간이 무관한 삽입과 겹칠 수 있고, 특히 한글 IME 가 토글 시점에 커밋하는 음절까지 취소하면 사용자 텍스트가 사라진다. `isComposing` 인 삽입은 IME 소유이므로 애초에 막지 않는다.
- **정리**: helper blur, helper 교체, unmount, 다른 물리 키에서 진행 중이던 press 를 버린다. 시간 기반 timeout 은 두지 않는다.
- **미할당 계약**: `isAssignedKeybinding()`(`keybinding-registry.ts`)이 빈 combo 를 걸러 `matchesKeybinding` 이 어떤 이벤트와도 매치하지 않게 한다. 설정 UI 는 빈 칸 대신 `keybindings.unassigned` 를 표시한다. 조합 종료 직후 Space/숫자 보호는 이 절이 아니라 #528 소관이다.
- **진단**: `os-input-source-chord-armed`/`-released`/`-text-input-blocked` 를 기존 cursor-trace 채널(§8.5 와 동일 sink)에 남긴다.

### 8.12 Linux IME 후보 선택 키 억제 (issue #528)

Sogou/fcitx 계열 Linux IME 는 후보를 선택하는 데 쓴 Space/숫자를 `compositionend` 전후에 일반 키 이벤트로 다시 내보낸다(전체 trio 또는 keydown 없는 orphan keyup). xterm 의 조합 가드는 그 시점에 이미 끝나 있어 literal 문자가 PTY 로 새므로, **Linux 에서만** 두 신호로 판정해 억제한다([ADR-0060](../adr/0060-linux-ime-candidate-key-suppression.md)).

- 판정은 `ui/src/lib/linux-ime-candidate-guard.ts` 의 `createLinuxImeCandidateGuard` 가 전부 소유한다(DOM 등록 없음, 순수 상태 기계). `TerminalView` 는 xterm 키 핸들러와 helper 의 `compositionstart`/`compositionupdate`/`compositionend`/`input`/`blur` **관찰**만 배선하며, 조합 문자열·commit 경로·xterm `CompositionHelper` 소유권은 건드리지 않는다(§8.5, ADR-0053/0054 경계 유지).
- **신호 1 — IME 소비 표식**: `keyCode === 229`(또는 `key === "Process"`). 사용자가 실제 누른 키는 자기 코드(Space 32, 숫자 48–57)를 보고한다.
- **신호 2 — orphan companion**: window 안에서 `keydown` 을 관측하지 못한 물리 키의 `keypress`/`keyup`.
- **그 밖은 통과**: 완전한 `keydown(32) → keypress → keyup` 은 실제 press 이므로 건드리지 않는다. "확정 직후 사용자가 누른 Space 를 잃지 않는다" 가 여기서 나온다. `compositionend` 이후 첫 printable 키를 버리는 방식은 채택하지 않았다.
- **window 는 안전 상한**: `compositionend` 에서 열리고 실제 비조합 텍스트 삽입 / 실제 후보 keydown / 무관한 실제 키 / blur·unmount / timeout 중 먼저 오는 것에서 닫힌다. 어떤 동작도 IME 지연 ms 값에 의존하지 않는다.
- **조합 commit 의 `input` 은 window 를 닫지 않는다**: 확정 텍스트 삽입은 모든 조합에서 발생하고 Chromium 은 `compositionend` 뒤에 보낼 수 있다(그 시점 `isComposing === false`). `isComposing` 만 보면 window 가 열린 프레임에서 바로 닫혀 guard 가 no-op 이 된다. 판정은 `ui/src/lib/ime-composition-events.ts` 의 `isCompositionSideInput`(네 조건) 한 곳이 소유하고 `ime-composition-controller.ts` 와 공유한다.
- **빈 `compositionupdate` 는 종료가 아니다**. 관측 keydown 초기화는 `compositionstart` 에서 한다 — `compositionend` 에서 지우면 조합 시작 전부터 눌려 있던 키의 정상 release 를 orphan 으로 오판한다.
- **preventDefault 경계**: 차단된 후보 `keydown` 과 차단된 orphan `keypress` 에만 건다(helper textarea 를 변형시키는 경우). `keyup` 에는 걸지 않는다.
- **플랫폼 게이트**: `isLinuxHost()` = user agent 에 `Linux` 포함 + `Windows` 제외. WSL 은 Windows WebView 라 Windows 를 보고하므로 제외 조건이 필요하다. 비활성 시 전 경로 no-op.
- **이벤트열 fixture**: `ui/src/lib/__fixtures__/linux-ime-candidate-traces.ts`. 업스트림 보고(orca#7543/#7634) 재구성이며 Linux 실기 캡처가 아니다 — 각 trace 가 `platformClaim` 으로 자신의 주장을 기록하므로 실기 캡처 확보 시 조용히 교체하지 말고 diff 한다.
- **진단**: `linux-ime-candidate-window-opened`/`-closed`/`-blocked` 를 기존 cursor-trace 채널(§8.5 와 동일 sink)에 남긴다.

### 8.13 native IME 후보창 앵커 (issue #532)

composition preview 는 shadow cursor 로 그리지만, OS 후보창은 포커스된 helper textarea 의 DOM rect 에서 위치를 잡고 xterm 은 그 textarea 를 **public buffer cursor** 에 둔다. TUI repaint 로 두 커서가 갈리면 preview 는 맞아도 후보창만 다른 행·열에 뜬다. 두 커서가 **실제로 갈릴 때만** helper 의 위치를 앵커 셀로 옮긴다([ADR-0061](../adr/0061-native-ime-candidate-anchor.md), ADR-0053 의 "helper 를 이동하지 않음" 을 _무조건 이동 금지_ 로 정정).

- 기하 판정은 `ui/src/lib/ime-anchor.ts` 가 전부 소유한다(DOM 접근 없음). `TerminalView` 는 rect 읽기와 `left`/`top` 쓰기만 한다.
- **게이트**: `shouldSyncHelperAnchor(publicCell, anchorCell)` — 조합 활성 + 두 셀 불일치. 일반 셸은 두 커서가 일치하므로 style 을 아예 쓰지 않는다.
- **앵커 계약은 하나**: `updateOverlayCaret` 가 해결한 `cursorX`/`cursorY` 를 그대로 넘긴다. preview caret 셀과 후보창 앵커 셀이 같은 값이다 — 두 번 계산하면 wrap 규칙이 한쪽만 바뀌는 순간 갈라진다.
- **좌표**: cell 크기는 렌더 rect 유도(`targetWidth / cols`, overlay caret 과 동일 식), 원점은 `.xterm-screen` 기준 캔버스 offset, 최종 px 는 device pixel grid 에 snap(후보창이 device-pixel rect 로 배치되므로 분수 offset 은 분수 DPR 에서 1px 어긋남을 만든다), 뷰포트 밖 앵커는 마지막 가시 셀로 clamp.
- **위치만 건드린다**: value·focus·composition 이벤트·크기는 읽지도 쓰지도 않는다(ADR-0053/0054 경계).
- **한 번 쓰는 것으로는 부족하다**: xterm 의 `CompositionHelper.updateCompositionElements()` 가 `_isComposing` 동안 같은 `left`/`top` 을 `buffer.x`/`buffer.y` 로 `onRender` 마다 + 자기 재예약 `setTimeout(0)` 으로 다시 쓴다(실측: 우리 값 뒤에 xterm 값이 남는다). `ime-anchor-keeper.ts` 가 `style` 속성 변경을 감시해 앵커를 재적용한다 — 쓰기 전에 비교하므로 자기 재트리거가 없고, 해제하면 관찰도 멈춘다. mock 터미널에는 이 두 번째 writer 가 없어 실제 `Terminal` 테스트로만 관측된다.
- **sync 는 viewport 체크 뒤**: 앞에 두면 shadow cursor 행이 뷰포트 밖일 때 매 프레임 이동 → 원복이 반복된다.
- **원복 의무**: 조합 종료 · 두 커서 재일치 · overlay 가 숨는 모든 경로(비포커스·scrollback·geometry 미확정) · helper 교체 · unmount 에서 저장해 둔 원래 inline 값으로 되돌린다.
- **진단**: `ime-anchor-hold-started`/`-reapplied`/`-restored` 를 기존 cursor-trace 채널(§8.5 와 동일 sink)에 남긴다. native 후보창의 실제 위치는 OS 창이라 스크린샷에 잡히지 않아 이 trace 로 사람이 확인한다.

### 8.14 조합 commit 과 세대별 input·keypress 경합 (issues #527, #660)

xterm 의 `CompositionHelper._finalizeComposition(true)` 는 확정 텍스트를 즉시 보내지 않는다 — 조합 범위를 캡처하고 `_isSendingComposition = true` 로 표시한 뒤 `setTimeout(0)` 안에서 textarea 최종값을 읽는다. Windows WebView2에서는 그 사이 `input(insertText)`가 legacy `keypress`보다 먼저 오거나 단독으로 올 수 있다. input을 즉시 보내면 finalizer가 같은 candidate를 다시 보내고, 단일 pending 상태를 공유하면 timer 전에 연속된 조합 세대가 서로를 덮어 문자 유실·순서 변경을 만든다([ADR-0093](../adr/0093-xterm-composition-keypress-reconciliation-owner.md), [ADR-0062](../adr/0062-composition-commit-keypress-race.md) 대체).

- **상태 소유자는 CompositionHelper 하나다**: exact bundle patch가 xterm 6.0.0 ESM/CJS의 CompositionHelper에 generation FIFO를 둔다. 각 delayed finalizer는 캡처 범위·다음 composition 경계·이미 전송된 길이·순서 있는 input/keypress 관측·완료 상태를 별도 record로 소유한다. 새 `compositionstart`는 직전 generation의 textarea 상한을 먼저 고정하므로 다음 조합 위치가 이전 timer에 섞이지 않는다.
- **input·keypress·finalizer가 같은 generation에 합류한다**: CoreBrowserTerminal의 `_inputEvent`와 `_keyPress`는 계산한 텍스트를 helper에 먼저 제안한다. pending generation이 있으면 즉시 PTY로 보내지 않고 최신 미완료 record에 보류하며, 없으면 ordinary input/keypress를 기존처럼 즉시 보낸다. timer는 자기 record만 완료하고 FIFO 선두의 완료 세대부터 한 번씩 flush한다. 일반 keydown immediate finalize도 pending FIFO를 먼저 비운 뒤 자기 키를 보낸다.
- **최종 candidate와 한 번 조정한다**: generation의 event observation을 원래 순서로 합친 뒤 textarea candidate와 양방향 포함 및 suffix-prefix 최장 overlap을 비교해 양쪽 정보를 보존하는 가장 짧은 ordered merge를 만든다. queue가 빌 때까지 `_isSendingComposition`은 유지된다.
- **외부 guard는 없다**: TerminalView는 `compositionend` 시작 위치를 캡처하거나 input/keypress를 `preventDefault`/억제하지 않는다. `xterm-pending-composition.ts`의 private 접근은 issue #555 blur fallback이 deferred send 중복을 피하는 `_isSendingComposition` 하나로 축소됐다.
- **설치가 계약 관문이다**: `ui/scripts/patch-xterm-reflow.mjs`는 pristine bundle을 선행 keypress patch 형태로 만든 뒤 generation correction을 적용한다. 이미 선행 patch 또는 최종 patch인 설치도 각각 upgrade/idempotent 성공한다. 두 번들의 helper state·input/keypress owner·delayed/immediate flush가 모두 맞지 않으면 postinstall이 실패하고 조용한 부분 적용은 없다.
- **결정적 테스트는 실제 xterm 대상이다**: 기존 6개 조합 이벤트열과 `compositionend → input → keypress`, input-only, timer 전 연속 두 generation, input/keyPress 뒤 일반 keydown 교차를 `Terminal.onData`까지 검증한다. pending이 없는 ordinary input·keypress 2개도 즉시 전송을 고정한다. 순수 mock 판정으로 이 상태 전이를 대체하지 않는다.
- **인간 입력 전달 실패**: local owner의 xterm `onData`와 IME blur fallback은 각 raw 입력을 정확히 한 번만 `write_to_terminal`로 제출한다. IPC 거절은 Rust 미수락의 증명이 아니므로 재전송하지 않으며, terminal별 `attempts`/`succeeded`/`failed` 및 UTF-8 byte 합계를 `frontend.inputDelivery`로 내보낸다. completion은 제출 session token과 one-shot attempt token이 현 entry와 같을 때만 한 번 정산한다. close 요청은 backend close IPC를 기다리지 않고 즉시 entry를 fence해 close/replacement 뒤 late completion을 버리며, 반복 실패의 수치는 모두 누적하되 action-required 오류 알림은 session당 하나로 coalesce해 사용자가 새 입력을 명시적으로 만들게 한다. protocol reply와 owner permit에 의해 막힌 입력은 이 카운터에 포함하지 않는다([ADR-0096](../adr/0096-terminal-human-input-write-failure-observability.md)).
- **미검증과 후속 경계**: Windows WebView2/한국어 IME 실기와 다중 pane flood 조건의 재현률·key-to-PTY exact byte는 dev 19281에서 확인해야 하며 release 19280은 건드리지 않는다. 반복 가능한 Windows IME 실기 자동화는 [#666](https://github.com/kochul2000/laymux/issues/666)이 추적한다.

### 8.15 조합 프리뷰 가시성은 activity 와 무관하다 (issue #551)

조합 프리뷰는 **caret 이 아니라 사용자가 입력 중인 텍스트**다. 두 결정이 한 게이트에 묶여 있어서, Codex 아닌 모든 페인(맨 셸 포함)에서 조합 중 자모가 **아무 데도 렌더되지 않았다** — 글리프도 밑줄도 없었다.

- **렌더러가 하나뿐이다**: `ui/src/index.css` 의 `.xterm .composition-view { visibility: hidden !important }` 는 xterm 네이티브 조합 표시를 **무조건** 끈다(조합 활성 클래스에 묶으면 compositionend 누락 시 stale 텍스트가 노출되므로 의도된 무조건이다). 따라서 조합 중 텍스트를 그릴 주체는 laymux 오버레이(`.terminal-composition-preview`) **하나뿐**이고, 그것이 꺼지면 대체 렌더러가 없다.
- **게이트가 두 겹이었다**: `TerminalView.tsx` 의 오버레이 rAF 조기 반환이 `stabilizeInteractiveCursor`·`isOverlayCaretActivity` 로 끊고, 통과해도 `resolveVisualCaretOwner` 안에서 같은 두 조건이 `compositionActive` 검사 **위**에 있어 `"hidden"` 으로 떨어졌다. 한쪽만 고치면 증상이 남는다.
- **판정**: `compositionActive → "composition-preview"` 를 caret 정책 게이트 **위로** 올린다. `stabilizeInteractiveCursor`·`overlayActivity` 는 laymux 가 **caret** 을 소유하는지에 대한 정책이고(Codex 가 repaint 중 커서를 footer 로 주차하므로 shadow cursor 캐럿이 필요한 것), 조합 텍스트 가시성과는 다른 종류의 질문이다.
- **경계는 유지한다**: `opened`/`focused`/`syncOutputActive`, `isAltBufferActive`, `viewportScrolledUp` **아래**에 둔다. 그것들은 "보이지 않는다 / 지오메트리를 신뢰할 수 없다" 는 진짜 조건이고, 그 상태에서 프리뷰를 그리면 잘못된 위치에 찍힌다.
- **부수 효과(의도됨)**: 비-Codex 페인이 조합 중일 때 `caretOwner === "composition-preview"` 가 되므로 (1) 오버레이 캐럿이 프리뷰 커서에 그려지고 — 조합 중에는 `hideNativeCursor` 가 네이티브 커서를 렌더러 게이트에서 끄므로(§8.21) 이게 없으면 캐럿이 사라진다 — (2) `syncHelperAnchor` 가 실행되어 OS 후보창이 조합 커서에 앵커된다(§8.13 의 확장).
- **결함이 테스트로 못박혀 있었다**: `ime-composition-controller.test.ts` 의 `"hides composition preview when overlay caret activity is off (non-Codex)"` 가 `"hidden"` 을 정답으로 단정하고 있었다. 교체했다.
- **역검증**: 우선순위를 되돌리면 새 단위 테스트 2건이 실패하고(`expected 'hidden' to be 'composition-preview'`), 조기 반환을 되돌리면 컴포넌트 테스트에서 `preview.textContent` 가 `''` 로 떨어진다 — 신고된 증상 그대로다.
- **미검증**: alt 버퍼는 건드리지 않았다. 확인된 두 케이스(맨 셸·Claude Code)는 모두 normal 버퍼이고, 전체화면 TUI(vim 등)에서 조합이 보이는지는 확인하지 않았다. `isAltBufferActive` 가 먼저 잡으므로 **거기서는 여전히 안 보인다** — 별 판정이 필요하다.
- **앵커 출처는 `computeUseShadowCursor` 가 정한다**: 게이트를 열자 앵커가 틀린 것이 드러났다. `getAnchor` 가 **무조건** shadow cursor 를 읽고 있었는데 그 근거("TUI 가 repaint 중 커서를 footer 로 옮긴다")는 Codex 계열에만 성립한다. 계측으로 확인: `ls` 뒤의 PowerShell 프롬프트는 OSC 133 `D` 만 보내고 `B` 를 안 보내므로 `isInputPhase` 가 false 로 남고, `shadow-sync-skip { reason: "inactive" }` 가 찍히며 shadow 가 버퍼보다 **한 행 뒤처진다**(shadowAbsY 256 / bufferAbsY 257). 프리뷰는 이전 행 열 0 에 그려졌다 — 숨은 게 아니라 **엉뚱한 곳에 그려진 것**이고, 사용자에게는 "안 보인다" 로 보였다. 깨끗한 프롬프트에서 되던 이유는 그때 두 값이 우연히 같았기 때문이다. 판정은 이 리포의 기존 술어 `computeUseShadowCursor = (hasPromptBoundary && isInputPhase) || hasSyncFramePosition` 를 따르고, false 면 라이브 버퍼 커서를 쓴다. 실측이 두 케이스를 정확히 가른다 — 셸은 false, Codex 는 `hasSyncFramePosition: true` 로 true.
- **carry-over 앵커는 체인 시작에서 유도하고, 행이 바뀌면 원점을 다시 잡는다**: #546 수정(PR #548)이 넣은 `echoed` 판정에 결함이 있었다. 그 판정은 "shadow 가 움직였다" 를 "shadow 가 확정분을 다 따라잡았다" 로 취급한다. Codex 실측: `ㄱㄱㄱ` 에서 두 번째 carry-over 시점에 PTY 는 **첫 자모만** 에코했으므로 shadow 는 열 2 인데 확정분은 두 자모(4 셀)였다. 그걸 채택하며 산술로 맞춰둔 4 가 **뒤로 끌려가** 세 번째 자모가 두 번째 위에 겹쳐 그려졌고, 프리뷰가 `ㄱㄱ` 에 멈춘 것처럼 보였다.
  - **판정**: 앵커는 `chainAnchor + width(체인 시작 이후 확정분)` 로 유도한다. lag 거부는 **같은 행 안에서만** 한다 — 늦게 도착한 에코는 같은 텍스트가 더 큰 열에 앉는 것이라 행을 바꾸지 않는다.
  - **행 변화 = 산술 원점 무효 신호**이며 방향을 묻지 않는다. 채택할 때 `chainAnchor`·`chainBaseText` 를 **다시 잡는다**. 재기준화가 빠지면 wrap 경계를 넘은 직후부터 `derived` 가 죽은 원점에서 계산돼 조건이 영구 참이 되고, 위에서 없앤 "한 에코 뒤진 값 채택" 이 그대로 되살아난다(cols 75, 원점 열 74, 에코 1개 지연 → 2차에서 정답 (4,6) 대신 (2,6) 채택 → 세 번째 음절이 두 번째 위에 겹친다). 오른쪽 여백 근처 한글 입력에서 닿는다.
  - 행이 **위로** 가는 경우도 전부 유효한 조합이므로 같이 따라간다 — 셸이 입력행을 한 줄 위에서 재출력(CUP·`ESC[A`; PSReadLine 멀티라인, 2줄 zsh 프롬프트), 스크롤 리전 내 IL/DL/RI, scrollback 상한 도달로 오래된 행 폐기 시 고정 행의 절대 인덱스 감소. 한때 "절대 행이라 스크롤로 안 변한다" 를 근거로 이 셋을 거부했는데, 그 근거는 **뷰포트 스크롤만** 배제한다.
  - **행 전진 규칙의 단일 소유자는 `advanceCells(originColumn, text, cols)` 다**: 처음에는 carry-over 가 `원점 + 폭` 로 앵커를 구하고 레이아웃이 `% cols` 로 접었는데, 그 둘은 **같은 규칙의 두 구현**이고 실제로 갈라져 있었다.
    리뷰가 커밋된 xterm 번들을 실행해 측정한 표가 근거다 — 남은 칸이 글리프 폭보다 작으면 xterm 은 **마지막 열을 pad 하고 글리프를 통째로 다음 행에** 놓는다:

    | cols   | 원점   | xterm 실측              | `% cols` 예측              |
    | ------ | ------ | ----------------------- | -------------------------- |
    | 75     | 73     | `(75, 0)` pending-wrap  | 일치                       |
    | 150    | 148    | `(150, 0)` pending-wrap | 일치                       |
    | 150    | 147    | `(149, 0)`              | 일치                       |
    | **75** | **74** | **`(2, +1)`**           | `(1, +1)` — **1셀 불일치** |
    | **80** | **79** | **`(2, +1)`**           | `(1, +1)` — **1셀 불일치** |

    그 1셀은 다음 carry-over 의 라이브 채택이 덮어주므로 **경계 음절이 체인의 마지막일 때만** 드러난다 — 오른쪽 여백에서 한 음절 치고 스페이스로 확정하는 평범한 흐름이다. `advanceCells` 가 클러스터·pad 를 함께 인식해 이 케이스를 없애고, 그 결과 wrap 경계에서 **라이브 값을 아예 참조하지 않는다**. 실측 표 5행을 그대로 단위 테스트로 고정했다.

  - **행 변화의 분류**: `derivedRow = chainRow + advance.rowOffset` 와 라이브 행이 같으면 wrap 으로 설명된 것이라 산술을 유지하고, 다르면 원점이 실제로 움직인 것(셸의 상향 redraw, 스크롤 리전 `IL/DL/RI`, scrollback 상한)이라 라이브를 새 원점으로 삼는다. 뒤로 간 라이브가 wrap 으로 오분류될 수 없다 — `advance.rowOffset >= 0` 이므로 `live.absY < chainRow` 는 `derivedRow` 와 같아질 수 없다.
  - **리사이즈는 원점과 함께 `cols` 를 캡처해 강제 rebase 한다**: xterm 이 reflow 하면 원점이 가리키던 행 자체가 이동하고, 행 델타를 옛 `cols` 로 누적한 값에 새 `cols` 를 곱하게 된다. 분류가 우연히 `originMoved` 로 떨어져 자기치유하던 것을 `chainCols` 비교로 결정적으로 만들었다(`shadow-cursor-rebase-resize`).
  - **정규화된 앵커는 레이아웃이 반환한다**: `anchorColumn` / `anchorRowOffset` 를 함께 돌려주고 렌더러의 컨테이너와 행이 **둘 다 그것을** 쓴다. 한때 컨테이너만 렌더러에서 따로 정규화했다가 행 오프셋을 이중 계산해 프리뷰가 자기 캐럿보다 한 행 아래로 떨어졌다. 위험은 값이 아니라 암묵적 계약이었다 — `anchorBufferX` 를 화면 열로 직접 읽는 소비자가 생기면 즉시 틀린다. 이제 원시 앵커가 컴포넌트로 새지 않는다.
    - 예외 한 곳: `cols <= 0` 조기 반환은 정규화 기준이 없어 원시 앵커를 그대로 통과시킨다. 렌더러는 그 경로에 닿지 않는다.
      캐럿 경로(`getCompositionPreviewCursor`)는 `% cols` · `Math.floor(/ cols)` 로 정규화했지만 rows 루프는 안 했다 — wrap 분기가 **무조건 열 0** 으로 접으므로 범위 밖 앵커가 전부 다음 행 열 0 에 그려졌다. 앵커 150 은 우연히 맞고 152 는 **그 위에 겹쳐서**, 경계를 걸치는 체인의 두 번째 음절이 첫 번째 아래로 사라졌다.
      실측으로 잡았다 — cols 150, 앵커 150 → 152 → 재기준화 (2,186), 사용자 관측은 1번째 보임 / 2번째 안 보임 / 3번째에 2개. 이제 루프 진입에서 앵커를 정규화하고(`anchorRowOffset` / `anchorColumn`), TerminalView 의 프리뷰 컨테이너 배치도 같은 정규화를 쓴다 — 원시 열로 두면 컨테이너가 터미널 박스 밖에 놓이고 행별 translate 로 끌어오는 데 의존해 클리핑 위험이 있다.
  - 이것이 리뷰가 "`cols` 를 모르는 한 불가피한 한 음절 구간" 이라고 적은 구멍의 실제 정체였다. **컨트롤러에 `cols` 를 넘길 필요가 없다** — 레이아웃이 이미 받는다. #541 에서 기각된 API 확장 없이 닫혔다. 그리고 에코 지연과 무관하다: 천천히 입력해도 재현된다.
  - **적용 범위**: shadow cursor 를 앵커로 쓰는 페인에서는 조합 중 `getShadowSyncEligibility` 가 `composition-preview-active` 를 먼저 돌려주어 라이브가 얼어 있으므로 행 변화 분기가 사실상 발생하지 않는다. 재기준화를 실제로 태우는 것은 버퍼 커서(셸) 경로다.
  - **앱이 자기 입력상자를 소유하면 산술은 틀린다 — 정착한 커서를 채택한다 (issue #569)**: 앵커 산술은 **터미널이** 텍스트를 어디 놓을지를 예측한다. 자기 입력상자를 소유하는 앱은 그럴 의무가 없다 — Codex 는 상자 안에서 자기 폭으로 랩하고 연속행을 **2칸 들여쓴다**. 실측(cols 150): `도` 가 줄 끝을 채우면 `레미` 가 다음 행에 `"  레미"` 로 온다. 산술은 열 0 을 가리키므로 프리뷰가 2칸 왼쪽에 그려지고, 다음 음절은 앞 음절 **위에 겹쳐** 그려져 지운다(`도시라` 는 `도`⏎`라시` 가 된다).
    - **판정: 조합 중 음절의 앵커는 마지막으로 정착한 에코의 버퍼 커서다.** 실측으로 커서가 들여쓰기를 정확히 반영한다 — 랩 너머로 한 글자 쓰면 `(4, row+1)`, 두 글자면 `(6, row+1)` 이고 화면의 `"  시라"` 와 일치한다. 한때 "커서도 모른다(149에 고정)" 고 기록했는데 **그 측정이 틀렸다**. 조합 이벤트 시점에서 읽었고, 그건 앱이 다시 그리기 **전**이다.
    - **shadow 가 아니라 원시 버퍼 커서다.** shadow 는 조합 동안 얼어 있고(`composition-preview-active`) 에코 한 박자 뒤진다 — 같은 순간 버퍼 6, shadow 4.
    - **양쪽으로 막는다 — "커서가 앞으로 갔다" 는 그 자체로 입력 캐럿의 증거가 아니다.**
      - **뒤면 거부**: 확정분을 PTY 가 아직 다 에코하지 않았다는 뜻이고, 채택하면 이미 그려진 텍스트 위로 앵커가 끌려간다 — 위쪽이 기록한 #551 회귀 그대로다.
      - **한 행 넘게 앞서도 거부**: 이 경로는 **모든 파싱 write** 가 탄다. transcript 를 흘리는 앱(Claude Code 는 DEC 2026 도 OSC 133 도 안 써서 아래 보류 조건이 하나도 안 걸린다)은 커서를 transcript 꼬리에 남기고, 그건 언제나 "앞" 이다. 그대로 두면 프리뷰가 출력을 따라 끌려 내려가 §8.15 아래의 #570 고정이 무효가 된다. 정당한 전진은 **앱이 자기 상자 안에서 다시 랩한 것**뿐이고 그것은 연속행 하나를 넘지 못한다.
    - **정착하지 않은 커서는 아예 주지 않는다**: DEC 2026 프레임 열림, save/restore repaint 진행 중, **`parkPending`**(legacy Codex 는 `?2026l` 을 cursor가 footer에 있는 채로 닫고 진짜 park를 ~15ms 뒤 다음 청크에 보낸다), alt 버퍼(행 좌표계가 다르다), sync-output. Codex 0.145의 strict `?25h` → position → `?2026l` tail은 reset buffer cursor 자체가 final park이므로 `parkPending`을 세우지 않고 이 정착 경로를 즉시 연다([ADR-0076](../adr/0076-codex-in-frame-cursor-park.md)).
    - **`pending-finalize` 단계에서는 채택하지 않는다.** 확정된 음절이 커서보다 앞인데 `compositionBaseText` 에는 아직 없어서, 채택하면 origin 은 음절 뒤·base 는 음절 앞이 되고 다음 carry-over 가 그 폭을 한 번 더 더한다.
    - **`pending-finalize`의 논리 수명과 가시 프리뷰 수명은 다르다.** `compositionend` 직후의 `setTimeout(0)` 전에는 같은 tick의 다음 `compositionstart`를 carry-over로 받아야 하므로 컨트롤러 phase·체인 원점·textarea residue는 그대로 둔다. 그러나 그 창에 `isComposing`/`keyCode 229`/`Process`가 아닌 새 키(영문·Backspace 포함)나 non-composition `beforeinput`/`input`이 들어오면 조합 체인이 끝났다는 권위 신호다. 이때 프리뷰가 계속 `active`이면 xterm은 새 키를 처리하는데 네이티브 커서는 억제된 채 완료 음절의 overlay caret만 남아, WSL처럼 PTY echo가 별도 왕복하는 셸에서 캐럿이 입력을 따라가지 않는 것처럼 보인다. 새 입력 시에는 **가시 상태만 즉시** `active=false`·빈 text/caret로 넘겨 xterm 네이티브 커서를 복구하고, deferred reset은 예정대로 residue와 내부 체인을 정리한다. IME 소유 키는 가시 상태를 유지해 같은 tick carry-over를 끊지 않는다. MCP로 PTY에 직접 보낸 한글·영문과 Backspace burst는 최종 버퍼와 렌더된 텍스트가 일치했으므로, 이 수정은 WSL 출력·로컬 echo·커서 좌표 예측을 추가하지 않고 브라우저 IME handoff에만 한정한다.
    - **채택하면 그것이 새 체인 원점이고, 이후 분류기가 라이브로 되돌리지 않는다**(`chainAnchorMeasured`). 앱 소유 상자에서는 커서와 산술이 정당하게 갈리므로, 관측된 원점을 "고쳐" 주는 것은 관측을 버리는 것이다. 리사이즈는 예외로 강제 재기준화 — reflow 는 관측한 행 자체를 옮긴다.
    - **텍스트 검색은 기각했다.** 확정분을 버퍼에서 찾아 위치를 재는 안을 먼저 만들었다가 버렸다: 같은 문자열이 두 번 나오면 어느 쪽인지 모르고, 앱이 확정분을 행 경계로 쪼개 놓으면(`도`/`시`) 연속 문자열로 존재하지도 않는다. 커서는 이 두 문제를 다 안 만든다.
  - **앵커는 스크롤을 따라간다 — 재기준화가 닿지 않는 구간이 있다 (issue #570)**: 위 분기는 전부 **조합 이벤트**에서만 돈다. 키를 누르지 않는 동안에는 앵커를 다시 잡는 주체가 없는데, 프리뷰의 화면행은 `anchorBufferAbsY - baseY` 다. 입력 상자를 바닥에 두는 TUI(Claude Code·Codex)가 출력하면 `baseY` 만 커지므로 **가만히 있는 앵커가 출력한 줄 수만큼 위로 밀린다.** 실측: Claude 스트리밍 중 앵커 1683 고정, 확정 시점 입력줄 1692 — 프리뷰가 9행 위. `onScroll` 에서 `baseY` 증가분을 앵커(`compositionAnchor`·`chainAnchor`)에 더해 **화면행에 고정**한다. 스크롤백 상한에 닿으면 delta 가 0 인데, 그때는 위에서 행이 버려지고 바닥 앵커 입력줄의 절대행도 그대로이므로 앵커도 움직이면 안 된다 — 같은 규칙이 두 경우를 모두 맞춘다. 뷰포트 스크롤(사용자가 위로 스크롤)은 별개 축이고 `viewportScrolledUp` 가 프리뷰를 이미 숨긴다.
  - **스트림 재구축은 스크롤이 아니다 — 창 전체를 하나의 net 으로 청구한다 (issue #602)**: 최초 attach와 구 v2 fallback 재부착은 `terminal.reset()` + snapshot replay 다. production v3의 transport/credit failure는 이 경로로 복구하지 않는다(§8.8). `reset()` 은 `baseY` 를 이미 0 으로 만든 채 **동기적으로** `onScroll` 을 발행하고(실물 계약은 `ui/src/test/screen/xterm-semantics.screen.test.ts` 가 고정), replay 는 await 여러 번에 걸쳐 `baseY` 를 다시 키운다. 그 두 반쪽을 각각 청구하면 앵커가 먼저 scrollback 높이만큼(실측 시나리오 1000행) 음수로 튀고 replay 가 그것을 나중에 갚는다 — 한글 음절은 그 사이에 확정되므로 **그 조합이 끝날 때까지 프리뷰가 화면 밖 위쪽에 앵커된다.** 그래서 attach write chain 전체를 `withCompositionScrollRebuild` 창으로 감싸 그 안의 `onScroll` 을 **baseline 을 동결한 채** 건너뛰고, 창이 닫힐 때 동결된 baseline 대비 현재 `baseY` 라는 net 한 번만 청구한다. 청구 규칙 자체는 live 스크롤과 같은 함수(`chargeCompositionBaseYMove`)가 소유하므로 net 은 입력줄이 차지한 화면행을 보존하는 값이고, 위 #570 규칙을 재부착 단위로 적용한 것과 같다. baseline 을 기준으로 재는 덕에 **창 안에서 새로 시작한 조합**도 맞는다 — 그 `compositionstart` 가 baseline 을 자기 좌표계로 재시드했기 때문이다. reset 만 억제하고 replay 를 그대로 청구하면 부호가 반대로 어긋나므로 두 반쪽을 함께 감싸는 것이 요점이다. 창 안에서는 `shadowCursorRef` 를 함께 옮기지 않는다 — 같은 창에서 `createShadowCursorState()` 로 비워졌고(§8.5, #596), 비워진 상태에서는 `computeUseShadowCursor` 가 false 라 컨트롤러가 라이브 버퍼 커서를 읽으므로 동결된 shadow 와 비교되는 경로가 없다. 재현은 컴포넌트 계층이 소유한다 — xterm mock 의 `reset` 이 실제 시맨틱(버퍼 비움 + 동기 `onScroll`)을 흉내 내고, `TerminalView.test.tsx` 의 `composition anchor across a stream rebuild (issue #602)` 가 창 **안**에서 관측한 청구 목록이 비어 있음과 창이 닫힌 뒤 net 한 번만 청구됨을 함께 고정한다. mock 이 버퍼를 비우게 되었으므로 **버퍼 상태를 심는 테스트는 attach reset 뒤에 심어야 한다** — #603 의 parser handler 게이트와 같은 순서 규칙이 버퍼 상태에도 적용된다.

- **여기서도 결함이 테스트로 못박혀 있었다**: `"adopts a shadow cursor that moved backwards"` 와 helper 앵커 테스트 2건이 그렇다. 후자는 "TUI 가 커서를 footer 에 주차했고 shadow 가 진값" 이라는 상태를 **단정만** 하고 그 상태를 만드는 DEC 2026 프레임을 구동하지 않아서, `computeUseShadowCursor` 가 false 인 합성 상태였다. 실측이 보여준 실제 흐름(프레임 열기 → 커서 주차 → 프레임 닫기)을 구동하도록 고쳤다 — 단정이 아니라 재현이다.
- **해소됨(issue #598)**: "`active` 가 true 인데도 네이티브 커서가 계속 보인다" 는 관측은 WebGL 이 커서 색을 무시한 것이 아니라 **숨김 수단 자체의 결함**이었다. §8.21 참조 — 배경색 위장과 옵션 경합을 버리고 렌더러 게이트로 옮겼다.

### 8.16 조합 중 포커스 아웃은 확정이다 (issue #555)

조합 중에 페인 포커스를 잃으면 조합 중이던 글자가 **영구 유실**됐다. PTY 로 보낸 적이 없으므로 되살릴 데이터가 없고, 다시 포커스해도 방향키를 눌러도 나타나지 않는다. 한국어(그리고 CJK 일반)에서 포커스 이동은 취소가 아니라 **확정**이며 Windows IME 자체도 그렇게 동작한다.

실제 `Terminal` 을 jsdom 에 띄워 측정한 계약(4케이스):

| 순서                            | blur 시점 xterm 상태 | 결과                                                |
| ------------------------------- | -------------------- | --------------------------------------------------- |
| blur 만 (`compositionend` 없음) | `composing: true`    | textarea 가 비워지고 **onData 없음**                |
| `compositionend` → blur → flush | `pending: true`      | **onData 없음** — finalizer 가 빈 슬라이스를 읽는다 |
| `compositionend` → flush → blur | `pending: false`     | `onData ["가"]` — 이미 전송됨                       |
| 조합 없는 잔여물                | —                    | blur 에서 **무조건** 비운다                         |

- **xterm 은 blur 에서 아무것도 보내지 않고 지우며, 자기 `_isComposing` 을 true 로 남긴다.** `handleBlur` 의 기존 주석은 "compositionend 가 따라오거나, 아니면 xterm 이 지운다" 였는데 실측은 후자이고 **지우기만 한다**. blur 뒤에 오는 `compositionend` 로도 복구 불가 — 읽을 슬라이스가 이미 없다.
- **phase 는 판별자가 아니다.** WebView2 + Windows IME 는 blur **전에** `compositionend` 를 보내므로 실제 순서는 `end → blur → flush` 이고, blur 가 xterm 의 deferred 창 **안에서** 도착한다. 그 시점 컨트롤러 phase 는 `pending-finalize` 이며, phase 만 보고 "xterm 이 보낼 것" 이라 판단하면 정확히 그 케이스에서 유실된다. (처음 이렇게 구현했고 실기에서 그대로 유실됐다 — 첫 계측이 `end → flush → blur` 만 재봤기 때문이다.)
- **판별자는 xterm 의 pending 플래그다.** blur 시점에 `readPendingCompositionSend(terminal).pending` 이 참이면 전송이 아직 예약 상태이고 소스가 이미 비었으므로 **반드시 실패한다** → 우리가 보낸다. 거짓이면 이미 보냈거나 보낼 게 없다 → 보내지 않는다. #542 가 만든 private 상태 리더를 그대로 재사용한다.
- **위험한 텍스트가 둘일 수 있다.** carry-over 는 한 음절을 끝내고 다음을 같은 tick 에 시작하므로 blur 가 _예약된 doomed 전송_ 과 _진행 중 조합_ 을 동시에 잡을 수 있다. doomed 쪽은 `state.text` 가 아니라 `compositionend` 시점에 따로 캡처한 `lastFinalizedText` 다 — 그때 `state.text` 는 이미 새 음절을 담고 있다.
- **텍스트 출처는 textarea 가 아니다.** xterm 이 자기 blur 핸들러(`terminal.open()` 시점에 먼저 등록)에서 값을 비우므로 거기서 읽으면 리스너 순서에 의존한다.
- **리셋은 유지한다.** xterm 이 `_isComposing` 을 true 로 남기므로 프리뷰가 다음 포커스 사이클까지 살아 있는 것을 막는 방어가 여전히 필요하다.
- **리더가 `null` 이면 "pending 아님" 으로 떨어진다** — 그 빌드에서는 유실이 되살아나지만, 포커스 이동마다 음절이 중복되는 것보다 낫다. xterm 계약 테스트가 같은 필드를 읽으므로 형태 변경은 배포 전에 큰 소리로 실패한다.
- **결함이 테스트로 못박혀 있던 네 번째 사례.** `"resets when the textarea blurs mid-composition (missed compositionend defense)"` 가 리셋만 단정해 유실을 정답으로 고정했다. stuck 방어 단정은 유지하고 유실 쪽만 갈랐다.
- **확정이냐 취소냐는 우리가 정하지 않는다 — IME 가 `compositionend` 의 `data` 로 말한다.** 실측(Windows 한글 IME): 조합 중 Esc 는 조합을 **확정하고** `data` 에 그 음절을 실어 보낸다. 그래서 그 경로는 커밋되고, 한글 사용자 기준으로 그것이 자연스러운 동작이다. `data` 가 빈 문자열인 경우에만 커밋하지 않는다 — 없는 텍스트를 만들어내지 않는다는 뜻이고, 어느 쪽이든 판단은 IME 가 한다.
  - 관측 시 주의: PowerShell(PSReadLine)은 Esc 를 **줄 전체 삭제**로 해석하므로 확정이 일어났는지 화면으로 알 수 없다. WSL(readline)에서는 지우지 않으므로 그쪽이 정보가 있는 관측이다.
- **확정되는 것은 "IME 가 들고 있던 것" 이 아니라 "화면에서 본 것" 이다.** `syncPreview` 의 previewText 분기가 `latestCompositionDisplayText` 를 승격하므로 `state.text` 는 textarea 변경 범위보다 긴 IME 표시 문자열일 수 있다. 한국어에서는 둘이 같고, 일본어 변환 중 blur 도 Windows IME 동작(확정)과 맞으므로 이 선택이 맞다. 반대 방향 보강도 필요하다 — `state.text` 는 deferred sync 대기값이라 마지막 `compositionupdate` 의 sync 전에 end/blur 가 오면 비어 있다. `latestCompositionDisplayText` 는 동기로 들어오고 위 의미론상 같은 소스라 `state.text || latestCompositionDisplayText` 로 받는다.
- **취소는 `compositionend` 의 `data` 로 판정한다.** Esc 는 `data: ""` 로 조합을 끝낸다. 이벤트 인자를 읽지 않던 동안에는 낡은 `lastFinalizedText` 가 남아 있어 그 뒤 blur 가 오면 **취소한 음절이 주입됐다**. `compositionupdate` 의 `event.data` 는 이미 신뢰하므로 태도도 일관된다. 이벤트가 없는 경우(합성 dispatch 등)에만 프리뷰 텍스트로 떨어진다.
- **경계 기록**: 한 태스크에 `compositionend` 가 두 번 오면 xterm 의 타이머가 둘 큐잉되고 첫 타이머가 단일 슬롯 플래그를 내려 두 번째는 아무것도 보내지 않는다. 그 창에서 `lastFinalizedText` 는 두 번째 텍스트만 들고 있어 첫 번째는 살릴 수 없다 — xterm 자체의 단일 슬롯 한계이고 이 판정의 결함은 아니다.
- **`pending` 이 안전을 만들고 캡처 수명은 load-bearing 이 아니다**: 정상 flush 후 blur 창은 실제로 존재한다(xterm 타이머가 먼저 전송하고 우리 deferred reset 전에 blur 가 끼어든다). 그때 캡처는 남아 있지만 `pending` 이 거짓이라 재전송되지 않는다. 그래서 테스트가 고정하는 것은 수명이 아니라 **조합**이다 — "pending 거짓 + 캡처 남아 있음 → 커밋 없음".
- **미검증**: 실기 확인 필요

### 8.17 조합 프리뷰는 alt 버퍼에서도 그린다 (issue #553)

전체화면 TUI(vim)에서 조합 중 자모가 **아예 보이지 않았다.** 스크롤과 무관하게, 라이브 하단에서 타이핑하는 동안이다.

- **§8.15 와 같은 구조**: `.xterm .composition-view` 가 무조건 꺼져 있어 조합 텍스트의 렌더러는 laymux 오버레이 하나뿐인데, `resolveVisualCaretOwner` 가 `isAltBufferActive` 를 `compositionActive` **앞**에서 잡아 `hideOverlay()` 로 보냈다. PR #552 가 caret 정책 게이트를 열었지만 alt 버퍼는 그 위에 남아 있었다.
- **판정**: `isAltBufferActive` 를 `compositionActive` **아래**로 내린다. alt 버퍼는 caret 정책과 같은 종류의 질문이다 — 전체화면 TUI 는 자기 커서를 직접 관리하므로 shadow cursor 캐럿이 의미 없다. 그것은 사용자가 입력 중인 **텍스트**에 대해 아무 말도 하지 않는다.
- **앵커는 오히려 더 단순하다**: alt 버퍼는 스크롤백이 없어 `baseY` 가 항상 0 이므로 절대 행 변환이 항등이다. vim 은 OSC 133 프롬프트도 sync frame 도 내지 않으므로 `computeUseShadowCursor` 가 거짓이 되어 앵커가 **라이브 버퍼 커서**에서 오고, 그것이 vim 이 커서를 둔 자리다.
- **스크롤 분기는 의도적으로 조합보다 위에 남긴다.** 실측으로 확인했다 — 조합 중 스크롤백을 올리면 프리뷰가 사라지지만 최하단으로 돌아오면 그대로 복귀하고 텍스트도 유실되지 않는다. 그리고 **숨기는 것이 옳다**: 프리뷰는 버퍼 행에 앵커돼 있어 히스토리를 보는 뷰포트 좌표로 그리면 엉뚱한 행에 찍히고, 사용자는 입력 줄을 보고 있지도 않다. 테스트로 못 박아 뒤집히지 않게 했다.
- **일괄 탈출구는 넣지 않았다.** "프리뷰가 안 그려지는 프레임이면 네이티브 조합 표시를 되살린다" 는 형태는 스크롤 중에도 발동하고, 네이티브 표시는 xterm textarea 위치에 뜨므로 스크롤백 중 위치 보장이 없다 — 지금 무해한 분기에 위치 오류를 만든다.
- **결함이 테스트로 못박혀 있던 다섯 번째 사례**: `"prioritizes alt buffer before all other visual owners"` 가 alt 버퍼가 조합보다 우선한다고 단정했다. 교체하고, caret 쪽(조합 없으면 여전히 `"alt-buffer"`)은 따로 고정했다.
- **alt 버퍼에서는 버퍼 커서가 언제나 권위다.** `baseY === 0` 은 행 변환이 항등이라는 뜻일 뿐 **어느 커서를 읽느냐**를 정하지 않는다. `computeUseShadowCursor` 는 `hasSyncFramePosition` 이면 참이 되는데, `getShadowSyncEligibility` 는 alt 버퍼에서 `"alt-buffer"` 를 돌려주며 **sync 를 통째로 스킵한다** — 포기한 값을 앵커로 쓰는 건 앞뒤가 안 맞는다. 그래서 `getAnchor` 에 `!shadow.isAltBufferActive` 를 더했다. vim 이 이 문제를 안 겪은 것은 OSC 133 도 DEC 2026 도 내지 않기 때문이고, 그건 **vim 의 성질이지 alt 버퍼의 성질이 아니다** — 처음에 "TUI 종류와 무관" 이라고 적은 것이 틀렸다.
  - 역검증: 조건을 빼면 alt 버퍼 안에서 DEC 2026 프레임을 낸 TUI 의 프리뷰가 얼어붙은 shadow 위치(`translate(100px, 100px)`)에 그려진다. 정답은 라이브 버퍼 커서(`translate(50px, 60px)`)다. 테스트 순서가 중요하다 — alt 버퍼 진입이 `hasSyncFramePosition` 을 초기화하므로 프레임은 진입 **뒤**에 와야 하고, 실제 TUI 순서도 그쪽이다.
- **버퍼 전환 경계는 안전하게 실패한다**(미검증 아님): normal 버퍼에서 잡은 앵커는 절대 행이고 alt 버퍼는 `baseY` 를 0 으로 만들므로 뷰포트 행이 `rows` 를 넘는다 → 뷰포트 가드가 **숨긴다**. 이탈은 부호가 반대(alt 의 작은 절대 행 − normal 의 큰 `baseY` → 음수)로 같은 가드에 걸린다. 양방향 모두 엉뚱한 행에 그리는 것이 아니라 숨기고, 다음 carry-over 가 새 버퍼 커서로 재기준화하므로 오차는 한 음절의 비가시성이다. 테스트로 고정했다.
- **불변식 — 네이티브 커서를 끄는 조건과 오버레이를 켜는 조건이 갈리면 캐럿이 사라진다.** `applyNativeCursorVisibility` 의 `hideNativeCursor` 는 `compositionPreview.active` 만으로 켜지고 alt 버퍼 항이 없다. 그래서 이 수정 전에는 alt 버퍼 조합 중 vim 커서가 (당시 수단인) 배경색으로 죽고 오버레이는 `"alt-buffer"` 에 막혀 **캐럿이 아무것도 없었다.** §8.15(#551), §8.16 에 이어 세 번째 같은 모양이다 — 한쪽 조건을 좁힐 때 반드시 다른 쪽을 함께 본다.
- **네 분기 판정 (이 이슈 종료 시점)**:

  | 분기                 | 사용자 상황                             | 판정                                                              |
  | -------------------- | --------------------------------------- | ----------------------------------------------------------------- |
  | `isAltBufferActive`  | 라이브 하단에서 입력 중, 영구히 안 보임 | **고쳤다** (조합이 우선)                                          |
  | `viewportScrolledUp` | 스크롤백 보는 중, 복귀 시 그대로 돌아옴 | 숨김 유지 — 버퍼 행 앵커라 뷰포트 좌표로 그리면 틀린 행           |
  | `syncOutputActive`   | DEC 2026 프레임 단위, 순간적            | 숨김 유지 — 깜빡임 수준                                           |
  | `!focused`           | 다른 곳을 보는 중                       | 숨김 유지 — **#556 이 blur 를 확정으로 처리하므로 유실이 아니다** |

  구조 진단(CSS 무조건 hide × 렌더러 하나)은 참이지만 결론은 "일괄 차단" 이 아니라 **분기마다 심각도를 재서 각각 판정** 이다. 셋은 "보이지 않지만 잃지 않는다" 로 닫히고, alt 버퍼만 라이브 하단 입력 중 영구히 안 보이는 유일 케이스였다.

- **미검증**: 다른 전체화면 TUI(less, htop, tmux)에서 실기 확인은 하지 않았다. 판정이 `isAltBufferActive` 하나에 걸려 있고 앵커도 버퍼 커서로 고정됐으므로 TUI 종류와 무관해졌지만, 실측은 vim 뿐이다.

---

### 8.18 프록시 모드에서는 조합 결과를 보내고 키를 보내지 않는다 (issue #558)

composer 모드로 vim 을 쓰면 `가나다라` 를 친 뒤 **Enter 도 Backspace 도 듣지 않았다.** 초안에 글자는 남아 있는데 제출도 삭제도 안 되는 고아가 된다. 같은 자리에서 `abcd` 는 Enter 없이 `a` 를 누르는 순간 vim 에 들어간다.

- **원인은 두 규칙의 교차**다. alt 화면에서 `passthroughComposerKey` 는 **모든 키**를 PTY 로 넘긴다(`if (!altScreen && !emptyPassthrough) return false;`) — 그래서 ASCII 가 타이핑하는 대로 앱에 들어간다. 반면 `TerminalInputComposer` 의 keydown 은 `isComposing || keyCode === 229` 인 동안 passthrough 를 **의도적으로 건너뛴다** — 조합은 textarea 소유라 키 단위로 중계할 수 없기 때문이다. 결과적으로 조합만 초안에 쌓이고, 그 다음부터 Enter·Backspace 는 초안이 아니라 앱으로 가서 초안에 손이 닿지 않는다.
- **판정: 키가 아니라 결과를 보낸다.** `compositionend` 에서 확정 텍스트를 PTY 로 바로 쓰고 초안에서 그만큼 덜어낸다(`resolveComposerCompositionCommit`). 한글이 ASCII 와 같은 경로·같은 타이밍이 되므로, 조합을 키로 쪼개려는 시도(자모 단위 중계, 조합 중 초안 우회) 없이 대칭이 회복된다.
- **판정 근거는 사용자가 이미 본 대비**다 — 같은 pane 에서 ASCII 는 즉시 들어가고 한글만 고아가 됐다. 즉 프록시 자체는 옳고 조합만 그 규칙 밖에 있었다.
- **빈 `data` 는 취소이므로 아무것도 쓰지 않는다.** §8.16 의 blur 확정과 같은 규칙 — 확정/취소 판단은 IME 것이고, 우리는 IME 가 주지 않은 텍스트를 만들어내지 않는다. composer 는 `event.data` 를 그대로 host 로 넘길 뿐 판정하지 않는다.
- **조합 전에 초안이 비어 있었을 때만 보낸다** (#560 에서 좁힘). 조합 구간은 캐럿 = 초안 끝이므로 확정 텍스트를 덜어내면 그 이전 초안이 나온다. 그것이 비어 있지 않으면 사용자가 작성 중이라는 뜻이고, 그때 키보드는 초안 것이므로(§8.19) 음절을 가로채면 한 문장이 두 목적지로 찢어진다. 그래서 그 경우는 초안에 남긴다 — 예전처럼 초안을 비우면 사용자 텍스트를 조용히 버리는 것이 된다.
- **초안이 확정 텍스트의 앞부분이면 그것은 이벤트 순서 지연이다.** 일부 IME 는 마지막 `input` 을 `compositionend` **뒤**에 보내므로 초안이 한 키 뒤처진 상태로 보인다(초안 `가나`, `data` `가나다`). 사용자 텍스트가 아니므로 "이전 초안 비어 있음" 으로 취급한다 — 아니면 그 음절이 초안에 갇힌다.
- **normal 버퍼는 건드리지 않는다.** 거기서 초안은 진짜 작성 표면이고 Enter 가 제출이므로(§8.8), 확정을 가로채면 "한 줄 다 쓰고 보내기" 가 깨진다. 판정을 `altScreen` 하나로 분기시켜 두 모드가 서로를 침범하지 않게 했다.
- **불변식 — 프록시 모드에서 초안은 목적지가 아니다.** 키가 PTY 로 흐르는 동안 초안에 쌓이는 텍스트는 그것을 꺼낼 키가 없으므로 도달 불가 상태가 된다. 초안에 무엇이든 넣는 경로를 alt 화면에서 열 때는 **꺼내는 경로가 같이 있는지** 반드시 확인한다.
- **역검증(3종)**: (1) composer 가 `onCompositionCommit` 을 안 부르면 → 확정이 PTY 로 가지 않고 초안에 남는다(고아 재현). (2) `altScreen` 가드를 빼면 → normal 버퍼 초안에서 글자가 새어나가 Enter 제출이 깨진다. (3) 초안을 덜어내지 않으면 → PTY 와 초안에 같은 글자가 이중으로 남는다. 셋 다 해당 테스트가 실패함을 확인했다.
- **남은 한계였던 부분은 §8.19(#560)에서 닫았다**: 붙여넣기·Tab recall·Shift+Enter 로 채운 초안도 고아가 되지 않는다.
- **미검증**: 실기 확인은 vim + Windows IME 한 조합만이다. macOS/Linux IME 의 `compositionend.data` 도 같은 계약이라고 보지만 측정하지 않았다.

---

### 8.19 빈 초안은 키보드를 빌려주고, 비어 있지 않은 초안은 쥔다 (issue #560)

#558 은 조합이 초안에 고아를 만드는 경로를 닫았지만, 같은 고아를 만드는 경로가 셋 더 남아 있었다 — **붙여넣기**, **Shift+Enter 줄바꿈**, **Tab recall 팝업**. 셋 다 keydown passthrough 를 거치지 않으므로 alt 화면에서도 초안에 텍스트를 넣고, 그 뒤 Enter·Backspace 는 앱 것이라 제출도 삭제도 안 된다.

- **판정: 규칙을 하나로 모은다.** `isComposerKeyProxyActive({ altScreen, draftEmpty })` — **빈 초안은 키보드를 빌려주고, 비어 있지 않은 초안은 쥔다.** 새 규칙이 아니라 §8.8 이 이미 쓰던 규칙(`ctx.empty` 일 때만 nav 키·제어 chord 를 넘김)을 alt 화면까지 일관되게 적용한 것이다. 전체화면 앱은 화면을 독점하므로 "빌려주는 키 집합" 이 전체 키로 넓어질 뿐이다.
- **비어 있지 않은 쪽이 규칙을 안전하게 만든다.** 초안에 있는 텍스트는 **화면에 보이고**, 그것을 제출하는 키(Enter)와 지우는 키(Backspace)가 초안에 남으므로 언제나 탈출구가 있다. #560 은 이 절반이 없어서 생긴 이슈다.
- **유입 경로마다 같은 판정을 묻는다.** passthrough 를 안 거치는 세 제스처가 각각 `isKeyProxyActive` 를 호출한다 — Shift+Enter 는 프록시 중이면 Enter 로 넘어가고, Tab 은 팝업을 열지 않고 `\t` 로 나가고, 붙여넣기는 Direct 모드 네이티브 붙여넣기와 **같은 쓰기 경로**로 앱에 들어간다. 판정 소유자가 하나라 keydown 게이트와 세 제스처가 갈라지지 않는다.
- **잔여 초안은 실제로 존재한다** — shell 에서 초안을 쓰고 Direct 로 토글, 그 상태로 앱을 띄우고 Composer 로 돌아오면 alt 화면에 초안이 남는다. 유입을 막는 것만으로는 이 경로가 닫히지 않으므로, 비어 있지 않은 초안에 키를 돌려주는 절반이 반드시 필요하다. 테스트로 고정했다(Backspace 는 PTY 로 안 가고, Enter 는 초안을 제출한다).
- **전체화면 앱에서 초안을 새로 만들 수는 없다** — 빈 초안에서는 인쇄 문자도 앱으로 가기 때문이다. 이는 손실이 아니라 프록시의 정의다. 실제로 #558 이전에도 alt 화면에서 타이핑은 앱으로 갔으므로 동작 변화가 없고, 오히려 "긴 프롬프트를 붙여넣어 Claude Code TUI 에 넣기" 는 초안에 갇히지 않고 앱에 들어가게 됐다.
- **대가: 초안이 비어 있지 않으면 Ctrl+C 도 앱에 가지 않는다.** 전체화면 앱이 멈춘 상태에서 초안에 글자가 남아 있으면 먼저 초안을 지워야 인터럽트가 된다. 예외를 두지 않은 이유는 **shell 쪽 규칙이 이미 그렇기 때문**이다 — `emptyPassthrough` 는 제어 chord 도 `ctx.empty` 에 묶어 두었으므로, alt 화면에만 chord 예외를 만들면 규칙이 다시 둘로 갈린다. 초안은 이제 사용자 것이므로 지우는 것은 한 번의 Backspace 범위 안에 있다.
- **붙여넣기 chord 자체는 절대 프록시하지 않는다.** 실기에서 Ctrl+V 가 다른 키처럼 넘어가 앱에 `^V`() 가 찍히고, `preventDefault` 때문에 클립보드 텍스트를 실어오는 `paste` 이벤트가 아예 생성되지 않았다. keydown 단계가 이기므로 onPaste 는 호출될 기회가 없다. `matchesKeybinding(event, "terminal.paste")` 는 프록시에서 제외해 기본 동작을 살리고, 뒤따르는 `paste` 이벤트가 라우팅을 맡는다(재바인딩 인식). Ctrl+C 는 그대로 앱에 간다 — alt 화면에서 그것은 SIGINT 다.
- **붙여넣기의 "비었나" 는 textarea 의 live value 로 판단한다.** controlled `text` prop 은 편집보다 한 렌더 뒤처지므로, 그것으로 판정하면 composer 는 프록시로 보고 이벤트를 소비하는데 host 는 비어 있지 않다고 보아 아무 데도 쓰지 않는다 — 붙여넣기가 사라진다. 그래서 host 쪽 `pasteComposerProxy` 는 비어 있음을 **다시 계산하지 않고** 소유권·alt 화면만 확인한다. 판정 하나, 소유자 하나.
- **불변식(§8.18 에서 이어짐) — 초안에 넣는 경로를 열 때는 꺼내는 경로를 같이 본다.** 이제 그 확인이 판정 함수 하나로 표현된다: 넣기 전에 `isComposerKeyProxyActive` 를 물어라. 참이면 목적지는 초안이 아니라 PTY 다.
- **역검증(4종)**: (1) 판정에서 `draftEmpty` 를 빼면 → 잔여 초안이 다시 고아가 되고 #558 의 "조합만 확정" 동작도 무너진다. (2) Shift+Enter 의 프록시 검사를 빼면 → alt 화면에서 줄바꿈이 초안에 들어간다. (3) Tab 의 프록시 검사를 빼면 → 앱이 `\t` 를 못 받고 팝업이 열린다. (4) 붙여넣기 검사를 빼면 → 붙여넣기가 초안에 남는다. 넷 다 해당 테스트가 실패함을 확인했다.
- **미검증**: 붙여넣기는 bracketed paste(`ESC[200~`) 로 감싸지 않는다 — Direct 모드 네이티브 붙여넣기와 동일한 동작이므로 의도적으로 맞췄지만, 그래서 vim insert 모드에 여러 줄을 붙여넣으면 autoindent 가 개입한다. 두 모드 공통 문제이므로 이 이슈에서 손대지 않았다.

### 8.20 WebGL atlas 는 pane 사이에서 공유된다 — 지운 쪽이 전원에게 알린다 (issue #571, #573)

`@xterm/addon-webgl` 의 texture atlas 는 render config(폰트·셀 크기·색·DPR)가 같은 **Terminal 인스턴스끼리 공유**된다(`CharAtlasCache.acquireTextureAtlas`). §8.4 가 부르는 `clearTextureAtlas()` 는 그 공유 atlas 를 지우면서 **호출한 터미널의 모델만** 다시 맞춘다. 나머지 터미널의 vertex 에는 지워진 페이지의 옛 좌표가 남고, 그 자리에 다른 문자가 다시 rasterize 되면 옛 좌표는 경계에 걸친 **glyph 조각**을 그린다.

- **판정 소유자는 `webgl-atlas-rebuild.ts` 하나다.** "atlas 가 지워졌다 → 누가 다시 그려야 하는가" 를 이 모듈만 답한다. `TerminalView` 는 마운트에서 재구성 콜백을 등록(instance id 키)하고, `rebuildTerminalRenderer()` 에서 보고만 한다.
- **리페인트로는 못 고친다.** `WebglRenderer._updateModel()` 은 code·색이 모델 캐시와 같은 셀을 건너뛴다. `refresh(0, rows-1)` 은 행을 훑되 vertex 를 다시 쓰지 않으므로 stale 좌표가 살아남는다. 그래서 재구성은 **`clearTextureAtlas()` + 전체 refresh** 다 — 모델을 비워야 모든 셀이 `updateCell()` 을 다시 통과한다. 이미 비어 있는 atlas 에 대한 `clearTexture()` 는 early-return 이라 전원 호출이 안전하다.
- **왜 조용한 pane 만 깨지나.** 워크스페이스 복귀에서는 pane 들이 한 task 안에서 함께 지우므로 서로를 해치지 않는다. 문제는 출력이 많은 pane 의 fit 이 write drain 을 기다리다 **뒤늦게 혼자 지울 때**다(계측: 일괄 clear 3건 뒤 525ms 만에 1건 추가). 그 시점에 이미 리페인트를 끝낸 pane 이 stale 이 되고, 바쁜 pane 은 스스로 계속 다시 그려 낫는다. `watch` 처럼 부분만 갱신하는 pane 이 가장 오래 깨진 채 남는다.
- **coalesce 는 microtask 하나.** 같은 task 의 clear 여러 건을 한 pass 로 덮고 다음 paint 전에 끝낸다. pane 마다 `ResizeObserver` 가 따로 있으므로 워크스페이스 복귀는 여전히 **pane 당 pass 하나**다. rAF 로 넓히면 pass 는 줄지만 clear 와 재구성 사이에 깨진 프레임이 한 번 보인다 — 막으려던 그 화면이다.
- **pass 는 많아도 재구성은 프레임당 터미널 하나** (#573). 이번 프레임에 이미 응답한 터미널은 다음 pass 가 건너뛰므로 N pane 복귀는 O(N²) 가 아니라 **O(N)** 이다. 근거는 모델 상태다 — 재구성 직후 모델은 비어 있고, 그것을 다시 채우는 것은 `renderRows` 뿐이며 xterm 은 그것을 항상 rAF 에서 돌린다. 프레임 집합은 **다음 animation frame 에 비우고**, 그 전에 그린 터미널은 `noteTerminalRendered()`(xterm `onRender` → `TerminalView`) 로 즉시 빠진다. rAF 없는 호스트에서는 skip 하지 않는다. 집합 등록은 `rebuild()` **앞**이다 — 동기 paint 가 보고한 delete 를 뒤늦은 add 가 덮으면 안 되므로, 던진 콜백만 `catch` 에서 되돌린다.
- **"터미널당 1회" 는 조용한 pane 기준이다.** 복귀 중에도 계속 그리는 pane 은 `onRender` 마다 집합에서 빠지므로 다음 pass 의 대상이 된다. paint 로 모델이 다시 채워졌으니 필요한 재구성이고, 계측이 pane 수를 넘어도 회귀가 아니다.
- **숨은 pane 은 팬아웃에서 빠진다** (#573). §8.4 가 hidden 터미널을 건드리지 않는 것과 같은 규약이고, hide→show 복귀가 `recoveringFromHidden` 에서 무조건 재구성하므로 **복귀 시 정확히 한 번**이 유지된다. 여기서 `reflowDirtyRef` 를 세우면 복귀가 guarded-fit 분기로 넘어가 재구성이 두 번이 되므로 세우지 않는다. "숨었나" 는 `TerminalView` 판정이라 코디네이터가 아니라 등록된 콜백이 답한다.
- **단독 보고자는 건너뛰되, 자기 재구성이 실패했으면 보고자로 안 쳐준다.** wipe 는 공유 atlas 에 닿았는데 자기 모델만 안 비워진 상태라 남들과 똑같이 stale 이기 때문이다. 건너뛴 보고자는 프레임 집합에 **넣지 않는다** — 넣으면 프레임당 재구성 1회를 아끼지만, "두 번째 wipe 가 이미 빈 atlas 에 닿아도 무해하다" 는 추론을 한 pass 에서 프레임 전체로 넓히게 된다. 위 보수적 판단과 같은 이유로 뺐다. pass 중에 올라온 보고는 무시한다(재구성 콜백이 되보고하면 microtask 무한 재예약).
- **범위: 공유 여부를 우리가 계산하지 않는다.** xterm 은 "누가 이 atlas 를 쓰는가" 를 노출하지 않고, `configEquals` 를 재현하면 같은 질문의 소유자가 둘이 된다(§8.19 의 실패 패턴). 통보는 등록된 전 터미널에 보낸다.
- **역검증**: `notifyTextureAtlasCleared()` 를 제거하면 같은 재현 스크립트에서 조용한 pane 전체가 다시 조각난다(실기 확인). 단위 테스트도 실패한다. hidden 가드를 빼면 숨은 pane 이 팬아웃에서 `clearTextureAtlas()` 를 받고, 프레임 집합을 빼면 6 pane / 6 pass 호출 횟수가 6 에서 30 으로 돌아간다(둘 다 해당 테스트 실패 확인).
- **미검증**: 저사양 GPU·소프트웨어 렌더링 폴백, 폰트 config 가 서로 다른 pane 이 섞인 구성, 원격(브라우저) 렌더러. #573 의 비용 축소는 단위 테스트로만 고정했고 #571 실기 재현은 사람이 다시 확인해야 한다.

판정과 대안 비교는 [ADR-0064](../adr/0064-shared-webgl-atlas-clear-fanout.md).

---

### 8.21 네이티브 커서 숨김은 렌더러 게이트에서 한다 (issue #598)

overlay caret 이 켜져 있는데도 codex 입력박스에 **어두운 1셀 블록이 하나 더** 보였다. #596 캡처의 픽셀 측정: 열 20 은 의도된 `.terminal-overlay-caret`(`#FFFFFF`), 열 39 는 꽉 찬 `#0C0C0C` — 즉 "숨겼다" 고 가정한 네이티브 커서가 테마 배경색으로 그려진 블록이었다.

- **원인은 소유권이다.** 예전 `hideNativeCursor` 는 앱이 언제든 되돌릴 수 있는 두 채널에 숨김을 걸고 있었다.
  - **색**: `theme.cursor`/`cursorAccent` 를 테마 배경색으로 칠하는 것은 "커서 셀의 배경 = 테마 배경" 일 때만 성립한다. codex 는 입력박스 행을 `ESC[48;2;41;41;41m`(`#292929`)로 칠하므로 `#0C0C0C` 커서가 **대비로 드러난다**. 밝은 스킴은 반대 방향으로 튄다.
  - **모양**: `options.cursorStyle` 은 권위가 아니다. xterm 6.0.0 의 두 렌더러 모두 `coreService.decPrivateModes.cursorStyle ?? options.cursorStyle` 순서로 읽고 DECSCUSR(`CSI Ps SP q`)가 그 DEC 모드를 쓴다 — 계약 테스트로 고정했다(`ESC[2 q` → `decPrivateModes.cursorStyle === "block"` 이고 `options.cursorStyle` 은 `"bar"` 그대로, `ESC[0 q` → `undefined`). 해결된 모양이 `block` 이면 렌더러는 셀을 커서 색으로 칠하고 글리프를 `cursorAccent` 로 그리므로, 위 색 위장과 겹쳐 **배경색으로 꽉 찬 1셀**이 된다. 캡처의 열 39 가 그것이고, `terminal.refresh()` 로 덮어도 다음 프레임에 되돌아온다.
- **판정: `coreService.isCursorHidden` 게이트에서 끈다.** 두 렌더러가 커서를 그릴지 정하는 유일한 조건이 `isCursorInitialized && !isCursorHidden` 이다(WebGL 은 model 빌드에서, DOM 렌더러는 row factory 에서 같은 필드를 읽는다). SGR·DECSCUSR·테마는 여기에 닿지 못하므로 경합이 없어진다. 포커스 없는 커서도 같은 게이트 아래라 `cursorInactiveStyle` 을 따로 맞출 필요가 없다.
- **계약**: 셀 배경이 무엇이든, 앱이 DECSCUSR 를 몇 번 보내든, 포커스가 있든 없든 숨김 구간에서 네이티브 커서는 그려지지 않는다.
- **앱의 DECTCEM 은 여전히 권위다.** 같은 필드를 DECTCEM(`?25h/l`)이 쓰고, §8.5/[ADR-0011](../adr/0011-dectcem-cursor-park-fifth-layer.md) 은 프레임 밖 `?25h` 를 앱의 최우선 커서 신호로 쓴다. 그래서 `ui/src/lib/native-cursor-suppression.ts` 는 필드를 accessor 로 감싸 **앱의 쓰기를 기록**하고 우리가 숨기는 동안만 hidden 을 보고한다. 앱 값은 `appCursorHidden` 으로 보존되고 해제·`dispose()` 시 그대로 복원된다. 우리 쓰기는 파서를 거치지 않으므로 shadow cursor 의 DECTCEM CSI 추적에 보이지 않는다 — 보여서는 안 된다.
- **테마·모양·`cursorWidth` 는 숨김 여부와 무관하게 사용자 설정이다.** 숨김 구간에서 달라지는 유일한 옵션은 `cursorBlink = false` 다(안 보이는 커서의 깜빡임은 repaint 낭비).
- **base 조건의 소유자는 하나다.** `applyNativeCursorVisibility`만 `baseHideNativeCursor`(composer 모드 · 조합 중 · `stabilizeInteractiveCursor` + overlay caret activity)를 계산한다. 조합 상태는 ref에만 있어 React가 볼 수 없으므로 React는 `nativeCursorVisibilityRef`를 **호출만** 하고 조건을 다시 계산하지 않는다. DEC 2026은 별도 `syncOutputCursorGateActive` reason을 소유하고, 최종 `applyNativeCursorGate`가 둘을 OR한다. 어느 reason의 전이도 다른 reason을 덮지 않는다.
- **`isCursorHidden`은 옵션이 아니다.** base 전이만 사용자 cursor option을 동기화하고 `refresh(0, rows-1)`를 한 번 호출한다. sync set/reset은 option을 바꾸지 않으며 정상 reset에는 xterm의 기존 전체 flush만 사용한다. safety timeout에서만 monitor가 gate 해제 후 corrective refresh를 한 번 요청한다 — §8.4의 폭주 중 repaint 제한을 유지한다.
- **실패하면 스스로 꺼진다.** private 필드 형태가 달라지면 `supported: false` 로 아무것도 하지 않고 네이티브 커서가 사용자 설정대로 보인다(overlay 와 겹친 이중 캐럿). #598 을 만든 배경색 위장으로 되돌아가지 않는다. `XTERM_NATIVE_CURSOR_FIELDS` 와 실제 `Terminal` 계약 테스트가 xterm 상향 시 읽을 수 있는 실패를 만든다 — §8.14 의 `xterm-pending-composition.ts` 와 같은 정책.
- **DOM renderer용 CSS는 base gate를 미러링할 때만 둔다.** `.terminal-native-cursor-hidden .xterm-cursor { opacity: 0 }`는 `onContextLoss` fallback의 방어선이고(§8.4) composer/IME selector도 같은 base reason의 입력을 미러링한다. synchronized-output은 raw gate reason은 있지만 CSS cursor rule은 두지 않는다. CSS는 WebGL의 마지막 paint에 닿지 않아 DOM만 즉시 숨기는 비대칭을 만들기 때문이다(issue #610).
- **synchronized-output은 lifecycle 우회용 raw reason이다.** 표준 write/refresh는 xterm `RenderService`가 보류하지만 DOM focus·blur·selection은 renderer를 직접 호출한다. `setSyncOutputActive`는 frame boundary 공표와 sync raw reason을 함께 소유하고, 정상 reset 전에 해제한다(아래 §8.22, [ADR-0079](../adr/0079-dec2026-cursor-gate-lifecycle-bypass.md)).
- **미검증**: 실기 확인은 하지 않았다(테스트만). codex pane 에서 열 39 블록이 실제로 사라지는지, 그리고 DECRQM 25 조회 응답이 숨김 구간에 "hidden" 으로 바뀌는 것(게이트가 필드 하나이므로 불가피)에 반응하는 앱이 있는지는 사람이 확인해야 한다.

판정과 대안 비교는 [ADR-0073](../adr/0073-native-cursor-renderer-level-suppression.md).

---

### 8.22 DEC 2026 cursor gate와 renderer lifecycle 우회 (issue #610)

`.terminal-sync-output-active .xterm-cursor { opacity: 0 }`는 DOM fallback에만 닿는다. 실제 xterm 6.0.0은 표준 행 갱신을 DEC 2026 frame 동안 보류하지만, 그 사실만으로 cursor가 안전하지는 않다.

- **표준 경로는 보류된다.** `RenderService.refreshRows`와 `_renderRows`는 mode가 켜져 있으면 범위만 `SynchronizedOutputHandler`에 누적한다. write, 공개 `terminal.refresh()`, WebGL cursor redraw는 정상 reset 또는 1초 safety timeout의 전체 flush까지 기다린다.
- **DOM lifecycle은 이 gate를 우회한다.** `handleFocus`, `handleBlur`, `handleSelectionChanged`는 DOM renderer의 `renderRows()`를 직접 호출한다. 실번들에서 frame 내부 buffer를 `OLD`→`NEW`와 다른 CUP 위치로 바꾼 뒤 blur/focus하면 mode가 여전히 true이고 `onRender`가 0회인데도 DOM row와 cursor가 새 위치로 이동했다. 따라서 `onRender === 0`은 화면 전체 동결의 증거가 아니다.
- **sync raw reason이 cursor만 보호한다.** `?2026h` parser handler가 `syncOutputCursorGateActive=true`를 먼저 적용하므로 직접 DOM paint는 새 내용을 그릴 수 있어도 `isCursorHidden`을 읽어 미확정 cursor는 만들지 못한다. 이 계약은 전체 frame content atomicity를 보장하지 않는다.
- **정상 reset에는 추가 repaint가 없다.** `?2026l` custom handler가 xterm mode reset보다 먼저 sync reason을 해제하고, 바로 뒤 xterm 전체 flush가 최종 cursor를 그린다. base suppression이 남아 있으면 OR 결과는 계속 hidden이다.
- **safety timeout만 recovery refresh를 요청한다.** xterm이 parser reset 없이 mode를 내리고 full render를 요청하면 rAF monitor가 그 전이를 감지해 sync reason을 해제하고 full refresh를 정확히 한 번 요청한다. xterm의 debounced render와 monitor의 실행 순서는 보장하지 않으며 같은 frame에서는 두 요청이 coalesce될 수 있다.
- **CSS 역할을 분리한다.** sync class는 실제 DOM helper textarea의 OS caret와 frame boundary 소비자를 위해 유지한다. `.xterm-cursor` sync rule은 제거한다. DOM cursor의 CSS blink는 frame 중 계속될 수 있고 직접 lifecycle paint가 없으면 pre-frame cursor가 남을 수 있지만, 잘못된 새 위치를 노출하지 않는 것이 보장 범위다.
- **검증 계층**: `ui/src/test/screen/dec2026-render-suppression.screen.test.ts`는 실제 DOM renderer에서 표준 refresh 보류, blur/focus 우회, gate 적용, 정상 reset, xterm safety timeout을 검증한다. `TerminalView.test.tsx`는 option churn 없음, timeout corrective refresh 1회, base/sync reason의 독립성을 검증한다. jsdom에는 WebGL context가 없으므로 canvas pixel parity는 주장하지 않는다([ADR-0074](../adr/0074-xterm-cell-grid-screen-test-tier.md)).

판정과 대안 비교는 [ADR-0079](../adr/0079-dec2026-cursor-gate-lifecycle-bypass.md).

---

## 9. WorkspaceSelectorView (cmux 클론)

### UI 구조

```
┌───────────────────────────────┐
│  + New Workspace              │
│  ▤ Default            [default]│  ← 레이아웃 카드(클릭 시 그 레이아웃으로 생성)
│  + 현재 레이아웃을 새로 저장  │  ← 현재 워크스페이스 pane 배치 → 새 레이아웃
├───────────────────────────────┤
│ WORKSPACES     [Hidden 2] [≡] │  ← 섹션 헤더: 유효 hidden workspace chip + 정렬 토글
│  (chip 클릭 시 바로 아래에    │
│   workspace 전용 보관함 전개) │
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

### 레이아웃 저장(Export New)

- 현재 워크스페이스의 pane 배치를 새 레이아웃 템플릿으로 저장하는 액션(`exportAsNewLayout`)은 상단 바가 아니라 **selector 의 "New Workspace" 패널 안, 레이아웃 카드 목록 바로 아래**에 있다. 쓰는 곳과 읽는 곳이 같은 표면이라 저장 직후 새 카드가 그 자리에서 보인다. 기존 레이아웃 덮어쓰기(`exportToLayout`)는 각 카드의 ⋯ 메뉴가 계속 소유한다.
- `GridEditToolbar` 는 창/도크 제어와 위젯 슬롯만 담당하며 레이아웃 액션을 갖지 않는다.

### 숨김 상태 파생과 복원

- `uiStore.hiddenWorkspaceIds`와 `hiddenPaneIds`는 localStorage에 저장하는 독립 raw state다. UI는 이 set을 직접 세어 표시하지 않고 `lib/hidden-items.ts`의 `deriveHiddenItems`가 현재 workspace 구조와 함께 계산한 visible 목록, 유효 숨김 개수, stale ID, shelf grouping을 사용한다([ADR-0005](../adr/0005-display-state-raw-separation-compute.md), [ADR-0033](../adr/0033-hidden-items-shelf-set-contract.md)).
- **보관함(shelf)은 hidden workspace 전용이며, 그것을 여는 count chip 바로 아래(목록 위)에 인라인으로 열린다**([ADR-0035](../adr/0035-workspace-only-shelf-per-pane-hide-toggle.md)). chip 카운트도 유효 hidden workspace 수만 세고, hidden pane 은 chip·보관함 어디에도 나타나지 않는다.
- workspace 행의 quick-hide 버튼은 항상 DOM에 존재하고 hover 또는 `:focus-within`에서 시각화된다. 숨김은 즉시 반영하며 최근 action은 5초 Undo snackbar로 되돌릴 수 있다.
- active workspace를 숨길 때의 visible fallback은 일반 workspace 전환과 같은 `workspace-transition.ts`의 `switchActiveWorkspace` 착지 경로를 사용한다. 따라서 이전 dock focus를 지우고 전역 `focusedPaneIndex`를 fallback workspace의 유효 pane으로 다시 계산한 뒤 숨김 raw state를 적용한다(issue #578, [ADR-0081](../adr/0081-pane-focus-transition-single-owner.md)). Selector 클릭·생성·복제, 키보드, Automation/Remote, 외부 상태 주입을 수선하는 coordinator도 각자 store를 조립하지 않고 같은 전환 소유자를 사용한다.
- **Pane 숨김은 workspace grid 의 각 pane 컨트롤바 eye 토글로만 제어한다**(숨김·복원 모두). selector 의 pane 요약 행에는 숨김 버튼이 없고, 숨겨진 pane 행은 목록에서 필터된다. dock pane 은 selector 에 나오지 않으므로 토글을 노출하지 않는다.
- 보관함의 기본 복원(행 클릭)은 workspace 를 다시 표시하고 활성화한 뒤 보관함을 닫으며, eye 버튼은 표시만 하고 다른 hidden workspace가 남아 있으면 보관함을 유지한다. "모두 표시"는 hidden workspace set 만 비우고 개별 숨김 pane flag 는 유지한다.
- workspace 를 복원해도 그 아래 pane 의 raw hidden flag 는 유지된다(복원은 pane 토글 소관).
- active workspace를 숨길 때는 현재 정렬 순서에서 다음 visible workspace를 먼저 활성화한다. 마지막 visible workspace는 숨길 수 없다. `useHiddenItemsCoordinator`는 Automation·세션 교체·구조 삭제처럼 selector 밖에서 raw state가 바뀌는 경우에도 이 불변식과 stale ID 정리를 즉시 적용한다.
- 명시적 `setPaneHidden`/`setWorkspaceHidden` 복원은 같은 store 전환에서 관련 `evictedPaneIds`를 지운다. 유효 hidden workspace 가 0 이 되면(hidden pane 존재 여부와 무관하게) 보관함도 닫힌다.

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

| 항목                | 데이터 소스                           | 표시 조건                  |
| ------------------- | ------------------------------------- | -------------------------- |
| Workspace 이름      | 사용자 지정                           | 항상                       |
| git branch          | OSC 133E 감지 또는 `.git/HEAD` watch  | 있을 때                    |
| working directory   | OSC 7 감지                            | 있을 때 (브랜치와 같은 줄) |
| 리스닝 포트         | 주기적 `ss -tlnp` / `netstat` 조회    | 활성 워크스페이스만        |
| 마지막 명령 + 결과  | OSC 133 E/D → `lx set-command-status` | 있을 때                    |
| 최신 알림 텍스트    | OSC 9/99/777 또는 `lx notify`         | 읽지 않은 알림 있을 때     |
| 읽지 않은 알림 배지 | 알림 시스템                           | 카운트 > 0                 |
| 알림 링 (테두리)    | 알림 발생 시                          | 읽지 않은 알림 있을 때     |

### 마지막 명령 표시 (Activity-Aware Computation)

표시 항목(아이콘, 색상, 텍스트)은 **원시 상태를 변경하지 않고**, activity 타입을 추가 입력으로 받아 계산 함수에서 분기하여 도출한다.

#### 기본 (셸, activity = none)

| 우선순위 | 조건                           | 아이콘 | 색상 |
| -------- | ------------------------------ | ------ | ---- |
| 1        | `outputActive === true`        | ⏳     | 노랑 |
| 2        | `exitCode === 0`               | ✓      | 초록 |
| 3        | `exitCode !== undefined` (≠ 0) | ✗      | 빨강 |
| 4        | 나머지 (유휴/대기)             | —      | 회색 |

#### Activity-Aware 분기 원칙

`computeCommandStatus(rawState, activity)` 함수는 activity 타입에 따라 **status(아이콘/색상)**, **statusMessage(텍스트)**, **notification(알림 발생 여부/내용)** 세 가지를 최적화한다.

| 항목              | 셸 (기본)                   | Claude Code (activity = Claude)   |
| ----------------- | --------------------------- | --------------------------------- |
| **status**        | OSC 133 C/D 기반 4상태      | working/idle 전환 + 합성 exitCode |
| **statusMessage** | 셸 명령 텍스트 (`npm test`) | 태스크 설명 (`Working on task`)   |
| **notification**  | exitCode ≠ 0 → 실패 알림    | task_completed 메시지 기반 알림   |

**설계 규칙**:

- 원시 상태(`commandText`, `exitCode`, `outputActive`, `title` 등)는 activity와 무관하게 독립 저장한다. 하나의 공유 필드를 앱별로 덮어쓰지 않는다.
- 계산 함수는 원시 상태 + activity 타입을 입력받아 최종 표시를 도출한다. activity 타입이 추가되면 계산 함수에 분기만 추가한다.
- 앱 전용 분기 로직은 [api-contracts.md](./api-contracts.md) §15.6(앱 전용 편의 코드 격리)에 따라 격리된 모듈에 구현하고, 계산 함수에서 import하여 사용한다.

명령 텍스트는 최대 30자로 truncate, 시간은 상대 시간(방금, N분 전, N시간 전)으로 표시.

#### 출력 기반 메시지 추출 (Codex 대화 · Claude recap)

`statusMessage`(=`activityMessage`)는 타이틀뿐 아니라 TerminalView 의 16KB rolling 출력 버퍼에서 직접 추출한 텍스트로도 채워진다. 추출기는 모두 `activity-detection.ts` 에 있으며 TerminalView 의 출력 콜백에서 현재 activity 분기에 따라 호출된다. Codex 분기는 `detectCodexConversationMessageFromOutput` 로 assistant bullet(`• …`) 라인을 골라 surfacing 하고, `nextCodexMessage && current.activityMessage !== nextCodexMessage` dedup 으로 같은 메시지 재기록을 막는다.

Claude 분기는 unfocused 세션 복귀 시(또는 `/recap`) 스크롤백에 출력되는 한 줄 요약을 `detectClaudeRecapFromOutput` 로 추출한다. 시그니처는 `※ recap: <요약> (disable recaps in /config)` — `※` 는 U+203B(REFERENCE MARK). 요약의 끝은 **명시적 종료자가 있어야만** 인정한다: 접미 힌트(`(disable recaps in /config)`) 또는 박스 드로잉 라인(`─` 3회+ 연속). EOF 폴백은 의도적으로 없다 — 스트리밍 중 잘린 미완성 recap 이 surfacing 되는 것을 막는 게이트다(#306 리뷰). recap 은 alt-screen 에서 CUP/CUF 커서 이스케이프로 여러 행에 wrap 되어 그려지므로, 단순 SGR 제거가 아니라 `stripAnsi`(CUP→`\n`, CUF(N)→N 칸 공백)로 정규화한 뒤 공백 런을 한 칸으로 접어 원래 한 줄로 복원한다. 버퍼에 여러 recap 이 누적되면 **마지막(최신)** 것을 취한다. surfacing 은 Codex 대화 메시지와 동일하게 `activityMessage` 경유이며(`ClaudeActivityHandler.computeStatusMessage` 의 `bullet` 경로), input-pending 모달이 떠 있는 동안(`CLAUDE_INPUT_PENDING_MARKER`)에는 recap 으로 덮어쓰지 않는다. 별도 notification 은 발생시키지 않는다.

#### 세션 리미트 자동 복귀 (Claude, issue #312)

Claude Code 가 세션 리미트에 걸리면 스크롤백에 `⎿  You've hit your session limit · resets 1:50pm (Asia/Seoul)` 배너를 출력한다. TerminalView 의 Claude 분기는 같은 16KB rolling 버퍼에서 `detectClaudeSessionLimitFromOutput`(`claude-session-limit.ts`, 순수 모듈)로 이 배너를 감지하고, `computeSessionLimitResumeAt` 으로 **다음 reset 시각 + 대기 시간**(UTC epoch)을 계산해 타이머를 예약한다. 시각 파싱은 12시간제 am/pm + 선택적 IANA 타임존(`(Asia/Seoul)`)을 지원하며, 타임존이 없거나 무효하면 로컬 타임존으로 해석한다. reset 시각이 이미 지난 경우 다음 날로 롤오버하되, **10분 grace** 이내로 막 지난 경우는 "오늘 이미 해제됨"으로 보고 즉시(또는 남은 delay 만큼만 기다려) 복귀한다.

타이머 발화 시 설정된 복귀 문구(기본 `"go on"`)를 PTY 에 쓰고, **150ms 후 단독 `\r`(CR)** 로 제출한다 — Claude Code TUI 에서 `\n` 은 줄바꿈만 발생하기 때문. 중복 발화 방지는 두 가지: 같은 reset 시각 키(`"13:50|Asia/Seoul"`)로 타이머가 이미 pending 이면 skip, 발화 직후 버퍼에 남은 배너 잔여물이 다음 날 타이머를 재예약하지 않도록 같은 키는 6시간 동안 재무장 금지. 예약/발화 시 각각 notification 을 발행한다. 설정은 `claude.sessionLimitAutoResume`/`sessionLimitResumeDelaySeconds`/`sessionLimitResumeMessage`([api-contracts.md](./api-contracts.md) Claude Code 설정).

### outputActive 감지 (워크스페이스 상태 관리 원칙)

`outputActive`는 ⏳ 아이콘(우선순위 1)을 결정하는 프론트엔드 전용 상태다. **두 가지 독립된 감지 경로**가 있으며, 백엔드에서 직접 `outputActive`를 계산하지 않는다.

| 감지 경로     | 대상                                                                | 신호                             | 동작                                                                     |
| ------------- | ------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| OSC 133 C/D   | 셸 명령 (pytest, apt 등)                                            | preexec → precmd lifecycle       | `commandRunning` → `outputActive`                                        |
| DEC 2026h     | TUI 앱 (Claude Code, neovim 등)                                     | `\x1b[?2026h` (동기화 렌더 시작) | Rust PTY 콜백에서 감지 → `terminal-output-activity` 이벤트               |
| 타이틀 스피너 | TUI 앱 thinking 단계 ([api-contracts.md](./api-contracts.md) §15.6) | OSC 0/2 타이틀 스피너 회전       | Rust PTY 콜백에서 `now_working` 감지 → `terminal-output-activity` 이벤트 |

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

| 상황                            | DEC 2026h 횟수  | 결과                                        |
| ------------------------------- | --------------- | ------------------------------------------- |
| 포커스 전환 (DEC 1004 → 리드로) | 1회             | 무시 (임계값 미달)                          |
| 키 입력 에코 (타이핑)           | 키당 1회        | 무시 (일반 타이핑 속도로는 2초 내 6회 미달) |
| Claude Code 응답 생성           | 수십~수백 회/초 | ⏳ 활성 (즉시 임계값 충족)                  |
| neovim 화면 갱신                | 수십 회/초      | ⏳ 활성 (즉시 임계값 충족)                  |

### 인터랙티브 앱 인식 — 프로세스 트리 liveness ([ADR-0009](../adr/0009-process-tree-interactive-app-liveness.md))

Claude Code·Codex 가 실행 중인지의 **권위는 PTY 자식 프로세스 트리**다. 타이틀(`Claude Code`/`OpenAI Codex` 배너·스피너)과 인메모리 캐시(`known_{claude,codex}_terminals`)는 앱 식별·작업/유휴·메시지 추출의 보조 신호일 뿐, "살아있는가/종료됐는가"의 최종 판정은 프로세스 트리가 한다.

- **오라클(3-state `PtyAppLiveness`)**: `process_tree::interactive_app_in_pty(state, terminal_id)` 가 PTY `child_pid` 의 자손 트리를 BFS 로 훑어 `claude.exe`/`codex.exe`(Linux: `claude`/`codex`)를 찾는다. `Running(app)`(가장 얕은 매치 = 포그라운드 앱) / `NoneAlive`(PID·스냅샷 성공 + 앱 없음 = 권위 있는 부재) / `Unknown`(PID 없음·serial·스냅샷 실패 = 신호 없음). 전역 스냅샷은 1초 TTL 로 캐시해 스피너 틱마다의 재열거를 막는다(종료 판정만 fresh 우회).
- **양성 권위**: `is_{claude,codex}_terminal_from_buffer` 는 오라클이 `Running(해당 앱)` 이면 타이틀/버퍼와 무관하게 `true` + 캐시 갱신. 긴 세션에서 시작 배너가 16KB 창 밖으로 밀려나고 타이틀이 스피너뿐이어도 인식이 유지된다.
- **음성 권위**: `NoneAlive`(또는 다른 앱 `Running`)는 stale 휴리스틱을 이긴다 — 캐시를 비우고 즉시 `false`, 버퍼-스캔의 배너 재고정을 건너뛴다. 이게 없으면 OSC exit title 없이 죽은 경우(SIGKILL·콜백 드롭) 16KB 의 stale 배너가 스크롤아웃까지 앱을 재고정한다. `Unknown` 만 타이틀/버퍼 휴리스틱으로 폴백한다.
- **false-exit 억제**: PTY 콜백의 타이틀 상태머신이 "비-앱 타이틀 → 종료"로 판정해도, 오라클(fresh)이 `Running` 으로 프로세스 생존을 확인하면 그 종료를 무효화한다(`claude_detected`·캐시·grace window·`claude_was_working` 보존, `interactiveAppExited` 미발행, 허위 "task completed" 미발행). 종료는 프로세스 소멸로만 확정된다.

인메모리 캐시는 영속화하지 않는다 — 앱 완전 재시작 시 PTY 가 죽어 감지 대상이 없고, webview 리로드 시 백엔드 `AppState`(캐시·버퍼·PTY)가 그대로 살아남기 때문.

#### WSL pane — 게스트 프로브가 권위 ([ADR-0134](../adr/0134-wsl-guest-interactive-app-liveness.md))

위 오라클은 호스트 프로세스 열거가 PTY 자손을 전부 본다는 전제 위에 선다. WSL pane 에서는 PTY 자식이 `wsl.exe` 이고 에이전트는 게스트 VM 안의 리눅스 프로세스라 Windows 스냅샷에 없다 — 호스트 트리는 이 pane 을 판정할 자격이 없다.

- **도메인 분기**: `PtyHandle.wsl_backed`(spawn 시점 `is_wsl_command` 결과)가 참이면 `app_in_pty` 는 호스트 스냅샷을 열지 않고 `wsl_liveness::liveness()` 의 판정을 그대로 반환한다.
- **게스트 프로브**: `wsl_liveness::refresh()` 가 distribution 당 1회 `wsl.exe --exec` 로 `/proc` 을 훑어, `comm` 이 `claude`/`codex` 인 프로세스를 상속된 `LX_TERMINAL_ID` 로 pane 에 귀속시킨다. 호출 주체는 activity reconcile 워커 하나다(아래). pane 안에서는 조상 깊이가 가장 얕은 프로세스가 이긴다. 감지 경로는 발행된 스냅샷만 읽는다 — PTY 콜백 스레드는 절대 게스트를 호출하지 않는다.
- **freshness 비대칭**: 신선하면 양방향 권위. 낡으면 `Running` 만 유지되고 부정은 `Unknown` 으로 강등된다. 프로브 실패·distribution 미해결·같은 depth 경합·귀속 불가 에이전트(`U` 행) 존재는 스냅샷에서 빠져 `Unknown` — 모든 실패의 종착지가 타이틀/버퍼 휴리스틱이다.
- **종료 판정도 같은 판정을 읽는다**: WSL pane 의 종료는 게스트 프로브가 소유하고, 억제가 틀렸으면 reconcile 워커가 정정한다([ADR-0135](../adr/0135-activity-reconcile-backend-diff-push.md) 4-2, ADR-0134 3-1 대체). 억제가 없으면 살아있는 에이전트에 대한 타이틀 유래 종료가 프론트를 `shell` 로 하드 오버라이드하고, 백엔드는 계속 `Claude` 여서 diff 가 침묵한다.
- **판정은 `(terminal_id, PTY generation)` 키**: Restart View 등으로 같은 id 에 새 PTY 가 붙으면 이전 세대 판정은 `Unknown`. 세션 종료 시 `wsl_liveness::forget()` 으로 항목을 지워 in-flight 패스가 되살리지 못하게 한다.
- **패스 전체 예산 + distribution 별 독립 타임아웃 + 시작 순서 회전**: 패스는 `WSL_LIVENESS_PASS_BUDGET`(4초) 안에 끝난다 — 기본 distro 해석과 모든 distribution 프로브가 이 예산을 나눠 쓰고, 개별 프로브는 자기 타임아웃과 남은 예산 중 작은 쪽을 받는다. 예산이 바닥나면 남은 distribution 은 판정 없이 건너뛰고 그 수를 로그로 남긴다(늦게 발행하면 모든 pane 의 판정이 함께 늙는다). 개별 타임아웃이 있어야 앞 distribution 하나의 장애가 뒤를 굶기지 않고, 회전이 있어야 밀리는 distribution 이 고정되지 않는다([ADR-0136](../adr/0136-activity-derivation-stamp-and-scoped-exit.md) 3).
- distribution 해석·검증(`is_safe_distro_name`)·실행 plumbing 은 `wsl_probe` 가 소유하고 세션 귀속 프로브(`commands/wsl_agent_session`)와 공유한다.

#### 주기 재판정 — 변경분만 push ([ADR-0135](../adr/0135-activity-reconcile-backend-diff-push.md))

이벤트 경로는 타이틀이 올 때만 말할 수 있고, 프롬프트에 멈춘 인터랙티브 앱은 타이틀을 내지 않는다. 그래서 놓친 분류를 되돌릴 주체가 필요하다 — 마운트 1회 동기화(위 ADR-0009 항목)는 `activity` 미설정 인스턴스만 채우므로 그 역할을 못 한다.

- **`activity_reconcile` 워커**가 타이머마다 `wsl_liveness::refresh()` → `detect_all_terminal_states()` → 직전 발행 값과 diff → 변경된 pane 만 `terminal-activity-reconciled` 이벤트로 발행한다.
- **cadence 는 고정 `ACTIVITY_RECONCILE_INTERVAL`(3초), 패스 시작 기준**: 패스 소요를 뺀 만큼만 잠들므로 두 발행 사이는 `cadence + 패스` 를 넘지 않는다. 이 워커가 게스트 스냅샷을 갱신하므로 `cadence + WSL_LIVENESS_PASS_BUDGET ≤ WSL_LIVENESS_AUTHORITATIVE_MAX_AGE` 를 테스트로 고정한다. 넘기면 패스 사이에 게스트 부정이 강등돼 stale 배너가 종료된 앱을 다시 pin 한다.
- **두 생산자의 판정은 파생 시점 stamp 로 순서화**한다([ADR-0136](../adr/0136-activity-derivation-stamp-and-scoped-exit.md)). PTY 콜백은 타이틀 판정 직전에, 워커는 스냅샷 직전에 `activity_order::next_activity_sequence()` 를 읽어 `activitySequence` 로 싣는다. 프론트는 pane 마다 적용한 stamp 를 기억하고 그보다 오래된 **activity** 만 무시한다 — 같은 이벤트의 title·메시지·출력 신호는 항상 적용된다.
- **PTY 세대가 교체된 pane 의 판정은 백엔드에서 폐기**: 워커가 스냅샷 전후로 세대를 읽어 달라진 pane 은 발행에서 빼고 발행 기록에서도 지운다(다음 패스가 새 세션 값을 발행). 같은 pane 의 종료 전이도 건너뛴다 — teardown 이 이미 정리한다.
- **종료 전이 전체를 소유하되 `(terminal, app)` 단위**: `InteractiveApp{app}` → 그 앱 아님 으로 바뀐 pane 마다 exit marker 기록 + 그 앱을 가리키는 grace window 제거 + 그 앱의 known 캐시·PTY 콜백 감지 플래그 해제, Claude 가 종료했을 때만 `claude_was_working`/`claude_last_working_title`/`claude_message` 정리 + 메시지 소거 이벤트 발행. 앱 간 handover 도 첫 앱의 종료로 취급하지만 후임 세션의 상태는 건드리지 않는다. 사라진 pane 은 제외(teardown 이 처리). 두 종료 경로(PTY 콜백 / 워커)는 `activity::apply_interactive_app_exit` 하나를 공유한다.
- **프론트(`useSyncEvents`)는 양방향으로 적용**한다. `interactiveApp → shell` 강등도 반영하고, 스토어에 없는 terminal_id 는 무시한다(제거된 pane 복원 금지).
- **`ACTIVITY_RECONCILE_FULL_RESYNC_INTERVAL`(60초)마다 전량 재발행**: diff 는 백엔드 변화만 보므로, 프론트가 자기 경로로 되돌린 drift 는 이 재발행으로만 수렴한다. 재발행은 발행량만 바꾸고 발행 기록은 유지한다 — 그 기록이 종료 판정의 유일한 직전 상태다.
- **실패한 패스는 발행하지 않는다**: 감지 에러는 "전부 shell" 이 아니라 패스 폐기. emit 실패는 발행 기록에서 되돌려 다음 패스가 재시도한다.

### 알림 레벨별 색상

| 레벨          | 색상   |
| ------------- | ------ |
| `error`       | 빨강   |
| `warning`     | 노랑   |
| `success`     | 초록   |
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
  - 기준은 입력 종류(마우스/화살표/키)가 아니라 프로그램의 진입/포커스(및 그 자리 응답=타이핑) 동작 자체 (ADR 0010·0012)
  - focus 기반 자동 해제의 SoT = AppLayout 의 두 effect (activeWorkspaceId/focusedPaneIndex 감지).
    마우스·화살표 모두 이 경로를 거치므로 진입 해제는 입력 수단별로 흩뿌리지 않는다.
  - 터미널 입력(타이핑)도 같은 해제 트리거다: TerminalView 의 onData 가 같은 dismiss 단위로
    해당 알림을 해제한다 — 이미 활성/포커스된 곳에 도착한 requiresAction 알림(focus 가 재발화
    안 됨)의 잔류 빈틈을 메운다. unread 없으면 store 읽기만(write/리렌더 가드) (ADR 0012, #365).
  - 해제 단위는 notifications.dismiss 모드를 따른다:
      · workspace : 워크스페이스 진입/아무 pane 포커스 → 전체 (markWorkspaceAsRead)
      · paneFocus : pane 포커스 → 그 pane(terminalId)만 (markTerminalAsRead)
      · manual    : 알림 클릭/네비게이션 → 해당 알림만 (markNotificationsAsRead)
  - 워크스페이스 셀렉터 클릭(WorkspaceSelectorView)도 setActiveWorkspace 를 거쳐 같은
    effect 로 해제된다(핸들러-로컬 markWorkspaceAsRead 없음, #365). 알림 네비게이션
    (useKeyboardShortcuts)은 별도의 명시 해제 경로(markNotificationsAsRead)다.
  - requiresAction 알림(예: "Claude is waiting for your input")도 focus/진입 시 해제된다
    — 해제 조건은 입력 수단이 아니라 focus 이므로 ↑↓·마우스·←→ 가 일치한다 (ADR 0012, #365).
    requiresAction 예외는 addNotification 의 도착-시점 auto-dismiss 에만 남아, 활성
    워크스페이스에 갓 도착한 모달 알림이 사용자가 보기 전에 사라지지 않게 한다.
  - 예외: manual 모드는 명시 해제(클릭/네비게이션/타이핑 없음) 전까지 유지
  - 표현: 배지/dot/패널 항목은 읽음 시 즉시 사라지지 않고 ~200ms opacity 페이드로 빠진다
    (components/ui/ExitFade). readAt 갱신은 즉시이고 DOM 언마운트만 지연 — 정책엔 무관.
```

### 키보드 단축키

설계 원칙: 전역 IDE 단축키는 `Ctrl+Shift`·`Ctrl+Alt`·`Alt+Arrow` 조합을 우선해 셸(readline, vim 등)의 `Ctrl+단일키`와 충돌을 피한다. Windows Terminal 키바인딩과 최대한 일치시킨다. 일부(터미널 copy/paste·zoom)는 의도적으로 `Ctrl+단일키`를 쓰며 근거는 [api-contracts.md](./api-contracts.md) §15.5 참조.

> **정본은 `ui/src/lib/keybinding-registry.ts` 의 `DEFAULT_KEYBINDINGS`** 다. 모든 단축키는 사용자가 재바인딩할 수 있으며(SettingsView Keybindings UI), 아래는 기본값 요약이다.

document 레벨 단축키 실행은 `useKeyboardShortcuts` 의 **액션 ID → 핸들러 테이블**이 담당하며, 콤보 매칭은 전부 `matchesKeybinding()`(사용자 오버라이드 우선)을 거친다 — 하드코딩 콤보 검사는 없다 (#337). 터미널 pass-through(`lx-shortcuts.ts`, #332/#333)와 같은 레지스트리를 참조하므로, 재바인딩하면 새 콤보가 동작하고 옛 기본 콤보는 비활성화되는 대칭이 양쪽에서 유지된다. Terminal/Memo/Issue Reporter 액션은 포커스된 view 내부에서 처리된다.

| 액션 ID                                     | 기본 단축키                    | 동작                                                                                                                   |
| ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `workspace.1`~`8`                           | `Ctrl+Alt+1`~`8`               | 워크스페이스 1~8 이동                                                                                                  |
| `workspace.last`                            | `Ctrl+Alt+9`                   | 마지막 워크스페이스                                                                                                    |
| `workspace.next` / `prev`                   | `Ctrl+Alt+↓` / `Ctrl+Alt+↑`    | 다음 / 이전 워크스페이스. 전환 후 Pane 포커스 자동 이동(기본) — `dock.arrowFocusPane=false` 면 Dock 포커스 유지 (#311) |
| `workspace.new`                             | `Ctrl+Alt+N`                   | 새 워크스페이스                                                                                                        |
| `workspace.duplicate`                       | `Ctrl+Alt+D`                   | 워크스페이스 복제                                                                                                      |
| `workspace.close`                           | `Ctrl+Alt+W`                   | 워크스페이스 닫기                                                                                                      |
| `workspace.rename`                          | `Ctrl+Alt+R`                   | 워크스페이스 이름 변경                                                                                                 |
| `pane.focus`                                | `Alt+Arrow`                    | Pane 포커스 이동 (상하좌우)                                                                                            |
| `pane.delete`                               | `Delete`                       | 편집 모드에서 포커스된 Pane 제거                                                                                       |
| `pane.propagateCwdOnce`                     | `Ctrl+Alt+P`                   | 포커스된 Pane의 CWD를 sync group에 1회 전파 (#324) — 컨트롤 바 버튼과 동일 동작                                        |
| `pane.copyIdentifier`                       | `Ctrl+Alt+C`                   | 포커스된 Pane 식별자를 클립보드에 복사 — Pane 번호 배지 클릭과 동일 포맷                                               |
| `sidebar.toggle`                            | `Ctrl+Shift+B`                 | 사이드바 토글                                                                                                          |
| `notifications.toggle`                      | `Ctrl+Shift+I`                 | 알림 패널 토글                                                                                                         |
| `notifications.unread`                      | `Ctrl+Shift+U`                 | 가장 최근 읽지 않은 알림으로 이동                                                                                      |
| `notifications.recent`                      | `Ctrl+Alt+←`                   | 최근 알림 발생 Pane으로 이동 (알림 소비)                                                                               |
| `notifications.oldest`                      | `Ctrl+Alt+→`                   | 오래된 알림 발생 Pane으로 이동 (알림 소비)                                                                             |
| `settings.open`                             | `Ctrl+,`                       | 설정 모달 토글                                                                                                         |
| `fileViewer.open`                           | `Ctrl+Shift+O`                 | 통합 파일 뷰어 열기                                                                                                    |
| `issueReporter.submit`                      | `Ctrl+Enter`                   | 이슈 리포터 제출                                                                                                       |
| `terminal.copy` / `paste`                   | `Ctrl+C` / `Ctrl+V`            | 터미널 복사 / 붙여넣기 (터미널 한정 예외 — §15.5; `Ctrl+C` 는 선택 없을 때만 SIGINT 위임)                              |
| `terminal.zoomIn` / `zoomOut` / `zoomReset` | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 터미널 폰트 확대 / 축소 / 리셋                                                                                         |
| `memo.zoomIn` / `zoomOut` / `zoomReset`     | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 메모 폰트 확대 / 축소 / 리셋 (MemoView 포커스 시 — view 인스턴스 오버라이드)                                           |

---

## 10.5 UsageView (Claude 사용량)

Claude Code 잔여 사용량의 유일한 정확한 원천은 `claude` 의 `/usage` TUI 화면이다. 수집은 Rust `usage_probe` 가 소유하고 표시만 프론트가 한다 ([ADR-0102](../adr/0102-claude-usage-probe-headless-pty.md)).

```
[UsageView 마운트]
    │  subscribe_usage_probe(subscriberId="usage-<paneId>", configDir)
    ▼
[usage_probe: config dir 당 워커 1개]
    │  구독자 0 → 1 이면 워커 spawn. 구독자 0 이 되면 워커 종료(claude 프로세스 종료)
    ▼
[worker 스레드]
    │  pty::spawn_pty(200x60)  — terminals 레지스트리에 등록하지 않는다
    │  PTY 출력 → vt100 화면 모델(usage_probe::screen)
    │  "claude\r" → trust 프롬프트("y\r") → welcome 감지 → 계정/플랜 파싱
    │  루프: ESC → "/usage" → ENTER → Right×3 → 화면 캡처 → parse_usage
    │        파싱 실패 시 같은 조회 안에서 Tab 재캡처(최대 3회, 추가 서버 조회 없음)
    ▼
[publish]
    │  UsageSnapshot(원시값: percent / reset 원문 / capturedAt / status) 캐시 갱신
    │  → Tauri 이벤트 `usage-snapshot-changed`
    ▼
[UsageView]
       configDir 일치하는 스냅샷만 채택
       pace = lib/usage-pace.ts 가 reset 원문 + 현재 시각에서 도출 (Rust 는 계산하지 않음)
       표시 행 = settings.usage.claude.visibleRows (하나 이상)
       배치·세로 밀도 = lib/usage-layout.ts 가 측정된 박스에서 도출 (stacked / columns / compact)
```

- **갱신 간격**: 정상 `settings.usage.claude.refreshSeconds`(하한 600s, 상한 3600s), 실패 시 60s 로 최대 3회 재조회 후 정상 간격 복귀.
- **구독 id 는 이펙트 실행마다 고유하다** (`usage-<paneId>#<seq>`). pane 당 고정 id 를 쓰면 React 가 이펙트를 실행→정리→재실행할 때 **죽은 정리 콜백이 살아있는 구독을 취소**해 수요가 0 이 되고, 마운트된 view 앞에서 probe 가 은퇴한다(실기에서 `idle` 로 관측). 백엔드도 같은 id·같은 config dir 재구독을 no-op 으로 처리해 정상 `claude` 를 죽이고 다시 띄우지 않는다.
- **읽기 경로는 부작용이 없다**: `get_usage_snapshot` / `GET /api/v1/usage` / MCP `get_claude_usage` 는 워커를 기동시키지 않으며, 구독이 없으면 `status: idle` 또는 빈 목록을 반환한다.
- **실패는 표시된다**: `claudeMissing` / `startupTimeout` / `parseFailed` / `upstreamError` / `failed` 를 구분해 view 푸터에 그대로 노출하고, 마지막 캡처 화면을 `rawScreen` 으로 남긴다(부팅 실패도 포함 — 화면이 비었는지 프롬프트에 막혔는지가 진단의 핵심이다).
- **표시 행은 전역 설정이다**: `visibleRows`는 현재 세션·전체 주간·모델별 주간 중 하나 이상을 선택하며 모든 Claude UsageView에 적용된다. 좁은 행에서는 의미를 유지하는 짧은 제목과 리셋/경과 퍼센트 원문만 표시한다([ADR-0103](../adr/0103-usage-view-visible-rows.md)).
- **세로 밀도는 높이에서 도출한다**: 높이가 줄면 `Ready`/`Last capture` 푸터를 먼저 감추고, 사용량 막대와 제목을 시간선/elapsed 텍스트 크기까지 줄인 뒤 상세 텍스트를 감춘다. `compact` 높이에서는 라벨·퍼센트까지 감춰 각 한도의 사용량·시간선 두 막대만 남긴다.
- **모델명에 의존하지 않는다**: 준비 판정은 배너의 `Claude Code` 문자열, 세 번째 행은 `Current week (<라벨>)` 의 괄호 라벨을 그대로 읽는 모델 무관 행(`weekModel` + `weekModelLabel`)이다. 퍼센트는 `used` 가 있는 줄에서만 읽어 `+50% ... promo` 같은 무관한 숫자를 배제한다. 실제 관측된 라벨: `Sonnet only`, `Fable`.
- **실기 확인**: `cargo test --test usage_probe_live -- --ignored --nocapture` 가 실제 `claude` 를 띄워 1회 조회한다. `LAYMUX_PROBE_SCREEN_OUT=<path>` 를 주면 캡처를 파일로 남겨 재조회 없이 분석할 수 있다.

### 10.5.1 CodexUsageView

Codex는 `/status` TUI를 파싱하지 않는다. `CodexUsageView`가 마운트된 동안 Rust command가 짧게 실행한 로컬 `codex app-server --stdio`에 `initialize`/`initialized` 뒤 `account/rateLimits/read`를 요청한다. 응답의 `rateLimitsByLimitId` primary window를 원시 usage row로 만들고, 프론트가 reset 시각과 window duration에서 elapsed bar를 계산한다. 비-Spark 행은 `Weekly limit`(좁으면 `Weekly`), Spark 행은 `Spark Weekly limit`(좁으면 `Spark`)으로 표시한다. `settings.usage.codex`가 font profile·600~3600초 갱신 간격·두 행의 표시 선택(하나 이상)·추가 `CODEX_HOME` 계정을 소유한다. 추가 계정은 해당 경로에서 사용자가 `codex login`을 끝낸 뒤 pane control bar에서 선택하며, Rust는 그 경로를 app-server 자식의 `CODEX_HOME` 환경으로만 전달한다. app-server listener·Codex thread·사용자 terminal에는 접근하지 않는다([ADR-0104](../adr/0104-codex-usage-app-server-probe.md)).

Claude와 Codex는 `UsagePresentation` 하나를 공유한다. 따라서 meter 색(`settings.usage.colors`)·terminal font·responsive density·compact row·footer·layout override는 provider별 코드가 아닌 공통 컴포넌트가 소유한다.

---

## 11. 전체 데이터 흐름 요약

```
[create_terminal_session]
    │  plan_start_dir() → PTY 에 적용된 시작 디렉터리
    │  session.cwd 시딩 (단일 진실 소스의 초기값, ADR-0130)
    │  create 응답 cwd 필드 → 프론트 스토어 (이벤트 없음)
    ▼
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

**1회성 CWD 전파 (issue #293, #324, #375).** 위 흐름은 셸의 `cd`가 자동 전파되는 경로다. 이와 별개로, 컨트롤 패널(`PaneControlBar`)의 "Propagate CWD once" 버튼(좌측, pane 번호 배지 우측에 정렬 — #324)과 `pane.propagateCwdOnce` 키바인딩(기본 `Ctrl+Alt+P`, 포커스 pane 대상)은 현재 view의 CWD를 sync group에 한 번만 밀어넣는다. 두 진입점 모두 `ui/src/lib/propagate-cwd-once.ts`의 `propagateCwdOnceForPane()` 한 경로로 디스패치되며, 소스에 따라 경로가 갈린다:

- TerminalView 소스: `propagate_cwd_once`(`terminal-${paneId}`) → `do_sync_cwd(force=true)`.
- FileExplorerView 소스: PTY 세션이 없어 커맨드가 실패하므로, 버튼은 `cwd-propagate-store`로 요청만 보내고 `FileExplorerView`가 자신의 `currentCwd`로 `handleLxMessage({action:"sync-cwd", force:true})`를 직접 디스패치한다.

`force=true`는 **소스 측** 게이트(에코 루프·소스 activity·`cwd_send`)만 우회한다 — 소스가 "지금 전파한다"고 명시적으로 누른 행위이기 때문이다. **대상 측** 게이트는 force 여부와 무관하게 항상 유지된다: 명령 실행 중/TUI 앱이면 cd 주입을 막는 `filter_targets_not_busy`, 그리고 각 대상의 `cwd_receive` 의사를 존중하는 `filter_targets_cwd_receive`(issue #375 — 옛 동작은 force 시 이 필터를 우회해 dock 등 receive=off pane에도 강제 전파했다). strict activity 판정은 output ring뿐 아니라 known-app/grace/exit cache와 process-tree PTY registry의 건강성을 detection 전후에 확인하며, poison을 `Shell`로 축소해 source/target을 허용하지 않는다. 대상이 file explorer일 때의 추종은 백엔드 cd 주입이 아니라, `do_sync_cwd`가 `sync-cwd` 이벤트에 실어 보내는 `force` 플래그를 `FileExplorerView`가 받아 처리하되, 자신의 `cwdReceive`가 off면 force라도 무시한다(백엔드 필터와 동일한 정책). 가드·이벤트 상세는 [api-contracts.md §10](api-contracts.md)의 "1회성 CWD 전파" 참조.

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
    ├── mcp-images/              ← MCP show_image 임시 이미지 (#287)
    └── terminal-output/
        ├── pane-abc12345.dat    ← xterm.js SerializeAddon 출력
        └── pane-def67890.dat
```

`cache/` 디렉터리는 향후 다른 캐시 데이터(메모 등)도 수용할 수 있도록 확장 가능한 구조.

### 13.3 프로파일 설정

```jsonc
{
  "profileDefaults": {
    "restoreCwd": true, // 기본값: 마지막 CWD 복원
    "restoreOutput": true, // 기본값: 이전 출력 복원
  },
  "profiles": [
    {
      "name": "PowerShell",
      "restoreOutput": false, // 프로파일별 오버라이드 (Option — 없으면 defaults 상속)
    },
  ],
}
```

### 13.4 종료 시퀀스

```
[Window close-requested event]
    │  App.tsx onCloseRequested 핸들러
    ▼
[saveBeforeClose()]
    ├─ 0. collectSettingsSnapshot()을 완료해 interrupt 전 agent 귀속을 보존
    │     ├─ get_terminal_cwds / get_claude_session_ids / get_codex_session_ids
    │     ├─ Claude: PTY descendant PID → ~/.claude/sessions/<pid>.json
    │     ├─ Codex: PTY child → 가장 얕은 Codex PID → logs DB process_uuid/thread_id
    │     ├─ Windows/WSL: distro 별 /proc probe에서 LX_TERMINAL_ID → Linux provider PID
    │     │    → Claude PID 세션 파일 또는 Codex PID가 연 rollout FD를 직접 읽음
    │     └─ state DB/rollout header로 top-level interactive thread 검증
    │        → provider는 활성이나 정확한 ID를 증명하지 못하면 terminalId: null
    │        → null 귀속은 해당 pane의 양쪽 stale session ID를 제거
    ├─ 1. exit.interruptTerminals이면 실행 중인 terminal에 Ctrl+C를 보내 agent 종료 출력을 기다림
    ├─ 2. 모든 TerminalView의 SerializeAddon.serialize({ excludeAltBuffer: true, excludeModes: true })
    │     → cache/terminal-output/{paneId}.dat 저장
    ├─ 3. 사전 수집한 snapshot을 settings.json에 저장
    │     → lastCwd·lastClaudeSession·lastCodexSession 포함
    └─ 4. cleanTerminalOutputCache(activePaneIds)
          → 고아 캐시 파일 정리
    ▼
[appWindow.destroy()]
```

Windows host의 WSL terminal은 host process tree에 `wsl.exe`만 보이므로 native PID 귀속을 적용하지 않는다. `TerminalSession`이 소유한 distro를 결정한 뒤 bounded `wsl.exe --exec sh` probe가 해당 distro의 `/proc` 환경을 읽고, rcfile에서 상속된 `LX_TERMINAL_ID`로 pane과 top-level Claude/Codex Linux PID를 직접 연결한다. provider가 중첩됐으면 전체 Claude/Codex 후보 중 유일한 최상위 agent만 활성 provider이며, provider별로 각각 최상위를 고르지 않는다. Claude는 `<HOME>/.claude/sessions/<pid>.json`을 `\\wsl.localhost\<distro>` 경로로 읽는다. Codex는 live WAL SQLite를 Windows에서 열지 않고, 선택된 Linux PID의 `/proc/<pid>/fd` 중 `CODEX_HOME/sessions` 아래 rollout symlink만 수집해 header를 검증한다. subagent·exec rollout은 제외하고 top-level ID가 하나일 때만 귀속한다. 명시 distro 파싱 실패는 default distro로 fallback하지 않고, default 조회와 모든 distro probe는 하나의 3초 deadline 안에서 끝난다. native·WSL 결과 병합 뒤 session ID 충돌도 전부 `null` 처리한다. distro·probe·provider 저장소 중 하나라도 증명할 수 없으면 CWD나 최신 파일로 추정하지 않고 `null`로 fail-closed한다([ADR-0120](../adr/0120-wsl-agent-session-attribution.md)).

### 13.5 시작 시퀀스

```
[useSessionPersistence 로드]
    │  settings.json → stores 적용
    │  workspace pane ID 복원 (안정 ID)
    │  orphan 캐시 정리
    ▼
[useTerminalStartupCoordinator]
    │  active workspace + visible dock + terminal-backed FileViewer 후보 계산
    │  Automation 요청 → foreground FileViewer → focus → workspace → dock 우선순위
    │  앱 전체에서 시작 슬롯 1개 부여
    ▼
[선택된 TerminalView 마운트 / 나머지는 dark placeholder]
    │  terminal-output-v3 listener 선등록
    ├─ loadTerminalOutputCache(paneId)
    │     → legacy cache의 SerializeAddon alternate-buffer suffix 제거
    └─ createTerminalSession(cwd: lastCwd, startupCommandOverride)
          → PTY가 마지막 CWD에서 시작
          → 응답 cwd = 실제 적용된 시작 디렉터리 → session.cwd + 스토어 시딩
            (resume pane 은 accepted OSC 7 을 못 내므로 이 값이 유일한 CWD)
          → Claude restoreSession이면 `claude --resume <id>`, Codex restoreSession이면
            `codex resume <id>`만 허용해 실행
          → 두 provider ID가 동시에 있으면 어느 것도 실행하지 않고 새 shell로 시작
          → attach_terminal_output(state + sequenced snapshot + nextEnvelopeId)
          → xterm reset
          → normal-buffer cache
          → "--- session restored ---" 구분선 + viewport 높이만큼 개행
          → live snapshot
          → backend 최종 bracketed-paste mode 합성
          → snapshot 이후 sequenced delta 재생
    │
    ├─ createTerminalSession 성공
    └─ xterm 첫 onRender
          → 두 조건이 모두 충족되면 현재 슬롯 완료
          → 다음 대기 TerminalView 마운트
          → 생성 실패는 즉시 완료, 신호 누락은 10초 watchdog 후 진행
```

Pane control bar의 **Restart View**는 이 앱 시작 복원 흐름의 명시적 예외다. 현재 runtime terminal store의 CWD(아직 보고되지 않았으면 저장된 `lastCwd`)로 기존 PTY를 종료한 뒤 새 PTY를 생성한다. 이때만 `restoreCwd` 설정과 무관하게 그 CWD를 전달하며, 출력 캐시와 Claude/Codex resume 복원은 건너뛴다. 재시작 요청은 첫 새 세션 생성이 끝나면 소비되므로, 이후 프로필 변경 등 일반 재생성은 원래의 복원 정책을 다시 따른다.

재시작 요청 상태(`epoch`/`cwd`/`fresh`)의 SoT 는 `stores/terminal-restart-store.ts` 다([ADR-0113](../adr/0113-workspace-clear-activity-owned.md)). `PaneGrid` 와 single-pane `Dock` 이 각자 자기 pane 의 항목만 구독하고, 워크스페이스 클리어의 `restart` 정책처럼 컴포넌트 밖에서도 요청할 수 있다. pane 이 제거되면 `forgetRestart`, 세션 복원처럼 pane 배열이 통째로 갈리는 경로는 기동 시 `gcStale` 이 정리한다.

출력 캐시는 과거 로그와 scrollback을 복원하기 위한 데이터이므로 normal buffer만 저장한다. 종료 시점에 Claude Code·vim 같은 TUI가 alternate buffer를 사용 중이어도 그 일시적인 전체 화면과 mouse/bracketed-paste 같은 live terminal mode는 새 PTY 세션으로 넘기지 않는다. 이전 버전이 alternate buffer 활성 상태에서 저장한 캐시는 normal buffer 직렬화 뒤에 `DECSET 1049` suffix가 붙어 있으므로, 복원 시 `normalBufferOnly`가 해당 suffix를 제거한다. 이를 제거하지 않으면 새 xterm이 alternate buffer에 고정되어 `baseY=0`으로 남고 scrollback과 scrollbar가 사라진다.

시작 조정 상태의 SoT는 frontend `terminal-startup-store`다. 후보 수집과 슬롯 전이는 `lib/terminal-startup-coordinator.ts`의 순수 함수가 담당하고, `PaneGrid`·single-pane `Dock`·terminal-backed `FileViewer`는 같은 reveal 집합을 소비하며, `TerminalView`는 PTY 준비와 첫 render 신호를 결합해 완료를 보고한다. 이미 reveal된 terminal은 `known`인 동안 다시 숨기지 않는다. 아직 준비되지 않은 현재 slot owner가 workspace 전환 등으로 `eligible`에서 빠지면 즉시 slot을 반납하고 다음 eligible terminal을 reveal한다. 이전 owner의 늦은 settle은 현재 slot을 바꾸지 않는다([ADR-0127](../adr/0127-terminal-startup-slot-follows-eligibility.md)).

#### 설정 snapshot 단일 경로

UI 종료 영속, 시작 hydration, Automation REST, MCP 설정 도구는 서로 다른 설정 조립 로직을 갖지 않는다.

```
조회/MCP validate
    → collectSettingsSnapshot()
    → settings/workspace/dock store + backend CWD/session id 합성

UI 시작 hydration
    → applySettingsSnapshot(settings, includeStructural=true)

MCP/REST 쓰기
    → Rust strict validate + revision 확인
    → settings.applySnapshot bridge
    → saveAndApplySettingsSnapshot(settings, includeStructural=false)
    → save_settings 성공 후 settings store 적용
      (Remote enabled 전이는 backend snapshot + owner gate + cloud tunnel에도 원자적으로 게시)
```

일반 설정 patch는 workspace/layout/dock 구조를 바꾸지 않으며, 구조 변경은 전용 Automation/MCP 흐름을 사용한다. 저장이 실패하면 런타임 store도 바꾸지 않아 디스크와 현재 UI가 갈라지지 않는다. 자세한 도구·검증·민감값 계약은 [api-contracts.md §12.7](./api-contracts.md)과 [ADR-0032](../adr/0032-llm-settings-introspection-and-safe-mutation.md)를 따른다.

**활동 상태 초기 동기화 (webview 리로드).** 백엔드 `AppState`는 webview 리로드에도 생존하므로 인터랙티브 앱 인식이 유지되지만, 프론트 활동 스토어는 리마운트로 비워진다. `useSyncEvents` 는 마운트 시 `get_terminal_states` 를 1회 호출해 살아있는 앱의 `interactiveApp` 활동을 재시드한다. 인스턴스가 늦게 등록되는 레이스는 스토어 구독으로 흡수하며, 모든 대상이 매칭되면 구독을 해제한다. 라이브 이벤트가 더 신선한 분류를 이미 적용했으면 덮어쓰지 않는다. ([ADR-0009](../adr/0009-process-tree-interactive-app-liveness.md))

### 13.6 Workspace Pane ID

- Pane ID는 `pane-{uuid8}` 형식으로 생성되며 settings.json에 저장
- 세션 간 안정적 — 캐시 파일 키로 사용
- 기존 ID 없는 설정은 마이그레이션 시 자동 생성

### 13.7 Pane 식별자 3종 (issue #256)

Pane을 가리키는 식별자는 용도가 다른 3가지가 공존한다. 혼동하지 말 것.

| 식별자       | 형식                                  | 용도                                                                               | 안정성                    |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `terminalId` | `terminal-pane-{uuid8}`               | **안정 참조** — write/focus의 1차 식별자, `LX_TERMINAL_ID` env var                 | 세션 간 안정              |
| `paneIndex`  | `WorkspacePane[]` 0-based 배열 인덱스 | **레이아웃 조작** — `split_pane`/`remove_pane`/`resize_pane`/`swap_panes` 파라미터 | split 삽입 순서에 종속    |
| `paneNumber` | 화면 읽기 순서 1..N                   | **표시 + 사람/AI 지칭** — 컨트롤바 배지, "N번 pane으로 보내"                       | 레이아웃 따라 실시간 변동 |

- `paneNumber`는 `ui/src/lib/pane-numbers.ts`의 `computePaneNumbers()` **단일 함수**에서 (y 우선, 동일 y는 x 오름차순; eps 0.01) 도출하는 **파생값**이다. 어디에도 저장/캐시하지 않으며 panes가 바뀌면 재계산된다.
- `WorkspaceSelectorView`의 pane 요약 행과 Direct Remote `/remote/v1/navigation`의 active workspace pane 배열도 이 `paneNumber` 오름차순으로 렌더/응답한다. 단, 표시 순서만 정렬하며 포커스와 `PaneMinimap.highlightIndex`, 원격 응답의 `paneIndex`는 레이아웃 조작용 원본 배열 인덱스를 계속 사용한다.
- `paneIndex`(배열)와 `paneNumber`(공간)는 다를 수 있다. 예: 좌우 분할 후 왼쪽을 다시 가로 분할하면 배열은 `[좌상, 좌하, 우]`지만 읽기 순서는 `좌상=1, 우=2, 좌하=3`.
- 자동화 노출: `list_terminals`/`get_active_workspace`의 각 pane(번호↔terminalId 매핑), `get_active_workspace`의 `focusedPaneNumber`, `identify_caller`의 `pane.number`와 `neighbors.{dir}.paneNumber`에 포함된다.
- 번호 직접 주소 지정: `write_to_terminal`/`read_terminal_output`/`focus_terminal`는 `terminal_id` 대신 `pane_number`(+옵션 `workspace_id`)를 받을 수 있다. 브리지 `terminals.resolveByNumber`로 호출 시점에 terminalId로 해석하며, `terminal_id`가 주어지면 항상 우선한다. 번호는 휘발성이므로 지속 참조는 `terminal_id`를 쓴다.
- `paneNumber`는 spawn-time env var로 주입하지 않는다(레이아웃 변경 시 stale). 자기 번호가 필요하면 `identify_caller`의 `pane.number`를 라이브 조회한다.
- **workspace name invariant**: 신규 생성/rename 적용 시 `workspace.name`의 모든 공백류는 `-`로 치환하고 앞뒤 공백은 제거한다. 예: `"My Workspace"` → `"My-Workspace"`. 마이그레이션은 하지 않으며, 기존 데이터는 다음 rename 이후 이 규칙이 적용된다. 콜론(`:`)은 정규화하지 않으므로 이름에 남을 수 있다 — locator 파싱은 이를 고려해 마지막 `:` 기준으로 분리한다(아래).
- **식별자 복사 (issue #276)**: 컨트롤바 `PaneNumberBadge`를 클릭하거나 `pane.copyIdentifier` 키바인딩(기본 `Ctrl+Alt+C`)을 누르면 해당 pane의 식별자를 클립보드에 복사한다. 포맷은 `ui/src/lib/pane-numbers.ts`의 순수 함수 `formatPaneIdentifier()`가 생성하며, `lx:pane:<workspaceName>:<paneNumber>` 형태다. 예: `lx:pane:Default:1`. 이 문자열은 자동화/MCP `write_to_terminal`·`read_terminal_output`·`focus_terminal`에서 `terminal_id` 또는 `pane_ref`로 그대로 사용할 수 있다. MCP는 locator를 마지막 `:` 기준으로 분리해(`rsplit_once`) 마지막 세그먼트를 pane number, 그 앞 전체를 workspace name으로 본다(이름에 `:`가 있어도 안전). 그런 다음 workspace name을 현재 workspace 목록에서 id로 해석한 뒤 `terminals.resolveByNumber` 경로로 terminalId를 찾는다. `paneNumber`는 휘발성이므로 복사값도 시점 참조다. 배지는 `workspaceId`와 `workspaceName`이 주어진 컨트롤바 컨텍스트(PaneGrid)에서만 클릭-복사 가능하며, dock 등 번호 없는 위치에서는 비대화형 라벨로 렌더된다.

---
