# 0323. 업데이트 복원점의 대화 확정은 종료되는 PTY에만 요구한다

- Status: Accepted
- Date: 2026-10-14
- Source: 사용자 보고(업데이트 때 Codex CLI override 확인 실패, 데몬 방식에서 확인이 필요한지 검증하고 수정 PR 요청), [ADR-0222](0222-agent-session-checkpoint-coordinator.md), [ADR-0270](0270-codex-status-checkpoint-probe.md), [ADR-0308](0308-pty-daemon-generations-across-updates.md), [ADR-0314](0314-update-never-interrupts-terminals.md), [data-flow.md §13.5](../architecture/data-flow.md)
- 관계: ADR-0222의 업데이트 전체 terminal critical barrier와 ADR-0270·[ADR-0278](0278-codex-status-current-screen.md)의 업데이트 `/status` 확인을 일부 대체한다. ADR-0314의 checkpoint·출력 캐시 단계는 유지하고 checkpoint 대상 정책을 확장한다. [ADR-0296](0296-committed-checkpoint-reuse-on-finalization.md)의 receipt 재사용은 명시적 종료로 한정한다.

## Context

업데이트 뒤 데몬 PTY는 같은 프로세스에 재결합하며 agent resume을 실행하지 않는다. 하지만 업데이트 준비는 여전히 모든 Codex의 현재 대화를 확인하고, 필요하면 초안을 지우고 `/status`를 입력한다. CLI override나 실행 중 작업 때문에 확인에 실패하면 업데이트가 중단되고 사용자에게 작업 종료를 요구한다. Ctrl+C만 제거한 ADR-0314로는 이 문제가 해결되지 않았다.

`/status`만 없애도 전체 terminal의 대화 ID를 확정하는 critical checkpoint가 미확인 대화 때문에 실패한다. 반대로 모든 검증을 없애면 데몬 비활성·기동 실패로 GUI가 소유하는 PTY의 디스크 복원 보호까지 사라진다. 환경 설정값이 아니라 실제 PTY의 종료 책임을 기준으로 구분해야 한다.

## Decision

**업데이트는 Codex 상태 확인 입력을 실행하지 않으며, GUI 종료 때 끝나는 PTY에만 대화 귀속의 확정을 요구한다.**

- Rust가 업데이트의 전역 입력 fence와 mutation drain 뒤 실제 PTY handle의 종료 책임을 읽는다. 데몬이 자식을 소유하는 handle은 재결합 대상이며, 그 밖의 handle은 디스크 복원 검증 대상이다. Windows·Linux에 같은 기준을 적용한다.
- 기존 내부 checkpoint 요청의 `terminalIds`는 디스크 복원 검증 대상만 담는다. 대상이 있으면 `requireConclusive=true`로 기존 150ms 이중 관측·귀속·CWD 검증을 유지한다. 대상이 없으면 `requireConclusive=false`로 저장한다. 빈 목록을 전체 critical 대상으로 해석하지 않도록 두 값을 함께 결정한다.
- 대상 목록은 엄격한 검증 범위이며 저장 범위가 아니다. 모든 workspace·pane·CWD·관측 가능한 agent 복원 정보는 기존 조정기와 로컬 세션 DB에 저장한다. 미확인 정보는 기존 보존·삭제 정책을 따르며 대화 ID를 추정하지 않는다.
- 업데이트는 종료용 Codex 확인 및 receipt 재사용 경로를 호출하지 않는다. 현재 레이아웃 저장과 출력 캐시가 끝난 뒤에만 성공 ACK한다. 저장 실패·drain 실패·timeout은 기존처럼 설치를 중단하고 입력 fence를 해제한다.
- `codex.verifySessionOnExit`에 따른 입력 기반 확인은 명시적 앱 종료에만 적용한다. GUI 소유 PTY의 대화가 읽기 기반 귀속으로 확정되지 않으면 업데이트는 실패한다. 자동 입력으로 그 작업을 건드리지 않는다.
- dev 검증은 기존 인계 API의 `prepare` 모드로 실제 설치 준비 함수·native 요청·frontend 저장/캐시·ACK를 실행한다. 성공/실패 뒤 검증이 소유한 fence와 업데이트 상태를 복구하고 설치·앱 종료는 실행하지 않는다. 실제 release 설치 허용 여부는 바꾸지 않으며, HTTP 호출자가 끊겨도 시작한 준비를 끝낸 뒤 해제한다. 기존 `installer`·`restart` 모드는 준비를 생략하는 인계 전용 동작을 유지한다.

## Alternatives Considered

- `/status`만 생략: 뒤의 전체 terminal critical checkpoint에서 다시 막힌다.
- 모든 업데이트의 귀속 검증 생략: 업데이트 때 실제로 종료되는 in-process PTY의 복원 보호를 잃는다.
- GUI 소유 PTY에 한해 `/status` 입력: 실행 중 작업·초안에 개입하는 업데이트 절차가 남고, 프로세스 탐색·훅·WSL 검증·receipt까지 대상 범위를 새로 전달해야 한다. 업데이트는 관측과 저장만 수행하고 미확인 디스크 복원은 중단하는 정책을 택한다.
- 데몬 활성 설정만 확인: 데몬 기동 실패로 fallback한 handle이나 이전 세대에서 재결합한 handle의 실제 소유권을 표현하지 못한다.

## Consequences

- 데몬에서 실행 중인 Codex의 CLI override, 대화 ID 미확정, 입력창 상태 때문에 업데이트가 막히거나 초안이 삭제되지 않는다.
- 실제 저장·출력 캐시의 실패는 계속 차단하며, 일반 종료·숨김 pane 정리의 critical 정책은 유지한다.
- 데몬이 이후 죽거나 유예 시간을 넘기면 마지막으로 확인한 디스크 복원 정보만 사용할 수 있다. 업데이트 순간의 대화 ID 확정은 데몬 생존의 대체 보장이 아니다.
- 데몬과 GUI 소유 PTY가 섞인 경우에는 읽기 기반 귀속 또는 CWD 조회의 전체 실패가 여전히 업데이트를 막을 수 있다. 프로세스별 조회 실패의 세분화는 이번 범위에 포함하지 않는다.
- 검증은 실제 데몬 PTY와 로컬 handle의 대상 분류, 미확인 데몬 대화의 저장, 로컬 PTY의 미확인 귀속 차단, 저장·출력 캐시 완료 후 ACK, 업데이트의 Codex 확인 미호출을 포함한다. 설정 마이그레이션과 새 사용자 옵션은 없다.
