# 0029. Remote 분리 입력 컴포저와 터미널 출력 surface

- Status: Accepted
- Date: 2026-07-13
- Source: 사용자 요청(Remote에서 텍스트 입력과 실제 셸 화면을 분리해 커서 튐과 모바일 입력 불편 완화) · ADR-0013 · ADR-0015 · ADR-0027 · ADR-0028 · `docs/terminal/` 커서 research 정본

## Context

현재 Focused Remote UI는 xterm.js의 숨은 helper textarea가 브라우저 키보드·IME 입력을 받고, `terminal.onData`가 생성한 바이트를 곧바로 `/remote/v1/terminals/{id}/write`로 보낸다. 이 방식은 실제 터미널과 가장 가까운 직접 입력을 제공하지만, 모바일 브라우저에서는 조합 중인 문자열을 확인·수정하기 어렵고 소프트 키보드가 터미널 viewport와 겹친다. Codex·Claude Code 같은 TUI가 footer를 반복해서 다시 그리면 xterm의 단일 애플리케이션 커서도 입력 위치와 리페인트 위치 사이를 이동한다.

xterm.js는 “사용자가 편집하는 입력 caret”과 “PTY 애플리케이션이 마지막으로 이동한 터미널 커서”를 구분하지 않는다. 데스크톱 `TerminalView`는 OSC 133/633, 프레임 밖 DECTCEM cursor park, save/restore, DEC 2026, `onWriteParsed`를 조합한 shadow cursor로 이를 완화하지만([ADR-0008](0008-shell-cursor-shadow-cursor.md), [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md)), 이 추적을 Remote 정적 페이지에 복제해도 모바일의 텍스트 편집·IME 문제는 해결되지 않는다.

반대로 Warp처럼 셸 line editor의 상태를 laymux가 소유하려면 shell integration과 애플리케이션별 의미 해석이 필요하다. Remote가 PTY 화면에서 현재 입력 문자열을 역추론해 별도 editor와 양방향 동기화하는 것은 터미널 프로토콜의 책임 경계를 넘으며, 임의의 TUI와 호환되지 않는다.

따라서 Remote에는 기존 직접 입력을 보존하면서, 아직 PTY에 보내지 않은 텍스트만 브라우저 네이티브 editor에서 편집하는 선택적 분리 모드가 필요하다. 이 모드는 하나의 PTY와 exclusive controller lease를 그대로 사용해야 하며, PC/Remote renderer 상태나 셸 내부 line editor를 새로운 진실원으로 복제해서는 안 된다.

## Decision

Focused Remote UI는 terminal별로 다음 두 입력 방식을 제공한다.

1. **Direct mode (`direct`)**: 기존 동작이다. xterm helper textarea가 키보드·IME 입력을 받고 `terminal.onData`를 기존 직렬화된 write 경로로 전달한다. 전체화면 TUI, 마우스 추적, 키 단위 제어가 필요할 때 사용한다.
2. **Detached composer mode (`composer`)**: 터미널 output viewport와 별도의 네이티브 `textarea`에서 전송 전 텍스트를 편집한다. 이 textarea의 selection/caret과 IME composition만 미전송 입력의 진실원이다. xterm은 PTY output을 계속 파싱·렌더링하고 mode/geometry를 추적하지만 텍스트 입력 focus를 갖지 않으며, xterm의 애플리케이션 커서는 이 surface에서 보이지 않게 한다.

모드와 상태 소유권은 다음 규칙을 따른다.

- 입력 모드는 Remote surface-local UI 상태다. 명시적으로 고른 `direct`/`composer` 선호만 `localStorage`의 `laymux.remote.inputMode`에 저장한다. 저장된 선호가 없는 첫 접속은 coarse pointer에서 `composer`, fine pointer에서 `direct`를 사용한다.
- composer 초안은 terminal id별 메모리에만 둔다. 서버, `settings.json`, `localStorage`에는 저장하지 않는다. terminal을 바꾸거나 일시적으로 lease를 잃어도 같은 페이지 수명 동안 초안을 보존하지만, 새로고침 또는 페이지 종료 뒤에는 복구하지 않는다. 이는 명령·토큰 같은 민감한 미전송 문자열을 영속화하지 않기 위한 경계다.
- composer가 활성일 때 terminal tap/선택/스크롤은 xterm helper textarea에 입력 focus를 주지 않는다. `IME compositionstart`부터 `compositionend`까지 Enter는 제출로 해석하지 않는다. 일반 Enter는 “Send”, Shift+Enter는 초안 줄바꿈이며 버튼으로 “Insert”와 “Send”를 모두 제공한다.
- **Insert**는 초안을 현재 PTY 입력 위치에 붙여 넣되 Enter를 추가하지 않는다. **Send**는 같은 payload 뒤에 단독 CR(`\r`)을 추가한다. 둘 다 줄바꿈을 CR로 정규화하고, remote xterm이 `terminal.modes.bracketedPasteMode`를 보고하면 텍스트 부분만 `CSI 200~`/`CSI 201~`로 감싼다. CR 제출은 bracketed-paste 종료 뒤에 둔다. 이 규칙은 xterm.js의 paste 의미와 일치하며 단일행 셸과 다중행 TUI composer를 함께 지원한다.
- 한 composer commit은 준비된 text와 선택적 CR을 합쳐 기존 `/remote/v1/terminals/{id}/write`에 **한 번의 요청**으로 보낸다. 요청은 시작 시점의 terminal id와 lease id에 묶고 기존 input write chain에서 순서를 보장한다. 성공 응답 뒤에만 해당 초안을 비우며, 실패나 결과가 불명확한 transport 오류에서는 초안을 보존한다.
- terminal write는 자동 재전송하지 않는다. HTTP 결과를 받지 못했어도 PTY에 바이트가 들어갔을 수 있으므로, 사용자가 화면을 확인한 뒤 명시적으로 다시 보내야 한다([ADR-0027](0027-remote-connection-graceful-recovery.md)). 새 request id나 exactly-once 서버 계약은 추가하지 않는다.
- 소프트 키 툴바와 `Ctrl+C`는 두 모드 모두에서 기존 PTY 직접 입력 경로를 사용한다. 이는 composer의 로컬 문자열을 편집하는 버튼이 아니라 Esc·방향키·interrupt 같은 terminal control이다([ADR-0028](0028-remote-soft-key-toolbar.md)).
- composer mode도 active Remote lease 없이는 commit, soft key, resize, focus request를 보내지 않는다. PTY `cols/rows`는 계속 현재 Remote xterm geometry가 결정한다. 입력 UI 분리는 ADR-0015의 PTY 전역 상태·surface 로컬 상태·controller owner 경계를 바꾸지 않는다.

분리 모드는 Remote 전용 입력 보조 계층이다. 셸/TUI의 현재 입력 줄을 읽어 composer에 가져오거나, composer selection을 PTY 애플리케이션 커서와 동기화하거나, 데스크톱 shadow cursor 로직을 Remote에 복제하지 않는다. Direct mode의 xterm cursor 동작도 변경하지 않는다.

## Implementation Plan

1. **Playwright 계약 테스트를 먼저 추가한다.** Remote API와 output WebSocket을 mock하고 coarse/fine pointer 기본값, 저장된 모드 우선순위, terminal별 초안 격리, composition 중 Enter 무시, Insert/Send payload, bracketed-paste on/off, 성공 시 clear, 실패 시 보존과 무자동재시도, terminal/lease 캡처를 검증한다.
2. **정적 페이지 계약 테스트를 먼저 보강한다.** `page.rs`에서 composer markup, `laymux.remote.inputMode`, 기존 write endpoint 재사용, 별도 Remote endpoint 부재, xterm cursor 비표시 전환, soft-key 직접 경로 유지 여부를 고정한다.
3. **Remote UI를 추가한다.** `page.html`에 접근 가능한 mode switch, terminal 아래 composer textarea, Insert/Send 버튼, 전송 상태를 추가한다. composer는 viewport를 과도하게 가리지 않도록 제한 높이와 내부 스크롤을 사용하고, 모바일 safe-area와 소프트 키 툴바가 함께 열린 레이아웃을 처리한다.
4. **입력 파이프라인을 한 곳으로 모은다.** 기존 direct 입력의 12ms batching은 유지하되, Promise를 반환하는 직렬 write primitive를 추출한다. composer commit은 terminal/lease snapshot, bracketed-paste 인코딩, 단일 request, in-flight 중 중복 제출 방지, 성공 후 조건부 clear를 이 primitive 위에 구현한다.
5. **focus와 cursor 전환을 구현한다.** composer 진입 시 xterm을 blur하고 inactive cursor를 숨긴 뒤 composer에 focus한다. direct 복귀 시 원래 appearance cursor option을 복원하고 사용자가 요청했을 때만 terminal에 focus한다. selection/scroll gesture와 resize/output parsing은 두 모드에서 동일하게 유지한다.
6. **living doc을 구현과 함께 갱신한다.** `docs/architecture/api-contracts.md` §13.4에 두 입력 모드, 초안 소유권, Insert/Send wire 규칙, 실패 정책을 반영한다. 새 endpoint와 settings schema가 없으므로 Remote API 표 자체는 바꾸지 않는다.
7. **자율 검증을 수행한다.** Rust remote page 단위 테스트와 Remote Playwright e2e를 통과시킨 뒤 dev 포트 19281에서 direct/composer 전환, 한글 IME, 다중행 bracketed paste, Codex/Claude footer repaint, soft-key, terminal 전환을 확인한다. 모바일·데스크톱 viewport 스크린샷을 비교하고 dev 프로세스는 `bash scripts/kill-dev.sh`로만 종료한다.

## Consequences

- 모바일 사용자는 전송 전 텍스트를 네이티브 caret, selection, 자동완성, IME로 안정적으로 편집할 수 있다. composer mode에서는 PTY 애플리케이션 커서를 입력 caret으로 사용하지 않으므로 footer repaint에 따른 보이는 입력 커서 점프가 사라진다.
- 셸과 TUI가 실제로 받은 입력·에코·편집 상태는 계속 PTY 안에만 존재한다. 전송한 뒤 내용을 수정하려면 Direct mode 또는 소프트 키를 사용해야 하며, composer는 이미 전송된 line editor 상태를 되가져오지 않는다.
- Direct mode가 남으므로 vim, tmux, 전체화면 TUI와 키 단위 상호작용의 호환성을 잃지 않는다. 두 모드가 동시에 PTY 입력 상태를 소유하지는 않는다.
- 새 Remote API, settings schema, cloud tunnel frame은 필요 없다. Direct와 Cloud 경로 모두 기존 lease 보호 write endpoint를 그대로 사용한다.
- 단일 HTTP write는 text와 제출 CR 사이의 부분 성공 가능성을 줄이지만 exactly-once를 보장하지 않는다. 결과가 모호할 때 초안을 보존하고 자동 retry를 금지하므로 중복 실행 여부의 최종 판단은 사용자에게 남는다.
- Remote 정적 페이지에 데스크톱 5-layer shadow cursor를 복제하지 않아 두 cursor 구현의 drift를 피한다. 향후 Remote UI가 ADR-0013의 React client adapter 구조로 이동해도 composer 상태는 surface-local adapter 위로 그대로 옮길 수 있다.
