# Project Overview

**laymux** — Tauri v2 (Rust + WebView) 기반의 자유 레이아웃 터미널 중심 IDE.

## Tech Stack
- **Framework**: Tauri v2 (Rust backend + React/TypeScript frontend)
- **Frontend**: React 19 + TypeScript + Zustand (상태관리) + Tailwind CSS v4 + xterm.js
- **Backend**: Rust (portable-pty, axum HTTP server, tokio async runtime)
- **Platform**: Windows, Linux
- **Build**: Vite 8, Cargo
- **Test**: Vitest (unit), Playwright (e2e), Rust `#[cfg(test)]` + `src-tauri/tests/`

## Key Features
- 자유 비율 그리드 레이아웃 (Workspace → Pane 구조)
- SyncGroup을 통한 터미널 간 CWD/Branch 동기화
- OSC 이스케이프 시퀀스 처리 (Rust PTY 콜백에서 단일 패스)
- Automation HTTP API (release=19280, dev=19281)
- `lx` CLI 바이너리 (Tauri 동봉)
- WorkspaceSelectorView (cmux 클론)

## Directory Structure
```
laymux/
├── ui/                    # React/TypeScript frontend
│   ├── src/
│   │   ├── components/    # layout/, ui/, views/
│   │   ├── stores/        # Zustand stores (workspace, terminal, grid, dock, etc.)
│   │   ├── hooks/
│   │   └── lib/
│   ├── e2e/               # Playwright e2e tests
│   └── package.json
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── commands/      # Tauri IPC commands
│   │   ├── settings/      # Settings management
│   │   ├── automation_server/  # HTTP API (axum)
│   │   ├── terminal/      # Terminal models
│   │   └── ...            # osc, pty, state, constants, etc.
│   └── tests/             # Integration/e2e tests
├── scripts/               # kill-dev.sh
├── mcp-server/            # MCP server
└── ARCHITECTURE.md        # Detailed architecture doc
```
