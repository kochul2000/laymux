# 0006. 내장 MCP 서버 (rmcp HTTP `/mcp`, 별도 바이너리 폐기)

- Status: Accepted
- Date: 2026-06-03
- Source: 구 ARCHITECTURE.md §12.7

## Context

초기에는 Claude Code(WSL)가 stdio 로 별도 `laymux-mcp` 바이너리에 연결하고, 그 바이너리가 다시 HTTP 로 axum Automation API 를 호출했다. 이 구조는 MCP 바이너리를 따로 빌드·배포해야 하고, 도구가 추가될 때마다 두 곳을 동기화해야 했다.

## Decision

**공식 `rmcp` SDK 로 MCP 서버를 Automation API 에 직접 내장**한다.

- axum 에 `nest_service("/mcp", StreamableHttpService)` 로 Streamable HTTP(JSON-RPC 2.0) 엔드포인트 제공. 별도 바이너리 빌드 불필요.
- Tool 은 `#[tool]` derive 매크로로 정의 — JSON Schema 자동 생성.
- 인증은 [ADR-0002](0002-automation-api-fixed-port-ip-allowlist.md)의 IP allowlist 미들웨어를 그대로 재사용.

## Consequences

- Claude Code 는 `http://<IP>:<PORT>/mcp` 만 등록하면 되고, laymux 재시작에도 재등록 불필요.
- Tool 추가: `mcp.rs` 에 파라미터 구조체(`#[derive(Deserialize, JsonSchema)]`) + `#[tool]` 메서드 추가 → bridge_request 또는 AppState 직접 접근으로 구현.
- 설정 자동 등록은 `scripts/setup-mcp.sh`(WSL/Linux) / `setup-mcp.ps1`(Windows).
- 현재 tool 목록·구현 패턴은 [architecture/api-contracts.md](../architecture/api-contracts.md) §12.7 이 SoT.
