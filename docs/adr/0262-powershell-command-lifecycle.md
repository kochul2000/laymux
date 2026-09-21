# 0262. PowerShell 작업 경계는 수락된 줄 입력과 프롬프트가 소유한다

- Status: Proposed
- Date: 2026-09-21
- Source: [#1058](https://github.com/kochul2000/laymux/issues/1058), 사용자 dev 재현·TDD 수정 PR 요청, [data-flow §9](../architecture/data-flow.md#작업-상태와-출력-활동-adr-0250)
- Extends: [ADR-0250](0250-terminal-task-state-and-notification-transitions.md)의 셸 관측 경로. 작업·출력 분리와 공통 정책은 유지한다.

## Context

PowerShell의 기존 통합은 프롬프트마다 OSC 133 D만 보낸다. 두 번째 명령이 실행되는 동안에도 이전 성공이 현재 상태로 남아 선택기가 체크를 표시하고 clear를 허용하며 자동 절전을 억제하지 않는다. 2026-09-21 main `12707ed9`의 격리 dev에서 출력 없는 대기 중 이 세 값을 확인했다.

키 입력·출력·무출력은 명령 실행의 증거가 아니다. PSReadLine의 키 바인딩을 바꾸거나 Enter마다 시작을 합성하면 멀티라인 편집·paste·취소에서도 잘못된 작업이 생긴다. `$LASTEXITCODE`만 읽으면 native 실행 뒤 성공한 cmdlet이나 실패한 cmdlet의 결과도 틀린다.

범위는 laymux가 생성하는 PowerShell 통합이다. CMD에 preexec를 새로 구현하거나 비통합 셸의 무출력 명령을 추론하지 않는다. 사용자 프로필 파일·PSReadLine 설정·키 바인딩·명령 이력을 변경하지 않는다.

## Decision

**PowerShell은 기존 PSConsoleHostReadLine이 실행할 입력을 반환한 뒤 C를 보내고, 그 실행에 대응하는 다음 프롬프트에서만 D를 보낸다.**

- Rust가 내장 통합 스크립트를 주입하고 기존 Rust OSC 단일 패스가 C/D/A를 구조화 이벤트로 바꾼다. Desktop·Remote·알림·절전·clear는 기존 공통 task 정책을 그대로 쓴다.
- 이미 로드된 PSReadLine의 기존 `PSConsoleHostReadLine` 함수를 감싸고 반환 문자열을 그대로 호스트에 돌려준다. PSReadLine 설치·강제 로드·키 바인딩 교체는 하지 않는다. PowerShell 5.1과 pwsh에 같은 스크립트를 쓴다.
- 공백·주석만 있는 입력과 취소는 새 작업이 아니다. 멀티라인·붙여넣기는 편집기가 완성된 실행 단위를 반환한 시점에 한 번 시작한다. 명령 본문 OSC E는 이번 범위에 추가하지 않는다.
- 처음의 통합 프롬프트는 A로 작업 없음을 알린다. D는 C 이후에만 한 번 보내므로 빈 Enter·주석·입력 중 Ctrl+C·프롬프트 재출력은 이전 결과와 알림 이력을 바꾸지 않는다.
- 종료는 프롬프트 진입의 `$?`와 새 PowerShell history 항목의 실행 상태로 판정한다. 성공은 D;0, 실패는 D;1이며 이는 PowerShell 파이프라인의 성공 여부다. 과거 native `$LASTEXITCODE`를 현재 명령의 결과로 재사용하지 않으며 변수 자체는 보존한다. 실행 중단은 D에 코드를 붙이지 않아 성공·실패를 합성하지 않는다.
- PSReadLine이 없으면 C/D/A를 보내지 않고 OSC 7 CWD만 유지한다. 새 pane은 CMD처럼 lifecycle 미확인과 출력 활동 fallback을 사용한다. 출력 중에는 기존 표시·자동 절전 fallback이 적용되고 clear는 기존 미확인 셸 best-effort 예외를 따른다. 무출력 실행의 clear 보호를 보장하지 않는다.
- 통합 설치 이후 사용자가 reader나 prompt를 재정의/제거하면 lifecycle 지원을 보장하지 않는다. 새 프로세스에서 통합을 다시 설치한다. CMD·Bash·Codex·Claude 계약은 변경하지 않는다.

## Alternatives Considered

- Enter·PTY write 시 시작 합성: 취소·부분 입력·멀티라인·에이전트 입력을 실행으로 오인하므로 제외한다.
- PSReadLine AcceptLine 키 교체 또는 validation/history 콜백: 다른 수락 키와 사용자 훅을 누락하거나 덮어쓸 수 있다. 호스트에 반환되는 실행 단위를 관찰하는 쪽을 택한다.
- 출력이 생기면 이전 성공 삭제: 입력 에코와 장식 출력도 작업으로 바뀌고 조용한 명령은 여전히 놓친다.
- PSReadLine 없는 환경에서 D만 유지: 이전 종료의 현재성을 확인할 수 없는 원래 결함이 남는다. 이 환경에서는 확인되지 않은 진행·완료를 만들지 않는다.

## Consequences

연속 명령과 무출력 실행의 작업 표시·clear 보호·절전 억제가 동일한 시작 증거를 쓴다. 빈 입력과 취소가 새 완료 알림을 만들지 않는다. PSReadLine 미사용 환경은 이전의 부정확한 완료 표시를 잃고, 종료 코드는 성공/실패 의미의 0/1로 제공한다.

실제 Windows ConPTY에서 연속 실행·성공/실패·중단·공백/주석·멀티라인을 회귀 테스트하며, dev에서 task·정책·알림·xterm·스크린샷을 대조한다. PSReadLine이 없는 환경과 CMD·Bash의 한계도 구분해 기록한다. 설정 마이그레이션은 없고 기존 pane은 재시작해야 새 통합을 받는다. reader API 또는 host의 history/취소 의미가 달라지면 이 결정을 재검토한다.

참고: [Microsoft PSConsoleHostReadLine 문서](https://learn.microsoft.com/en-us/powershell/module/psreadline/psconsolehostreadline), [VS Code의 동일 호스트 경계 활용](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1). 이 ADR의 빈 입력·결과·fallback 정책은 laymux의 공통 task 계약에 따른다.
