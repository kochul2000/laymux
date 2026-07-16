# NNNN. <결정 제목>

- Status: Proposed | Accepted | Superseded by [NNNN](NNNN-....md) | Deprecated
- Date: YYYY-MM-DD
- Source: <원 결정 출처 — 예: architecture/api-contracts.md §N, AGENTS.md 규칙, PR #NN, issue #NN>

## Context

이 결정이 필요해진 배경. 무엇이 문제였고 현재 동작은 어떠한가. 어떤 제약·force 가 작용하며, 이번 결정의 범위와 비목표는 무엇인가.

## Decision

무엇을 정했나. 결론은 단정형으로 한 줄로 요약 가능해야 한다. 필요한 경우 상태 소유권/SoT, 모듈 책임, 외부 계약, 불변식, 실패·보안·크로스플랫폼 정책을 구체화한다.

## Alternatives Considered

검토한 대안과 각 대안을 선택하지 않은 이유. 비용·복잡도·호환성·운영 위험 등 결정에 작용한 force 를 남긴다.

## Consequences

이 결정으로 따라오는 결과 — 장점, 비용, 부채, 위험, 트레이드오프, 마이그레이션/롤아웃, 테스트·문서 후속 작업, 재검토 조건.

<!--
ADR 작성 규칙:
- 리뷰 중에는 Status=Proposed, 방향 승인 후 머지할 때는 Status=Accepted 로 전환한다.
- append-only. 한번 Accepted 된 ADR 본문은 고치지 않는다.
- 번복 시 새 ADR 을 만들고, 옛 ADR 의 Status 를 `Superseded by [NNNN]` 로만 바꾼다.
- 파일명: NNNN-kebab-case-제목.md (NNNN 4자리 zero-pad)
- 병렬 PR 과 번호가 충돌할 수 있으므로 PR 직전 최신 main 기준으로 번호를 다시 확인한다.
- "현재 코드가 어떻게 생겼나" 는 여기 쓰지 말 것 → docs/architecture/ (living doc).
  여기는 "왜 그렇게 정했나" 의 불변 기록.
-->
