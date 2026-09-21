# 0260. Remote 메모는 PC 저장소를 공유하고 패널 진입점은 기기별로 선택한다

- Status: Accepted
- Date: 2026-09-21
- Source: 사용자 요구(Remote 메모 공유 및 우상단 아이콘별 표시 설정), [ADR-0257](0257-remote-github-view.md), [architecture/api-contracts.md](../architecture/api-contracts.md)
- Extends: ADR-0257의 우측 스와이프 대상과 기기 로컬 패널 설정

## Context

PC 메모는 pane별 키로 `cache/memo.json`에 저장되지만 Remote에서 읽거나 편집할 수 없다. 두 표면이 같은 메모를 편집하면 기존의 무조건 저장은 상대의 변경을 잃게 한다. 모바일 헤더에 진입점이 늘어나므로 사용자가 필요한 버튼만 남길 수 있어야 한다. 새 메모 pane 생성이나 협업용 실시간 병합은 범위 밖이다.

## Decision

**PC와 Remote는 같은 메모 키와 저장 파일을 사용하며, 이전에 읽은 내용과 현재 저장 내용이 같을 때만 변경을 저장한다. 패널 진입점 표시는 기기 로컬 설정이다.**

- Remote `GET /remote/v1/memos`는 저장된 메모 목록을 반환한다. 클라이언트는 navigation의 MemoView pane을 합쳐 아직 비어 있는 메모도 선택할 수 있다. `POST /remote/v1/memos`는 `{leaseId,key,content,expectedContent}`를 받는다. 기존 bearer/Origin gate에 더해 읽기·쓰기 모두 active lease를 요구한다. Android E2E는 이 두 exact route만 허용한다. 응답은 no-store다.
- 저장 비교와 파일 쓰기는 PC 저장과 같은 leaf `MEMO_LOCK` 안에서 수행한다. 임시 파일을 쓴 뒤 원자적 교체로 저장하며, 실패한 쓰기가 기존 파일을 잘라내지 않는다. 파일 읽기/파싱 실패는 빈 저장소로 취급하지 않는다. 내용 불일치는 Remote에서 409이며 기존 내용과 편집 초안을 모두 보존한다. PC 편집기도 동일한 비교 저장을 사용한다.
- PC의 자동 저장은 유지한다. Remote는 명시적 Save를 제공한다. 읽기 갱신은 저장되지 않은 초안을 덮어쓰지 않는다. 충돌 후에는 사용자가 초안을 보관하고 Reload로 최신본을 선택해야 한다. 메모 본문은 HTML로 실행하지 않는다.
- Remote Settings의 Panels 탭은 Files/GitHub/Memo/탐색 제외/PC 모드 버튼 표시와 우측 스와이프 대상을 소유한다. 표시 기본값은 모두 켜짐이며 실제 노출에는 기존 연결·가용성 조건도 필요하다. 설정은 기기 localStorage와 Remote settings MCP에만 속한다.
- `rightSwipeView`에 `memo`를 추가한다. 아이콘 숨김은 진입점의 표시만 바꾸며 스와이프 사용 가능 여부나 권한을 바꾸지 않는다. Memo overlay도 기존 Escape/Android back/닫기 스와이프 및 터미널 입력 차단 규칙을 따른다.

## Alternatives Considered

- Remote 전용 localStorage 메모: PC와 공유한다는 요구에 맞지 않는다.
- 마지막 저장 우선: PC의 지연 자동 저장이 Remote 변경을 조용히 덮어쓸 수 있어 기각한다.
- CRDT/실시간 병합: 단순 메모에 협업 프로토콜과 영속 revision을 도입하는 비용이 과도하다. 현재 내용 비교와 명시적 충돌 복구로 제한한다.
- 버튼을 숨기면 스와이프도 금지: 헤더 공간 절약이라는 목적과 모순된다.

## Consequences

- 메모 파일 형식과 키는 유지하므로 마이그레이션이 없다. 동시 편집은 사용자 해결이 필요하지만 무음 덮어쓰기를 방지한다.
- 메모 저장 비교·오류와 클라이언트 초안 상태를 테스트하고 Remote 설정 스키마·Android allowlist·living doc을 함께 갱신한다.
- PC 메모의 변경은 Remote가 새로 읽을 때 반영된다. 여러 사용자의 동시 협업 요구가 생기면 실시간 병합 여부를 다시 검토한다.
