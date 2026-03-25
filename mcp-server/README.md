# laymux-mcp

Claude Code에서 laymux 터미널 pane을 제어할 수 있는 MCP (Model Context Protocol) 서버.

## 전제 조건

- **laymux**가 Windows에서 실행 중이어야 한다. 이 MCP 서버는 laymux의 Automation API(`http://<host>:19280`)에 HTTP로 연결하는 프록시이므로, laymux가 꺼져 있으면 모든 도구 호출이 실패한다.
- **Rust 툴체인** (`cargo`) — 빌드에 필요
- **Claude Code CLI** (`claude`) — 서버 등록에 필요

## Tools

| Tool | 설명 |
|------|------|
| `list_terminals` | 모든 터미널 pane 목록 (ID, 프로필, CWD, sync group) |
| `write_to_terminal` | 터미널에 명령 전송 (`\n` 포함하면 실행) |
| `read_terminal_output` | 터미널 최근 출력 읽기 (기본 100줄) |

## 빠른 시작

### 전역 설치 (권장)

모든 프로젝트에서 사용 가능하게 등록한다:

```bash
cd mcp-server
./setup.sh
```

### 특정 프로젝트에만 설치

```bash
cd mcp-server
./setup.sh --project /path/to/your/project
```

설치 후 **Claude Code를 재시작**하고 `/mcp` 명령으로 laymux가 목록에 보이는지 확인한다.

## 스크립트가 하는 일

1. `cargo build --release`로 바이너리 빌드
2. MCP 서버 등록
   - 전역: `claude mcp add --scope user` → `~/.claude.json`에 등록
   - 프로젝트: 프로젝트 루트에 `.mcp.json` 생성
3. `~/.claude/settings.json`에 `mcp__laymux__*` 도구 권한 추가

## 수동 설치

### 1. 빌드

```bash
cd mcp-server
cargo build --release
```

### 2. MCP 서버 등록

**전역 등록** (모든 프로젝트에서 사용):

```bash
claude mcp add --transport stdio laymux --scope user /absolute/path/to/laymux-mcp
```

**프로젝트 등록** (특정 프로젝트에서만 사용):

Claude Code로 작업할 프로젝트 루트(laymux 디렉토리가 아니라, Claude Code를 실행하는 작업 디렉토리)에 `.mcp.json` 파일을 생성한다:

```json
{
  "mcpServers": {
    "laymux": {
      "command": "/absolute/path/to/laymux-mcp",
      "args": []
    }
  }
}
```

### 3. 도구 권한 허용 (선택)

매번 승인 프롬프트 없이 사용하려면 `~/.claude/settings.json`의 `permissions.allow`에 추가:

```json
"mcp__laymux__*"
```

### 4. Claude Code 재시작

재시작 후 `/mcp` 명령으로 laymux 서버가 목록에 보이는지 확인한다.

## MCP 서버 관리

```bash
claude mcp list              # 등록된 서버 목록
claude mcp remove laymux     # 서버 제거
```

scope 우선순위: `local > project > user`. 동일 이름이 여러 scope에 있으면 좁은 scope가 우선한다.

## 연결 설정

laymux-mcp는 시작 시 환경변수에서 Automation API 주소를 결정한다:

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `IDE_AUTOMATION_HOST` | `127.0.0.1` | Automation API 호스트 |
| `IDE_AUTOMATION_PORT` | `19280` | Automation API 포트 |

**laymux 터미널 안에서 Claude Code를 실행하면** 이 환경변수가 자동 주입되므로 별도 설정이 필요 없다.

**laymux 밖에서 실행하는 경우** (예: 별도 WSL 터미널) `.mcp.json`에서 환경변수를 지정한다:

```json
{
  "mcpServers": {
    "laymux": {
      "command": "/absolute/path/to/laymux-mcp",
      "args": [],
      "env": {
        "IDE_AUTOMATION_HOST": "172.x.x.x",
        "IDE_AUTOMATION_PORT": "19280"
      }
    }
  }
}
```

WSL에서 Windows 호스트 IP는 `cat /etc/resolv.conf | grep nameserver | awk '{print $2}'`로 확인할 수 있다.

## 동작 원리

```
Claude Code
  ↕ stdio (JSON-RPC 2.0)
laymux-mcp
  ↕ HTTP
laymux Automation API (Windows, :19280)
```

## 주의사항

- 프로젝트 단위 `.mcp.json`을 사용할 때, 최상위 키는 반드시 `"mcpServers"`여야 한다. 서버 이름을 바로 최상위에 넣으면 무시된다.
- `/mcp` 명령으로 서버가 보이지 않으면 등록 경로나 JSON 형식이 잘못된 것이다.
