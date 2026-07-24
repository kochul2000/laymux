# 0053. 네이티브 Windows 동기화 출력은 xterm 쓰기 경계에서 커서 복원까지 원자화한다

- Status: Accepted
- Date: 2026-07-24
- Source: 사용자 요구(xterm.js 기반 공개 프로젝트의 문제 해결 사례 조사와 laymux 적용 방향 결정); [xterm.js 6.0.0 CompositionHelper](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/browser/input/CompositionHelper.ts#L215-L245); [xterm.js 6.0.0 render hook](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/browser/CoreBrowserTerminal.ts#L385); [xterm.js 6.0.0 CoreService data origin](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/services/CoreService.ts#L48-L64); [xterm-file-manager composition key guard](https://github.com/xxddccaa/xterm-file-manager/blob/d6a732fe79312011419e932b65c108e787143a22/frontend/src/components/terminal/Terminal.tsx#L828-L836); [xterm-file-manager preedit/commit classification](https://github.com/xxddccaa/xterm-file-manager/blob/d6a732fe79312011419e932b65c108e787143a22/frontend/src/components/terminal/terminalIme.ts#L30-L47); [fluxtty post-composition key suppression](https://github.com/amoswzw/fluxtty/blob/b726e9da2b5c958ae7fff8f6be6ba611b049be44/src/input/InputBar.ts#L295-L308); [fluxtty keydown guard](https://github.com/amoswzw/fluxtty/blob/b726e9da2b5c958ae7fff8f6be6ba611b049be44/src/input/InputBar.ts#L364-L379); [Orca output scheduler](https://github.com/stablyai/orca/blob/981653f27d6ef31da4b8e9570129006f46ef4416/src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts#L386-L455); [Orca foreground render settle](https://github.com/stablyai/orca/blob/981653f27d6ef31da4b8e9570129006f46ef4416/src/renderer/src/lib/pane-manager/pane-terminal-foreground-render-settle.ts#L39-L180); [cursor-jump evidence](../terminal/cursor-jump-evidence/README.md); [architecture/data-flow.md §8.3–8.5](../architecture/data-flow.md); [ADR-0001](0001-osc-rust-single-pass.md); [ADR-0008](0008-shell-cursor-shadow-cursor.md); [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md); [ADR-0015](0015-remote-terminal-state-ownership.md); [ADR-0026](0026-conpty-width-resize-repaint-filter.md); [ADR-0052](0052-truecolor-capability-advertising-setting.md)
- Relation: ADR-0008·0011의 shadow cursor 식별 모델을 대체하지 않고, ADR-0015의 PTY-global byte stream/surface-local renderer 분리를 지키며, ADR-0026이 정한 WebView의 xterm write 경계에 네이티브 Windows 출력의 시간적 원자성 책임을 추가한다. ADR-0001의 Rust OSC 단일 패스와 ADR-0052의 xterm.js terminal-emulator reply 소유권은 변경하지 않는다. 프론트 상태 머신은 CSI 오탐을 피하기 위한 ECMA-48 control-string framing만 식별하며, OSC 번호·payload·hook 의미는 계속 Rust만 해석한다.

## Context

laymux는 Codex의 논리적 입력 커서를 ADR-0008의 shadow cursor와 ADR-0011의
DECTCEM cursor park로 추적한다. Codex는 DEC synchronized-output 프레임 안에서
`?25l`로 커서를 숨기고 footer를 그린 뒤, footer 위치에서 `?25h`와 `?2026l`을
보낸다. 약 15ms 뒤 별도 PTY 청크의 `?25l` + CUP + `?25h`로 실제 입력 위치에
커서를 주차한다. 현재 overlay는 `?2026l` 뒤 이 park를 최대 50ms 기다리며 이전
위치에 동결되므로 논리 커서가 footer로 이동하는 문제를 완화한다.

그러나 ConPTY와 IPC의 청크 경계는 TUI의 논리 프레임 경계가 아니다. xterm.js의
synchronized-output 모드는 프레임 안의 렌더를 보류하지만 `?2026l`에서 종료되며,
뒤 청크의 cursor park까지 하나의 표시 트랜잭션으로 보장하지 않는다. 현재
`trackedTerminalWrite` 큐도 바이트 순서·backpressure·reflow 배제는 보장하지만,
서로 다른 출력 청크를 DEC 프레임과 cursor restore 단위로 결합하지 않는다. 따라서
xterm/Chromium이 frame-end와 park 사이의 일시적인 footer 커서를 rasterize할 여지가
남는다. overlay 동결은 상위 논리 커서를 보호할 뿐 xterm native renderer가 어떤
중간 상태를 볼지 통제하지 않는다.

xterm.js 6.0.0은 활성 IME composition의 view와 helper textarea를 현재 buffer cursor에
맞추고, render마다 이 배치를 갱신한다. 따라서 pre-write 안정화가 xterm에 노출하는 마지막
cursor 위치는 native IME 후보창 위치에도 영향을 주지만, composition lifecycle과 helper
focus 자체는 xterm이 계속 소유해야 한다. cursor 표시 문제를 고친다는 이유로 helper를
재생성하거나 blur/focus하거나 composition event를 합성하면 preedit/commit 경계를 바꾸는
별도 입력 회귀가 된다.

downstream xterm.js 앱의 IME 패치도 같은 소유권 경계를 뒷받침하지만 구현은 서로 다르다.
xterm-file-manager는 `KeyboardEvent.isComposing` 또는 legacy `keyCode === 229`이면 앱의
custom key handler를 건너뛰어 xterm의 `CompositionHelper`에 맡기고, 자체 macOS native
text fallback 경로에서만 `beforeinput.inputType`으로 preedit와 commit을 구분한다.
fluxtty는 xterm helper가 아니라 별도 `InputBar`가 commit을 PTY에 직접 보내므로,
`compositionend` 직후 발생하는 IME 확정용 printable keydown 한 번을 제거한다. 전자는
laymux가 보존할 일반 불변식이지만, 후자의 one-shot suppression과 native fallback queue는
각 앱의 별도 입력 경로에 결합된 보정이며 출력 cursor transaction의 일반 해법은 아니다.

공개 사례 가운데 Orca는 로컬 네이티브 Windows ConPTY 출력에 한해 synchronized-output 프레임을
보류·병합하고, 너무 일찍 온 cursor show를 최종 위치 뒤로 재배치한 다음, xterm 파싱
완료 직후와 다음 animation frame에 viewport를 다시 그린다. laymux에서는 이 흐름을
ADR-0011의 cursor park 규칙과 결합한다. ADR-0011에서 **프레임 밖 `?25h`는 권위 있는
cursor park**이므로 프레임 안의 footer `?25h`를 단순히 `?2026l` 뒤로 옮기면 잘못된
footer 위치를 진짜 park로 분류하게 된다.

결정 범위는 PC WebView의 로컬 네이티브 Windows PTY 출력에서 DEC 2026 프레임과
DECTCEM cursor restore를 xterm에 전달하는 순서, 실패 시 원본 보존, 지연·메모리 상한,
shadow cursor와의 관계다. Linux·WSL·browser remote 렌더러, Rust OSC 단일 패스,
backend raw output/cache/WebSocket 계약, xterm.js fork, Codex 자체 수정, 설정 토글,
기존 shadow cursor 교체는 비목표다.

## Decision

**PC WebView는 로컬 네이티브 Windows PTY의 완전한 DEC 2026 프레임과 뒤따르는 최종 DECTCEM cursor restore를 xterm write 직전의 하나의 bounded 표시 트랜잭션으로 만든다.**

- 안정화 상태는 surface-local renderer 상태다. attach 세대가 정리한 live foreground
  delta가 기존 ConPTY resize repaint filter를 지난 뒤, 공통 tracked xterm write 큐에
  들어가기 전에 terminal별 스트리밍 상태 머신을 통과한다. filter가 timeout이나 취소로
  방출한 live delta도 같은 경계를 따른다. Rust PTY 콜백의 OSC 파싱·액션 디스패치, raw
  output ring, session output sequence, cache 및 remote WebSocket 바이트는 변경하지 않는다.
  attach snapshot/cache replay는 변환하지 않으며, attach의 parsed 완료 신호는 보류
  시점이 아니라 실제 xterm write callback 뒤에 전달한다.
- 상태 머신은 문자열 디코딩이나 정규식이 아니라 `Uint8Array` 바이트를 처리하며 PTY
  청크 경계를 넘어 `CSI ? 2026 h/l`, `CSI ? 25 h/l`, `CUP`(`H`/`f`) 및
  `CHA`(`G`) 경계를 추적한다. 여기서 재작성 판단에 관련된 제어는 singleton private
  mode `?2026h/l`·`?25h/l`과 위 절대 위치 제어뿐이다. OSC는 BEL 또는 ST, DCS·APC·PM·SOS는
  ST까지의 7-bit ECMA-48 framing만 식별하여 그 payload 안의 CSI 모양 바이트를 건너뛴다.
  OSC 번호·payload·hook 의미는 해석하지 않으며 control string 전체와 완결된 일반 CSI,
  UTF-8/non-control 바이트를 그대로 보존한다. 관련 private mode의 결합 파라미터,
  중첩·불균형 DEC 2026, 제한 길이를 넘은 partial CSI 또는 control string만 모호성으로 본다.
  transaction 재작성 상태와 control-string lexical 상태는 서로 독립적이며, transaction을
  fail-open하더라도 아직 닫히지 않은 control string의 lexical 문맥은 잃지 않는다.
- 활성화 여부의 SoT는 Rust가 PTY spawn 직전에 확정한 **초기 launcher**다. Rust는 실제
  `CommandBuilder`에 넘길 `cmd_path`의 대소문자를 무시한 basename과 target OS로
  `InitialExecutionHost = NativeWindows | Wsl | DirectSsh | NonWindows | Unknown`을
  산출한다. Windows에서 정상 파싱된 `wsl[.exe]`는 `Wsl`, `ssh[.exe]`는 `DirectSsh`,
  그 밖의 정상 파싱된 spawn target은 `NativeWindows`, 비-Windows build는 `NonWindows`,
  파싱 실패·metadata 누락은 `Unknown`이다. 오직 `NativeWindows`만 활성화하며 나머지는
  즉시 pass-through한다. UI는 `navigator.userAgent`, profile 이름, 원래 command 문자열,
  앱 이름이나 늦게 도착하는 activity 분류로 이 값을 다시 추측하지 않는다.
- 이 metadata는 terminal 생성 결과의 immutable 필드다. attach coordinator는 생성 결과와
  renderer gate를 먼저 결합한 뒤에만 그 session의 buffered live delta를 drain하므로 첫
  delta도 판별 전에 변환되지 않는다. browser remote renderer에는 이 생성 계약이 없으므로
  항상 bypass한다. 직접 실행한 WSL/SSH는 제외되지만 native shell 안에서 나중에 시작한
  nested WSL/SSH까지 초기 launcher가 식별한다고 주장하지 않는다.
- 상태는 `PassThrough`, `HoldingFrame`, `AwaitingRestore` 세 가지다. `PassThrough`에서
  singleton `?2026h`를 만나면 그 marker부터 보류하고 `HoldingFrame`으로 전이한다. 첫
  singleton `?2026l`에서 `AwaitingRestore`로 전이하며, 그 전의 반복 `?2026h` 또는 reset
  없는 불균형 시퀀스는 현재 후보를 원본 그대로 방출한다. `AwaitingRestore`에서 새
  `?2026h`가 먼저 오면 이전 후보는 원본 그대로 방출하고 새 marker부터 별도 후보를
  시작한다. 이 규칙으로 연속 프레임을 서로 합치지 않는다. 청크 끝의 partial CSI는 다음
  청크까지 bounded prefix로 유지하며 그 자체를 오류로 취급하지 않는다.
- 인정하는 최종 restore의 바이트 문법은 `?2026l` 직후부터 정확히 singleton `?25l` →
  하나 이상의 `CUP`/`HVP`/`CHA` → singleton `?25h` 순서다. 청크 끝의 incomplete prefix만
  다음 청크까지 기다린다. 이 문법 밖의 완결된 control string, C0, 일반·private CSI,
  printable byte가 하나라도 먼저 오거나 restore 요소 사이에 끼면 후보 전체를 즉시
  byte-for-byte fail-open한다. 완전한 restore가 확인되면 frame과 restore를 tracked writer의
  단일 요청으로 enqueue한다.
- 정확한 최종 restore가 확인된 경우에만 같은 트랜잭션의 in-frame singleton `?25h`를
  제거한다. 최종 restore의 `?25l`, position, `?25h` 바이트와 순서는 전혀 바꾸지 않으며,
  `?25h` 뒤에 position이 오는 패턴은 재배치하지 않고 fail-open한다. 특히 in-frame show를
  `?2026l` 뒤로 이동시켜 가짜 out-of-frame park를 만들지 않는다.
- 변환 뒤 xterm parser가 보는 최종 버퍼·커서 visibility와 애플리케이션이 보낸 최종
  상태는 원본과 같아야 한다. ADR-0011의 parser hook은 보존된 out-of-frame `?25h`를
  계속 권위 park로 관측하며 shadow cursor/IME overlay가 해당 위치를 사용한다.
- 활성 IME composition은 xterm.js의 `CompositionHelper`가 계속 소유한다. stabilizer는
  PTY output byte의 write 시점만 제어하고 user input·composition event를 보류하거나
  변환하지 않는다. `.xterm-helper-textarea`/`.composition-view`를 직접 재배치·재생성하거나,
  helper를 blur/focus하거나, textarea value를 초기화하거나, synthetic composition event를
  보내지 않는다. 실제 write callback 뒤의 public refresh가 xterm의 정상 `onRender` 경로를
  일으켜 helper를 최종 buffer cursor에 맞추게 하고, laymux overlay도 같은 최종 park를
  사용한다. private `CompositionHelper` 접근은 금지한다. 기존 custom keyboard handler도
  browser가 `isComposing` 또는 `keyCode === 229`로 표시한 일반 조합 키를 앱 단축키나
  stabilizer 경로에서 소비하지 않는다는 불변식을 유지한다. 다만 진행 중 조합을 stale
  범위로 강제 finalize하는 OS IME mode-switch key에 대한 기존 명시적 차단은 유지한다.
- 첫 `?2026h`를 보류한 monotonic 시각을 `frameStartAt`으로 기록하고 absolute hold deadline을
  `D_hold = frameStartAt + 50ms`로 정의한다. `HoldingFrame`과 `AwaitingRestore`가 `D_hold`를
  공유하며 `?2026l`에서 타이머를 다시 시작하지 않는다. post-frame restore는 확인 즉시
  방출하고, 열린 프레임이나 restore 대기는 `D_hold`에서 원본을 fail-open한다. 별도의 입력
  시각 휴리스틱은 두지 않는다. 보류 데이터와 partial CSI/control-string prefix를 합친 크기는
  기존 단일 write chunk 상한인 1MiB를 넘지 않는다. 구현 PR에서 시간·크기 상수를 한 모듈과
  테스트로 고정한다.
- 상태 머신이 `?2026l`을 관측한 monotonic 시각을 `frameEndAt`으로 기록하고 ADR-0011의 park
  settle deadline을 `D_park = frameEndAt + 50ms`로 계산해 renderer-local write metadata에
  싣는다. `D_hold`와 `D_park`는 서로 다른 절대 deadline이다. stabilizer가 원본을 늦게
  fail-open해 xterm parser가 뒤늦게 frame-end를 보더라도 park settle은 `D_park`까지 남은
  시간만 사용하며 xterm 관측 시점부터 새 50ms를 시작하지 않는다. 이미 `D_park`가 지났으면
  즉시 settle한다. 완전한 restore는 같은 write에서 권위 park를 확정하므로 pending settle을
  남기지 않는다.
- 안정화는 xterm.js가 live PTY output을 파싱해 생성하는 terminal protocol reply를
  가로채거나 human input으로 재분류하거나 애플리케이션의 응답 기한 밖으로 지연시키지
  않는다. OSC 10/11을 프론트에서 의미 해석하지 않고도, 위 50ms hard deadline으로 어떤
  live query도 stabilizer 때문에 50ms보다 오래 xterm parser 앞에 머물지 않게 한다. 이는
  **stabilizer가 추가하는 지연의 상한**이며 PTY까지의 end-to-end 전달 보장을 뜻하지 않는다.
  xterm.js의 terminal-emulator reply 소유권을 유지하고 Rust나 프론트엔드에 OSC 중복
  응답기를 추가하지 않는다. terminal-generated reply를 사용자 입력용 remote-control
  gate와 분리하는 기존 버그 수정 및 100ms 통합 테스트 통과를 구현 활성화의 선행조건으로 둔다.
- 이 선행 수정은 keyboard·IME·paste·mouse·focus에서 발생하는 human input을 xterm의 data
  emission 전에 owner-gate한다. 거부된 human input은 xterm data 경로에 진입하지 않는다.
  terminal surface는 tracked writer의 source context로 live PTY parse와 cache/snapshot replay를
  구분하고, live parse가 만든 terminal protocol reply는 전용 PTY 경로로 전달하며 replay가
  만든 reply는 억제한다. 공개 `terminal.onData`가 `wasUserInput`을 노출하지 않는 한 응답
  바이트 패턴의 allowlist/denylist로 출처를 추정하지 않는다. 이 계약을 만족한 뒤에만 일반
  `onData` 경로에서 사용자 입력용 `localTerminalControlAllowed()` gate를 제거한다.
- 같은 attach 세대 안의 restore 부재, timeout, 크기 상한, 모호한 관련 시퀀스 또는 파서
  불일치는 보류한 바이트를 **원래 순서와 값 그대로 fail-open 방출**하고 상태를 초기화한다.
  최종 restore를 확인하지 않은 채 `?25h`를 삭제하거나 합성하지 않는다. xterm
  backpressure가 발생하면 기존 큐와 동일하게 원본 트랜잭션을 보존해 재시도한다. 단,
  OSC·DCS·APC·PM·SOS 내부에서 timeout 또는 크기 상한에 도달하면 transaction 바이트는 즉시
  방출하되 lexical 상태는 `PassThroughUntilTerminator`로 전이한다. 이 상태는 추가 데이터를
  보류하지 않고 그대로 전달하면서 OSC의 BEL/ST 또는 나머지 control string의 ST만 찾으며,
  종결 뒤에만 새 transaction 탐지를 허용한다. split ST 판정을 위해 직전 바이트가 ESC였는지만
  기억하고 바이트 자체는 보류하지 않는다. 종결자가 오지 않으면 해당 attach 세대의 나머지
  출력은 안정화하지 않는다.
- attach gap은 뒤따르는 authoritative snapshot이 화면 상태를 대체하므로 이전 세대의
  보류 바이트를 새 세대에 방출하지 않고 폐기한다. superseded attach epoch·profile 교체도
  이전 세대의 보류 바이트와 callback을 폐기하며, unmount는 보류 바이트를 폐기하고 모든
  timeout·stale `requestAnimationFrame`을 취소한다. 새 attach 세대에서는 transaction과
  lexical 상태를 모두 초기화한다. 이 lifecycle 폐기는 같은 세대의 fail-open과 구분하며
  snapshot과 stale delta의 중복 적용을 막는다.
- 안정화된 트랜잭션의 xterm write callback 뒤 visible viewport를 public
  `terminal.refresh(0, rows - 1)`로 갱신하고 다음 `requestAnimationFrame`에 한 번 더
  갱신한다. 이 settle 경로는 `fit()`, `clearTextureAtlas()` 또는 xterm private API를
  호출하지 않으며 hidden surface에는 기존 visible 복구 규칙을 적용한다. 이는
  `data-flow.md` §8.4의 geometry 외 refresh 제한에 대한, 완성된 synchronized-output
  transaction에만 적용되는 좁은 예외다.
- 순수 바이트·상태 전이는 별도 UI 라이브러리 모듈이 소유하고 terminal surface는 host
  gate, 세대 lifecycle, 타이머, tracked writer 및 refresh orchestration만 담당한다.
  resize repaint filter와 새 stabilizer는 독립 상태 머신으로 유지한다. Remote lease 중
  PC renderer는 계속 surface-local 출력을 소비하므로 안정화를 유지하지만, 별도 browser
  xterm renderer는 이번 결정 범위에 포함하지 않는다.

## Alternatives Considered

- **ADR-0011의 shadow cursor 동결만 유지:** 논리 overlay 위치는 보호하지만 xterm과
  Chromium이 frame-end와 후속 park 사이의 native cursor 상태를 보지 못하게 하지는
  못하므로 기각했다.
- **in-frame `?25h`를 `?2026l` 뒤로 이동:** 일반 xterm에서는
  transient cursor를 줄이지만 laymux는 그 show를 권위 park로 해석하여 footer 좌표를
  저장한다. ADR-0011과 충돌하므로 최종 park를 보존하고 redundant show만 조건부로
  제거하는 변형을 선택했다.
- **모든 `?25h`를 전역 제거하거나 Codex 출력을 문자열 치환:** restore가 없는 앱,
  WSL·remote 및 청크 분할에서 커서가 영구적으로 숨을 수 있다. 완전한 대체 restore를
  확인한 경우만 변환하는 스트리밍 상태 머신을 선택했다.
- **Rust PTY 콜백에서 프레임을 재작성:** 한 번만 처리할 수 있지만 renderer별 paint
  시점과 rAF는 Rust가 소유하지 않는다. backend raw output·cache·remote 소비자까지
  변형하고 ADR-0001의 OSC 책임과 별개인 표시 정책을 전역화하므로 기각했다.
- **Windows의 모든 ConPTY 세션에 적용하여 WSL도 포함:** WSL 프로필도 Windows의 동일한
  PTY backend를 거치므로 분기가 단순하고 WSL TUI에도 이득을 줄 수 있다. 그러나 이번
  결정은 실측한 native Codex 경로만 승인하며 WSL·SSH 출력에는 같은 cursor restore
  계약이 확인되지 않았다. 잘못된 범위의 cursor show 변환은 영향이 크므로, 실행 대상을
  명시하는 보수적 positive gate를 먼저 채택했다.
- **Codex activity일 때만 활성화:** activity 판정은 출력과 process-tree 이벤트 뒤에
  도착할 수 있어 첫 프레임을 놓치며, protocol상 동일한 안전 패턴을 앱 이름으로
  제한한다. transport/profile gate와 완전한 frame/restore 증거를 사용하기로 했다.
- **xterm.js fork 또는 private `_core.refresh` 사용:** upstream 추적 비용과 버전 결합을
  늘린다. bounded pre-write 트랜잭션과 public refresh로 먼저 해결하고, 공개 API로
  검증할 수 없는 renderer 결함이 실측될 때만 재검토한다.
- **downstream 앱의 IME fallback을 함께 도입:** xterm-file-manager의 macOS native text
  fallback queue와 fluxtty의 composition 직후 one-shot printable-key suppression은 각각
  custom native fallback과 별도 `InputBar`가 commit을 직접 PTY에 쓰는 구조를 보정한다.
  laymux의 xterm helper 경로에 동일 로직을 추가하면 정상적인 composition 직후 첫 글자를 버리거나
  xterm commit과 중복 전송할 수 있다. 공통적으로 입증된 “조합 키를 앱 handler가 가로채지
  않는다”는 소유권 불변식만 채택하고, post-composition suppression은 WebView2에서 같은
  이벤트 순서와 유령 입력이 재현되는 별도 버그 PR에서 테스트를 먼저 추가하기로 했다.
- **플랫폼별 helper blur/focus refresh를 함께 도입:** stale input context를 고치는 별도 입력
  문제이며 output transaction의 책임이 아니다. 재현 근거 없이 적용하면 진행 중 composition을
  종료하거나 commit을 중복시킬 수 있으므로 이번 결정에서는 xterm의 기본 composition
  lifecycle을 보존한다.

## Consequences

- 정상 Codex park 패턴에서는 footer의 in-frame show가 native cursor로 표시되지 않고
  최종 입력 위치가 같은 xterm write에 포함된다. shadow cursor도 같은 최종 park를
  계속 사용하므로 native/overlay/IME 커서의 시간적 기준이 일치한다.
- 첫 frame marker부터 50ms 안에 restore가 도착하는 정상 프레임은 패턴 확인 즉시 표시된다.
  열린 프레임과 restore 부재 모두 최초 hold부터 최대 50ms 뒤 원본 경로로 복귀하며, 1MiB
  상한으로 terminal별 메모리 사용을 제한한다. `D_park`는 실제 `frameEndAt`부터 최대 50ms만
  허용하므로 xterm의 지연된 관측 뒤 새 50ms가 추가되지 않는다. frame-end가 `D_hold` 직전에
  온 restore 부재 후보의 overlay 동결은 frame start부터 최대 약 100ms가 될 수 있으며,
  frame-end 기준 추가 동결은 최대 50ms다.
- 프레임 자체가 길면 restore 대기에 쓸 수 있는 시간이 줄어들어 유효한 트랜잭션도 fail-open할
  수 있다. 이 경우 바이트와 최종 터미널 상태는 보존되지만 커서 점프 완화율은 낮아진다.
  실측 트레이스에서 이 경로가 반복되면 OSC 응답 기한을 침범하지 않는 더 좁은 식별 정책을
  후속 결정으로 검토한다.
- 완전한 최종 restore가 있을 때만 redundant show를 제거하므로 최종 버퍼와 visibility는
  유지된다. 실패 경로는 원본을 그대로 방출하지만, 그 경우 기존 shadow cursor가 제공하는
  완화 수준으로 돌아가므로 순간적인 native cursor가 다시 보일 수 있다.
- 구현은 바이트 파서·타이머·기존 write/backpressure 큐의 결합 복잡도를 추가한다.
  순수 상태 머신 테스트는 실측 `codex-footer-frame`을 사용해 모든 바이트 분할 지점,
  UTF-8/non-control 바이트 보존, 연속·중첩·반복 프레임, exact restore 순서,
  결합/불완전 CSI, BEL/ST로 끝나는 split OSC·DCS와 payload 안의 CSI 모양 바이트,
  `D_hold`/`D_park` 산식과 deadline 비재시작, 크기 상한 및 byte-for-byte fail-open을 검증해야
  한다. 특히 열린
  control string에서 timeout·1MiB 상한으로 fail-open한 뒤 남은 payload에 가짜 DEC 2026과
  exact restore를 여러 청크로 주입해 종결 전에는 어떤 바이트도 변형하지 않는지 고정한다.
  변환 전후 xterm buffer·cursor mode의 최종 상태가 같은지도 trace replay로 비교한다. surface
  통합 테스트는 snapshot/live-delta 경계, 단일 enqueue, backpressure 재시도, parser hook의
  최종 park 관측, frame-end absolute deadline 공유, immediate+rAF refresh, 세대 교체 뒤
  stale rAF 취소를 검증한다.
- 플랫폼 계약 테스트는 `InitialExecutionHost`의 각 값과 metadata 누락을 고정하고,
  `NativeWindows`만 활성화되며 직접 WSL·SSH, non-Windows, browser remote 및 unknown은
  pass-through임을 검증한다. 실제 dev Codex headful 검증은 입력 중 화면을 연속 캡처해
  cursor가 입력 행에만 있고 `Working`/footer 행에는 DOM/WebGL cursor pixel이 나타나지
  않는지 확인한다. 외부 Codex 버전에 의존하지 않는 트레이스 replay가 CI 정본이다.
- live OSC 10/11 질의를 DEC 2026 후보의 시작·중간·청크 경계에 각각 배치해 stabilizer
  추가 지연이 50ms를 넘지 않는지 검증하고, `?2026l` 직후에 배치한 OSC 질의는 즉시
  fail-open하는지 확인한다. 별도 protocol-reply 회귀 테스트는 keyboard·IME·paste·mouse·focus
  각각에서 거부된 human input이 xterm data 경로에 진입하지 않는지, live parser reply만 전용
  PTY 경로를 사용하는지, cache/snapshot replay의 reply가 PTY에 전송되지 않는지 검증한다. 또한
  `localTerminalControlAllowed()`가 false이거나 아직 확정되지 않은 때에도 xterm.js가 생성한
  응답이 사용자 입력 gate와 독립적으로 100ms 안에 PTY로 전달되는지 고정한다. 이 테스트와
  관련 버그 수정이 통과하기 전에는 stabilizer를 활성화하지 않는다.
- 활성 composition 도중 split DEC 2026 frame과 exact restore를 주입하는 통합 테스트는
  preedit text와 focus가 유지되고, synthetic composition event 없이 helper와 laymux IME
  preview가 실제 write callback 및 다음 animation frame 뒤 같은 최종 park를 가리키며,
  commit text가 누락·중복 없이 한 번만 PTY로 전달되는지 검증한다. 같은 테스트 묶음은
  `isComposing === true`와 `keyCode === 229`인 일반 조합 keydown이 앱 단축키 경로에 소비되지
  않는지 고정하되, fluxtty식 post-composition printable-key suppression은 구현하지 않는다.
- Rust→WebView의 terminal 생성 결과에는 비영속 initial-execution-host metadata가 추가되며 Rust와
  TypeScript 계약 테스트가 필요하다. 설정·Automation/Remote API·영속 세션 스키마
  마이그레이션은 없다. 구현 PR은 `docs/architecture/data-flow.md` §8.4–8.5에 write
  경계·상태 소유권·ECMA-48 lexical framing과 Rust semantic OSC 소유권의 구분·park
  absolute deadline 공유·검증 절차를 동기화한다. 사용자 요청이 없는 한
  `docs/terminal/` research 정본은 수정하지 않는다.
- native shell 안에서 나중에 실행한 임의 wrapper나 nested SSH는 생성 시점 transport
  metadata만으로 완전히 식별할 수 없다. 완전한 restore 증거와 byte-for-byte fail-open이
  최종 커서 의미를 보호하지만, 실측에서 비호환 패턴이 발견되면 process-tree 기반 실행
  host metadata 또는 더 좁은 positive gate를 후속 결정으로 검토한다.
- Codex가 frame-end 전에 정확한 위치로 커서를 복원하거나, xterm.js가 후속 cursor
  restore까지 공개 transaction API로 묶거나, 계측에서 50ms 상한이 입력 지연 또는
  park 누락을 만든다고 확인되면 이 결정을 재검토한다.
