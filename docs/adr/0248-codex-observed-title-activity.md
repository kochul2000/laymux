# 0248. 관측된 Codex 타이틀로 작업 경계를 판정한다

- Status: Proposed
- Date: 2026-09-14
- Source: 사용자 Codex 영구 모래시계 보고, dev Codex 0.154.0/Astra 재현, [data-flow](../architecture/data-flow.md)의 outputActive 감지, [ADR-0147](0147-output-volume-activity-and-app-declared-idle.md)
- 관계: ADR-0147의 앱 선언 우선 원칙을 Codex의 관측된 타이틀 lifecycle에 확장한다.

## Context

Codex Astra의 장식 애니메이션은 유휴 composer도 150ms마다 다시 그린다. dev에서 반짝이가 활성인 동안 타이틀은 유휴인데 frame source가 outputActive를 계속 켜며 2초 타이머의 만료를 막는 것을 확인했다. 따라서 렌더링 정지는 작업 완료의 필요조건이 아니다.

Codex의 유휴 타이틀은 고유 접두어 없는 대화명/디렉터리이고 사용자가 타이틀 구성을 바꿀 수 있다. 임의의 정적 타이틀을 처음부터 유휴 선언으로 취급하면 타이틀 신호가 없는 작업을 놓친다. 프로세스 생존 판정과 터미널 바이트/렌더링은 변경 범위 밖이다.

## Decision

현재 Codex activity에서 실제 Braille 작업 타이틀을 관측한 경우에만, 이후 타이틀 전환을 출력량·프레임보다 우선하는 작업 경계로 사용한다.

Zustand의 기존 outputActive가 표시 상태의 원시 소스로 남는다. 이벤트 수신자는 현재 hook 수명 안에서 타이틀 신호를 관측한 terminal ID만 기억한다. 관측 뒤 작업 타이틀은 outputActive를 켜고 추론 타이머를 취소한다. 비어 있지 않은 비스피너 타이틀은 기존 완료 경로를 한 번 실행하고 outputActive를 끈다. 이 세션의 frame/volume 이벤트는 작업 경계를 덮어쓰지 않는다.

타이틀이 비거나 시작 배너로 돌아오면 관측 자격을 해제하고 출력 기반 감지로 복귀한다. Codex activity를 떠나거나 terminal이 제거되어도 자격을 버린다. WebView 재시작에서는 자격을 복원하지 않고 새 작업 타이틀을 다시 관측한다. 한 번도 작업 타이틀을 관측하지 않은 세션은 기존 frame/volume 추론을 유지한다. Windows와 WSL에 같은 규칙을 적용하며 API·설정·영속 스키마는 추가하지 않는다.

## Alternatives Considered

- 반짝이를 끄기: 사용자가 선택한 Codex 장식을 변경하며 다른 유휴 리렌더에도 같은 결함이 남는다.
- 프레임 임계/타임아웃 조정: 지속 애니메이션과 실제 작업은 같은 렌더링 신호를 내므로 경계가 되지 못한다.
- 모든 비스피너 타이틀을 즉시 유휴로 간주: 정적 타이틀 사용자까지 출력 감지에서 제외한다.
- rollout 파일 감시로 완료 판정: 별도 세션 귀속·파일 lifecycle을 작업 상태와 결합하는 비용이 있다. 이미 관측 가능한 TUI 타이틀로 이번 결함을 해결한다.

## Consequences

반짝이를 유지하면서 완료 표시와 알림을 되살리고, 조용한 작업 중 타이머 만료를 완료로 오인하지 않는다. 회귀 테스트는 반복 frame/volume, 다음 작업, activity 종료 후 fallback을 검증한다.

한 번 작업 타이틀을 제공하던 앱이 같은 실행 중 타이틀 갱신을 아무 신호 없이 중단하면 최신 타이틀 상태가 남는다. WebView 리로드 직후 이미 유휴인 세션도 다시 작업 타이틀을 볼 때까지 기존 추론의 한계를 가진다. 이 조건이 실제 문제로 확인되면 프로세스 incarnation에 귀속된 lifecycle 소스를 별도로 검토한다.

재현에서는 dev의 초기 색상 조회 지연 때문에 애니메이션이 꺼지는 조건이 있어, WSL Codex의 OSC 10/11 조회를 관측한 직후 재현 도구로 고정 팔레트 응답을 제공했다. 이는 dev 실험 설정이며 제품의 프로토콜 응답 경로는 수정하지 않는다.
