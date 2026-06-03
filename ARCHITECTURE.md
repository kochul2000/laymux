# IDE Architecture Document

> **이 문서는 [`docs/architecture/`](./docs/architecture/) 로 분할되었다.** (구 단일 문서, 2026.03.21 확정본 → living doc 3분할)
> 설계 정본은 아래 세 living doc 이며, "왜 그렇게 정했나" 의 불변 기록은 [`docs/adr/`](./docs/adr/) 에 있다.

| living doc | 담는 범위 | 구 섹션 |
|---|---|---|
| [`docs/architecture/overview.md`](./docs/architecture/overview.md) | 구조·정적 모델 | §1 개요 · §2 기술 스택 · §3 레이아웃 · §4 Workspace/Layout · §6 View · §7 SyncGroup |
| [`docs/architecture/data-flow.md`](./docs/architecture/data-flow.md) | 런타임 흐름 | §5 Grid 편집 · §8 TerminalView(OSC·렌더러) · §9 SelectorView · §11 데이터 흐름 · §13 세션 영속/캐시 |
| [`docs/architecture/api-contracts.md`](./docs/architecture/api-contracts.md) | 계약·규약·설계 원칙 | §10 Settings · §12 Automation API+MCP · §14 Rust 설계 원칙 · §15 UI 설계 원칙 |

섹션 번호(§N.M)는 분할 후에도 보존되며, 각 번호는 위 세 문서 중 정확히 한 곳에 있다.
코딩 에이전트 진입점은 [`AGENTS.md`](./AGENTS.md) 를 본다.
