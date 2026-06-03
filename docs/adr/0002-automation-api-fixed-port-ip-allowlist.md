# 0002. Automation API — 고정 포트 + IP allowlist 무인증

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §12.2 · §12.6, CLAUDE.md 규칙

## Context

AI/외부 도구(Claude Code CLI 등)가 IDE 를 프로그래밍 방식으로 제어하려면 안정적이고 발견 가능한 엔드포인트가 필요하다. 동적 포트는 도구가 매번 포트를 찾아야 하고, 토큰 기반 인증은 로컬 자동화 루프에 마찰을 더한다. 동시에 release 와 dev 인스턴스가 같은 `laymux.exe` 이름을 공유하므로 둘을 구분할 안전한 경계가 필요하다.

## Decision

**고정 포트 + 로컬 IP allowlist 만으로 보안**을 확보하고 인증 헤더를 두지 않는다.

- 포트 고정: release = `19280`, dev = `19281`. 각 빌드 타입은 하나의 인스턴스만 실행 가능(포트 충돌 시 시작 실패).
- `0.0.0.0` 바인딩(WSL2→Windows 호스트 접근 허용) + IP allowlist 미들웨어: loopback / RFC 1918 사설 대역 / link-local 만 허용. 외부 공인 IP 는 403.
- 인증 헤더 불필요(Chrome DevTools·Jupyter 와 동일 모델). 내장 MCP `/mcp` 도 같은 미들웨어를 재사용([ADR-0006](0006-embedded-mcp-server.md)).

## Consequences

- 개발 중 스크린샷/API 호출은 **dev(19281)만** 사용한다. release(19280)는 사용자 소유이므로 건드리지 않는다.
- dev 종료는 PID 수동 kill 금지 — `scripts/kill-dev.sh` 가 `automation.json` PID 로 dev 만 안전하게 종료한다.
- 신규 기능은 Automation API/MCP 확장과 자율 검증 루프(API→스크린샷→평가→수정) 구성 가능성을 함께 고려한다.
- 엔드포인트/포트 파일 경로의 현재 계약은 [architecture/api-contracts.md](../architecture/api-contracts.md) §12 가 SoT.
