# 0292. Codex 종료 복원점은 검증한 훅 대화 식별자를 우선한다

- Status: Accepted
- Date: 2026-10-06
- Source: 사용자 종료 시 `/status` 실패 제보와 훅 우선 요구, [ADR-0284](0284-codex-title-hook-binding.md), [ADR-0278](0278-codex-status-current-screen.md), architecture/data-flow.md §13.5
- 관계: ADR-0284의 훅 연결 사용 범위를 명시적인 종료·업데이트 checkpoint까지 확장한다. 일반 상태 감지와 일반 세션 귀속 계약은 유지한다.

## Context

훅 우선 상태 감지를 선택해도 종료 복원점은 별도 `/status` 입력으로 확보하고 있었다. 현재 대화의 식별자가 있어도 입력 초안을 삭제하고 화면을 확대하며, Codex가 같은 화면을 반복 출력하면 안정화 대기가 끝나지 않아 종료·업데이트가 막힌다. 작업 상태 이벤트의 60초 만료는 누락된 전이가 작업을 무기한 유지하지 않게 하는 정책이며 대화 ID의 유효 수명과 다르다. 공유 서버의 종속 pane ID와 토큰은 현재 TUI 소유권을 증명하지 않는다. 이번 결정은 명시적인 종료 복원점 검증에 한정한다.

## Decision

**훅 우선을 선택한 Codex의 종료·업데이트 checkpoint는 현재 TUI와 저장소에 연결된 훅 ID를 먼저 검증한다.**

- 기존 입력 fence와 drain 뒤 실제 Codex PID·시작 시각·저장소·PTY generation을 확인한다. 현재 live OSC 제목의 ID를 같은 배포판과 설정 루트의 유일한 최상위 훅 대화에 연결하고 관리된 제목 설정과 훅 설치를 확인한다. 프로세스 진단이 다른 대화를 확정하면 훅으로 덮어쓰지 않는다.
- 작업 phase의 만료와 대화 메타데이터 보존을 분리한다. 레지스트리는 기존 최대 256개 대화 한도를 유지하고 오래된 항목부터 퇴출한다. phase와 UI 검증 lease의 기존 만료를 유지한다. SessionEnd·subagent·중복 ID/설정 루트는 종료 증거로 사용하지 않는다.
- 훅 ID는 정확한 최상위 rollout 또는 rollout 없는 Fresh 검증을 통과해야 한다. checkpoint 토큰의 수명에서만 통합 귀속에 사용하고, 저장용 조회마다 프로세스·generation·제목 revision·현재 훅 연결·설치·rollout을 다시 확인한다. 기존 중복 소유권 검사와 이중 관측 barrier를 유지한다.
- 증거가 없거나 모호하면 기존 `/status` 경로를 사용한다. 훅으로 확인한 pane에는 입력·초안 삭제·화면 확대를 하지 않는다. `verifySessionOnExit=false`와 휴리스틱 모드의 정책을 유지한다. fallback 화면 안정화는 내용·generation·geometry로 판단하고 최신 출력 sequence는 backend 검증에 전달한다.

## Alternatives Considered

- 마지막 훅의 pane ID만 사용: 공유 서버와 새 PTY에서 이전 소유자를 지목하므로 거부한다.
- 최신 작업 phase만 사용: 60초 이상 쉬는 대화는 받은 식별자가 있어도 `/status`를 다시 요구한다.
- 설치만으로 `/status` 생략: 미수신·새 대화·충돌을 식별하지 못하므로 복원점이 안전하지 않다.
- `/status` 안정화만 수정: 선택한 훅 연결을 종료에 쓰지 못하고 초안 삭제와 화면 조작을 계속 요구한다.

## Consequences

검증한 훅이 있는 pane은 입력 초안을 보존하면서 종료 복원점을 확보한다. 메타데이터를 phase보다 오래 보관하고 종료 때 추가 검증하는 비용이 있다. 한도 초과 퇴출·제목 형식 변경·설치 제거·충돌·미수신에는 `/status`가 필요하다. 기존 설정과 외부 이벤트 payload는 바뀌지 않아 마이그레이션은 없다. Windows·WSL에서 phase 만료 후 종료, 새 대화/resume·공유 서버·PTY 교체·훅 제거·중복 ID와 fallback을 검증한다. 제목이나 훅 ID 계약이 바뀌면 이 연결 정책을 재검토한다. 기존 훅 우선 선택과 종료 복원점 실패를 수정하는 patch다.
