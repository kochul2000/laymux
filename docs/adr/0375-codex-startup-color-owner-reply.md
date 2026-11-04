# 0375. Codex 복원 최초 색상 응답은 초기 테마 snapshot으로 PTY 소유자가 전달한다

- Status: Proposed
- Date: 2026-11-04
- Source: 사용자 재현 및 수정·머지·릴리스 요청; Windows dev Codex 0.166.0 비교; [data-flow.md §8.8](../architecture/data-flow.md); [ADR-0131](0131-native-windows-codex-startup-color-reply-guard.md); [ADR-0054](0054-xterm-human-and-protocol-data-origin.md); [ADR-0300](0300-detached-pty-daemon-core.md)
- Relation: ADR-0131의 최초 응답 차단은 중복·지연 응답 보호로 유지하면서, 초기 테마 응답을 PTY 소유자에게 위임하는 예외를 추가한다. 일반 live/replay 응답 및 Remote 단일 responder 계약은 유지한다.

## Context

Windows 네이티브 Codex 복원에서 색상 질의 약 24ms 뒤 준비된 정상 응답도 ADR-0131 guard가 버린다. Codex 0.166.0은 ConPTY 내부 색상표를 화면 테마로 사용하지 않으므로 입력창 배경과 보조 글자색을 계산하지 못한다. 같은 dev에서 일반 실행은 입력창 배경 `#292929`를 출력하고 복원 실행은 기본 배경으로 출력했다. 반대로 guard가 없는 실행에서 WebView를 1.6초 멈추면 응답 문자열이 composer로 들어가므로 보호를 단순 제거할 수 없다.

WebView가 정지한 동안에도 색상 응답을 전달하려면 실제 PTY I/O 소유자가 응답할 수 있어야 한다. 범위는 backend가 검증한 native Windows Codex 복원·빈 세션 복귀의 최초 OSC 10/11 쌍이다. 일반 실행, WSL/SSH launcher, Remote responder, 실행 중 테마 변경은 범위 밖이다.

## Decision

**프런트엔드가 PTY 생성 전에 확정한 초기 전경·배경색의 OSC 응답 snapshot을 전달하고, 실제 PTY 소유자는 최초 exact 질의를 읽으면 snapshot의 해당 응답을 한 번 전달한다.**

- 색상의 SoT는 visible terminal을 만드는 초기 테마다. 프런트엔드는 같은 확정된 불투명 6자리 hex 색에서 OSC 10/11 RGB 응답을 만든다. Rust는 RGB를 선택·합성하지 않고 길이·코드·RGB 형식을 검증한 응답만 전달한다. 유효한 쌍이 없으면 기존 guard 동작을 유지한다.
- 내부 create IPC의 선택적 snapshot은 backend가 native shell과 native Codex override를 다시 검증한 경우에만 사용한다. 일반 터미널·WSL·SSH·viewer에는 응답 권한이 없다. 외부 HTTP·MCP·설정 계약은 추가하지 않는다.
- 응답자는 실제 native PTY reader와 writer다. in-process는 GUI의 native owner, daemon은 daemon의 native owner에서 reader 시작 전에 연결한다. GUI proxy에는 responder를 만들지 않는다. daemon spawn metadata로 운반한 snapshot은 세션 catalog·adoption metadata에 보존하지 않는다. 살아 있는 세션 재결합에는 새 responder를 설치하지 않는다.
- reader는 출력 publish 전에 chunk 경계를 넘어 exact ST-terminated OSC 10/11 질의를 관측한다. 코드별 최초 한 번만 snapshot을 기존 PTY writer FIFO에 넣고 50ms의 write deadline을 부여한다. 만료·실패 시 재시도하거나 늦게 주입하지 않는다. OS 스케줄링 전체의 시간 상한을 보장하지 않으며 이 deadline은 이미 지연된 write를 실행하지 않기 위한 제한이다.
- 질의 인식·owner write 대기·output callback/transport backpressure의 **누적 처리 예산을 startup 전체에서 50ms로 공유**한다. 각 write는 남은 예산만 사용하며 여러 짧은 callback이나 분할된 두 질의도 예산을 다시 시작하지 않는다. 누적 처리 예산을 소진하면 남은 위임을 영구 해제한다. 뒤에 쌓인 질의의 app-side probe가 이미 끝났을 수 있기 때문이다. 무출력 native read 대기는 app-side probe와 같은 시계가 아니므로 차감하지 않는다. 만료된 queued write는 취소 flag로 폐기하고, 진행 중인 native write는 기존 PTY exact-job OS 취소·완료 확인·실패 시 input fault/종료 정책을 재사용한다.
- startup 전에 OSC 10/11 setter/reset이 관측되면 초기 snapshot은 더 이상 권위가 없으므로 responder를 비활성화한다. 이 경우 복원 색상 최적화보다 잘못된 응답 방지를 우선한다. 다른 터미널 질의는 통과시킨다.
- visible xterm은 출력 질의를 계속 파싱하지만 ADR-0131 guard가 최초 대응 RGB 응답을 버려 이중 응답과 WebView 지연 뒤 composer 오염을 막는다. guard의 generation 검증·adoption disarm·human/protocol 분리는 유지한다.

## Alternatives Considered

- **최초 응답 차단 제거:** 현재 Codex에서도 WebView 1.6초 정지로 입력 오염이 재현된다.
- **frontend reply 지연만 측정해 통과:** backend read 시계는 Codex의 input probe 시작·종료를 증명하지 못하며 WebView stall 문제도 남는다.
- **attach 완료 뒤 실행:** ADR-0131에서 이미 attach 뒤 1.625초 지연이 관측됐다.
- **모든 terminal protocol을 Rust로 이전:** renderer의 동적 색상·모드 전체를 복제해야 하므로 이번 복원 결함과 독립적인 큰 변경이다.
- **ConPTY 색상표를 수정:** 현재 Codex는 pseudoconsole의 색상표를 visible renderer 값으로 인정하지 않는다.

## Consequences

초기 테마에 대한 최초 응답은 WebView parser backlog와 무관하게 전달되며 기존 지연 응답 보호를 유지한다. native owner에 작은 one-shot 인식기와 응답 snapshot, 내부 create IPC·spawn metadata의 선택적 필드가 추가된다. snapshot 이후 셸이 색을 바꾸는 경우 최적화를 포기하며 실행 중 테마 변경을 Codex에 재전파하지 않는다. owner write 자체의 OS 지연은 hard real-time 보장이 아니다.

회귀 검증은 snapshot 형식·잘못된 코드·분할 질의·malformed ESC 취소·한 번 응답·setter 무효화·앞선 callback stall 뒤 질의 폐기·queued write 만료·실제 Win32 full pipe에서 active write 취소와 daemon 전달·adoption 비활성화를 포함한다. Windows dev에서 일반/복원 입력창 색상 동등성과 WebView 정지 중 복원 색상 유지·composer 오염 부재를 함께 확인한다.
