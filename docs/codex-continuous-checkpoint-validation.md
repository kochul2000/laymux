# Codex 연속 복원점과 종료 검증 시나리오

기준: [ADR-0295](adr/0295-codex-continuous-conversation-checkpoint.md), [ADR-0296](adr/0296-committed-checkpoint-reuse-on-finalization.md). 실제 dev는 포트 19281과 health의 worktreeRoot를 확인하고 격리한 APPDATA/CODEX_HOME을 사용했다. 자동 테스트와 실제 dev에서 확인한 범위를 구분한다.

| ID | 조건·예외 | 기대 결과 | 검증 계층 | 상태 |
|---|---|---|---|---|
| C01 | native 훅 대화, 작업 완료·장기 idle | 일반 저장에 정확한 ID, 종료 입력 0회 | Rust + dev | 통과: Stop 수신 뒤 디스크 ID 확인 |
| C02 | WSL 훅 귀속과 사용자 지정 Codex 홈 | 배포판·저장소를 유지해 저장 | Rust + dev | 자동 통과; 실제 WSL custom home의 fallback·resume 저장 통과 |
| C03 | 빈 새 대화, 설정만 변경, 파일 없는 훅 ID | lifecycle 증거만 Fresh, 누락 파일을 새 대화로 오인하지 않음 | Rust + UI | 자동 통과 |
| C04 | 앱 재시작 후 resume, 시작 훅·TUI 진단 미수신 | 실제 실행 요청·현재 제목·rollout으로 확인, 초안 유지 | Rust + dev | 통과: native·WSL 새 훅 없는 resume |
| C05 | 같은 CWD의 여러 pane·공유 서버 | pane별 정확한 대화, 중복 소유권 거절 | Rust + dev | 자동 통과; 같은 프로젝트의 native·WSL 두 ID 실기 통과 |
| C06 | 축약 제목 충돌, 다른 홈·배포판 | 유일한 대화로 추정하지 않음 | Rust | 자동 통과 |
| C07 | 늦은 훅, subagent, SessionEnd, 레지스트리 퇴출 | 과거/보조 훅을 현재 대화 증거로 채택하지 않음 | Rust | 자동 통과 |
| C08 | `/new`·`/resume`, I/O 중 제목 전환·ABA | 이전 관측 폐기, 최신 대화만 저장 | Rust + UI | 자동 통과; 실제 resume의 미수신 경계도 확인 |
| C09 | PTY 교체, PID 재사용, 프로세스 종료 | 이전 generation·process incarnation 증거 거절 | Rust | 자동 통과 |
| C10 | DB 읽기 실패·잠금·손상, rollout 누락·중복·보조 역할 | Unknown/미식별을 성공으로 합성하지 않음 | Rust + WSL 실기 fixture | 자동 통과; guest 권한·symlink 실패 5개 실기 통과 |
| C11 | 숨긴 workspace·dock·미진입 pane·resume 초기화 | 기존 소유권과 미소비 복원점 유지 | UI + Rust | 자동 통과 |
| C12 | 훅 설치 제거·검사 지연, 이미 확인한 대화 | 현재 대화 증거로 저장, 설치 helper 재실행 0회 | Rust + dev | 통과: native·WSL 설치 제거 전후 동일 ID·입력 대상 없음 |
| C13 | 작업 중·승인 대기·초안·좁은 pane | 증명된 대화에는 입력·리사이즈 없음 | UI + dev | 자동 통과; 실제 좁은 두 pane 초안·geometry 보존 |
| C14 | 증거 없는 pane, 휴리스틱 모드, 새 status 행·줄바꿈 | `/status` 검증과 실패 처리 유지 | UI + 화면 + Rust + dev | 통과: 실제 0.160.1 Server 행의 timeout 재현→수정, WSL fallback 저장 |
| C15 | 저장 힌트 폭주, 저장 도중 새 힌트, 종료와 동시 요청 | single-flight, 후속 저장, fence 유지·해제 | UI + Rust | 자동 통과; 실제 훅의 일반 저장 확인 |
| C16 | settings 쓰기 실패, 오래 걸린 저장, 저장 중 상태 변경 | 기존 원자성·실패 전파·revision 보호 | UI + Rust | 자동 통과 |
| C17 | 일반 종료·업데이트 준비·완전한 앱 재기동 | 디스크 ID로 새 프로세스에서 같은 대화 복원 | UI + dev | 종료 준비·완전 재기동 통과; update barrier는 자동 테스트 |
| C18 | 정상 pane과 WSL 실패 pane 혼재·CPU 부하 | 정상 자동 저장 유지, critical 실패 원인 구분 | Rust + UI + dev | 자동 통과; WSL timeout 시 Unknown과 기존 ID 보존 확인 |
| C19 | timeout·취소·늦은 응답·중복 Enter | 입력 fence 회수, 늦은 입력 금지 | UI + Rust + dev | 자동 통과; 실패 후 입력·재시도 실기 통과 |
| C20 | 여러 pane의 정상 종료 | 전체 조회를 pane 수만큼 중첩하지 않음 | Rust + dev 측정 | 8-pane 증거 batch·16-pane native 열거 1회 통과; 실제 두 pane 종료 준비 6.271초 |
| C21 | 저장 완료 후 상태·파일 변경 없음 | receipt 재사용, WSL/DB/status/중복 저장 생략, 기록 저장 유지 | Rust + UI + dev | 자동 통과; 실기 측정은 실행 기록 참조 |
| C22 | 저장 후 인간 입력·제목·CWD·힌트·PTY·settings·rollout 변경 | receipt 무효화, 기존 검증으로 fallback | Rust + UI + dev | 자동 통과; 실기 입력 무효화는 실행 기록 참조 |
| C23 | 실패·부분·중복·과거 capture·위조 token·재기동 | 재사용 거절, 과거 저장 성공으로 오인하지 않음 | Rust + UI | 자동 통과 |
| C24 | Codex와 idle 셸 혼재, 셸 명령 실행, 다른 provider | 확인된 idle 셸만 허용; 실행 중인 명령·미식별 provider는 거절 | Rust + dev | 자동 통과; native·WSL Codex와 PowerShell idle 셸 혼재 실기 재사용 6ms |
| C25 | 터미널 protocol reply·resize | 인간 입력 revision을 변경하지 않음 | Rust | 자동 통과 |
| C26 | `/status` 새 필드·순서·누락·중복 필드·메타데이터 줄바꿈 | 부가 필드에 독립적으로 유일한 전체 Session UUID 확인 | Rust + 실제 xterm | 자동 통과; 중복 Session·잘린 UUID·모달·과거 카드 거절 유지 |

실제 PC 전원 차단은 이 환경의 다른 작업에 영향을 주므로 자동 실행하지 않는다. 프로세스를 완전히 종료한 뒤 메모리 상태 없이 같은 격리 프로파일을 기동하는 검증으로 디스크 복원 경계를 확인하며, 실제 OS 재부팅 여부는 별도 기록한다.

## 실행 기록

- 조사 시작: main `df70682eca376fcb3712ba154f866d2d7604971e`, 독립 작업 트리 `laymux-codex-checkpoint-hook-latency`.
- Codex 0.160.1의 실제 `/status` 화면에서 `Server: Local background server` 행을 기존 parser가 거부하는 것을 재현했다. 익명화한 실제 render checkpoint fixture를 Rust parser와 실제 xterm 테스트가 공유한다.
- TDD: 일반 훅 귀속, native 종료/provider 전환, 설치 검사 의존 제거, 조회 중 token 만료, 저장 힌트, 실제 Server 행·정렬된 줄바꿈, native batch 열거·WSL 캐시 경계, 새 훅 없는 resume에 대해 변경 전 실패를 확인하고 수정 후 통과시켰다.
- 전체 UI 단위 테스트: 257개 파일 / 5,307개 테스트 통과. 화면 테스트: 15개 파일 / 106개 통과. Playwright: 533개 통과. `tsc --noEmit`, 엄격한 `cargo clippy --workspace --all-targets -- -D warnings`, `cargo check --release` 통과.
- 최종 library 전체: 2,236개 통과, 0개 실패, 10개 환경 의존 테스트 제외. 이 중 실제 WSL 설정·rollout fixture 5개는 `--ignored`로 별도 실행해 통과했다. 프로세스 환경 테스트의 시작 경합은 자식의 준비 완료 출력으로 동기화했다. 전체 workspace 빌드의 초기 병렬 실행에서 Windows paging file 부족(OS 1455)이 발생하여 `cargo test --workspace -j 2`로 동시 빌드 수를 제한해 다시 검증했다.
- 실제 resume 검증: native·WSL 모두 신규 훅 없이 ID 확인, 디스크 commit, 초안과 geometry 보존, 입력 IPC 거절, 훅 제거 후 동일 증거, 휴리스틱 모드의 fallback 대상 유지. 스크립트 전체 검증 구간 8.629초에는 추가 조회·거절 확인·이중 저장 관측이 포함되어 종료 시간과 구분한다.
- 실제 `saveBeforeClose`: 두 pane의 critical 저장과 터미널 기록 저장 완료, 6.271초. 앱 PID `102292`를 완전히 종료하고 같은 디스크 프로파일을 재기동했다. 새 PID `100640`에서 native `01a111dc-0a14-74b3-a063-27c56aa4d838`, WSL `01a111da-9f5d-79f3-97dd-b86003f3fdff` 대화와 디스크 ID가 모두 일치했다. 중간에 ID를 다시 주입하지 않았다.
- WSL에서 격리 dev 실행 파일의 Windows 호스트 HTTP 연결이 timeout되는 환경을 확인했다. WSL 실기의 최초 대화는 fallback으로, 재기동 대화는 검증된 resume·live 제목·rollout으로 확인했다. WSL 훅 전송 자체의 성공을 주장하지 않는다. 컴파일 부하 중 WSL process/DB probe timeout은 Unknown으로 남기고 기존 복원 ID를 보존했다.
- 저장 완료 receipt 실기: native·WSL 두 pane의 `begin_codex_status_checkpoint` 재사용 판정 14ms, 입력 후 receipt 무효화와 새 commit 발행 통과. 이후 실제 `saveBeforeClose`의 기록 저장 포함 전체 준비 23ms(기존 반복 조회 6.271초). PID `83364` 완전 종료 뒤 새 PID `37412`에서 두 live 대화와 디스크 ID 일치. 중간 재주입 없이 같은 격리 프로파일로 확인했다. 이후 PowerShell idle 셸을 추가한 3-pane catalog에서도 재사용 판정 6ms·입력 후 무효화 통과.
- 최종 screenshot: `.screenshots/screenshot_1791337815017.png`.

## 재현 명령

격리 dev의 `APPDATA`, 짧은 native `CODEX_HOME`(Windows Unix socket 길이 제한), WSL custom home을 준비한다. `LAYMUX_CODEX_WORKSPACE`, `LAYMUX_CODEX_HOMES`, `LAYMUX_DEV_URL`, `LAYMUX_CDP_URL`을 지정하고 다음 스크립트를 실행한다.

```powershell
node scripts/tests/codex-resume-checkpoint.e2e.mjs
node scripts/tests/codex-checkpoint-reuse.e2e.mjs
node scripts/tests/codex-restart-checkpoint.e2e.mjs prepare .tmp/restart.json
# 해당 격리 APPDATA와 dev health를 확인한 뒤 scripts/kill-dev.sh --with-daemon으로 종료한다.
# 데몬이 남으면 재기동이 살아 있는 Codex를 재결합해 복원점의 resume 경로를 거치지 않는다.
# 같은 APPDATA/CODEX_HOME으로 dev를 다시 기동한다. ID를 다시 주입하지 않는다.
node scripts/tests/codex-restart-checkpoint.e2e.mjs verify .tmp/restart.json
```

`LAYMUX_EXPECT_NO_HOOKS=1`은 신규 훅 없는 resume 조건을 추가로 요구한다. restart prepare는 일반 종료와 같은 저장·기록 정리 함수를 실행하고, 성공한 종료의 입력 fence를 유지한다. verify는 새 앱 PID와 live 귀속·디스크 ID를 함께 확인한다. 실제 업데이트 다운로드·설치와 실제 OS 재부팅은 실행하지 않았다.
