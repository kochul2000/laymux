# 0029. Terminal 분리 입력 컴포저 — PC와 Remote 공통 surface 모델

- Status: Accepted
- Date: 2026-07-13
- Source: 사용자 요청(PC와 Remote에서 텍스트 입력과 실제 셸 화면을 분리해 커서 튐과 입력 불편 완화) · PR #445 P1 리뷰(Remote attach mode 복구, backend owner 검증, blocking PTY write의 protocol gate 분리) · ADR-0004 · ADR-0008 · ADR-0011 · ADR-0013 · ADR-0015 · ADR-0024 · ADR-0027 · ADR-0028 · `docs/terminal/` 커서 research 정본

## Context

PC `TerminalView`와 Focused Remote UI는 모두 xterm.js의 helper textarea가 키보드·IME 입력을 받고, `terminal.onData`가 생성한 바이트를 하나의 PTY에 보내는 직접 입력 모델을 쓴다. 이 모델은 실제 터미널과 가장 가까운 호환성을 제공하지만, 긴 자연어 prompt나 다중행 텍스트를 전송 전에 검토·수정하기 어렵다. 특히 모바일 Remote에서는 소프트 키보드가 viewport와 겹치고 조합 중인 문자열을 다루기 불편하다.

xterm.js는 “사용자가 편집하는 입력 caret”과 “PTY 애플리케이션이 마지막으로 이동한 터미널 커서”를 구분하지 않는다. Codex·Claude Code 같은 TUI가 footer를 반복해서 다시 그리면 단일 애플리케이션 커서는 입력 위치와 리페인트 위치 사이를 이동한다. PC `TerminalView`는 OSC 133/633, 프레임 밖 DECTCEM cursor park, save/restore, DEC 2026, `onWriteParsed`를 조합한 shadow cursor와 별도 IME composition preview로 이를 완화한다([ADR-0008](0008-shell-cursor-shadow-cursor.md), [ADR-0011](0011-dectcem-cursor-park-fifth-layer.md)). 그러나 커서 추적은 이미 PTY에 들어간 입력의 표시를 안정화할 뿐, 전송 전 텍스트 편집기를 제공하지는 않는다. 같은 로직을 Remote 정적 페이지에 복제해도 모바일 입력 불편은 남는다.

Remote xterm의 parser mode도 PTY 전역 상태의 신뢰 가능한 원본이 아니다. 최초 attach와 output reconnect는 xterm을 reset한 뒤 output ring의 최근 64 KiB만 재생한다. TUI가 그보다 앞서 bracketed paste를 `CSI ? 2004 h`로 켰다면 최근 snapshot에는 mode 전이가 없고, 새 xterm의 `terminal.modes.bracketedPasteMode`는 실제 애플리케이션 상태와 달리 `false`가 된다. 이를 그대로 믿고 다중행 text를 보내면 각 CR이 별도 제출로 해석될 수 있다.

controller owner도 frontend status cache만으로 강제할 수 없다. Remote claim 직후 PC가 `remote-control-changed`를 처리하기 전에 Tauri `write_to_terminal`을 호출하면, 현재 backend command는 terminal id와 data만 확인하고 PTY에 기록한다. owner 확인과 실제 write가 하나의 backend 임계 구역에서 선형화되지 않으면 UI 차단은 안전 경계가 아니다.

반대로 Warp처럼 셸 line editor의 상태를 laymux가 소유하려면 shell integration과 애플리케이션별 의미 해석이 필요하다. PTY 화면에서 현재 입력 문자열을 역추론해 별도 editor와 양방향 동기화하는 것은 터미널 프로토콜의 책임 경계를 넘으며 임의의 TUI와 호환되지 않는다.

따라서 PC와 Remote 모두 기존 직접 입력을 보존하면서, 아직 PTY에 보내지 않은 텍스트만 네이티브 editor에서 편집하는 선택적 분리 모드가 필요하다. 이 모드는 하나의 PTY와 controller owner 경계를 그대로 사용해야 하며, 각 client의 초안이나 renderer 상태를 새로운 PTY 진실원으로 만들지 않아야 한다.

## Decision

PC `TerminalView`와 Focused Remote UI는 terminal surface마다 다음 두 입력 방식을 제공한다.

1. **Direct mode (`direct`)**: 기존 동작이다. xterm helper textarea가 키보드·IME 입력을 받고 `terminal.onData`를 현재 surface의 write adapter로 전달한다. PC의 5-layer shadow cursor와 composition preview도 이 모드에서 그대로 유지한다. 전체화면 TUI, 마우스 추적, 키 단위 제어가 필요할 때 사용한다.
2. **Detached composer mode (`composer`)**: terminal output viewport와 분리된 네이티브 `textarea`에서 전송 전 텍스트를 편집한다. 이 textarea의 value, selection/caret, IME composition만 미전송 입력의 진실원이다. xterm은 PTY output을 계속 파싱·렌더링하고 terminal mode와 geometry를 추적하지만 텍스트 입력 focus를 갖지 않는다. PC는 xterm native cursor뿐 아니라 shadow overlay caret과 composition preview도 숨기며, Remote는 xterm 애플리케이션 커서를 숨긴다.

모드와 상태 소유권은 다음 규칙을 따른다.

- 각 terminal surface의 현재 모드와 초안은 terminal id별 client 메모리 상태다. 명시적으로 고른 기본 모드 선호만 surface별 `localStorage`에 저장한다: PC는 `laymux.desktop.inputMode`, Remote는 `laymux.remote.inputMode`를 사용한다. PC의 최초 기본값은 항상 `direct`이며, Remote는 저장된 선호가 없을 때 coarse pointer에서 `composer`, fine pointer에서 `direct`를 사용한다.
- composer 초안은 서버, `settings.json`, `localStorage`에 저장하지 않는다. terminal을 바꾸거나 Remote lease를 일시적으로 잃어도 같은 client runtime 동안 terminal id별 초안을 보존하지만, WebView/페이지 reload 또는 앱 종료 뒤에는 복구하지 않는다. 이는 명령·토큰 같은 민감한 미전송 문자열을 영속화하지 않기 위한 경계다.
- bracketed-paste 여부는 xterm surface가 아니라 **Rust PTY output callback이 소유하는 PTY 전역 protocol state**다. backend는 chunk 경계를 보존하는 streaming DEC private-mode tracker로 전체 PTY output의 `CSI ? 2004 h/l`과 terminal reset을 처리하고, terminal별 mutex gate 안에 `TerminalProtocolState { bracketed_paste, revision }`를 유지한다. tracker는 여러 DEC parameter와 chunk 중간 분할을 처리하며 recent output ring이 오래된 bytes를 버려도 상태를 잃지 않는다. 이 per-terminal gate는 바깥 table lock을 놓은 뒤 획득한다. human control 경로에서는 아래의 terminal control-operation gate 다음, AppState lock보다 먼저 잡으며, output callback과 attach 경로는 control-operation gate 없이 protocol-state gate→`output_buffers` 순서만 사용한다. 이 순서를 `state.rs`에 추가한다.
- 모든 attach/reattach는 output snapshot과 같은 시점의 `TerminalAttachState { version, snapshotSeq, modes: { bracketedPaste } }`를 먼저 받는다. PTY callback과 attach snapshot은 모두 terminal protocol-state gate→`output_buffers` 순서로 처리하므로 mode와 `snapshotSeq`가 같은 output prefix를 나타낸다. Direct Remote WebSocket은 첫 text control frame으로 attach state를 보내고 그 다음 binary 64 KiB snapshot과 `snapshotSeq` 이후 delta를 보낸다. Cloud tunnel은 `stream.open{kind:"websocket.accept"}` payload에 같은 state를 넣고 relay가 browser WebSocket의 첫 text control frame으로 전달한다([ADR-0024](0024-cloud-native-wss-tunnel.md)). PC WebView가 live backend session/cache에 재attach할 때도 Tauri attach-state query로 같은 값을 읽는다.
- client는 attach state를 받기 전 mode를 `false`로 추정하지 않는다. attach 시 xterm을 reset한 뒤 backend state에 맞는 synthetic `CSI ? 2004 h/l`을 **xterm parser에만** 적용하고 snapshot을 재생한다. live delta는 backend tracker와 각 xterm parser가 모두 처리한다. attach metadata가 없거나 version을 지원하지 않으면 composer Insert/Send와 direct clipboard paste를 fail-closed로 비활성화하며 raw 다중행 paste를 보내지 않는다.
- composer는 output viewport 아래에 배치해 terminal 내용을 덮지 않는다. composer 높이가 바뀌면 해당 xterm surface의 가용 geometry도 바뀐다. 현재 controller owner인 surface만 최종 `cols/rows`를 PTY에 보내며, owner가 아닌 PC surface는 기존 remote-return dirty/reflow 경로로 최신 geometry를 나중에 동기화한다([ADR-0015](0015-remote-terminal-state-ownership.md)).
- composer가 활성일 때 terminal tap·선택·스크롤은 xterm helper textarea에 사용자 입력 focus를 주지 않는다. 다만 xterm의 `terminal.onData` 전체를 모드로 차단하지 않는다. focus reporting이나 terminal query 응답처럼 xterm이 생성하는 protocol data도 같은 채널을 통과할 수 있으므로, 사용자 키 입력은 focus 경계에서 막고 필요한 protocol reply는 backend owner gate를 통과해 전달한다.
- 공통 action은 **Insert**와 **Send**다. Insert는 초안을 현재 PTY 입력 위치에 붙여 넣되 Enter를 추가하지 않는다. Send는 같은 payload 뒤에 단독 CR(`\r`)을 추가한다. client는 `{ text, submit }` intent만 보내고, Rust가 줄바꿈을 CR로 정규화한 뒤 authoritative `TerminalProtocolState.bracketed_paste`가 참이면 텍스트 부분만 `CSI 200~`/`CSI 201~`로 감싼다. CR 제출은 bracketed-paste 종료 뒤에 둔다. direct clipboard paste도 같은 structured input 경로를 사용해 stale xterm mode로 raw paste를 만들지 않는다. PC의 key gesture는 키바인딩 registry action으로만 연결하고 컴포넌트에 조합을 하드코딩하지 않는다. Remote에서는 IME composition 중 Enter를 제출로 해석하지 않으며 일반 Enter는 Send, Shift+Enter는 줄바꿈으로 처리한다.
- 한 composer commit은 backend가 준비한 text와 선택적 CR을 합쳐 **한 번의 PTY write**로 보낸다. PC는 새 Tauri `write_terminal_input`, Remote는 새 lease 보호 `/remote/v1/terminals/{id}/input` structured endpoint를 사용한다. 기존 raw Tauri `write_to_terminal`과 Remote `/write`는 direct key·protocol reply·soft-key 용도로 유지하되 아래 owner gate를 반드시 공유한다. 요청은 시작 시점의 terminal id와 controller 권한에 묶고, terminal별 control-operation gate와 `PtyHandle` writer mutex로 write ordering과 payload 비인터리빙을 보존한다. 성공 뒤에만 해당 초안을 비우며, 실패나 결과가 불명확한 오류에서는 초안을 보존한다.
- Rust는 human surface의 raw/structured write를 단일 owner-checked 내부 함수로 모은다. origin은 `Local` 또는 `Remote { lease_id }`다. Remote claim/release, human write, owner-checked resize는 바깥 table lock을 놓은 뒤 얻는 **terminal별 control-operation gate**를 공유한다. write는 이 gate를 잡은 뒤 structured 요청에 한해서 terminal protocol-state gate→`pty_handles`→`remote_control` 순서로 필요한 상태를 잠근다. 만료 lease를 정리하고 owner를 검증한 뒤 현재 `TerminalProtocolState`의 mode와 revision을 캡처해 payload를 인코딩하고 clone 가능한 PTY handle을 얻는다. mode 캡처·인코딩이 해당 요청과 mode 전이 사이의 선형화 지점이며, 이후 mode 전이는 다음 요청부터 적용한다. 실제 `PtyHandle::write` 전에 protocol-state gate와 모든 AppState lock을 해제하고, 같은 terminal의 claim/write/resize를 직렬화하는 control-operation gate만 유지한 채 blocking PTY I/O를 수행한다. 따라서 긴 chunked `write_all`/`flush` 중에도 output callback은 protocol-state gate를 얻어 PTY output을 계속 drain할 수 있다. Local은 active Remote lease가 없을 때만, Remote는 현재 lease id가 일치할 때만 허용하며, 이미 시작한 write가 끝나기 전에는 경쟁 claim이 완료되지 않는다. claim·PC write와 mode 전이·input encoding의 선후는 backend에서 선형화되고 frontend status event는 UX 반영용일 뿐 권한 경계가 아니다. raw write는 mode 캡처가 필요 없어 protocol-state gate를 건너뛰지만 같은 control-operation/owner 검증 경로를 쓴다. resize도 같은 control-operation gate 아래에서 `terminals`→`pty_handles`→`remote_control` 순서로 owner를 검증하고, AppState lock을 놓은 뒤 실제 resize를 수행한다. Automation/MCP의 명시적 automation writer는 별도 신뢰 경계로 유지한다.
- write는 자동 재전송하지 않는다. 특히 Remote HTTP 결과를 받지 못했어도 PTY에 바이트가 들어갔을 수 있으므로 사용자가 output을 확인한 뒤 명시적으로 다시 보내야 한다([ADR-0027](0027-remote-connection-graceful-recovery.md)). 새 request id나 exactly-once 서버 계약은 추가하지 않는다.
- PC에서 composer commit은 direct typing과 같은 “사용자가 응답함” action으로 처리해 기존 notification dismiss 정책을 재사용한다. Remote의 소프트 키 툴바와 `Ctrl+C`는 두 모드 모두에서 기존 PTY 직접 입력 경로를 사용하며 composer 문자열을 편집하지 않는다([ADR-0028](0028-remote-soft-key-toolbar.md)).
- active Remote lease가 있으면 PC composer 초안은 보존하되 기존 local input overlay 아래에서 편집·Insert·Send를 비활성화하고 PTY resize도 보내지 않는다. lease가 끝나면 PC는 기존 명시적 reflow/resize 복구 뒤 편집과 전송을 재개할 수 있다. 어느 surface도 controller owner가 아닐 때 PTY write/resize를 보내지 않는다.

분리 모드는 PC와 Remote가 공유하는 입력 보조 개념이지만 셸/TUI line editor의 복제본은 아니다. 현재 PTY 입력 줄을 composer로 가져오거나, composer selection을 애플리케이션 커서와 동기화하거나, 이미 전송된 내용을 양방향 편집하지 않는다. Direct mode의 기존 cursor·IME·TUI 호환 동작도 변경하지 않는다.

## Implementation Plan

1. **PTY protocol-state tracker 테스트를 먼저 추가한다.** `CSI ? 2004 h/l`, 여러 parameter, chunk 경계 분할, ring eviction, reset을 순수 streaming parser test로 고정한다. PTY callback과 attach가 terminal protocol-state gate→output ring 순서를 공유해 bytes·`snapshotSeq`·mode를 같은 output prefix에서 캡처하는지 검증한다.
2. **attach protocol 테스트를 먼저 추가한다.** Direct WebSocket의 attach text frame→binary snapshot→delta 순서와 reconnect 복구를 검증한다. Cloud tunnel은 `websocket.accept` attach payload와 relay가 제공할 browser prelude 계약을 고정하고, metadata 누락·지원하지 않는 version에서 paste/composer가 fail-closed인지 Playwright로 검증한다.
3. **backend owner/control-operation gate 테스트를 먼저 추가한다.** Remote claim 전/후 Local write, 잘못된/정상 lease의 Remote write, claim과 Local write 경쟁, lease 만료, local/remote resize를 Rust test로 검증한다. blocking fake PTY writer를 사용해 먼저 선형화된 write가 끝날 때까지 같은 terminal의 claim이 완료되지 않되, 그동안 output callback의 protocol-state 갱신과 attach snapshot은 진행되는지 검증한다. frontend status callback을 의도적으로 늦춘 e2e에서도 PC payload가 Remote owner의 PTY에 들어가지 않아야 한다.
4. **structured input 계약 테스트를 먼저 추가한다.** authoritative bracketed-paste on/off, 줄바꿈 정규화, Insert/Send CR 위치, 빈 초안, Unicode·한글·다중행 vector를 Rust encoder와 PC/Remote adapter test로 고정한다. mode 캡처 뒤 protocol-state gate와 AppState lock이 해제된 상태에서 PTY write가 실행되고, write 도중 생긴 mode 전이가 다음 요청부터 반영되는지도 검증한다. direct clipboard paste도 structured 경로를 사용하고 raw key/protocol reply는 owner gate를 공유하는지 검증한다.
5. **PC `TerminalView`와 재사용 UI를 TDD로 구현한다.** direct 기본값, terminal별 mode/draft 격리, native·shadow·composition caret 비표시, composer focus, 성공/실패 시 draft 처리, notification dismiss, Remote lease 중 backend write/resize 거절과 lease 반환 후 geometry 복구를 검증한 뒤 `components/ui/` composer와 키바인딩 registry action을 연결한다.
6. **Remote UI와 input ordering을 TDD로 구현한다.** coarse/fine pointer 기본값, 저장된 선호, terminal별 초안, composition 중 Enter 무시, attach state 적용, 단일 structured request, in-flight 중 중복 제출 방지, 실패 시 draft 보존과 무자동재시도, soft-key raw 경로를 Playwright와 `page.rs` 계약 test로 검증한다.
7. **living doc과 자율 검증을 완료한다.** `docs/architecture/data-flow.md` §8에 PTY protocol-state/PC composer/owner gate 흐름을, `docs/architecture/api-contracts.md` §13.4와 cloud tunnel 계약에 attach prelude와 structured input endpoint를 반영한다. 관련 Rust/Vitest/Remote Playwright/UI build를 통과시키고 dev 19281에서 PC·Direct Remote·Cloud Remote의 한글 IME, 다중행 paste, reconnect, lease race를 확인한 뒤 모바일·데스크톱 스크린샷을 비교한다. dev 프로세스는 `bash scripts/kill-dev.sh`로만 종료한다.

## Consequences

- PC와 모바일 Remote 모두 전송 전 텍스트를 네이티브 caret, selection, IME로 안정적으로 편집할 수 있다. composer mode에서는 PTY 애플리케이션 커서를 입력 caret으로 사용하지 않으므로 footer repaint가 미전송 입력 caret을 움직이지 않는다.
- PC의 기존 shadow cursor와 composition preview는 제거되지 않는다. Direct mode는 현재 동작을 유지하고, composer mode만 별도의 caret owner를 사용한다.
- 셸과 TUI가 실제로 받은 입력·에코·편집 상태는 계속 PTY 안에만 존재한다. 전송한 뒤 내용을 수정하려면 Direct mode나 terminal control key를 사용해야 한다.
- composer가 차지하는 높이는 surface geometry를 바꾸므로 owner 전환 시 기존 guarded reflow/resize 규칙을 반드시 따른다. Remote 제어 중 PC layout 변화가 shared PTY를 resize하지 않는다.
- PC와 Remote 초안은 서로 동기화되지 않는다. surface-local 미전송 상태를 공유하지 않아 lease 전환과 transport 단절이 draft ownership까지 확장되지 않는다.
- xterm의 mode는 표시용 mirror이고 Rust `TerminalProtocolState`가 bracketed-paste의 권위다. 64 KiB snapshot에서 오래된 mode 전이가 빠져도 attach prelude와 backend structured encoder가 안전한 paste를 보장한다.
- human surface의 write/resize 권한은 backend lock 안에서 강제된다. claim과 동시에 들어온 stale PC 요청은 명시적 owner 오류로 실패하고 draft를 보존한다.
- 긴 PTY write는 같은 terminal의 controller operation만 직렬화한다. protocol-state gate와 AppState lock을 점유하지 않으므로 자식이 stdout을 내보내며 stdin 소비를 늦춰도 output callback이 drain을 계속해 순환 대기를 만들지 않는다.
- 새 Tauri structured-input/attach-state 계약, Remote `/input` endpoint, output attach prelude, Cloud `websocket.accept` metadata가 추가된다. settings schema는 바뀌지 않는다. Cloud relay는 attach metadata를 browser WebSocket의 첫 text frame으로 전달해야 하며, 구버전 relay에서는 paste/composer를 fail-closed로 제한한다.
- 현재 Remote entry가 정적 HTML인 동안 PC React component와 Remote composer 구현은 별도다. 공통 test vector와 wire 계약으로 drift를 막고, ADR-0013의 React remote client adapter가 완성되면 UI component를 합친다.
