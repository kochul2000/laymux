# 0364. 명시적 터미널 종료는 PTY 단절 전에 foreground 작업에 정상 종료를 요청한다

- Status: Accepted
- Date: 2026-10-29
- Source: 사용자의 pane·앱 창 종료 시 SIGTERM 요청과 업데이트 인계 보존 요구, dev의 foreground Compose·신호 관측 실기, [data-flow.md §8.23](../architecture/data-flow.md#823-pty-소유자와-pty-데몬), ADR-0300·0308·0336
- Amends: ADR-0300의 명시적 종료 절차. ADR-0308의 업데이트 인계와 ADR-0336의 WebView 복구 인계는 유지한다.

## Context

WSL의 foreground `docker compose up`은 Ctrl+C 이후 컨테이너를 중지하지만, laymux와 Windows Terminal의 터미널 닫기 이후에는 계속 실행됐다. 같은 조건의 일반 프로세스에는 SIGINT 대신 SIGHUP이 관측됐다. 따라서 attached 실행만으로 터미널 수명과 컨테이너 수명이 묶이지 않는다. daemon PTY와 in-process PTY에서 동일하게 재현됐으며 Codex를 실행하지 않아도 발생했다.

사용자는 명시적 pane 닫기와 앱 창 종료에서 작업에 정상 종료 기회를 주되, 업데이트 동안에는 살아 있는 작업을 새 GUI에 인계하도록 요구했다. Docker project 이름을 추정하거나 다른 pane이 공유하는 서버·컨테이너를 종료해서는 안 된다. 이미 실행 중인 이전 세대 PTY 데몬도 업데이트 후 재결합할 수 있으므로 새 데몬 코드에만 의존해서는 안 된다.

## Decision

**GUI의 명시적 종료는 PTY를 끊기 전에 해당 세대의 foreground 작업에 정상 종료를 요청하고 최대 12초 기다린 다음 기존 PTY 종료·강제 종료 fallback을 수행한다.**

- 정상 종료 요청의 주체는 GUI이고, OS PTY와 최종 강제 종료의 소유자는 기존 backend다. GUI는 daemon 소유 PID를 직접 강제 종료하지 않는다. 이전 데몬에 재결합한 경우도 GUI가 정상 종료 단계를 수행한 뒤 기존 terminate 프로토콜을 사용한다.
- Linux와 WSL은 현재 PTY foreground process group에 SIGTERM을 보낸다. WSL은 배포판·실행 사용자·terminal ID·기존 agent hook token으로 실제 PTY session leader를 검증한다. 모호하거나 검증할 수 없는 대상에는 신호를 보내지 않는다. 정상 종료는 저장된 앱 이름이나 표시 캐시를 근거로 실행하지 않는다.
- Native Windows는 별도 headless helper가 해당 자식의 생성 식별자를 검증하고 그 콘솔에만 연결해 CTRL_C_EVENT를 보낸다. 프로세스 전체의 GUI 콘솔 상태를 변경하지 않는다. Unix SIGTERM이 있는 것처럼 취급하지 않는다.
- 신호를 보내는 동안 물리적 PTY 연결을 유지한다. 명시적 종료는 출력 세대를 논리적으로 retire하기 전에 해당 세대의 discard-drain을 설정한다. 이후 바이트는 UI·OSC·활동 상태에 발행하지 않고 계속 읽어 버리며, 정상 종료 완료 또는 제한 시간 뒤 기존 PTY teardown이 실제 reader를 끝낸다. fault retirement와 reconnect에는 이 예외를 적용하지 않는다. 대기 대상은 foreground 작업이며, 작업이 끝난 뒤 프롬프트로 돌아온 셸 자체가 종료되기를 무한히 기다리지 않는다. 대상 확인 실패·권한 부족·시간 초과는 경고를 남기고 기존 종료 fallback으로 진행한다.
- 명시적 pane·workspace 종료와 정상 앱 종료에 적용한다. 재시작·checkpoint 후 숨김 eviction처럼 같은 PTY close transaction을 쓰는 경로에도 적용하며, 입력 fault 등 raw retirement에는 적용하지 않는다. 앱 종료의 등록된 여러 대상은 병렬 처리하고 전체 종료 대기에도 상한을 둔다. 반복 종료 요청은 같은 handle의 정상 종료 단계를 중복 실행하지 않는다.
- 업데이트·WebView 복구의 handoff가 시작되면 이 단계를 실행하지 않는다. daemon 세션은 신호·terminate 없이 유지하며, 기존 in-process·probe 정리는 기존 방식으로 수행한다. 업데이트 실패로 handoff를 취소하면 다음 정상 종료에 다시 적용한다.
- Docker 전용 탐색·전역 정리·detached container 종료·공유 Codex daemon 종료는 하지 않는다. PTY 밖으로 분리된 작업의 수명 관리와 이번 종료 정책은 별개다.

## Alternatives Considered

- PTY를 먼저 닫고 대기 시간만 늘리기: Compose가 SIGHUP을 정상 중지 요청으로 처리하지 않으므로 기각한다.
- Ctrl+C 바이트만 쓰기: raw 입력을 소비하는 TUI와 Windows 콘솔에서 정상 종료 신호 전달을 보장하지 못한다.
- 모든 자식·공유 daemon·Docker project를 찾아 종료하기: 다른 작업의 수명과 데이터를 침범하므로 기각한다.
- 새 PTY 데몬에서만 정상 종료하기: 업데이트로 남은 이전 세대 데몬에는 적용되지 않으므로 기각한다.
- 업데이트에서도 동일한 종료 정책 적용: 실행 중 세션을 보존하는 기존 인계 계약을 깨뜨리므로 기각한다.

## Consequences

foreground Compose를 비롯한 정상 종료 신호 처리 프로그램은 자신의 정리 절차를 수행할 기회를 얻는다. 종료가 기존보다 늦어질 수 있으며, 비협조적인 작업이나 검증 실패에 대해 완전한 정리를 보장하지 않는다. WSL의 선택적 daemon metadata는 이후 재결합에서도 원래 배포판·사용자를 보존한다. 기존 데몬 wire protocol은 변경하지 않는다.

앱 종료 UI는 기존 저장·선택적 Ctrl+C·Codex 확인 예산에 병렬 PTY 정리 예산 18초를 더한다. 5초 저장 제한만 적용해 정상 종료 대기 중에 실패 판단을 내리지 않는다. Windows 실기의 Compose v5.5.1은 콘솔 Ctrl+C/Break 요청에도 컨테이너를 남겼으므로 Windows 콘솔 이벤트를 Docker 정리 보장으로 해석하지 않는다. 이 경우도 제한 시간 후 기존 PTY 종료로 진행하며, 검증용 project는 별도의 명시적 `down`으로 정리한다.

TDD와 dev 실기로 SIGTERM 수신·정리 완료·timeout fallback·다른 pane 격리·daemon/in-process·앱 종료를 검증한다. Windows dev의 업데이트 prepare/installer 인계에서는 guest PID·daemon session·동작 중 컨테이너와 재결합 후 명시적 종료를 검증한다. Linux용 restart 인계와 인계 취소 경계는 정책 단위 테스트로 검증하며 Windows에서 Linux용 `app.restart()`의 동작을 대체 주장하지 않는다. 정상 종료 없이 강제로 GUI를 죽이는 경우의 자동 자원 회수는 범위 밖이다.
