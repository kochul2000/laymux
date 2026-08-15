# 0156. Grok Build는 Claude·Codex와 같은 1급 에이전트다

- Status: Proposed
- Date: 2026-08-13
- Source: 사용자 요구(Claude/Codex activity·연동 설정·usage 패리티를 Grok Build에 적용). [ADR-0009](0009-process-tree-interactive-app-liveness.md), [ADR-0102](0102-claude-usage-probe-headless-pty.md), [ADR-0104](0104-codex-usage-app-server-probe.md), [ADR-0118](0118-codex-session-pid-attribution.md), [ADR-0120](0120-wsl-agent-session-attribution.md), [ADR-0134](0134-wsl-guest-interactive-app-liveness.md), [ADR-0125](0125-configurable-agent-launch-command.md), [ADR-0147](0147-output-volume-activity-and-app-declared-idle.md)
- Extends: 0009, 0102, 0103, 0104, 0105, 0118, 0120, 0125, 0134, 0147

## Context

laymux는 Claude Code와 Codex CLI를 1급 에이전트로 다룬다. 세 표면이 함께 움직인다.

- **activity** — 프로세스 트리 liveness + 타이틀 상태머신 + `known_*_terminals`. 표시 이름은 `interactiveApp.name` (`"Claude"` / `"Codex"`).
- **연동 설정** — `claude` / `codex` 섹션이 실행 명령, 세션 복원, selector 상태 메시지를 소유한다. Claude만 `syncCwd`와 세션 리미트 자동 복귀를 추가로 가진다.
- **usage** — `usage.<agent>`가 수집 경로와 표시 행·색을 소유하고, 화면은 공통 `UsagePresentation`이 그린다. Claude는 headless PTY로 `/usage` TUI를 긁고, Codex는 로컬 `app-server` JSON-RPC를 쓴다.

Grok Build(`grok` CLI, 홈 `$GROK_HOME` 또는 `~/.grok`)는 같은 세 표면이 없다. 관측된 현재 동작:

- OSC 0/2 타이틀은 환영 화면에서 `grok`, 세션 중에는 `<status> - <title>… - grok`, 작업 중에는 `<braille> - Running: <tool> - <title>… - grok`다. `"Grok Build"` 리터럴은 타이틀에 없고 배너/버퍼에만 있다.
- 프로세스 이름은 Windows `grok.exe`, POSIX `grok`다. 기존 `name_to_app`은 이를 무시하므로 pane은 `shell`로 남는다.
- 세션은 UUID이며 `grok --resume <id>`로 복원한다. 라이브 매핑은 `$GROK_HOME/active_sessions.json`의 `{session_id, pid, cwd, opened_at}`이고, 본문은 `$GROK_HOME/sessions/<encoded-cwd>/<id>/summary.json`이다.
- 계정 사용량은 TUI `/usage`(alias `/cost`)가 보여 준다. 화면에 `Weekly limit` / `Monthly limit` / `Credits` / pay-as-you-go 버킷이 있다. `grok usage` 같은 구조화 CLI나 Codex식 app-server rate-limit API는 없다.

범위: Grok을 세 번째 1급 에이전트로 들이는 소유권·계약·불변식. 비목표: Grok ACP 임베드, pane 신규 시작 시 자동 기동, xAI API 키를 laymux 설정에 복사, Claude식 `syncCwd`/`! cd`, Claude식 세션 리미트 배너 자동 복귀, 사용량 기반 자동 개입.

## Decision

**Grok Build는 Claude·Codex와 같은 1급 에이전트다. activity 이름 `"Grok"`, 연동 설정 `grok`, 사용량 `usage.grok`를 추가하고, 세 provider는 한 pane에서 상호배타적이다.**

### Activity

- `interactiveApp.name`은 `"Grok"`이다. 프로세스 트리 `name_to_app`은 `grok` / `grok.exe`(대소문자 무시)를 Grok으로 사상한다. 실행 파일 이름만으로 `Running("Grok")`이 성립하며, 이 양성은 Claude/Codex와 같이 타이틀·배너보다 권위다([ADR-0009](0009-process-tree-interactive-app-liveness.md)). 짧은 이름 충돌은 잔여 위험이지 이름-단독 권위를 약화하는 예외가 아니다.
- WSL guest probe는 `grok`를 Claude/Codex와 같은 comm 집합에 넣는다. 유일 최상위·같은 깊이 경합 포기·귀속 실패 시 그 distro의 부정 포기 규칙은 [ADR-0134](0134-wsl-guest-interactive-app-liveness.md) 그대로다. 호스트 스냅샷은 WSL pane에 대해 Grok도 `NoneAlive`를 내지 않는다.
- 타이틀 진입은 대소문자 무시 접미사 ` - grok` 또는 버퍼의 `"Grok Build"`다. 환영 화면의 단독 `grok`는 Codex의 bare cwd basename과 같다 — 프로세스 트리가 Unknown일 때 단독으로는 진입하지 않고, 이미 검출된 세션의 종료 신호로도 쓰지 않는다. 종료는 접미사/`Grok Build`/작업 스피너가 모두 없고 프로세스 트리도 Grok이 아닐 때만 확정한다.
- 작업 판정은 확인된 Grok 타이틀이 Braille(U+2800..U+28FF) 접두사 또는 `- Running:`을 가질 때다. 스피너 목록은 편의이며 출력 볼륨이 받친다([ADR-0147](0147-output-volume-activity-and-app-declared-idle.md)).
- Grok은 선언 유휴 신호가 없다. Claude의 `✳`에 해당하는 타이틀 토큰을 인정하지 않는다. `- Running:` 부재를 선언 유휴로 쓰지 않는다. 유휴 TUI 리페인트는 Codex와 같이 볼륨 임계를 넘으면 ⏳로 남는다.
- `known_grok_terminals`를 Claude/Codex 캐시와 같은 규칙으로 둔다. 한 terminal이 새 provider로 진입하면 다른 두 캐시 항목을 즉시 제거한다. 중첩 실행은 기존처럼 **전체 provider 중 유일한 최상위 하나**만 활성으로 인정한다.

### 연동 설정과 세션 복원

- `grok` 설정은 Codex와 같은 필드만 가진다: `command`(기본 `"grok"`), `restoreSession`, `sessionMaxAgeHours`, `statusMessageMode`, `statusMessageDelimiter`. `syncCwd`와 `sessionLimit*`는 복제하지 않는다 — Grok은 부모 TUI CWD 변경 계약과 Claude 세션 리미트 배너 파서를 제공하지 않는다.
- `grok.command`는 [ADR-0125](0125-configurable-agent-launch-command.md)와 같은 문법·정규화를 쓰고, 복원 override는 디스크 설정에서 재도출한 `<command> --resume <id>`만 통과한다. Claude는 `--resume`, Codex는 서브커맨드 `resume`, Grok은 플래그 `--resume`이다. `<id>`는 하이픈 포함 표준 UUID `8-4-4-4-12` 십육진만 허용한다(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`). 이는 [ADR-0118](0118-codex-session-pid-attribution.md) 세션 ID 문자셋의 부분집합이며, 하이픈 없는 32자·URN·괄호 감싼 값은 거부한다.
- 세션 ID SoT는 **PTY descendant의 Grok PID와 `$GROK_HOME/active_sessions.json`의 `pid`가 직접 일치하는 `session_id`**다. 그 ID의 `sessions/.../summary.json` 파일이 존재하고, 그 파일의 수정 시각(mtime)이 age 게이트를 통과할 때만 저장한다. `opened_at`/`updated_at` JSON 필드는 쓰지 않는다. 파일이 없거나 mtime을 읽지 못하면 저장하지 않는다. CWD 최신 세션 fallback은 두지 않는다. 같은 ID가 둘 이상의 terminal에 붙으면 충돌한 쪽을 모두 `null`로 만든다.
- native `GROK_HOME`의 SoT는 **호스트 laymux 프로세스 환경 변수**다([ADR-0118](0118-codex-session-pid-attribution.md)의 `CODEX_HOME`과 같다). 없으면 호스트 사용자 홈 `.grok`다. PTY 자식 환경이나 셸 프로필에만 있는 값은 탐색하지 않는다. WSL pane은 [ADR-0120](0120-wsl-agent-session-attribution.md)과 같이 guest `LX_TERMINAL_ID` + Linux `grok` PID + guest 프로세스의 `GROK_HOME`(없으면 guest `HOME/.grok`)의 `active_sessions.json`을 읽는다.
- `lastGrokSession`은 `lastClaudeSession`/`lastCodexSession`과 상호배타적으로 영속한다. 세 키 중 **둘 이상**이 동시에 있으면 복원 경로는 provider를 추측하지 않고 새 세션으로 시작한다. 저장 경로는 하나를 기록할 때 나머지 두 키를 실제로 삭제한다. `restoreSession`이 꺼져도 정확한 ID는 수집한다.
- selector 상태 메시지의 원시 텍스트는 타이틀에서 스피너 접두사와 `- Running:` 접두사, ` - grok` 접미사를 벗긴 나머지다. 작업 타이틀의 `<tool> - <session title>`을 더 쪼개지 않는다. 표시는 기존 `statusMessageMode` 계산 함수가 맡는다.

### Usage

- Grok 사용량 수집은 Claude와 같이 **레지스트리 밖 headless PTY probe**가 소유한다. probe는 `grok`를 띄워 `/usage`를 보내고 자체 화면 모델에서만 파싱한다. Codex app-server를 흉내 내지 않고, 사용자 터미널에 `/usage`를 주입하지 않으며, `auth.json`이나 xAI API 키를 laymux 설정으로 복사하지 않는다.
- 원시 스냅샷 행 키는 닫힌 집합 `weekly` · `monthly` · `credits` · `payg`다. `credits`는 구독 크레딧, `payg`는 pay-as-you-go 한도이며 한 키로 합치지 않는다. 화면에 없는 키는 스냅샷에 넣지 않는다. `visibleRows`에 있는데 스냅샷에 없으면 그 행은 그리지 않는다(빈 0% 행으로 채우지 않는다). 잘못된·빈 `visibleRows`는 `["weekly","monthly"]`로 정규화한다.
- `usage.grok`는 `{profile, refreshSeconds, configDirs, visibleRows, colors}`를 가진다. `profile`은 Claude와 같이 **probe를 spawn할 터미널 프로필**이다. 빈 값이면 `defaultProfile`, 존재하지 않으면 구독이 오류로 실패한다. `configDirs`의 각 경로는 추가 `GROK_HOME`이며 기본 홈은 항상 포함한다. `refreshSeconds`의 600초 하한은 공개된 xAI `/usage` rate limit이 아니라, `grok` 프로세스 기동 비용과 다른 에이전트 표시 cadence를 맞추기 위한 적용 clamp다(3600 상한 포함). 스키마는 값을 거부하지 않고 조용히 올린다.
- 기본 used 색은 GrokNight 마젠타 액센트에서 가져온 `#c084fc`다. Claude `#d97757`·Codex `#10a37f`와 같이 selector 표기색(`--grok`)과 같은 값이며 테마 토큰에 묶지 않는다.
- pane view 타입은 `GrokUsageView`다. 기존 Claude `UsageView`와 Codex `CodexUsageView`를 재해석하거나 합치지 않는다.
- 위젯 타입 `grokUsage`를 추가한다. 옵션은 `display` · `barWidth` · `barHeight` · `elapsedHeight`에 더해 Claude와 같은 `configDir`(기본 홈은 빈 문자열)을 가진다. 행 선택과 색은 전역 `usage.grok`가 소유한다.
- 워커는 해당 `GROK_HOME`을 보는 `GrokUsageView`/위젯 구독이 있을 때만 산다. Automation/MCP 읽기는 probe를 기동시키지 않는다. 기존 Claude 전용 `GET /api/v1/usage`와 MCP `get_claude_usage`의 의미·경로는 바꾸지 않는다. Grok은 형제 계약으로만 노출한다: REST `GET /api/v1/usage/grok`, MCP `get_grok_usage`, Tauri `get_grok_usage_snapshot`.

## Alternatives Considered

- **일반 `interactiveApp` 패턴만 추가하고 연동·usage는 미룬다.** 타이틀만으로는 환영 화면 `grok`와 셸을 구분하지 못하고, 복원·usage가 빠진 채 selector만 켜지면 사용자에게 1급 에이전트처럼 보인다. 세 표면을 한 결정으로 연다.
- **Claude 설정을 통째로 복제한다(`syncCwd`, `sessionLimit*`)** . Grok은 `! cd` 부모 세션 변경 계약이 없고, 한도 배너 문구·리셋 시각 형식도 Claude 파서와 다르다. 없는 계약을 설정으로 노출하면 죽은 토글이 된다.
- **세션을 CWD 최신 `summary.json`으로 추정한다.** 같은 디렉터리의 여러 Grok pane이 한 대화를 중복 resume한다. Grok이 PID를 `active_sessions.json`에 이미 쓰므로 추정할 이유가 없다.
- **Grok usage를 xAI HTTP API나 `auth.json` 토큰으로 조회한다.** 비밀을 새 저장소로 옮기고 CLI 로그인과 어긋난다. Codex가 `CODEX_HOME` 인증을 재사용한 것과 같은 이유로 기각한다.
- **사용자 pane에 `/usage`를 보낸다.** 작업 화면과 대화 맥락을 오염시킨다.
- **usage를 세션 `signals.json` 토큰 합으로 추정한다.** 계정 weekly/monthly 한도와 다른 값이다. 표시 원천은 `/usage` 화면이다.

## Consequences

- 설정 스키마, widget type `grokUsage`, view type `GrokUsageView`, restore override 세 번째 형태, `interactiveApp.name`, REST `GET /api/v1/usage/grok`, MCP `get_grok_usage`가 외부 계약으로 늘어난다. 기존 Claude-only usage 엔드포인트의 의미는 바꾸지 않는다.
- 프로세스 이름 `grok`는 짧다. 무관한 `grok.exe`가 PATH에 있으면 0009와 같이 그 pane을 Grok으로 본다. 이 잔여 위험은 Claude/Codex 이름 충돌과 같은 종류이며, 이름-단독 권위를 Grok만 약화하지 않는다.
- `/usage` TUI와 `active_sessions.json`은 공개 안정 계약이 아니다. 파싱 실패는 조용한 오답이 아니라 명시 상태로 드러나야 하고, 상류가 구조화 CLI나 PID/session API를 주면 수집·귀속 어댑터만 새 ADR로 교체한다.
- probe는 수요가 있는 동안 `grok` 프로세스를 `GROK_HOME`마다 하나 더 띄운다. Claude probe와 같은 비용이며, 앱 시작만으로 띄우지 않는다.
- 세 provider 상호배타와 3-way known-cache handover는 activity·영속 테스트의 고정 축이 된다. 두 provider만 가정한 테스트는 Grok 핸드오버를 빠뜨리면 회귀한다.
- 후속: `docs/architecture/{overview,data-flow,api-contracts}.md`에 Grok 축을 같은 PR에서 반영한다. 타이틀·`/usage` 화면·`active_sessions.json`은 fixture로 고정하고, 실기 조회는 ignore 테스트로 둔다.
