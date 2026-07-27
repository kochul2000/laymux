# 0068. Remote 터미널 query 응답자는 PC xterm 하나로 제한한다

- Status: Accepted
- Date: 2026-07-27
- Source: 사용자 재현(입력하지 않은 문자열이 Remote 연결 뒤 PTY에 유입됨); issue #480; [PR #594 최종 리뷰](https://github.com/kochul2000/laymux/pull/594); [architecture/data-flow.md §8.8](../architecture/data-flow.md); [ADR-0015](0015-remote-terminal-state-ownership.md); [ADR-0029](0029-detached-terminal-input-composer.md); [ADR-0034](0034-single-send-terminal-composer.md); [ADR-0054](0054-xterm-human-and-protocol-data-origin.md)
- Relation: ADR-0054의 PC WebView protocol reply 출처 분리를 Remote surface까지 확장한다. ADR-0029/0034가 유지한 Remote `/write`의 protocol reply 용도는 폐기하고 human input·soft key의 owner-gated raw write 용도만 유지한다. 다른 결정을 대체하지 않는다.

## Context

PC WebView와 Remote 브라우저는 같은 PTY output을 각자의 xterm으로 파싱한다. DSR,
Device Attributes, DECRQM, XTVERSION, OSC 색상 query를 두 xterm이 모두 처리하면 각각
`onData` reply를 만들고, 두 reply가 같은 PTY stdin으로 돌아간다. 특히 Remote reconnect는
과거 snapshot의 query까지 다시 파싱하므로 중복 reply가 현재 셸 prompt에 사용자가 입력하지
않은 문자열처럼 남을 수 있다. snapshot write 동안의 `onData`만 버리는 replay guard로는
연결 뒤 live delta에서 반복되는 query를 막지 못한다.

ADR-0054는 PC xterm의 human input과 parser-generated reply를 분리해 후자만
owner-independent backend 경로로 보냈지만 Remote surface는 명시적으로 비목표였다.
ADR-0029/0034는 Remote `/write`를 direct key·soft key와 protocol reply가 함께 쓰는
owner-gated raw 경로로 남겼다. 따라서 Remote parser가 reply를 생성할지와 PC parser가 이미
답했는지를 정하는 책임 경계가 없었다.

OSC 4/10/11/12는 한 payload 안에 query와 setter를 함께 쌓을 수 있다. xterm parser의 custom
OSC handler는 payload 전체를 처리하거나 다음 handler로 넘기는 boolean 계약이라 query slot만
제거할 수 없다. payload를 claim한 뒤 setter-only OSC를 `terminal.write()`로 재진입시키면 그
write는 현재 parser 위치가 아니라 xterm write queue 뒤에 붙는다. 같은 V1 delta 뒤쪽의 정상
setter나 reset보다 먼저였던 setter가 나중에 적용되어 최종 색상 순서가 역전된다.

PC `TerminalView`는 hidden pane eviction이나 surface teardown으로 잠시 없을 수 있다. 이때
정확히 한 responder를 유지하려면 backend가 parser surface의 생존과 generation을 추적하고
responder를 선출해야 한다. 이번 결정은 duplicate stdin을 멈추는 범위이며 새 election protocol,
Rust의 renderer 상태 합성, terminal query 목록의 일반화를 비목표로 한다.

## Decision

**Terminal protocol query에는 PC xterm만 응답할 수 있고 Remote xterm은 모든 output phase에서 reply를 생성하지 않는 display mirror로 동작한다.**

- PC의 contiguous live parser reply는 ADR-0054의 `write_terminal_protocol_reply` 경로를
  그대로 사용한다. Remote는 lease·input mode·snapshot/live 여부와 무관하게 CSI DSR·DA·
  DECRQM·XTVERSION과 valid query slot을 하나라도 포함한 OSC 4/10/11/12 payload를 custom
  parser handler에서 claim한다. Remote parser reply를 `/write` 또는 다른 PTY 입력 경로로
  전달하지 않는다.
- responder 수는 **최대 하나**다. PC xterm surface가 살아 있으면 그 surface가 응답하고,
  surface가 unmount된 동안에는 responder가 0개일 수 있다. 이때 optional query가 timeout될 수
  있지만, Remote가 독자적으로 응답해 PC와 다시 중복될 위험보다 안전한 실패로 본다. surface
  generation을 아는 backend responder election을 도입할 때만 이 정책을 새 ADR로 재검토한다.
- setter-only OSC payload는 xterm 기본 handler에 그대로 넘긴다. query와 setter가 섞인
  payload는 custom handler가 query slot을 제거한 뒤, 고정 xterm 6.0.0의
  `_core._inputHandler` color setter method를 현재 parser callback 안에서 동기 호출한다.
  OSC 4의 color index와 OSC 10/11/12의 target offset, setter 간 상대 순서를 보존한다.
  `terminal.write()` 재진입이나 microtask/timer 재생은 금지하며, 같은 delta에서 뒤에 온 정상
  setter와 OSC 104/110/111/112 reset이 항상 최종 상태를 결정한다.
- 혼합 payload를 처리할 때 pinned private setter adapter가 없거나 성공을 확인할 수 없으면
  즉시 오류로 실패한다. built-in handler로 query까지 넘기거나 비동기 setter 재생으로
  fallback하지 않는다. 일부 Remote 렌더링이 중단되는 loud failure가 중복 PTY 입력이나 조용한
  색상 순서 손상보다 우선한다.
- Remote가 적용하는 setter는 같은 PTY output을 xterm 기본 parser가 처리할 때와 동일한 색상
  문법만 받아들이며 새로운 스크립트 실행·네트워크·파일 권한을 만들지 않는다. human key·IME·
  paste·mouse/focus·soft key의 `/write`는 계속 ADR-0015/0029의 backend owner permit을 요구한다.
  이 결정은 인증, CORS, port, Remote API wire schema를 바꾸지 않는다.
- 실제 vendored xterm 6.0.0, V1 snapshot header/binary pair, 한 delta의 혼합 query+setter와 후속
  setter/reset을 함께 사용하는 브라우저 회귀 테스트로 순서와 무응답을 고정한다. parser mock은
  모든 지원 ident의 query 판정과 target/index 보존을 별도로 고정한다.

## Alternatives Considered

### PC와 Remote가 각각 query에 응답

현재 결함을 유지한다. 정상적인 두 reply도 PTY 관점에서는 중복 stdin이며 reconnect snapshot은
오래된 query를 다시 실행하므로 선택하지 않았다.

### Remote lease owner가 응답하고 PC는 Remote 제어 중 침묵

terminal reply는 human controller 권한이 아니라 emulator 상태에서 나온다. owner event 처리와
parser callback 사이의 race, PC/Remote surface generation, reconnect를 함께 선형화해야 하며
현재 backend에는 responder election 상태가 없다. 단순 lease 판정만으로는 0개 또는 2개를 막지
못하므로 선택하지 않았다.

### Rust가 모든 query reply를 합성

DSR cursor position과 OSC color query는 xterm renderer의 현재 cursor/theme 상태가 필요하다.
Rust output parser가 이 surface-local 상태를 소유하지 않으며 별도 emulator를 만드는 것은 범위를
크게 넓히므로 선택하지 않았다.

### 혼합 OSC payload 전체를 버림

reply는 막지만 같은 payload의 유효 setter까지 잃어 Remote 표시가 PC와 달라진다. display mirror가
output side effect를 보존해야 하므로 선택하지 않았다.

### setter-only OSC를 `terminal.write()`로 재생

구현은 단순하지만 xterm write queue 끝에서 실행되어 같은 delta의 후속 setter/reset과 순서를
뒤집는 실제 회귀가 확인되었다. parser 위치 불변식을 만족하지 않아 선택하지 않았다.

### PTY output을 xterm 앞에서 streaming rewrite

공개 API만 사용할 수 있지만 OSC가 WebSocket frame과 UTF-8 chunk 경계를 가로지를 때까지 별도
streaming parser 상태를 유지해야 하고 xterm의 OSC 문법을 중복 구현한다. 현재 고정 버전의 built-in
setter를 동기 호출하는 편이 범위와 drift가 작다. xterm이 공개 synchronous setter API를 제공하면
private adapter 대신 이 대안을 다시 비교한다.

## Consequences

- Remote 연결·재연결·live prompt repaint가 같은 query를 다시 PTY에 쓰지 않아 사용자가 입력하지
  않은 reply 문자열이 셸 prompt에 섞이지 않는다.
- 혼합 색상 payload의 표시 side effect는 보존되고, 같은 delta 뒤쪽의 setter/reset이 늦게 온
  값이라는 terminal stream 순서가 유지된다.
- hidden eviction 등으로 PC xterm이 없는 동안 일부 query는 응답을 받지 못할 수 있다. 정확히 한
  responder가 항상 필요한 요구가 생기면 backend generation-scoped election과 surface liveness를
  별도 결정해야 한다.
- Remote page가 xterm 6.0.0 private input handler method 이름에 의존하는 유지보수 비용이 생긴다.
  xterm upgrade는 실제 bundle 회귀 테스트가 실패하는 상태에서 시작하며 adapter 이름만 조용히
  갱신하지 않는다.
- 설정·저장 데이터·API migration은 없다. Windows와 Linux 모두 같은 브라우저 parser 경로를 쓰며
  OS별 분기는 추가되지 않는다.
