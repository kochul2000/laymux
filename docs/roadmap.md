# 로드맵 / 진행 상태

> 진행 트래커. 설계 정본이 아니라 "어디까지 왔나" 의 living 상태다.
> 무엇을·왜는 [architecture/](./architecture/) 와 [adr/](./adr/) 가 SoT. 세부 작업 상태는 GitHub issue 가 1차 소스.

## 출하됨 (shipped)

- [x] **레이아웃 엔진** — 4 Dock + 자유 비율 Grid WorkspaceArea, lazy mount, Grid 편집 UX(분할/병합/리사이즈) ([overview §3·§5](./architecture/overview.md))
- [x] **Workspace / Layout 모델** — Layout→Workspace 생성, 인스턴스 오버라이드 레이어 ([ADR-0004](./adr/0004-settings-vs-ui-state-separation.md))
- [x] **TerminalView** — xterm.js + PTY, `lx` CLI 주입, shadow cursor / 플리커 완화 ([ADR-0008](./adr/0008-shell-cursor-shadow-cursor.md))
- [x] **OSC 파이프라인** — Rust 단일 패스 파싱·훅·디스패치, 프리셋 12종 ([ADR-0001](./adr/0001-osc-rust-single-pass.md))
- [x] **SyncGroup / CWD 동기화** — 단일 소스 + activity 가드 전파 ([ADR-0003](./adr/0003-cwd-single-source-syncgroup.md))
- [x] **WorkspaceSelectorView** — cmux 클론, 미니맵, activity-aware 상태 계산, 알림 시스템 ([ADR-0005](./adr/0005-display-state-raw-separation-compute.md))
- [x] **Settings** — Windows Terminal 호환 교집합, settings.json/localStorage 분리
- [x] **Automation API** — axum REST, 고정 포트 + IP allowlist 무인증 ([ADR-0002](./adr/0002-automation-api-fixed-port-ip-allowlist.md))
- [x] **내장 MCP 서버** — rmcp HTTP `/mcp`, tool 30종 ([ADR-0006](./adr/0006-embedded-mcp-server.md))
- [x] **MCP Resources** — 구독형 read-only 상태 노출 (issue #202)
- [x] **세션 영속 / 캐시** — 출력·CWD 복원, 안정 pane ID, 숨김 터미널 자동 종료(#269)
- [x] **Pane 식별자 3종** — terminalId / paneIndex / paneNumber, 번호 주소 지정 + 배지 복사 ([ADR-0007](./adr/0007-pane-identifier-trio.md), #256·#276)
- [x] **통합 파일 뷰어** — FileExplorerView + 텍스트/이미지/터미널 뷰어, MCP `show_image`(#277·#278·#279·#287)

## 다음 / 검토 중

- [ ] View 플러그인 시스템 (현재 built-in only)
- [ ] activity 핸들러 확장 (neovim, htop 등 — [ADR-0005](./adr/0005-display-state-raw-separation-compute.md))

> 새 마일스톤/이슈가 확정되면 이 표에 한 줄 추가하고, 출하 시 `[x]` 로 옮긴다.
