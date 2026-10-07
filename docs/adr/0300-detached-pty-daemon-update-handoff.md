# 0300. PTY 데몬이 작업을 유지하고 앱 업데이트는 연결을 인계한다

- Status: Proposed
- Date: 2026-10-07
- Source: 사용자 요구("업데이트 재시작 같은건 pty로 이어가면 되니까"), [PR #1142](https://github.com/kochul2000/laymux/pull/1142), [현재 종료·체크포인트 흐름](../architecture/data-flow.md#134-종료-시퀀스), [구현·검증 계획](../plans/pty-daemon-update-handoff.md)
- 관계: ADR-0201·0222·0270·0296의 업데이트 전 사용자 PTY 종료와 대화 확인 barrier를 연결 인계로 대체한다. ADR-0067의 ConPTY 배치 경계와 ADR-0068의 protocol responder 소유권을 확장한다. ADR-0299의 portable 설정/로컬 SQLite 분리와 PC 재부팅 후 명시적 resume는 유지한다. 이 Proposed 문서는 기존 Accepted ADR의 현재 효력을 바꾸지 않는다.

## Context

laymux는 이미 Rust `portable-pty`로 터미널을 실행한다. PTY handle, 출력/OSC, 대화 귀속과 종료 gate가 Tauri 앱의 상태에 속하므로 앱 재시작은 작업 종료·복원과 결합된다. Windows에서는 설치 디렉터리의 ConPTY 실행 이미지가 열린 터미널에 매핑된다. 업데이트가 사용자 PTY를 끝내 파일 잠금을 풀어야 하므로 설치 직전에 정확한 대화 복원점을 확인한다.

WSL 프로세스 조회가 deadline 안에 끝나지 않으면 실행 중 대화가 `Unknown`으로 남아 업데이트를 막을 수 있다. PR #1142는 이때 검증된 이전 ID를 보존하고 일반 저장을 재시도하지만, 사용자 프로세스를 종료하는 업데이트의 안전 조건은 그대로다. 사용자는 업데이트·앱 재시작 중에도 Codex와 셸 작업을 계속 실행하고, 작업까지 완전히 종료하거나 PC를 재부팅할 때만 저장된 대화로 복원하기를 원한다.

프로세스만 분리하면 충분하지 않다. GUI가 없을 때 출력 credit와 VT query 응답이 멈추면 자식은 출력이나 응답을 기다리며 정지한다. 오래된 GUI ACK·입력·종료 요청이 재연결 뒤 살아 있는 다른 세대에 적용되면 작업 보존도 깨진다. 새 설치본이 기존 데몬 파일을 덮거나 호환 불일치를 이유로 데몬을 죽여도 같은 문제가 재발한다.

범위는 Windows·Linux에서 실행 중인 사용자 PTY를 앱 수명과 분리하고 업데이트·재시작에서 재연결하는 것이다. PC 전원 차단 후 프로세스 메모리 유지, 실행 중 PTY의 다른 데몬으로 이동, GUI가 없는 동안 Remote/Automation/MCP 전체 서비스를 제공하는 것은 범위 밖이다. WSL 대화 조회 최적화는 별도이며 데몬 자체 재시작과 실제 작업 종료에서는 기존 확인이 계속 필요하다.

## Decision

**Rust PTY 데몬이 터미널 실행·출력·OSC·복원 상태를 소유하고, 앱 업데이트와 재시작은 사용자 작업을 종료하지 않는 인증된 detach/attach 인계로 처리한다.**

### 수명주기

| 의도                                              | 사용자 PTY와 데몬                          | 저장·확인                                                                   |
| ------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| 앱 업데이트·명시적 앱 재시작                      | 계속 실행, 새 GUI가 같은 generation에 연결 | UI 구조 저장과 인계 ACK 필요, 대화 확인 미완료만으로 인계 차단 안 함        |
| 작업까지 완전 종료·개별 터미널 삭제·숨김 eviction | 해당 작업을 종료                           | 기존 conclusive checkpoint·입력 fence·인터럽트·손실 동의 유지               |
| GUI crash·연결 유실·업데이트 설치 실패            | 계속 실행하며 재연결 대기                  | 평상시 복원 저장 지속, 연결 단절을 작업 종료로 해석하지 않음                |
| PC 재부팅·데몬 소실                               | 새 데몬의 새로운 generation으로 시작       | SQLite의 검증된 복원점으로 resume, 실행 메모리/진행 중 연산은 복원하지 않음 |

닫기 버튼의 일반 종료 의미는 작업까지 완전 종료로 유지한다. 클라이언트 접속 수가 0이 됐다는 이유로 작업을 자동 종료하지 않는다. 업데이트를 강제로 인계 모드로 바꾸는 플래그 대신 `restart/update/shutdown` 의도를 명시적으로 전달한다. 개별 terminal 종료 권한은 attach 권한과 구별한다.

### 상태와 저장 소유권

- Rust 데몬이 PTY handle, 생성/종료, input·resize FIFO, terminal generation, 출력 순서/retention, OSC action, 훅·프로세스 귀속, CWD 원시 상태와 일반 복원 저장을 소유한다. OSC의 업무 처리는 Rust 단일 패스를 유지한다(ADR-0001). 재생된 화면 바이트로 훅·CWD·대화 이벤트를 다시 발생시키지 않는다.
- Tauri 앱은 workspace/dock/pane 배치·현재 view·설정 UI·Remote/Automation/MCP의 기존 외부 진입점을 소유하는 클라이언트다. 살아 있는 terminal을 앱 시작 시 DB 값으로 다시 생성하지 않고 데몬 catalog의 content ID·generation과 결합한다. terminal ID만 같다는 이유로 다른 daemon incarnation이나 generation의 handle을 재사용하지 않는다.
- 세션 영역의 SQLite writer는 데몬 하나다. GUI는 구조 변경을 revision과 함께 제출하며 데몬은 현재 terminal generation·구조 revision을 검사한 뒤 commit한다. GUI 미접속 중에도 CWD·검증된 대화 ID·confidence를 저장한다. Unknown 보존, 부분 저장 재시도, stale collection 거절과 transaction 원자성은 유지한다.
- portable `settings.json`과 machine 구성 변경은 기존 Rust 설정 경계를 유지한다. 구성과 세션은 서로의 행을 교체하지 않고, commit revision으로 결합한다. 설정 파일·DB I/O와 IPC 대기는 런타임 락을 보유한 채 실행하지 않는다.
- `lx`의 terminal 관련 요청과 에이전트 훅의 로컬 수신 경로는 데몬으로 연결한다. GUI에만 존재하는 파일 열기 등 요청은 GUI 미접속 시 명시적인 unavailable 결과를 반환한다. GUI의 외부 Automation 포트와 daemon IPC를 같은 endpoint로 사용하지 않는다.

### 출력·VT 상태와 입력

- 데몬은 GUI가 없을 때도 출력 전체를 순서대로 파싱하고 bounded한 현재 화면·scrollback을 유지한다. GUI parsed ACK를 데몬의 PTY read 진행 조건으로 삼지 않는다. 느린 GUI는 화면 구독만 재동기화하고, 데몬 parser 자체 과부하는 기존 bounded backpressure로 처리한다. 미파싱 prefix를 버리지 않는다(ADR-0097).
- 화면과 terminal protocol query 상태는 frontend와 동일 버전·동일 패치의 **headless xterm worker**가 소유한다. Rust가 별도 VT 의미론을 추정하지 않는다. worker 배포 런타임과 snapshot import/export는 구현 전 실험으로 검증하고 버전 고정하며, 대체 엔진을 선택하려면 이 결정을 다시 판정한다.
- worker에 필요한 JavaScript 런타임은 daemon bundle에 동봉한다. 사용자 PC의 Node 설치나 PATH에 의존하지 않는다. 런타임·addon·기존 frontend 패치의 호환성 및 snapshot이 보존하지 못하는 상태는 구현 전 gate에서 명시적으로 검증한다.
- DSR·DA·DECRQM·색상 query 등은 데몬의 headless parser 한 곳만 응답한다. Desktop/Remote xterm은 display mirror이고 과거 snapshot·재연결 replay에서 PTY reply를 보내지 않는다. human input과 protocol reply의 출처 분리, width/grapheme와 resize 순서, DECSET 2026 계약을 유지한다. GUI 미접속 중 임의의 고정 커서 좌표로 응답하지 않는다.
- attach는 parser가 확정한 동일 generation·출력 sequence의 화면 checkpoint와 이후 delta를 전달한다. 경계에서 발생한 출력은 누락·중복 적용하지 않는다. retention 범위 밖 재접속은 새 화면 checkpoint로 동기화하고, snapshot 불일치·파싱 실패는 typed 오류로 표시한다. 임의의 tail 바이트를 현재 화면으로 취급하지 않는다.
- 입력·resize·종료·ACK에는 daemon incarnation, terminal generation, attachment epoch를 결부한다. 오래된 client의 제어를 거절하고 단일 input owner를 유지한다. ACK가 유실된 human input은 자동 재전송하지 않는다. UI 단절이 PTY fatal 오류가 되지 않게 구독 수명과 PTY 수명을 분리한다.

### IPC·프로세스·버전

- Windows는 사용자 전용 named pipe, Linux는 사용자 전용 Unix socket을 사용한다. OS 사용자/로그인 세션 확인과 per-instance capability로 인증한다. build kind·프로필·dev worktree 신원이 다른 데몬에 연결하지 않는다. capability를 settings export·로그·터미널 환경에 노출하지 않는다. daemon endpoint는 LAN에 공개하지 않는다.
- 프로세스 PID·파일 존재만으로 기존 데몬을 승인하지 않는다. 인증된 handshake에서 incarnation, protocol major/minor, capability, runtime bundle ID, catalog revision을 확인한다. 최초 기동은 단일-instance gate로 직렬화한다.
- GUI와 데몬의 호환 가능한 버전을 rolling update로 유지한다. 호환되지 않으면 실행 중 데몬을 강제로 재시작하지 않고 앱 업데이트를 인계 전에 차단한다. 매 릴리스는 직전 출하 데몬과의 호환 조합을 검증하며, breaking 변경은 작업을 완전 종료한 뒤 적용한다.
- GUI가 업데이트돼도 기존 데몬과 headless worker는 실행 중 runtime bundle에 고정한다. 기존 PTY를 새 worker로 자동 이관하지 않는다. runtime binary의 mtime 변경을 데몬 종료 조건으로 삼지 않는다. 실제 daemon runtime 갱신은 사용자 작업이 없는 시점에 수행한다.
- Windows에서는 데몬 executable·ConPTY·headless worker와 필요한 helper를 LOCALAPPDATA의 build별 버전 디렉터리에 staging한다. Linux는 XDG_STATE_HOME 아래 build별 버전 디렉터리를 사용한다. live bundle은 immutable하며 설치기가 덮거나 지우지 않는다. 실행 중인 bundle의 GC는 거절한다. 지원 ConPTY 파일은 현재처럼 정확한 내용과 아키텍처를 검증한다(ADR-0067).
- GUI `Drop`과 updater의 `on_before_exit`는 자기 임시 probe/helper만 정리한다. daemon-owned 사용자 PTY는 종료하지 않는다. Windows 설치 대상 파일의 쓰기 가능 검사는 유지하며 unrelated 프로세스의 잠금이 풀리지 않으면 인계 단계에서 명시적으로 실패한다. 파일 잠금을 풀려고 데몬을 죽이지 않는다.

### 업데이트 인계와 실패

서명 검증과 다운로드 뒤 새 GUI/runtime 후보의 호환성·파일 배치 가능성을 확인한다. GUI 구조 변경을 DB에 commit하고 데몬에 update handoff를 요청한다. 데몬은 현재 incarnation·catalog·DB revision·bundle pin과 detach 뒤에도 출력/저장을 계속 처리할 준비를 결부한 일회성 인계 ACK를 반환한다. 이것은 대화 확인 완료 receipt와 다른 계약이다. ACK 확인 뒤 GUI 제어권을 반납하고 설치기로 넘어간다.

Unknown 대화 ID는 이전 복원점을 보존하며 인계할 수 있다. DB 저장 실패·데몬 인증/호환성 실패·인계 ACK 실패는 설치기를 실행하기 전에 업데이트를 취소한다. ACK 뒤 설치 실패나 새 GUI 기동 실패가 나도 작업은 데몬에서 계속 실행한다. 새 GUI는 catalog로 재연결하고 레이아웃·출력 checkpoint를 적용한다. 기존 PID나 session ID만 보고 다른 데몬에 연결하거나 중복 resume하지 않는다.

데몬/worker 장애와 GUI 재연결 실패는 서로 다른 typed 상태로 노출한다. headless parser의 오류로 생존 작업을 무조건 종료하지 않고 오류·backpressure·복원 가능 범위를 표시한다. daemon incarnation이 바뀌면 이전 입력·ACK·handoff token은 무효다. PC 재부팅과 데몬 소실 후 복원은 ADR-0299의 디스크 복원 경로를 사용한다.

## Alternatives Considered

- **앱 안 PTY와 조회/receipt 최적화 유지:** 지금 종료 지연을 줄일 수 있고 PC 재부팅 후 resume에는 충분하다. 앱 업데이트 동안 실행 중 연산·셸을 유지하지 못한다.
- **파일 잠금이 풀릴 때까지 기다리며 PTY를 남김:** Windows 설치 디렉터리의 live ConPTY 이미지와 끊어진 입출력/query 응답 수명을 해결하지 못한다.
- **tmux/WSL 전용 분리:** Linux/WSL에서 유용하지만 native Windows·PowerShell의 동일 사용자 동작과 번들 ConPTY 계약을 충족하지 못한다.
- **Rust에서 VT 화면을 새로 구현:** frontend xterm과 width·alternate buffer·query 응답 의미론이 달라질 위험과 이중 구현 비용이 크다. 같은 xterm 버전의 headless worker를 선택한다.
- **Superset의 host service 전체 구조 도입:** 앱 재시작을 넘는 데몬 소유권은 참고하되, Remote/Automation·workspace 서비스 전체 이전은 현재 목표에 불필요하다. Superset 공식 FAQ는 Windows를 아직 지원 대상으로 두지 않으므로 Windows 인계/패키징 검증을 대신하지 않는다.
- **새 앱과 구 데몬이 불일치하면 즉시 kill/restart:** 구현은 단순하지만 작업 유지 목적을 깨뜨린다. 호환성 gate와 idle 시 bundle 갱신을 선택한다.

## Consequences

업데이트가 실행 중 작업을 파괴하는 경계에서 GUI 연결 교체로 바뀐다. 종료 시 대화 검증 비용과 WSL 귀속 조회 실패가 정상 업데이트를 막는 결합을 없앨 수 있고, GUI crash 뒤에도 같은 PTY로 돌아올 수 있다. PC 재부팅 복원과 Unknown 보존에는 SQLite가 계속 필요하다.

대신 로컬 IPC, 재연결·credit, headless VT worker와 배포 런타임, 버전 호환 매트릭스, immutable bundle 및 GC, GUI 미접속 중 저장, 권한/소유권 전환을 운영해야 한다. 구현 전에 headless xterm의 기존 패치·query·serialize/resize 의미론과 Windows 설치 파일 교체를 실측한다. 충족하지 못하면 daemon 유지 업데이트를 출하하지 않고 기존 종료·복원 경로를 유지한다.

구현은 [단계별 계획과 TDD 수용 조건](../plans/pty-daemon-update-handoff.md)에 따라 작은 PR로 나눈다. 이 ADR PR은 설계만 제안하며 현재 제품 동작·설정 스키마를 변경하지 않는다. 새 기능을 켜기 전에 관련 Accepted ADR의 부분 대체 상태와 living doc을 구현 PR에서 갱신한다. 기존 mixed JSON/DB의 자동 migration은 만들지 않는다.

실행 중인 데몬의 무중단 교체, GUI가 없는 동안 Remote 서비스를 계속 제공하기, 다른 VT 엔진으로 교체, 플랫폼별 로그인 세션 경계를 바꿀 필요가 생기면 새 ADR로 다시 결정한다.

### 참고 근거

- [Superset 공식 FAQ](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/faq.mdx): background daemon의 앱 재시작/업데이트 유지와 지원 플랫폼.
- [Superset의 dev rebuild에 의한 daemon 종료 보고 #3611](https://github.com/superset-sh/superset/issues/3611): mtime 기반 재시작이 실행 중 작업을 파괴한다는 보고와 protocol 호환성 문제.
- [Microsoft ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole): pseudoconsole 종료가 연결된 client에 종료 이벤트를 전달하는 계약.
- [xterm.js 공식 headless 설명](https://github.com/xtermjs/xterm.js#nodejs-support): 서버 측 terminal 상태 관리와 serialize addon을 통한 재연결 사용 사례. 이것이 laymux의 모든 화면·query 상태를 보장한다고 가정하지 않는다.
