# 0220. path-link 수명 판정은 synchronized-output 안정 프레임에서 수행한다

- Status: Proposed
- Date: 2026-08-30
- Source: 사용자 요구("Codex Direct 입력에서 한글 IME 한 덩어리가 확정될 때 파일 경로 밑줄이 사라졌다가 다시 생김") · [architecture/data-flow.md §8.6](../architecture/data-flow.md) · [ADR-0188](0188-path-link-ambient-detection-triggers.md)
- Corrects: ADR-0188의 terminal write 단위 path-link 폐기 규칙

## Context

ADR-0188은 데스크톱 터미널의 `selection`·`point`와 Remote 터미널의 `selection`·`point`·`screen` path-link 발견 트리거를 정했다. stale 링크를 막기 위해 데스크톱 `TerminalView.onWriteParsed`는 매 physical write 뒤 저장 token을 현재 xterm 버퍼와 비교했고, Remote `screen`은 write마다 데코레이션을 폐기한 뒤 출력이 500ms 멈추면 다시 검증했다.

Codex 같은 TUI는 한글 IME의 확정 문자열을 받은 뒤 화면을 DEC 2026 synchronized-output 프레임으로 다시 그린다. xterm은 이 프레임이 열린 동안 렌더러에는 직전 완료 화면을 계속 보여 주지만 내부 버퍼에는 줄 지우기와 재출력을 순서대로 적용한다. PTY가 한 프레임을 여러 delta로 나누면 첫 write 직후 버퍼의 경로 줄은 잠시 비어 있고 다음 write에서 같은 경로가 복원된다. 이 중간 버퍼를 완료 화면처럼 재검증하면 아직 보이는 밑줄을 폐기하고, 최종 프레임 뒤 hover 또는 Remote 유휴 스캔이 다시 실행될 때까지 밑줄이 사라진다.

이 문제는 입력 문자의 언어나 Composer 자체가 아니라, Direct 입력의 echo가 촉발한 TUI repaint와 path-link 수명 판정의 프레임 경계가 어긋난 것이다. 따라서 입력 경로별 예외나 지연값이 아니라 xterm이 이미 제공하는 synchronized-output 상태를 기준으로 판정해야 한다.

범위는 데스크톱·Remote path-link의 write 후 원문 재검증과 Remote `screen` 데코레이션·signature 수명이다. 후보 문법, stat 배치 상한, Remote API 요청·응답, 권한 경계, 500ms 유휴 시간은 바꾸지 않는다. resize/reflow, buffer 전환, xterm reset, marker를 폐기하는 전체 화면 초기화처럼 좌표계 자체가 무효가 되는 사건을 이전 완료 화면 위에 유령 데코레이션으로 복제하는 것도 비목표다.

## Decision

**path-link는 DEC 2026 synchronized-output 중간 버퍼로 수명을 판정하지 않고, 정상 reset 뒤의 write 완료 또는 xterm 안전 timeout 뒤에 관찰한 안정 프레임에서만 저장 token을 재검증한다.**

- 데스크톱 `TerminalView`는 synchronized-output mode가 활성인 `onWriteParsed`에서 `pathLink.revalidate()`를 실행하지 않고 deferred 상태만 기록한다. 정상 `?2026l`은 그 physical write의 `onWriteParsed`에서 최종 버퍼를 한 번 재검증한다. 닫는 sequence가 없어 xterm의 1초 safety timeout이 mode를 내린 경우에는 기존 mode monitor가 deferred 재검증과 recovery refresh를 함께 수행한다. point 조회 memo 무효화와 IME echo 관찰은 physical write마다 계속 실행한다.
- Remote write 완료 경로도 mode가 활성인 동안 원문 재검증을 보류하고 유휴 스캔 타이머만 다시 잡는다. 유휴 gate는 mode가 내려갈 때까지 재예약되므로 정상 reset과 safety timeout 모두 최종 버퍼 판정에 도달한다. 타이머 재예약은 진행 중인 이전 `screen` 요청만 취소하며 원문이 살아 있는 데코레이션은 폐기하지 않는다. 다만 OSC 7은 화면 셀을 바꾸지 않고 서버가 소유한 CWD를 바꿀 수 있으므로, 모든 physical write는 screen 검증 context를 dirty로 만들고 안정 프레임의 다음 유휴 스캔에서 화면 문자열이 같아도 서버 검증을 한 번 수행한다. 화면 signature는 physical write가 없었던 중복 유휴 평가만 생략한다.
- 안정 프레임에서는 저장한 live marker 줄·시작 셀·원문 token이 현재 셀과 다른 항목만 즉시 폐기한다. Codex의 line erase(`EL`)처럼 marker가 살아 있는 repaint에서 최종 좌표·token·path·kind가 같으면 기존 marker와 decoration을 재사용해 DOM identity를 유지한다. 이미 dispose된 marker나 decoration은 재사용하지 않는다.
- Remote 화면 signature는 요청을 시작한 화면이 아니라 검증 응답의 모든 match가 최신 셀에 매핑되고 전체 decoration 집합이 성공적으로 적용된 뒤에만 그 집합에 결속한다. 취소된 요청은 새 signature를 획득하지 않으며, 원문이 살아 있는 기존 성공 집합의 signature는 유지한다. malformed·부분 매핑 응답이나 기존 집합의 원문 재검증 탈락은 해당 scope와 signature를 무효화해 다음 같은 화면을 검증 완료로 오인하지 않는다.
- 화면 signature가 바뀌어 새 batch를 검증하는 동안에도 원문 재검증을 통과한 기존 `screen` 밑줄은 유지한다. 성공 결과 적용 시 live marker·좌표·terminal·lease·capability·token·path·kind가 같은 항목은 재사용하고, 사라진 항목만 dispose하며 새 항목만 생성한다.
- 빈 화면, invalid 응답, 요청 실패, 권한·terminal 상실은 해당 scope를 폐기한다. resize/reflow, normal/alternate buffer 전환과 xterm reset은 좌표계가 바뀌므로 기존 `screen` scope와 signature를 즉시 폐기한다.

## Alternatives Considered

- **ADR-0188처럼 physical write마다 즉시 판정하거나 `screen`을 전면 폐기한다.** stale 표시를 단순하게 막지만, 렌더되지 않은 DEC 2026 중간 버퍼를 사용자에게 보이는 화면으로 오인해 이번 깜빡임을 만든다.
- **Direct 입력이나 한글 확정 뒤에만 재검증을 늦춘다.** 같은 repaint는 영문·붙여넣기·Composer 전송과 앱 자체 갱신에서도 생긴다. 입력 종류를 원인으로 삼으면 경로별 예외가 늘고 실제 화면 경계와도 맞지 않는다.
- **Remote 유휴 시간을 늘린다.** 재스캔 빈도만 낮출 뿐 write 시점 폐기와 데코레이션 재생성 공백은 남고, 적절한 값도 입력 속도와 네트워크 지연에 따라 달라진다.
- **화면 signature에 Remote가 마지막으로 본 CWD를 포함한다.** CWD의 SoT는 서버 terminal state이고 Remote navigation snapshot은 drawer가 닫힌 동안 최신임이 보장되지 않는다. stale client 복제본을 검증 context로 삼지 않고, output burst마다 서버가 최신 CWD로 다시 해석하게 한다.
- **모든 synchronized-output 지우기에서 DOM을 별도 overlay로 복제한다.** xterm marker까지 폐기하는 전체 화면 초기화에서도 이전 밑줄을 유지할 수 있지만, 이미 좌표계가 무효인 화면 위에 클릭 가능한 stale 표시를 남긴다. 이번 Codex line repaint는 live marker 보존으로 해결되므로 이 추가 상태 계층은 만들지 않는다.
- **stat 결과를 path 기준 TTL 캐시한다.** 반복 I/O는 줄지만 파일 생성·삭제가 화면 변화 없이 캐시 수명 동안 반영되지 않는다. 이 결정은 filesystem 결과가 아니라 안정 프레임과 검증된 decoration identity만 재사용한다.

## Consequences

- Direct 입력의 한글 음절 확정이 Codex의 분할 repaint를 촉발해도, 아직 렌더되지 않은 중간 줄 지우기로 파일 경로 밑줄을 폐기하지 않는다. 최종 셀에 같은 token이 돌아오면 밑줄과 클릭 대상은 계속 유지된다.
- 닫히지 않은 DEC 2026 프레임도 xterm 안전 timeout 뒤 최종 버퍼를 한 번 재검증하므로 stale 링크가 무기한 남지 않는다.
- Remote에서 physical write가 없는 중복 유휴 평가는 추가 path-link 요청과 filesystem stat을 만들지 않는다. output burst가 있으면 화면 문자열이 같아도 500ms 유휴 뒤 한 번 검증하므로, 보이지 않는 CWD 변경 뒤 상대경로가 이전 절대경로를 계속 열지 않는다. 같은 결과는 기존 decoration을 재사용해 이 검증 비용이 깜빡임으로 드러나지 않는다.
- 링크 자체의 최종 셀 원문이 바뀌거나 marker가 사라지면 즉시 폐기한다. 안정성 개선이 stale 파일 열기를 허용하지 않는다.
- Remote 결과 적용에는 bounded reconciliation과 성공 적용 signature가 추가된다. `screen` 후보 상한이 64이므로 선형 매칭 비용은 고정 상한 안에 있다.
- 컴포넌트 테스트는 분할 프레임과 safety timeout의 데스크톱 deferred 재검증을 검증한다. 실제 xterm Playwright E2E는 동일 화면 write 중 decoration 유지와 서버 context 재검증, 같은 셀의 CWD별 절대경로 재해석, Direct 한글 확정 echo, 분할 DEC 2026 프레임의 decoration DOM identity, safety timeout, 취소된 화면 요청 signature 재시도를 검증한다. xterm의 synchronized-output 또는 marker 수명 계약이 바뀌면 이 결정을 재검토한다.
