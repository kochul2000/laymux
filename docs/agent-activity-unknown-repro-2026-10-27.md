# 미관측 activity·전체 sweep 제거 dev 검증

설계: [ADR-0360](adr/0360-unknown-activity-and-event-recovery.md). 기준은 v3.4.2 main `267d71e0b37a3bb7ecb69f734f2376cc4c9ee977`, 검증 코드는 `fix/activity-unknown-no-full-sweep`이다. dev Automation 19281과 CDP 9342만 사용했다. release 19280은 조작하지 않았다.

## 재현과 수정 확인

먼저 fake timer 180초에 전체 task 재조회가 세 번 일어나고, 미설정 activity가 shell로 표시되는 실패를 확인했다. Codex·Grok은 자식 명령의 종료 코드만 받아도 shell로 바뀌는 별도 실패가 나왔다. 프로세스 `Unknown`에서 제목 유래 종료를 보류하는 Rust 테스트도 변경 전 실패했다.

실제 PTY 검증은 `scripts/tests/agent-activity-recovery.e2e.mjs`의 `setup → fault → remote → quiet-exit → unknown → cleanup` 순서로 실행했다. Windows·WSL × Codex·Claude의 격리 프로세스 네 개와 합성 기록을 사용하며 실제 provider API나 사용자 인증 정보를 쓰지 않는다. 최초 전체 검증 뒤 독립 리뷰의 P1을 수정하고 같은 순서를 다시 실행했다. 최종 dev PID는 50880이었다.

- `fault`: 최근 16 KiB에서 제목을 밀어내고 WSL distro를 존재하지 않는 테스트 이름으로 80초간 바꿨다. 30초 뒤 실제 제목 reset도 보내 앱 식별이 유지되는지 확인했다. reset으로 소실된 관리 UUID는 실제 새 제목으로 다시 설정한 뒤 출력으로 다시 밀어냈다. 40개 표본에서 앱 식별을 유지했고, backend 원시 WSL activity는 `unknown`이었다. distro 복구 후 추가 제목 없이 같은 Codex 대화·완료 턴을 다시 조회했다. `finally`에서 distro를 복구한다.
- `remote`: 실제 Edge Remote drawer에 네 provider 행이 표시되고 host 상태와 일치했다. 테스트 lease와 Remote 설정은 원복했다.
- `quiet-exit`: 65초 동안 `onTaskStateRefresh` 요청 0개, 네 pane의 activitySequence 변경 0개였다. 각 실제 프로세스에 exit를 보내고 frontend shell 복귀를 500ms 간격으로 측정했다.

| 환경 | 앱 | 입력 요청부터 shell 확인까지 |
| --- | --- | ---: |
| Windows | Codex | 519ms |
| Windows | Claude | 527ms |
| WSL | Codex | 2551ms |
| WSL | Claude | 3073ms |

이 값은 격리 재현의 표본이며 모든 환경의 최대 지연 보장은 아니다. 3초 생존 감지·WSL 패스 예산은 유지한다. 확인된 부재가 과거 앱 제목·배너·grace보다 우선하는 것은 별도 Rust 테스트로 고정했다.

- `unknown`: 지원 에이전트가 아닌 별도 Windows 프로세스에 출력을 흘려 lifecycle 근거를 최근 버퍼에서 제거했다. backend·frontend·selectorDisplay 모두 unknown이었다. 실제 clear API는 `cleared: []`, `skipped[].reason: stateUnknown`을 반환했다. 해당 프로세스 종료 뒤 관측된 셸 프롬프트로 shell 복귀를 확인했다.
- 같은 단계에서 backend가 이미 unknown인 프로세스에 실제 늦은 `Claude Code` 제목을 보내 frontend가 Claude로 바뀐 것을 store 구독으로 확인했다. backend의 activity 값은 그대로 unknown이지만 새 관측 sequence가 해당 pane만 보정해 2588ms 뒤 unknown으로 복귀했다. 다른 pane의 activitySequence는 변하지 않았다. 이는 전체 타이머 제거 뒤 남을 수 있는 영구 drift에 대한 독립 리뷰 P1의 재현과 수정 검증이다. frontend의 다른 앱을 부르는 자식 명령·낡은 command stamp도 실패 테스트를 먼저 확인하고 수정했다.
- 화면: dev screenshot API의 `unknown.png`, `shell-return.png`와 실제 Remote의 `remote.png`를 확인했다. 격리 workspace를 지우고 원 workspace로 복귀한 뒤 `bash scripts/kill-dev.sh`로 dev GUI를 종료했다.

## 자동 검증과 기존 실패 구분

- Rust 전체: P1 보완 후 2710 통과, 12 ignored. `cargo clippy --lib --tests -- -D warnings` 통과.
- UI: SettingsView를 제외한 294개 파일·5721개 테스트 통과. P1 보완 뒤 변경 관련 6개 파일·447개 테스트, TypeScript·ESLint·Prettier·production 빌드 통과. 전체 실행에는 production bundle 테스트도 포함한다.
- 별도 `SettingsView.test.tsx`는 193개 assertion이 통과하지만 `AgentHooksSection.tsx:106`의 모킹되지 않은 installation 응답에서 비동기 오류 4건이 남는다. 같은 main SHA의 임시 독립 worktree에서도 193 통과·동일 오류 4건을 재현했으며 이번 수정 파일 밖이다. 최초 동시 전체 실행의 5초 부하 timeout은 worker 수를 줄인 독립 재실행에서 통과했다.
- 한 전체 Rust 실행에서 Android pairing의 초 경계 비교가 1초 차이로 실패했지만 단독 재실행과 이후 전체 실행은 통과했다. 이번 변경으로 테스트의 시간 조건을 완화하지 않았다.

실행 로그·JSON·화면은 gitignore된 `.screenshots/agent-state-20261027/` 아래에 있다. `dev-e2e/context.json`, `fault-timeline.json`, `quiet-exit.json`, `unknown.json`이 마지막 실행의 증거다. 테스트는 fake distro와 workspace를 소유 범위 안에서 복구한다.
