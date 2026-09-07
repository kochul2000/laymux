# 0236. Remote Composer 인라인 첨부 칩

- Status: Proposed
- Date: 2026-09-07
- Source: 사용자 합의(파일별 칩, Backspace/Delete 삭제, 제거 버튼·복원 단축키 없음), ADR-0029, ADR-0181, architecture/data-flow.md §8
- Relationship: ADR-0029의 Remote textarea 선택과 ADR-0181의 Composer 경로 표시를 확장한다.

## Context

첨부의 호스트 cache 경로가 초안에 길게 표시되어 문장 편집을 방해한다. 사용자는 파일 하나를 문장 속 한 요소로 보고 키보드로 삭제하기를 원한다. textarea는 편집 불가능한 인라인 요소를 담을 수 없다. 업로드·lease·Direct 입력 계약과 desktop Composer는 이번 범위 밖이다.

## Decision

Remote Composer는 네이티브 contenteditable에 텍스트와 편집 불가능한 파일별 칩을 담고, 전송 시 칩을 원래 경로로 직렬화한다.

- terminal별 runtime draft가 원문 text와 첨부 범위·파일명 metadata를 소유한다. DOM은 편집 중 이 상태를 갱신하며 terminal 전환 시 해당 draft에서 복원한다. 영속 저장은 추가하지 않는다.
- 파일 하나가 칩 하나다. 이미지에는 Image와 번호, 다른 파일에는 원래 파일명을 표시한다. 삭제 버튼은 두지 않는다. Backspace/Delete 및 선택 영역 삭제는 칩 전체를 제거한다. 브라우저 선택·한글 조합을 재구현하지 않고 칩 경계만 보정한다. 별도의 Ctrl+Z 바인딩이나 복원 기능을 만들지 않는다.
- 원래의 경로 quoting과 structured input 계약을 유지한다. 문자열로 직접 입력·붙여넣은 경로는 첨부로 추정하지 않는다. clipboard HTML은 수용하지 않는다.
- 전송 snapshot/revision, 실패 보존, 업로드 취소와 lease 검증을 유지한다. history에는 실제 전송된 원문만 남고 history recall은 일반 텍스트다.
- 칩 제거는 초안에서만 제거한다. 서버 cache 파일 수명은 기존 정리 정책을 따른다.

## Alternatives Considered

- textarea에 짧은 문자열만 삽입: 경로와 표시 문자열의 관계가 사라지고 부분 삭제가 가능하다.
- textarea 위에 칩을 겹쳐 그리기: 줄바꿈·폰트·선택 좌표를 두 렌더러가 맞춰야 하므로 제외한다.
- 별도 첨부 목록: 문장 속 커서 이동과 Backspace 삭제 요구를 충족하지 못한다.
- rich editor 의존성: 필요한 기능은 네이티브 선택과 non-editable span으로 충족한다.

## Consequences

경로 길이와 무관하게 파일 단위로 편집한다. contenteditable의 줄바꿈·clipboard·칩 경계·IME와 모바일 동작에 브라우저 회귀 검증이 필요하다. API나 설정 마이그레이션은 없다. 풍부한 편집·독자적인 undo 계약이 필요해질 때 editor 선택을 재검토한다.
