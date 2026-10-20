# 0348. Restart View는 기존 checkpoint와 에이전트 세션 복원을 재사용한다

- Status: Accepted
- Date: 2026-10-20
- Source: 사용자 요구(Restart View에서 Claude·Codex·Grok을 종료 후 같은 세션으로 resume), [data-flow.md §13.5](../architecture/data-flow.md#135-체크포인트-조정과-파괴-전-barrier), [ADR-0222](0222-agent-session-checkpoint-coordinator.md), [ADR-0113](0113-workspace-clear-activity-owned.md), [ADR-0140](0140-split-pane-inherits-source-cwd.md)
- 관계: ADR-0113·0140의 요청 버스를 확장한다. Clear와 분할의 새 세션 정책은 유지한다.

## Context

Restart View는 터미널을 재마운트하면서 에이전트 세션 복원을 건너뛰므로 실행 중인 대화를 잃는다. 앱 종료·재시작에는 현재 대화의 귀속을 확인해 checkpoint로 저장하고 설정된 명령으로 resume하는 경로가 이미 있다. 버튼을 위해 세션 탐지나 resume 명령을 따로 구현하면 두 경로의 검증과 사용자 설정이 달라진다. 범위는 desktop grid·stack layer·dock의 Restart View이며 Clear와 분할의 의미를 바꾸지 않는다.

## Decision

**Restart View는 현재 터미널의 기존 critical checkpoint를 완료한 뒤 PTY를 교체하고, 앱 기동과 같은 에이전트 복원 분기로 실행한다.**

- 대화 ID의 정본은 기존 backend 귀속과 commit된 pane view다. hidden eviction의 대상 입력 차단·진행 중 mutation drain·critical checkpoint·close transaction을 공통으로 사용한다. 입력 차단은 저장을 기다리는 동안과 close 완료까지 유지하고, 무관한 pane 입력은 허용한다. `flushSessionCheckpoint`의 대상별 안정 관측·저장·메모리 게시를 그대로 재사용하며 별도 세션 검색이나 resume 명령 조립은 만들지 않는다.
- 내부 IPC `checkpoint_and_close_terminal_for_restart(id,generation?)`는 이 공통 transaction을 `restart` 이유로 호출한다. 지정한 generation이 바뀌면 종료하지 않는다. frontend는 이 이유에 숨김 만료 조건을 적용하지 않고 대상 checkpoint의 확정 완료를 확인해 ACK한다. 기존 `eviction`의 숨김 자격 검증은 유지한다.
- 세션을 확인할 수 없거나 저장에 실패하면 실행 중인 PTY를 종료하지 않고 실패를 알린다. 준비되지 않은 터미널은 기존 새 시작으로 복구할 수 있다.
- checkpoint 도중 pane이 삭제·교체되거나 터미널 generation이 바뀌면 이전 요청을 적용하지 않는다. 같은 pane의 중복 요청은 진행 중 작업에 합류한다.
- 요청 버스는 세션 복원 허용 여부만 전달한다. TerminalView의 기존 provider별 `restoreSession` 설정, 명령·ID 검증, Fresh 처리와 startup override 우선순위를 그대로 사용한다. 현재 CWD와 새 출력 화면 정책은 기존 Restart View를 따른다.
- 기존 terminal ID별 lifecycle 직렬화가 close 완료 후 create를 수행한다. Windows와 Linux에 별도 프로세스 종료·실행 경로를 추가하지 않는다.
- Clear의 restart와 분할 CWD 시드는 기본값인 새 세션 시작을 유지한다.

## Alternatives Considered

- 버튼에서 provider를 감지하고 resume 명령을 직접 전송한다: 기존 귀속 검증과 명령 설정을 중복하고 종료 완료 순서를 별도로 관리해야 한다.
- 저장된 ID만으로 즉시 재마운트한다: 실행 중 대화가 바뀌었으면 이전 세션을 재개할 수 있다.
- 모든 restart 요청에 resume을 켠다: Clear가 대화 문맥을 제거하지 못하고 새 pane의 시작 정책까지 바뀐다.
- 앱 전체 종료 준비를 호출한다: 다른 pane의 입력 차단과 종료 정리까지 수행하므로 단일 pane 재시작 범위를 벗어난다.

## Consequences

- 세 provider가 앱 재시작과 같은 검증·설정으로 복원된다. checkpoint 대기 시간이 추가되며 귀속이 불명확하면 사용자가 다시 시도해야 한다.
- 새 설정·저장 스키마·마이그레이션은 없다. 기존 복원 설정을 끈 provider는 앱 기동 때와 동일하게 resume하지 않는다.
- 회귀 검증은 세 provider의 최신 ID 게시, 저장 실패·교체 중 취소, grid·dock 연결, Clear의 새 세션 정책과 close→create 순서를 포함한다.
- 세션 확인을 할 수 없는 상황에서도 강제 종료가 필요해지면 별도 사용자 동작과 손실 정책을 다시 결정한다.
