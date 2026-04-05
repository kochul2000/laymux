* 모든 개발 진행은 TDD 로 한다.
* @ARCHITECTURE.md 를 기반으로 수정한다. 만약 내용이 달라지면 사용자와 논의하여 반드시 갱신한다.
* UI/디자인 변경 시 반드시 `/screenshot` 스킬로 최종 결과를 확인한다. 스크린샷으로 확인할 수 없는 상태(모달, 특정 UI 상태 등)는 Automation API 엔드포인트를 확장하여 프로그래밍적으로 트리거한 뒤 검증한다.
* 모든 개발 시 자율 검증 루프(API 조작→스크린샷→평가→수정)를 구성하여 스스로 결과를 확인하고 품질을 높인다. 필요한 API 엔드포인트가 없으면 먼저 추가한다. Automation API는 AI가 IDE를 자율 제어할 수 있는 핵심 인터페이스이므로, 기능 추가 시 항상 API 확장과 자율 루프 구성 가능 여부를 고려한다.
* **컴파일 에러 수정 시 테스트 우선**: 새 필드/기능 추가로 인해 기존 테스트가 컴파일 에러를 일으키면, 단순히 기본값(`None`, `0` 등)을 채워 넣어 컴파일만 통과시키지 말고, 해당 기능을 실제로 검증하는 e2e 테스트를 추가한다.
* **마이그레이션 불필요**: 현재 내부 개발 단계이므로 설정 파일 경로 변경 등에 대한 마이그레이션 로직은 구현하지 않는다. 기존 데이터는 수동으로 처리한다.
* **Automation API 포트 규칙**: 고정 포트 — release=19280, dev=19281. 각 빌드 타입은 하나의 인스턴스만 실행 가능. 개발 중 스크린샷/API 호출은 반드시 dev 인스턴스(포트 19281)를 사용한다. Release 빌드(포트 19280)는 사용자가 직접 사용하므로 절대 건드리지 않는다. dev discovery 파일: `%APPDATA%\laymux-dev\automation.json`.
* **외부 프로세스 실행 시 headless_command 사용**: Rust에서 `std::process::Command::new()` 대신 반드시 `crate::process::headless_command()`를 사용한다. Windows에서 콘솔 창이 깜빡이는 것을 방지하기 위해 `CREATE_NO_WINDOW` 플래그를 자동 적용한다.
* **`color-mix()` 사용 금지**: `color-mix(in srgb, ...)` 등 현대 CSS 색상 함수는 html2canvas가 파싱하지 못해 스크린샷 API가 깨진다. 반투명 accent가 필요하면 `var(--accent-50)`, `var(--accent-20)` 등 `index.css`에 정의된 CSS 변수를 사용한다.
* **CWD는 모든 설계의 핵심**: CWD(현재 작업 디렉터리)는 SyncGroup을 통해 터미널 간 동기화되며, `terminalStore`에 중앙 관리된다. 새 View나 기능이 CWD 정보를 필요로 할 때 **백그라운드 셸을 생성하지 말고** `terminalStore`의 syncGroup CWD를 구독하여 사용한다. 파일 시스템 접근(디렉터리 목록 등)은 Rust 백엔드(`std::fs`)를 직접 호출한다.
