# 0361. 분할·스택은 기본적으로 원본 터미널 프로필을 선택한다

- Status: Accepted
- Date: 2026-10-28
- Source: 사용자 요구(가로·세로 split과 stack에 프로필 자동 진입, 설정 UI 포함, 기본 true, Remote 검증), [ADR-0140](0140-split-pane-inherits-source-cwd.md), [ADR-0297](0297-pane-stack-slot-layer-model.md), [ADR-0339](0339-remote-stack-creates-enterable-terminal.md)
- 관계: ADR-0140·0297의 EmptyView 기본 생성 정책을 옵션으로 확장하고 ADR-0339의 Remote 터미널 생성 계약을 유지한다.

## Context

같은 셸을 나란히 쓰려는 사용자는 분할·stack 후마다 EmptyView에서 프로필을 다시 골라야 한다. 기존 CWD 시드는 첫 터미널이 생성될 때까지 기다리므로 이 불편을 해소하지 못한다. 원본 터미널의 프로필로 바로 진입하되 이전 동작을 선택할 설정이 필요하다. Remote에는 EmptyView 프로필 선택기가 없으며 선택한 터미널이 슬롯의 비활성 레이어일 수도 있다.

## Decision

**`terminal.inheritProfileOnSplit`을 기본 true로 저장하고 가로·세로 분할과 stack의 새 터미널 프로필 선택에 공통 적용한다.**

- 설정의 SoT는 호스트 settings.json이다. Rust 기본값·역직렬화·설정 스키마와 UI 기본값·설정 화면을 일치시키며 다음 생성부터 적용한다. Windows와 Linux에 동일하게 적용한다.
- 기준은 분할·stack 대상 슬롯의 활성 레이어다. 원본이 터미널일 때 실행 중 인스턴스의 프로필을 우선하고 저장된 view의 프로필로 보완한다. 프로필이 생략된 터미널은 기존 기본 프로필 해석을 따른다. 다른 pane으로 폴백하지 않는다.
- 프로필 이름만 선택한다. 에이전트 세션·출력 캐시·pane별 override는 복사하지 않는다. CWD는 기존 일회성 시드 경로를 계속 사용하며 옵션과 독립이다.
- 끄거나 원본이 비터미널이면 데스크톱 UI는 EmptyView를 만든다. 명시한 view 종류·프로필·CWD가 자동 선택보다 우선한다.
- Automation split·stack은 기존의 사용 가능한 터미널 기본 계약을 유지하고, 프로필을 생략했을 때 설정을 적용한다. Remote stack도 사용 가능한 터미널을 항상 만들며 true이면 Remote가 선택한 레이어의 프로필·CWD를, false이면 기본 프로필과 선택 레이어의 CWD를 사용한다. 비활성 레이어를 선택한 경우에도 슬롯 활성 레이어로 대체하지 않는다.

## Alternatives Considered

- UI 버튼마다 프로필 복사: 키보드·Automation·Remote 간 결과가 달라지고 정책이 분산된다.
- view 전체 복사: 원본의 에이전트 대화와 로컬 override까지 새 pane으로 옮겨 독립 세션 원칙을 깨뜨린다.
- Remote도 false이면 EmptyView 생성: 프로필 선택기가 없는 Remote에서 새 레이어에 진입할 수 없다.
- 기본 false: 반복적인 프로필 선택을 기본적으로 없애 달라는 사용자 요구를 충족하지 못한다.

## Consequences

- 데스크톱에서는 분할·stack 후 바로 같은 프로필의 새 셸을 사용할 수 있고 설정으로 이전 EmptyView 동작을 선택할 수 있다.
- 프로필 startup command는 새 터미널의 정상 시작 규칙에 따라 실행된다. 기존 에이전트 대화 복원 정보는 상속하지 않는다.
- Remote에서 상속을 끄고 WSL 원본을 Windows 기본 프로필로 열면 원본 CWD가 새 실행 환경에서 유효하지 않을 수 있다. CWD 변환·실패 fallback은 기존 PTY 시작 정책을 따르며 시드를 실제 CWD로 단정하지 않는다.
- 새 설정은 호환되는 기능 추가로 minor 버전 영향이다. 마이그레이션 없이 누락 필드 기본값으로 처리한다.
- UI draft/저장, 기본값·false 영속화·타입 검증, 두 분할 방향·stack·활성 레이어·명시값 우선, Remote 선택 레이어 동작을 검증한다.
- Remote에 EmptyView 선택기가 생기면 false의 표면별 동작 차이를 재검토한다.
