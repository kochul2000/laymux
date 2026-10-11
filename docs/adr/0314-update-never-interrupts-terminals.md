# 0314. 업데이트는 터미널을 인터럽트하지 않고, Ctrl+C 정리는 명시적 종료에만 쓴다

- Status: Accepted
- Date: 2026-10-11
- Source: 사용자 보고("데몬 형식으로 바꾸었는데 버전 업데이트때 여전히 터미널 종료동작을 해버려", "업데이트 종료 경로와 완전 종료경로가 구분되어야 돼", "업데이트 위한 종료에서 Ctrl C 3번은 하거든? 그건 명시종료때만 있어야지"), v1.8.0 → v1.8.1 업데이트 실측, [ADR-0264](0264-exit-update-progress-dialog.md), [ADR-0308](0308-pty-daemon-generations-across-updates.md), [ADR-0048](0048-kill-terminals-on-exit.md)
- 관계: ADR-0264의 "저장된 종료 설정으로 선택적 Ctrl+C·출력 대기를 수행한다"를 업데이트에 한해 대체한다. 종료와 업데이트가 같은 진행 모달과 checkpoint·출력 캐시 단계를 공유한다는 결정은 유지한다.

## Context

ADR-0264는 업데이트 준비를 종료 준비와 같은 함수로 만들었다. critical checkpoint 다음에 저장된 종료 설정(`exit.interruptTerminals`)이 켜져 있으면 모든 터미널에 Ctrl+C를 여러 번 보낸다. 당시에는 설치기가 GUI와 모든 터미널을 끝냈다. 그래서 끝나기 전에 에이전트가 resume 정보를 출력하게 하는 것(ADR-0048의 효용 B)이 업데이트에도 이득이었다.

ADR-0308 이후 업데이트는 PTY 데몬 세션을 끝내지 않는다. 새 GUI가 같은 pane에서 그 세션을 다시 붙인다. 그런데 준비 단계의 Ctrl+C는 그대로 남아 있었다. v1.8.0 → v1.8.1 업데이트에서 실제로 확인한 결과는 다음과 같다.

- 이전 세대 데몬의 셸 6개(PowerShell 2, WSL 4)는 모두 살아남았고, 새 GUI가 재결합했다.
- 그 안에서 실행 중이던 Claude·Codex 같은 작업은 업데이트 직전의 Ctrl+C ×3으로 끝났다.
- 재결합한 터미널은 업데이트 checkpoint의 agent resume을 건너뛴다(ADR-0308, 기존 `adopted` 규칙). 그래서 끝난 에이전트가 다시 시작되지도 않았다.

데몬은 작업을 보존하고, 준비 단계는 바로 그 작업을 끊었다. 사용자는 업데이트를 위한 종료와 명시적 종료를 다른 경로로 보고, Ctrl+C 정리는 명시적 종료에만 있어야 한다고 정했다. living doc(`data-flow.md`)도 "`exit.interruptTerminals`는 일반 종료의 인터럽트만 제어한다"고 적고 있었으나 코드가 이와 달랐다.

## Decision

**업데이트 준비는 터미널에 Ctrl+C를 보내지 않는다. `exit.interruptTerminals`의 Ctrl+C 정리는 사용자가 앱을 명시적으로 종료할 때만 실행한다.**

- 업데이트 준비 단계는 checkpoint → 출력 캐시뿐이다. 프론트엔드는 업데이트 요청에 출력 캐시(`cacheTerminalOutputs`)만 수행한다. 명시적 종료는 `prepareTerminalExit`(Ctrl+C 정리 → 출력 캐시)를 그대로 쓴다.
- `UpdateStatus`는 종료 설정(`exitSettings`)을 싣지 않는다. 업데이트 준비 단계(`PreparationStage`)에서 `interrupting`·`settling`을 뺀다. 이 두 단계는 종료 진행 화면에만 있다.
- 업데이트 확인 화면은 "작업 정리 켜짐/꺼짐" 대신 터미널 작업이 업데이트 동안에도 계속 실행된다고 안내한다. PC와 Remote가 같은 문구를 쓴다.
- dev lifecycle preview는 update에 `interrupting`·`settling` 단계나 `cleanup`을 주면 거부한다.

## Alternatives Considered

- **데몬 세션이 아닌 터미널(in-process PTY)에만 Ctrl+C를 보낸다:** 데몬을 끈 환경(`LAYMUX_PTY_DAEMON=0`)이나 데몬 기동에 실패해 in-process로 떨어진 터미널은 업데이트에서 끝나므로, resume 정보 출력 효용이 남는다. 하지만 업데이트 종료와 명시적 종료를 구분한다는 사용자 결정과 맞지 않는다. 또 터미널마다 backend를 프론트엔드에 노출해야 하므로 선택하지 않았다. 해당 터미널의 agent 복원은 Ctrl+C 출력이 아니라 checkpoint의 세션 정보로 이루어진다.
- **업데이트용 Ctrl+C 설정을 따로 둔다:** 데몬이 세션을 보존하는 한 켤 이유가 없는 설정이 되고, 잘못 켜면 이번 결함을 다시 만든다. 그래서 선택하지 않았다.
- **Ctrl+C를 유지하고 재결합 터미널에서 agent resume을 다시 허용한다:** 작업을 끊었다가 다시 시작하는 것은 보존이 아니다. 실행 중이던 빌드·셸 작업은 resume할 수도 없다.

## Consequences

- 업데이트 뒤 데몬 세션 안의 셸, 에이전트, 빌드가 끊기지 않고 같은 pane에서 계속된다.
- `exit.interruptTerminals`를 켠 사용자도 업데이트로 작업을 잃지 않는다. 앱을 직접 닫을 때만 정리가 실행된다.
- in-process PTY 터미널(데몬 비활성·기동 실패)은 업데이트에서 끝나고, 끝나기 전에 Ctrl+C를 받지도 않는다. 이런 터미널에서는 에이전트가 resume 힌트를 출력할 기회가 없어진다. 대신 checkpoint의 세션 정보로 복원한다.
- 업데이트 진행 화면이 한 단계 줄어든다(다운로드 → 복원 정보 저장 → 터미널 기록 저장 → 설치).
- 검증: 업데이트 요청이 `prepareTerminalExit`를 부르지 않고 출력 캐시만 수행하는지, update 단계 목록에 정리 단계가 없는지, PC와 Remote 확인 화면 문구를 단위·e2e 테스트로 확인한다.
