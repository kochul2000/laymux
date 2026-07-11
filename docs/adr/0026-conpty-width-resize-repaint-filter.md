# 0026. ConPTY width resize repaint filter

- Status: Accepted
- Date: 2026-07-11
- Source: 사용자 보고(스크롤백 반복 및 가로 정렬 손상) · issue #285 · ADR-0001 · ADR-0008 · [Microsoft Terminal #16911](https://github.com/microsoft/terminal/issues/16911) · [xterm.js #5997](https://github.com/xtermjs/xterm.js/pull/5997)

## Context

Windows ConPTY 터미널의 normal buffer에 scrollback이 있는 상태에서 폭을 넓히면 두 동작이 순서대로 발생한다. 먼저 xterm.js가 기존 scrollback을 새 폭으로 reflow한다. 이어 ConPTY가 `ESC[?25l ESC[H`로 시작하고 `ESC[?25h`로 끝나는 현재 화면 재도색 프레임을 출력한다. reflow로 과거 행 일부가 viewport 경계 안으로 이동한 뒤 이 프레임이 1행부터 다시 쓰이므로, 과거 내용이 현재 화면 내용으로 덮여 누락되거나 반복된다. 실제 53열에서 100열로 넓힌 재현에서는 88~91번 행이 사라지고 92번 이후가 그 위치를 덮었다.

`refresh()`는 이미 손상된 xterm line model을 다시 그릴 뿐 내용을 복구하지 못한다. xterm reflow를 끄면 넓어진 폭에서 과거 행이 잘리고 가로 정렬이 깨진다. viewport를 1행으로 축소한 뒤 넓히는 방식은 과거 내용 유실은 막지만 ConPTY가 현재 화면을 다시 출력하면서 그 화면 전체를 scrollback에 중복시킨다.

xterm.js 6.0.0에는 별개로 폭 확장 reflow 뒤 제거된 soft-wrap 행의 `isWrapped`가 남는 결함도 있다. upstream PR #5997의 수정은 이 메타데이터 문제를 해결하지만 ConPTY 재도색에 의한 내용 덮어쓰기는 해결하지 않는다.

## Decision

Windows normal buffer의 scrollback이 있는 상태에서 열 수가 증가할 때만 ConPTY resize repaint filter를 짧게 활성화한다.

- pane resize는 기존 80ms trailing debounce와 xterm write queue drain 뒤 120ms output quiet 조건을 유지한다.
- xterm `onResize`에서 이전 열 수보다 증가했고 active buffer가 normal buffer이며 `baseY > 0`일 때 500ms 필터 창을 연다.
- 필터는 그 창 안에서 `ESC[?25l ESC[H`로 시작해 `ESC[?25h`로 끝나는 한 프레임만 xterm 입력에서 제거한다. 프레임 앞뒤 데이터와 일치하지 않는 출력은 그대로 전달한다.
- alternate buffer와 Linux에서는 필터를 활성화하지 않는다.
- Rust PTY 콜백의 OSC 단일 패스와 raw output ring은 변경하지 않는다. 필터는 구조화 이벤트 처리 이후 WebView의 xterm write 경계에만 적용한다.
- `@xterm/xterm`은 6.0.0으로 고정하고, upstream commit `e9c648f`의 `isWrapped` 정리 패치를 `postinstall`에서 적용한다. stable xterm 릴리스가 해당 수정 내용을 포함하면 로컬 패치와 버전 고정을 재검토한다.

## Consequences

- ConPTY가 보내는 resize 화면 복제본이 reflow된 scrollback을 덮지 않아 폭 변경 뒤 과거 행의 순서와 개수가 유지된다.
- xterm 자체의 stale `isWrapped`도 제거되어 행 시작 위치와 wrapped range 계산이 일치한다.
- 필터는 exact frame marker, normal buffer, Windows, 폭 증가, scrollback 존재, 짧은 시간 창을 모두 만족해야 동작하므로 일반 PTY 출력에 대한 영향 범위가 제한된다.
- resize 직후 normal buffer 애플리케이션이 같은 marker를 의도적으로 출력하면 그 한 프레임이 제거될 수 있다. output quiet 조건과 500ms 상한으로 가능성을 줄이며, TUI가 주로 쓰는 alternate buffer는 제외한다.
- 설치 결과가 upstream bundle 형태에 의존하므로 patch script는 대상 문자열을 찾지 못하면 즉시 실패하고, 테스트는 패치 적용 여부를 확인한다.
