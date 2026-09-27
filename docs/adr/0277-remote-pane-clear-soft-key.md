# 0277. Remote 기본 클리어 키는 pane clear action을 실행한다

- Status: Accepted
- Date: 2026-09-27
- Source: 사용자 요구(Remote Add keys에 Alt+L 추가, 기본 `/clr` 교체), [ADR-0265](0265-pc-remote-first-use-defaults.md), [ADR-0269](0269-remote-physical-keyboard-shortcuts.md), [ADR-0271](0271-remote-requested-desktop-writes-carry-lease.md), [api-contracts §13.4](../architecture/api-contracts.md#134-terminal-control)
- Amends: ADR-0265의 기본 `/clr` 사용자 키 결정. 나머지 첫 사용 기본값과 저장값 우선 정책은 유지한다.

## Context

기본 `/clr` 사용자 키는 현재 활동과 무관하게 `/clear`를 제출한다. shell에는 잘못된 명령이고, 에이전트에서도 pane clear의 busy 정책을 거치지 않는다. Remote 물리 Alt+L은 이미 기존 pane clear API와 데스크톱 실행기를 사용하지만 Add keys에는 이 action이 없다.

## Decision

**Remote Add keys에 내장 `soft:clearPane`을 제공하고, 새 기기의 Main 행에서 `/clr`을 `Alt+L` pane clear action으로 교체한다.**

- label은 `Alt+L`, 설명은 `Alt+L (clear pane)`이며 Add keys의 Pane actions에서 배치한다. 바이트 조합키가 아니라 `pane.clearTerminal`과 같은 action이다. 물리 키 재바인딩은 action의 의미를 바꾸지 않는다.
- 기존 물리 Alt+L과 같은 navigation queue와 `runRemoteClear("pane")`를 사용한다. 진행 중인 pane 이동 뒤에는 이동이 완료된 pane을 클리어한다. lease 검사, activity·busy 정책, 오류·skip 표시는 ADR-0269·0271·0158의 경로가 소유한다. 새 API나 IPC는 만들지 않는다.
- Main 왼쪽 기본값은 `^C · Q · Esc · Alt+L`이며 기본 사용자 키 목록은 빈 배열이다. runtime과 Remote settings schema의 기본값을 일치시킨다.
- 유효한 기존 저장 배치와 사용자 키는 보존한다. 저장된 `/clr`을 자동 치환하거나 삭제하지 않는다. 사용자는 Add keys에서 pane clear를 배치하거나 배치를 초기화할 수 있다. 설정 저장·로드만으로 클리어를 실행하지 않는다.

## Alternatives Considered

- `/clr`을 Alt+L 바이트로 바꾼다: PTY가 받는 Alt+L은 laymux pane clear action을 실행하지 않는다.
- Add keys에만 추가한다: 기본 버튼에도 활동·busy 정책을 적용하라는 요청을 충족하지 못한다.
- 저장된 `/clr`을 모두 치환한다: 사용자가 편집한 키와 배치의 소유권을 침해한다.

## Consequences

터치 버튼과 물리 Alt+L의 동작이 일치하고 기본 사용자 키 하나가 사라진다. 이미 저장한 기기는 자동 변경되지 않는다. 배치·재로드·첫 사용·저장값 보존과 clear API 호출/초안·포커스 보존을 브라우저 테스트로 검증한다. 기존 API의 권한·busy 정책 검증은 그대로 재사용한다.
