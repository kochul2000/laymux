# Terminal Docs

터미널 동작에 대한 research/참조 문서.

## 정본 3종 — cursor/flicker ([ADR-0008](../adr/0008-shell-cursor-shadow-cursor.md), [ADR-0011](../adr/0011-dectcem-cursor-park-fifth-layer.md))

커서·overlay caret·IME/composition·플리커·DECSET 2026·DECTCEM 관련 변경 전 반드시 읽는다.
**통상 구현 작업 중에는 수정하지 않는다** (사용자가 명시적으로 문서 개정을 요청할 때만).

- [`fix-flicker.md`](./fix-flicker.md) — cursor/flicker/shadow-cursor 작업 진입점 (필수 워크플로 체크리스트).
- [`xterm-shadow-cursor-architecture.md`](./xterm-shadow-cursor-architecture.md) — 5-layer shadow cursor 전략 상세 research (DECTCEM 커서 주차 포함).
- [`xterm-cursor-repaint-analysis.md`](./xterm-cursor-repaint-analysis.md) — TUI repaint 중 cursorX/Y 가 footer 로 drift 하는 원인 심층 분석 (DECSET 2026, CSI s/u, overlay 동기화).

## 기타 참조

- [`claude-osc-handle.md`](./claude-osc-handle.md) — Claude Code 가 사용하는 모든 OSC/DEC 시퀀스 통합 가이드 (바이트 포맷, 스펙 링크, xterm.js API 예제, Tauri/Windows 연동 패턴).
- [`windows-terminal-ime-caret-redesign-plan.md`](./windows-terminal-ime-caret-redesign-plan.md) — Windows Terminal 식 IME caret 소유권 모델 리디자인 플랜. **부분 구현 상태** — 문서 상단 현황 참조.
- [`cursor-jump-evidence/`](./cursor-jump-evidence/README.md) — Codex footer frame 커서 점프의 PTY 트레이스 증거 (PR #207 후속 분석, `LAYMUX_PTY_TRACE`/`LAYMUX_CURSOR_TRACE`).
