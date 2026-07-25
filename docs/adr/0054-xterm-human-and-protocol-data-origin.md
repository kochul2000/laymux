# 0054. xterm 사용자 입력과 터미널 프로토콜 응답의 출처를 분리한다

- Status: Accepted
- Date: 2026-07-25
- Source: 사용자 머지 요청; [PR #525 최종 리뷰](https://github.com/kochul2000/laymux/pull/525); [xterm.js 6.0.0 CoreService](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/services/CoreService.ts#L48-L64); [architecture/data-flow.md §8.8](../architecture/data-flow.md); [ADR-0015](0015-remote-terminal-state-ownership.md); [ADR-0052](0052-truecolor-capability-advertising-setting.md); [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)
- Relation: ADR-0015의 human-control owner 권한 경계와 ADR-0052의 terminal-emulator protocol reply 소유권을 유지한다. ADR-0053의 tracked xterm write source 분류를 보완하며 기존 ADR을 대체하지 않는다.

## Context

xterm.js 6.0.0의 `CoreService.triggerDataEvent(data, wasUserInput)`는 두 종류의
데이터를 같은 공개 `Terminal.onData`로 내보낸다. 키보드·IME·paste 같은 human
input은 `wasUserInput=true`이고, OSC 10/11이나 DSR 같은 parser-generated terminal
reply는 `false`다. 그러나 공개 `onData` callback은 문자열만 제공해 이 origin bit를
잃는다. 반대로 내부 `CoreService.onUserInput`은 human data를 `onData` 직전에
동기적으로 알린다.

Remote가 PTY를 소유하거나 Local owner snapshot이 아직 오지 않은 동안 laymux는
human input을 fail-closed해야 한다. 기존 xterm 6.0.0의 `disableStdin`은
`wasUserInput`을 검사하기 전에 모든 `triggerDataEvent`를 반환하므로 human input뿐
아니라 OSC 10/11 응답도 버린다. 이 응답은 xterm이 현재 색상처럼 브라우저 렌더러가
소유한 상태를 바탕으로 만들어야 하므로 Rust가 대신 합성할 수도 없다.

DOM capture event만으로 origin을 복원하는 것도 충분하지 않다. xterm의
`CompositionHelper`는 `compositionend`의 최종 commit을 다음 macrotask로 미룰 수
있고, 동시에 parser write callback이 살아 있으면 그 commit을 live parser reply로
오분류할 수 있다. 반대로 focus report는 xterm이 `wasUserInput=false`로 내보내지만
실제 DOM focus gesture에서 비롯되므로 DOM origin도 보조 신호로 필요하다. 문자열
형태나 protocol reply allowlist로 분류하면 사용자 입력과 유효한 terminal reply가
같은 바이트를 가질 수 있어 권한 경계를 만들 수 없다.

결정 범위는 PC WebView의 xterm `onData`에서 human input과 parser-generated reply를
구분하고 각 backend 경로로 전달하는 계약이다. Rust OSC 파싱, Remote 웹 surface의
입력 모델, IME helper textarea의 focus/composition 소유권, protocol byte 목록은
비목표다.

## Decision

**xterm CoreService의 origin bit를 보존해 human input은 owner-gated 경로로, live parser reply는 전용 non-human 경로로 보낸다.**

- 고정 버전 xterm 6.0.0의 ESM·CommonJS 배포 번들에서 `disableStdin` gate를
  `disableStdin && wasUserInput`으로 좁힌다. 따라서 Local input이 허용되지 않을 때
  human data만 xterm 내부에서 차단하고 parser-generated reply는 공개 `onData`까지
  도달한다. `postinstall` 패치는 정확한 원문 패턴과 패치 결과를 검사해
  idempotent하게 적용하며, 의존성 버전이나 minified 형태가 바뀌면 조용히 건너뛰지
  않고 설치를 실패시킨다.
- PC WebView는 고정 버전의 private
  `terminal._core.coreService.onUserInput`을 좁은 adapter 하나에서만 구독한다.
  이 동기 신호가 바로 뒤의 `onData`를 human으로 표시하므로 DOM event가 끝난 뒤
  지연된 IME commit도 live parser source와 겹치더라도 protocol로 승격되지 않는다.
  한 번의 origin 표시는 한 번의 `onData`에서만 소비하고, 계약이 바뀌어 `onData`가
  오지 않으면 microtask에서 폐기한다.
- wrapper의 capture-phase DOM 표시는 보조 신호로 유지한다. 특히 xterm이
  `wasUserInput=false`로 생성하는 mouse/focus report를 실제 human gesture와 연결한다.
  private origin 구독에 실패하면 live write 중의 모호한 `onData`도 human으로
  fail-closed한다. 이 경우 protocol reply가 유실될 수는 있어도 Remote owner를
  우회해 사용자 바이트가 PTY로 전달되어서는 안 된다.
- `replay` source에서 나온 reply는 계속 폐기하고, 신뢰 가능한 origin 신호 아래
  `live` parser write에서 나온 non-human data만
  `write_terminal_protocol_reply`로 보낸다. human route는 전송 직전에 frontend의
  Local owner 상태를 다시 확인하고 backend owner permit을 요구하는 기존
  `write_to_terminal`을 사용한다. backend permit이 최종 권한 경계다.
- source 문자열, 특정 OSC/CSI 응답 목록, 타이밍 길이만으로 origin을 추정하지 않는다.
  설치 번들의 gate 의미, 실제 CoreService 신호 순서, 지연 IME commit과 live parser
  overlap, replay suppression, Remote/unknown owner 차단을 회귀 테스트로 고정한다.

## Alternatives Considered

### xterm 6.0.0의 `disableStdin`을 그대로 사용

Remote 입력 차단은 되지만 parser-generated OSC/DSR 응답도 함께 사라진다. 특히
OSC 10/11 조회처럼 브라우저 terminal emulator가 답해야 하는 계약을 깨므로
선택하지 않았다.

### `disableStdin=false`와 DOM capture event만 사용

동기 keydown/input에는 작동하지만 `CompositionHelper`가 timer로 미룬 IME commit은
DOM 표시가 끝난 뒤 발생한다. parser write와 겹치면 사용자 입력을 owner-independent
protocol 경로로 보낼 수 있어 권한 경계로 사용할 수 없다.

### 응답 바이트 allowlist 또는 문자열 형태로 분류

terminal reply와 사용자 입력의 바이트 공간은 분리되어 있지 않다. 새 protocol마다
목록을 유지해야 하고, 오분류 시 사용자 바이트가 Remote owner gate를 우회할 수 있어
선택하지 않았다.

### xterm.js 전체 fork 또는 public API 추가를 기다림

장기적으로 public origin metadata가 가장 바람직하지만 현재 pinned release에는 없다.
전체 fork의 동기화 비용 대신 exact bundle patch와 한 곳의 private adapter로 의존 범위를
제한한다. upstream이 동등한 public 계약을 제공하면 이 결정을 재검토한다.

## Consequences

- Remote/unknown owner 동안 keyboard·IME·paste 같은 human input은 계속 차단하면서
  live parser의 OSC 10/11·DSR 응답은 PTY로 돌아간다.
- 지연된 composition commit은 parser write와 같은 macrotask에 겹쳐도 human route에
  남으며 backend owner permit을 우회하지 않는다.
- xterm의 private CoreService와 minified bundle 형태에 의존하는 유지보수 비용이
  생긴다. xterm 업그레이드는 설치 패치와 실제 번들 계약 테스트가 실패하는 상태에서
  시작하며, 새 버전의 origin·`disableStdin` 의미를 확인하기 전에는 패턴만 갱신하지
  않는다.
- private origin adapter를 사용할 수 없는 버전에서는 안전 우선으로 ambiguous live
  data를 human으로 처리한다. 일부 protocol 기능이 저하될 수 있으나 사용자 입력의
  권한 우회보다 작은 실패다.
- xterm이 public `onData`에 origin metadata를 제공하거나 `disableStdin`이 human
  input만 차단하는 안정 버전이 나오면 local bundle patch와 private adapter 제거를
  검토한다.
