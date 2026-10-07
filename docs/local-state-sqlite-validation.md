# 로컬 SQLite 저장 계층 검증

설계 정본은 [ADR-0299](adr/0299-portable-settings-and-local-sqlite-state.md), 현재 계약은 [Settings](architecture/api-contracts.md#10-settings)와 [세션 영속](architecture/data-flow.md#13-session-persistence--cache)이다.

## 테스트 시나리오

| 경계 | 확인할 결과 | 검증 위치 |
| --- | --- | --- |
| 다른 PC로 settings만 복사 | 취향·논리 프로필·템플릿 유지, 이전 PC 명령·CWD·대화 ID 없음 | `settings/persistence/tests.rs`의 두 PC fixture |
| 사용자 설정과 세션의 독립 저장 | 대화·활성 workspace·뷰어 변경은 DB만 갱신, 설정 초기화는 세션 행 유지 | `local_state/tests.rs`, `settings/persistence/tests.rs`, dev harness |
| 부분 조회 실패 | Unknown은 이전 검증 ID 유지, 확인 완료와 쓰기 성공 구분 | `local_state/tests.rs`, frontend checkpoint 테스트 |
| 새 이벤트 없는 회복 | DB의 부분 ACK 뒤 제한된 재시도로 최신 ID 저장 | `session_checkpoint/hints.rs`의 실제 DB/worker 통합 테스트 |
| 구조·세대·view 변경 | 삭제/교체된 view에 저장 결과 게시 안 함, 이전 세대 증거로 receipt 발행 안 함 | frontend checkpoint·backend receipt 테스트 |
| 스택과 숨은 레이어 | 레이어 순서·활성 레이어·각 대화 복원점 유지, compact/stack 중복 content ID 거절 | `local_state/tests.rs`, receipt 테스트 |
| 템플릿 환경 | 로컬 configDir/CWD 보존, portable export에 없음, 다른 슬롯에 과거 환경 적용 안 함 | projection·persistence 테스트 |
| 동시 저장과 DB 잠금 | 일관된 그룹/pane/revision, 250ms busy timeout 뒤 오류, WAL reader는 이전 commit 읽음 | `local_state/tests.rs` |
| 디스크 부족 | 실제 SQLITE_FULL 발생 시 전체 rollback, revision과 이전 복원점 유지 | `local_state/tests.rs`의 `max_page_count` fixture |
| 손상·schema 오류 | 원본 보존, 기본값으로 덮어쓰기 안 함, 설정 초기화 버튼 숨김 | Rust persistence·UI recovery·dev 오류 검증 |
| 종료·업데이트 취소 | 기존 fence/critical barrier 유지, 실패를 성공 ACK로 처리하지 않음 | 기존 lifecycle·status·checkpoint 테스트 |
| 완전 앱 종료 후 재기동 | 새 PID에서 native/WSL의 동일 대화 ID·workspace·파일 뷰어 복원 | dev harness `prepare` → kill-dev → `verify` |
| 출력 캐시 유실 | 출력 캐시 없이 DB 복원 메타데이터로 같은 대화 복원 | 격리 dev 재시작 검증 |
| 변경 없는 종료 | DB revision으로 receipt 검증, provider/WSL 재조회와 settings 재쓰기 생략 | receipt 테스트·dev 재사용/종료 측정 |

실제 PC 재부팅·전원 차단과 실제 업데이트 설치는 자동 검증에서 수행하지 않는다. 완전한 앱 프로세스 교체로 디스크 복원을 검증한다. WAL·synchronous=FULL의 전원 차단 내구성은 파일시스템/저장장치의 동기화 보장에 의존한다.

## 격리 dev 실행

Windows에서 APPDATA와 LOCALAPPDATA를 모두 현재 worktree의 `.tmp` 하위에 지정한다. WebView 데이터 폴더와 CDP 포트도 분리한다. Linux에서는 HOME과 XDG_STATE_HOME을 함께 격리한다. release 포트 19280은 사용하지 않는다.

`scripts/tests/local-state-sqlite.e2e.mjs`는 dev health의 worktree 신원, `.tmp` 파일 경로, `matrix-` workspace와 전체 terminal 소유권을 확인한다. 기존에 검증된 테스트 대화를 해당 격리 fixture에 준비한 뒤 실행한다.

```powershell
$env:LAYMUX_CODEX_WORKSPACE='matrix-sqlite'
$env:LAYMUX_CDP_URL='http://127.0.0.1:9229'
$env:LAYMUX_DEV_URL='http://localhost:1420'
node scripts/tests/local-state-sqlite.e2e.mjs check
node scripts/tests/local-state-sqlite.e2e.mjs prepare .tmp/sqlite-restart.json
# APPDATA를 격리 경로로 지정한 상태에서 bash scripts/kill-dev.sh
# 같은 APPDATA/LOCALAPPDATA로 새 dev 프로세스를 실행한 뒤:
node scripts/tests/local-state-sqlite.e2e.mjs verify .tmp/sqlite-restart.json
```

`protected-db`는 앱을 종료한 뒤 백업한 **격리 DB만** 손상 fixture로 바꿔 기동했을 때 사용한다. DB/JSON bytes 보존, 쓰기 차단, 오류 모달의 경로와 초기화 버튼 부재를 확인한다. 확인 후 앱을 종료하고 백업을 복원한다. 앱 종료는 항상 `bash scripts/kill-dev.sh`를 사용한다.

## 기존 데이터 수동 처리

자동 마이그레이션은 없다. 기존 혼합 JSON의 workspace·대화 ID·로컬 명령을 새 저장 계층에 자동으로 가져오지 않는다.

1. 이전 버전에서 앱을 정상 종료하고 `settings.json`, `cache`, 관련 provider의 대화 저장소를 별도 백업한다. 기존 JSON의 pane 대화 ID·CWD·프로필 실행 명령·WSL 배포판을 기록한다.
2. 새 버전에서 이식 가능한 취향·논리 프로필·템플릿을 사용하고, Settings UI에서 현재 PC의 프로필 명령·시작 디렉터리·provider 경로·Remote 환경을 다시 지정한다.
3. 필요한 workspace를 만들고 기록한 대화 ID로 provider의 명시적 resume를 실행한다. 일반 checkpoint에서 정확한 귀속이 확인되면 새 DB에 복원점이 저장된다. 파일 뷰어도 다시 연 뒤 저장한다.
4. DB를 백업/수동 교체할 때는 앱을 완전히 종료한다. WAL/SHM 파일이 남아 있다면 DB와 함께 보존하며, 실행 중 DB 본체만 복사하지 않는다. 손상/schema 오류에 자동 초기화를 적용하지 않는다.

초기 DB 세션이 없는 기동은 기존 출력 캐시와 localStorage 오버라이드를 정리하지 않는다. 첫 세션 저장 이후 정상 캐시 GC가 재개되므로 원래 복원 데이터는 먼저 백업한다. 비밀의 OS keyring 계약과 미전송 Composer/history의 메모리 전용 계약은 유지한다.

## 실행 결과

전체 자동 테스트와 격리 dev의 실제 결과는 PR 검증 항목에 기록한다.
