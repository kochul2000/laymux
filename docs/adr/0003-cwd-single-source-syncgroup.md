# 0003. CWD 단일 소스 + SyncGroup 전파 (백그라운드 셸 금지)

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §7 · §10(CWD 전파 가드) · §11, CLAUDE.md 규칙

## Context

CWD(현재 작업 디렉터리)는 WorkspaceSelectorView 표시, FileExplorerView, 터미널 간 동기화 등 다수 기능의 입력이다. 각 View 가 CWD 를 얻으려고 별도 백그라운드 셸을 띄우면 PTY/리소스가 낭비되고 진실이 여러 곳으로 갈라진다. 또한 OSC 7 은 일부 셸이 프롬프트 재렌더마다 재발행하므로, 사용자가 실제로 `cd` 한 시점만 골라내야 한다.

## Decision

**CWD 의 단일 진실 소스는 Rust `TerminalSession.cwd`** 이고, SyncGroup 단위로 전파한다.

- 같은 `syncGroup` 문자열을 가진 터미널끼리 동기화(기본값 = Workspace ID, `"none"` = 독립).
- 전파는 activity 가드를 통과해야 한다 — 소스가 `Shell`(= `OSC 133;D` 직후)일 때만. `Running`/`InteractiveApp` 상태의 OSC 7 은 전파하지 않는다. 무한 루프는 `LX_PROPAGATED=1` 로 차단.
- 프론트엔드/새 View 는 백그라운드 셸을 만들지 말고 `terminalStore` 의 syncGroup CWD 를 구독한다. 파일시스템 접근은 Rust `std::fs` 를 직접 호출한다.

## Consequences

- CWD 정보가 필요한 새 기능은 셸을 추가로 띄우지 않는다 — 이것이 설계의 핵심 제약.
- 전파/대상 필터링은 `detect_terminal_state`(activity + 영구 추적 `known_*_terminals`) 한 곳에서 평가한다.
- 현재 전파 흐름·가드 순서는 [architecture/data-flow.md](../architecture/data-flow.md) §11 및 [api-contracts.md](../architecture/api-contracts.md) §10(CWD 전파 가드)이 SoT.
