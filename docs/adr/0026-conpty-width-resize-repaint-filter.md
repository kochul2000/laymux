# 0026. ConPTY width resize repaint filter

- Status: Accepted
- Date: 2026-07-11
- Source: 사용자 보고(스크롤백 반복 및 가로 정렬 손상) · issue #285 · ADR-0001 · ADR-0008 · [Microsoft Terminal #16911](https://github.com/microsoft/terminal/issues/16911) · [xterm.js #5997](https://github.com/xtermjs/xterm.js/pull/5997)

## Context

Windows ConPTY 터미널의 normal buffer에 scrollback이 있는 상태에서 폭을 바꾸면 두 동작이 순서대로 발생한다. 먼저 xterm.js가 기존 scrollback을 새 폭으로 reflow한다. 이어 ConPTY가 `ESC[?25l ESC[H` 또는 `ESC[?25l ESC[8;<rows>;<cols>t ESC[H`로 시작하고 `ESC[?25h`로 끝나는 현재 화면 재도색 프레임을 출력한다. reflow로 과거 행 일부가 viewport 경계 안으로 이동한 뒤 이 프레임이 1행부터 다시 쓰이므로, 과거 내용이 현재 화면 내용으로 덮여 누락되거나 반복된다. 실제 53열에서 100열로 넓힌 재현에서는 88~91번 행이 사라지고 92번 이후가 그 위치를 덮었다. 98열에서 8열로 줄인 재현에서는 window-size 제어 시퀀스가 끼어 있는 프레임이 현재 화면 첫 논리 행의 24문자를 덮었다.

`refresh()`는 이미 손상된 xterm line model을 다시 그릴 뿐 내용을 복구하지 못한다. xterm reflow를 끄면 넓어진 폭에서 과거 행이 잘리고 가로 정렬이 깨진다. viewport를 1행으로 축소한 뒤 넓히는 방식은 과거 내용 유실은 막지만 ConPTY가 현재 화면을 다시 출력하면서 그 화면 전체를 scrollback에 중복시킨다.

xterm.js 6.0.0에는 별개로 폭 확장 reflow 뒤 제거된 soft-wrap 행의 `isWrapped`가 남는 결함도 있다. upstream PR #5997의 수정은 이 메타데이터 문제를 해결하지만 ConPTY 재도색에 의한 내용 덮어쓰기는 해결하지 않는다.

## Decision

Windows normal buffer의 scrollback이 있는 상태에서 열 수가 변경될 때 ConPTY resize repaint filter를 짧게 활성화한다.

- pane resize, 폰트, DPR, scrollbar, remote control 복귀처럼 terminal geometry를 바꾸는 모든 `fit()`은 공통 스케줄러를 통과한다. pane resize는 기존 80ms trailing debounce를 유지하며, PTY 출력과 세션 복원을 포함한 모든 xterm write를 공통 추적 함수의 최대 1 MiB 청크 FIFO로 전달해 queue drain 뒤에만 fit한다. xterm backlog 제한이 write를 동기 거부하면 해당 청크를 FIFO 선두에 유지하고 parser 진행 뒤 같은 데이터를 재시도한다. 대기 중 들어온 atlas 재생성 및 backend resize 요구는 OR로 누적해 뒤의 일반 fit 요청이 덮어쓰지 못하게 하며, 대기 중 컨테이너가 숨겨지면 각 dirty ref로 이관한다.
- Windows에서만 queue drain 뒤 마지막 PTY 출력 기준 최대 120ms의 quiet window를 기다린다. 최초 보류부터 500ms가 지나면 quiet 조건을 해제하고, parser queue가 비는 즉시 최신 resize를 실행한다. Linux는 queue가 비면 즉시 실행한다.
- remote control 복귀 fit에서는 그 fit이 발생시키는 일반 `onResize` backend 전송을 억제하고, 최종 `cols/rows`를 ConPTY repaint filter로 보호하는 명시적 resize 하나로 동기화한다. backend resize가 성공해야 remote-return dirty를 지우며, 거부되거나 1초 동안 완료되지 않으면 최신 geometry revision을 100ms 뒤 재시도한다. hidden surface는 visible 복귀까지 이 동기화를 dirty로 보류한다.
- 각 fit 직전에 active normal buffer의 `baseY > 0` 여부를 스냅샷으로 저장한다. xterm `onResize`에서 이전 열 수와 달라졌고 이 스냅샷에 scrollback이 있었을 때 500ms repaint 탐색 창을 연다. 따라서 얕은 scrollback이 wider reflow 과정에서 `baseY = 0`으로 줄어도 필터가 누락되지 않는다.
- 필터는 PTY 청크 경계와 무관하게 그 창 안에서 `ESC[?25l` 뒤에 선택적 `ESC[8;<rows>;<cols>t`를 거쳐 `ESC[H`로 이어지고 `ESC[?25h`로 끝나는 프레임을 xterm 입력에서 제거한다. start marker가 탐색 창 끝에서 검출돼도 end marker를 받을 수 있도록 검출 시점부터 별도의 500ms 완료 창을 시작한다. 프레임 앞뒤 데이터와 일치하지 않는 출력은 그대로 전달하고, 불완전한 start marker 후보는 불일치하거나 최종 탐색 창이 만료되면 방출한다. end marker 없이 완료 창이 만료되면 불완전 프레임을 폐기한다. 각 폭 변경은 고유 arm token과 자체 탐색 deadline으로 누적한다. backend resize가 실패하면 해당 token만 정확히 취소해 이전 arm의 deadline을 바꾸지 않는다. 아직 start marker를 찾는 중이면 split 후보를 비공개로 유지하고, 프레임 제거 중이면 현재 프레임을 끝내거나 만료시킨 뒤 남은 arm을 순서대로 탐색한다.
- alternate buffer와 Linux에서는 필터를 활성화하지 않는다.
- Rust PTY 콜백의 OSC 단일 패스와 raw output ring은 변경하지 않는다. 필터는 구조화 이벤트 처리 이후 WebView의 xterm write 경계에만 적용한다.
- `@xterm/xterm`은 6.0.0으로 고정하고, upstream commit `e9c648f`의 `isWrapped` 정리 패치를 `postinstall`에서 적용한다. stable xterm 릴리스가 해당 수정 내용을 포함하면 로컬 패치와 버전 고정을 재검토한다.

## Consequences

- ConPTY가 보내는 resize 화면 복제본이 reflow된 scrollback을 덮지 않아 폭 변경 뒤 과거 행의 순서와 개수가 유지된다.
- xterm 자체의 stale `isWrapped`도 제거되어 행 시작 위치와 wrapped range 계산이 일치한다.
- 필터는 exact frame marker, normal buffer, Windows, 실제 폭 변경, scrollback 존재, 짧은 시간 창을 모두 만족해야 동작하므로 일반 PTY 출력에 대한 영향 범위가 제한된다.
- resize 직후 normal buffer 애플리케이션이 같은 marker를 의도적으로 출력하면 그 한 프레임이 제거될 수 있다. Windows 전용 output quiet 조건과 repaint start의 500ms 탐색 창으로 가능성을 줄이며, TUI가 주로 쓰는 alternate buffer는 제외한다.
- 지속 출력에 대한 quiet 대기는 최초 보류 뒤 500ms를 넘지 않는다. 새 PTY write가 parser queue에 남아 있으면 queue drain은 계속 우선하며, queue가 비는 다음 시점에 resize를 실행해 xterm parser와 reflow가 겹치지 않게 한다.
- 모든 geometry fit이 같은 스케줄러를 사용하므로 폰트, DPR, scrollbar 변경도 parser write와 reflow를 겹치지 않는다. hidden 복귀 중 필요한 atlas 재생성 같은 작업은 후속 fit에 병합되어도 유지된다.
- remote control 복귀 resize가 실패하거나 지연돼도 최신 PC geometry가 성공할 때까지 dirty 상태와 보호 arm을 재구성하므로 PTY 전역 크기가 remote geometry에 남지 않는다.
- xterm backlog 거부 시 청크를 버리지 않으므로 출력 watermark는 보존되지만, parser가 처리할 수 있을 때까지 fit도 함께 지연된다.
- 설치 결과가 upstream bundle 형태에 의존하므로 patch script는 대상 문자열을 찾지 못하면 즉시 실패하고, 테스트는 패치 적용 여부를 확인한다.
