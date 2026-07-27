# 0075. 세션 복원 출력은 새 PTY 화면 원점 뒤의 scrollback으로 둔다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 재현 보고(2026-07-28), [data-flow.md §8.8](../architecture/data-flow.md), PR #595

## Context

세션을 다시 열 때 프론트엔드는 저장한 xterm normal-buffer를 재생한 뒤 새 PTY의 live snapshot과 delta를 같은 xterm에 이어 쓴다. PR #595에서 복원 시 한 화면만큼 넣던 줄바꿈을 제거하자 저장 출력의 마지막 커서가 프론트엔드 live 화면 원점으로 남았다. 반면 새 PTY는 자체적으로 새 화면의 1행부터 시작하고 Windows ConPTY를 포함한 셸은 CUP/HVP 같은 절대 좌표로 그 화면을 갱신할 수 있다. 그 결과 프론트엔드의 복원 프롬프트는 화면 아래에 있지만 입력 echo는 1행에 생기고, 같은 출력이 서로 다른 행에 겹쳤다.

복원 이력과 새 PTY 화면은 한 xterm buffer를 공유하지만 좌표계의 소유자가 다르다. 저장 cache는 과거 출력일 뿐 새 PTY의 현재 화면 좌표를 소유할 수 없고, 새 PTY가 live cursor와 terminal mode의 진실원이어야 한다. 동시에 복원 경계를 만들기 위한 합성 빈 화면을 다시 cache에 저장하면 재시작할 때마다 빈 줄이 한 화면씩 누적된다. 기존 cache 안의 공백을 휴리스틱으로 지우는 것은 사용자가 실제로 출력한 빈 줄까지 손상할 수 있으므로 범위 밖이다.

## Decision

**저장된 terminal output은 새 PTY 화면과 같은 좌표에 재생하지 않고 한 화면 뒤의 scrollback으로 이동하며, 새 PTY가 1행 1열부터 live 화면과 cursor/mode를 소유한다.**

- PTY attach는 xterm reset 뒤 normal-buffer cache를 재생하고 복원 구분선을 쓴 다음, 현재 xterm `rows`만큼 CRLF를 써서 복원 viewport 전체를 scrollback으로 이동한다. 이어서 `CUP 1;1`로 xterm cursor를 새 PTY의 화면 원점에 맞춘 뒤 live snapshot과 delta를 적용한다.
- 이 경계는 PTY 구현이나 셸 종류와 무관한 프론트엔드 불변식이다. 새 PTY가 절대 좌표를 쓰든 순차 출력만 쓰든 cache의 마지막 cursor와 결합하지 않는다.
- output cache 저장은 alternate buffer와 live mode를 제외하는 기존 계약을 유지하고, normal buffer의 live cursor 또는 그 아래 마지막 의미 있는 행까지만 명시적 범위로 직렬화한다. 복원 경계가 만든 trailing blank screen은 runtime 좌표 공간일 뿐 과거 출력이 아니므로 저장하지 않는다.
- 기존 cache 내부의 반복 구분선이나 빈 줄은 파괴적으로 정리하지 않는다. 다음 attach부터 현재 viewport에서 격리하고 새 합성 공백의 누적만 막는다.
- 화면 좌표에 관한 회귀는 mock 문자열 단정만으로 종결하지 않고 실제 xterm 셀 격자 테스트와 dev 앱의 buffer dump·스크린샷·입력 echo로 검증한다.

## Alternatives Considered

- **cache 직후 곧바로 live snapshot을 이어 쓴다.** 추가 출력이 가장 적지만 저장 cursor와 새 PTY의 절대 화면 좌표가 갈라진다. PR #595 이후 실기에서 프롬프트·입력 echo 분리와 출력 겹침으로 실패했다.
- **CRLF 한 화면만 추가하고 cursor를 그대로 둔다.** 복원 이력은 scrollback으로 가지만 새 prompt가 화면 아래에 놓이고, 합성 blank rows가 기본 SerializeAddon 범위에 다시 저장돼 매 재시작마다 cache가 커진다.
- **xterm `clear()` 또는 두 번째 `reset()`으로 live 화면을 만든다.** 좌표는 단순해지지만 사용자가 기대하는 복원 scrollback을 지우거나 live snapshot 직전의 parser 상태를 불필요하게 초기화한다.
- **기존 cache에서 반복 marker·CRLF 패턴을 정규식으로 제거한다.** 과거 버전의 오염을 줄일 수 있지만 터미널 출력은 임의의 ANSI와 실제 빈 줄을 포함하므로 안전한 구분 기준이 없다. 데이터 보존을 우선해 채택하지 않는다.

## Consequences

세션을 열면 복원 출력은 스크롤해서 볼 수 있는 이력으로 남고, 현재 viewport의 첫 행부터 새 셸 prompt와 입력 echo가 같은 좌표에 표시된다. 복원 경계의 빈 행은 cache에 재저장되지 않아 반복 재시작으로 한 화면씩 늘어나지 않는다. 저장 범위를 계산하는 프론트엔드 로직과 실제 xterm screen test가 추가된다.

기존 cache에 이미 들어간 중복 marker·빈 줄은 scrollback 안에 남는다. 이를 제거하려면 terminal byte stream에서 사용자 출력과 과거 합성 출력을 구분할 신뢰 가능한 metadata가 먼저 필요하다. xterm SerializeAddon의 range 의미나 PTY attach snapshot 계약이 바뀌어 live 화면 자체를 완전한 checkpoint로 복원하게 되면 이 경계를 재검토한다.
