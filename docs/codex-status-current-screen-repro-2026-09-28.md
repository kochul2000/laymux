# Codex 현재 화면 판독과 최종 저장 dev 검증

- 날짜: 2026-09-28
- 요청: 새로 출력되는 바이트에 Session 행이 없더라도 현재 화면에 보이는 전체 ID를 읽어 종료·업데이트 복원점을 확인한다.
- ADR: [0278 — Codex 종료 확인은 명령 실행 후 현재 화면을 읽는다](adr/0278-codex-status-current-screen.md).
- 환경: `fix/codex-checkpoint-pane-error`, `e734cd93` 기반 작업 트리의 dev 19281. health로 dev 빌드·작업 트리·PID를 확인했다. Windows native PowerShell과 Ubuntu-22.04 WSL에 격리한 CODEX_HOME을 사용했다. 실제 TUI는 양쪽 모두 Codex 0.157.1이며, 테스트 중 격리된 background server는 0.158.0으로 갱신됐다.

## 원인과 변경

반복 `/status`는 화면에 완전한 카드를 표시하면서도 바뀐 셀만 출력한다. 이전 구현은 Enter 이후 바이트에서 명령 echo·헤더·Session 행을 모두 요구했기 때문에 정상 화면을 실패로 판정했다. [이전 입력 실측](codex-status-input-repro-2026-09-28.md)의 실패는 Codex 명령의 실패가 아니라 Laymux 판독의 실패다.

제품은 이제 기존 rendererless xterm checkpoint 모델이 누적한 현재 화면을 읽는다. `/status` builtin 선택을 확인하고 Enter를 한 번 보낸 다음, 제출 경계를 지난 화면이 180ms 동안 안정되면 generation·출력 sequence·geometry와 함께 backend로 전달한다. backend는 현재 활성 버퍼의 마지막 `/status` 카드에서 전체 UUID를 읽는다. 미완성 카드, 오래된 화면, 세대·크기 변경은 확정하지 않는다. rollout·Fresh 검증과 최종 저장의 기존 입력 fence는 유지한다.

초안은 Backspace와 Delete를 128쌍씩 보내며 실제 빈 입력창을 확인한다. 최대 32회와 기존 제한 시간을 적용한다. `/model`·`/permissions` 메뉴는 화면을 확인한 뒤 Esc 한 번으로 닫는다. `/mod` 선택 팝업은 문자 삭제로 닫힌다. 화면 기록을 지우는 Ctrl+L은 사용하지 않는다.

## 측정 경로

실제 dev WebView에서 제품 `withCodexStatusCheckpoint`를 호출했다. `beginAppClose`로 입력 fence를 열고, 대상 확인·입력·현재 화면 판독 후 실제 `flushSessionCheckpoint({reason: 'update', requireConclusive: true})`를 실행했다. 반환된 각 pane의 proof ID와 저장된 coverage ID가 같고 `checkpointCommitId > 0`인지를 검사했다. 완료 후 제품의 토큰 정리와 `cancelAppClose`를 실행해 dev를 유지했다.

하니스는 기존 화면 provider를 감싸 전달된 snapshot을 기록했다. 판독 결과나 저장 IPC를 성공으로 대체하지 않았다. PTY 원시 출력도 수집해 submit 경계 이후의 바이트와 화면 판독을 대조했다. 작은 pane은 제품 경로가 최소 96×40으로 확장하며, 이번 측정은 96×45에서 판독한 뒤 원래 41×45로 복구했다.

아래 표는 최종 128쌍 삭제 코드로 완료한 **17개 시나리오 × 두 플랫폼 = 34개 pane 검증**이다. 시간은 두 pane 확인과 critical checkpoint 저장을 포함한 하니스 한 번의 경과 시간이며, `/status` 명령만의 응답 시간이 아니다. 표의 순서는 시나리오 분류이며 실행 순서를 뜻하지 않는다.

| 시나리오 | Windows native | WSL | 경과 시간 | 저장 commit |
| --- | --- | --- | --- | --- |
| 빈 입력창 연속 조회 1 | 통과 | 통과 | 11,803ms | 11 |
| 빈 입력창 연속 조회 2 | 통과 | 통과 | 11,936ms | 12 |
| 빈 입력창 연속 조회 3 | 통과 | 통과 | 11,913ms | 13 |
| 빈 입력창 연속 조회 4 | 통과 | 통과 | 11,771ms | 14 |
| 빈 입력창 연속 조회 5 | 통과 | 통과 | 11,595ms | 15 |
| 3줄 초안, 커서 처음 | 통과 | 통과 | 12,716ms | 16 |
| 3줄 초안, 커서 중간 | 통과 | 통과 | 13,181ms | 17 |
| 3줄 초안, 커서 끝 | 통과 | 통과 | 12,604ms | 18 |
| 중간·끝에 빈 줄이 있는 초안 | 통과 | 통과 | 12,235ms | 19 |
| 한글·이모지·자동 줄바꿈 초안 | 통과 | 통과 | 12,890ms | 3 |
| 100줄 붙여넣기 | 통과 | 통과 | 12,734ms | 4 |
| `/model` 메뉴 | 통과 | 통과 | 13,288ms | 5 |
| `/permissions` 메뉴 | 통과 | 통과 | 13,174ms | 6 |
| `/mod` 슬래시 선택 팝업 | 통과 | 통과 | 12,775ms | 7 |
| 로컬 명령으로 rollout이 생긴 대화 | 통과 | 통과 | 11,537ms | 8 |
| `/new`로 바뀐 새 대화 | 통과 | 통과 | 12,042ms | 10 |
| 이전 대화 ID로 재개 | 통과 | 통과 | 11,857ms | 23 |

100줄 붙여넣기는 Codex가 축약해서 표시하는 paste 요소의 삭제다. 수동으로 입력한 100줄의 삭제 성능으로 일반화하지 않는다. 한글 사례는 `한글🙂` 65회 반복을 포함한 세 줄이며 커서를 중간에 두었다. 초기 16쌍 구현에서는 이 사례가 입력 준비 제한 시간에 걸렸고, 128쌍으로 조정한 최종 코드에서 위 결과를 확인했다.

### 새 출력에 ID가 없는 반복 조회

연속 조회 2~5에서 Enter 이후의 새 출력에는 양쪽 모두 `Session:` 행이 없었다. 그래도 현재 화면에서 같은 전체 UUID를 확인하고 저장했다.

| 조회 | native 새 출력 | WSL 새 출력 | 양쪽 새 Session 행 | 현재 화면 판독·저장 |
| --- | --- | --- | --- | --- |
| 2 | 692바이트 | 734바이트 | 없음 | 통과 |
| 3 | 692바이트 | 734바이트 | 없음 | 통과 |
| 4 | 731바이트 | 734바이트 | 없음 | 통과 |
| 5 | 692바이트 | 777바이트 | 없음 | 통과 |

### 새 대화와 재개 ID

`!echo CHECKPOINT_SCREEN_TEST`로 모델 요청 없이 영속 대화를 만들고, `/new`에서 이전 ID와 다른 Fresh ID를 얻는지 검사했다. 이후 원래 ID로 `codex resume`한 뒤 `identified` 판정과 저장 ID 일치를 확인했다. native의 `/new`가 표시한 checkout 선택 메뉴는 테스트 준비에서 Current checkout을 선택했다. 제품 probe가 이 메뉴를 자동으로 승인하는 것은 아니다.

| 플랫폼 | 영속 대화 및 재개 ID | `/new`의 Fresh ID |
| --- | --- | --- |
| native | `01a0e6d9-1a09-7441-b671-ce00129ff05c` | `01a0e6de-2e0a-7cb0-84b7-1cfe5c66c4de` |
| WSL | `01a0e6d9-1af3-76e0-b5d5-303c7bded7c2` | `01a0e6dc-a8c8-70e2-9698-e23c862538f2` |

재개 검증 도중 테스트 CODEX_HOME에 남은 WSL 프로세스 때문에 실제 `Ambiguous WSL Codex process`도 발생했다. 제품 오류에는 `[Status-검증 · pane 2 · work]`와 다음 안내가 포함됐다: “표시된 pane의 작업을 수동으로 종료한 뒤 다시 시도하세요. 같은 오류가 계속되면 해당 pane을 닫고 다시 시도하세요.” 격리한 테스트 프로세스를 정리한 뒤 표의 재개 검증이 통과했다. 모호한 프로세스를 임의로 고르는 정책으로 변경하지 않았다.

재개 검증 뒤 dev 창을 넓혀 찍은 실제 화면에는 위 두 영속 대화의 전체 ID가 보인다. 캡처는 작업 트리의 `.screenshots/screenshot_1790580378688.png`에 보관했다. 합성 모달이나 재구성한 이미지를 증거로 사용하지 않았다.

## 자동 회귀 검증

- Rust `cargo test --lib status_probe -- --include-ignored`: 23개 통과. 실제 WSL 검사와 현재 화면 parser·세대·sequence·크기·범위 검증을 포함한다.
- UI 관련 네 파일: 34개 통과. 명령 선택, 입력창·메뉴 가드, 판독 후 저장, 한 번만 제출, 오류의 pane 위치와 수동 종료 안내를 검증한다.
- 별도 screen 스위트 관련 두 파일: 5개 통과. 실제 xterm에 선택 화면과 차분 출력 fixture를 흘려 새 바이트에 없는 ID가 현재 화면에 유지됨을 확인한다.
- production/remote 번들 두 파일: 10개 통과. `npm run build`, 변경 TS 파일의 ESLint, workspace/all-targets Clippy도 통과했다.

실측에서 Codex가 alternate buffer를 사용한다는 점을 확인했고, 실제 serialized checkpoint를 Rust fixture로 추가했다. 이전 raw-only parser는 비교용 테스트 모듈로만 남겼다. 현재 카드 파서는 마지막 응답이 불완전할 때 더 오래된 카드로 돌아가지 않는 회귀 검증을 갖는다.

## 증거 파일과 검증 범위

- 작업 트리의 `.tmp/screen-result-*.json`: dev 신원, provider snapshot, PTY 바이트, 확인 결과와 저장 결과.
- `.tmp/current-screen-summary.json`: 위 17개 결과의 재검증 요약. `.tmp/summarize-current-screen.mjs`가 저장 ID 일치와 새 대화·재개 ID를 다시 assert한다.
- `.tmp/screen-result-resume-ambiguous.json`: 실제 WSL 모호성 오류.
- `.tmp/current-screen-suite.mjs`, `.tmp/run-screen-once.mjs`, `.tmp/probe-screen-diagnostic.mjs`: 입력 준비와 제품 경로 실행 하니스.
- `src-tauri/src/commands/codex_session/status_probe/fixtures/`: 커밋 가능한 native/WSL 차분 출력·현재 화면 회귀 fixture.

이번 검증은 실제 dev의 종료 입력 fence, Codex 대화 확인, critical checkpoint 저장까지다. Remote 브라우저의 업데이트 클릭부터 설치 프로그램 실행까지의 전체 E2E나 모든 Codex 버전·사용자 키맵을 검증했다는 뜻은 아니다. 실행 중 작업, 첨부, Vim, 미지원 모달은 기존 정책대로 자동 진행하지 않는다. release 19280과 사용자 Codex 설정·훅은 변경하지 않았다.
