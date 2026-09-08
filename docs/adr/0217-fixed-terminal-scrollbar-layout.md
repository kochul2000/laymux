# 0217. 터미널 스크롤바 레이아웃을 하나로 고정한다

- Status: Accepted
- Date: 2026-08-30
- Source: 사용자 요구(2026-08-30), `docs/architecture/data-flow.md` §8.4

## Context

터미널 설정은 스크롤바 방식을 `overlay`와 `separate` 중에서 고르게 했다. 그러나 고정된 xterm.js 6.0.0과 FitAddon은 `overviewRuler.width=0`도 기본 스크롤바 폭 14px로 fallback하므로 두 값 모두 셀 격자에서 같은 우측 gutter를 예약한다. `separate`는 같은 geometry에 overview-ruler canvas와 구분선만 추가해 사용자에게 의미 있는 레이아웃 선택을 제공하지 못했다.

이번 결정의 범위는 데스크톱 `TerminalView`의 스크롤바 geometry와 이를 노출하던 settings 계약이다. 스크롤 감도, scrollback 동작, 하단 이동 버튼과 Remote 터미널의 surface-local 스크롤은 비목표다. xterm 또는 FitAddon을 패치해 셀을 스크롤바 아래까지 늘리는 진짜 overlay를 새로 구현하는 것도 비목표다.

## Decision

데스크톱 터미널 스크롤바는 현재의 `overviewRuler.width=0` 레이아웃 하나로 고정하고 사용자 설정으로 노출하지 않는다.

- `TerminalView`는 xterm 생성 시 `overviewRuler.width=0`을 항상 사용한다.
- xterm v6와 FitAddon의 기본 14px gutter 예약은 유지한다.
- overview-ruler canvas와 구분선은 렌더하지 않는다.
- `settings.json`, Rust settings schema·검증, 프론트엔드 store와 Settings UI에서 `terminal.scrollbarStyle`을 제거한다.
- 이미 저장된 알 수 없는 필드는 별도 마이그레이션 없이 기존 settings 역직렬화·재저장 정책에 맡긴다.
- 스크롤바 모드 전환이 없어지므로 이를 위한 런타임 xterm option 변경과 geometry reflow도 제거한다.

## Alternatives Considered

### 진짜 overlay 구현

FitAddon의 폭 계산을 별도로 소유하거나 xterm 패치를 추가하면 셀 격자를 스크롤바 아래까지 늘릴 수 있다. 그러나 현재 동작을 유지하라는 요구 범위를 넘고, 오른쪽 끝 셀과 TUI의 인터랙티브 요소를 슬라이더가 가리는 새 정책을 결정해야 하므로 선택하지 않았다.

### `overlay`와 `separate` 설정 유지

두 값이 같은 gutter를 예약하고 `separate`만 구분선을 추가하므로 실질적인 선택이 아니다. 설정 스키마, UI, 검증과 hidden reflow 분기만 계속 유지해야 하므로 선택하지 않았다.

### 스크롤바 완전 숨김

휠과 키보드 스크롤은 가능하지만 scrollback 위치와 드래그 탐색 affordance가 사라지므로 선택하지 않았다.

## Consequences

- 모든 데스크톱 터미널은 동일한 열 계산과 스크롤바 표시를 사용한다.
- 사용자는 의미 없는 모드 선택과 `separate`의 세로 구분선을 보지 않는다.
- 설정 변경에 따른 terminal fit과 PTY resize 경로가 줄어든다.
- 기존 `scrollbarStyle` 키는 더 이상 계약이나 검증 대상이 아니며 마이그레이션 코드를 두지 않는다.
- 향후 진짜 overlay나 별도 gutter 모드를 도입하려면 오른쪽 끝 셀 가림, TUI 포인터 입력과 xterm 업그레이드 동작을 다시 검토해야 한다.
