# 0316. Remote는 보이는 복원 안내에 밑줄을 상시 표시한다

- Status: Accepted
- Date: 2026-10-11
- Source: 사용자 보고("리모트에서 이미 끝나있는 resume 클릭은 되는데 밑줄이 없어. 뭔가 다르게 처리한거니?"), [ADR-0286](0286-clickable-agent-resume-hints.md), [ADR-0315](0315-remote-resume-shell-state-from-host.md)
- 관계: ADR-0286의 "표시와 클릭은 xterm 추가 링크 provider가 소유한다"를 Remote에 한해 보완한다. 클릭(탭)은 그대로 링크 provider가 맡고, Remote의 밑줄 표시만 xterm decoration이 맡는다. 데스크톱은 바꾸지 않는다.

## Context

xterm 링크 provider의 밑줄은 포인터가 링크 위에 있을 때만 그려진다. 데스크톱은 마우스 hover로 밑줄을 볼 수 있다. 그러나 Android Remote에는 hover가 없으므로, 밑줄은 탭하는 순간 합성된 mousemove로 잠깐 나타났다가 사라진다. 사용자는 탭하기 전에 복원 안내가 링크인지 알 수 없었다.

Remote의 파일 경로 링크는 이미 화면 스캔 결과를 xterm decoration으로 상시 표시한다(ADR-0188, ADR-0220). 복원 링크만 hover 밑줄에 기대고 있었다.

## Decision

**Remote는 화면에 보이는 정형 복원 안내마다 xterm decoration으로 밑줄을 상시 표시한다. 탭 처리는 기존 링크 provider와 ADR-0315의 호스트 판정을 그대로 쓴다.**

- 판정은 링크 provider와 같은 셀 파서(`agent-resume-link.ts`)를 쓴다. 정형 문법, 자동 줄바꿈 결합, normal buffer 한정 규칙이 같으므로 밑줄이 보이는 곳과 탭이 되는 곳이 일치한다.
- 출력 파싱, 스크롤, 크기 변경, buffer 전환 뒤 animation frame 하나로 묶어 viewport 행만 다시 읽는다. 논리 줄은 첫 행에서 한 번만 읽고, 이어지는 줄바꿈 행은 건너뛴다. 단 viewport 첫 행은 위에서 시작한 안내의 일부일 수 있으므로 항상 읽는다. 자동 줄바꿈된 안내는 물리 행마다 decoration 하나를 둔다.
- 동기 출력(DEC 2026) frame이 진행 중이면 이번에는 읽지 않는다. 다시 그리기 위해 잠깐 지운 행 때문에 밑줄이 깜빡이지 않게 하기 위해서다. frame을 끝내는 출력이 파싱되면 다시 읽는다.
- 같은 행·열·폭의 밑줄은 다시 만들지 않고 유지한다. 단 decoration이 이미 해제된 밑줄은 유지하지 않는다. `terminal.reset()`은 decoration을 모두 해제하지만 옛 buffer의 marker는 남기므로, 재연결로 같은 snapshot이 같은 행에 다시 그려지면 marker 위치만으로는 밑줄이 살아 있는지 알 수 없다. 내용이 바뀌거나 화면에서 벗어난 밑줄은 marker를 해제해 지운다. alternate buffer(에이전트 TUI)에서는 밑줄을 두지 않는다.
- 밑줄은 파일 경로 링크와 같은 스타일(`border-bottom`, `pointer-events: none`)을 쓰므로 탭을 가로채지 않는다.
- 셸 상태와 관계없이 형식이 맞으면 밑줄을 표시한다. 실행 가능 여부는 탭할 때 호스트가 판정한다(ADR-0315). 데스크톱 hover 밑줄도 셸 상태를 보지 않는다.

## Alternatives Considered

- **터치 브리지가 마지막 탭 위치에 hover를 유지한다:** 탭하기 전에는 여전히 보이지 않으므로 선택하지 않았다.
- **호스트가 셸 상태일 때만 밑줄을 표시한다:** Remote의 navigation 스냅샷은 낡을 수 있어(ADR-0315) 상시 조회가 필요하다. 탭할 때 판정하면 충분하므로 선택하지 않았다.
- **데스크톱도 상시 밑줄로 바꾼다:** 데스크톱은 hover로 이미 볼 수 있고, 사용자 요구 범위 밖이라 선택하지 않았다.

## Consequences

- Remote에서 종료 안내를 탭하기 전에도 링크라는 것을 알 수 있다.
- 출력이 쏟아지는 동안 frame마다 viewport를 다시 읽는다. normal buffer의 화면 안 논리 줄을 한 번씩만 읽으므로 비용은 화면 셀 수에 비례한다.
- 검증:
  - e2e는 hover나 탭 없이 줄바꿈된 안내 두 행에 정확한 위치와 폭으로 밑줄이 생기는지 확인한다.
  - e2e는 화면을 덮어쓰면 밑줄이 사라지는지 확인한다.
  - e2e는 reset 뒤 같은 화면을 다시 그려도 밑줄이 유지되는지 확인한다.
  - e2e는 alternate buffer에 들어가면 밑줄이 사라지고, 나오면 다시 생기는지 확인한다.
  - 기존 탭 e2e는 밑줄이 있는 상태에서 탭해도 제출되는지 확인한다.
  - 화면 테스트는 범위 스캔이 줄바꿈된 안내를 한 번만 돌려주는지 확인한다. viewport가 안내의 중간 행에서 시작해도 그 안내를 찾는지도 확인한다.
