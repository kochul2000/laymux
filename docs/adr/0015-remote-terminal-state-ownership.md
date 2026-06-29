# 0015. Remote 터미널 상태 소유권 — PTY 전역 상태와 surface 로컬 상태 분리

- Status: Accepted
- Date: 2026-06-29
- Source: Direct Remote Mode 구현 중 제어권 전환 경계에서 PC/remote xterm geometry가 섞인 회귀 · ADR-0013 · architecture/api-contracts.md §13

## Context

Direct Remote Mode는 PC WebView와 browser remote가 같은 PTY session을 번갈아 제어한다. 이때 xterm 렌더러는 surface마다 별도지만 PTY process는 하나다. 처음에는 remote browser의 `fit()`이 만든 `cols/rows`를 backend PTY에 적용하고, PC가 제어권을 가져오면 PC `TerminalView`에서 다시 `fit()`/`refresh()`를 호출하는 식으로 처리했다.

하지만 `fit()`만으로는 충분하지 않다. remote 제어 중 backend PTY 크기는 remote browser 폭으로 바뀌지만, PC xterm 인스턴스의 내부 `cols/rows`는 그 변화를 모를 수 있다. PC 제어권 회수 시 xterm 입장에서는 자기 크기가 바뀌지 않았기 때문에 resize event가 발생하지 않고, backend PTY가 remote geometry에 남아 Claude Code 같은 TUI가 깨진 상태로 보일 수 있다.

또한 width만 문제가 아니다. 입력, resize, focus, renderer cache, IME, selection, scroll position처럼 서로 다른 성질의 상태가 섞여 있다. 어떤 상태가 PTY 전역인지, 어떤 상태가 surface 로컬인지, 어떤 상태가 현재 제어권 owner만 쓸 수 있는지를 명확히 분리해야 한다.

## Decision

터미널 상태를 다음 세 범주로 분리한다.

1. **PTY 전역 상태**: 한 terminal session의 process와 protocol 상태다. PTY process, output byte stream, CWD/title/activity, terminal escape state, 그리고 현재 `cols/rows`가 여기에 속한다. `cols/rows`는 renderer 로컬 값이 아니라 프로세스에 SIGWINCH로 반영되는 전역 상태다.
2. **surface 로컬 상태**: 각 화면에만 남는 renderer/UI 상태다. DOM pixel size, devicePixelRatio, xterm canvas/WebGL atlas, cell metrics cache, scroll viewport, selection, focus, IME/composition, drawer/open state는 PC와 remote가 공유하지 않는다.
3. **controller owner 상태**: PTY 전역 상태를 변경할 권한이다. active owner만 stdin write, PTY resize, workspace/pane focus request를 보낼 수 있다.

제어권 규칙은 다음과 같다.

- remote lease가 active이면 browser remote가 PTY write/resize owner다. PC `TerminalView`는 로컬 렌더러 상태를 유지하되 backend PTY에 write/resize를 보내지 않는다.
- PC가 reclaim하거나 remote lease가 끝나면 PC가 owner가 된다. visible `TerminalView`는 자기 xterm의 현재 `cols/rows`를 backend PTY에 명시적으로 다시 보내고 renderer를 reflow/refresh한다.
- PC `TerminalView`가 hidden이면 reclaim 시점에는 dirty로 표시하고, 다시 visible이 되는 순간 PC geometry를 backend PTY에 보낸다.
- remote browser는 lease 상실을 명시적으로 표시하고 write/resize를 중지한다. 재접속하려면 새 lease claim을 해야 한다.

## Consequences

- Claude Code, Codex 같은 TUI는 현재 owner의 geometry 기준으로 PTY를 그린다. remote 제어 중에는 remote width를 쓰고, PC 회수 후에는 PC width로 되돌린다.
- PC와 remote의 renderer cache, scroll, selection, IME 상태는 서로 덮어쓰지 않는다.
- 제어권 전환 경계에서는 renderer reflow/refresh가 필수 동작이 된다.
- 향후 Full UI/Focused UI adapter 리팩터링에서도 `resize`/`write` API는 active owner 경계를 통과해야 하며, renderer 로컬 상태를 원격 계약에 섞지 않는다.
