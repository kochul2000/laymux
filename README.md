# Laymux

A free-layout, terminal-focused IDE built with Tauri (Rust + WebView).

[한국어](./README.ko.md)

## Overview

Laymux is a desktop IDE designed around terminal workflows. It provides a flexible grid-based layout system with dockable panels, workspace management, and terminal synchronization — all in a lightweight native shell.

### Key Features

- **Free-layout Grid** — Arrange panes in any ratio-based grid configuration. Split, resize, and merge panes freely.
- **4-Dock System** — Top, Bottom, Left, Right dock areas that persist across workspace switches.
- **Workspaces** — Save and switch between different layout + view configurations. Layouts define pane structure and are used at workspace creation time.
- **Terminal-first** — Full PTY terminals (xterm.js + portable-pty) with WSL and PowerShell profile support.
- **SyncGroup** — Synchronize CWD, git branch, and other state across terminals in the same group.
- **OSC Hooks** — React to terminal escape sequences (OSC 7, OSC 133) to trigger IDE actions like directory sync and failure notifications.
- **Browser Preview** — Embedded WebView for live previewing web apps.
- **Automation API** — HTTP REST API on `localhost:19280` for programmatic control by external tools (CI, AI agents, scripts).
- **IDE CLI** — `ide` command available inside terminals for sync, notifications, and inter-terminal communication.
- **Notification System** — Per-workspace unread badges, alert rings, and OS-native notifications.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri v2 (Rust + WebView2 / WebKitGTK) |
| Frontend | React 19, TypeScript, Tailwind CSS 4 |
| State | Zustand |
| Terminal | xterm.js 6 + portable-pty |
| Automation | axum (Rust HTTP server) |
| Platforms | Windows, Linux |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Tauri CLI](https://tauri.app/start/)
  ```bash
  cargo install tauri-cli
  ```
- **Windows**: WebView2 (pre-installed on Windows 10/11)
- **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

### Development

```bash
# Install frontend dependencies
cd ui && npm install && cd ..

# Run in development mode (launches both frontend dev server and Tauri app)
cargo tauri dev
```

The frontend dev server starts on `http://localhost:1420` and the Tauri app connects to it with hot reload.

### Build

```bash
# Production build
cargo tauri build
```

Outputs platform-specific installers in `src-tauri/target/release/bundle/`.

### Testing

```bash
# Frontend unit tests
cd ui && npm test

# Frontend unit tests (watch mode)
cd ui && npm run test:watch

# E2E tests
cd ui && npm run test:e2e

# Rust tests
cd src-tauri && cargo test
```

## Project Structure

```
laymux/
├── src-tauri/           # Rust backend
│   ├── src/
│   │   ├── lib.rs       # Tauri app setup
│   │   ├── automation_server.rs  # HTTP REST API
│   │   ├── pty.rs       # Terminal PTY management
│   │   ├── state.rs     # Application state
│   │   ├── commands/    # Tauri IPC commands
│   │   ├── terminal/    # Terminal module
│   │   └── bin/ide.rs   # IDE CLI binary
│   └── Cargo.toml
├── ui/                  # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/  # AppLayout, Dock, WorkspaceArea, Grid
│   │   │   └── views/   # TerminalView, BrowserPreview, Settings, etc.
│   │   ├── stores/      # Zustand stores
│   │   ├── hooks/       # React hooks
│   │   └── lib/         # Utilities (OSC parser, colors, etc.)
│   └── package.json
├── mcp-server/          # Claude Code MCP server integration
├── ARCHITECTURE.md      # Detailed architecture specification
└── CLAUDE.md            # Development guidelines
```

## Automation API

Laymux exposes a local HTTP API for programmatic control:

```bash
# Health check
curl http://localhost:19280/api/v1/health

# List workspaces
curl http://localhost:19280/api/v1/workspaces

# Write to a terminal
curl -X POST http://localhost:19280/api/v1/terminals/{id}/write \
  -H "Content-Type: application/json" \
  -d '{"input": "ls -la\n"}'

# Take a screenshot
curl -X POST http://localhost:19280/api/v1/screenshot

# Full API documentation
curl http://localhost:19280/api/v1/docs
```

Port discovery file location:
- **Windows**: `%APPDATA%\laymux\automation.json`
- **Linux**: `~/.config/laymux/automation.json`

## Keyboard Shortcuts

IDE shortcuts avoid `Ctrl+single-key` to not conflict with shell bindings.

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+1-8` | Switch to workspace 1-8 |
| `Ctrl+Alt+↓/↑` | Next / previous workspace |
| `Ctrl+Shift+W` | Close workspace |
| `Ctrl+Shift+R` | Rename workspace |
| `Ctrl+Shift+B` | Toggle sidebar |
| `Alt+Arrow` | Move pane focus |
| `Ctrl+,` | Settings |

## License

MIT
