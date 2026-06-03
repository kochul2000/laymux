# Claude Code 자동화 런북

dev 터미널에서 `claude` 명령으로 Claude Code 를 **프로그래밍 방식으로 구동·검증**할 때의 절차다. (일반 개발에는 필요 없고, Automation API/MCP 로 Claude Code 세션을 자동 제어하는 경우에만 쓴다.)

진입점 요약은 [`AGENTS.md`](../AGENTS.md) 에 한 줄로만 있고, 상세 절차는 여기에 둔다.

## 절차

1. `claude\r\n` 전송 후 **10초 대기**(초기화). 제출은 반드시 `\r`(CR) — `\n` 은 줄바꿈만 발생시킨다.
2. 출력(`GET /api/v1/terminals/:id/output`)에서 **"trust" 확인** — "Yes, I trust this folder" 프롬프트가 뜨면 `y\r\n` 으로 통과. 해당 프로젝트 디렉터리 첫 접근 시 PowerShell/WSL 모두 나타날 수 있다.
3. **"Claude Code" 타이틀 폴링**(3초 간격, 최대 60초). `GET /api/v1/terminals` 의 `title` 에 "Claude Code" 가 포함되거나 activity 가 `{"type":"interactiveApp","name":"Claude"}` 면 준비 완료.
4. 종료: Ctrl+C(`0x03` ETX)를 0.3초 간격으로 2회 전송. 5초 대기 후 activity 가 `shell` 로 바뀌었는지 확인.

## 관련

- 활동 상태 감지(셸/interactiveApp/outputActive)와 Claude 타이틀 접두사 규칙: [`architecture/data-flow.md`](./architecture/data-flow.md) §9.
- Claude Code CWD 동기화(`claude.syncCwd`) 동작: [`architecture/api-contracts.md`](./architecture/api-contracts.md) §10.
