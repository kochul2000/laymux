# 0344. 워크트리 관리는 Remote 도구로 제공하고 MCP는 laymux 고유 사용 관측만 제공한다

- Status: Proposed
- Date: 2026-10-19
- Source: 사용자 요청(Remote 워크트리 도구, Git으로 알 수 없는 laymux 정보만 MCP 제공, 독립 화면 사용 후 UX/UI 피드백 보고), ADR-0343, architecture/api-contracts.md §12·§15
- 관계: ADR-0343의 Desktop/Automation 계약을 Remote로 확장하며 MCP 범위에 읽기 전용 사용 관측을 추가한다.

## Context

데스크톱의 워크트리 목록·검사·제거는 Remote에서도 필요하다. 별도 Remote 구현이 Git 판단이나 보호 정책을 복제하면 파일과 사용 중인 터미널을 보호하는 기준이 달라질 수 있다. Remote는 인증된 연결과 활성 제어권, 현재 선택한 터미널을 기준으로 작업하므로 대상 터미널이나 CWD가 바뀐 뒤 이전 검사로 제거해서도 안 된다.

에이전트는 Git 명령으로 목록·변경·병합 여부를 조사하고 워크트리를 제거할 수 있다. 반면 실행 중인 터미널, 숨은 복원 대상, 분리된 PTY, 관측 실패는 laymux 내부 상태다. MCP는 이 정보에만 가치를 더한다. 이번 범위는 Remote 도구와 관측 MCP이며 강제 제거·브랜치 삭제·일괄 정리·자동 병합 판정은 포함하지 않는다.

## Decision

**Remote는 기존 워크트리 공통 서비스에 인증·제어권·현재 터미널 검증을 더하고, MCP는 `get_worktree_usage` 읽기 전용 관측 하나만 제공한다.**

- Git 상태와 제거 가능 여부의 소유권은 ADR-0343의 공통 서비스에 둔다. Remote에 새 Git 실행 경로나 삭제 정책을 만들지 않는다.
- Remote 목록·검사·제거는 활성 lease를 요구하며 서버가 현재 terminal registry의 CWD와 실행 환경으로 저장소를 확정한다. 검사·제거의 요청 CWD가 현재 값과 다르면 거부한다. 클라이언트가 임의 `workingDir`나 `force`를 전달해 우회할 수 없다.
- 제거는 Remote의 기존 non-PTY lease mutation barrier를 blocking worker가 Git 작업 종료까지 보유한다. 제어권 회수는 이미 승인된 작업이 끝나기를 기다린다. 파일·HEAD·laymux 사용 정보는 실행 직전 공통 서비스가 다시 검사한다.
- 브라우저·PWA·Android E2E는 같은 Remote route를 사용한다. E2E의 허용 경로에는 명시적인 세 경로만 추가한다. 기존 인증, IP·origin 정책과 제어권 소유자는 바꾸지 않는다.
- Remote 도구는 현재 terminal을 기준으로 목록·정리 후보·최신 상세·파일 내용 열기·사용 연결·확인 후 제거를 제공한다. 연결이나 terminal이 바뀌면 이전 응답과 제거 확인을 무효화한다. 저장소 핀은 두지 않는다.
- Remote의 기존 도구 순환·표시 설정·컨트롤바 상하 배치를 따른다. 상태의 진실원은 각 기존 기능에 두고 새 controller는 표시와 요청 생명주기만 소유한다.
- MCP `get_worktree_usage({path})`는 명시적인 절대 경로를 같은 실행 환경에서 해석하고 `{path,scope,complete,usage,warnings}`를 반환한다. `scope`는 `current_build`이며 실행·저장·daemon 사용 정보의 소유권은 `worktree_usage`에 둔다.
- `complete=false` 또는 관측 경고를 미사용으로 해석하지 않는다. 사용 항목이 없더라도 앱 밖 프로세스의 미사용이나 Git 상태를 보증하지 않는다. MCP에는 제거 가능 판정이나 파일·Git 정보를 섞지 않는다.
- Git 목록·검사·제거용 MCP는 추가하지 않는다. 에이전트는 자신의 Git 도구를 사용하고 laymux 관측을 함께 확인한다.

## Alternatives Considered

- Git 명령을 그대로 감싼 관리 MCP: 기존 에이전트 도구와 중복되므로 제외한다.
- 기존 terminal/workspace MCP만 조합: 분리된 PTY의 관측 실패와 숨은 복원 참조를 일관된 디렉터리 경계·실행 환경으로 합성하기 어려워 사용 관측 하나를 제공한다.
- Remote가 Automation API를 직접 호출: Remote 인증·제어권·E2E의 경계를 우회하므로 기존 Remote route를 둔다.
- Remote 전용 Git 서비스: 데스크톱과 삭제 보호 기준이 갈라지므로 공통 서비스를 재사용한다.

## Consequences

사용자는 Remote에서도 워크트리를 관리하고 에이전트는 Git만으로 얻지 못하는 연결 상태를 조회할 수 있다. Remote route·E2E 허용 목록·기기 설정 스키마·도구 순환·생성 번들을 함께 유지해야 한다. 사용 정보가 불완전하면 제거가 차단되는 보수적 정책과 동시 파일 변경을 완전히 원자적으로 막을 수 없는 한계는 유지한다.

TDD로 제어권·현재 CWD·늦은 응답·보호·확인 제거를 검증하고 dev에서 실제 파일과 모바일 화면으로 확인한다. 독립 에이전트가 실제 화면을 사용한 UX/UI 피드백은 사용자에게 보고하며 자동 반영하지 않는다. 호환되는 기능 추가이므로 버전 영향은 minor다.
