# 0362. 훅 기반 activity와 대상별 분산 fallback

- Status: Proposed
- Date: 2026-10-28
- Source: 사용자의 정상 훅 pane 검사 제외·저빈도 분산 fallback·진입/종료 의심 대상 확인 요청, [ADR-0360](0360-unknown-activity-and-event-recovery.md), [data-flow.md §9](../architecture/data-flow.md)
- Amends: ADR-0135의 3초 전체 재판정, ADR-0134의 WSL 표시 생존 관측, ADR-0360의 고정 cadence 및 관측 보정 방식. checkpoint와 입력 권한의 fresh 증거 계약은 유지한다.

## Context

3초 activity 워커는 모든 pane을 판정하고 WSL 배포판마다 `/proc` 전체를 읽는다. 훅 조회도 2초마다 전체 대화 귀속을 두 번 검증한다. 따라서 훅이 정상이어도 반복 게스트 실행이 계속된다. 기본 WSL 배포판의 60초 캐시 만료는 별도의 `wsl --list --quiet` 실행을 추가한다. 관측 비용을 없애지 않고 UI 발행량만 줄여서는 사용자 제보의 집중 부하를 해결하지 못한다.

훅은 heartbeat가 아니며 강제 종료 때 SessionEnd가 없을 수 있다. 보고된 terminal ID·token만으로 귀속을 인정하면 공유 서버·재부착·이전 세대·subagent가 다른 pane의 작업을 덮을 수 있다. 표시의 마지막 증거와 입력 직전의 새 증거를 구분해야 한다.

## Decision

**activity는 훅과 실제 lifecycle/진입 이벤트로 요청한 대상만 재판정하고, 훅 관측이 없는 대상만 저빈도로 분산 확인한다.**

- 3초 전체 프로세스 검사와 동시 전체 fallback을 제거한다. PTY 생성·새 제목/명령·종료 의심·pane/workspace 진입은 해당 세대의 대상 요청을 합친다. 이벤트 없이 전체 pane을 재발행하지 않는다.
- 훅 귀속은 최초에 기존 exact 대화·프로세스·domain·generation 검증으로 확정한다. 재사용은 같은 세대·앱 epoch·대화·설정 루트·domain·검증된 root PID/생성 식별자(Windows 생성 시각, Linux/WSL 커널 tick)에 한정한다. 새 root/대화·collision·SessionEnd·세대 교체는 재검증한다. 원시 훅 보고만으로 소유권을 만들지 않는다.
- 정상 훅의 같은 root를 증명하는 새 이벤트는 프로세스 전체 열거 없이 표시 증거를 갱신한다. 반복 조회는 검증 시각을 갱신하지 않는다. snapshot의 `verifiedAtMs`로 기존 6초 작업 확인 lease를 보존하며, 오래된 안정 상태 표시는 마지막 상태로 남아도 새 유휴 근거로 사용하지 않는다.
- clear 등 입력은 대상의 fresh 귀속·생존·작업 상태를 확인한 뒤 수행한다. close/update checkpoint의 StartedAfter·세대·receipt 검증은 기존 경로를 유지한다. 표시 캐시가 입력 권한이나 복원점의 증거가 되지 않는다.
- 훅 미설치·관측 단절·재부착 초기의 fallback은 배포판/호스트 단위로 분산한다. WSL 한 배포판의 전체 프로세스 스캔을 pane 수만큼 반복하지 않는다. 요청 대상의 결과만 갱신하고 실패를 부재로 바꾸지 않는다. timeout 이후 즉시 전체 재실행하는 catch-up도 하지 않는다.
- WSL 생존 캐시는 대상별 관측 시각과 세대에 결부한다. 일부 대상의 갱신이 다른 pane의 오래된 결과를 새 것으로 만들지 않는다. 오래된 음성은 Unknown으로 열화하고, 표시 fallback의 느린 cadence를 맞추기 위해 제어용 음성 수명을 연장하지 않는다.
- WSL 기본 배포판은 Windows의 Lxss 기본값 metadata로 해석해 60초 TTL을 이유로 `wsl.exe`를 주기 실행하지 않는다. 명시적 배포판과 잘못된 설정의 fail-closed 규칙은 유지한다.

일반 Codex 턴·Claude/Grok 기록 조회는 이미 관측한 프로세스 귀속과 현재 기록 파일을 읽는다. 표시 조회의 캐시 부재·만료는 새 OS/게스트 스캔을 시작하지 않는다. 대상별 worker가 `StartedAfter` 관측으로 귀속과 진단을 확보한다. WSL 표시 캐시는 해당 terminal 세대를 포함한 실제 관측의 결과만 읽고, 부분 갱신이 다른 terminal의 시각을 갱신하지 않는다. native 표시는 세대·앱 epoch·명령 경계·대화 제목이 일치하는 관측만 사용한다. 저장 수명은 제어용 생존/유휴 권한의 수명이 아니다.

`begin_agent_clear`는 표시 캐시와 별개로 요청 이후 시작한 해당 terminal의 실제 에이전트 귀속을 확인한다. 확인 중 입력 revision이나 세대가 달라지면 입력을 거절한다. 훅 작업의 확인이 오래되면 마지막 상태를 stale로 보존하며, 명시적 clear는 필요한 대상만 재확인한 뒤 기존 6초 입력 lease를 적용한다.

producer와 PTY의 실제 TUI owner를 분리한다. 최초 귀속은 실제 owner PID/생성 식별자를 검증한다. 같은 producer의 새 훅은 작업 상태를 갱신하지만, 이벤트 조상에 같은 owner가 있을 때만 owner 생존 확인 시각을 갱신한다. 공유 app-server처럼 owner 조상이 없는 경로는 저빈도 대상 관측을 유지하며 서버 자체를 TUI owner로 취급하지 않는다.

## Alternatives Considered

- 주기 숫자만 늘리기: 훅 조회의 반복 귀속 검증과 WSL 신선도 결합을 남기고 전체 동시 작업도 유지하므로 기각한다.
- 모든 관측 제거: 훅 없는 앱·강제 종료·재부착을 놓치므로 기각한다.
- 훅의 terminal ID만 신뢰: 공유 서버·이전 세대·subagent 귀속 보호를 깨뜨리므로 기각한다.
- 캐시 응답 때마다 확인 lease 갱신: 새 증거 없이 작업 유휴를 연장하므로 기각한다.

Linux/WSL의 절대 생성 시각은 guest 시간 보정으로 변할 수 있으므로 helper가 커널의 생성 tick을 선택적으로 전송한다. 최초 연결은 실제 PID/tick과 대조한다. 같은 root의 새 실제 이벤트는 UI 표시 모드와 무관하게 캐시를 갱신하며, 캐시 보관 연장은 관측 시각이나 입력 lease를 갱신하지 않는다. 일반 작업 phase 훅은 저장 checkpoint를 요청하지 않고 새 대화/root·SessionStart/End만 identity 힌트를 보낸다. 명시적 진입 요청은 값이 같아도 해당 대상 결과를 재발행한다.

## Consequences

정상 훅 pane의 반복 전체 스캔을 없애고 관측 단절 대상의 비용을 분산한다. 강제 종료처럼 이벤트가 없는 경우의 복구는 저빈도 fallback까지 늦어질 수 있다. 관측 실패 동안 마지막 앱/상태를 보존하는 정책과 unknown 입력 거절은 유지한다. 정상 훅·장시간 유휴·훅 누락·강제 종료·재부착·handover·세대 교체·다중 배포판에서 실제 프로브 횟수와 복구 지연을 dev에서 측정한다. 공개 snapshot의 선택적 검증 시각 확장과 정확한 scheduling 상수는 living doc에서 관리한다.
