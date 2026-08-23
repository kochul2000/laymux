# 0193. FileViewer 는 OS 열기·위치 보기를 버튼으로 노출하고, 확인 정책은 트리거와 분리한다

- Status: Proposed
- Date: 2026-08-22
- Source: 사용자 요구("viewer 에서 Ctrl 클릭·Ctrl+Shift 클릭 효과, 즉 OS 에서 직접 파일 열기 또는 위치 열기를 수행하는 버튼을 추가", "바이너리 fallback 일 때는 직접 파일 열기 버튼을 콘텐츠 표시 위치에도 보여 줘서 행동을 유도"), [architecture/data-flow.md §8.6](../architecture/data-flow.md)
- 관계:
  - **확장** — [ADR-0100](0100-path-link-host-os-open-modifier-contract.md). 그 ADR 은 "File Explorer 뷰·FileViewer 오버레이의 OS 열기 확장"을 명시적 비목표로 두었다. 이 ADR 이 그 범위를 FileViewer 로 넓히고, 넓히면서 확인 정책의 소유자를 트리거 밖으로 옮긴다.
  - **경계 유지** — [ADR-0045](0045-remote-path-link-reuses-desktop-parser.md)(원격 파일 읽기 권한을 호스트 프로세스 실행 권한으로 확장하지 않는다), [ADR-0042](0042-remote-file-viewer-secret-capability.md)·[ADR-0184](0184-remote-file-viewer-in-page-overlay.md)(Remote FileViewer 는 데스크톱 오버레이를 복제하지 않는다)
  - **관련** — [ADR-0109](0109-file-viewer-typed-preview-renderers.md)(FileViewer 의 렌더러 분기와 fallback), [ADR-0031](0031-extension-viewer-profile-path-conversion.md)(호스트 경로 산출은 Rust 소유)

## Context

ADR-0100 은 검증된 터미널 path-link 위에서 `Ctrl`+클릭(OS 연결 프로그램으로 열기)과 `Ctrl+Shift`+클릭(파일 관리자에서 위치 보기)을 계약으로 고정했다. 백엔드 `open_in_os` 커맨드, 호스트 경로 해석, 확인 게이트, 하드 클래스 확장자 목록은 그때 다 만들어졌다. 그러나 그 트리거는 **터미널 화면에 경로 문자열이 찍혀 있고, 사용자가 그것을 선택·hover 해 밑줄을 띄운 상태**에서만 성립한다.

FileViewer 에는 그 조건이 없다. 뷰어는 이미 파일 하나를 열어 놓았으므로 대상은 확정돼 있는데, 그 파일을 OS 에서 열거나 탐색기에서 위치를 보려면 사용자는 (a) 주소창의 경로를 복사해 (b) 터미널이나 탐색기에 붙여넣거나, (c) 그 경로가 찍힌 터미널 출력을 찾아 다시 선택해야 한다. 대상이 확정된 표면에서 대상이 불확정한 표면으로 돌아가는 역행이다.

바이너리 fallback 에서는 이 비용이 기능 실종처럼 보인다. `read_file_for_viewer` 가 `kind: "binary"` 를 돌려주면 뷰어는 "Binary file (N KB)" 한 줄만 그린다(ADR-0109 의 fallback). 사용자가 보는 것은 빈 화면이고, 다음에 할 수 있는 행동이 화면에 없다. 실제로 그 파일을 여는 방법은 있는데(호스트 연결 프로그램) 그 경로가 어디에도 노출되지 않는다.

결정을 강제하는 force 는 세 가지다.

1. **확인 정책이 트리거에 묶여 있다.** ADR-0100 의 구현에서 "실행으로 이어지는 열기는 확인받는다"는 위험 정책은 `needsOsOpenConfirm(action: PathLinkClickAction, …)` 로 path-link 의 클릭 액션 타입에 결합돼 있다. 두 번째 트리거가 생기면 이 정책을 (a) 복제하거나 (b) 소유자를 옮겨야 한다. 복제하면 같은 `.exe` 가 터미널에서는 경고를, 뷰어에서는 무경고로 갈릴 수 있다.
2. **설정 두 키의 성질이 서로 다르다.** `terminal.pathLinkOsOpenEnabled` 는 실은 **입력 소유권 스위치**다 — 그 키가 켜져 있으면 path-link 가 밑줄 위의 `Ctrl` 클릭을 `preventDefault`+`stopImmediatePropagation` 으로 종결해 xterm 선택 확장·TUI 마우스 리포팅·#352 우회에서 그 클릭을 빼앗는다(ADR-0100 Decision 2). Settings UI 의 라벨도 "Ctrl+click opens in the OS" 다. 반면 `terminal.pathLinkOsOpenConfirm` 은 입력과 무관한 **위험 정책**이다.
3. **콘텐츠 종류마다 툴바가 없다.** FileViewer 의 헤더(`ToolbarBar`)는 Preview/Source 토글이나 zoom 이 필요한 종류에만 있다. 바이너리·archive·PDF·외부 터미널 뷰어·읽기 실패 상태에는 툴바가 없다. 버튼을 본문 렌더러 쪽에 두면 파일 종류에 따라 있다가 없다가 한다.

범위는 데스크톱 FileViewer(오버레이 헤더 + 바이너리 fallback 본문)의 OS 열기·위치 보기 버튼, 그 확인 정책의 소유자 이동, 실패 표시다. File Explorer 목록 행의 OS 열기, Remote 표면 대응, 새 설정 키, 게스트(WSL) 맥락 실행은 비목표다.

## Decision

**FileViewer 는 열려 있는 파일에 대해 OS 열기·위치 보기를 호스트 헤더의 버튼으로 항상 노출하고, 미리보기가 없는 바이너리 fallback 에서는 콘텐츠 자리에도 같은 동작을 유도 버튼으로 다시 보여 준다. 확인 정책은 트리거에서 떼어 표면 독립 모듈이 소유하며, 두 표면은 그 한 정책을 공유한다.**

1. **트리거는 늘고 동작·정책은 그대로다.** 버튼은 ADR-0100 이 정한 두 동작(`open`, `reveal`)을 같은 백엔드 커맨드 `open_in_os` 로 수행한다. 호스트 경로 산출·`explorer.exe` 인자 형식·spawn 실패만 오류로 보고하는 정책은 그대로 재사용하고, 뷰어용 경로 변환이나 두 번째 실행 경로를 만들지 않는다.

2. **확인 정책의 소유자는 `lib/os-handoff.ts` 다.** 하드 클래스 확장자 목록, `requiresHardConfirm`, 확인 여부 판정, 확인 문구의 i18n 키 선택을 여기로 옮긴다. 판정 입력은 path-link 의 클릭 액션이 아니라 **백엔드 모드**(`"open" | "reveal"`)다 — 트리거가 무엇이든 같은 형태로 물어볼 수 있어야 한다. `path-link-os-open.ts` 에는 트리거 고유의 입력 계약(수정자 → 액션 매핑, 액션 → 모드 변환, hover 힌트 키)만 남긴다. 같은 이유로 공용 i18n 문구(`osHandoff.confirm`·`confirmExecutable`·`failed`)는 `common.terminal` 에서 `common.osHandoff` 로 옮긴다. 하드 클래스 목록은 계속 코드 상수이며 설정 키로 노출하지 않는다.

3. **버튼은 `terminal.pathLinkOsOpenConfirm` 을 따르고 `terminal.pathLinkOsOpenEnabled` 를 따르지 않는다.**
   - 확인: 파일을 연결 프로그램으로 여는 `open` 은 설정이 켜져 있으면 매번, 꺼져 있으면 하드 클래스만 확인한다. `reveal` 은 대상을 실행하지 않으므로 확인하지 않는다. 즉 뷰어 버튼과 터미널 Ctrl 클릭은 같은 파일에 대해 항상 같은 판정을 내린다.
   - 활성화: `pathLinkOsOpenEnabled` 는 밑줄 위 수정자 클릭의 소유권 스위치이므로(Context 2) 버튼에는 적용하지 않는다. 버튼은 자기 좌표 안의 클릭만 받고 xterm·TUS·#352 와 나눠 갖는 입력이 없으므로 그 스위치가 해결하는 충돌 자체가 없다. 버튼 전용 on/off 설정도 만들지 않는다 — 명시적 UI + 확인 게이트로 충분하고, 설정 표면은 원격 patch 가능한 쓰기 표면이기도 하다(ADR-0100 Decision 5). Settings UI 의 확인 설정 설명에 "뷰어 버튼에도 적용된다"를 명시해 두 표면의 관계를 사용자에게 알린다.

4. **버튼의 소유자는 호스트 헤더이고, 바이너리 fallback 만 본문에 한 벌 더 갖는다.** 대상 파일은 콘텐츠 종류와 무관하게 하나뿐이므로 버튼은 본문 렌더러가 아니라 오버레이 헤더가 소유한다 — 바이너리·archive·PDF·외부 터미널 뷰어·읽기 실패에서도 같은 자리에 있다. 예외는 바이너리 fallback 하나다. 거기서는 화면에 볼 것이 없어서 사용자가 "지원하지 않는 파일"로 결론내고 헤더의 글리프까지 찾지 않으므로, 콘텐츠 자리에 라벨 버튼과 안내 문구를 함께 그려 다음 행동을 제시한다. 아직 파일을 고르지 않은 prompt 모드에는 대상이 없으므로 버튼을 그리지 않는다.

5. **실패는 누른 표면에서 보여 준다.** `open_in_os` 는 spawn 실패만 reject 한다. 이 경우 사용자는 버튼을 눌렀는데 아무 일도 없는 것으로 관측하므로 조용히 삼키지 않는다. 다만 터미널 path-link 가 쓰는 알림 스토어는 pane 단위 표시라 pane 이 아닌 오버레이에서는 보이지 않으므로, 뷰어에서는 버튼 옆 인라인 오류 텍스트로 표시한다. 그 상태는 **경로로 스코프**하여 다른 파일로 이동하면 따라붙지 않게 한다(effect 에서 상태를 지우지 않기 위한 형태 — `react-hooks/set-state-in-effect`).

6. **Remote 표면은 그대로 두고, 커맨드도 계속 데스크톱 전용이다.** 새 버튼은 데스크톱 React 트리에만 있다. `open_in_os` 를 Automation API·MCP 툴·Remote 라우트에 노출하지 않는 ADR-0100 Decision 5 와 ADR-0045 의 권한 경계는 바뀌지 않는다.

## Alternatives Considered

- **버튼을 콘텐츠 툴바(`ToolbarBar`)에 둔다**: 파일 종류별 컨트롤(zoom·Preview/Source)과 한자리에 모인다. 그러나 툴바 자체가 종류마다 있다가 없다가 하므로(Context 3) 정작 가장 필요한 바이너리·읽기 실패에서 버튼이 사라진다. 모든 종류에 툴바를 새로 만드는 것은 이 요구보다 큰 UI 변경이다.
- **`terminal.pathLinkOsOpenEnabled` 로 버튼도 함께 끈다**: ADR-0100 본문의 "기능 전체를 끌 수 있다"는 표현과 문자적으로 맞고, "호스트 프로그램 실행을 원하지 않는다"는 사용자 의도를 존중한다. 채택하지 않는다 — 그 키의 실제 계약과 Settings 라벨은 수정자 클릭의 입력 소유권이며, 터미널 설정 하나를 끈 사용자가 뷰어 헤더의 버튼이 사라진 이유를 추적할 방법이 없다. 이 비대칭은 Consequences 에 비용으로 남긴다.
- **뷰어 전용 설정 키(`viewer.osOpenEnabled`)를 새로 만든다**: 표면별로 정확히 끌 수 있다. 그러나 위험을 실제로 막는 것은 확인 게이트와 하드 클래스이고, 새 키는 원격 patch 로 뒤집힐 수 있는 표면을 하나 더 늘린다. 설정이 늘어나는 만큼 두 키의 조합 의미(끈 상태에서 확인 설정은 무엇을 뜻하는가)도 설명해야 한다.
- **확인 정책을 뷰어 쪽에 복제한다**: diff 가 작고 기존 path-link 코드를 건드리지 않는다. 채택하지 않는다 — 같은 파일이 트리거에 따라 다른 경고를 받게 되는 것이 이 기능의 유일한 안전장치를 무의미하게 만드는 방식이다. 정책을 옮기는 리팩터가 이번 변경의 본체다.
- **바이너리 fallback 을 자동으로 OS 에 넘긴다**(열자마자 연결 프로그램 실행): 클릭이 하나 줄어든다. 채택하지 않는다 — 뷰어를 여는 행위가 곧 호스트 프로그램 실행이 되어 ADR-0100 Decision 3 의 "되돌릴 수 없는 동작의 기본값은 확인"을 정면으로 어긴다. MCP·Automation 이 여는 뷰어까지 실행 트리거가 된다.
- **본문 유도 버튼을 모든 종류에 그린다**(텍스트·이미지에도 큰 CTA): 발견성이 가장 높다. 그러나 볼 것이 있는 화면에서는 콘텐츠를 밀어내는 소음이고, 헤더에 이미 같은 버튼이 있다. 유도가 필요한 것은 화면이 빈 경우뿐이다.
- **실패를 알림 스토어로 보낸다**(터미널 path-link 와 동일): 표시 경로가 하나로 통일된다. 그러나 알림은 `terminalId`/`workspaceId` 로 pane 에 귀속돼 표시되므로 pane 이 아닌 오버레이의 실패에는 붙일 대상이 없고, 없는 pane 의 id 로 넣으면 사용자에게 보이지 않는다.
- **모달 `alert` 로 실패를 알린다**: 놓칠 수 없다. 그러나 ADR-0100 이 같은 이유로 기각했다 — 모달은 dev 자동화 루프(스크린샷·Automation)를 세운다.

## Consequences

- 뷰어에서 파일 하나를 확정한 상태에서 호스트 탐색기·연결 프로그램까지 클릭 두 번 안에 도달한다. 경로 복사·재선택 역행이 사라진다.
- 바이너리 fallback 이 "지원 안 되는 파일" 화면에서 "여기서 열 수 있다" 화면으로 바뀐다. `kind: "binary"` 는 미리보기 부재의 fallback 이므로, 앞으로 새 미리보기가 추가되면 이 유도 화면에 도달하는 파일은 줄어든다.
- 확인 정책이 트리거 밖으로 나오면서 `path-link-os-open.ts` 의 export 면이 좁아지고, 새 트리거(예: File Explorer 행, 컨텍스트 메뉴)를 붙일 때 정책을 다시 결정하지 않아도 된다. 반대로 `os-handoff.ts` 는 이제 두 표면의 공통 의존이 되어, 그 판정을 바꾸면 터미널 동작까지 함께 바뀐다.
- **뷰어 버튼은 끌 수 없다.** `pathLinkOsOpenEnabled` 를 끈 사용자에게도 헤더 버튼은 남는다. 실행 위험은 확인 게이트와 하드 클래스가 계속 막지만, "OS 열기를 완전히 없애고 싶다"는 요구가 실제로 오면 표면 독립 키(`osHandoff.enabled` 등)를 도입하는 별도 결정이 필요하다. 그때는 path-link 의 입력 소유권 키와 위험/활성화 키를 분리해 이름부터 다시 정한다.
- i18n 키가 `common.terminal.osOpen*` → `common.osHandoff.*` 로 이동한다. 내부 개발 단계라 마이그레이션은 만들지 않으며, 이후 문구 추가는 새 그룹에 한다.
- 실패 표시가 표면마다 다르다 — 터미널은 알림, 뷰어는 인라인 텍스트. 표시 경로가 둘이라는 비용을 받아들이는 대신, 각 표면에서 실제로 보이는 자리에 나온다.
- 뷰어 헤더에 버튼이 두 개 늘어 좁은 창에서 주소창 폭이 줄어든다. 헤더는 글리프 버튼(`↗`, `📁`)만 쓰고 라벨은 tooltip·`aria-label` 로 제공한다.
