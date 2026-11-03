# 0370. Pane 식별자 링크는 PC와 Remote가 같은 규칙으로 해석한다

- Status: Accepted
- Date: 2026-11-03
- Source: 사용자 요구(터미널 출력의 pane 참조 밑줄·이동·포커스, 설정 토글 기본 켬), [ADR-0007](0007-pane-identifier-trio.md), [ADR-0081](0081-pane-focus-transition-single-owner.md), architecture/data-flow.md §8.6

## Context

에이전트가 출력한 리뷰어 표에는 터미널 ID와 배지에서 복사한 사람이 읽는 참조가 함께 등장한다. 현재는 이를 복사한 뒤 별도로 pane을 찾아야 한다. PC와 Remote가 서로 다른 정규식이나 번호 계산을 쓰면 같은 출력이 다른 대상으로 이동할 수 있다. 기존 URL·OSC 8 링크와 파일 경로의 소유권도 보존해야 한다.

## Decision

**Pane 참조 탐지·셀 좌표 계산·대상 해석을 공유하고, 탐색 실행은 각 표면의 기존 포커스 경로가 소유한다.**

- `lx:pane:<workspaceName>:<paneNumber>`, `terminal-pane-<uuid8>`, `pane-<uuid8>`를 독립 토큰으로 인식한다. 짧은 해시·숫자·URL/파일 경로에 포함된 부분 문자열은 인식하지 않는다. OSC 8과 URL이 우선한다.
- locator는 마지막 콜론 기준으로 분리하고 현재 레이아웃의 공간 번호를 사용한다. 같은 이름의 workspace가 여럿이면 모호한 locator를 링크하지 않는다. 문자열이나 셀에서 새로운 OSC 시퀀스를 파싱하지 않는다.
- 현재 레이아웃에서 확인된 터미널 레이어만 링크한다. 클릭 시 설정·화면·대상을 다시 검사한다. 삭제되거나 닫는 중인 대상은 이동하지 않는다. 화면의 자동 줄바꿈은 연결하지만 실제 개행을 임의로 이어 붙이지 않는다.
- PC는 기존 레이어 활성화·pane 포커스 전환을 사용한다. Remote는 기존 terminal 선택·host focus·출력 attach 경로와 lease 정책을 사용한다. 숨은 스택 레이어도 정확한 ID로 선택한다.
- `terminal.paneLinkEnabled: boolean`은 기본 true이며 PC 설정 UI에서 편집한다. 호스트가 단일 정본이고 navigation payload와 기존 성공 heartbeat로 Remote에 전달한다. drawer가 닫혀 있어도 다음 heartbeat에 토글을 반영한다. false이면 밑줄과 클릭을 함께 해제한다. URL/파일 액션 칩 설정은 pane 탐색과 독립이다.
- 보이는 링크는 hover 없이도 밑줄을 표시하여 터치에서도 발견할 수 있게 한다. 셀 범위는 공용 Unicode 셀 매핑을 사용한다.
- Workspace 이름은 공백 정규화 계약만 따르며 괄호·쉼표 등 구두점을 제한하지 않는다. 실제 이름을 리터럴로 매칭해 구분자와 이름을 추측하지 않는다. Remote는 연결·페이지 표시·pane 링크 켬 동안 기존 2초 navigation 메타데이터 폴링을 drawer가 닫혀도 유지한다. 닫힌 drawer는 다시 렌더하지 않고 선택·출력 attach·포커스를 보존한다. 링크를 끄거나 연결·표시를 잃으면 drawer 전용 폴링으로 돌아간다.

## Alternatives Considered

- 해시만 탐지: 일반 출력·커밋 해시와 구분할 수 없어 기각한다.
- PC·Remote 별도 파서: 경계·와이드 문자·번호 해석이 갈라지므로 기각한다.
- 전용 URI를 OS 브라우저로 전달: 앱 내부 탐색을 외부 프로토콜 등록에 의존하게 하므로 기각한다.
- Remote 기기별 토글: 동일 출력의 인식 규칙이 달라지고 설정 정본이 중복되므로 기각한다.

## Consequences

새 pane을 사용자가 메뉴를 열기 전에 발견하는 대신, 링크가 켜진 연결 기기는 drawer가 닫혀 있어도 2초마다 기존 읽기 전용 navigation 요청을 보낸다. 토글·페이지 표시·lease로 이 비용을 제한한다.

PC와 Remote에서 표·괄호·백틱 안 참조를 직접 선택할 수 있다. 기본 켬인 호환 기능 추가로 버전 영향은 minor다. 설정 schema·설명·영속 기본값·navigation payload를 함께 갱신하며 별도 마이그레이션은 하지 않는다. 공간 번호는 과거 출력 시점의 영구 핸들이 아니므로 클릭 시점의 번호를 가리킨다. 순수 파서·실제 xterm 셀·설정 UI·Remote 브라우저 테스트로 비활성화, 오탐 방지, 재배치 및 포커스를 검증한다.
