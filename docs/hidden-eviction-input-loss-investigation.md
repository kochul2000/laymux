# 숨김 자동 종료와 입력 유실 조사

2026-09-05. 원인 조사 기준: v0.12.11. 아래 초기 재현 이후 대상별 입력 차단으로 수정하고 격리 dev에서 검증했다.

## 사용자 관찰

시작 직후에는 정상이다가 여러 pane을 숨긴 이후 입력이 간헐적으로 절반 이상 누락되고 수시간 지속됐다. CPU·RAM은 여유가 있었고 스크롤·렌더링은 정상이다. 붙여넣기도 통째로 성공하거나 통째로 실패했다. 미진입·세션 복원 예정 pane이 포함됐을 가능성이 있다. 업데이트에서 `destructive session finalization is already in progress`와 유사한 문구를 본 기억이 있다.

## 수정 전 재현

검증 결과: UI 관련 3개 파일 94 tests, Rust 진단 1 test, 변경 UI 테스트의 ESLint 통과. 이번 실행은 test 유발 경로이며 dev 실기·OS 키보드 재현은 수행하지 않았다.

- `useHiddenTerminalAutoClose.test.ts`: 실제 hook과 store에 600초 숨김 조건을 주고, backend 요청이 3초 후 attribution 오류로 실패하도록 주입했다. 가상 시간을 2시간 진행해 1,400회 이상 재시도와 55% 이상의 요청 진행 구간을 확인했다. 이 비율은 주입한 지연의 결과이며 실기 입력 손실률 측정이 아니다.
- 같은 hook에서 backend PTY가 없는 pane의 응답(`closed=[]`, `failed=[id]`)을 반복 반환하면 10초 만료 이후 60초까지 11번 호출되고 완료 상태가 되지 않는다.
- Rust `diagnostic_hidden_eviction_fence_rejects_unrelated_input_and_update`: production finalization gate를 세운 뒤 실제 raw-input/structured-paste 내부 진입점을 호출하면 둘 다 `destructive session finalization is in progress`로 거절된다. 두 번째 finalization 진입은 `destructive session finalization is already in progress`로 거절된다. gate 해제 후 mutation admission은 회복된다. OS IME나 실제 PTY 출력 테스트가 아니다.
- `persist-session.test.ts`: PTY 생성 전(`sessionReady=false`) 복원 예정 pane은 critical update coverage에서 제외되고 기존 `lastCodexSession`을 보존한다. 따라서 미진입 pane의 존재만으로 업데이트 저장이 반드시 실패한다는 가설은 지지되지 않는다.
- 같은 저장 테스트에서 live terminal attribution이 계속 `unknown`이면 targeted eviction checkpoint가 연속으로 거절된다. 미확정 세션을 임의로 성공 처리하지 않는다.

## 수정 전 코드에서 확인한 연결

`WorkspaceArea`는 미방문 workspace를 마운트하지 않지만 자동 종료 hook은 모든 workspace의 pane을 후보로 계산한다. backend 자동 종료는 live PTY 대상 유무를 확인하기 **전에** 전역 finalization gate와 drain을 수행한다. PTY가 없는 대상도 failed로 돌아오고 다음 5초 tick에서 다시 요청된다.

live 숨김 terminal의 checkpoint가 실패하면 hook은 pending 표시만 제거한다. 횟수 제한이나 backoff 없이 다음 tick에서 다시 전역 gate에 진입한다. 그 구간의 키 입력과 붙여넣기는 큐에 보존되지 않고 오류로 끝난다. 이 구조는 장시간 반복되는 입력 유실과 업데이트 진입 충돌을 함께 만들 수 있다.

## 미확인 범위

당시 실패한 terminal ID, attribution 상태, 실제 gate 점유 시간은 확보하지 못했다. 3초 오류 주입은 Windows provider probe 실패가 실제 발생했다는 증명이 아니다. 또한 pane에 키보드 포커스를 주지 않은 것과 workspace 자체를 한 번도 마운트하지 않은 것은 다르다.

우선 수정 지점은 PTY 없는 대상의 반복 finalization 제거와, 숨김 정리가 무관한 terminal의 입력을 차단하는 전역 gate 범위다. 재시도 간격만 늘리면 유실 빈도만 낮출 뿐 근본 해결이 아니다. 반대로 checkpoint 검증을 생략하면 세션 복원을 잃을 수 있다. 대상별 차단으로 바꿀 경우 ADR-0222의 전역 mutation/drain 계약을 정정하는 새 ADR과 generation·생성/종료·입력 경합 검증이 필요하다.

## 수정 및 dev 검증

ADR: [0231 숨김 정리 대상별 입력 admission](adr/0231-hidden-eviction-target-scoped-input-admission.md).

- UI는 `sessionReady=true`인 대상만 정리 요청한다. 미기동 대상 제외 테스트는 수정 전 11회 호출로 실패했고 수정 후 0회로 통과했다. backend도 live PTY가 없으면 fence 없이 반환한다.
- 숨김 정리는 대상 terminal의 입력만 막는다. 해당 입력과 기존 일반 mutation을 drain한 뒤 기존 strict checkpoint 및 close를 수행한다. 다른 terminal의 raw input·structured paste·protocol reply는 계속 허용한다. 생성/종료 등 일반 mutation은 보수적으로 제한한다.
- update는 전역 fence를 유지하고 진행 중인 숨김 정리까지 기다린다. 기존 drain 시간 제한은 유지하므로 오래 걸리는 정리에서 update timeout까지 없앴다는 뜻은 아니다.
- Rust 회귀 테스트는 실제 입력 진입점/테스트 PTY writer, 대상별 drain, update 대기, 취소 시 fence 해제를 검증한다.
- 격리된 Windows dev(19281, PID 51124)에서 `ui/scripts/repro-hidden-eviction.mjs` 실행: WebView의 attribution 조회에 3초 지연 오류를 주입했다. 실제 Rust 정리가 3회 실패하는 25초 동안 다른 pane의 raw 입력 116회와 전체 붙여넣기 116회가 모두 성공했고 거절은 0회였다. 한 번도 마운트하지 않은 복원 예정 pane은 실행되지 않았고 정리 요청에도 포함되지 않았다.
- 재현 스크립트는 IPC 입력 허용 여부를 측정한다. OS 키보드/IME 이벤트나 최종 셀 내용을 측정한 것이 아니며, 당시 사용자 환경의 최초 attribution 실패 원인은 아직 확인하지 못했다. release 인스턴스는 조작하지 않았다.

재실행은 별도 임시 `APPDATA`와 `WEBVIEW2_USER_DATA_FOLDER`를 지정한 dev에서만 수행한다. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9229`로 `cargo tauri dev`를 실행한 뒤 Windows의 `ui/`에서 `node scripts/repro-hidden-eviction.mjs`를 실행한다. 스크립트는 테스트 workspace를 생성하므로 일상 사용 중인 dev 프로필을 쓰지 않는다. 종료는 같은 `APPDATA`를 지정하고 `bash scripts/kill-dev.sh`로 한다.

최종 검사: UI 전체 4,862개, 관련 UI 재검사 87개, Rust checkpoint 관련 14개, UI build·ESLint·workspace/all-targets clippy `-D warnings` 통과. Rust 전체는 2,033개 통과, 원격 페이지 HTML 문자열 검사 4개 실패했다. 실패한 `remote_server::page` 테스트 및 입력 HTML/JS/CSS는 최신 main과 동일하며 이번 변경에서 수정하지 않았다.
