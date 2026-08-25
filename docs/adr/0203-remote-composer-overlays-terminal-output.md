# 0203. Remote Composer는 터미널 출력 위에 겹친다

- Status: Accepted
- Date: 2026-08-25
- Source: 사용자 요구("투명도가 터미널까지 쭉 내려가야 의미가 있다") · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [ADR-0200](0200-remote-composer-opacity-state-settings.md)
- Amends: ADR-0200의 Composer 배치·terminal geometry 비목표

## Context

ADR-0200은 Remote Composer 전체 surface에 Idle·Focused·Active opacity를 적용했지만, Composer를 터미널 아래의 별도 레이아웃 행으로 유지했다. 그 결과 opacity를 낮춰도 Composer 뒤에는 terminal cell이 아니라 불투명한 terminal shell 배경만 있었고, 사용자가 기대하는 터미널 출력 투과 효과는 나타나지 않았다.

Composer를 별도 행으로 두면 표시·숨김 때 terminal host 높이도 바뀐다. 이는 Remote의 높이 축소 crop과 PTY geometry 정책을 불필요하게 작동시키며, 투명 입력 surface가 출력 문맥 위에 놓인다는 시각 모델과도 맞지 않는다.

범위는 Remote Composer의 화면 배치와 그에 따른 terminal host geometry다. opacity 상태·설정 소유권, Direct mode, Composer 높이 조절, 추천 목록, 입력·전송 계약, desktop Composer는 바꾸지 않는다.

## Decision

**보이는 Remote Composer는 terminal host의 하단 위에 겹치는 overlay이며, terminal cell surface가 Composer 뒤까지 연속해서 렌더된다.**

- terminal shell은 terminal 하나만 전체 가용 높이에 배치하고 Composer를 별도 grid 행으로 할당하지 않는다.
- Composer는 terminal과 같은 shell 안에서 하단에 absolute overlay로 배치한다. shell의 기존 내부 여백과 좌우·하단 경계를 맞추며 terminal 위의 stacking order를 가진다.
- ADR-0200의 opacity는 overlay 전체에 그대로 적용한다. 따라서 낮은 opacity에서는 terminal cell과 배경이 Composer·textarea를 통해 실제로 비친다.
- Composer 표시·숨김과 높이 조절은 terminal host 크기나 PTY rows를 변경하지 않는다. 기존 agent-input 숨김 줄 수에서는 Composer가 실제로 덮는 terminal 행 수를 차감하고, 그보다 설정값이 클 때 남는 행만 viewport를 위로 이동한다.
- Composer 높이는 surface-local ResizeObserver로 관찰한다. 높이가 바뀌면 가린 행 수와 숨김 경계를 다시 적용하고, scroll-to-bottom 버튼은 현재 overlay 상단보다 위에 배치한다.
- 추천 목록은 Composer 위로 떠 있는 기존 배치를 유지하고 terminal 위에서 함께 합성한다. navigation drawer와 modal처럼 더 높은 전역 overlay는 계속 Composer보다 앞선다.

## Alternatives Considered

- **별도 행을 유지하고 shell 배경만 투명하게 한다.** Composer 뒤 공간에 terminal cell이 없으므로 배경색만 달라질 뿐 출력이 비치지 않는다.
- **terminal screenshot 또는 복제 surface를 Composer 배경으로 그린다.** 실제 xterm과 동기화해야 하는 두 번째 시각 surface를 만들고 스크롤·WebGL·selection·IME 상태가 갈라질 수 있다.
- **Composer 높이만큼 terminal을 음수 margin으로 늘린다.** 겹침은 만들 수 있지만 grid geometry와 ResizeObserver가 읽는 크기가 불명확해지고 crop/fit 정책에 가짜 높이 변화를 남긴다.
- **opacity 대신 배경 alpha만 낮춘다.** 텍스트 가독성은 유지되지만 ADR-0200의 surface 전체 상태 설정 의미를 바꾸며, 현재 사용자 설정과 Active 100% 계약을 깨뜨린다.

## Consequences

- Idle·Focused opacity가 실제 terminal output과 합성되어 설정값의 시각적 의미가 생긴다.
- Composer가 열린 동안에도 terminal host와 PTY geometry가 안정적이어서 모드 전환에 따른 불필요한 fit/crop이 사라진다.
- 출력의 마지막 행 일부는 Composer 아래에 가려진다. 이 가림 자체가 agent 입력부 숨김에 기여하므로 같은 줄을 다시 스크롤해 출력 문맥을 과도하게 밀어 올리지 않는다. 설정된 숨김 줄이 가린 행보다 클 때만 남는 차이만큼 Composer 전용 scroll-to-bottom 경계를 유지한다.
- 사용자가 textarea 높이를 드래그해도 경계와 하단 이동 버튼 위치를 다시 계산한다. 이 계산은 terminal surface의 CSS 변수와 xterm viewport만 바꾸며 PTY geometry에는 관여하지 않는다.
- 회귀 테스트는 terminal과 Composer의 bounding box가 하단에서 겹치고 기존 opacity 상태 전이가 유지되는지, 기본 agent 숨김 줄이 overlay와 중복 적용되지 않는지 검증한다. 실제 dev 화면에서도 terminal 문자열이 낮은 opacity Composer 아래로 이어지는지 확인한다.
