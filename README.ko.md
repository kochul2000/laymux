# Laymux

Tauri(Rust + WebView) 기반의 자유 레이아웃 터미널 중심 IDE.

[English](./README.md)

## 개요

Laymux는 터미널 워크플로우에 최적화된 데스크톱 IDE입니다. 유연한 그리드 기반 레이아웃, 도킹 패널, 워크스페이스 관리, 터미널 동기화 기능을 네이티브 경량 셸에서 제공합니다.

### 주요 기능

- **자유 레이아웃 그리드** — 비율 기반 그리드로 Pane을 자유롭게 배치. 분할, 크기 조절, 병합 지원.
- **4방향 Dock** — Top, Bottom, Left, Right 독 영역이 워크스페이스 전환과 무관하게 항상 유지.
- **워크스페이스** — 레이아웃 + View 구성을 저장하고 전환. 레이아웃은 템플릿으로 여러 워크스페이스가 공유 가능.
- **터미널 중심** — PTY 기반 터미널(xterm.js + portable-pty)로 WSL, PowerShell 프로파일 지원.
- **SyncGroup** — 같은 그룹의 터미널 간 CWD, git 브랜치 등 상태 동기화.
- **OSC Hook** — 터미널 이스케이프 시퀀스(OSC 7, OSC 133)에 반응하여 디렉터리 동기화, 실패 알림 등 IDE 액션 트리거.
- **브라우저 미리보기** — 내장 WebView로 웹 앱 실시간 미리보기.
- **Automation API** — `localhost:19280`의 HTTP REST API로 외부 도구(CI, AI 에이전트, 스크립트)에서 IDE를 프로그래밍적으로 제어.
- **IDE CLI** — 터미널 내에서 `ide` 명령으로 동기화, 알림, 터미널 간 통신.
- **알림 시스템** — 워크스페이스별 읽지 않은 배지, 알림 링, OS 네이티브 알림.

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프레임워크 | Tauri v2 (Rust + WebView2 / WebKitGTK) |
| 프론트엔드 | React 19, TypeScript, Tailwind CSS 4 |
| 상태 관리 | Zustand |
| 터미널 | xterm.js 6 + portable-pty |
| Automation | axum (Rust HTTP 서버) |
| 플랫폼 | Windows, Linux |

## 시작하기

### 사전 요구사항

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Tauri CLI](https://tauri.app/start/)
  ```bash
  cargo install tauri-cli
  ```
- **Windows**: WebView2 (Windows 10/11 기본 설치됨)
- **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

### 개발 모드

```bash
# 프론트엔드 의존성 설치
cd ui && npm install && cd ..

# 개발 모드 실행 (프론트엔드 dev 서버 + Tauri 앱 동시 실행)
cargo tauri dev
```

프론트엔드 dev 서버가 `http://localhost:1420`에서 실행되며, Tauri 앱이 핫 리로드로 연결됩니다.

### 빌드

```bash
# 프로덕션 빌드
cargo tauri build
```

플랫폼별 인스톨러가 `src-tauri/target/release/bundle/`에 생성됩니다.

### 테스트

```bash
# 프론트엔드 단위 테스트
cd ui && npm test

# 프론트엔드 단위 테스트 (watch 모드)
cd ui && npm run test:watch

# E2E 테스트
cd ui && npm run test:e2e

# Rust 테스트
cd src-tauri && cargo test
```

## 프로젝트 구조

```
laymux/
├── src-tauri/           # Rust 백엔드
│   ├── src/
│   │   ├── lib.rs       # Tauri 앱 설정
│   │   ├── automation_server.rs  # HTTP REST API
│   │   ├── pty.rs       # 터미널 PTY 관리
│   │   ├── state.rs     # 애플리케이션 상태
│   │   ├── commands/    # Tauri IPC 커맨드
│   │   ├── terminal/    # 터미널 모듈
│   │   └── bin/ide.rs   # IDE CLI 바이너리
│   └── Cargo.toml
├── ui/                  # React 프론트엔드
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/  # AppLayout, Dock, WorkspaceArea, Grid
│   │   │   └── views/   # TerminalView, BrowserPreview, Settings 등
│   │   ├── stores/      # Zustand 스토어
│   │   ├── hooks/       # React 훅
│   │   └── lib/         # 유틸리티 (OSC 파서, 색상 등)
│   └── package.json
├── mcp-server/          # Claude Code MCP 서버 연동
├── ARCHITECTURE.md      # 상세 아키텍처 명세
└── CLAUDE.md            # 개발 가이드라인
```

## Automation API

Laymux는 프로그래밍 제어를 위한 로컬 HTTP API를 제공합니다:

```bash
# 헬스체크
curl http://localhost:19280/api/v1/health

# 워크스페이스 목록
curl http://localhost:19280/api/v1/workspaces

# 터미널에 입력
curl -X POST http://localhost:19280/api/v1/terminals/{id}/write \
  -H "Content-Type: application/json" \
  -d '{"input": "ls -la\n"}'

# 스크린샷
curl -X POST http://localhost:19280/api/v1/screenshot

# 전체 API 문서
curl http://localhost:19280/api/v1/docs
```

포트 디스커버리 파일 위치:
- **Windows**: `%APPDATA%\laymux\automation.json`
- **Linux**: `~/.config/laymux/automation.json`

## 키보드 단축키

IDE 단축키는 셸 바인딩과 충돌하지 않도록 `Ctrl+단일키`를 피합니다.

| 단축키 | 동작 |
|--------|------|
| `Ctrl+Alt+1-8` | 워크스페이스 1-8 이동 |
| `Ctrl+Alt+↓/↑` | 다음 / 이전 워크스페이스 |
| `Ctrl+Shift+W` | 워크스페이스 닫기 |
| `Ctrl+Shift+R` | 워크스페이스 이름 변경 |
| `Ctrl+Shift+B` | 사이드바 토글 |
| `Alt+Arrow` | Pane 포커스 이동 |
| `Ctrl+,` | 설정 |

## 라이선스

MIT
