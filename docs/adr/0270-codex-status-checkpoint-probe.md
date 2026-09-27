# 0270. Codex 종료 복원점은 선택적으로 `/status`로 확인한다

- Status: Accepted
- Date: 2026-09-27
- Source: 사용자 요청(기본 데몬의 세션 미식별 해결, 입력 삭제 후 `/status` 조회, 기본 켜짐), [data-flow §13.5](../architecture/data-flow.md), [ADR-0222](0222-agent-session-checkpoint-coordinator.md), [조사 기록](../codex-shared-daemon-attribution-repro-2026-09-26.md)
- Extends: ADR-0222의 종료·업데이트 귀속 수집. 일반 저장의 수동 관측 정책은 유지한다.

## Context

Codex의 기본 공유 데몬에서는 TUI 프로세스 진단에 현재 대화 ID가 없을 수 있다. 로그로 식별하는 기존 경로는 계속 유효하지만, 이 경우 critical checkpoint가 `activeButUnidentified`로 업데이트를 거부한다. `/status`는 TUI가 현재 표시하는 대화의 ID를 즉시 출력한다. 다만 사용자 입력창을 조작해야 하며, 좁은 창에서는 ID가 잘린다. 입력을 추측해서 전송하거나 과거 화면의 ID를 채택해서는 안 된다.

## Decision

`codex.verifySessionOnExit`(기본 true)가 켜져 있으면 일반 종료와 업데이트의 마지막 checkpoint 전에 Codex TUI의 입력을 비우고 `/status`로 복원점을 확인한다. 사용자 요청에 따라 신규 설정과 필드가 생략된 기존 설정은 켜짐으로 해석하며, 명시적으로 저장한 false는 유지한다.

- 옵션은 미전송 초안 삭제와 일시적인 터미널 크기 변경을 명시한다. 주기 저장, 완료 알림, workspace 전환, 숨김 pane 정리에서는 실행하지 않는다. 기존 로그 감지는 유지한다.
- backend가 짧은 수명의 조회 토큰, 대상 PTY generation, 실행 중인 Codex 프로세스, 원래 크기와 조회 출력 경계를 소유한다. 일반 종료는 입력 fence를 획득·drain하고, 업데이트는 해당 native checkpoint 요청이 이미 소유한 fence를 사용한다. 일반 입력과 Remote 제어는 이 구간에 끼어들 수 없다.
- 전용 IPC는 정해진 편집 키, `/status`, Enter만 허용한다. Ctrl+C는 입력 삭제·작업 중단·앱 종료 사이 의미가 달라 사용하지 않는다. 기본 편집 키의 유계 반복으로 앞뒤 입력을 지운 뒤, frontend의 실제 xterm 셀에서 `/status` 명령 선택 상태를 확인한 경우에만 Enter를 보낸다. 확인 실패는 사용자 초안을 제출하지 않고 조회를 실패시킨다.
- 조회 중에는 ID가 잘리지 않는 크기를 사용한다. frontend가 기존 parser drain·guarded fit 경로로 xterm 크기를 먼저 고정한 뒤 backend가 순서가 부여된 PTY geometry를 적용한다. 성공·실패 모두 원래 크기로 복구하고, 조회 중 실제 창 크기가 달라졌으면 기존 resize 경로로 다시 맞춘다.
- Enter 직전의 출력 경계 이후에 새로 출력된 `/status` 카드의 전체 UUID만 받는다. 과거 scrollback, 축약 ID, 복수 ID, generation·프로세스 교체와 조회 실패는 확정 증거가 아니다. 실제 rollout의 정확한 ID·최상위 역할을 검증하며, 영속 파일 없는 새 대화는 기존 Fresh 의미로 저장한다. WSL의 파일 부재는 해당 배포판 내부에서도 확인한다. UNC에서 읽지 못하는 symlink 뒤의 기록이나 접근 실패를 Fresh로 바꿔 기존 복원점을 지우지 않는다.
- 확인 결과는 해당 토큰과 fence 수명에서만 기존 backend 귀속 결과에 합쳐진다. critical checkpoint의 두 번 관측과 중복 소유권 검증을 유지하며 저장 이후의 Ctrl+C는 복원점을 다시 수집하지 않는다. 조회 실패는 종료·업데이트 준비를 중단하고 정리 후 fence를 해제한다. 기한은 증거만 만료시키며, 저장 중에 입력 차단을 자동 해제하지 않는다. 저장 완료 시 기한을 다시 검사하고 성공한 일반 종료는 창 파괴까지 fence를 유지한다. 이 단계에서는 기존 terminal close 정리만 허용한다. 초기 대상 수집에도 제한 시간을 적용한다.
- native와 WSL은 같은 입력·화면 절차를 사용하되 프로세스·rollout 확인은 기존 호스트별 조회 경로를 따른다. 공유 데몬을 종료하거나 Codex 설정·rollout을 변경하지 않는다.
- native 실행 환경은 sysinfo의 프로세스 조회로 읽는다. 실제 TUI의 홈·SQLite 경로·실행 인자·CWD를 확인할 수 없으면 Laymux 환경으로 추정하지 않는다. 조회한 환경 전체를 로그나 영속 상태에 남기지 않는다. WSL은 기존 배포판별 홈 조회와 rollout 검증을 사용한다.
- 기본 텍스트 편집기를 지원 범위로 한다. 입력 전 시작 인자와 사용자·프로젝트·시스템 TOML을 검사하여 CLI config/profile/CWD override, 편집 키 변경·Vim·include·별도 sqlite_home 설정을 거부한다. 프로젝트 설정 기준은 실제 Codex 프로세스의 작업 디렉터리를 포함하며 마지막 OSC 보고로 대체하지 않는다. WSL 설정은 해당 배포판 안에서 symlink를 따라 읽고, 읽기 실패를 파일 부재로 추정하지 않는다. chat 방향키 재지정은 조회에 사용하는 키와 겹치지 않으므로 허용한다. 이 검사는 TUI 내부의 현재 유효 설정을 반환하는 공식 API가 아니므로 실행 중 키맵 변경·다른 설정의 대화로 전환한 상태까지 보장하지 않는다.

## Alternatives Considered

- 기존 로그만 사용: 무입력 조회라는 장점이 있지만 공유 데몬에서 TUI의 현재 선택을 관측하지 못하는 경우를 해결하지 못한다.
- 종료 출력의 `codex resume` 수집: 유효한 대안이지만 작업 중 종료 메뉴와 TUI 종료 여부를 처리해야 한다. 사용자가 `/status`를 선택했다.
- 타이틀 설정·TUI 녹화 로그: 사용자 Codex 설정 또는 재시작이 필요하며 축약 ID와 무입력 전환의 한계가 있다.
- Ctrl+C로 입력 삭제: 빈 입력, 모달, 실행 중 이미지 처리에서는 종료·중단을 일으킬 수 있어 사용하지 않는다.
- 반복 Ctrl+U 뒤 즉시 Enter: 커서 뒤 텍스트와 여러 줄을 완전히 제거했다고 보장하지 못하므로 명령 선택 상태 확인을 생략하지 않는다.

## Consequences

기본 데몬과 기존 Codex 설정을 유지하며 종료 직전의 대화를 확인할 수 있다. 비용은 미전송 초안 손실, 화면 형식 의존성, 잠시 바뀌는 터미널 크기와 준비 지연이다. 미지원 모달·편집 모드·업스트림 화면 변경은 추측 대신 실패로 처리한다. 입력 선택, 오래된 화면 배제, 타임아웃·정리·generation 교체, 중복 ID, Fresh와 영속 대화, update fence를 테스트하고 실제 dev TUI에서 검증한다. Codex가 현재 TUI 대화를 제공하는 공식 조회 API를 제공하면 이 입력 기반 절차를 재검토한다.
