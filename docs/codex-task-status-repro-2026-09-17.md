# Codex 진행·빈 입력창 상태 재현

2026-09-17, Windows dev(19281), `fix/codex-live-task-status`, 기준 HEAD `fd505bf21fdc95a0c0e635314364125b8367fc99`와 이 브랜치의 변경을 검증했다. health의 `worktreeRoot`는 `D:\PycharmProjects\laymux`, 실행 파일은 해당 워크트리의 `target/debug/laymux.exe`였다. APPDATA와 WebView 저장소는 `.tmp/codex-live-task-20260917/` 아래로 격리했다.

Windows PowerShell의 Codex와 WSL Linux Codex 모두 0.154.0, 모델은 `gpt-6-astra high`다. 실제 PTY에 요청을 제출하고 Codex 턴 IPC, 공통 task, Automation `selectorStatus`, 실제 xterm 셀과 dev 스크린샷을 대조했다. OS 물리 키 입력은 사용하지 않았다.

## 수정 전 확인한 두 경로

| 조건 | 실제 관측 | 잘못된 표시의 원인 |
| --- | --- | --- |
| WSL Astra의 새 빈 입력창 | backend `idle`, task `idle/confirmed`, `outputActive=true` | 공통 아이콘 함수가 확인된 idle도 출력 fallback에 넣어 모래시계로 바꿈 |
| Windows의 완료 뒤 새 30초 도구 요청, 조회마다 7초 지연 주입 | backend는 새 턴의 `running`, xterm은 `Working (23s)`인데 task는 이전 턴의 `ended/success/stale` | 6초 뒤 돌아오는 정상 조회까지 폐기해 다음 조회도 복구할 수 없음 |

WSL의 기존 표시 테스트도 `idle + outputActive`를 모래시계로 기대하고 있었다. 두 경로의 회귀 테스트를 먼저 실패시킨 뒤 구현을 수정했다.

Windows 일반 속도의 연속 요청은 수정 전에도 정상 진행을 표시했다. **사용자 release에서 발생한 순간의 조회 지연은 측정하지 않았다.** 지연 경로가 제보의 유일한 원인이라고 주장하지 않는다.

## 지연 실기

1. native pane에서 도구 없는 단답 요청을 완료해 이전 성공 상태를 만든다. WSL pane은 새 빈 Astra 입력창으로 둔다.
2. 격리된 dev WebView의 CDP에서 Vite의 `tauri-api.ts` 모듈 응답만 가로채 `getCodexTurnStates`의 실제 IPC 호출 전에 7초 대기를 삽입한다. 상태값·턴 기록·store는 합성하지 않는다.
3. native에 파일 접근 없이 `Start-Sleep -Seconds 30`을 실행한 뒤 답하도록 요청한다. 본문과 단독 CR을 별도 write로 보낸다.
4. 공통 task와 xterm 셀을 500ms마다 55초간 수집하고, 작업 중 별도의 실제 턴 조회 및 dev 스크린샷과 대조한다.

수정 전에는 55초 동안 이전 성공 표시를 벗어나지 못했다. 수정 후에는 제출 약 8.065초에 새 턴의 `running/confirmed`와 모래시계로 복구했다. 이후 조회가 매번 지연되어 `confirmed↔stale`로 바뀌어도 진행 아이콘을 유지했고, 실제 완료 뒤 약 44.586초에 `ended/success/confirmed`와 체크로 전환했다. 별도 IPC 호출의 실측 소요 시간은 8.133초였다. WSL은 출력 활동이 계속되어도 `idle`과 대시를 유지했다.

지연 주입은 저장소 코드에 남기지 않았다. 이후 WebView를 다시 로드해 주입한 모듈을 제거하고, 새 PTY generation에서 일반 속도 검증을 수행했다.

## 일반 속도 실기 결과

| 시나리오 | Windows | WSL |
| --- | --- | --- |
| 저장 후 WebView 재로딩 | 같은 완료 대화 복원, 새 generation에서 `ended/success/confirmed`, 체크 | 새 빈 Astra 대화 복원, `idle/confirmed + outputActive=true`, 대시 |
| 실제 도구 요청 | `Start-Sleep -Seconds 30`; 약 2.526초부터 진행, 약 44.303초에 완료 | `sleep 20`; 약 2.525초부터 진행, 약 35.247초에 완료 |
| 완료 뒤 다음 요청, 실행 중 중단 | `Start-Sleep -Seconds 60` 요청 후 20초에 ESC; 약 22.161초에 `ended/interrupted`, 대시 | `sleep 60` 요청 후 20초에 ESC; 약 22.160초에 `ended/interrupted`, 대시 |
| `/status` 로컬 명령 | 같은 중단 turnId·결과 유지, 새 작업·알림 없음 | 같은 중단 turnId·결과 유지, 새 작업·알림 없음 |
| `/clear` | generation 유지, 새 sessionId·selectionKey의 `idle/confirmed`, 대시 | generation 유지, 새 sessionId·selectionKey의 `idle/confirmed + outputActive=true`, 대시 |

일반 도구 요청과 중단 요청은 각 55초간 500ms 간격으로 수집했다. 실제 xterm의 진행·답변·중단 문구와 표시가 일치했다. Automation 조회의 `selectorStatus`도 공통 task와 일치했다. 일반 요청의 성공 알림과 중단 알림은 pane당 각각 한 번만 발생했고, `/status`·`/clear` 이후에도 총 4개로 유지됐다.

WSL의 `/clear` 직후부터 추가 55초를 관찰했다. 약 10.144초에 새 세션의 `idle`을 확인했으며, 관측 전의 이전 중단 상태와 이후 유휴 상태 모두 출력 애니메이션이 있어도 대시를 유지했다. 따라서 세션 전환이 즉시 관측된다는 의미는 아니다. 저장한 정상 작업 3개·중단 2개 trace, 수정 전 지연 실패 trace, 마지막 유휴·Automation 투영·알림 개수는 `verify-evidence.mjs`의 assertion으로도 확인했다.

`/clear` 후 native Codex는 저장된 기본 모델 `gpt-5.6-sol high`로 돌아갔고 WSL은 Astra를 유지했다. 따라서 이 단계의 native 빈 입력창을 Astra 실측으로 기록하지 않는다. 앞의 실행·중단과 최초 빈 WSL 입력창은 Astra에서 검증했다.

## 자동 검증과 리뷰

- Windows `ui/`에서 `npx vitest run --maxWorkers=4`: 238파일, 4,987개 통과.
- `npm run build`: TypeScript 검사와 프로덕션 빌드 통과. `npm run build:remote-page` 후 생성 산출물 일치 검사도 전체 테스트에서 통과했다.
- 변경한 TypeScript 5파일의 ESLint·Prettier와 `git diff --check` 통과. 최종 Remote 산출물을 포함해 dev Rust 빌드도 성공했다.
- 독립 서브에이전트 리뷰 2회: 1차의 P3 문서 불일치를 수정했고, 2차는 유효한 코드 지적 없음. 두 리뷰 모두 P1·P2 런타임 결함을 발견하지 못했다.

로컬 재현 자료는 `.tmp/codex-live-task-20260917/`의 `probe.mjs`, `sample-*.json`, `watch-*.json`, `watch-interrupt-*.json`, `verify-evidence.mjs`, `verification-summary.json`에 남겼다. 수정 전 Windows 지연 표시는 `.screenshots/screenshot_1789638421975.png`, 수정 후 같은 조건은 `screenshot_1789639069371.png`, 일반 동시 작업은 `screenshot_1789639209019.png`, 양쪽 중단은 `screenshot_1789639330425.png`, 새 빈 대화는 `screenshot_1789639393632.png`다. 이 파일들은 로컬 자료이며 git에는 포함하지 않는다.

## 검증 범위와 남는 한계

- 6초 지연 판정은 유지한다. 이번 변경은 정상 응답을 영구히 버리던 경로를 복구하며, 조회 자체의 지연이나 영원히 반환하지 않는 I/O를 해결하지 않는다.
- 시작·복원 직후 프로세스/세션 귀속이 아직 `unknown`이면 기존 출력 fallback이 남는다. 이번 실기에서도 초기 미식별 이후 `idle/confirmed`로 복구하는 구간이 있었다. 미확인을 유휴나 성공으로 합성하지 않는다.
- Desktop·Remote의 공통 표시 테스트와 Codex 조회→store→selector 회귀 테스트를 실행했다. Remote 생성 번들도 갱신했다.
- 앱·입력·PTY generation·등록 교체·구독 종료 후 늦은 응답 차단과 완료 알림 중복 방지는 자동 테스트 및 두 번의 독립 서브에이전트 리뷰로 확인했다.

ADR: [0254 — 확인된 작업 없음의 표시 우선순위](adr/0254-confirmed-idle-before-output-activity.md), [0255 — 지연된 Codex 관측 복구](adr/0255-codex-delayed-observation-recovery.md).

## 2026-09-18 일반 셸 추가 실기

같은 격리 dev에서 에이전트가 없는 PowerShell·WSL Bash·CMD pane을 별도로 열었다. `activity`는 세 pane 모두 shell로 식별됐다. `activity` 필드 자체가 없는 조합은 공통 Desktop/Remote 표시 함수의 자동 테스트로 확인했으며 실제 셸 측정과 구분한다.

| 조건 | 실제 결과 |
| --- | --- |
| WSL `echo SHELL_START; sleep 8; echo SHELL_DONE` | `outputActive=false`인 대기 중에도 running/⏳, 종료 후 success/✓ |
| WSL `echo FAIL_START; sleep 8; (exit 7)` | 대기 중 running/⏳, 종료 후 failure/✗; 20초 대기도 동일 |
| CMD의 출력 없는 `ping -n 9 127.0.0.1 >nul` | task 미확인·출력 false·대시 유지, 성공/진행을 합성하지 않음 |
| CMD 안의 `powershell.exe -NoProfile`에서 4초간 4KiB 줄을 50ms마다 출력 후 5초 대기 | task는 계속 미확인, 출력 중 약 1.260초에 ⏳, 출력이 멎고 약 7.220초에 대시; 그때도 프로세스는 아직 대기 중 |
| PowerShell 첫 8초 명령 | 시작 관측 없이 대시, 실제 프롬프트 복귀 때 success/✓ |
| PowerShell 다음 8초·20초 명령 | **작업 중에도 이전 success/✓가 유지되는 기존 한계 확인** |

PowerShell은 현재 통합에서 OSC 133 D만 보내고 C/E를 보내지 않는다. 이번 변경의 idle 분기나 Codex 구독을 거치지 않는 기존 ended 표시이므로 새 회귀로 분류하지 않았다. 시작 신호의 소유권과 부분 통합 셸의 표시·보호 정책을 결정해야 하는 별도 ADR 범위로 [#1058](https://github.com/kochul2000/laymux/issues/1058)에 기록했다. 따라서 일반 셸 전체가 정상이라고 보고하지 않는다.

자료는 같은 로컬 디렉터리의 `shell-probe.mjs`, `shell-run-windows-1789659029696.json`, `shell-run-wsl-1789659029697.json`, `shell-run-raw-1789659031742.json`이다. `.screenshots/screenshot_1789659020095.png`는 실행 중 세 pane의 화면이다. PowerShell은 `SECOND_START` 뒤 프롬프트가 없는데 ✓, WSL은 출력 없는 sleep 중 ⏳, CMD는 출력 중 ⏳인 상태를 동시에 캡처했다.

추가 회귀 테스트 후 전체 UI 238파일·4,989개가 통과했다. 선택기 Playwright E2E는 현재의 2회 클릭 숨기기 확인을 반영하도록 낡은 테스트 절차를 수정한 뒤 15개가 통과했다. 이는 제품의 숨기기 동작을 변경한 것이 아니다. 릴리즈 채널 검증도 통과했으며 v1.0.6의 Cargo·Tauri·lockfile 버전을 일치시켰다. 기존 릴리즈 계약을 적용한 버전 갱신과 E2E 절차 보정에는 별도 ADR이 필요하지 않다.
