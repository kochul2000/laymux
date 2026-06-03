# 0008. 터미널 셸 커서/플리커 — shadow cursor 4-layer

- Status: Accepted
- Date: 2026-06-03
- Source: `docs/terminal/` (research 정본), 구 ARCHITECTURE.md §8.4

## Context

TUI 앱(Claude Code, neovim 등)이 화면을 리페인트할 때 xterm.js 의 `cursorX/Y` 가 footer 로 drift 하고, DECSET 2026 동기화 출력(`\x1b[?2026h/l`)에서 렌더/파스 타이밍이 갈려 커서가 깜빡인다. 즉흥적·국소적 수정은 IME/composition, overlay caret, atlas 재생성과 얽혀 회귀를 반복 유발했다 — 다층 문제다.

## Decision

**4-layer shadow cursor 아키텍처를 채택**하고, 그 설계 근거를 `docs/terminal/` 3개 문서에 정본으로 둔다.

- 4 layer: OSC 133 prompt marker · DECSC/RC(ESC 7/8) · Mode 2026 동기화 출력 · `onWriteParsed`. 구현은 `ShadowInputCursor` 클래스.
- 렌더러는 셀 geometry 변경(폰트/DPR/실제 크기 transition)에서만 `fit() + clearTextureAtlas() + refresh()` 를 호출하고, activity/cursor shape/theme 변경에는 호출하지 않는다(§8.4). reflow 는 `requestAnimationFrame` 으로 coalesce.
- cursor·overlay·flicker·DECSET 2026 관련 변경 전, 반드시 세 문서를 정본으로 확인한다:
  - `docs/terminal/fix-flicker.md` (진입점·워크플로 체크리스트)
  - `docs/terminal/xterm-shadow-cursor-architecture.md` (4-layer 구현 가이드)
  - `docs/terminal/xterm-cursor-repaint-analysis.md` (cursorX/Y drift 원인 분석)

## Consequences

- cursor/overlay 작업은 기억·즉흥 실험만으로 진행하지 않는다. 위 세 문서를 정본으로 따른다.
- 이 research 문서들은 **통상 구현 작업 중 수정하지 않는다** — 사용자가 명시적으로 research 문서 개정을 요청할 때만 갱신.
- 렌더러 reflow/atlas 원칙의 living 서술은 [architecture/data-flow.md](../architecture/data-flow.md) §8.4 가 SoT.
