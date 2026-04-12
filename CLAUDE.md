* 모든 개발 진행은 TDD 로 한다.
* **구현 전 ARCHITECTURE.md 필독**: 기능 추가/수정 전에 반드시 `ARCHITECTURE.md`의 관련 섹션을 읽고 설계 원칙을 확인한다. 특히 §14(Rust 설계 원칙), §15(UI 설계 원칙)는 코드 작성 전 반드시 숙지한다. 만약 구현 내용이 아키텍처와 달라지면 사용자와 논의하여 반드시 갱신한다.
* UI/디자인 변경 시 반드시 `/screenshot` 스킬로 최종 결과를 확인한다. 스크린샷으로 확인할 수 없는 상태(모달, 특정 UI 상태 등)는 Automation API 엔드포인트를 확장하여 프로그래밍적으로 트리거한 뒤 검증한다.
* 모든 개발 시 자율 검증 루프(API 조작→스크린샷→평가→수정)를 구성하여 스스로 결과를 확인하고 품질을 높인다. 필요한 API 엔드포인트가 없으면 먼저 추가한다. Automation API는 AI가 IDE를 자율 제어할 수 있는 핵심 인터페이스이므로, 기능 추가 시 항상 API 확장과 자율 루프 구성 가능 여부를 고려한다.
* **컴파일 에러 수정 시 테스트 우선**: 새 필드/기능 추가로 인해 기존 테스트가 컴파일 에러를 일으키면, 단순히 기본값(`None`, `0` 등)을 채워 넣어 컴파일만 통과시키지 말고, 해당 기능을 실제로 검증하는 e2e 테스트를 추가한다.
* **마이그레이션 불필요**: 현재 내부 개발 단계이므로 설정 파일 경로 변경 등에 대한 마이그레이션 로직은 구현하지 않는다. 기존 데이터는 수동으로 처리한다.
* **Automation API 포트 규칙**: 고정 포트 — release=19280, dev=19281. 각 빌드 타입은 하나의 인스턴스만 실행 가능. 개발 중 스크린샷/API 호출은 반드시 dev 인스턴스(포트 19281)를 사용한다. Release 빌드(포트 19280)는 사용자가 직접 사용하므로 절대 건드리지 않는다. **Bearer 인증 필수**: dev discovery 파일(`%APPDATA%\laymux-dev\automation.json`)에서 `port`와 `key`를 읽어 모든 API 호출에 `Authorization: Bearer <key>` 헤더를 포함한다. Health 엔드포인트만 인증 없이 접근 가능.
* **dev 프로세스 종료 시 반드시 `scripts/kill-dev.sh` 사용**: dev 인스턴스를 종료해야 할 때(포트 충돌, exe 잠금, 재시작 등) **절대로 `tasklist | grep laymux`로 PID를 찾아 수동 kill하지 않는다.** release와 dev가 동일한 `laymux.exe` 이름을 사용하므로 구분이 불가능하여 release를 잘못 죽일 수 있다. 반드시 `bash scripts/kill-dev.sh`를 실행하여 `automation.json` PID 기반으로 dev만 안전하게 종료한다.
* **외부 프로세스 실행 시 headless_command 사용**: Rust에서 `std::process::Command::new()` 대신 반드시 `crate::process::headless_command()`를 사용한다. Windows에서 콘솔 창이 깜빡이는 것을 방지하기 위해 `CREATE_NO_WINDOW` 플래그를 자동 적용한다.
* **Rust 코드 설계 원칙 준수**: ARCHITECTURE.md §14에 정의된 Rust 설계 원칙을 따른다. 핵심 규칙:
  - 에러: `AppError` enum 사용, 프로덕션 코드에서 `unwrap()` 금지
  - 락: `MutexExt::lock_or_err()` 사용, `state.rs` 문서화 순서 준수
  - 상수: 이벤트명/환경변수명 등 매직 스트링은 `constants.rs`에 정의
  - 모듈: 파일 500줄 초과 시 분할 고려, `mod.rs`는 `pub use` 허브만
  - 커맨드: `#[tauri::command]`는 얇은 진입점, 핵심 로직은 `&AppState` 받는 내부 함수로 분리
  - 로깅: `eprintln!()` 대신 `tracing` 매크로 사용
* **OSC 처리는 Rust 전용** (`ARCHITECTURE.md` §8.3 참조): OSC 이스케이프 시퀀스의 파싱(`osc.rs`), 훅 매칭(`osc_hooks.rs`), 액션 디스패치(`dispatch_osc_action`)는 모두 Rust PTY 콜백에서 단일 패스로 처리한다. 프론트엔드에서 OSC regex 파싱, 훅 조건 평가, IPC 라운드트립을 통한 OSC 처리를 하지 않는다. 프론트엔드는 Rust가 발행한 구조화 Tauri 이벤트(`terminal-title-changed`, `sync-cwd` 등)만 구독한다. 새 OSC 동작 추가 시 `osc_hooks.rs`에 프리셋을 추가하고 `dispatch_osc_action()`에서 분기한다.
* **`color-mix()` 사용 금지**: `color-mix(in srgb, ...)` 등 현대 CSS 색상 함수는 html2canvas가 파싱하지 못해 스크린샷 API가 깨진다. 반투명 accent가 필요하면 `var(--accent-50)`, `var(--accent-20)` 등 `index.css`에 정의된 CSS 변수를 사용한다.
* **원시 상태 분리 → 계산 함수로 표시 도출**: 여러 시스템(OSC 133, 타이틀 변경 등)이 관여하는 상태를 표시할 때, 각 시스템은 자기 원시 상태만 독립적으로 저장하고 하나의 공유 필드를 덮어쓰지 않는다. 최종 표시(아이콘, 색상 등)는 모든 원시 상태를 입력받는 단일 계산 함수에서 도출한다. 표시 규칙이 바뀌면 계산 함수만 수정한다.
* **CWD는 모든 설계의 핵심**: CWD(현재 작업 디렉터리)는 SyncGroup을 통해 터미널 간 동기화되며, `terminalStore`에 중앙 관리된다. 새 View나 기능이 CWD 정보를 필요로 할 때 **백그라운드 셸을 생성하지 말고** `terminalStore`의 syncGroup CWD를 구독하여 사용한다. 파일 시스템 접근(디렉터리 목록 등)은 Rust 백엔드(`std::fs`)를 직접 호출한다.
* **Claude Code 자동화 테스트 시 주의사항**: dev 터미널에서 `claude` 명령으로 Claude Code를 자동 실행할 때, 다음 절차를 따른다:
  1. `claude\r\n` 전송 후 **10초 대기** (Claude Code 초기화 시간)
  2. 터미널 출력(`GET /api/v1/terminals/:id/output`)에서 **"trust" 문자열 확인** — "Yes, I trust this folder" 프롬프트가 나타나면 `y\r\n` 전송하여 통과. 이 프롬프트는 해당 프로젝트 디렉터리에 처음 접근할 때 나타나며, PowerShell/WSL 모두 발생할 수 있다.
  3. trust 통과 후 또는 trust 없을 때, **"Claude Code" 문자열이 타이틀에 나타날 때까지 폴링** (3초 간격, 최대 60초). `GET /api/v1/terminals`의 `title` 필드에 "Claude Code"가 포함되거나 activity가 `{"type":"interactiveApp","name":"Claude"}`이면 준비 완료.
  4. 종료: Ctrl+C(`\u0003`)를 0.3초 간격으로 2회 전송. 5초 대기 후 activity가 "shell"로 변경되었는지 확인.
* **UI 코드 설계 원칙** (`ARCHITECTURE.md` §15 참조):
  - **CSS 변수 우선**: 모든 공통 값(색상, 간격, 반경, 폰트 크기, hover overlay)은 `index.css` `:root`에 CSS 변수로 정의. 하드코딩된 매직 넘버 금지.
  - **호버/인터랙션**: `onMouseEnter/Leave`에서 `style.background` 직접 조작 금지. CSS 호버 클래스(`.hover-bg` 등)를 사용.
  - **공유 컴포넌트**: 재사용 UI 요소는 `components/ui/`에 배치. 3곳 이상 동일 패턴 반복 시 공통화.
  - **스타일링**: Tailwind 유틸리티(레이아웃) + CSS 변수(테마 값) 하이브리드. 인라인 `style`은 동적/조건부 값에만 사용.
* **Cursor work must follow the reference docs**: Any change to terminal cursor behavior, shadow cursor logic, overlay caret behavior, IME/composition handling, flicker mitigation, or DECSET 2026 synchronized output handling MUST be checked against ALL THREE documents before editing code:
  - `docs/terminal/fix-flicker.md` — canonical entry point and workflow checklist.
  - `docs/terminal/xterm-shadow-cursor-architecture.md` — 4-layer shadow cursor implementation guide (OSC 133, DECSC/RC, Mode 2026, onWriteParsed). Contains the complete `ShadowInputCursor` class.
  - `docs/terminal/xterm-cursor-repaint-analysis.md` — deep analysis of WHY cursorX/Y drifts to footer during TUI repaints. Covers DECSET 2026 render/parse split, CSI s/u vs ESC 7/8 pitfalls, overlay sync timing (onRender vs onWriteParsed), buffer line inspection, and prompt marker design. Includes xterm.js issue/PR references.
  Do not make cursor or overlay changes from memory or ad hoc experimentation alone. This is a complex, multi-layered problem where naive fixes cause regressions.
* **Terminal cursor docs are research truth, not routine edit targets**: Treat `fix-flicker.md`, `xterm-shadow-cursor-architecture.md`, and `xterm-cursor-repaint-analysis.md` as authoritative reference material. Do not update these documents during normal implementation work unless the user explicitly asks to revise the research documents themselves.
