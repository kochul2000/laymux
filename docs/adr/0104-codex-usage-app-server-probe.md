# 0104. Codex 사용량은 app-server rate-limit API로 수집한다

- Status: Accepted
- Date: 2026-07-31
- Source: 사용자 요구; issue #688; [ADR-0102](0102-claude-usage-probe-headless-pty.md); `docs/architecture/data-flow.md` §10.5

## Context

Codex CLI 사용량을 Claude UsageView와 같은 pane으로 보여줘야 한다. Claude는 사용량의 원천이 `/usage` TUI 화면뿐이어서 headless PTY를 사용한다. 반면 현재 Codex CLI app-server는 인증된 계정의 구조화된 `account/rateLimits/read` JSON-RPC 응답을 제공한다. 화면을 자동 조작·파싱하면 구조화된 경로가 있는 Codex에서 불필요하게 취약하고, 사용자 터미널의 세션 상태를 건드릴 위험도 생긴다.

범위는 Codex CLI의 ChatGPT rate-limit 정보 표시와 Claude/Codex 화면의 공통 프레젠테이션이다. 계정 로그인, rate-limit reset credit 사용, API 과금·토큰 사용량 조회, Codex app-server의 네트워크 노출은 범위가 아니다.

## Decision

**Codex UsageView는 로컬의 일회성 `codex app-server` stdio 프로세스에 초기화 후 `account/rateLimits/read`를 요청하고, Claude/Codex는 provider별 raw snapshot을 공통 Usage 프레젠테이션에 전달한다.**

- Codex probe는 `headless_command`로 app-server를 실행하고 stdio JSONL만 사용한다. Windows의 npm 설치에서는 stdio를 보존하기 위해 command shim 대신 Node의 Codex 엔트리포인트를 직접 실행한다. WebSocket listener를 열지 않으며 사용자 터미널·PTY 레지스트리·Codex 대화 스레드를 만들지 않는다.
- raw snapshot은 app-server가 반환한 `limitId`, `limitName`, `primary`/`secondary`의 `usedPercent`, `windowDurationMins`, `resetsAt`와 계정 plan만 저장한다. 표시용 reset 문구와 elapsed 퍼센트는 프론트엔드가 원시 시각·window duration에서 계산한다.
- Codex view는 마운트된 동안에만 `settings.usage.codex.refreshSeconds`(600~3600초) cadence로 읽고, unmount 뒤에는 프로세스를 유지하지 않는다. `usage.codex`는 terminal font profile과 `Weekly limit`/`Spark Weekly limit` 표시 행(하나 이상)을 함께 소유한다. `configDirs`의 추가 계정은 각 경로에서 사용자가 `codex login`을 마친 `CODEX_HOME`이며, 선택한 경로만 app-server 자식의 환경으로 전달한다. 읽기 API는 캐시·listener·worker를 기동하지 않는다.
- `UsagePresentation`은 bar, 색, 서체, responsive density, compact 배치, footer, control bar 동작을 단일 구현으로 소유한다. provider view는 제목·행·상태·refresh 함수만 주입한다. 사용량·경과·track 색은 provider별이 아니라 `usage.colors` 하나가 소유한다. 기본 팔레트는 청록 `#58d1eb`·주황 `#fd971f`·회색 `#585858`이며, 테마 토큰이 아닌 사용량 표시 설정이므로 테마 전환으로 바뀌지 않는다.

## Alternatives Considered

- **Codex TUI의 `/status` 화면 파싱:** 사용자에게 보이는 경로이지만 구조화된 app-server rate-limit API보다 TUI 변경에 취약하고, 별도 PTY 제어가 필요하다.
- **사용자 터미널에 `/status` 입력:** 현재 작업을 중단하거나 대화 내용을 바꾸므로 monitor의 읽기 전용 성질을 어긴다.
- **Codex 계정 토큰을 Laymux 설정에 복사:** 인증 비밀을 별도 보관·암호화할 새 책임이 생기고 CLI 로그인과 어긋난다. 계정별 `CODEX_HOME`의 기존 Codex 인증 저장소를 그대로 사용한다.
- **Claude와 Codex 화면을 별도 React 컴포넌트로 복제:** 즉시 만들기는 쉬워도 반응형·색·compact 규칙이 곧 드리프트한다.

## Consequences

- Codex CLI가 PATH에 없거나 ChatGPT 계정으로 인증되지 않았으면 view footer에 명확한 상태를 표시한다.
- app-server protocol이 바뀌면 JSON-RPC parser의 고립된 adapter와 fixture 테스트를 갱신한다. Claude의 PTY probe에는 영향을 주지 않는다.
- Codex의 반환 버킷 수는 계정·플랜에 따라 달라질 수 있으므로 공통 프레젠테이션은 고정된 세 행을 가정하지 않는다.
- 사용량 색을 테마 토큰에서 분리한 결과, 테마를 바꿔도 사용량 색은 유지된다. 이는 계정/모델을 가로질러 사용량의 의미를 일관되게 보이게 하는 선택이며, 테마와 함께 바꾸려면 사용자가 `usage.colors`를 직접 조정해야 한다.
