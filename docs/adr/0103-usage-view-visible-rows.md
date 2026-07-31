# 0103. UsageView 표시 행은 전역 사용량 설정이 소유한다

- Status: Accepted
- Date: 2026-07-31
- Source: 사용자 요구; [ADR-0102](0102-claude-usage-probe-headless-pty.md); `docs/architecture/api-contracts.md` 사용량 모니터 설정

## Context

Claude UsageView의 세 한도(현재 세션, 전체 모델 주간, 모델별 주간)는 모든 pane에서 항상 보였다. pane별 표시 상태로 두면 같은 계정의 UsageView들이 서로 다른 요약을 보이고, 어느 행이 데이터 소스 설정인지 사용자가 예측하기 어렵다. 반대로 모든 행을 숨길 수 있으면 수요 기반 probe는 살아 있지만 view에는 아무 사용량도 남지 않는다.

범위는 Claude UsageView의 표시 선택과 좁은 폭에서의 문구 축약이다. probe 수집, 원시 스냅샷, API/MCP 계약, 갱신 주기는 바꾸지 않는다.

## Decision

**`usage.claude.visibleRows`는 모든 Claude UsageView가 공유하는 표시 행 설정이며, `session`·`weekAll`·`weekModel` 중 하나 이상을 항상 유지한다.**

- 기본값은 세 행 모두다. 설정 UI는 마지막 선택 행의 해제를 막고, 프론트 설정 로드는 비어 있거나 잘못된 값을 기본 세 행으로 정규화한다.
- view는 이 설정으로 행을 필터링하고, 남은 행 수로 column 배치의 최소 폭을 계산한다.
- 좁은 행에서는 제목을 `session`·`week (all)`·`week (<model>)`로, 상세 줄은 리셋 원문과 퍼센트만으로 축약한다. 충분한 폭에서는 기존의 전체 문구를 보인다.
- 낮은 pane은 사용량 막대와 제목을 시간선/elapsed 텍스트 크기까지 먼저 줄이고, 상세 텍스트를 감춘 뒤, 최저 높이에서 두 막대만 남긴다. 의미를 잃는 중간 말줄임표보다 정보 우선순위를 명시적으로 낮춘다.

## Alternatives Considered

- **pane별 override:** 자유 레이아웃에는 유연하지만 같은 계정의 pane마다 의미가 달라지고 영속 override가 늘어난다.
- **모든 행 숨김 허용:** 빈 view가 정상 상태처럼 보여 probe 상태와 표시의 관계가 불명확해진다.
- **CSS 말줄임표만 사용:** 어떤 값이 어떤 한도인지 사라져, 의미를 보존하는 명시적 축약보다 읽기 어렵다.

## Consequences

- Settings → Views → Usage에서 선택 하나로 모든 Claude UsageView가 즉시 갱신된다.
- 기존 설정에는 필드가 없으므로 기본 세 행이 적용된다. 빈 배열은 유지하지 않고 기본값으로 복원한다.
- 새 에이전트 사용량을 추가할 때는 그 에이전트의 행 식별자와 기본 선택을 별도로 정한다.
