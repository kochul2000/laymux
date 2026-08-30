# 0221. Codex position-first 인프레임 커서 주차도 권위 tail로 인정한다

- Status: Accepted
- Date: 2026-08-30
- Source: 사용자 보고(PR #950 수정과 최신 Laymux에서도 유사한 IME/cursor 증상 지속); Codex CLI 0.151.0 dev PTY trace; [OpenAI Codex PR #40166](https://github.com/openai/codex/pull/40166); [architecture/data-flow.md §8.4·§8.5](../architecture/data-flow.md); [ADR-0076](0076-codex-in-frame-cursor-park.md); [ADR-0078](0078-wsl-in-frame-cursor-park-metadata.md)
- Extends: ADR-0076의 strict in-frame park 문법을 position-first 순서로 확장한다.
- Extends: ADR-0078의 WSL metadata-only recognizer에 같은 문법을 적용한다.

## Context

ADR-0076과 ADR-0078은 Codex CLI 0.145.0에서 실측한 `?25h` →
CUP/HVP/CHA 하나 이상 → `?2026l` 꼬리만 권위 있는 인프레임 cursor park로
인정한다. Native Windows stabilizer는 이 문법을 한 tracked write로 원자화하고,
WSL recognizer는 바이트를 변경하지 않은 채 정확한 reset write에
`frameEndCursorAuthoritative`를 붙인다.

OpenAI Codex PR #40166은 그리기 도중 이전 위치의 cursor가 노출되지 않도록 cursor를
보이기 전에 먼저 이동하도록 순서를 바꿨다. 이 변경은 Codex 0.150.0에 포함됐고,
dev의 Codex 0.151.0 WSL PTY에서도 CUP/HVP/CHA → `?25h` → `?2026l` 꼬리가
반복 관측됐다. v0.12.4 dev 출력 300줄에서는 position-first 꼬리가 50회,
show-first 꼬리가 0회였다.

기존 상태 머신은 position이 show보다 먼저 오면 후보를 만들지 않는다. Native Windows는
완결된 frame을 legacy restore 대기로 넘겨 다음 frame 또는 hold timeout까지 지연하고,
WSL은 바이트를 통과시키지만 reset metadata를 붙이지 않는다. 그 결과 reset에서 final
buffer cursor 대신 pre-frame snapshot과 `parkPending` fallback을 사용한다.

PR #950은 열린 frame 안의 활성 composition preview 소유권 우선순위를 고쳤지만, reset
바이트가 권위 cursor metadata를 잃는 이 분류 경로는 바꾸지 않았다. 따라서 같은 종류의
cursor 지연이나 다음 조합 앵커 중첩이 계속 나타날 수 있다.

범위는 PC WebView의 Native Windows stabilizer와 WSL metadata-only recognizer가 두
position/show 순서를 판정하는 규칙이다. IME controller 산술·composition lifecycle,
Rust OSC 파이프라인, direct SSH·native Linux·browser Remote의 host 범위, legacy
out-of-frame restore는 비목표다.

## Decision

**열린 DEC 2026 frame의 즉시 닫히는 strict suffix가 show-first 또는 position-first인 경우 모두 권위 있는 인프레임 cursor park로 인정한다.**

- 지원하는 인프레임 문법은 다음 두 가지다.
  - show-first: singleton `?25h` → CUP/HVP/CHA 하나 이상 → singleton `?2026l`
  - position-first: CUP/HVP/CHA 하나 이상 → singleton `?25h` → singleton `?2026l`
- 각 문법의 구성 토큰은 연속해야 한다. printable byte, C0, control string, position 이외
  CSI 또는 결합 private mode가 끼면 해당 후보를 취소한다. 이후 frame 안에서 새로 나타난
  정확한 suffix는 다시 후보가 될 수 있다.
- 2026을 포함한 유효한 결합 private-mode reset은 실제 DEC 2026 frame 경계로 latch를
  닫되, singleton strict reset으로 인정하거나 권위 metadata를 붙이지 않는다.
- 앱 이름이나 버전 문자열로 분기하지 않는다. 정확한 바이트 suffix와 기존
  `InitialExecutionHost` gate만 근거로 사용한다.
- Native Windows stabilizer는 어느 문법이든 reset에서 즉시 frame 전체를 tracked write
  하나로 방출하고 `frameEndCursorAuthoritative`를 붙인다. 최종 visibility를 표현하는
  `?25h`는 보존하고, 성공한 transaction 안의 더 앞선 transient show만 제거한다.
- WSL recognizer는 두 문법을 같은 의미로 판정하되 바이트를 보류·삭제·재정렬하지 않는다.
  정확한 reset을 파싱하는 write에만 metadata를 붙인다.
- metadata 소비 규칙은 바꾸지 않는다. reset 시 strict tail의 final position이 이미
  xterm buffer에 적용됐으므로 그 좌표를 shadow cursor로 채택하고 `parkPending`과
  settle timer를 만들지 않는다.
- 기존 show-first 문법, legacy out-of-frame restore, 50ms/1MiB 상한, lexical framing,
  lifecycle reset과 byte-for-byte fail-open 규칙은 유지한다.
- 두 host 구현은 바이트 보류 책임이 달라 별도 상태 머신으로 남기되 같은 문법 fixture와
  부정 테스트로 의미가 어긋나지 않게 고정한다.

## Alternatives Considered

- **Codex를 0.149 이하로 고정한다.** 최신 Codex 사용을 막고 upstream이 의도적으로 제거한
  cursor 노출 문제를 되살리므로 기각한다.
- **새 position-first 문법으로 기존 문법을 교체한다.** Codex 0.145와 기존 trace 호환성을
  깨므로 두 순서를 함께 지원한다.
- **모든 `?2026l`에서 현재 buffer cursor를 권위화한다.** footer에서 frame을 닫는 TUI의
  임의 위치를 입력 caret로 오인하므로 기각한다.
- **position/show 사이의 임의 제어를 허용한다.** 허용 범위가 넓어져 repaint body를
  권위 tail로 오인할 수 있으므로 관측된 두 연속 suffix만 인정한다.
- **Codex activity나 버전을 감지해 분기한다.** 첫 frame보다 activity 판정이 늦을 수 있고
  wrapper·nested 실행에서 버전 판정도 권위가 아니므로 기각한다.
- **PR #950의 composition 우선순위나 settle timeout만 조정한다.** 권위 reset metadata가
  사라진 원인을 고치지 않고 stale cursor fallback을 더 빨리 또는 오래 노출할 뿐이므로
  기각한다.
- **Native Windows와 WSL을 하나의 출력 stabilizer로 합친다.** WSL의 byte-for-byte
  pass-through 계약까지 바꾸므로 문법 의미만 동일하게 유지하고 host별 출력 책임은 보존한다.

## Consequences

- Codex 0.150.0 이후 position-first frame도 Native Windows에서 즉시 원자화되고 WSL에서
  즉시 권위 metadata를 받아 불필요한 restore/park settle 지연을 만들지 않는다.
- Codex 0.145 show-first와 legacy out-of-frame restore는 계속 동작한다.
- 상태 머신과 테스트해야 할 문법 수가 늘어난다. one-chunk와 모든 split boundary,
  position 복수 개, 두 순서의 교차 suffix, 중간 printable/C0/CSI/control-string,
  같은 청크의 여러 reset metadata 범위, timeout·상한·lifecycle fail-open을 고정해야 한다.
- Native Windows 테스트는 final show 보존, 이전 transient show 제거, 즉시 atomic emission,
  `parkDeadline` 부재를 검증한다. WSL 테스트는 원본 바이트 동일성과 정확한 reset write의
  metadata만 검증한다.
- TerminalView 통합 테스트는 두 WSL strict tail 모두 `park-settle-timeout`을 만들지 않는지
  고정한다. 실제 Windows WebView2 IME의 후보창·조합 시각 결과는 자동화가 어려우므로
  dev PTY trace와 사람의 실기 확인을 최종 검증으로 남긴다.
- Codex가 두 strict suffix 밖의 문법으로 다시 바뀌면 임의 허용으로 넓히지 않고 새 trace와
  후속 ADR로 재검토한다.
