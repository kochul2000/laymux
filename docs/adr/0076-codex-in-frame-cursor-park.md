# 0076. Codex 인프레임 커서 주차를 동기화 출력의 최종 상태로 인정한다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 보고(Codex 출력 중 커서가 위로 이동하고 줄 끝 한글 조합 순서가 겹침); Codex CLI 0.145.0 dev 실측; [architecture/data-flow.md §8.5](../architecture/data-flow.md); [ADR-0008](0008-shell-cursor-shadow-cursor.md); [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md); [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)
- Relation: ADR-0053을 대체한다. 아래에서 명시적으로 바꾸는 frame-tail 문법·shadow cursor 정착 규칙 외의 ADR-0053 결정(네이티브 Windows host gate, surface-local 소유권, bounded byte parser, fail-open, tracked write/refresh, 입력·프로토콜 응답 분리)은 그대로 재채택한다. ADR-0008·0011의 shadow cursor/DECTCEM 소유권은 바꾸지 않고, 새 Codex가 같은 권위 신호를 프레임 안에서 내는 경우를 추가한다.

## Context

ADR-0053이 근거로 삼은 Codex는 synchronized-output frame을 footer의 `?25h`와
`?2026l`로 닫고 약 15ms 뒤 별도 청크의 `?25l` + position + `?25h`로 입력
커서를 주차했다. 그래서 stabilizer는 frame reset 뒤의 정확한 restore까지 기다려
한 tracked xterm write로 묶었고, shadow cursor는 reset 시점의 footer 대신 pre-frame
snapshot을 임시값으로 유지했다.

Codex CLI 0.145.0의 네이티브 Windows PTY 출력은 이 순서를 바꿨다. dev에서 493개
frame을 수집했으며 반복된 꼬리는 `?25h` 뒤에 최종 입력 위치 CUP를 보내고 그 다음
`?2026l`로 닫는 형태였다(예: footer `26;58H` → `?25h` → input `24;3H` →
`?2026l`). 뒤따르는 out-of-frame hide/position/show restore는 없었다.

기존 상태 머신은 ADR-0053의 명시적 규칙에 따라 `?25h` 뒤 position을 최종 restore로
인정하지 않았다. 따라서 완결된 새 frame도 `AwaitingRestore`에 남아 다음 frame 또는
50ms timeout까지 한 frame씩 늦게 전달됐다. shadow cursor도 reset에서 최종 buffer
위치를 버리고 pre-frame snapshot을 복원한 뒤 `parkPending`을 세웠다. 출력이 scrollback을
늘리는 동안 이 오래된 절대 행은 화면 위로 밀려 overlay cursor가 입력줄보다 위에 보였다.

같은 `parkPending`은 IME의 `getSettledCursor()`를 `null`로 만들었다. 원래 Codex가 자기
입력 상자의 줄바꿈과 continuation indent를 적용한 실제 cursor를 채택해 terminal 셀
산술을 교정해야 하지만, 새 frame에서는 정착 경로가 항상 막혔다. 그 결과 줄 끝 한글은
xterm 쓰기 규칙용 `advanceCells`만 따라가고 Codex의 앱 소유 2셀 indent를 놓쳐 다음
음절이 앞 음절 위에 겹쳤다. `advanceCells` 자체의 wide-cell pad 계산은 실제 xterm과
일치하며 shell에도 필요하므로, 앱 frame의 권위 cursor를 복구하는 것이 책임 경계에 맞다.

결정 범위는 PC WebView의 native Windows live PTY에서 새 in-frame park를 식별·전달하고,
shadow cursor와 IME 정착 상태에 넘기는 규칙이다. Linux·WSL·direct SSH·browser remote,
Rust raw output/OSC 파이프라인, xterm 셀 폭 규칙, 일반 synchronized-output의 WebGL native
cursor 숨김(issue #610)은 비목표다.

## Decision

**정확한 `?25h` + position + `?2026l` frame tail은 프레임 안에서 완료된 권위 cursor park로 인정하고, reset 시점의 buffer cursor를 shadow cursor와 IME의 정착 좌표로 사용한다.**

- ADR-0053의 legacy 문법 `?2026l` → `?25l` → position 하나 이상 → `?25h`는 계속
  지원한다. 완결되면 frame과 out-of-frame restore를 한 tracked write로 전달하고,
  parser의 out-of-frame show가 park를 확정한다.
- 새 문법은 열린 frame 안의 singleton `?25h` 뒤에 CUP/HVP/CHA position 하나 이상이
  연속하고 singleton `?2026l`로 즉시 닫힐 때만 인정한다. show와 reset 사이에 printable
  byte, control string, C0 또는 position 이외 CSI가 하나라도 끼면 후보가 아니며 ADR-0053의
  legacy 대기/fail-open 규칙으로 돌아간다. 앱 이름이나 시간 간격으로 문법을 추측하지 않는다.
- 새 문법이 완결되면 stabilizer는 다음 청크를 기다리지 않고 frame 전체를 tracked write
  하나로 방출한다. 최종 `?25h`는 xterm의 애플리케이션 DECTCEM 상태를 갱신해야 하므로
  보존하고, 그보다 앞선 transient in-frame show만 제거한다. synchronized-output이 final
  position까지 렌더를 보류하므로 보존한 show가 footer에서 독립 paint되는 경계는 없다.
- emission에는 surface-local `frameEndCursorAuthoritative` metadata를 싣는다. xterm parser가
  같은 write의 `?2026l` handler에 도달했을 때 `buffer.active`는 이미 final position을
  적용했으므로, `applyDec2026ResetToShadowCursor`는 pre-frame snapshot 대신 그 좌표를
  채택한다. `parkPending`은 세우지 않고 남은 settle timer를 해제하며, final show의
  visibility를 shadow state에도 반영한다.
- metadata가 없으면 reset 시 pre-frame snapshot을 쓰고 out-of-frame park/settle을 기다리는
  기존 규칙을 그대로 적용한다. 모든 reset에서 buffer cursor를 믿으면 legacy footer jump가
  재발하므로 두 문법의 상태 전이를 합치지 않는다.
- IME controller의 산술과 채택 휴리스틱은 바꾸지 않는다. 새 frame 완료 뒤
  `getSettledCursor()`가 final buffer cursor를 제공하게 하여, 기존 issue #569 경로가 Codex의
  앱 소유 wrap/indent를 다시 교정한다.
- host positive gate, 50ms/1MiB 상한, control-string framing, byte-for-byte fail-open,
  attach lifecycle, protocol reply와 human input 분리, atomic write 뒤 public refresh는
  ADR-0053의 결정을 그대로 재채택한다.

## Alternatives Considered

- **새 꼬리를 계속 fail-open:** 바이트 최종 상태는 보존하지만 매 frame이 다음 frame 또는
  timeout까지 늦고, shadow cursor가 이미 관측된 final CUP를 버려 두 사용자 증상이 지속된다.
- **모든 `?2026l`에서 live buffer cursor 채택:** 새 Codex에는 맞지만 legacy Codex가 reset을
  footer에서 보내는 실측과 충돌해 원래 cursor jump를 되살린다.
- **frame 안 마지막 position을 조건 없이 권위화:** repaint body의 임의 CUP를 입력 caret로
  오인할 수 있다. final show 뒤 position만 허용하고 reset까지 다른 토큰이 없는 strict tail을
  선택했다.
- **최종 `?25h`도 삭제하고 shadow state만 visible로 변경:** overlay는 맞아도 xterm의 앱
  DECTCEM 값이 stale해져 overlay 소유권을 해제하거나 Codex가 종료될 때 native cursor가
  계속 숨을 수 있다. atomic frame 안에서 show를 보존하는 쪽이 최종 터미널 상태도 같다.
- **`advanceCells`에 Codex continuation indent를 하드코딩:** terminal width와 앱 입력 상자
  width는 다른 계약이고 Codex 레이아웃은 바뀔 수 있다. 앱이 실제로 남긴 cursor라는 기존
  단일 진실원을 복구하기로 했다.

## Consequences

- Codex 0.145 frame은 다음 frame/timeout을 기다리지 않고 표시되며 overlay cursor가 현재
  입력 행을 따른다. 활성 한글 조합도 frame-end CUP를 정착 좌표로 채택해 줄 끝 continuation
  indent에서 음절 overdraw를 피한다.
- legacy Codex의 out-of-frame restore와 pre-frame fallback은 유지된다. 새 metadata가 없는
  WSL·Linux·remote·replay 경로도 동작이 바뀌지 않는다.
- stabilizer는 두 개의 성공 문법과 in-frame tail의 strict 후보 상태를 관리한다. 단위 테스트는
  새 꼬리의 즉시 atomic emission·metadata·deadline 부재, legacy restore, 중간 payload/CSI의
  fail-open을 고정해야 한다. shadow 상태 테스트는 legacy snapshot과 새 final buffer 선택을
  대조하고, TerminalView 통합 테스트는 열린 IME가 final park를 실제 픽셀 앵커로 채택하는지
  검증한다.
- 새 Codex가 show/position/reset 사이에 다른 무해한 제어를 추가하면 strict parser는 안전하게
  legacy 대기/fail-open으로 돌아가지만 지연과 cursor 증상이 재발할 수 있다. 그때는 새 trace를
  근거로 허용 문법을 별도 결정에서 확장한다.
- 앱이 frame-end 전에 정확한 위치를 복원하면 재검토한다는 ADR-0053의 조건이 실제로 발생해
  이 ADR을 만들었다. 향후 xterm.js가 final cursor metadata를 공개하거나 Codex가 다시
  out-of-frame restore만 사용하면 두 문법의 복잡도를 줄일 수 있는지 재평가한다.
