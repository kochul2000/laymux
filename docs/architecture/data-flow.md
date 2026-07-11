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

### 8.2 `lx` CLI

IDE가 TerminalView를 spawn할 때 아래 환경변수를 자동 주입한다(`commands/terminal.rs` + `pty.rs`).
`lx` 는 이 변수들로 현재 터미널/그룹과 IDE 엔드포인트를 식별한다.

```bash
# IDE가 터미널 spawn 시 자동 주입
LX_SOCKET=...            # IDE IPC 엔드포인트 — Linux: /tmp/lx-{session}.sock (Unix socket) / Windows: 127.0.0.1:{port} (TCP)
LX_TERMINAL_ID=...       # 현재 터미널 인스턴스 ID (terminal-pane-{uuid8})
LX_GROUP_ID=...          # 현재 SyncGroup ID
LX_AUTOMATION_PORT=...   # Automation API 포트 (release 19280 / dev 19281)
```

PATH 는 수정하지 않는다 — `lx` 바이너리(진입점 `src-tauri/src/bin/lx.rs`, 파서 `src-tauri/src/cli/`)는 셸의 PATH 에서 찾을 수 있게 별도로 배치돼 있어야 한다.

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

ResizeObserver의 hidden→visible 분기에서는 `recoveringFromHidden`(=기존 `prevWasHidden`)과 `reflowDirtyRef.current`를 OR로 결합해 단일 `fit() + clearTextureAtlas() + refresh()`로 소비하고, dirty를 다시 `false`로 클리어한다. 같은 integer 크기 가드도 dirty 플래그를 함께 검사해 보류된 reflow가 누락되지 않도록 한다. 이 복구 요청의 atlas 재생성 플래그는 queue drain을 기다리는 동안 뒤의 일반 resize 요청과 OR 병합되므로 유실되지 않는다. 대기 중 다시 hidden으로 전환되면 atlas 재생성과 remote-return backend resize 플래그를 각각 dirty ref로 이관한 뒤 fit 요청만 취소한다.

이 메커니즘은 §8.4의 "0×0 hidden 상태에서 실제 크기로 복귀할 때만 atlas 재생성" 원칙을 위반하지 않는다. 오히려 hidden 동안 발생한 폰트/DPR/scrollbar 변경을 그 단일 transition에 합류시켜 reflow 호출을 추가하지 않는다.

#### Burst collision 방지

Codex/Claude 같은 TUI는 종료 시 `ESC[?1049l`, scrollback 재방출, footer repaint 등 많은 출력과 cursor/renderer 상태 전환을 짧은 시간에 발생시킨다. 이 시점에 activity 변경까지 겹쳐 `fit()` + `clearTextureAtlas()` + `refresh()`가 반복 호출되면 WebGL atlas rebuild가 TUI exit burst와 충돌하여 인접 pane의 glyph corruption으로 나타날 수 있다.

따라서 reflow 요청은 반드시 `requestAnimationFrame` 단위로 coalesce하고, 같은 tick 안에서 여러 번 발생해도 마지막 요청만 실행한다. activity/cursor/theme 변경 effect는 terminal option만 갱신하고, 필요한 overlay caret 갱신은 별도 updater로 처리한다. 셀 geometry reflow는 font/DPR/실제 size transition을 담당하는 전용 effect에만 둔다.

Pane divider의 ResizeObserver burst는 80ms trailing debounce로 한 번의 `fit()`으로 합친다. ResizeObserver뿐 아니라 폰트, DPR, scrollbar, remote control 복귀를 포함해 geometry를 바꾸는 모든 fit은 공통 스케줄러를 통과한다. PTY 출력과 세션 복원을 포함해 `terminal.write(data, callback)`로 전달한 데이터가 xterm parser queue에 남아 있으면 reflow를 실행하지 않는다. 모든 write는 공통 추적 함수를 거치며, 대기 중인 write 수가 0일 때 보류된 최신 fit을 한 번 실행한다. xterm이 backlog 제한 등으로 write를 동기 거부하면 catch 경로가 카운터를 되돌리고 보류 fit을 다시 평가한다. 대기 중 요청의 atlas 재생성 및 backend resize 플래그는 OR 병합한다. Windows에서는 이전 폭을 기준으로 만들어진 ConPTY 청크가 끝나도록 마지막 PTY 출력 뒤 최대 120ms의 quiet window를 추가로 기다리되, 지속 출력 때문에 resize가 무기한 미뤄지지 않도록 최초 보류 시점부터 500ms로 대기를 제한한다. Linux에서는 parser queue가 비는 즉시 실행한다. 이는 xterm buffer reflow와 write parser가 같은 active buffer를 동시에 갱신하는 충돌을 피하면서 지속 출력 중에도 resize 진행을 보장하기 위한 순서다.

`PaneControlBar`의 root/content slot, `ViewRenderer`의 terminal wrapper, `TerminalView`의 최상위 wrapper는 모두 `min-width: 0`과 overflow clipping을 유지한다. xterm canvas의 이전 고정 폭이 flex item의 intrinsic minimum으로 역전파되면 pane이 좁아져도 관찰 대상 host가 줄지 않아 `ResizeObserver`와 `fit()`이 새 열 수를 계산하지 못하고, 오래된 넓은 canvas가 잘리면서 scrollback이 좌우에 반복된 것처럼 보인다. 각 flex 경계가 실제 pane 폭까지 줄어들어야 buffer reflow와 renderer 크기 갱신이 같은 geometry를 사용한다.

Windows ConPTY는 폭 변경 뒤 현재 화면을 `ESC[?25l ESC[H ... ESC[?25h` 프레임으로 다시 출력한다. xterm이 먼저 새 폭으로 scrollback을 reflow하면 이 프레임이 viewport 경계로 이동한 과거 행을 덮어쓰므로, 각 fit 직전 active normal buffer의 scrollback 존재 여부를 스냅샷으로 보존하고 열 수가 증가할 때만 500ms resize repaint 탐색 창을 활성화한다. wider reflow가 얕은 scrollback의 `baseY`를 1에서 0으로 줄여도 fit 전 스냅샷을 사용한다. 필터는 PTY 청크 경계와 무관하게 start/end marker를 스트리밍 탐지해 각 widen에 대응하는 exact frame을 xterm write에서 제외하고 앞뒤 출력은 유지한다. 추가 widen은 outstanding repaint 수로 누적하며, 탐색 중인 split start 후보와 제거 중인 frame을 새 arm이 reset하지 않는다. start marker를 찾으면 청크로 분할된 end marker를 위해 별도의 500ms 완료 창을 시작한다. 불완전한 start marker 후보는 불일치하거나 최종 탐색 창이 만료되면 정상 출력으로 방출하고, end marker 없이 완료 창이 만료된 프레임은 폐기한 뒤 다음 outstanding frame을 탐색한다. Rust OSC 파이프라인과 raw output ring은 그대로이며 Linux와 alternate buffer에는 적용하지 않는다([ADR-0026](../adr/0026-conpty-width-resize-repaint-filter.md)).

xterm 6.0.0의 wider reflow는 제거된 soft-wrap 행 주변에 stale `isWrapped`를 남길 수 있다. dependency는 6.0.0으로 고정하고 upstream commit `e9c648f`의 수정 패치를 `postinstall`에서 적용한다. patch target이 달라지면 설치를 실패시켜 검토 없이 다른 bundle에 부분 적용되지 않게 한다.

#### 테스트 요구사항

TerminalView renderer 경로를 수정할 때는 다음 회귀 테스트를 유지하거나 추가한다.

- font 변경은 한 프레임에 coalesce된 reflow를 예약하고 `clearTextureAtlas()`를 호출한다.
- activity 토글(Codex 시작/종료)은 reflow를 호출하지 않는다.
- cursor shape/blink 변경은 option만 갱신하고 reflow를 호출하지 않는다.
- 같은 integer size의 ResizeObserver entry는 `fit()`을 호출하지 않는다.
- 0×0 hidden 상태에서 실제 크기로 복귀할 때만 atlas를 재생성한다.
- hidden(0×0) 컨테이너에서 font/DPR/scrollbar 변경이 발생해도 `fit()` 및 `clearTextureAtlas()`를 즉시 호출하지 않는다 (dirty 마킹만 수행).
- hidden→visible 전환 시 보류된 dirty가 있으면 단일 `fit() + clearTextureAtlas() + refresh()`로 소비하고, 뒤의 일반 fit이 합류하거나 대기 중 다시 hidden이 되어도 atlas/backend sync 요구를 유지한다.
- PTY 출력 또는 세션 복원 write callback이 남아 있는 동안 ResizeObserver, font, DPR, scrollbar reflow를 실행하지 않고, queue drain 뒤 누적 플래그를 포함한 fit을 정확히 한 번 실행한다.
- xterm write가 callback 등록 전에 동기 예외를 던져도 drain 카운터를 복구해 이후 fit을 차단하지 않는다.
- Windows의 120ms output quiet 대기는 지속 출력에서도 최초 보류 뒤 500ms 안에 끝나며, Linux resize에는 적용하지 않는다.
- Windows normal buffer의 scrollback을 넓힐 때 청크 경계에서 분할된 marker를 인식하고, 탐색 창 끝에서 start marker가 완성된 frame에도 별도 완료 창을 적용한다. fit 중 `baseY`가 1에서 0으로 줄어드는 얕은 scrollback도 보호한다. start 전 또는 split start 보류 중 여러 번 재무장하면 outstanding 수만큼 frame을 제거하고, 제거 중 재무장하면 현재 frame의 완료 또는 만료 뒤 다음 frame을 탐색한다.
- terminal을 감싼 각 flex 경계는 `min-width: 0`과 overflow clipping을 가져 xterm canvas의 intrinsic width가 pane 축소를 막지 않는다.

### 8.5 Shadow cursor / DECTCEM 주차 상태

Codex overlay caret의 DEC 2026 프레임 안/밖 판정은 xterm.js 렌더 모드가 아니라 parser 경계가 권위 소스다.

- `CSI ? 2026 h/l` parser handler가 activity 분류와 무관하게 `ShadowCursorState.isDec2026FrameOpen`을 열고 닫는다. 웹뷰 리로드나 초기 감지 중 `?2026h`가 shell/미분류 상태에서 먼저 와도 같은 프레임의 `?25h`를 park로 오인하지 않는다.
- `terminal.modes.synchronizedOutputMode`와 `syncOutputActiveRef`는 xterm 렌더 억제, CSS cursor visibility, 중복 repaint 차단에 사용한다. xterm.js는 1초 safety timeout 뒤 이 모드를 `false`로 바꿀 수 있으므로, DECTCEM `?25h` 주차 분류나 frame-open settle 판정에는 사용하지 않는다.
- 프레임 set 시 기존 trusted shadow가 있으면 그대로 유지하고, 없으면 pre-frame buffer 좌표를 임시 `hasSyncFramePosition`으로 승격한다. safety timeout 뒤 overlay가 다시 그려져도 frame body의 footer 좌표를 live buffer에서 읽지 않게 하기 위함이다.
- `isDectcemShowPark()`는 `isDec2026FrameOpen === false`이고 normal buffer일 때만 참이다. 따라서 장시간 프레임에서 모드 timeout이 발생해도 프레임 안 `?25h`는 visibility-only repaint tail로 남는다.
- settle 재무장 상한은 `parkPending` fallback 동결만 해제한다. `isDec2026FrameOpen`은 타이머나 activity 전환이 닫지 않으며 실제 `?2026l` parser 경계에서만 닫힌다.
- `?2026l` 뒤 `parkPending`이면 overlay 좌표 repaint를 동결하지만, IME composition이 종료되어 `active=false`가 되면 프리뷰 DOM의 opacity와 text를 동결 검사 전에 즉시 정리한다. 완료된 조합 문자열이 settle timeout까지 화면에 남아서는 안 된다.

상태 전이는 `ui/src/lib/shadow-cursor-state.ts`, parser hook·settle timer·overlay paint 순서는 `TerminalView.tsx`가 담당한다.

### 8.6 링크 활성화 (평문 / OSC 8 / TUI 우회)

터미널 내 URL 클릭은 모두 `openExternal`(`@/lib/tauri-api`)로 OS 브라우저를 연다(webview 내 `window.open` 금지).

- **평문 URL** — `WebLinksAddon`의 핸들러가 `openExternal`로 라우팅.
- **OSC 8 hyperlink** — xterm `Terminal.linkHandler.activate`가 `openExternal`로 라우팅(#345). `WebLinksAddon`은 정적 import.
- **들여쓰기 하드랩 URL**(Claude OAuth 등) — `createIndentedLinkProvider`가 인접 동일 들여쓰기 줄을 결합해 탐지(설정 `paste.linkJoin`).
- **TUI 마우스 트래킹 우회**(#352) — codex 등 풀스크린 TUI가 마우스 리포팅을 켜면 클릭이 앱으로 전달되어 위 세 경로가 트리거되지 않는다. 다수 터미널의 관례대로 **Shift 또는 Alt + 좌클릭** 시 wrapper DOM의 capture-phase `mousedown` 리스너가 가로채, 좌표를 셀로 변환해 OSC 8 → 들여쓰기 결합 → 평문 URL 순으로 링크를 찾아 `openExternal`로 연다. 링크를 찾으면 `stopImmediatePropagation`으로 클릭이 TUI에 전달되지 않게 막고, 없으면 그대로 흘려보내 기존 선택/드래그를 해치지 않는다.
  - 순수 탐지 로직은 `ui/src/lib/terminal-link-click.ts`(`resolveLinkAtCell`/`findPlainUrlAtCol`/`isModifierLinkClick`). 평문 URL 정규식은 `WebLinksAddon`과 동일하게 유지한다.
  - 좌표→셀 변환(`_mouseService.getCoords`)과 OSC 8 uri 조회(`_oscLinkService.getLinkData`)는 xterm 코어 내부 API이므로 `TerminalView.tsx`에서 try/catch + optional 접근으로 감싼다. 평문·들여쓰기 경로는 공개 buffer API만으로 동작하므로 내부 접근이 실패해도 폴백된다.
- **파일/디렉토리 경로 → viewer·cwd 전파**(#363, **선택 기반·데코레이션**) — URL이 아닌 "스킴 없는 파일/디렉토리 경로"(예: `ui/src/index.css`, `Cargo.toml`, `/etc/hosts`, `laymux`, `v3`)는 `createPathLinkController`(`ui/src/lib/path-link-provider.ts`)가 처리한다. **사용자가 드래그로 선택한 한 덩어리만** 대상으로 한다(기존의 hover 줄 전체 토큰 stat 방식은 제거 — 느리고 Windows에서 동작 안 함).
  - 검증 흐름은 `TerminalView`의 `onSelectionChange`/드래그 종료 `pointerup` 시점에 1회 수행한다: ① 설정 `terminal.pathLinkEnabled` off면 종료 ② 선택이 비었거나 `terminal.pathLinkMaxLength`(기본 256) 초과면 종료 ③ `trimSelectionToPath`로 단일 토큰 추출(공백 끼면 제외, URL 스킴 제외, 후행 `:line:col`·문장부호·따옴표/괄호 제거). **선택 기반이라 슬래시·확장자 없는 맨이름(디렉토리/확장자 없는 파일)도 후보로 받는다** — 존재 검증이 실질 게이트이므로 형태 휴리스틱으로 거르지 않는다(URL 스킴만 제외) ④ `joinCwdPath`로 cwd와 조합(없으면 종료) ⑤ **`stat_path`를 선택당 1회만** 호출 ⑥ `decidePathLinkAction`으로 분기 — 존재 안 함=밑줄 없음, 파일=`openFile`, 디렉토리=`changeDir`.
  - **밑줄은 xterm 데코레이션으로 직접 그린다**(linkifier hover 의존 안 함). xterm `ILinkProvider`/Linkifier는 mousemove 시점에만, 같은 셀이면 재질의를 건너뛰어, 비동기 stat 검증이 끝난 뒤 마우스가 정지해 있으면 밑줄/클릭이 안 켜졌다("나갔다 돌아와야 동작"). 그래서 검증되면 `setVerifiedSelection`이 `registerMarker`+`registerDecoration`(둘 다 xterm **proposed API** → `Terminal` 생성 시 `allowProposedApi: true` 필수)으로 그 범위에 밑줄 요소를 만든다. 선택 좌표는 `mapSelectionToPathRange`가 `getSelectionPosition()`의 **0-based·end exclusive** 모델 좌표를 데코레이션의 **1-based 절대 버퍼 좌표**로 보정한다(미보정 시 밑줄이 한 행 위·한 칸 왼쪽). 선택이 바뀌거나 해제되면 `clear()`가 데코레이션·마커를 dispose한다.
  - **커서·클릭은 `TerminalView`가 hit-test로 처리한다.** 데코레이션 요소는 `pointer-events: none`(순수 시각)이라 클릭·드래그가 그대로 xterm으로 전달된다 → ⓐ 포인터(손가락) 커서는 `mousemove` 시 `hitTest(clientX,clientY)`로 **밑줄 사각형 안일 때만** 켜고(벗어나면 원래 커서), ⓑ 클릭은 `mousedown`(capture) 시점에 경로를 캡처해 두고 이동 없이 `mouseup`이면 `activate`로 연다 — 클릭 시 xterm이 선택을 지워 `current`가 비기 때문. **드래그면 무시**해 일반 재선택이 되게 두고, 새 선택은 `onSelectionChange`가 재평가한다.
  - 클릭 분기: 파일이면 `useFileViewerStore.openFileViewer`로 통합 뷰어를 연다. 디렉토리면 그 경로를 새 cwd로 **제안**해 기존 중앙화 전파 경로(`do_sync_cwd`)에 그대로 태운다 — `FileExplorer.navigateTo`와 동일하게 ① origin으로 **비-터미널 sentinel**(`${instanceId}__pathlink`)을 넘겨 백엔드가 소스의 tracked cwd를 발명(`ipc_dispatch.rs`의 `update_terminal_cwd`)하거나 소스를 대상에서 제외하지 않게 하고(클릭한 pane도 특별취급 없이 일반 대상), ② **`force`를 넣지 않아** `filter_targets_cwd_receive`가 적용되어 **`cwd_receive`를 켠 pane(클릭한 pane 포함)만** 이동한다(dock·다른 pane 동일 정책). `force: true`는 `cwd_receive`를 무시하므로 쓰지 않는다. 셸별 경로 변환(POSIX↔UNC↔Windows)은 백엔드 `write_cd_to_group_terminals`가 프로파일별로 처리한다.
  - 순수 로직은 `ui/src/lib/path-link-detect.ts`(`trimSelectionToPath`/`isWithinPathLengthLimit`/`joinCwdPath`/`normalizeMsysCwd`/`mapSelectionToPathRange`/`decidePathLinkAction`)에 분리해 단위 테스트로 덮는다.
  - **Windows cwd 처리**: git-bash/MSYS 셸이 cwd를 `/d/PycharmProjects/...` 형태로 보고하면, 상대경로 조합 후 백엔드 `resolve_address_path`가 선행 `/`를 WSL로 오인(`\\wsl.localhost\...`)해 검증이 실패한다. 이를 막기 위해 `joinCwdPath`가 조합 직전 `normalizeMsysCwd`로 MSYS cwd(`^/<drive>/...`, 단 `/mnt/` 제외)를 Windows 드라이브 경로(`X:\...`)로 변환한다(백엔드 전역 동작은 변경하지 않음). PowerShell cwd(`D:\...`)·POSIX(`/home/...`)·WSL UNC(`\\wsl.localhost\...`)는 그대로 동작한다(단위 테스트로 보장).
  - 와이드 문자(CJK/이모지)가 앞선 줄은 셀 컬럼이 어긋날 수 있다 — 기존 `indented-link-provider`와 동일한 알려진 제약(별도 이슈로 추적).

### 8.7 맨 아래로 이동 버튼 (issue #349)

사용자가 스크롤백 위로 올라가 있을 때 우측 하단에 플로팅 "맨 아래로 이동" 버튼(`.terminal-scroll-to-bottom`)을 띄운다.

- 표시 판정은 `isTerminalScrolledUp(terminal)` 순수 함수로 도출한다. xterm `buffer.active.viewportY < baseY`이면 스크롤백을 보는 중이므로 버튼을 노출하고, 같으면(또는 `viewportY` 미제공 시) 라이브 최하단으로 보고 숨긴다.
- 상태 갱신은 `terminal.onScroll` 단일 소스에서만 일어난다. 휠 스크롤·`scrollToBottom()`·출력 추가 모두 xterm의 onScroll을 발생시키므로 별도 폴링이 없다. disposable은 메인 effect cleanup에서 해제한다.
- 클릭 시 `terminal.scrollToBottom()`을 호출하고 즉시 버튼을 숨긴다(후속 onScroll이 동일 결론을 재확인).
- laymux-dev MCP의 `scroll_terminal`은 같은 live xterm에 `scrollLines(lines)`를 호출해 viewport를 상대 이동하고 현재 `baseY`/`viewportY`를 반환한다. PTY 입력을 합성하지 않으며 release MCP에는 노출하지 않는다([ADR-0025](../adr/0025-dev-terminal-viewport-automation.md)).
- 버튼은 overlay caret / loading 레이어보다 위(`z-index: 5`)에 두어 클릭 가능성을 보장하고, overlay 스크롤바 거터를 피해 우측 16px 여백을 둔다.

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

**1회성 CWD 전파 (issue #293, #324, #375).** 위 흐름은 셸의 `cd`가 자동 전파되는 경로다. 이와 별개로, 컨트롤 패널(`PaneControlBar`)의 "Propagate CWD once" 버튼(좌측, pane 번호 배지 우측에 정렬 — #324)과 `pane.propagateCwdOnce` 키바인딩(기본 `Ctrl+Alt+P`, 포커스 pane 대상)은 현재 view의 CWD를 sync group에 한 번만 밀어넣는다. 두 진입점 모두 `ui/src/lib/propagate-cwd-once.ts`의 `propagateCwdOnceForPane()` 한 경로로 디스패치되며, 소스에 따라 경로가 갈린다:

- TerminalView 소스: `propagate_cwd_once`(`terminal-${paneId}`) → `do_sync_cwd(force=true)`.
- FileExplorerView 소스: PTY 세션이 없어 커맨드가 실패하므로, 버튼은 `cwd-propagate-store`로 요청만 보내고 `FileExplorerView`가 자신의 `currentCwd`로 `handleLxMessage({action:"sync-cwd", force:true})`를 직접 디스패치한다.

`force=true`는 **소스 측** 게이트(에코 루프·소스 activity·`cwd_send`)만 우회한다 — 소스가 "지금 전파한다"고 명시적으로 누른 행위이기 때문이다. **대상 측** 게이트는 force 여부와 무관하게 항상 유지된다: 명령 실행 중/TUI 앱이면 cd 주입을 막는 `filter_targets_not_busy`, 그리고 각 대상의 `cwd_receive` 의사를 존중하는 `filter_targets_cwd_receive`(issue #375 — 옛 동작은 force 시 이 필터를 우회해 dock 등 receive=off pane에도 강제 전파했다). 대상이 file explorer일 때의 추종은 백엔드 cd 주입이 아니라, `do_sync_cwd`가 `sync-cwd` 이벤트에 실어 보내는 `force` 플래그를 `FileExplorerView`가 받아 처리하되, 자신의 `cwdReceive`가 off면 force라도 무시한다(백엔드 필터와 동일한 정책). 가드·이벤트 상세는 [api-contracts.md §10](api-contracts.md)의 "1회성 CWD 전파" 참조.

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

| 식별자       | 형식                                  | 용도                                                                                            | 안정성                    |
| ------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------- |
| `terminalId` | `terminal-pane-{uuid8}`               | **안정 참조** — write/focus의 1차 식별자, `LX_TERMINAL_ID` env var                              | 세션 간 안정              |
| `paneIndex`  | `WorkspacePane[]` 0-based 배열 인덱스 | **레이아웃 조작** — `split_pane`/`remove_pane`/`resize_pane`/`swap_panes` 파라미터 | split 삽입 순서에 종속    |
| `paneNumber` | 화면 읽기 순서 1..N                   | **표시 + 사람/AI 지칭** — 컨트롤바 배지, "N번 pane으로 보내"                                    | 레이아웃 따라 실시간 변동 |

- `paneNumber`는 `ui/src/lib/pane-numbers.ts`의 `computePaneNumbers()` **단일 함수**에서 (y 우선, 동일 y는 x 오름차순; eps 0.01) 도출하는 **파생값**이다. 어디에도 저장/캐시하지 않으며 panes가 바뀌면 재계산된다.
- `paneIndex`(배열)와 `paneNumber`(공간)는 다를 수 있다. 예: 좌우 분할 후 왼쪽을 다시 가로 분할하면 배열은 `[좌상, 좌하, 우]`지만 읽기 순서는 `좌상=1, 우=2, 좌하=3`.
- 자동화 노출: `list_terminals`/`get_active_workspace`의 각 pane(번호↔terminalId 매핑), `get_active_workspace`의 `focusedPaneNumber`, `identify_caller`의 `pane.number`와 `neighbors.{dir}.paneNumber`에 포함된다.
- 번호 직접 주소 지정: `write_to_terminal`/`read_terminal_output`/`focus_terminal`는 `terminal_id` 대신 `pane_number`(+옵션 `workspace_id`)를 받을 수 있다. 브리지 `terminals.resolveByNumber`로 호출 시점에 terminalId로 해석하며, `terminal_id`가 주어지면 항상 우선한다. 번호는 휘발성이므로 지속 참조는 `terminal_id`를 쓴다.
- `paneNumber`는 spawn-time env var로 주입하지 않는다(레이아웃 변경 시 stale). 자기 번호가 필요하면 `identify_caller`의 `pane.number`를 라이브 조회한다.
- **workspace name invariant**: 신규 생성/rename 적용 시 `workspace.name`의 모든 공백류는 `-`로 치환하고 앞뒤 공백은 제거한다. 예: `"My Workspace"` → `"My-Workspace"`. 마이그레이션은 하지 않으며, 기존 데이터는 다음 rename 이후 이 규칙이 적용된다. 콜론(`:`)은 정규화하지 않으므로 이름에 남을 수 있다 — locator 파싱은 이를 고려해 마지막 `:` 기준으로 분리한다(아래).
- **식별자 복사 (issue #276)**: 컨트롤바 `PaneNumberBadge`를 클릭하거나 `pane.copyIdentifier` 키바인딩(기본 `Ctrl+Alt+C`)을 누르면 해당 pane의 식별자를 클립보드에 복사한다. 포맷은 `ui/src/lib/pane-numbers.ts`의 순수 함수 `formatPaneIdentifier()`가 생성하며, `lx:pane:<workspaceName>:<paneNumber>` 형태다. 예: `lx:pane:Default:1`. 이 문자열은 자동화/MCP `write_to_terminal`·`read_terminal_output`·`focus_terminal`에서 `terminal_id` 또는 `pane_ref`로 그대로 사용할 수 있다. MCP는 locator를 마지막 `:` 기준으로 분리해(`rsplit_once`) 마지막 세그먼트를 pane number, 그 앞 전체를 workspace name으로 본다(이름에 `:`가 있어도 안전). 그런 다음 workspace name을 현재 workspace 목록에서 id로 해석한 뒤 `terminals.resolveByNumber` 경로로 terminalId를 찾는다. `paneNumber`는 휘발성이므로 복사값도 시점 참조다. 배지는 `workspaceId`와 `workspaceName`이 주어진 컨트롤바 컨텍스트(PaneGrid)에서만 클릭-복사 가능하며, dock 등 번호 없는 위치에서는 비대화형 라벨로 렌더된다.

---
