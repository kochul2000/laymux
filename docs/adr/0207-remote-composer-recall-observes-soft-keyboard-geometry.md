# 0207. Remote Composer 탭 recall은 소프트 키보드 geometry를 관측한다

- Status: Accepted
- Date: 2026-08-26
- Source: 사용자 요구("컴포저 포커스는 남았지만 키보드가 내려간 상태에서 키보드를 올리려고 탭하면 추천이 뜨지 않아야 한다", "추천이 열린 상태에서 빈 영역을 탭하면 닫혀야 한다"); [ADR-0196](0196-remote-coarse-pointer-attach-defers-input-focus.md); [data-flow §8.8](../architecture/data-flow.md); [api-contracts §13](../architecture/api-contracts.md)
- 관계: ADR-0196의 attach focus 정책은 유지하고, 그 ADR이 수용한 "DOM focus는 남고 IME만 닫힌 상태를 구별하지 못한다"는 한계와 `VirtualKeyboard` 단독 도입 기각 범위를 **혼합 geometry 판정으로 확장·정정**한다.

## Context

Remote Composer는 소프트 키보드에 Tab 키가 없는 터치 기기를 위해 빈 editor 탭으로 과거 입력 목록을 열 수 있다. 기존 구현은 빈 초안·history 존재·기능 on·IME 조합 아님만 확인했다. Composer가 focus된 상태에서 시스템 Back이나 브라우저 동작으로 소프트 키보드만 내려가도 DOM focus는 남으므로, 사용자가 키보드를 다시 올리려고 editor를 탭하면 같은 탭이 recall 목록까지 열었다. 키보드를 올리는 동작과 목록을 여는 동작이 겹쳐 입력칸을 가리는 문제다.

ADR-0196은 attach가 coarse-pointer 입력 surface를 선점하지 않도록 해 최초 진입의 focus/IME 위상 반전을 없앴다. 다만 시스템이 IME만 내린 뒤의 상태는 감지할 수 없는 한계로 수용했고, `Keyboard` 버튼은 DOM focus를 proxy로 유지했다. 당시 대안의 `VirtualKeyboard` API는 Android Chrome 일부에만 의존하면 iOS·WebView를 포괄하지 못한다는 이유로 기각했다. 이번 문제는 attach focus가 아니라 **사용자 탭 recall의 표시 조건**이므로, 표준 API 하나를 전역 키보드 SoT로 승격하지 않으면서 이미 Remote layout이 쓰는 `VisualViewport` geometry를 fallback으로 결합할 수 있다.

작용하는 force는 다음과 같다.

- 키보드를 올리는 첫 탭과 키보드가 열린 뒤의 두 번째 탭을 구분해야 한다. `click` 전에 focus 기본 동작과 viewport resize가 일어날 수 있으므로 click 시점의 관측만으로는 부족하다.
- 모바일 브라우저의 URL bar·회전·분할 화면도 viewport 높이를 바꾸므로 모든 height 감소를 키보드로 간주할 수 없다.
- `VirtualKeyboard`는 직접 신호지만 지원 범위가 제한되고, `VisualViewport`는 넓게 지원되지만 heuristic이다.
- 이 상태는 Remote 페이지의 표시 전용 runtime geometry이며 설정·외부 API·PTY 상태로 승격할 이유가 없다.
- history와 자동완성 중 어떤 목록이 보이든 editor의 빈 영역 탭은 같은 dismiss 의미를 가져야 한다.

범위는 coarse-pointer Remote Composer의 editor 탭 recall과 열린 추천 목록 dismiss다. 하드웨어 Tab 키 recall, 자동완성 후보 계산·키보드 선택, `Keyboard` 버튼의 접기/펼치기 의미, attach focus 정책, Remote API와 입력 history의 비영속 계약은 비목표다.

## Decision

**coarse-pointer Remote Composer의 빈 editor 탭 recall은 탭 시작 시점에 소프트 키보드가 geometry로 이미 보인 경우에만 열고, 열린 추천 상태에서 editor 빈 영역을 탭하면 목록만 닫는다.**

- 키보드 가시성은 surface-local runtime 계산값이며 영속하지 않는다. DOM focus는 이 계산의 입력이 아니다.
- `navigator.virtualKeyboard.boundingRect.height > 0`을 관측할 수 있으면 열린 것으로 판정한다. 이 API를 전역 SoT로 요구하지 않고, 값이 없으면 `VisualViewport`(미지원 시 `window.innerWidth/innerHeight`) fallback을 사용한다.
- fallback은 같은 viewport 폭에서 관측한 최대 높이를 keyboard-closed 기준으로 유지한다. 현재 높이가 기준보다 `max(80px, 기준 높이의 15%)` 이상 줄었을 때만 열린 것으로 판정한다. 폭이 바뀌면 회전·창 재배치로 보고 기준을 현재 높이로 재설정한다.
- 판정 snapshot은 `pointerdown`에서 캡처하고 뒤따르는 `click`이 소비한다. 첫 탭이 focus를 만들고 그 사이 viewport가 줄어도 그 탭은 recall을 열지 않는다.
- geometry를 신뢰할 수 없거나 coarse pointer가 아니면 tap-to-open을 fail-closed한다. 하드웨어 Tab 경로는 그대로 남는다.
- history 또는 자동완성 목록이 실제로 보이면 editor 탭은 먼저 두 목록 상태를 닫고 종료한다. 초안 텍스트·selection·전송 상태는 변경하지 않는다. 다음 편집은 기존 규칙대로 자동완성을 다시 활성화한다.
- 이 계산과 목록 상태는 Remote 정적 페이지가 소유한다. 새 endpoint, 설정 키, storage 쓰기, PTY 입력은 만들지 않는다.

## Alternatives Considered

- **DOM focus를 계속 유일한 proxy로 사용** — 시스템이 키보드만 내리면 focus가 남는 것이 이번 결함의 직접 원인이다. ADR-0196이 수용한 한계를 사용자 요구에 따라 그대로 둘 수 없어 기각했다.
- **빈 editor의 모든 탭에서 recall 열기 유지** — 첫 탭의 키보드 열기와 목록 표시가 겹치는 현재 동작이며 사용자가 불편을 명시했다. 기각했다.
- **`VirtualKeyboard` API만 사용** — 직접 신호지만 지원하지 않는 iOS·일부 WebView/브라우저에서 tap-to-open이 사라진다. ADR-0196의 기각 사유가 여전히 유효하므로 단독 사용은 기각하고 optional 우선 신호로만 사용한다.
- **`VisualViewport` 감소만 사용** — URL bar와 작은 chrome 변화까지 키보드로 오인한다. 폭별 최대 기준과 절대·상대 최소 감소량을 함께 요구하는 쪽을 택했다.
- **Keyboard 버튼·focus/blur 이벤트로 별도 boolean 상태 관리** — 시스템 Back, 브라우저 UI, 외부 키보드 전환처럼 앱 이벤트를 거치지 않는 경로에서 stale해진다. 실제 geometry 관측보다 불완전해 기각했다.
- **목록 밖 document 전체 탭에서 dismiss** — drawer 버튼·soft key·terminal selection 등 다른 gesture의 소유권까지 바꾼다. 기존 blur가 surface 이탈을 처리하므로 이번 범위는 editor 빈 영역으로 제한했다.

## Consequences

- focus가 남은 채 키보드가 내려간 상태에서는 첫 editor 탭이 키보드만 올리고 recall을 열지 않는다. 키보드가 이미 열린 뒤 다시 탭해야 history 목록이 열린다.
- history와 자동완성 목록 모두 editor 빈 영역 탭으로 닫히며, 초안과 전송 횟수는 그대로다.
- `VirtualKeyboard`를 지원하지 않아도 viewport가 resize되는 모바일 브라우저는 동일 동작을 제공한다. 반대로 overlay keyboard처럼 두 신호를 모두 제공하지 않는 환경에서는 원치 않는 popup보다 fail-closed를 택해 탭 recall이 열리지 않으며 하드웨어 Tab만 남는다.
- 80px/15% 경계는 URL bar 같은 작은 변화의 false positive를 줄이는 heuristic이다. 매우 작은 viewport·특수 키보드에서는 false negative가 가능하며, 실기 데이터가 다른 경계를 요구하면 이 ADR을 대체하는 새 결정으로 조정한다.
- orientation 중 키보드가 열린 채 폭이 먼저 바뀌면 새 기준이 축소 높이로 잡혀 일시적으로 false negative가 날 수 있다. 키보드가 닫혀 더 큰 높이가 관측되면 기준은 자동 복구된다.
- 브라우저 e2e는 coarse pointer, viewport 축소, pointerdown→click 순서, 첫 탭 no-open, 다음 탭 open, history/자동완성 dismiss와 초안 보존을 검증한다. Rust source 계약은 readable asset에 이 gate와 runtime-only 계산이 포함됨을 고정하고, bundle hash 테스트는 production minified artifact 동기화를 검증한다.
- headless 브라우저는 실제 OS IME를 띄우지 못하므로 최종 실기 검증은 Android/WebView에서 키보드를 시스템 Back으로 내린 뒤 첫 탭과 두 번째 탭의 목록 상태를 관찰한다.
- living docs의 Remote viewport와 Composer recall 계약을 같은 PR에서 갱신한다.
