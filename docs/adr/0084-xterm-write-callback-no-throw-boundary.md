# 0084. xterm write 완료 콜백은 예외가 빠져나가지 않는 경계다

- Status: Accepted
- Date: 2026-07-28
- Source: 사용자 보고(issue #624: 출력 폭주 누적 뒤 xterm discard 경고와 dev 프로세스 종료) · [architecture/data-flow.md §8.4·§8.8](../architecture/data-flow.md) · [ADR-0026](0026-conpty-width-resize-repaint-filter.md) · [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md) · [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)
- Extends: [ADR-0080](0080-output-backlog-coalescing-and-out-of-band-frontend-vitals.md)의 visible xterm single-flight FIFO 완료 경계
- Relation: [ADR-0072](0072-terminal-output-gap-sequence-exact-repair.md)의 delivery gap 복구와 달리, 이 결정은 xterm이 이미 수락해 파싱한 바이트 뒤의 embedder 완료 작업을 다룬다. [ADR-0026](0026-conpty-width-resize-repaint-filter.md)의 backpressure 동일 청크 재시도 계약은 유지한다.

## Context

issue #624의 최초 실기는 PR #622 최종 single-flight 구현이 들어오기 전 코드에서 나왔다. 당시 visible write drain은 여러 `terminal.write()`를 callback 대기 없이 한 번에 제출할 수 있었고, xterm 6.0.0의 약 50 MB 내부 pending watermark를 넘으면 `write data discarded, use flow control to avoid losing data`가 동기로 발생했다. PR #622 최종 구현은 physical write를 callback 단위로 하나만 허용하고, 거절된 batch 객체와 buffer를 FIFO 선두에 복원해 이 직접 축적 경로를 닫았다.

그러나 xterm 6.0.0의 `WriteBuffer._innerWrite`에는 더 강한 embedder 계약이 있다. xterm은 바이트 파싱 뒤 callback을 먼저 호출하고, callback이 정상 반환한 다음에야 buffer offset을 전진시키고 `_pendingData`에서 해당 길이를 빼며 다음 drain을 예약한다. callback이 예외를 던지면 바이트는 이미 파싱됐지만 xterm의 accounting과 drain은 끝나지 않는다. 반면 laymux callback은 자신의 `pendingTerminalWrites`를 먼저 0으로 내리고 다음 FIFO task를 예약하므로, 예외가 빠져나가면 laymux는 새 write를 계속 제출하고 xterm은 이전 pending을 지우지 못한다. 결국 watermark 거절이 반복되고 logical queue와 로그가 함께 자랄 수 있다.

visible callback은 parse 지연 metric, synchronized-output monitor, logical `onParsed` waiter, stabilized renderer settle, 다음 write 또는 fit hand-off를 한 경계에서 실행한다. 어느 하나의 부가 작업 실패도 이미 파싱된 바이트를 재시도할 근거가 아니다. 재시도하면 exactly-once를 깨고, 예외를 그대로 올리면 xterm의 내부 완료를 막는다. 실패를 조용히 삼키면 원 실기에서처럼 ADR-0072 gap 카운터가 0인 채 원인을 찾지 못한다.

최근 dev `crash.log`와 Windows Application/WER 기록에는 issue #624 시각의 Rust panic 또는 laymux/WebView crash가 남아 있지 않았다. 따라서 프로세스 exit 1의 OS 직접 원인을 OOM이나 특정 unhandled exception으로 확정하지 않는다. 이 결정의 범위는 증거로 고정할 수 있는 xterm downstream admission·completion 불변식과 진단이며, backend PTY read flow control, ring 크기, WebView 프로세스 복구 정책은 비목표다.

## Decision

**visible xterm이 수락한 write의 callback은 모든 완료 작업을 독립적으로 시도하되 어떤 예외도 xterm으로 되돌려 보내지 않으며, 수락된 바이트는 callback 후 실패를 이유로 다시 쓰지 않는다.**

- visible FIFO는 ADR-0080대로 single-flight다. callback이 돌아오기 전에는 다음 physical write를 제출하지 않는다. xterm이 watermark로 동기 거절한 write만 “미수락”으로 분류해 materialize된 같은 batch 객체와 같은 buffer를 FIFO 선두에 복원하고 16 ms 뒤 재시도한다.
- callback 진입 즉시 laymux의 in-flight parse context를 종료한다. 그 뒤 parse metric, synchronized-output monitor, logical consumer callback, stabilized renderer settle, 다음 FIFO/fit hand-off를 단계별 예외 경계에서 실행한다. 한 단계 실패가 뒤 단계를 건너뛰게 하지 않는다.
- logical `onParsed`는 해당 accepted batch에 대해 최대 한 번 호출한다. 호출 자체가 실패해도 `onDiscard`로 바꾸거나 batch를 재시도하지 않는다. xterm parser는 이미 바이트를 처리했으므로 재시도는 중복 출력이다.
- completion 단계의 모든 실패는 terminal 세션 수명의 진단 카운터에 누적한다. 전체 횟수와 `live`/`replay` source, `metrics`/`monitor`/`consumer`/`refresh`/`drain`/`unknown` stage를 각각 구분한다.
- 경고에는 terminal byte를 싣지 않고 source, attach epoch, batch id 범위, stage와 오류 메시지만 남긴다. 같은 pane mount에서 같은 `source + stage` 조합은 최초 한 번만 경고하고 카운터는 이후에도 모두 센다. 오류 폭주가 console 폭주로 증폭되는 것을 금지한다.
- callback 진단 자체도 no-throw다. 카운터 또는 console 기록 실패가 xterm accounting을 다시 막지 않는다.
- callback 실패는 ADR-0072의 delivery gap이 아니다. 바이트가 xterm에 도달해 파싱된 뒤의 로컬 부가 작업 실패이므로 sequence repair를 시작하거나 coordinator의 expected sequence를 되감지 않는다.
- 다음 animation frame의 2차 stabilized refresh도 예외를 포착해 같은 source/stage 규율로 진단한다. 이미 끝난 physical callback의 drain을 되돌리지는 않는다.

## Alternatives Considered

- **동기 `write data discarded`만 catch하고 같은 batch를 계속 재시도한다.** 살아 있는 xterm parser가 backlog를 비우는 경우에는 맞지만 callback 예외로 parser accounting이 고착된 경우 영원히 같은 watermark를 만난다. 원인을 만들기 전의 callback 경계를 보호하지 못해 기각했다.
- **accepted callback 작업이 실패하면 batch를 재시도한다.** callback은 파싱 완료 뒤 호출된다. 같은 byte를 다시 쓰면 화면·terminal reply·cursor state가 두 번 적용되어 ADR-0072의 exactly-once 순서를 직접 깨므로 기각했다.
- **첫 callback 실패에서 나머지 완료 단계를 중단한다.** monitor 실패가 Promise waiter 또는 FIFO hand-off를 영구 정지시킬 수 있다. 단계가 서로의 성공 조건이 아니므로 독립 실행을 선택했다.
- **예외를 microtask에서 다시 던진다.** xterm accounting은 살릴 수 있지만 WebView 전역 unhandled exception을 의도적으로 만들며 issue #624의 프로세스 종료 위험을 유지한다. 구조화 진단으로 대체했다.
- **예외를 아무 기록 없이 삼킨다.** byte 순서는 보존하지만 renderer 또는 waiter 결함을 실기에서 찾을 수 없다. ADR-0080의 out-of-band 관측 목적과 충돌해 기각했다.
- **frontend queue 대신 PTY reader를 xterm 소비 속도에 직접 묶는다.** backend ring·Tauri event·Remote subscriber·ConPTY deadlock 경계를 함께 바꾸는 별도 결정이다. ADR-0072가 PTY read thread를 WebView 속도에 묶지 않는 이유를 뒤집으므로 이 범위에서 기각했다.

## Consequences

- post-parse renderer/consumer 결함이 있어도 xterm은 accepted byte 길이를 pending에서 빼고 다음 write를 계속 처리할 수 있다. callback 실패가 watermark discard 루프로 증폭되지 않는다.
- 한 단계 실패 뒤에도 다른 logical waiter와 FIFO hand-off는 실행된다. 바이트는 accepted write마다 정확히 한 번 파싱되고 callback 실패 때문에 중복 제출되지 않는다.
- renderer settle 자체는 실패할 수 있다. 이 결정은 그 시각 결함을 성공으로 위장하지 않고 `writeCallbackRefreshFailures`와 최초 경고로 드러내되 output stream 정확성과 xterm liveness를 우선한다.
- out-of-band frontend diagnostics의 pipeline payload에 callback failure 카운터가 추가된다. source/stage 조합의 최초 경고만 남으므로 장시간 폭주에서도 로그량은 terminal mount당 유한하다.
- component 회귀 테스트는 xterm의 “callback 후 pending 차감” 순서를 작은 watermark로 모사한다. renderer settle 실패가 반복돼도 callback이 정상 반환하고 후속 byte가 FIFO 순서로 정확히 한 번 drain되며, 카운터는 전부 증가하고 경고는 source+stage당 한 번뿐임을 고정한다.
- 원 issue의 dev 시나리오는 최종 코드로 다시 측정해야 한다. discard 0, 프로세스 생존, byte stream 순서, `writeCallbackFailures`의 실제 값이 완료 조건이다. 값이 0이면 기존 multi-flight가 원 관측의 충분한 원인이었다는 근거가 되고, 값이 증가하면 stage별 카운터로 별도 결함을 좁힌다. 어느 경우에도 현 기록만으로 과거 exit 1의 OS 원인을 확정하지 않는다.
- xterm 버전을 올릴 때 callback과 pending accounting 순서가 바뀌었는지 확인한다. 순서가 바뀌어도 no-throw embedder 경계는 안전하지만, 테스트의 upstream 계약 설명과 재현 harness는 새 버전에 맞춰 재검토한다.
