# 0254. 확인된 작업 없음은 출력 활동보다 우선한다

- Status: Accepted
- Date: 2026-09-17
- Source: 사용자 Windows Codex 조기 완료·WSL Astra 빈 입력창 모래시계 제보, Codex 0.154.0 dev 실측, architecture/data-flow.md §9
- Partially Supersedes: [ADR-0251](0251-single-terminal-status-icon.md)의 작업 없음에서 출력 활동을 모래시계로 표시하는 규칙
- Preserves: [ADR-0250](0250-terminal-task-state-and-notification-transitions.md)의 작업·관측·출력 상태 분리, 알림·절전·clear 정책

## Context

Windows dev에서 동일한 새 Codex 세션을 native와 WSL에 열었다. 두 세션 모두 턴 조회가 `idle`을 반환하고 공통 작업은 `idle/confirmed`였다. WSL Astra는 입력창의 반짝이를 계속 출력하여 `outputActive=true`였고, ADR-0251의 출력 fallback이 이를 모래시계로 표시했다. 앱 식별·세션 귀속·유휴 관측에 실패한 사례가 아니라, 확인된 유휴를 표시 단계에서 뒤집은 사례다. 기존 표시 테스트도 이 조합을 모래시계로 기대해 회귀를 놓쳤다.

범위는 공통 상태 아이콘의 우선순위다. 작업 시작·완료의 감지 방법이나 출력 검출기는 이 결정으로 바꾸지 않는다. Windows 조기 완료는 별도 런타임 조건을 검증해야 하며 이 표시 수정만으로 해결됐다고 판단하지 않는다.

## Decision

**확인된 작업 없음은 출력 활동과 관계없이 대시로 표시하고, 출력만의 모래시계는 작업 상태가 없는 경우에만 허용한다.**

- `idle`은 `—`다. `running`, `waiting`, `ended`의 기존 표시와 마찬가지로 출력 활동보다 우선한다. 관측 지연에서 보존된 `idle`도 출력으로 진행 상태를 추정하지 않는다.
- 작업 상태가 없는 경우의 출력 fallback은 유지한다. 작업이 미확인인 상태를 유휴로 합성하지 않는다.
- Desktop과 Remote는 동일한 순수 표시 함수를 쓴다. 원시 `outputActive`는 보존하고, 아이콘으로 작업·알림·절전·clear 정책을 역산하지 않는다. 모델 이름·타이틀 설정·OS별 예외는 추가하지 않는다.

## Alternatives Considered

- Astra의 색상·문자 애니메이션을 출력 검출에서 제거: 출력 자체는 실제로 발생하며 작업 중 애니메이션과 같은 경로다. 모델별 렌더링 패턴에 의존하게 된다.
- Codex에만 출력 fallback 금지: 같은 `idle`이 앱마다 다른 의미로 표시된다. 이미 확인한 작업 상태를 우선하는 공통 규칙으로 해결한다.
- 출력 활동의 모래시계를 모두 제거: 작업 관측이 없는 셸·TUI의 출력 표시까지 바꾼다. 이번 실측에서 확인한 충돌보다 범위가 넓다.

## Consequences

빈 Astra 입력창을 유휴로 표시하고, 실제 `running`을 관측하면 출력량과 무관하게 모래시계를 표시한다. 확인된 유휴에서 비작업 출력이 발생해도 단일 아이콘에는 드러나지 않는 비용이 있다. 원시 출력 활동은 진단/API에 남는다. 스키마·설정·의존성·마이그레이션은 추가하지 않는다.

표시 조합과 Codex 조회→store→selector 경로를 회귀 테스트로 고정한다. 같은 dev의 실제 빈 입력창에서 `idle/confirmed`, `outputActive=true`, `—`를 함께 확인하고, 연속 요청·작업 중 대기·완료·중단 및 Remote 표시를 검증한다. 작업 미확인에서의 장기 출력 fallback이나 오래된 완료 관측 문제는 따로 원인을 측정해야 한다.

실측 결과와 재현 조건은 [Codex 상태 재현 기록](../codex-task-status-repro-2026-09-17.md)에 둔다.
