# 0078. WSL 인프레임 커서 주차는 바이트 보류 없이 reset 메타데이터로 전달한다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 보고(WSL Codex에서 한글→영문 전환과 Backspace 반복 시 커서가 매우 늦게 따라옴); dev cursor/PTY trace; [architecture/data-flow.md §8.4·§8.5](../architecture/data-flow.md); [ADR-0076](0076-codex-in-frame-cursor-park.md)
- Relation: ADR-0076의 strict `?25h` → position → `?2026l` 권위 규칙을 WSL live PTY로 확장한다. ADR-0076이 재채택한 네이티브 Windows stabilizer host gate와 legacy transaction 규칙은 바꾸지 않는다.

## Context

Codex CLI 0.145.0은 WSL에서도 synchronized-output frame의 마지막에 `?25h` 뒤 최종
입력 위치 CUP를 쓰고 곧바로 `?2026l`로 닫는다. 그러나 ADR-0076의
`frameEndCursorAuthoritative`는 네이티브 Windows stabilizer의 성공 emission에만 붙었다.
`InitialExecutionHost=wsl`은 그 stabilizer를 우회하므로 동일한 strict tail을 xterm이
파싱해도 reset은 항상 legacy frame으로 분류됐다.

그 결과 각 입력 echo frame마다 `parkPending`이 생기고 최대 50ms settle timer 동안 overlay
repaint가 동결됐다. dev trace에서 반복 입력마다 `overlay-frozen(park-pending)` 뒤
`park-settle-timeout`과 다음 animation frame을 거쳐 약 30ms 후에야 cursor update가
관측됐다. 한글 조합 중에는 composition preview가 동결을 우회하지만, 조합 종료 직후 영문
입력이나 Backspace는 다시 이 지연을 그대로 받아 사용자 증상과 일치했다.

WSL은 ConPTY의 네이티브 Windows cursor restore 교정 대상이 아니다. Windows stabilizer를
그대로 켜면 일반 WSL 앱의 DEC 2026 frame도 legacy restore 후보로 최대 50ms 보류할 수 있다.
WSL 출력의 byte-for-byte pass-through를 지키면서, 이미 출력 안에 완결된 권위 신호만
shadow cursor에 전달할 별도 결정이 필요하다.

범위는 PC WebView의 WSL live PTY delta와 Codex 0.145 strict in-frame tail이다. legacy
out-of-frame restore의 원자화, Linux·direct SSH·unknown·browser Remote, replay/snapshot,
Rust raw output/OSC 파이프라인과 IME 산술은 비목표다.

## Decision

**WSL live PTY는 byte-for-byte pass-through를 유지하되, strict in-frame cursor park를 읽기 전용 스트림 recognizer로 판정해 정확한 `?2026l` write에만 `frameEndCursorAuthoritative`를 붙인다.**

- recognizer는 terminal surface마다 하나를 두고 `Uint8Array`의 CSI와 control-string lexical
  state만 청크 사이에 유지한다. 앱 이름이나 시간 간격으로 추정하지 않는다.
- 인정 문법은 ADR-0076과 같다. 열린 singleton `?2026h` frame 안에서 singleton `?25h` 뒤
  CUP/HVP/CHA가 하나 이상 연속하고 singleton `?2026l`로 즉시 닫혀야 한다. show와 reset
  사이의 printable byte, control string, C0, position 이외 CSI는 후보를 취소한다.
- recognizer는 바이트를 기다리거나 삭제·치환·재정렬하지 않는다. 호출받은 모든 바이트를
  같은 호출에서 즉시 반환한다. strict reset이 완결된 경우에만 현재 청크를 그 reset의 시작과
  끝에서 나눠, reset을 파싱하는 tracked xterm write에 metadata 범위를 한정한다. 같은 청크에
  앞선 legacy reset이 있어도 metadata를 공유하지 않는다.
- CSI가 청크 경계에서 나뉘면 lexical state로 완결을 인식하되 이미 전달한 prefix를 다시
  보관하거나 내보내지 않는다. authoritative reset의 나머지 바이트가 든 다음 write에 metadata를
  붙이면 xterm parser의 연속 상태가 같은 reset handler에서 이를 소비한다.
- metadata가 붙은 reset은 ADR-0076과 동일하게 현재 buffer cursor를 채택하고
  `parkPending`/settle timer를 만들지 않는다. 문법이 불완전하면 metadata 없이 기존 parser
  settle 경로로 fail-open한다.
- attach stream 교체·gap 재부착·unmount에서는 recognizer의 열린 frame과 partial token을
  폐기한다. native Windows stabilizer와 같은 lifecycle reset 경계를 사용한다.
- 네이티브 Windows는 기존 stabilizer, WSL은 metadata-only recognizer, direct SSH·native
  Linux·unknown·browser Remote와 replay/snapshot은 기존 pass-through를 유지한다.

## Alternatives Considered

- **WSL에도 `NativeWindowsOutputStabilizer`를 활성화:** strict Codex frame은 해결되지만
  legacy restore를 보내지 않는 일반 WSL synchronized-output 앱의 frame까지 50ms 보류할 수
  있다. WSL에 필요 없는 바이트 변환·원자화 책임도 함께 확장된다.
- **park settle 상한을 줄이거나 0으로 설정:** 증상을 줄일 뿐 frame-end의 이미 존재하는 권위
  cursor를 계속 버린다. legacy Codex의 footer jump 방어까지 약화한다.
- **WSL의 모든 `?2026l`에서 buffer cursor 채택:** legacy Codex나 다른 TUI가 footer에서
  frame을 닫는 경우를 오인한다. ADR-0076의 strict grammar를 그대로 재사용한다.
- **PTY 청크 전체에 boolean metadata 부착:** 한 청크에 여러 frame reset이 있으면 앞선
  non-authoritative reset도 권위화된다. reset token 경계에서 emission을 나누기로 했다.
- **Rust PTY 계층에서 앱별 판정:** surface-local xterm parser 상태와 metadata 소비 경계를
  Rust raw output/OSC 단일 패스에 섞고 앱 탐지를 계약으로 만든다. 기존 프론트 cursor 소유권을
  유지한다.

## Consequences

- WSL Codex 0.145의 입력 echo마다 legacy 50ms settle freeze가 생기지 않아 한글→영문 전환과
  Backspace 반복에서 overlay cursor가 frame-end 최종 위치를 즉시 따른다.
- WSL 출력은 원본과 바이트·순서가 같고 추가 timer나 frame hold가 없다. strict reset이 있는
  청크만 tracked write 경계가 더 잘게 나뉠 수 있다.
- native Windows의 legacy/new grammar와 refresh settle은 변경되지 않으며, WSL legacy frame은
  종전 parser timeout fallback을 유지한다.
- recognizer는 stabilizer와 같은 strict grammar를 별도 lexical state machine으로 구현하므로
  두 판정이 어긋날 유지보수 위험이 있다. 단위 테스트는 one-chunk/split strict tail,
  payload·CSI·OSC interruption, 같은 청크의 legacy+strict frame과 reset lifecycle을 고정한다.
  TerminalView 통합 테스트는 WSL strict reset에서 settle timeout이 생기지 않는지 검증한다.
- Codex가 tail 문법을 다시 바꾸거나 WSL 외 host에서 같은 지연이 실측되면 trace를 근거로
  recognizer의 문법 또는 host 범위를 새 결정에서 재검토한다.
