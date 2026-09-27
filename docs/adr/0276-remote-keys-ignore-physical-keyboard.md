# 0276. Remote Keys 표시는 물리 키보드 연결과 독립으로 둔다

- Status: Accepted
- Date: 2026-09-27
- Source: 사용자 요구(`Hide Keys with physical keyboard` 제거), [ADR-0273](0273-remote-physical-keyboard-and-navigation-keys.md), [api-contracts.md §13.4](../architecture/api-contracts.md)
- Supersedes in part: ADR-0273의 Keys 자동 숨김과 해당 기기 설정 노출. 물리 키보드 감지·플로팅 자동 숨김·Nav 정책은 유지한다.

## Context

물리 키보드 연결 시 기본 활성인 Keys 자동 숨김이 Keys 행과 토글을 함께 숨긴다. 사용자는 이 옵션이 불필요하므로 제거하기를 요청했다. 설정 화면뿐 아니라 기기 저장값과 Remote settings MCP에도 같은 설정이 노출되어 있어 표시만 지우면 자동 숨김이 계속 적용된다.

## Decision

**Keys 행과 토글은 기존 배치·펼침 설정으로 표시하며 물리 키보드 연결 여부로 숨기지 않는다.**

- `hideKeysWithKeyboard`를 설정 UI, 기기 설정 목록, Remote settings MCP 스키마에서 제거한다. 해당 필드를 보내는 설정 요청은 기존 미지원 필드 검증으로 거부한다.
- 이전 localStorage 값은 읽거나 적용하지 않는다. 기존 배치·활성·펼침 값은 변경하지 않으며 저장소 마이그레이션은 추가하지 않는다.
- 기본 true인 `hideFloatingWithKeyboard`는 유지한다. 플로팅 Keys 버튼도 다른 플로팅 컨트롤과 같은 전체 표시 조건을 따른다.
- 물리 키보드 감지, 연결·해제 토스트, Nav 단축키, 입력 포커스 복구의 계약은 변경하지 않는다.

## Alternatives Considered

- 기본값만 false로 변경: 기존 저장값이 true인 기기에서는 계속 숨겨지고 불필요한 옵션도 남는다.
- 체크박스만 제거: 이전 저장값 또는 MCP 설정으로 사용자가 해제할 수 없는 숨김이 생길 수 있어 설정과 표시 조건을 함께 제거한다.

## Consequences

물리 키보드가 연결되어도 Keys를 터치해 사용할 수 있으며 사용자가 접은 행은 그대로 접혀 있다. Keys 자동 숨김을 사용했던 기기는 수동으로 행을 접어야 한다. 갱신 전 MCP 클라이언트가 삭제된 필드를 보내면 스키마를 다시 조회해야 한다. Android native 변경이나 새 APK는 필요하지 않다.

기존 저장값이 있는 연결 상태, 연결·해제, 사용자 펼침 상태 보존, 플로팅 설정 유지와 삭제 필드 거부를 테스트한다. 이후 Keys 표시 정책을 바꾸려면 수동 배치·펼침과의 관계를 다시 검토한다.
