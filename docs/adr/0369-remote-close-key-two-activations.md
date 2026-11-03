# 0369. Remote Close pane 키는 같은 버튼을 두 번 활성화해야 실행한다

- Status: Accepted
- Date: 2026-11-03
- Source: 사용자 요구(Remote 키보드에 추가한 pane 닫기도 더블탭 확인 적용), [ADR-0327](0327-remote-pane-action-keys-mirror-pc-control-bar.md), [ADR-0322](0322-remote-item-management-menus.md), [api-contracts §13.4](../architecture/api-contracts.md#134-terminal-control)
- 관계: ADR-0327의 Close pane 단일 활성화 결정을 대체한다. Stack·Clear pane 및 API 계약은 유지한다.

## Context

Remote 관리 메뉴는 두 번 활성화로 pane 닫기를 보호하지만 Input bar에 추가한 Close pane은 한 번에 닫힌다. 모바일의 작은 키를 잘못 누르면 실행 중인 터미널을 잃는다. 사용자는 키바의 닫기에도 두 번 확인을 요구했다. 같은 action은 기본행·확장행·플로팅 버튼으로 표시될 수 있고, 모바일 키보드 포커스를 보존해야 한다.

## Decision

**Remote Close pane 키는 같은 버튼·pane·controller lease에서 연속 두 번 활성화해야 기존 닫기 요청을 보낸다.**

- 첫 활성화는 해당 버튼의 위험 색상·테두리와 접근성 이름만 바꾸며 요청·포커스 이동·확인창을 만들지 않는다. 시간 제한 없이 두 번째 활성화가 확인을 소비한다.
- 상태는 Remote surface의 일시적 UI 상태이며 저장하지 않는다. 기본행·확장행·플로팅 버튼 사이에 확인을 승계하지 않는다. PC 확인 설정과 독립적으로 항상 적용한다.
- 다른 컨트롤 활성화, blur, Escape, 마우스·펜 이탈, 창 비활성·문서 숨김, 버튼 제거·숨김·비활성, pane·lease 변경은 해제한다. 터치 이탈과 같은 대상의 navigation 갱신은 유지한다.
- navigation 작업 중에는 닫기 키를 비활성화한다. 확인한 pane ID와 lease가 queue 실행 시점에도 같아야 닫는다. 이동 도중의 탭이나 중복 탭으로 다른 pane을 닫지 않는다. 실패 후 재시도도 두 번 활성화한다.
- 기존 close route·권한·마지막 pane 보호는 유지한다. 서버 요청이나 물리 키보드 단축키에 확인 상태를 추가하지 않는다. Clear pane·Stack은 기존 한 번 활성화를 유지한다.

## Alternatives Considered

- 단일 활성화 유지: 실수로 세션을 잃는 사용자 문제를 해결하지 못한다.
- native confirm dialog: 모바일 키보드와 입력 포커스를 바꾸고 관리 메뉴의 인라인 확인과 달라진다.
- PC 설정을 Remote로 전달: 별도 외부 계약과 동기화가 필요하며 항상 확인을 요구한 범위를 넓힌다.
- queue가 도착한 pane에 확인을 승계: 사용자가 확인한 대상과 닫히는 대상이 달라질 수 있다.

## Consequences

닫기에 탭 한 번이 추가되며 한 번 탭으로 세션을 잃는 것을 막는다. 버튼 재생성 시 다시 확인해야 한다. 단위 테스트는 취소·대상 수명·포커스를, 브라우저 테스트는 실제 배포 번들의 첫 탭 무요청·두 번째 요청·입력 초안 보존·취소·플로팅 경로를 검증한다. 생성 번들과 living doc을 함께 갱신한다. 확인 발견성 문제가 남으면 위험 강조 표현을 재검토한다.
