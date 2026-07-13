# 0029. Terminal 분리 입력 컴포저 — PC와 Remote 공통 surface 모델

- Status: Accepted
- Date: 2026-07-13
- Source: 사용자 요청(PC와 Remote에서 텍스트 입력과 실제 셸 화면을 분리해 커서 튐과 입력 불편 완화) · ADR-0004 · ADR-0008 · ADR-0011 · ADR-0013 · ADR-0015 · ADR-0027 · ADR-0028 · `docs/terminal/` 커서 research 정본

## Context

PC `TerminalView`와 Focused Remote UI는 모두 xterm.js의 helper textarea가 키보드·IME 입력을 받고, `terminal.onData`가 생성한 바이트를 하나의 PTY에 보내는 직접 입력 모델을 쓴다. 이 모델은 실제 터미널과 가장 가까운 호환성을 제공하지만, 긴 자연어 prompt나 다중행 텍스트를 전송 전에 검토·수정하기 어렵다. 특히 모바일 Remote에서는 소프트 키보드가 viewport와 겹치고 조합 중인 문자열을 다루기 불편하다.

xterm.js는 “사용자가 편집하는 입력 caret”과 “PTY 애플리케이션이 마지막으로 이동한 터미널 커서”를 구분하지 않는다. Codex·Claude Code 같은 TUI가 footer를 반복해서 다시 그리면 단일 애플리케이션 커서는 입력 위치와 리페인트 위치 사이를 이동한다. PC `TerminalView`는 OSC 133/633, 프레임 밖 DECTCEM cursor park, save/restore, DEC 2026, `onWriteParsed`를 조합한 shadow cursor와 별도 IME composition preview로 이를 완화한다([ADR-0008](0008-shell-cursor-shadow-cursor.md), [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md)). 그러나 커서 추적은 이미 PTY에 들어간 입력의 표시를 안정화할 뿐, 전송 전 텍스트 편집기를 제공하지는 않는다. 같은 로직을 Remote 정적 페이지에 복제해도 모바일 입력 불편은 남는다.

반대로 Warp처럼 셸 line editor의 상태를 laymux가 소유하려면 shell integration과 애플리케이션별 의미 해석이 필요하다. PTY 화면에서 현재 입력 문자열을 역추론해 별도 editor와 양방향 동기화하는 것은 터미널 프로토콜의 책임 경계를 넘으며 임의의 TUI와 호환되지 않는다.

따라서 PC와 Remote 모두 기존 직접 입력을 보존하면서, 아직 PTY에 보내지 않은 텍스트만 네이티브 editor에서 편집하는 선택적 분리 모드가 필요하다. 이 모드는 하나의 PTY와 controller owner 경계를 그대로 사용해야 하며, 각 client의 초안이나 renderer 상태를 새로운 PTY 진실원으로 만들지 않아야 한다.

## Decision

PC `TerminalView`와 Focused Remote UI는 terminal surface마다 다음 두 입력 방식을 제공한다.

1. **Direct mode (`direct`)**: 기존 동작이다. xterm helper textarea가 키보드·IME 입력을 받고 `terminal.onData`를 현재 surface의 write adapter로 전달한다. PC의 5-layer shadow cursor와 composition preview도 이 모드에서 그대로 유지한다. 전체화면 TUI, 마우스 추적, 키 단위 제어가 필요할 때 사용한다.
2. **Detached composer mode (`composer`)**: terminal output viewport와 분리된 네이티브 `textarea`에서 전송 전 텍스트를 편집한다. 이 textarea의 value, selection/caret, IME composition만 미전송 입력의 진실원이다. xterm은 PTY output을 계속 파싱·렌더링하고 terminal mode와 geometry를 추적하지만 텍스트 입력 focus를 갖지 않는다. PC는 xterm native cursor뿐 아니라 shadow overlay caret과 composition preview도 숨기며, Remote는 xterm 애플리케이션 커서를 숨긴다.

모드와 상태 소유권은 다음 규칙을 따른다.

- 각 terminal surface의 현재 모드와 초안은 terminal id별 client 메모리 상태다. 명시적으로 고른 기본 모드 선호만 surface별 `localStorage`에 저장한다: PC는 `laymux.desktop.inputMode`, Remote는 `laymux.remote.inputMode`를 사용한다. PC의 최초 기본값은 항상 `direct`이며, Remote는 저장된 선호가 없을 때 coarse pointer에서 `composer`, fine pointer에서 `direct`를 사용한다.
- composer 초안은 서버, `settings.json`, `localStorage`에 저장하지 않는다. terminal을 바꾸거나 Remote lease를 일시적으로 잃어도 같은 client runtime 동안 terminal id별 초안을 보존하지만, WebView/페이지 reload 또는 앱 종료 뒤에는 복구하지 않는다. 이는 명령·토큰 같은 민감한 미전송 문자열을 영속화하지 않기 위한 경계다.
- composer는 output viewport 아래에 배치해 terminal 내용을 덮지 않는다. composer 높이가 바뀌면 해당 xterm surface의 가용 geometry도 바뀐다. 현재 controller owner인 surface만 최종 `cols/rows`를 PTY에 보내며, owner가 아닌 PC surface는 기존 remote-return dirty/reflow 경로로 최신 geometry를 나중에 동기화한다([ADR-0015](0015-remote-terminal-state-ownership.md)).
- composer가 활성일 때 terminal tap·선택·스크롤은 xterm helper textarea에 사용자 입력 focus를 주지 않는다. 다만 xterm의 `terminal.onData` 전체를 모드로 차단하지 않는다. focus reporting이나 terminal query 응답처럼 xterm이 생성하는 protocol data도 같은 채널을 통과할 수 있으므로, 사용자 키 입력은 focus 경계에서 막고 필요한 protocol reply는 현재 controller owner의 write adapter로 계속 전달한다.
- 공통 action은 **Insert**와 **Send**다. Insert는 초안을 현재 PTY 입력 위치에 붙여 넣되 Enter를 추가하지 않는다. Send는 같은 payload 뒤에 단독 CR(`\r`)을 추가한다. 둘 다 줄바꿈을 CR로 정규화하고, 해당 xterm이 `terminal.modes.bracketedPasteMode`를 보고하면 텍스트 부분만 `CSI 200~`/`CSI 201~`로 감싼다. CR 제출은 bracketed-paste 종료 뒤에 둔다. PC의 key gesture는 키바인딩 registry action으로만 연결하고 컴포넌트에 조합을 하드코딩하지 않는다. Remote에서는 IME composition 중 Enter를 제출로 해석하지 않으며 일반 Enter는 Send, Shift+Enter는 줄바꿈으로 처리한다.
- 한 composer commit은 준비된 text와 선택적 CR을 합쳐 **한 번의 write 호출**로 보낸다. PC adapter는 기존 Tauri `write_to_terminal`, Remote adapter는 기존 lease 보호 `/remote/v1/terminals/{id}/write`를 사용한다. 요청은 시작 시점의 terminal id와 controller 권한에 묶고 surface의 기존 write ordering을 보존한다. 성공 뒤에만 해당 초안을 비우며, 실패나 결과가 불명확한 오류에서는 초안을 보존한다.
- write는 자동 재전송하지 않는다. 특히 Remote HTTP 결과를 받지 못했어도 PTY에 바이트가 들어갔을 수 있으므로 사용자가 output을 확인한 뒤 명시적으로 다시 보내야 한다([ADR-0027](0027-remote-connection-graceful-recovery.md)). 새 request id나 exactly-once 서버 계약은 추가하지 않는다.
- PC에서 composer commit은 direct typing과 같은 “사용자가 응답함” action으로 처리해 기존 notification dismiss 정책을 재사용한다. Remote의 소프트 키 툴바와 `Ctrl+C`는 두 모드 모두에서 기존 PTY 직접 입력 경로를 사용하며 composer 문자열을 편집하지 않는다([ADR-0028](0028-remote-soft-key-toolbar.md)).
- active Remote lease가 있으면 PC composer 초안은 보존하되 기존 local input overlay 아래에서 편집·Insert·Send를 비활성화하고 PTY resize도 보내지 않는다. lease가 끝나면 PC는 기존 명시적 reflow/resize 복구 뒤 편집과 전송을 재개할 수 있다. 어느 surface도 controller owner가 아닐 때 PTY write/resize를 보내지 않는다.

분리 모드는 PC와 Remote가 공유하는 입력 보조 개념이지만 셸/TUI line editor의 복제본은 아니다. 현재 PTY 입력 줄을 composer로 가져오거나, composer selection을 애플리케이션 커서와 동기화하거나, 이미 전송된 내용을 양방향 편집하지 않는다. Direct mode의 기존 cursor·IME·TUI 호환 동작도 변경하지 않는다.

## Implementation Plan

1. **공통 입력 계약 테스트를 먼저 추가한다.** 줄바꿈 정규화, bracketed-paste on/off, Insert/Send CR 위치, 빈 초안, Unicode·한글·다중행 test vector와 terminal별 draft transition을 순수 함수로 고정한다. PC와 Remote가 같은 vector를 검증해 wire 의미의 drift를 막는다.
2. **PC `TerminalView` 테스트를 먼저 추가한다.** direct 기본값과 기존 `onData` 회귀 방지, terminal별 mode/draft 격리, native·shadow·composition caret 비표시, composer focus, 단일 Tauri write, 성공/실패 시 draft 처리, notification dismiss, Remote lease 중 write/resize 차단과 lease 반환 후 geometry 복구를 검증한다.
3. **재사용 PC UI를 구현한다.** `components/ui/`에 접근 가능한 detached composer를 만들고 `TerminalView`의 output 아래에 배치한다. PC mode action은 키바인딩 registry에 등록하며 CSS 변수와 공통 class를 사용한다. composer 높이 변화는 기존 guarded fit/write-drain scheduler를 통과시킨다.
4. **Remote Playwright·정적 계약 테스트를 먼저 추가한다.** coarse/fine pointer 기본값, 저장된 선호, terminal별 초안, composition 중 Enter 무시, Insert/Send payload, bracketed-paste, 성공 시 clear, 실패 시 보존과 무자동재시도, lease/terminal capture, soft-key 직접 경로를 검증한다.
5. **Remote UI와 input ordering을 구현한다.** `page.html`에 mode switch와 detached composer를 추가하고 기존 12ms direct batching은 유지한다. composer commit은 Promise를 반환하는 직렬 write primitive 위에서 단일 request, in-flight 중 중복 제출 방지, 성공 후 조건부 clear를 수행한다.
6. **living doc을 구현과 함께 갱신한다.** `docs/architecture/data-flow.md` §8에 PC composer의 focus/cursor/reflow 흐름을, `docs/architecture/api-contracts.md` §13.4에 Remote 모드·초안 소유권·Insert/Send wire 규칙·실패 정책을 반영한다. 새 backend endpoint와 settings schema가 없으므로 API 표는 바꾸지 않는다.
7. **자율 검증을 수행한다.** 관련 Vitest, Rust remote page 단위 테스트, Remote Playwright e2e, UI build를 통과시킨다. dev 포트 19281에서 PC와 Remote 각각 direct/composer 전환, 한글 IME, 다중행 bracketed paste, Codex/Claude footer repaint, soft-key, terminal 전환, Remote lease 회수를 확인하고 모바일·데스크톱 viewport 스크린샷을 비교한다. dev 프로세스는 `bash scripts/kill-dev.sh`로만 종료한다.

## Consequences

- PC와 모바일 Remote 모두 전송 전 텍스트를 네이티브 caret, selection, IME로 안정적으로 편집할 수 있다. composer mode에서는 PTY 애플리케이션 커서를 입력 caret으로 사용하지 않으므로 footer repaint가 미전송 입력 caret을 움직이지 않는다.
- PC의 기존 shadow cursor와 composition preview는 제거되지 않는다. Direct mode는 현재 동작을 유지하고, composer mode만 별도의 caret owner를 사용한다.
- 셸과 TUI가 실제로 받은 입력·에코·편집 상태는 계속 PTY 안에만 존재한다. 전송한 뒤 내용을 수정하려면 Direct mode나 terminal control key를 사용해야 한다.
- composer가 차지하는 높이는 surface geometry를 바꾸므로 owner 전환 시 기존 guarded reflow/resize 규칙을 반드시 따른다. Remote 제어 중 PC layout 변화가 shared PTY를 resize하지 않는다.
- PC와 Remote 초안은 서로 동기화되지 않는다. surface-local 미전송 상태를 공유하지 않아 lease 전환과 transport 단절이 draft ownership까지 확장되지 않는다.
- 새 backend API, settings schema, cloud tunnel frame은 필요 없다. PC와 Direct/Cloud Remote가 각자의 기존 write adapter를 재사용한다.
- 현재 Remote entry가 정적 HTML인 동안 PC React component와 Remote composer 구현은 별도다. 공통 test vector와 wire 계약으로 drift를 막고, ADR-0013의 React remote client adapter가 완성되면 UI component를 합친다.
