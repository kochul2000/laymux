# Architecture Decision Records

laymux 의 아키텍처 결정 기록. **append-only, 불변.** "왜 그렇게 정했나" 의 SoT 다.
현재 구조(살아있는 설명)는 [../architecture/](../architecture/) 를 본다 — ADR 은 결정의 *근거*만 고정하고, 코드가 지금 어떻게 생겼는지는 living doc 이 SoT.

| ADR | 제목 | Status |
|---|---|---|
| [0001](0001-osc-rust-single-pass.md) | OSC 처리 — Rust 단일 패스, 프론트엔드는 이벤트만 | Accepted |
| [0002](0002-automation-api-fixed-port-ip-allowlist.md) | Automation API — 고정 포트 + IP allowlist 무인증 | Accepted |
| [0003](0003-cwd-single-source-syncgroup.md) | CWD 단일 소스 + SyncGroup 전파 (백그라운드 셸 금지) | Accepted |
| [0004](0004-settings-vs-ui-state-separation.md) | settings.json(구성) vs localStorage(UI 상태) 분리 + 오버라이드 레이어 | Accepted |
| [0005](0005-display-state-raw-separation-compute.md) | 표시 상태 — 원시 상태 분리 → 단일 계산 함수 | Accepted |
| [0006](0006-embedded-mcp-server.md) | 내장 MCP 서버 (rmcp HTTP `/mcp`, 별도 바이너리 폐기) | Accepted |
| [0007](0007-pane-identifier-trio.md) | Pane 식별자 3종 분리 (terminalId / paneIndex / paneNumber) | Accepted |
| [0008](0008-shell-cursor-shadow-cursor.md) | 터미널 셸 커서/플리커 — shadow cursor 4-layer | Accepted |
| [0009](0009-process-tree-interactive-app-liveness.md) | 인터랙티브 앱 인식 — 프로세스 트리 liveness + 마운트 동기화 | Accepted |
| [0010](0010-notification-dismiss-on-program-focus-entry.md) | 알림 해제 — 사용자 입력 종류가 아닌 프로그램의 진입/포커스 동작 기준 | Accepted |

## 새 ADR 추가

1. `0000-template.md` 를 다음 번호로 복사 (`NNNN-kebab-case-제목.md`, 4자리 zero-pad).
2. Context / Decision / Consequences 작성, Status=Accepted.
3. 이 표에 한 줄 추가.
4. 기존 결정을 번복하면 → 새 ADR 작성 + 옛 ADR 의 Status 만 `Superseded by [NNNN]` 로 변경 (본문은 고치지 않는다).

> 초기 ADR(0001–0008)은 구 `ARCHITECTURE.md` 와 `CLAUDE.md` 의 설계 규칙에 흩어져 있던 결정들을 이전한 것이다. 각 ADR 의 `Source` 가 원 출처를 가리킨다.
