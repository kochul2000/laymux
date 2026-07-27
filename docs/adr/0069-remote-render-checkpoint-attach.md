# 0069. Remote attach는 raw tail이 아니라 xterm 화면 체크포인트에서 시작한다

- Status: Proposed
- Date: 2026-07-27
- Source: 사용자 보고(Remote에서 출력 중인 터미널로 워크스페이스 이동 시 화면 대부분이 비는 문제) · [architecture/api-contracts.md §13](../architecture/api-contracts.md) · [architecture/data-flow.md §8.8](../architecture/data-flow.md) · [ADR-0015](0015-remote-terminal-state-ownership.md) · [ADR-0029](0029-detached-terminal-input-composer.md) · [ADR-0058](0058-single-terminal-cell-width-provider.md)
- Relation: ADR-0015의 surface 상태 분리를 유지하면서 Remote attach의 초기 상태 계약을 확장하고, ADR-0029의 V1 `snapshot` payload가 반드시 PTY raw byte 구간이라는 결정을 정정한다. ADR-0058의 단일 셀 폭 provider를 Remote 체크포인트에도 직접 적용한다.

## Context

Remote output attach는 지금까지 generation-scoped PTY output ring의 마지막 N바이트를 새 브라우저 xterm에 재생했다. 이 방식은 줄 단위 로그에는 동작하지만, TUI가 최초 전체 화면을 그린 뒤 `CUP`·`EL` 같은 커서 기반 부분 갱신만 계속 보내면 복원 가능한 시작점이 사라진다. 워크스페이스 이동은 Remote의 단일 xterm을 reset한 뒤 이 tail을 적용하므로, snapshot 상한보다 오래된 전체 프레임은 사라지고 최근 부분 패치가 빈 화면 몇 곳에만 찍힌다. 첫 newline까지 버리는 정렬도 줄 경계일 뿐 VT 상태 경계가 아니어서 중간 토큰이나 escape 상태를 복구하지 못한다.

snapshot 상한을 4 KiB에서 1 MiB로 키우면 실패 시점만 늦어진다. ring 크기보다 오래 전체 redraw가 없는 프로그램에는 같은 문제가 재발하고, attach 비용과 민감한 scrollback 노출만 커진다. 반대로 Rust에 별도 VT emulator를 두면 데스크톱·Remote xterm이 공유하는 Unicode/grapheme provider와 다른 셀 폭 계산원이 생겨 ADR-0058을 깨뜨린다. visible 데스크톱 xterm의 직렬화도 사용할 수 없다. Remote가 PTY geometry를 소유하는 동안 visible xterm은 PC surface geometry를 유지하므로 cursor-addressed output을 다른 격자로 해석한다.

범위는 데스크톱이 호스트인 Direct/Cloud Remote output attach와 이를 위한 내부 Tauri output metadata다. PTY raw ring을 Automation/MCP 진단·검색에 쓰는 계약, surface별 렌더러/selection/scroll 위치 분리, Remote controller lease와 resize 소유권은 바꾸지 않는다.

## Decision

**Remote output attach는 PTY geometry를 따라 모든 output을 파싱한 렌더러 없는 xterm의 직렬화 화면 체크포인트에서 시작하고, 체크포인트 sequence 이후의 raw delta만 이어 붙인다.**

- 각 live terminal generation은 데스크톱 WebView 안에 DOM renderer를 열지 않은 checkpoint xterm 하나를 둔다. 이 모델은 visible `TerminalView`와 별개 surface이며 사용자 focus·selection·viewport를 소유하지 않는다.
- checkpoint xterm은 `terminal-unicode-width.ts`의 provider를 첫 write 전에 활성화한다. 별도 Rust/JS 폭 테이블이나 VT parser를 추가하지 않는다.
- backend output session은 generation, monotonic byte sequence와 함께 `{ revision, cols, rows }` PTY geometry를 attach state와 각 delta에 붙인다. geometry 변경 뒤의 bytes는 checkpoint xterm을 먼저 같은 크기로 resize한 뒤 파싱한다.
- checkpoint 모델은 초기 raw attach가 sequence 0에서 시작한 generation만 복원 가능하다고 표시한다. truncation된 raw tail에서 임의 화면을 추측하지 않는다.
- Remote/Cloud attach는 먼저 checkpoint 모델에서 `{ generation, sourceSeq, geometry, serializedAnsi }`를 얻는다. backend는 같은 generation·geometry와 ring 보존 범위를 검증한 뒤, `sourceSeq`부터 subscriber 등록 시점까지의 raw suffix를 직렬화 ANSI 뒤에 붙이고 그 경계에서 bounded subscriber를 등록한다. 검증 중 generation 교체·resize·ring gap이 생기면 결과를 보내지 않고 새 attach를 시도한다.
- Remote browser는 자신의 xterm을 현재 viewport에 fit하고 그 `cols/rows`의 lease-gated resize가 완료된 뒤 output attach를 시작한다. attach 중 surface fit을 보류하고, 반환된 screen checkpoint는 `state.geometry`에서 reset/replay한 뒤 viewport fit을 재개한다.
- frontend bridge 대기 뒤에는 Direct와 Cloud 모두 첫 snapshot 전 active lease를 다시 검사한다. 대기 중 release·expiry·reclaim이 이기면 이미 만든 checkpoint/subscriber를 폐기하고 어떤 화면 byte도 보내지 않는다.
- 브라우저 wire pair는 호환성을 위해 `terminal.output` V1 header→binary 형태를 유지한다. `state.snapshotKind="screen"`을 추가해 합성 화면임을 표시하며, 연결별 sequence offset으로 `byteLength == seqEnd - seqStart`와 이후 delta 연속성을 유지한다. `snapshotSeq`는 그 연결의 wire watermark이고 source sequence와 같다고 해석하지 않는다.
- `remote.snapshotMaxKib`는 checkpoint의 scrollback 목표 예산이다. 현재 normal viewport, active alternate buffer, cursor와 terminal mode를 복원하는 최소 직렬화가 예산보다 크면 최소 상태를 우선한다. 절대 상한을 넘는 체크포인트는 전송하지 않는다.
- checkpoint가 아직 준비되지 않았거나 복원 불가능하면 raw tail을 성공한 화면처럼 보내지 않는다. output stream을 닫아 기존 Remote 재접속 정책으로 다시 attach한다.

## Alternatives Considered

- **snapshot 상한 또는 ring을 크게 늘린다**: 전체 redraw가 상한 밖으로 밀리면 동일하게 실패하며 attach 비용과 노출 범위만 증가한다.
- **newline·clear-screen·alternate-screen 진입을 안전 지점으로 추측한다**: newline은 VT parser checkpoint가 아니고, 모든 TUI가 주기적으로 clear/재진입한다는 보장이 없다.
- **Remote 브라우저에 terminal별 xterm을 계속 보존한다**: 이미 방문한 terminal의 짧은 이탈에는 도움이 되지만 첫 방문, reload, 상한보다 긴 이탈을 해결하지 못하며 모든 output WebSocket을 유지해야 한다.
- **visible 데스크톱 xterm을 직렬화한다**: Remote lease 중 PTY geometry와 PC surface geometry가 달라 같은 cursor-addressed bytes를 다른 화면으로 해석하므로 체크포인트가 권위 상태가 아니다.
- **Rust VT emulator를 output session에 둔다**: attach는 단순해지지만 xterm과 다른 Unicode/grapheme·escape 구현이 세 번째 렌더 상태 진실원이 된다. ADR-0058 불변식과 xterm 호환성을 동시에 유지하기 어렵다.

## Consequences

- 전체 redraw가 ring/snapshot 상한보다 오래전에 끝난 TUI도 워크스페이스 이동·재접속 시 현재 화면과 cursor/mode를 복원한다. 체크포인트 이후 bytes는 exact sequence로 한 번만 적용된다.
- Direct와 Cloud는 같은 checkpoint/subscriber 경계를 사용하고 기존 relay의 V1 header/binary 변환 형식을 유지한다.
- 각 live terminal은 렌더러 없는 xterm buffer와 한 번의 추가 파싱 비용을 가진다. DOM/WebGL surface는 만들지 않고 scrollback 직렬화는 설정 예산으로 제한한다. terminal 수·출력량에서 이 비용이 문제가 되면 별도 worker로 옮길 수 있지만 상태 계약은 유지한다.
- attach state와 frontend delta metadata에 generation·geometry가 추가된다. 기존 V1 browser는 알 수 없는 state 필드를 무시할 수 있고 wire pair 불변식은 유지되지만, 데스크톱 checkpoint producer는 새 metadata를 필수로 검증한다.
- checkpoint 모델이 sequence 0부터 보지 못한 generation은 fail-closed한다. 현재 terminal lifecycle에서는 `TerminalView`가 session을 만들기 전에 listener/model을 준비하므로 정상 경로는 이 조건을 만족한다.
- 테스트는 (1) 작은 snapshot 예산보다 긴 sparse TUI 갱신 뒤 화면 복원, (2) alternate buffer 아래 normal buffer 복원, (3) generation/geometry/ring gap 거절, (4) checkpoint와 live delta의 wire sequence 연속성, (5) Direct/Cloud V1 pair, (6) pre-attach resize와 source geometry replay 순서, (7) checkpoint 대기 중 lease 교체 시 첫 frame 차단을 검증한다.
