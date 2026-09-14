# 0247. 사용량 조회는 선택한 실행 환경의 로그인 상태로 복구한다

- Status: Proposed
- Date: 2026-09-14
- Source: 사용자 요구(WSL pane에서 로그인한 뒤 사용량 위젯 복구, Claude·Codex·Grok 동시 점검), architecture/data-flow.md §10.5
- Extends: [0102](0102-claude-usage-probe-headless-pty.md), [0104](0104-codex-usage-app-server-probe.md), [0156](0156-grok-first-class-agent.md)

## Context

Claude와 Grok의 장기 실행 프로브는 시작할 때 읽은 인증 상태를 유지할 수 있다. 기동 실패로 워커가 종료되거나 실패한 CLI를 그대로 재사용하면 다른 pane에서 로그인해도 사용량이 복구되지 않는다. Codex는 매번 새 app-server를 실행하지만 Windows 실행이 고정돼 WSL 로그인 저장소를 사용하지 않는다. 기존 Codex profile은 글꼴 선택만 담당한다.

범위는 조회 프로세스의 실행 환경과 실패 복구다. 로그인 자체, 토큰 복사, 사용자 터미널 입력, 새 설정 스키마, 실시간 로그인 감시는 범위가 아니다.

## Decision

**사용량 조회는 선택한 프로필의 실행 환경에서 인증 정보를 읽고, 실패한 PTY 세션은 다음 재조회 때 새로 기동한다.**

- Claude·Grok은 config dir당 수요 기반 워커와 마지막 스냅샷을 유지한다. 기동·조회 실패 시 자식 CLI와 PTY를 종료하고, 자동 또는 수동 재조회 때 같은 프로필·config dir로 기동한다. 성공한 CLI는 유지한다.
- 두 PTY provider의 실패 간격은 기존 Claude 정책을 공유한다. 최초 3회는 60초, 이후는 정상 600~3600초 간격이다. 재기동으로 실패 횟수를 초기화하지 않으며 성공 시 초기화한다. 구독 해제는 대기·기동을 취소한다.
- Codex의 기존 `usage.codex.profile`은 글꼴과 실행 환경을 함께 고른다. 빈 값은 `defaultProfile`이다. Windows에서 WSL 프로필이면 그 배포판·사용자·시작 경로 옵션을 보존해 WSL Bash 안에서 일회성 app-server를 실행한다. WSL 옵션 중 조회와 무관한 실행·관리 옵션은 오류로 거부하며 Windows 계정으로 폴백하지 않는다. 그 외 프로필은 기존 네이티브 실행을 유지한다.
- WSL Bash 초기화 후 명시적 `CODEX_HOME`을 위치 인자로 전달한다. 셸 코드로 보간하거나 Windows 경로로 변환하지 않는다. 빈 config dir은 해당 환경의 CLI 기본값을 쓴다. 토큰을 laymux가 읽거나 복사하지 않는다.
- Codex는 기존 stdio JSON-RPC와 구독별 공유 폴링을 유지한다. 매 조회는 새 프로세스이며, 실패가 다음 조회를 중단하지 않는다. WSL 자손이 파이프를 유지해도 호출자의 오류 출력 대기는 제한한다.

## Alternatives Considered

- Windows로 인증 파일 복사: 다른 계정·사용자 경계를 섞고 비밀 관리 책임이 생긴다.
- 로그인 파일 감시: provider별 저장소·키체인과 WSL 파일 감시 책임이 추가된다. 기존 재조회로 복구가 가능하다.
- 모든 정상 조회에서 PTY 재기동: 정상 CLI의 기동 비용을 불필요하게 반복한다.
- Grok 수동 refresh만 유지: 사용자 동작 없이 복구되는 위젯 요구를 충족하지 않는다.

## Consequences

WSL에서 로그인한 환경과 조회 환경이 일치하고 위젯 재구독 없이 복구된다. 복구 시점은 다음 재조회이며, 지속 실패 후에는 설정된 정상 간격만큼 늦을 수 있다. Grok도 제한된 빠른 재시도 비용을 부담한다. Codex의 WSL 프로필 선택은 기존 Windows 계정 대신 WSL 계정을 표시하므로 의도된 동작 변경이다.

WSL 초기화 설정과 CLI 설치 경로에 의존한다. 오류는 기존 snapshot 상태로 노출한다. 실제 WSL PTY·stdio에서 임시 인증 상태 변경과 자동 복구를 검증하고, 구독 해제와 실패 횟수 제한을 테스트한다. CLI가 인증 변경 알림을 공식 제공하면 감시 도입을 재검토한다.
