# Codex 종료·업데이트 확인 오류와 dev 실측

> 후속 수정과 최종 결과: [현재 화면 판독 검증](codex-status-current-screen-repro-2026-09-28.md). 아래 내용은 수정 전 실측 이력이다.

> 이 문서는 최초 오류 개선과 당시 발견한 미해결 항목을 기록한다. 이후 사용자가 제안한 Esc·Backspace·Delete 방식의 실제 결과는 [별도 실측 기록](codex-status-input-repro-2026-09-28.md)을 따른다. 입력 동작의 개선과 새 응답 ID 증거 확보는 구분한다.

- 날짜: 2026-09-28
- 기준: `e734cd93`, `fix/codex-checkpoint-pane-error`
- 대상: dev 19281, health의 worktreeRoot·gitCommit·PID 확인. Windows native 및 Ubuntu-22.04 WSL Codex 0.157.1, 기본 공유 데몬.
- 격리: 별도 APPDATA/WebView 저장소, native `CODEX_HOME=D:/lx-status-928`, WSL `CODEX_HOME=/tmp/laymux-status-repro/codex`. 사용자 release 19280은 조작하지 않았다.
- ADR: [0270](adr/0270-codex-status-checkpoint-probe.md)의 직접 적용. 새 ADR 불필요: 오류 대상 표시와 기존 composer/응답 판정의 버그 수정이며, process 귀속·입력 fence·전체 UUID·rollout 검증·저장 barrier 정책을 바꾸지 않는다.

## 변경과 확인 방법

WSL process 모호성·조회 실패 및 대상별 준비 실패가 terminal ID를 보존하도록 했다. PC 프론트는 현재 workspace/Dock, 공간 순서 pane 번호, title 또는 label/profile로 표시한다. 조회 중 여러 pane이 실패하면 모두 표시하고 작업 수동 종료 후 재시도를 안내한다. `/quit` 뒤 데몬이 남는 경우도 실측되어, 계속 실패하면 해당 pane을 닫으라는 안내를 추가했다. 레이아웃에서 사라진 대상만 원래 ID로 남는다. PC updater의 오류 ACK와 Remote `lastError` 표시 경로를 유지한다.

CDP로 실제 dev WebView가 로드한 `withCodexStatusCheckpoint`를 실행했다. 성공 callback에서는 실제 `getTerminalSessionAttributions`와 `flushSessionCheckpoint({reason:'update',requireConclusive:true})`를 호출했다. 일반 종료 fence를 획득하고 성공·실패 후 `cancelAppClose`로 실측용 fence를 해제했다. 이는 공통 `/status`·저장 경로 검증이며 **설치 프로그램 실행 및 실제 Remote 업데이트 전체 E2E는 아니다**. native update request ID의 fence 연결과 실패 ACK는 별도 회귀 테스트로 확인했다.

각 조회 전·중·후 xterm 셀과 v3 출력 바이트를 수집했다. 좁은 pane은 약 40~41×45에서 96×45로 확장되고 종료 후 원래 크기로 돌아왔다. 성공 시 provider ID와 저장 coverage의 ID가 일치함을 확인했다. 초안 검사는 모델 요청을 제출하지 않았고 대화 영속화에는 `!echo STATUS_REPRO_OK` 로컬 명령을 사용했다.

## 실측 결과

| 시나리오 | 결과 |
| --- | --- |
| 최초 WSL 빈 대화, 수정 전 | `/status` 카드가 그려졌지만 응답 파서가 시간 초과. ANSI 커서 이동을 지우면서 행을 합친 것이 원인 |
| native 초기 sandbox 설정 메뉴, 수정 전 | 선택 행의 `›`를 composer로 오인하여 편집 키가 메뉴로 전달됨. 화면 셀 회귀로 수정 전 실패 확인 |
| native/WSL 빈 대화 동시 조회, 수정 후 | 두 서로 다른 전체 ID를 `fresh`로 검증·저장. 약 10.8초(대상 검색·확인·이중 저장 관측 포함) |
| 이전 status 카드가 남은 상태에서 한 줄 미전송 초안 | 두 환경 모두 초안 제거 후 같은 ID로 검증·저장, 약 11.0초 |
| 로컬 셸 명령으로 영속화된 대화 | 두 환경 모두 원래 ID를 `identified`로 검증·저장, 약 10.2초 |
| `/new` 전환 | native checkout 선택을 수동 완료한 뒤 두 환경 모두 이전과 다른 ID를 `fresh`로 검증·저장, 약 10.6초 |
| native checkout 선택 메뉴 | 편집 키 전송 전에 해당 pane 안내와 함께 거절. WSL의 정상 조회는 끝까지 정리됨 |
| WSL `/model` 메뉴 | 해당 pane 안내와 함께 거절. 메뉴 선택을 제출하지 않음 |
| WSL 로컬 `sleep 20` 실행 중 | `Working (esc to interrupt)`를 보고 편집 키 전송 전에 거절. 해당 pane geometry는 유지됨 |
| 복수 줄 초안, 중간 커서 | **미해결**: native는 `/status` 텍스트만 있고 builtin 메뉴가 선택되지 않아 Enter 전 차단. WSL은 아래의 불완전 차등 카드로 응답 확인 실패 |
| 여러 차례 status 조회로 동일 카드가 쌓인 상태 | **미해결**: 새 출력에서 command/header가 아예 생략되는 차등 repaint는 확정 증거가 부족하여 차단됨 |
| WSL TUI 종료 후 재시작 | 같은 pane marker의 잔존 managed daemon·pid-update-loop와 새 TUI를 관측. 실제 `Ambiguous WSL Codex process` 재현 및 workspace/pane/title 안내 확인 |
| `/quit` 후 재시도 | WSL 데몬이 남아 모호성 지속. 단순 `/quit`이 항상 해결책은 아님 |
| 문제 WSL pane 닫기 후 재시도 | 해당 terminal 제거·EmptyView 전환 후 native shell `noAgent` coverage로 저장 barrier 통과 |

## 파서 수정의 범위와 남은 한계

실제 native/WSL은 CRLF 없이 ANSI CUP로 행을 그리며, 같은 행의 왼쪽 테두리를 재사용해 `>_ OpenAI Codex`만 새로 출력하기도 한다. 수직 cursor sequence의 행 경계를 유지하고, 새 `/status` echo와 카드 상단이 나온 뒤의 해당 헤더 조각을 허용했다. 실제 두 플랫폼의 차등 응답을 `status_probe/fixtures/*-status-repaint.ansi`로 보관하고 세션 UUID를 테스트용 값으로 정규화했다.

아예 새 command/header를 내보내지 않는 repaint에서 과거 화면을 세션 증거로 채택하지 않는다. 이 경우와 복수 줄 초안의 builtin 선택 실패는 여전히 업데이트를 막는다. 따라서 이 검증은 `/status` 경로 전체의 무조건적인 신뢰성을 보증하지 않는다. 잔존 공유 데몬을 TUI와 구분하는 process 귀속 정책도 이번 변경 범위에 포함하지 않는다. 자동 데몬 종료, 임의 후보 선택, 이전 세션 ID fallback을 추가하지 않았다.

## 자동 회귀와 화면 확인

- Rust status probe 테스트 19개 통과. 실제 WSL의 symlink 설정·rollout 검증 테스트 두 개도 `--include-ignored`로 실행했다.
- UI 관련 테스트 42개 통과: pane 이름·공간 번호·Dock·제거된 대상·한영 안내, 시작 전 실패, update 오류 ACK, task teardown 미실행, Remote 표시 경로·생성 번들 일치.
- 실제 xterm screen 테스트 통과: 초기 설정/작업 모달과 오래된 scrollback을 composer/명령 선택으로 오인하지 않음.
- TypeScript 검사, UI production build, 변경 파일 ESLint, Rust strict clippy 통과.
- PC lifecycle dev preview를 Automation API로 열어 screenshot API로 확인했다. 실제 실패 문구를 Remote dialog에도 넣고 390×844 headless 화면에서 가로 넘침 없이 표시됨을 확인했다. Remote transport는 모의 status 입력이며 실제 설치는 수행하지 않았다.
- 상세 JSON과 전·중·후 셀/바이트 기록은 작업 워크트리 `.tmp/result-*.json`, 이미지들은 `.screenshots/`에 있다. 인증 파일은 커밋하지 않는다.
