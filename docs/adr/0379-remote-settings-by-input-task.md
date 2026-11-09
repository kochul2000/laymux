# 0379. Remote 설정은 입력 과업을 기준으로 묶는다

- Status: Accepted
- Date: 2026-11-09
- Source: 사용자 UI 개선 요구, [#1300](https://github.com/kochul2000/laymux/issues/1300), [ADR-0214](0214-remote-settings-paginates-into-tabs.md), [ADR-0269](0269-remote-physical-keyboard-shortcuts.md)
- Extends: ADR-0214의 설정 분류와 소속 항목을 정리한다.

## Context

Input bar에서 물리 키보드 설정이 먼저 펼쳐지고 Composer 글자 크기·불투명도는 Display에 있다. 입력 바를 편집하려는 사용자에게 무관한 설명을 먼저 읽게 하고 Composer를 조정하려면 여러 탭을 찾아야 한다. 설정 값과 기기 로컬 저장은 이미 분리되어 있으므로 위치를 바꾸기 위해 새 설정 모델을 만들 필요는 없다.

## Decision

**입력 바와 선택형 물리 키보드는 Input에, Composer의 모양과 동작은 Composer에 함께 둔다.**

기존 inputBar 패널 ID와 선택 저장 키는 유지하며 표시 이름만 Input으로 넓힌다. 물리 키보드는 기본으로 접힌 명시적 섹션으로 제공하고 단축키 도움말도 그 안에 둔다. 입력 바 편집은 별도 키보드 설명을 펼치지 않고 사용한다. Composer의 글자 크기·상태별 불투명도와 history·자동완성·에이전트 출력 옵션은 같은 패널에서 편집한다. Display에는 터미널과 메뉴·스크롤 등의 화면 설정을 둔다. 여섯 패널, 키보드 탐색, 연결 전 편집, DOM 컨트롤 ID, 기기 로컬 저장·MCP 키·호스트 API는 유지한다.

## Alternatives Considered

- 물리 키보드 전용 일곱 번째 탭은 이미 좁은 화면에서 분류 발견성이 나쁜 문제를 더 키우므로 추가하지 않는다.
- 위치를 유지하고 링크만 추가하면 같은 과업이 흩어진 구조와 잘못된 첫 화면을 남긴다.
- 모든 표시 값을 Display에 유지하면 구현 소유권은 단순하지만 Composer 전용 탭이 사용자가 기대하는 모양 설정을 제공하지 못한다.

## Consequences

같은 과업의 조절 항목을 한곳에서 찾고 물리 키보드를 쓰지 않는 사용자는 관련 설명을 펼칠 필요가 없다. Composer 패널은 길어지므로 모양·동작의 제목을 구분한다. DOM ID와 저장 키를 보존해 사용자 값과 MCP 계약을 유지하지만 탭 이름·상위 섹션을 가정한 e2e는 갱신해야 한다. 항목 증가로 한 과업이 다시 여러 화면을 요구하면 분류를 재검토한다.
