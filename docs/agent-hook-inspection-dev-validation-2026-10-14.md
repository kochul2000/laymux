# 훅 설치 검사 재사용 dev 검증 — 2026-10-14

관련 변경: PR #1189, [ADR-0324](adr/0324-agent-hook-inspection-on-discovery.md).

## 환경과 측정

- Windows native Tauri dev API 19281, CDP 9229. 초기 실행 head `099bafa0`, branch `fix/hook-warning-repeat`를 health로 확인했다.
- APPDATA·LOCALAPPDATA·WebView 데이터는 격리했다. release 19280과 사용자 CLI 설정을 수정하지 않았다. 기본 native·WSL 훅 폴더는 읽기 전용으로 검사했고 설치·손상 fixture는 리포의 `.tmp/`에 한정했다.
- `Inspecting agent hook installation` backend debug 기록으로 실제 설치 status·관리 진입 횟수를 셌다. IPC 성공 응답이나 설치 결과를 mock하지 않았다.
- 최초 실행에 native Claude/Codex와 실행 중 Ubuntu-22.04의 Claude/Codex를 각각 한 번 검사했다(총 4회). 같은 앱의 자동 캐시 조회는 추가 설치 검사를 실행하지 않았다.

## 실제 CLI와 반복 조회

기존 터미널 8개가 모두 ready인 상태에서 격리 CODEX_HOME에 동봉 helper를 명시적으로 설치했다. 실제 Codex를 `--no-daemon --no-alt-screen`으로 실행해 fixture의 폴더·훅 trust를 통과하고 도구 사용 없는 `OK` 응답을 받았다. 사용자 홈에서 시작하면 기본 폴더와 사용자 지정 폴더의 훅이 같은 대화에 중복 수신되어 기존 모호성 방어가 snapshot을 거절했다. 리포 경로에서 새 대화를 시작한 후에는 실제 프로세스 귀속의 훅 snapshot이 반환됐다.

포커스 복귀·`get_agent_hook_states(['codex'])`·자동 캐시 조회를 20회 반복했다. 약 33.42초 동안 19개 sample에서 실제 Codex snapshot이 반환됐고, 설치 검사 추가 횟수는 **0회**였다. 조회와 캐시 조회를 합친 sample의 최대 시간은 약 207ms였다. 이 수치는 이벤트 전송 자체의 시간 측정이 아니다. 실제 현재 대화·프로세스 검증은 유지한다.

## 대상 발견과 명시적 검사

- native fixture helper가 실제 dev PTY 환경에서 새 설정 폴더의 SessionStart를 보냈다. 알림 이벤트 직후 backend가 그 폴더만 한 번 검사하고 실제 JSON 파싱 오류를 캐시했다.
- WSL pane에서 동봉 Linux helper로 새 `/mnt/d/.../.tmp/hi-wsl` 폴더의 SessionStart를 보냈다. 실행 중 Ubuntu-22.04에서 이 폴더만 한 번 검사했다. 같은 이벤트 5회와 캐시 조회 10회·포커스 복귀를 반복해도 설치 검사 횟수는 증가하지 않았다.
- 두 fixture 파일의 오류를 EOF에서 다른 파싱 오류로 바꿨다. 자동 조회는 기존 캐시 오류를 유지했다. native 명시적 status는 해당 대상만 한 번 검사하고 새 오류를 반영했다. REST updates 명시적 전체 조회는 알려진 7개 대상을 실제 재검사했다.
- 실제 안내의 ‘나중에’ 버튼을 클릭한 후 캐시 안내를 갱신했다. 오류 결과를 보존하면서 안내는 숨겨졌다. 같은 대상의 문구 변경은 별도 UI 회귀 테스트로도 검증했다.
- 실제 Ubuntu-22.04 fixture의 첫 status를 시간 초과시키는 Rust 테스트에서 제한된 읽기 전용 재시도 1회로 성공했다. 정지 배포판을 자동 시작하지 않는 정책은 검사 실행 횟수를 세는 단위 회귀로 검증했다.

## 출력 부하와 회귀

기존 8개 터미널을 유지하고 결정적 background 4-pane 플러드 벤치에서 각 pane에 150,000행을 흘렸다. final marker·frontier·입력 echo·서비스 간격·catch-up·bridge·diagnostics·스크린샷 기준이 모두 통과했다. 판정은 `acceptance.passed: true`였다.

TDD에서 주기·포커스 검사를 제거하는 UI 회귀 4개가 기존 코드에서 실패했다. Rust의 최초 검사 재사용 회귀는 20회 반복 조회에서 42번 검사하는 기존 방식으로 실패했다. 별도 회귀는 수동 검사가 진행 중일 때 새 대상 알림을 놓치는 경우를 재현했고, 완료 뒤 캐시 조회를 예약하도록 수정했다. 대상 발견·WSL·오류 보관·재검사 무효화·경로 별칭·대화/제목 안전성 테스트를 함께 실행했다.

초기 전체 검증은 UI 5,624개, Rust 2,417개 통과(10개 ignored), 훅 관리 Playwright 1개 통과였다. 후속 큐 수정은 관련 UI 25개와 타입·lint 검사로 확인했다. 관리 결과도 안내 갱신 이벤트를 발행하도록 하여 Settings/REST 관리 후 자동 타이머 없이 캐시 결과를 표시한다. 실제 dev 재기동 뒤 명시적 status의 실패 결과가 별도 갱신 호출 없이 화면 안내에 표시됐고, backend 설치 호출은 그 status 1회뿐이었다. 최종 훅 관련 Rust 테스트 34개도 통과했다. 독립 리뷰 결과는 PR 본문에 기록한다.

원시 증거는 로컬 `.tmp/hook-inspection-once/`의 `dev.log`, `poll.json`, `first-discovery.json`, `wsl-discovery.json`, `repeat-wsl.json`, `manual.json`, `manual-rest.json`, `bench.json`, 각 테스트 로그에 있다. dev 종료에는 `scripts/kill-dev.sh --with-daemon`을 사용한다.
