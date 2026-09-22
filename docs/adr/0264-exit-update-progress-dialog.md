# 0264. 종료와 업데이트의 준비 단계를 공유하고 전용 진행 모달로 표시한다

- Status: Accepted
- Date: 2026-09-22
- Source: 사용자 UX 기획·구현 요청, ADR-0048, ADR-0174, ADR-0201, ADR-0222, architecture/data-flow.md §13
- 관계: ADR-0048의 선택적 인터럽트를 업데이트로 확장한다. critical checkpoint와 설치 전 자식 정리의 순서는 유지한다.

## Context

종료의 작업 정리는 화면 변화 없이 수 초 기다리게 한다. 업데이트는 Settings, 상단 버튼, Remote가 별도 확인 UI를 갖고 있으며 작업 정리 설정도 적용하지 않는다. 복원 정보는 인터럽트 전에 확정해야 하고 업데이트 실패 시 설치를 진행해서는 안 된다. 다운로드한 비율과 작업의 정상 종료 여부는 서로 다른 사실이다.

## Decision

종료와 업데이트는 같은 단계 표현과 준비 함수를 사용하고, 업데이트는 하나의 전용 모달에서 확인·실행·진행·실패를 표시한다.

- 업데이트의 SoT는 Rust UpdateManager다. downloading → preparing → installing을 사용하고 preparing의 checkpoint/interrupting/settling/caching 진행을 PC와 Remote에 공유한다. 종료의 화면 상태는 창 수명에 속하며 frontend가 소유한다.
- 다운로드·서명 검증 및 입력 drain 뒤 critical checkpoint를 먼저 commit한다. 그 뒤 저장된 종료 설정으로 선택적 Ctrl+C·출력 대기·출력 캐시를 완료하고 ACK한다. 마지막으로 기존 installer child/file-lock guard를 실행한다. 준비 중 일반 checkpoint는 마지막 복원점을 덮지 못한다.
- native update 요청 ID가 유효할 때만 frontend 준비 진행을 받는다. 업데이트 ACK 기한은 기존 20초에 준비를 위한 20초를 더한다. 실패 시 fence를 해제하고 실패 단계와 오류를 표시한다.
- 종료와 업데이트 설치 수락은 Rust manager에서 상호 배제한다. 중복 창 종료는 하나의 작업으로 합친다. 일반 종료의 저장 실패·지연은 자동 강제 종료 대신 사용자의 명시적 종료 선택을 기다린다.
- 백분율은 알려진 단계의 처리량/대기 시간에만 사용한다. Ctrl+C 전달을 작업 정상 종료 성공으로 표시하지 않는다. 전체 진행률을 임의로 합성하지 않는다.
- Settings는 채널·종료 설정과 업데이트 모달 진입점을 제공한다. 모달을 닫아도 Settings 초안은 유지한다. Remote는 host 채널을 변경하지 않고 기존 제어 lease로만 설치를 요청한다.
- Remote는 설치 상태 뒤의 단절을 재연결 대기로 표시하고 목표 실행 버전 확인 후 완료한다. 다른 단계의 단절은 오류로 표시한다. Android 앱 자체의 설치 경로는 변경하지 않는다.
- dev 전용 Automation preview는 실제 정리·설치 없이 같은 모달을 렌더한다. release에서는 거부하며 실제 업데이트 비활성 정책은 유지한다.

## Alternatives Considered

- 화면마다 독립 상태·모달 유지: 재연결 및 실패 표현이 다시 어긋나므로 기각한다.
- 프론트 타이머로 전체 0~100% 합성: 실제 저장·설치 성공과 관계없는 완료를 보여주므로 기각한다.
- 작업 정리 후 복원 정보 수집: 이미 종료된 에이전트의 식별 근거를 잃으므로 기각한다.
- 모든 수명주기를 Rust로 이전: xterm 직렬화는 WebView 소유이며 이번 범위를 넘는 이전 비용 때문에 기각한다.

## Consequences

내부 progress IPC와 Remote update snapshot이 확장된다. 업데이트 준비 중 화면을 유지할 시간이 늘고, 출력 캐시 실패도 설치 중단으로 이어질 수 있다. 체크포인트 ACK, 설정 on/off, 재진입, Remote 재연결 및 dev preview를 검증한다. OS 강제 종료와 외부 설치기 내부 진행률은 범위 밖이다. WebView 없이 업데이트를 수행할 필요가 생기면 준비 작업 소유권을 재검토한다.
