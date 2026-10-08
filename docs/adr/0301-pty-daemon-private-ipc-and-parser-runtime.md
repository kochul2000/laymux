# 0301. PTY 데몬은 사용자 전용 인증 IPC와 버전 고정 parser 런타임을 사용한다

- Status: Proposed
- Date: 2026-10-07
- Source: 사용자 구현 진행 지시, [ADR-0300](0300-detached-pty-daemon-update-handoff.md), [PR #1143](https://github.com/kochul2000/laymux/pull/1143), headless xterm 실제 셀 복원 및 private stdio worker 실험
- 관계: ADR-0300의 IPC·VT worker·runtime 배포 계약을 구체화한다. 기존 외부 Automation 포트·Remote 인증 정책은 변경하지 않는다.

## Context

앱과 데몬의 수명을 분리하면 PID나 파일의 존재만으로 재연결 대상을 신뢰할 수 없다. 오래된 GUI의 입력/종료가 다른 generation에 적용되는 문제와, 임시 연결 장애를 사용자 작업 종료로 처리하는 문제를 차단해야 한다. Windows·Linux의 로컬 권한 경계를 사용하며 설치 과정에서 살아 있는 daemon 이미지를 덮어쓰지 않아야 한다.

headless xterm 6.0.0과 serialize addon 0.14.0의 실제 화면 비교에서 명시적인 마지막 열 cursor 복원이 한 칸 어긋나는 결함을 재현했다. wrap-pending은 보존하고 명시적인 cursor 위치는 복원 뒤 보정해야 한다. 기존 Unicode provider를 공유했을 때 한글·이모지 셀 배치와 UTF-8 분할 입력을 동일하게 처리했다. parser 프로세스의 stdin write도 멈출 수 있으므로 stdout 응답 대기만 timeout으로 감싸면 충분하지 않다.

## Decision

**private daemon IPC는 instance 인증·generation·attachment epoch를 검증하고, Node 24 계열의 동봉 런타임에서 동일한 headless xterm을 실행하며 모든 worker IO를 유계로 처리한다.**

- Windows named pipe와 Linux Unix socket은 현재 사용자만 연결할 수 있게 설정하고 원격 pipe client를 거절한다. 다른 사용자·로그인 세션·build/profile/worktree를 대상으로 재연결하지 않는다. 인증용 instance capability는 사용자 전용 discovery에 보관하며 로그·설정 export·자식 터미널 환경에 노출하지 않는다.
- Windows 권한은 token group에서 실제 logon SID를 읽어 설정한다. UAC의 AuthenticationId로 SID를 합성하지 않는다. 양쪽 pipe peer의 kernel PID로 로그인 신원을 검사한다. Linux는 UID와 audit session ID를 확인하며 scope에는 audit ID 또는 XDG 로그인 세션을 포함한다. `setsid()`로 바뀌는 process session ID를 로그인 신원으로 사용하지 않는다. Linux socket은 긴 state 경로와 분리한 짧은 0700 디렉터리에 만들고 파일 권한을 0600으로 제한한다.
- handshake는 protocol version 1, daemon incarnation, runtime bundle identity와 catalog를 확인한다. 제어 요청은 incarnation·attachment epoch·terminal generation을 검증한다. 인증 실패나 오래된 epoch는 입력·resize·종료를 수행하지 않는다. 전송 실패한 human input은 자동 재시도하지 않는다.
- 새 nonce와 protocol·scope·incarnation·runtime 전체에 HMAC-SHA256를 적용한다. client와 server의 proof에는 서로 다른 role label을 사용해 상호 인증하고 reflection을 거절한다. 동시에 하나의 GUI만 attach한다. detach와 연결 중단은 그 연결의 권한만 폐기하며, 취소된 connection task의 Drop도 atomic liveness를 폐기한다. 늦은 disconnect가 다음 GUI의 epoch를 폐기하지 않는다. 요청 ID는 연결별로 단조 증가하며 재전송된 제어를 실행하지 않는다.
- GUI 연결 단절과 출력 구독 실패는 사용자 PTY 종료와 구분한다. GUI-owned handle의 Drop/fatal transport 정리가 daemon-owned PTY를 종료하지 않도록 ownership을 명시한다. 완전 종료·명시적 삭제만 검증된 대상에 종료 요청을 보낸다.
- Node **24.21.0**·headless xterm 6.0.0·serialize addon 0.14.0·공유 Unicode provider·worker bundle을 동일 immutable runtime에 고정한다. Node 배포 artifact와 라이선스 checksum을 빌드 시 검증한다. 사용자 PATH의 Node는 production fallback으로 사용하지 않는다. bundle identity는 이름별 파일 hash를 담은 manifest의 SHA-256이다. 새 디렉터리를 완성한 뒤 rename으로 게시하며 live bundle을 교체하지 않는다. [Node 배포 정본](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt).
- daemon은 GUI 초기화 전에 별도 실행 모드로 진입한다. 짧게 실행되는 중간 launcher 뒤에 남으며 Windows에서는 독립 process group과 job breakaway, Linux에서는 독립 session을 사용한다. kernel 파일 수명 lock으로 같은 SQLite profile의 daemon writer를 하나로 제한한다. PID와 오래된 discovery 파일만으로 기존 process를 종료하거나 새 writer를 승인하지 않는다.
- private IPC frame은 16 MiB, read/write deadline은 5초, 동시 연결은 8개로 제한한다. idle GUI client는 heartbeat를 보내며 연결 만료를 PTY 종료로 처리하지 않는다. parser process heap은 512 MiB, normal/alternate screen의 합계 cell 예산은 4,194,304개다. geometry는 OS process 생성 전에 승인하고 scrollback은 화면 수와 폭에 맞춰 이 예산 안에서 나눈다.
- worker는 Rust가 소유하는 private stdio로만 JSON request/response를 교환한다. 요청 ID를 검증하고 frame은 16 MiB로 제한한다. blocking stdin write와 stdout read는 별도 IO thread가 소유하고 호출자는 최대 5초 뒤 자기 parser process만 중단해 pipe를 해제한다. parser process는 사용자 PTY와 별도 수명이다.
- 잘못된 generation·없는 terminal·잘못된 operation의 거절은 parser 전체 종료 사유가 아니다. response ID 불일치·IO 종료·frame 손상·deadline 만료는 해당 parser instance를 unavailable로 표시한다. 다른 instance/사용자 process를 PID 이름으로 찾아 종료하지 않는다.
- snapshot은 실제 xterm 상태에서 생성한다. 명시적 cursor 보정은 pending wrap과 구분한다. resize·mode·OSC 색상/링크·normal/alternate buffer 상태도 검증한 checkpoint 계약으로 보존한다. raw output replay로 과거 protocol reply나 업무 OSC를 다시 실행하지 않는다.
- 공개 API가 누락한 scroll margin·saved cursor·미완료 parser/UTF-8 prefix는 버전 고정 adapter가 실제 parser 상태에서 읽는다. 완료된 OSC/질의는 replay하지 않고 미완료 prefix만 다음 delta 앞에 연결한다. serialize addon의 OSC 8 누락은 daemon 사본에서 보완한다. snapshot에 `generation`과 parser가 완료한 `sourceSeq`를 결부한다. binding을 교체하는 권한은 새 core generation의 prepare 경로에만 두며 늦은 이전 generation 출력은 거절한다.
- GUI ESM·GUI/Remote CJS·headless의 width reflow 패치를 동일하게 적용한다. 여러 retained row가 남으면 마지막 row의 `isWrapped`를 유지한다. 화면 테스트는 제품이 배포하는 patched ESM을 직접 사용한다. 기본 theme·내장 palette·Unicode provider도 GUI와 worker가 공유한다.
- GUI가 없는 동안에도 protocol query는 headless parser가 단일 응답한다. GUI/Remote는 mirror로 동작하고 동일 query를 PTY에 다시 답하지 않는다. Rust는 기존 live OSC 업무 처리와 PTY input origin 분리를 소유한다.

## Alternatives Considered

- 외부 Automation TCP 포트를 daemon IPC에 재사용: 기존 공개/Remote 권한 경계와 daemon 재연결 수명이 결합된다.
- PID와 socket 파일의 존재만 확인: PID 재사용·다른 profile/worktree·stale client의 제어를 막지 못한다.
- 사용자 Node를 PATH에서 실행: 런타임 누락·버전 변화로 배포된 기능이 달라진다.
- worker stdin을 호출자 thread에서 직접 쓰기: parser가 읽지 않으면 timeout 이전의 write에서 무한 대기할 수 있다.
- cursor 위치만 직렬화하고 VT 상태를 추정: scroll region·mode·wrap·색상과 링크 등 이후 출력의 의미를 재현하지 못한다.

## Consequences

앱 재연결과 daemon 오류가 실제 작업 종료를 자동으로 유발하지 않고, 권한·instance·generation 경계를 테스트할 수 있다. 같은 VT 엔진과 Unicode provider를 사용해 GUI 복원과 query 응답의 이중 구현을 줄인다.

대신 parser 런타임의 배포 용량·버전 보관·private IO thread·frame 한도·장애 처리와 권한 설정을 운영해야 한다. worker 오류 시 출력 처리 중단과 복원 가능 범위를 명시해야 하며 프로세스 메모리가 살아 있다는 사실만으로 정상 진행을 보장하지 않는다. IPC 인증·stale 제어·blocking IO와 실제 xterm cell/VT/query 검증, Windows 설치 잠금과 Linux socket 검증을 구현 PR의 완료 조건으로 둔다.

parser가 소실되거나 generation의 파싱이 실패하면 해당 실행 경로의 새 입력·생성·resize를 unavailable로 거절한다. 명시적 close와 catalog 조회는 계속 허용한다. parser 정리는 이미 종료된 PTY close의 성공을 되돌리지 않는다. GUI의 전체 연결 인계, offline 세션 저장과 Linux 실기 검증이 남아 있는 동안 기본 앱 경로에는 daemon을 활성화하지 않는다.
