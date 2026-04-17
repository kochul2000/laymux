<p align="center">
  <img src="Logo.svg" alt="Laymux" width="120" height="120" />
</p>

<h1 align="center">Laymux</h1>

<p align="center">
  <strong>Windows + WSL, Claude Code, Codex CLI, CJK/IME</strong> 사용자를 위한<br/>
  키보드 중심 멀티 페인 터미널 IDE.
</p>

<p align="center"><a href="./README.md">English</a></p>

![Laymux overview](docs/screenshots/overview.png)

## 만든 이유

Windows에서 개발하는 많은 사람은 이미 WSL 셸과 Claude Code·Codex CLI 같은 AI 에이전트, 그리고 한글·일본어·중국어 IME를 동시에 쓰고 있지만, 대부분의 터미널 UI는 이런 환경을 부가 기능 정도로 다룹니다. Laymux는 처음부터 이 네 축을 중심에 놓고 설계되었습니다.

- **여러 WSL·PowerShell 터미널**을 비율 기반 그리드에 나란히 배치해, 탭을 왔다갔다할 필요 없이 각자의 프로파일·CWD·동기화 정책을 따로 굴립니다.
- **Claude Code와 Codex는 1급 시민**으로, 언제 일을 하고 있는지·언제 idle인지·언제 끝났는지를 IDE가 이해하고 워크스페이스 셀렉터와 알림으로 드러냅니다.
- **한글·일본어·중국어 IME 입력**은 shadow cursor 레이어가 xterm.js 실제 커서와 컴포지션 상자를 고정시켜 TUI 재그리기 중에도 입력창이 튀지 않습니다.
- **AI 에이전트가 IDE 자체를 조작**할 수 있도록 로컬 HTTP REST API와 MCP 서버가 내장되어 있어 외부 LLM이 페인을 열고, 명령을 실행하고, 출력을 읽고, 스크린샷을 찍습니다.

## 누구를 위한 도구인가

### Windows + WSL 사용자
비율 기반 자유 레이아웃 그리드, WSL 배포판 인식 프로파일, 터미널별 세션 복원(CWD + 스크롤백)을 지원합니다. OSC `9;9`는 Rust에서 파싱되어 배포판 이름을 추출하고, OSC `7`은 동기화된 터미널 간에 CWD를 전파합니다. 설정은 Windows Terminal 스타일의 `colorSchemes`·`profiles` 블록을 그대로 받아들입니다.

### Claude Code 사용자
타이틀 접두(`Claude Code`, Braille 스피너 글리프) 매칭과 버퍼 스캔 폴백으로 활동 상태를 감지합니다. working→idle 전환은 작업 완료 알림으로 이어지고, 프로파일의 `claude.syncCwd` 옵션으로 CWD 전파 시 idle 상태의 Claude에 `! cd …`를 실제로 입력할지 여부를 선택할 수 있습니다.

### Codex CLI 사용자
Codex는 Claude와 함께 interactive-app 패턴에 등록되어 동일한 `shell` / `interactiveApp` / `outputActive` 활동 파이프라인을 공유합니다. IME 컴포지션 오버레이는 Codex와 같은 TUI가 활성일 때만 동작하도록 게이팅되어 일반 셸에서는 방해하지 않습니다.

### CJK / IME 사용자
Shadow cursor 레이어가 xterm.js 실제 커서 위치를 미러링하여 OS IME 후보창이 TUI 재그리기 중에도 지연되거나 튀지 않게 합니다. DECSET 2026 동기화 출력 처리와 xterm.js 커서 재페인트 보정으로 electron 기반 터미널에서 흔한 플리커를 제거했습니다. 설계 문서는 [`docs/terminal/`](./docs/terminal/)에 있습니다.

## 주요 기능

### 레이아웃 & 워크스페이스
- 비율 기반 자유 그리드 (분할 / 병합 / 크기 조절, 편집 모드 토글).
- 4방향 Dock(Top / Bottom / Left / Right)이 워크스페이스 전환과 무관하게 유지.
- 8종 View: Terminal, Settings, WorkspaceSelector, Memo, FileExplorer, Empty, IssueReporter, NotificationPanel.
- 세션 복원: 터미널 스크롤백, CWD, 윈도 지오메트리.

### 터미널
- `portable-pty` 기반 PTY + xterm.js 6 렌더링.
- 프로파일별 `syncCwd` / `restoreCwd` / `restoreOutput` 옵션.
- 리스닝 포트 자동 감지, 워크스페이스 셀렉터에 표시.

### Claude Code & Codex 인식
- OSC 133, DEC 2026h 버스트, 타이틀 스피너 애니메이션으로부터 도출한 3가지 활동 상태(`shell` / `interactiveApp` / `outputActive`).
- `known_claude_terminals` O(1) 캐시 + 버퍼 스캔 폴백으로 즉시 인식.
- working→idle 전환 시 작업 완료 이벤트와 알림 발행.

### CJK / IME
- xterm.js 렌더 커서와 동기화된 shadow cursor로 IME 컴포지션 위치 정확히 고정.
- 컴포지션 프리뷰 오버레이는 Codex 스타일 TUI 활성 상태에서만 표시.
- 플리커 완화 설계: `docs/terminal/fix-flicker.md`, `xterm-shadow-cursor-architecture.md`, `xterm-cursor-repaint-analysis.md`.

### SyncGroup & OSC 훅
- 워크스페이스 스코프 CWD / git 브랜치 자동 동기화 (기본값 = 워크스페이스 ID; 사용자 정의 문자열로 워크스페이스 간 공유, `none`으로 개별화 가능).
- Rust에서 단일 패스로 파싱되는 12개 내장 OSC 프리셋: `sync-cwd` (OSC 7), `set-wsl-distro` (OSC 9;9), `sync-branch`, `set-title-cwd`, `notify-on-fail` / `notify-on-complete` (OSC 133;D), `track-command` / `track-command-result` / `track-command-start` (OSC 133;C/D/E), `notify-osc9` / `notify-osc99` / `notify-osc777`.

### Automation API & MCP
- 고정 포트의 로컬 HTTP REST API: **release `19280`, dev `19281`** (둘은 절대 충돌하지 않음).
- IP allowlist(loopback + RFC 1918 + link-local) — WSL2 / Hyper-V 서브넷이 미리 허용됨. 인증 헤더 불필요.
- rmcp 기반 Streamable-HTTP MCP 서버로 **29개 툴**(터미널, 워크스페이스, 그리드/페인, 스크린샷, 알림, 출력 검색)을 노출.

### `lx` CLI
`lx` 바이너리는 모든 Laymux 터미널의 `PATH`에 자동 주입되며 `LX_SOCKET` / `LX_TERMINAL_ID` / `LX_GROUP_ID` 환경 변수로 연결됩니다. 10개 명령을 제공합니다:

```
lx sync-cwd [path]            # 그룹에 CWD 동기화 (--all 옵션)
lx sync-branch [branch]
lx notify "msg" [--level info|warning|error|success]
lx set-tab-title "title"
lx set-command-status --command "cmd" | --exit-code N
lx open-file <path>
lx send-command "cmd" --group <name>
lx get-cwd
lx get-branch
lx get-terminal-id
```

### 알림 & 워크스페이스 대시보드
- cmux 스타일 `WorkspaceSelectorView`: 워크스페이스별 브랜치, CWD, 리스닝 포트, 마지막 명령 + exit 아이콘, 최신 읽지 않은 알림, 페인 미니맵.
- 알림 레벨: `error` / `warning` / `success` / `info` — 읽지 않은 배지와 OS 네이티브 토스트로 표시.

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | Tauri v2 (Rust + Windows WebView2 / Linux WebKitGTK) |
| 프론트엔드 | React 19, TypeScript, Tailwind CSS 4 |
| 상태 관리 | Zustand |
| 터미널 | xterm.js 6 + portable-pty |
| Automation | axum HTTP + rmcp Streamable-HTTP MCP |
| 플랫폼 | Windows, Linux |

## 시작하기

### 사전 요구사항

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Tauri CLI](https://tauri.app/start/) — `cargo install tauri-cli`
- **Windows**: WebView2 (Windows 10/11 기본 설치됨)
- **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

### 개발 모드

```bash
# 프론트엔드 의존성 설치
cd ui && npm install && cd ..

# 개발 모드 실행 (프론트엔드 dev 서버 + Tauri 앱)
cargo tauri dev
```

프론트엔드 dev 서버는 `http://localhost:1420`에서 실행되고 Tauri 앱이 핫 리로드로 연결됩니다. Dev 빌드는 Automation API 포트 `19281`을 사용하므로 릴리스(`19280`)와 절대 충돌하지 않습니다.

### 빌드

```bash
cargo tauri build
```

플랫폼별 인스톨러가 `src-tauri/target/release/bundle/`에 생성됩니다.

### 테스트

```bash
cd ui && npm test              # 프론트엔드 단위 테스트
cd ui && npm run test:watch    # watch 모드
cd ui && npm run test:e2e      # E2E 테스트
cd src-tauri && cargo test     # Rust 테스트
```

## Automation API

```bash
curl http://localhost:19280/api/v1/health
curl http://localhost:19280/api/v1/workspaces
curl -X POST http://localhost:19280/api/v1/terminals/{id}/write \
  -H "Content-Type: application/json" \
  -d '{"input": "ls -la\n"}'
curl -X POST http://localhost:19280/api/v1/screenshot
curl http://localhost:19280/api/v1/docs
```

포트 디스커버리 파일 위치:
- **Windows**: `%APPDATA%\laymux\automation.json`
- **Linux**: `~/.config/laymux/automation.json`

### MCP (Model Context Protocol)

Streamable-HTTP MCP 엔드포인트(`/mcp`)가 29개 툴(터미널, 워크스페이스, 그리드/페인, 스크린샷, 알림, 출력 검색)을 제공합니다.

```jsonc
// Claude Code ~/.claude.json
{
  "mcpServers": {
    "laymux": {
      "type": "url",
      "url": "http://localhost:19280/mcp"
    }
  }
}
```

전체 툴 목록은 `ARCHITECTURE.md` §12.7 참조.

## 프로젝트 구조

```
laymux/
├── src-tauri/                # Rust 백엔드
│   ├── src/
│   │   ├── lib.rs            # Tauri 앱 설정
│   │   ├── automation_server/ # HTTP REST + MCP 서버
│   │   ├── pty.rs            # 터미널 PTY 관리
│   │   ├── osc.rs            # OSC 파서
│   │   ├── osc_hooks.rs      # 12개 내장 OSC 훅 프리셋
│   │   ├── state.rs          # 애플리케이션 상태
│   │   ├── commands/         # Tauri IPC 커맨드
│   │   ├── terminal/         # 터미널 모듈
│   │   └── bin/lx.rs         # `lx` CLI 바이너리
│   └── Cargo.toml
├── ui/                       # React 프론트엔드
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/       # AppLayout, Dock, WorkspaceArea, Grid
│   │   │   └── views/        # 8종 View
│   │   ├── stores/           # Zustand 스토어
│   │   ├── hooks/            # React 훅
│   │   └── lib/              # OSC, 색상, IME 등 유틸
│   └── package.json
├── docs/
│   ├── screenshots/          # README 이미지
│   └── terminal/             # 커서 / IME / 플리커 레퍼런스 문서
├── ARCHITECTURE.md           # 상세 아키텍처 명세
└── CLAUDE.md                 # 개발 가이드라인
```

## 키보드 단축키

IDE 단축키는 셸·readline 바인딩과 겹치지 않도록 `Ctrl+단일키`를 피합니다.

| 단축키 | 동작 |
|--------|------|
| **`Ctrl+Alt+↓/↑`** | **다음 / 이전 워크스페이스** |
| **`Ctrl+Alt+←/→`** | **알림 간 내비게이션** |
| **`Alt+Arrow`** | **Pane 포커스 이동** |
| `Ctrl+Alt+1-8`, `9` | 워크스페이스 1–9 이동 |
| `Ctrl+Shift+I` | 알림 패널 토글 |
| `Ctrl+Shift+U` | 읽지 않은 알림으로 이동 |
| `Ctrl+Shift+W` | 워크스페이스 닫기 |
| `Ctrl+Shift+R` | 워크스페이스 이름 변경 |
| `Ctrl+Shift+B` | 사이드바 토글 |
| `Delete` (편집 모드) | 포커스된 Pane 제거 |
| `Ctrl+,` | 설정 |

## 문서

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 전체 아키텍처 명세.
- [`docs/terminal/`](./docs/terminal/) — 커서·IME·플리커 리서치 문서 (레퍼런스 전용).
- [`CLAUDE.md`](./CLAUDE.md) — 개발 가이드라인.

## 관련 프로젝트

같은 작성자가 만든, Laymux 사용자층과 잘 맞는 도구들:

- [**claude-simple-usage**](https://github.com/kochul2000/claude-simple-usage) — 가벼운 Claude Code 사용량 / 토큰 트래커.
- [**JetBrainsMonoBigHangul**](https://github.com/kochul2000/JetBrainsMonoBigHangul) — 한글 글리프를 키운 JetBrains Mono 패치 폰트. CJK 터미널 가독성용.

## 라이선스

MIT
