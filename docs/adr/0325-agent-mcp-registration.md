# 0325. 에이전트 MCP 등록은 Settings에서 실행 환경별로 확인·설치한다

- Status: Proposed
- Date: 2026-10-14
- Source: 사용자 요구(훅처럼 Claude·Codex·Grok MCP 등록 상태 확인과 한 번에 설치), [ADR-0006](0006-embedded-mcp-server.md), [ADR-0282](0282-optional-agent-hook-installation.md), [ADR-0156](0156-grok-first-class-agent.md)
- 관계: ADR-0006의 `scripts/setup-mcp.*` 수동 등록을 앱 내 선택 동작으로 확장한다. ADR-0282의 환경별 선택 설치·동일 helper 원칙을 MCP 등록에 적용한다.

## Context

내장 MCP 서버를 쓰려면 사용자가 저장소 스크립트를 실행하거나 에이전트 설정 파일을 직접 고쳐야 한다. 스크립트는 Claude만 다루고 저장소 checkout이 필요하며, 배포 앱 사용자는 등록 여부를 확인할 방법이 없다. Codex와 Grok은 각자 `config.toml`의 `[mcp_servers.<name>]`을 읽고, Claude는 사용자 홈의 `.claude.json` `mcpServers`를 읽는다. Windows와 각 WSL 배포판은 홈과 설정이 다르며 WSL에서 Windows 호스트에 닿는 주소는 네트워킹 모드에 따라 다르다.

`.claude.json`은 Claude Code가 자주 다시 쓰는 큰 파일이고 Codex `config.toml`에는 사용자가 추가한 서버별 도구 승인 같은 하위 항목이 붙는다. dev와 release는 포트와 노출 도구 계층이 달라 서로 다른 이름으로 등록돼야 한다.

## Decision

**Claude·Codex·Grok 설정 화면에서 실행 환경을 골라 Laymux MCP 등록을 확인·설치·제거하고, 파일 작업은 훅과 같은 helper가 수행한다.**

- 등록 이름과 포트는 실행 중인 빌드가 정한다. release는 `laymux`·19280, dev는 `laymux-dev`·19281이다. 주소는 `http://<host>:<port>/mcp`이며 인증 헤더를 쓰지 않는다(ADR-0002 IP allowlist).
- 대상 파일: Claude는 `$CLAUDE_CONFIG_DIR/.claude.json`(없으면 `~/.claude.json`)의 `mcpServers.<name>`에 `{"type":"http","url":...}`, Codex는 `$CODEX_HOME/config.toml`(없으면 `~/.codex`), Grok은 `$GROK_HOME/config.toml`(없으면 `~/.grok`)의 `[mcp_servers.<name>].url`이다. 사용자 범위만 다루며 프로젝트 범위 파일은 바꾸지 않는다. WSL `--exec`와 Laymux 프로세스는 셸 프로필의 환경 변수를 보지 못하므로 사용자가 같은 의미의 설정 폴더를 절대 경로로 지정할 수 있다.
- 이름이 소유권이다. 설치는 해당 이름 항목의 주소만 갱신하고 같은 항목의 다른 필드(도구 승인·timeout·enabled)와 나머지 파일 내용·키 순서·TOML 서식을 보존한다. 같은 이름 항목에 stdio 전용 필드(`command`·`args`·`env`·`env_vars`·`cwd`)가 있으면 지우고 URL 형태로 바꾼다. Codex는 HTTP 항목에 이 필드가 남으면 설정 전체를 거부한다. Claude는 `type`이 없으면 stdio로 보므로 `type`이 `http`가 아니면 등록으로 보지 않는다. 제거는 해당 이름 항목 하나(하위 테이블 포함)만 지운다.
- 상태는 설정 파일이 정본이다. 미등록·등록됨(주소 일치)·다른 주소로 등록됨·주소 확인 불가(항목은 있으나 Laymux 미도달)를 구분하고, Codex `enabled = false`와 Grok `disabled_mcp_servers` 비활성은 경고로만 보여주고 바꾸지 않는다.
- WSL은 지정 배포판의 기본 사용자로 Linux helper가 처리한다. helper가 `127.0.0.1`, 기본 게이트웨이, `resolv.conf` nameserver 순으로 `/api/v1/health`를 확인해 처음 응답한 호스트를 주소로 쓴다. 응답이 없으면 설치를 거부하고 기존 항목은 "주소 확인 불가"로 둔다. 네트워킹 모드나 게이트웨이가 바뀌면 상태가 "다른 주소"로 바뀌어 재설치를 안내한다. WSL 기동과 호스트 확인을 고려해 helper 대기 시간은 훅보다 길게 둔다.
- 쓰기는 결과 문서를 다시 파싱해 의도한 상태가 됐는지 확인한 뒤에만 진행한다. 바꾸기 전 내용을 `<파일>.laymux-backup` 하나에 덮어쓰고, 교체 직전 원본과 같을 때만 원자 교체한다. `config.toml` 폴더는 훅 설치기(Codex 제목 연결)와 같은 `.laymux-hooks.lock`으로 직렬화한다. `.claude.json`은 Claude Code가 락 없이 다시 쓰므로 교체 직전 비교가 유일한 보호다. 손상·예상하지 못한 구조(객체·테이블이 아닌 항목 포함)·동시 외부 변경은 원본을 보존한 채 실패한다. 설치·제거는 명시적 즉시 동작이며 앱 실행·Settings 저장은 등록을 바꾸지 않는다. 실행 중인 CLI는 재시작해야 반영된다.

## Alternatives Considered

- 각 CLI의 `mcp add` 명령 실행: 환경마다 CLI가 PATH에 있어야 하고 WSL 비로그인 셸 PATH·버전별 옵션 차이를 관리해야 한다. 상태 확인과 주소 비교도 CLI별 출력 파싱이 필요하다.
- stdio 프록시 명령 등록: WSL 주소 변화에 강하지만 세션마다 추가 프로세스와 helper 수명 관리가 필요하다. 현재 CLI 모두 HTTP를 직접 지원한다.
- 이름과 무관하게 URL로 소유 판정: 사용자가 같은 서버를 다른 이름으로 등록한 경우를 건드릴 위험이 있고 이름 중복 등록을 만든다.
- 파일 전체 재직렬화: `.claude.json` 키 순서와 TOML 주석·서식을 잃는다.

## Consequences

사용자는 저장소 없이 앱에서 세 CLI의 등록을 확인하고 한 번에 설치·제거한다. Grok은 Claude 호환으로 `.claude.json`의 서버도 읽으므로 두 곳에 같은 이름이 있으면 Grok `config.toml`이 우선한다. WSL 게이트웨이 변경 시 재설치가 필요하다. helper에 JSON 순서 보존·TOML 편집·호스트 확인이 추가되며 세 파일 형식·주소 갱신·하위 필드 보존·제거·손상 파일·WSL 호스트 선택을 검증한다. 호환되는 기능 추가이므로 버전 영향은 minor다.
