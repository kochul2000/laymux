# AGENTS.md

> 코딩 에이전트(Claude Code, Codex 등)를 위한 리포 진입점.
> `CLAUDE.md` 는 이 파일을 가리키는 포인터다 — 규칙은 한 곳(AGENTS.md)만 유지한다.
> 모든 출력은 한글로 한다.

## 이 리포

laymux — Tauri(Rust + WebView) 기반 자유 레이아웃 터미널 IDE. Windows·Linux 지원.

- **src-tauri/** — Rust 백엔드. PTY, OSC 처리, Automation API(axum), 내장 MCP 서버, 설정/세션.
- **ui/** — React + TypeScript + Zustand 프론트엔드. xterm.js 터미널, 그리드 레이아웃.
- **lx** — 터미널에 자동 주입되는 IDE 통신 CLI 바이너리(Rust, Tauri 동봉).

## 설계 정본 — 코드 짜기 전에 읽어라

설계 결정은 git issue 가 아니라 **`docs/` 가 SoT** 다.

- **`docs/architecture/`** — 현재 구조 (living doc, HEAD 반영)
  - [`overview.md`](docs/architecture/overview.md) — 구조·기술 스택·레이아웃·Workspace/Layout 모델·View·SyncGroup
  - [`data-flow.md`](docs/architecture/data-flow.md) — Grid 편집·TerminalView(OSC 파이프라인·렌더러 reflow)·SelectorView 상태 계산·데이터 흐름·세션 영속
  - [`api-contracts.md`](docs/architecture/api-contracts.md) — Settings(settings.json)·Automation API+MCP·**Rust 코드 설계 원칙(§14)**·**UI 코드 설계 원칙(§15)**
- **`docs/adr/`** — 아키텍처 결정 기록 (append-only, 불변). "왜 그렇게 정했나"
- **`docs/roadmap.md`** — 진행 상태
- **`docs/terminal/`** — 터미널 커서/플리커 research 정본 ([ADR-0008](docs/adr/0008-shell-cursor-shadow-cursor.md))

**living doc 동기화 의무.** 기능 추가/수정 전 관련 `docs/architecture/` 섹션을 읽고 설계 원칙을 확인한다. 코드 변경이 서술과 어긋나면 **같은 PR 에서** 문서를 갱신한다. 구현이 아키텍처와 달라지면 사용자와 논의하여 반드시 갱신한다. 새 설계 결정을 내리면 → `docs/adr/0000-template.md` 를 복사해 ADR 추가(번복 시 옛 ADR 은 `Superseded by` 만 표시, 본문 유지).

## 개발 환경

- **테스트는 TDD.** 전체 스위트(unit + e2e + build + 실행 검증)는 `/full-test` 스킬.
- **컴파일 에러 우선 처리:** 새 필드/기능으로 기존 테스트가 깨지면 기본값(`None`/`0`)만 채워 컴파일만 통과시키지 말고, 그 기능을 실제 검증하는 e2e 테스트를 추가한다.
- **CI lint 없음** — 로컬에서 fmt/clippy/eslint/prettier 관리.
- **마이그레이션 불필요** — 내부 개발 단계. 설정 경로/스키마 변경에 마이그레이션 로직을 만들지 않고 기존 데이터는 수동 처리.

## 자율 검증 루프

UI/디자인 변경은 `/screenshot` 스킬로 최종 결과를 확인한다. 스크린샷으로 못 보는 상태(모달 등)는 **Automation API 엔드포인트를 확장**해 프로그래밍적으로 트리거 후 검증한다. 기능 추가 시 항상 API 확장 + 자율 루프(API 조작→스크린샷→평가→수정) 구성 가능 여부를 고려한다. ([api-contracts.md §12](docs/architecture/api-contracts.md), [ADR-0002](docs/adr/0002-automation-api-fixed-port-ip-allowlist.md))

- **포트 규칙:** release=19280, dev=19281. 빌드 타입당 1 인스턴스. 개발 중 스크린샷/API 는 **반드시 dev(19281)**, release(19280)는 사용자 소유이므로 건드리지 않는다. 인증 불필요(IP allowlist).
- **dev 종료는 반드시 `bash scripts/kill-dev.sh`** — release/dev 가 같은 `laymux.exe` 이므로 `tasklist | grep laymux` 로 수동 kill 금지. `automation.json` PID 로 dev 만 안전 종료.

## 작업 규칙 (코드 짜기 전 확인)

- **Rust 설계 원칙** — [api-contracts.md §14](docs/architecture/api-contracts.md). 에러 `AppError`(프로덕션 `unwrap()` 금지), 락 `MutexExt::lock_or_err()` + `state.rs` 순서, 매직 스트링은 `constants.rs`, 파일 500줄↑ 분할, `#[tauri::command]` 는 얇은 진입점(핵심 로직은 `&AppState` 내부 함수), `eprintln!` 대신 `tracing`.
- **외부 프로세스는 `crate::process::headless_command()`** — `std::process::Command::new()` 금지(Windows 콘솔 창 깜빡임 방지).
- **OSC 처리는 Rust 전용** — 파싱(`osc.rs`)·훅(`osc_hooks.rs`)·디스패치(`dispatch_osc_action`)는 Rust PTY 콜백 단일 패스. 프론트는 구조화 Tauri 이벤트만 구독. ([ADR-0001](docs/adr/0001-osc-rust-single-pass.md))
- **CWD 는 SyncGroup 으로** — 백그라운드 셸을 만들지 말고 `terminalStore` 의 syncGroup CWD 를 구독. FS 접근은 Rust `std::fs`. ([ADR-0003](docs/adr/0003-cwd-single-source-syncgroup.md))
- **원시 상태 분리 → 단일 계산 함수** — 여러 시스템이 한 표시에 관여할 때 각자 원시 상태만 저장하고, 표시는 계산 함수에서 도출. ([ADR-0005](docs/adr/0005-display-state-raw-separation-compute.md))
- **UI 설계 원칙** — [api-contracts.md §15](docs/architecture/api-contracts.md). CSS 변수 우선(`index.css` `:root`), 호버는 CSS 클래스(`style.background` 직접 조작 금지), 재사용 UI 는 `components/ui/`, 키 조합 하드코딩 금지(키바인딩 레지스트리).
- **`color-mix()` 금지** — html2canvas 가 파싱 못 해 스크린샷 API 가 깨진다. `var(--accent-50)` 등 사전 정의 CSS 변수 사용.
- **터미널 커서/플리커는 research 정본을 따른다** — cursor/overlay/IME/flicker/DECSET 2026 변경은 `docs/terminal/{fix-flicker,xterm-shadow-cursor-architecture,xterm-cursor-repaint-analysis}.md` 3개를 정본으로 확인. 기억·즉흥 실험만으로 수정 금지. 이 문서들은 통상 작업 중 수정하지 않는다(사용자가 명시 요청 시에만). ([ADR-0008](docs/adr/0008-shell-cursor-shadow-cursor.md))

## Claude Code 자동화 테스트

dev 터미널에서 `claude` 를 프로그래밍 방식으로 구동·검증하는 절차(초기화 대기 → trust 통과 → 타이틀 폴링 → 종료)는 [`docs/claude-code-automation.md`](docs/claude-code-automation.md) 참조.
