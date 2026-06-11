# Docs

laymux 의 참조 문서 홈. 구현 작업의 기준이 되는 문서들을 Git 으로 관리한다.
문서 체계의 진입점·동기화 의무는 [`AGENTS.md`](../AGENTS.md) 가 정의한다.

## 규칙

- 어떤 동작에 대한 참조 문서가 여기 있으면, 해당 코드를 고치기 전에 먼저 읽는다.
- research 참조 문서([`terminal/`](./terminal/README.md) 정본 3종)는 통상 구현 작업 중 다시 쓰지 않는다 — 사용자가 명시적으로 문서 개정을 요청할 때만 갱신한다.
- 새 구현 참조 노트는 리포 루트에 두지 말고 주제별 하위 디렉터리에 추가한다.
- `architecture/` 는 living doc 이다 — 코드가 서술과 어긋나면 **같은 PR 에서** 갱신한다. 새 설계 결정은 [`adr/`](./adr/README.md) 에 추가한다.

## 구조

| 경로 | 내용 |
|---|---|
| [`architecture/`](./architecture/overview.md) | **living doc** — HEAD 의 현재 구조·흐름·계약: [overview](./architecture/overview.md)(구조·모델) · [data-flow](./architecture/data-flow.md)(런타임 흐름) · [api-contracts](./architecture/api-contracts.md)(Settings·REST·MCP 계약, 코드 설계 원칙) |
| [`adr/`](./adr/README.md) | 아키텍처 결정 기록 (append-only, 불변) — "왜 그렇게 정했나" |
| [`roadmap.md`](./roadmap.md) | 진행 상태 트래커 (shipped / 검토 중) |
| [`terminal/`](./terminal/README.md) | 터미널 research 문서 — 커서/플리커 정본 3종, Claude OSC 시퀀스 가이드, IME caret 리디자인 플랜, 커서 점프 트레이스 증거 |
| [`claude-code-automation.md`](./claude-code-automation.md) | dev 터미널에서 Claude Code 를 프로그래밍 방식으로 구동·검증하는 런북 |
