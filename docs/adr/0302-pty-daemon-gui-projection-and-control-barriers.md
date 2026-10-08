# 0302. GUI는 출력 projection을 소유하고 PTY 제어 완료는 데몬에서 확인한다

- Status: Proposed
- Date: 2026-10-08
- Source: 사용자 구현 지시, [ADR-0300](0300-detached-pty-daemon-update-handoff.md), [ADR-0301](0301-pty-daemon-private-ipc-and-parser-runtime.md), [구현 계획](../plans/pty-daemon-update-handoff.md), [출력 소유권](0097-transport-lossless-presentation-lossy-ownership.md)
- 관계: ADR-0300·0301의 GUI adapter와 physical control barrier를 구체화한다. 기존 Remote owner·checkpoint fence의 완료 조건을 완화하지 않는다.

## Context

GUI와 데몬의 수명을 분리해도 기존 GUI `AppState`·PTY handle·출력 credit를 그대로 연결하면 구독 실패가 사용자 작업 종료로 번진다. daemon의 실제 generation·sequence와 새 GUI의 v3 delivery generation·sequence도 서로 다르다. 오래 걸리는 provider 조회가 입력 RPC를 막거나 RPC 오류를 physical write 완료로 간주하면 controller가 바뀐 뒤 옛 입력이 적용될 수 있다.

새 GUI에 필요한 VT 상태의 일부는 serialize addon에 없다. 문자열만 재생해서 charset·tab stop·mouse encoding 같은 상태를 잃으면 재연결 직후 입력의 의미가 달라진다. 이 상태와 출력 경계를 하나의 검증된 checkpoint로 전달해야 한다.

## Decision

**GUI는 daemon catalog와 출력을 로컬 presentation 상태로 투영하며 실제 PTY 제어·확인·저장은 daemon의 generation과 완료 barrier를 기준으로 수행한다.**

- daemon incarnation·PTY generation과 GUI-local delivery generation·lease·sequence를 별도로 관리한다. GUI generation retirement, handle Drop, 출력 fail-stop은 daemon PTY를 종료하지 않는다. 명시적 삭제·실제 종료만 검증된 대상에 close를 요청한다.
- 기존 Desktop v3 credit/parsed ACK는 GUI presentation을 제한한다. daemon read/parser의 진행 조건으로 삼지 않는다. source ring의 gap은 authoritative 화면 checkpoint와 새 GUI delivery generation으로 복구한다. bootstrap을 임의의 raw tail로 대체하지 않는다.
- 입력·resize는 기존 terminal FIFO를 유지하고 원래 operation deadline을 IPC 너머로 전달한다. Windows uptime/Linux monotonic clock의 만료를 실제 enqueue와 write chunk에서 검사한다. transport 오류·timeout 뒤 human input을 자동 재전송하지 않는다.
- ownership 변경·인계는 GUI 대기 작업뿐 아니라 daemon의 physical operations와 quarantine completion도 drain된 뒤 완료한다. 연결 단절을 완료 ACK로 합성하지 않는다. 인증하거나 완료를 확인할 수 없으면 변경을 실패로 반환한다.
- 제어 연결은 순서를 유지하고 조회는 별도 인증 연결에서 실행한다. 조회는 owner gate를 I/O 동안 보유하지 않으며 완료 시 attachment epoch를 재검증한다. 이전 GUI의 늦은 조회 결과를 새 GUI 확인의 증거로 채택하지 않는다.
- 구조 revision·대화 귀속/receipt·critical status probe는 daemon의 authoritative terminal 상태에서 검사한다. GUI mirror의 PID·generation·재생된 제목을 복원 ID 확인 근거로 사용하지 않는다. 세션 SQLite writer는 daemon 하나이며 GUI는 구조를 revision과 함께 제출한다.
- 화면 checkpoint는 VT snapshot·미완료 UTF-8/VT prefix·versioned parser supplement를 같은 generation/source sequence에 결부한다. supplement에는 고정 xterm 버전의 charset·tab stop·mouse encoding 같은 누락 상태만 담고 수입 전에 shape와 범위를 검증한다. snapshot parse 완료와 live delta 사이에서 적용한다. 재생된 업무 OSC나 query reply를 daemon에 다시 보내지 않는다.
- GUI 전용 Automation/Remote/MCP·설정 UI 경계는 유지한다. `lx` terminal 요청과 agent hook은 daemon 수명에 연결한다. WSL hook 전달은 별도 loopback 수신 경로와 terminal별 기존 hook token으로 인증한다. GUI의 공개 Automation 포트를 daemon 제어 endpoint로 사용하지 않는다.

## Alternatives Considered

- GUI/daemon generation 공유: presentation 재연결과 실제 PTY 생성을 구별하지 못하고 오래된 ACK가 현재 구독을 오염시킨다.
- proxy terminate를 daemon close에 연결: Drop·렌더러 실패·업데이트 정리가 사용자 프로세스를 종료한다.
- RPC 오류를 완료로 취급: 취소되지 않은 platform write가 controller 변경 뒤에도 계속될 수 있다.
- 조회/입력을 하나의 순차 연결에 배치: WSL·파일·SQLite 지연이 사용자 입력 경로를 점유한다.
- 손실된 VT 상태를 화면/커서로 추정: 이후 tab·charset·mouse 입력을 같은 의미로 처리할 수 없다.

## Consequences

새 GUI가 기존 PTY를 유지하면서 delivery를 복구할 수 있고 대화 조회 실패가 업데이트 인계나 정상 입력을 막지 않는다. 기존 controller/finalization의 안전 조건을 physical 작업 완료에 연결해 유지한다.

projection mapping·구독 복구·완료 확인·parser supplement 버전 검증이 필요하다. 실제 dev에서 입력/resize·slow GUI·gap·update restart·true quit·GUI crash를 검증하고 다중 pane flood·Remote owner 변경·hook/offline 저장·PC 재기동 수준 복원을 완료 조건으로 둔다.
