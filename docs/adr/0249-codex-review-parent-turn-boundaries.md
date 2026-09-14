# 0249. Codex 리뷰 경계에서 부모 턴의 귀속을 복원한다

- Status: Accepted
- Date: 2026-09-14
- Source: 사용자 v1.0.1 `/review` 완료 후 영구 모래시계 제보, 해당 pane의 Codex 0.154.0 rollout 실측, [ADR-0248](0248-codex-turn-lifecycle-activity.md), architecture/data-flow.md §13.5
- Amends: ADR-0248의 현재 턴 식별 규칙. 세션 귀속·원시 상태 소유권·IPC 스키마는 유지한다.
- References: [Codex 리뷰 이벤트 전달](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tasks/review.rs), [Legacy/Paginated 저장 정책](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/rollout/src/policy.rs)

## Context

Codex 0.154.0의 리뷰는 부모 세션의 한 rollout에 부모 EnteredReviewMode, 하위 리뷰 task_started, 부모 ExitedReviewMode, 부모 task_complete를 기록한다. 시작과 완료의 turn_id가 서로 다를 수 있다. 기존 파서는 하위 시작 ID를 현재 턴으로 기억하고 부모 완료를 오래된 종료로 오인해 버린다. 실제 제보 pane은 출력 활동이 꺼져도 running으로 남았다.

완료 문구나 타이틀을 추가로 추측할 필요는 없다. Legacy 기록에는 entered_review_mode/exited_review_mode 이벤트가, Paginated 기록에는 해당 TurnItem을 담은 item_completed가 있다. ExitedReviewMode는 리뷰 중단 때도 발생하므로 그 자체를 성공으로 처리해서는 안 된다. 다른 턴의 늦은 종료를 무조건 받아들이는 것도 기존 보호를 없앤다.

## Decision

**현재 세션의 구조화된 리뷰 진입·종료 경계에서 부모 turn_id를 진행 중인 턴으로 복원하고, 이후 부모의 종료 이벤트로 결과를 판정한다.**

- 두 저장 형식의 리뷰 경계를 같은 의미로 해석한다. 경계의 유효한 turn_id를 사용하고, 텍스트 본문·모델·타이틀·시간 경과는 귀속 근거로 사용하지 않는다.
- 리뷰 경계는 running만 만든다. 부모 task_complete/turn_complete와 error, turn_aborted가 기존 규칙대로 완료·실패·중단을 결정한다.
- 하위 시작 이벤트를 마지막으로 본 상태에서도 리뷰 종료 경계가 부모 ID를 다시 세운다. 초기 읽기 구간에 진입 경계가 없어도 종료 경계와 부모 종료만으로 복원한다.
- 새로운 일반 턴의 시작 이후에 도착한 다른 ID의 종료는 계속 무시한다. PTY generation·프로세스별 세션 선택 검증, 읽기 상한·부분 줄·미확인 처리와 알림 중복 방지는 ADR-0248을 유지한다.

## Alternatives Considered

- 모든 다른 ID의 종료 수용: 리뷰 증상은 사라지지만 새 작업을 오래된 종료로 덮을 수 있다.
- ExitedReviewMode를 즉시 성공으로 처리: 중단 경로도 이 이벤트를 내므로 성공 알림을 오발행할 수 있다.
- 화면의 리뷰 완료 문구 감지: 번역·표시 형식에 의존하고 구조화된 근거가 이미 있다.
- 부모·자식 턴 전체 추적기: 현재 문제는 명시적 경계에서 ID를 복원하는 것으로 해결되며 추가 상태나 계층 저장이 필요하지 않다.

## Consequences

화면이 멈춘 리뷰를 실제 부모 완료로 끝내며 일반 턴의 오래된 종료 방어를 보존한다. 추가 의존성·설정·IPC 필드는 없다. Legacy/Paginated 리뷰 완료·중단·초기 꼬리 읽기와 이후 일반 턴의 회귀 테스트, dev 실측을 남긴다. 내부 저장 형식 의존성은 그대로이므로 Codex의 리뷰 이벤트 전달/저장 정책이 바뀌면 재검토한다.
