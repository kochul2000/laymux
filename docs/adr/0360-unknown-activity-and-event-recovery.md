# 0360. 미관측 activity는 셸이 아니며 전체 복구 sweep을 하지 않는다

- Status: Proposed
- Date: 2026-10-27
- Source: 사용자 요청(60초 일괄 검사 제거, 감지 실패의 shell 판정 금지, 에이전트 종료 지연), [data-flow.md §9](../architecture/data-flow.md), [ADR-0005](0005-display-state-raw-separation-compute.md), ADR-0009, ADR-0135, ADR-0358, ADR-0359
- Amends: ADR-0009의 미관측 시 제목 종료 fallback, ADR-0135의 전체 재발행, ADR-0358의 주기적 전체 작업 재조회, ADR-0359의 미관측 기본 판정.

## Context

버퍼 없음·빈 출력·lifecycle 부재는 셸 프롬프트를 관측했다는 뜻이 아니다. 그런데 이 경우 shell을 기본값으로 반환하고 UI도 미설정을 shell로 표시한다. 이 판정은 자동 CWD 전파와 clear 같은 입력 정책에도 전달된다. 지원 에이전트 부재가 확인돼도 과거 제목·배너와 grace가 앱 표시를 붙잡아 종료 전환을 늦추기도 한다.

60초마다 전체 activity 재발행과 전체 작업 재조회가 독립적으로 일어난다. 사용자는 이 집중 작업을 없애도록 요청했다. 다만 출력 없이 끝나는 프로세스는 제목 이벤트만으로 감지할 수 없고 WSL의 음성 관측은 제한된 신선도를 갖는다.

## Decision

**관측 근거가 없으면 activity는 unknown이며, 복구는 진입 이벤트와 기존 변경분 감지로 수행하고 60초 전체 sweep을 제거한다.**

- Rust activity와 기존 API·IPC의 tagged union에 `unknown`을 추가한다. 누락·빈 버퍼·읽기 실패·일반 텍스트만으로 shell이나 running을 만들지 않는다. 셸 prompt/종료는 OSC 133 A/B/D, 명령 실행은 C의 순서로 판정한다. 지원하지 않는 셸 통합은 미확인으로 남는다.
- 프로세스로 확인된 지원 앱은 출력보다 우선한다. 신선한 `NoneAlive`는 지원 에이전트의 과거 제목·배너·grace보다 우선하되, 그 자체를 셸 유휴 근거로 사용하지 않는다. 다른 TUI 식별은 유지한다.
- unknown은 에이전트 종료·자동 입력 허가의 근거가 아니다. 기존 ADR-0359의 마지막 앱 기준 보존과 세대·epoch 보호를 유지한다. 이미 확인한 앱의 일시적 미관측은 라벨만 유지할 수 있으며, 초기 미관측과 API의 실제 판정은 unknown이다. task의 unknown/stale 보호와 clear의 독립 관측 조건을 완화하지 않는다.
- PTY 제목 상태머신도 같은 종료 증거 조건을 사용한다. `Unknown`·`Ambiguous`에서는 제목 reset에 따른 앱 종료·작업 완료·종료 정리로 인한 live 제목 삭제를 보류한다. 실제 OSC의 식별자 변경/소실은 기존 live 제목 계약대로 반영한다. frontend의 자식 명령 종료 코드도 에이전트를 shell로 바꾸지 않는다. 실제 앱 종료는 확인된 프로세스 부재/handover와 이후 셸 lifecycle로 수렴한다. 전체 재발행에 의존하던 frontend의 독자적인 shell 강등을 제거한다.
- 60초 전체 activity 재발행과 전체 task 재조회 타이머를 제거한다. 3초 프로세스 생존 감지와 변경된 pane만 발행하는 경로는 유지한다. 최초 task 복구·foreground 복귀는 현재 workspace만, pane focus·준비는 해당 pane만 조회한다. 기존 진행 중 작업의 provider 구독 주기는 유지한다.
- UI는 미설정/unknown을 `unknown`으로 표시한다. unknown 대상 clear는 busy 정책과 관계없이 `stateUnknown`으로 거절한다. backend 자동 CWD 전파·MCP shell 실행도 unknown을 거절한다.

## Alternatives Considered

- 모든 주기 관측 제거: 조용한 종료를 놓치고 WSL 음성 캐시의 신선도 계약을 깨뜨리므로 이번 범위에서는 선택하지 않는다.
- shell 기본값과 이전 전체 재발행 유지: 증거 부재를 유휴 입력 허가로 바꾸고 사용자 요청에도 어긋나므로 기각한다.
- 지원 프로세스가 없으면 곧바로 shell: 임의 명령 실행과 미통합 셸을 구분하지 못하므로 기각한다.
- 미관측 때 기존 에이전트 상태 삭제: live 제목과 작업 귀속을 잃는 ADR-0359의 회귀를 재발시키므로 기각한다.

## Consequences

미관측 pane의 셸 오판과 60초 동시 복구 부하를 제거한다. 확인된 종료는 grace 만료를 기다리지 않는다. OSC 통합이 없는 pane은 미확인으로 보일 수 있고 자동 CWD/clear도 보수적으로 거절한다. 마지막 앱 라벨 보존은 생존 확인이 아니며 프로세스 조회 자체의 실패 원인을 해결했다는 의미도 아니다.

API 소비자는 새 unknown 값을 처리해야 한다. 기존 응답 구조와 인증·포트는 유지한다. unit 테스트와 Windows·WSL dev PTY에서 미관측, 복구, 60초 경계, 실제 종료 지연을 검증한다. 앱/작업 관측을 다시 합치거나 주기를 완전히 없앨 때는 새 결정을 기록한다.
