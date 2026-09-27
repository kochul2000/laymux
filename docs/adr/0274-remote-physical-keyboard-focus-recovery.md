# 0274. Remote 물리 키보드 입력은 안전한 입력 표면으로 포커스를 복구한다

- Status: Proposed
- Date: 2026-09-27
- Source: 사용자 실기 신고(물리 키보드 연결 중 터치 pane 전환 후 재탭 필요), [ADR-0196](0196-remote-coarse-pointer-attach-defers-input-focus.md), [ADR-0273](0273-remote-physical-keyboard-and-navigation-keys.md), [api-contracts.md §13.4](../architecture/api-contracts.md)
- Extends: ADR-0196의 coarse pointer 포커스 제한에 확인된 물리 키보드 예외를 추가한다. ADR-0273의 기존 native 연결 상태를 재사용한다.

## Context

터치 기기는 비동기 attach 뒤 DOM focus만 생기고 소프트 키보드는 열리지 않는 문제를 피하려 입력 포커스를 선점하지 않는다. 하지만 Android가 물리 키보드 연결을 확인한 경우에도 이 제한이 적용되어 pane을 터치로 선택한 뒤 입력하려면 출력 화면을 다시 탭해야 한다. 다른 버튼이나 빈 화면에 포커스가 남은 경우에도 일반 문자가 입력 표면에 도달하지 않는다.

포커스를 항상 강제하면 설정·다른 편집기·모달 입력과 IME 조합을 방해한다. native 장치 판정, 단축키 매핑, PTY 입력 인코딩, 소프트 키보드 토글, 커서 렌더링은 변경 범위 밖이다.

## Decision

**물리 키보드 연결이 확인된 Remote는 사용자 pane 선택의 attach와 일반 문자 입력에서 현재 모드의 입력 표면으로 포커스를 복구한다.**

- 연결 판정은 ADR-0273의 native snapshot을 유일한 근거로 사용한다. 미연결·미지원은 기존 coarse pointer 정책을 유지한다.
- 사용자 진입의 기존 attach 포커스 지점에서 물리 키보드는 coarse pointer 제한의 예외다. 현재 lease·terminal과 문서 가시성, 열린 오버레이·모달·navigation, 다른 편집기의 포커스를 확인한다. 비동기 attach의 기존 generation 검증과 자동 재접속의 no-focus 규칙은 유지한다.
- 단축키 처리 후 소비되지 않은 일반 문자 또는 조합을 시작하는 키에서 같은 안전 조건으로 포커스를 복구한다. Ctrl/Alt/Meta 조합, 제어·탐색 키, 이미 진행 중인 IME 조합은 가져오지 않는다. 이미 입력 표면에 포커스가 있으면 아무 일도 하지 않는다.
- Direct는 xterm helper textarea, Composer는 보이는 현재 editor를 사용한다. 접어 둔 Composer나 disabled editor를 강제로 펼치거나 활성화하지 않는다.
- 원래 키 이벤트의 브라우저 입력 동작을 유지한다. 합성 키 재전송이나 직접 PTY 문자열 전송을 하지 않으며 첫 문자와 이후 입력은 기존 xterm/Composer 경로에서 한 번만 처리한다.

## Alternatives Considered

- 모든 coarse pointer의 attach 자동 포커스 허용: 소프트 키보드의 기존 위상 문제를 다시 만든다.
- blur마다 즉시 포커스 강제: 모달·설정·선택·접근성 탐색의 정상 동작을 방해한다.
- 첫 키를 합성 이벤트나 PTY write로 재전송: IME·키보드 배열·Composer 입력 모델을 복제하고 중복 입력 위험을 만든다.
- APK에서 키를 가로채기: Remote UI의 오버레이·모드 소유권을 native에 중복 구현해야 한다.

## Consequences

물리 키보드 사용자는 터치로 pane을 선택한 뒤 바로 입력하며, 포커스가 유실돼도 일반 입력으로 복구한다. 새 API·설정·APK 변경은 없다. 실제 Remote 번들과 xterm을 사용하는 브라우저 테스트에서 Direct/Composer의 pane 전환, 첫 문자 무손실·무중복, 미연결·다른 편집기·오버레이 보호를 검증한다. Android 실기의 IME와 하드웨어 이벤트 전달은 별도 확인 대상이며, 브라우저가 기본 입력 목적지를 새 포커스로 옮기지 않는 플랫폼이 발견되면 이 정책을 재검토한다.
