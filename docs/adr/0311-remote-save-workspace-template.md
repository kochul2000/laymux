# 0311. Remote는 지정한 워크스페이스를 전환 없이 새 템플릿으로 저장한다

- Status: Proposed
- Date: 2026-10-10
- Source: 사용자 후속 요청(리모트 워크스페이스 템플릿 추가), ADR-0310, architecture/overview.md §4.1, architecture/api-contracts.md §13.3
- Relationship: ADR-0310 관리 메뉴를 템플릿 저장으로 확장한다. ADR-0297의 슬롯·레이어 복사와 ADR-0299의 템플릿 영속 소유권은 유지한다.

## Context

Remote는 호스트 템플릿 목록에서 워크스페이스를 만들 수 있지만 새 템플릿을 저장할 수 없다. 기존 내보내기는 활성 workspace를 읽으므로 비활성 행에서 저장하려고 임시 전환하면 사용 중인 터미널과 호스트의 활성 문맥이 바뀐다. 새 템플릿 추가만 제공하며 기존 템플릿 덮어쓰기·삭제와 Remote 격자 편집은 범위 밖이다.

## Decision

**Remote 관리 메뉴는 명시적으로 지정한 workspace를 활성 전환 없이 새 이름의 템플릿으로 저장한다.**

`POST /remote/v1/layouts`는 `{workspaceId,name,leaseId?}`를 받고 기존 Remote 인증과 active controller lease를 요구한다. workspace id와 공백뿐인 이름을 거부한다. 호스트 bridge는 대상 존재를 확인하고 workspace store의 기존 내보내기 함수를 명시적 source id로 호출한다. source가 없어졌다면 활성 workspace로 대체하지 않는다. source id 없는 기존 desktop 내보내기는 활성 workspace를 사용한다.

템플릿의 SoT와 영속은 기존 호스트 store·저장 경로다. 기존 복사 함수로 슬롯 비율·레이어·view 설정을 보존하며 에이전트 대화 복원 소유권은 복사하지 않는다. 기존 템플릿을 덮어쓰지 않고 새 id를 생성한다. 성공 시 Remote는 템플릿 목록만 다시 읽고 현재 terminal output과 active workspace를 유지한다. 오류는 입력창에 남기며 Android E2E exact allowlist는 동일 POST만 추가한다.

## Alternatives Considered

- 저장 전에 source workspace로 전환: 사용자 문맥과 활성 terminal을 바꾸므로 제외한다.
- Remote가 pane JSON을 작성해 업로드: 호스트 구조·복사 정책을 복제하고 오래된 snapshot을 저장하므로 제외한다.
- Remote에 별도 템플릿 저장소: 데스크톱 템플릿 목록과 영속이 어긋나므로 제외한다.

## Consequences

사용자는 활성·비활성 workspace의 현재 구성을 관리 메뉴에서 재사용 가능한 템플릿으로 저장할 수 있다. 내보내기 함수에 선택적 source id와 성공 여부 반환이 추가되지만 기존 호출 방식은 유지한다. source 소실·비활성 source·레이어 및 복원 소유권 복사·영속·목록 갱신·lease·오류 보존 검증이 필요하다. 별도 데이터 마이그레이션은 없으며 Remote UI와 호스트 재빌드가 필요하다.
