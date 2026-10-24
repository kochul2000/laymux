# 0355. 검증된 에이전트 종료 훅을 유지하고 실제 클리어 전에 입력창을 비운다

- Status: Accepted
- Date: 2026-10-24
- Source: 사용자 요구(Codex 성공·타이핑 활동 오인과 Alt+L 실패 수정), dev Codex 0.163.0·Claude 2.1.309 실측, ADR-0284, ADR-0250, ADR-0158, ADR-0340
- 관계: ADR-0284의 유휴·종료 phase 만료와 ADR-0158의 초안 미관측 위험을 일부 대체한다.

## Context

Codex 작업 기록의 성공이 결과 없는 Stop 훅에 가려진다. 또한 사용자 타이핑이 출력 활동의 프레임 임계를 넘고, 작업 미확인 구간의 모래시계가 된다. 작업이 끝나도 훅 phase가 60초에 만료되어 미확인 상태로 돌아갈 수 있다. Alt+L은 두 CLI의 초안 뒤에 `/clear`를 붙여 일반 질문으로 제출한다.

훅은 프로세스와 현재 대화의 귀속을 증명한 snapshot만 사용할 수 있다. Stop만으로 성공을 합성하거나 지난 턴의 성공을 현재 턴에 옮겨서는 안 된다. 사용자 설정·다른 에이전트와 workspace Ctrl+L의 의미는 유지한다. Grok은 별도 PR에서 조사·수정한다.

## Decision

**현재 대화가 계속 검증되는 유휴·종료 훅은 시간만으로 폐기하지 않고, Codex의 동일 턴 기록으로 종료 결과를 보완하며, Codex·Claude 실제 클리어는 화면으로 입력창을 검증하고 초안을 삭제한 뒤 실행한다.**

- 유휴·종료 관찰의 수명과 현재 귀속 검증의 수명을 분리한다. 현재 PTY·프로세스·대화·설치 상태와 6초 검증 lease는 계속 필요하다. 진행·승인 대기는 기존 60초 phase 기한을 유지한다. 새 입력·대화 전환·세대 교체·조회 실패는 이전 훅 우선권을 잃게 한다.
- Codex 종료 훅의 결과가 없으면 동일 generation·session ID·turn ID의 확정된 rollout 결과만 반영한다. 다른 턴·대화·미확인 기록과 명시적인 실패·중단은 덮어쓰지 않는다. 원시 기록과 훅은 분리하며 선택 함수만 결과를 합친다.
- Codex·Claude의 작업 표시는 출력량·프레임 신호로 작업 미확인을 진행 중으로 승격하지 않는다. 원시 출력 활동은 진단에 보존하고 일반 셸·Grok의 기존 fallback은 유지한다.
- 단일 pane clear는 Codex·Claude의 현재 viewport에서 지원하는 텍스트 입력창을 확인한다. 초안은 제한된 Backspace/Delete 배치로 지우고 빈 입력창을 확인한 뒤 `/clear`를 제출한다. 확인할 수 없는 화면·모달·지원하지 않는 편집 모드·삭제 한도·시간 초과·PTY 교체는 실패로 반환하며 slash 명령을 제출하지 않는다. 기존 busy 정책과 Remote 입력 소유권을 유지한다.
- interrupt 정책은 남은 clear 기한 안에서 확인된 idle/ended 관찰을 기다린 뒤 입력창을 검사한다. 화면의 과거 응답이나 초안 문구를 편집 모드로 해석하지 않고 현재 입력창과 footer를 구분하며, 모든 연속·줄바꿈 행이 비었는지 확인한다.
- 입력 revision 비교·증가와 FIFO enqueue는 `PtyHandle`의 공유 leaf 게이트 안에서 한 연산으로 실행한다. human-control 게이트 밖에서 직접 쓰는 Automation·MCP도 같은 PTY 게이트를 거친다. 게이트 안에서는 AppState 락이나 물리 I/O 완료를 기다리지 않는다.
- 삭제와 제출 사이에는 generation·앱 epoch와 작업 상태를 재검사하며 terminal별 clear 중복 실행을 막는다. Rust가 발급한 generation·입력 revision을 각 삭제·제출 시 기존 human-control enqueue 게이트 안에서 비교한다. 자신의 삭제로 증가한 revision만 다음 요청에 전달하고, Local·Remote·Automation 입력이 끼어들면 화면 갱신 전이라도 후속 clear를 거부한다. 새 IPC는 고정된 삭제 배치와 `/clear` 제출만 허용하며 Remote lease와 PTY FIFO의 기존 소유권·실패 처리를 공유한다. Automation의 기존 hard deadline 뒤에 새 입력을 보내지 않는다. 결과는 기존 failed 배열로 설명한다.

## Alternatives Considered

- 모든 phase를 무기한 유지: Stop 누락 시 진행 상태가 고정된다. 안정된 유휴·종료만 재검증 수명으로 바꾼다.
- Stop을 성공으로 간주: 다른 훅의 중단·실패와 미관측 결과를 숨긴다. 동일 턴의 기록이 필요하다.
- 현재 세션의 마지막 성공을 무조건 복사: 다음 턴 종료와 이전 기록의 지연 관측을 혼동한다.
- clear 전에 Ctrl+C를 항상 전송: 작업을 중단하거나 사용자의 직전 Ctrl+C와 합쳐 CLI를 종료할 수 있다.
- Ctrl+U만 전송: 커서 뒤의 텍스트와 여러 줄 초안을 완전히 지웠음을 보장하지 않는다.

## Consequences

유휴 상태가 시간만으로 미확인이 되지 않고, 타이핑이 작업 표시를 켜지 않으며 초안이 의도하지 않은 질문으로 제출되지 않는다. 화면을 검사할 수 없는 숨김 pane이나 지원하지 않는 편집 화면의 clear는 보수적으로 실패할 수 있다. 검사·삭제에 제한된 추가 지연이 생긴다. Windows·WSL의 실제 CLI와 셀 격자 테스트, 현재 턴·다른 턴·늦은 관측·모달·여러 줄 초안·deadline·세대 교체 회귀를 검증한다. CLI가 입력창 형식이나 구조화된 new-chat API를 바꾸면 이 결정을 재검토한다.
