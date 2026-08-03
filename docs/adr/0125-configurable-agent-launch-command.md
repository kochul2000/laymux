# 0125. 에이전트 실행 명령은 설정이 소유하고, 복원 override 는 그 설정에서 재도출한다

- Status: Accepted
- Date: 2026-08-03
- Source: 사용자 요구(설정 UI 에 Claude/Codex 세션 복원 명령 노출, `--dangerously-skip-permissions`·`--yolo` 같은 플래그 지정), [ADR-0117](0117-codex-session-restore.md), [ADR-0118](0118-codex-session-pid-attribution.md), [api-contracts.md §5·§13](../architecture/api-contracts.md)

## Context

세션 복원은 프론트가 `claude --resume <id>` / `codex resume <id>` 문자열을 만들어 `create_terminal_session` 의 `startupCommandOverride` 로 넘기고, Rust 가 그 두 형태만 정확히 매칭해 통과시킨다([ADR-0117](0117-codex-session-restore.md)). 실행 명령이 코드에 하드코딩돼 있어 사용자는 자신이 늘 쓰는 플래그(`--dangerously-skip-permissions`, `--yolo`)로 복원할 수 없고, PATH 가 아닌 경로에 설치한 바이너리도 지정할 수 없다.

문자열은 새로 뜬 셸에 그대로 타이핑된다. 따라서 "사용자가 플래그를 넣을 수 있게 한다"는 요구는 곧 "셸 한 줄의 내용을 설정이 정한다"는 뜻이고, 다음 두 가지를 동시에 만족해야 한다.

- Rust 의 override 검증은 프론트가 보낸 문자열을 신뢰하지 않는다는 전제 위에 서 있다. 검증을 "무엇이든 통과"로 완화하면 `startupCommandOverride` 가 임의 명령 실행 채널이 된다.
- 설정값 자체가 `;`·`&&`·`$( )` 같은 셸 메타문자를 실어 나르면, 설정을 쓴 주체와 무관하게 복원 시점에 두 번째 명령이 실행된다.

비목표: pane 을 새로 시작할 때 이 명령으로 에이전트를 자동 기동하는 것, 프로필 `startupCommand` 에 프리셋을 채워주는 UI. 이번 결정은 **세션 복원 경로에만** 적용한다.

## Decision

**에이전트 실행 명령은 `claude.command` / `codex.command` 설정이 소유하고(기본 `"claude"` / `"codex"`), Rust 는 복원 override 를 그 설정에서 재도출한 문자열과만 대조한다.**

- 값의 문법: 실행 파일 이름/경로 한 개 + 플래그. 허용 문자는 영숫자와 ` - _ . / \ : = ,` 뿐이고, 첫 글자는 `-` 일 수 없다. 셸 메타문자(`; & | $ \` " ' < > ( )`)와 줄바꿈·탭은 문법 밖이므로 값 자체가 두 번째 명령을 만들 수 없다. 공백은 앞뒤를 잘라내고 연속 공백만 하나로 접는다 — 줄바꿈은 접지 않고 거부한다(두 줄을 한 줄로 용접하지 않기 위해).
- 정규화는 `settings/agent_command.rs` 와 `ui/src/lib/agent-command.ts` 가 같은 규칙으로 수행하고, 문법을 어긴 값은 조용히 기본 명령으로 대체된다. 이 함수는 **항상 문법을 만족하는 문자열만** 반환한다.
- Rust 의 `startupCommandOverride` 검증은 `<정규화된 claude.command> --resume <safe-id>` 와 `<정규화된 codex.command> resume <safe-id>` 두 형태만 통과시킨다. 접두어는 **디스크의 settings 에서 읽고**, 호출자가 보낸 문자열에서 추출하지 않는다. 따라서 호출자는 사용자가 설정하지 않은 플래그를 끼워 넣을 수 없다. 세션 ID 문법은 기존 그대로다([ADR-0118](0118-codex-session-pid-attribution.md)).
- 문법을 어긴 설정값은 `validate_settings` 가 `/claude/command`·`/codex/command` 이슈로 보고하고, 설정 UI 는 미리보기 대신 경고를 띄운다. 앱은 실패하지 않고 기본 명령으로 계속 동작한다.
- 적용 시점은 `nextUse` — 다음 터미널 생성부터다. 실행 중인 pane 의 명령을 바꾸지 않는다.

## Alternatives Considered

- **override 검증 완화(임의 문자열 허용).** 프론트만 신뢰하면 되므로 가장 간단하지만, `create_terminal_session` 이 임의 명령 실행 채널이 된다. Rust 가 프론트 문자열을 신뢰하지 않는다는 ADR-0117 의 전제를 정면으로 깬다.
- **플래그를 별도 배열 필드(`claude.flags: string[]`)로 분리.** 토큰 경계가 명확해 인용 문제가 없다. 그러나 사용자가 한 줄로 인지하는 값을 두 필드로 쪼개면 UI·문서·설정 파일 모두에서 조합 규칙을 다시 설명해야 하고, 실행 파일 경로 지정까지 포함하면 결국 같은 문자열 검증이 필요하다. 한 줄 + 엄격한 문법을 택했다.
- **셸 인용/이스케이프 지원(공백 있는 경로를 따옴표로 감싸기).** 따옴표를 허용하는 순간 문법이 셸 파서 수준으로 커지고, 플랫폼별(PowerShell vs POSIX) 인용 규칙 차이를 override 검증이 재현해야 한다. 공백 있는 경로는 이번 범위에서 지원하지 않는다.
- **프론트가 만든 접두어를 그대로 신뢰.** 구현이 가장 짧지만, 설정을 우회한 플래그 주입을 막을 수 없다.

## Consequences

- 사용자는 설정 한 곳에서 복원 명령을 정한다. `claude --dangerously-skip-permissions` 로 두면 복원이 `claude --dangerously-skip-permissions --resume <id>` 로 뜬다. **이 설정은 권한 승인 절차를 건너뛰는 플래그를 상시화할 수 있으므로, 값의 위험은 사용자가 소유한다** — laymux 는 문법만 강제하고 플래그의 의미는 판단하지 않는다.
- 프론트·백엔드가 같은 정규화 규칙을 중복 구현한다. 두 구현이 갈라지면 복원 override 가 통째로 거부되어 복원만 조용히 안 되는 형태로 나타난다. 양쪽에 같은 케이스 표를 가진 테스트를 두어 갈라짐을 잡는다.
- 공백이 들어간 설치 경로(`C:\Program Files\...\claude.exe`)는 지원하지 않는다. 필요해지면 인용 문법이 아니라 별도 필드나 심링크/래퍼를 권하는 쪽으로 재검토한다.
- 잘못된 값은 앱을 멈추지 않고 기본 명령으로 대체된다. 사용자가 오타를 눈치채지 못할 수 있으므로 설정 UI 경고와 `validate_settings` 이슈가 유일한 신호다.
- pane 신규 시작 시 에이전트 자동 기동, 프로필 시작 명령 프리셋은 이 결정 밖이다. 그쪽으로 확장할 때는 "이 명령이 복원 전용"이라는 전제가 깨지므로 새 결정이 필요하다.
