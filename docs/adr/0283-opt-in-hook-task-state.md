# 0283. 훅 상태는 현재 대화 귀속을 검증한 뒤 선택적으로 사용한다

- Status: Accepted
- Date: 2026-09-29
- Source: 사용자 요구(휴리스틱 대신 훅 감지를 선택하는 기능은 별도 PR), [ADR-0282](0282-optional-agent-hook-installation.md), [검증 결과](../agent-hooks-validation.md), [ADR-0005](0005-display-state-raw-separation-compute.md), [ADR-0250](0250-terminal-task-state-and-notification-transitions.md)
- 관계: ADR-0282의 관찰 전용 범위를 확장한다. 지연된 서버의 원래 pane 식별자는 대화 귀속의 정본이 아니라는 점을 명시한다.

## Context

훅 설치와 훅 사용은 다른 선택이다. 사용자는 Claude·Codex별로 기존 감지를 유지하거나 훅 기반 상태를 우선 사용할 수 있어야 한다. 설치·신뢰 승인·CLI 버전에 따라 훅이 없거나 일부 이벤트가 누락될 수 있다.

Codex 0.158은 TUI가 셸로 돌아와도 서버와 대화가 남는다. 다른 pane이나 새 PTY에서 resume하면 서버가 원래 환경 변수를 유지할 수 있다. 따라서 훅이 전달한 pane ID·PTY 토큰 또는 SessionEnd 부재만으로 현재 pane의 대화를 판정하면 셸 오인을 재발시킨다. Stop도 CLI 프로세스 종료가 아니며 다른 사용자 Stop 훅은 작업을 계속시킬 수 있다.

## Decision

**provider별 기본값은 heuristic으로 유지하고 hooks 선택 시 현재 실행 환경·프로세스·정확한 대화 ID가 일치하는 훅 관찰을 작업 상태에 우선 사용한다.**

- `claude.stateDetection`과 `codex.stateDetection`은 `heuristic|hooks`다. 설정 변경은 기존 Settings 저장 방식에 따르며 훅 설치·제거는 계속 별도 명시 동작이다.
- Rust는 유계 메모리 레지스트리에 provider·실행 환경·대화별 원시 훅 관찰을 보관한다. 기존 Automation IP allowlist 안의 관찰 수신 자체는 활동·세션 복원 상태를 변경하지 않는다. 오래된 PTY 토큰의 관찰도 현재 대화의 별도 검증 전에는 소비할 수 없다.
- 현재 PTY 세대와 실제 프로세스에 귀속된 provider 조회가 정확한 대화 ID를 반환해야 훅을 소비한다. WSL 배포판도 일치해야 한다. 다른 대화·subagent·중복 귀속·셸·프로세스 조회 실패에서는 훅 상태를 내보내지 않는다. CWD나 최근 파일 시각으로 대화를 추정하지 않는다.
- native Codex 저장소는 Laymux의 환경이 아니라 실제 TUI 프로세스의 `CODEX_HOME`·`CODEX_SQLITE_HOME`을 읽는다. Codex 0.158 공유 서버는 현재 TUI와 서버 대화를 연결하는 검증된 계약이 없으므로 훅 우선에서도 휴리스틱을 사용한다. 독립 실행 `--no-daemon`을 Settings에서 안내하되 사용자의 실행 명령이나 공유 서버 설정을 자동 변경하지 않는다.
- 프런트는 훅 원시 상태와 기존 감지 상태를 분리하고 단일 선택 함수에서 표시할 작업을 도출한다. 훅 모드라도 미설치·비활성·미수신·귀속 실패·관찰 만료에는 기존 감지를 사용한다. 세대·provider 변경과 수신 지연에 걸친 오래된 응답을 거부한다. 감지 출처는 진단 API와 Settings에서 확인할 수 있다.
- UserPromptSubmit·도구 진행은 작업 중, PermissionRequest·질문은 입력 대기, Stop은 응답 종료 관찰, Interrupt·StopFailure는 관찰된 중단·실패다. SessionStart의 compact는 작업 완료가 아니며 SessionEnd는 프로세스 생존의 대체 근거가 아니다. 도구·프롬프트·응답 내용은 수집하지 않는다. 다른 훅의 승인·거부 결정을 변경하지 않는다.
- CLI 이벤트만으로 모든 후속 훅의 판단이나 누락을 알 수 없으므로 신뢰 가능한 상태의 범위를 표시하고 불확실하면 기존 경로로 돌아간다. 관찰은 디스크 복원점의 영속성을 보장하지 않는다. 이 PR은 활동 감지 선택을 소유하며 종료 체크포인트의 `/status` 계약은 변경하지 않는다.

## Alternatives Considered

- 훅 pane ID와 토큰만 믿기: 공유 서버와 resume가 원래 pane에 잘못 연결될 수 있다.
- 훅이 오면 provider 자체를 실행 중으로 전환: 셸에 남은 서버와 지연 이벤트가 원래 종료 실패를 재발시킨다.
- 기존 상태 필드를 여러 감지기가 번갈아 덮어쓰기: 이벤트 순서에 따라 선택 설정을 무시하고 표시·알림이 흔들린다.
- 훅 모드에서 기존 감지를 모두 끄기: 비지원 CLI·누락 이벤트·신뢰 미승인에서 상태가 사라지고 종료 감지가 악화된다.

## Consequences

기존 사용자는 바뀌지 않고 원하는 provider에만 훅 상태를 적용한다. 강한 대화 귀속과 유계 관찰의 비용이 추가되며 관찰할 수 없는 조합은 기존 감지로 명시적으로 돌아간다. Windows·WSL, 두 provider, 새 대화·resume·작업·승인·응답 종료·중단·셸 복귀, 선택 해제·훅 제거·미수신·PTY 교체·늦은 이벤트·다른 대화의 조합을 검증한다. 새 CLI 이벤트가 추가되거나 공유 서버 귀속 계약이 바뀌면 이 결정을 재검토한다.
