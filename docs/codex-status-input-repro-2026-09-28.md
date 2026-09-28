# Esc·Backspace·Delete 방식의 Codex dev 실측

> 후속 수정과 최종 결과: [현재 화면 판독 검증](codex-status-current-screen-repro-2026-09-28.md). 아래 내용은 수정 전 실측 이력이다.

- 날짜: 2026-09-28
- 요청: 메뉴를 Esc로 닫고 Ctrl+U 대신 문자 삭제로 초안을 지운 뒤 `/status`를 실행할 수 있는지 실제 dev에서 확인.
- 환경: `fix/codex-checkpoint-pane-error`, `e734cd93` 기반 dev 19281. health의 worktreeRoot·PID 확인. Codex 0.157.1 Windows native / Ubuntu-22.04 WSL, 각각 격리한 CODEX_HOME. release 19280은 사용하지 않았다.
- ADR 불필요: 이번 작업은 입력 대안의 실측이며 새 제품 계약을 채택하지 않는다. 기존 [ADR-0270](adr/0270-codex-status-checkpoint-probe.md)의 새 출력 증거 요구를 완화하지 않았다. 당시 Ctrl+L 초안은 채택하지 않았으며, 후속 사용자 요청으로 [ADR-0278](adr/0278-codex-status-current-screen.md)을 현재 화면 판독안으로 변경했다.

## 측정 방법

실제 dev WebView의 terminal API로 테스트용 두 pane에만 입력했다. xterm과 PTY를 96×45로 맞추고, 전·후 셀과 `terminal-output-v3` 원시 바이트를 수집했다. 완료·실패 후 원래 크기로 복구했다.

입력 정리에는 Backspace(`7f`)와 Delete(`ESC [ 3 ~`)를 각각 16회씩 묶어 보내고, 140ms 후 실제 입력창을 확인했다. 테스트 세션의 빈 입력창 placeholder를 실험용 oracle로 사용했다. 이것을 범용 제품 판정 함수로 구현한 것은 아니다. Ctrl+U/K/E와 Ctrl+L은 정리 절차에 사용하지 않았다. 커서를 처음으로 옮기는 키는 시나리오 세팅에만 사용했다.

메뉴는 화면에서 열림을 확인한 다음 Esc를 한 번 보내고 닫힘을 확인했다. Status 실행은 `/statu`를 입력하고 실제 선택된 `/status` builtin을 확인한 뒤 Enter를 전송했다. 초기 blank composer, 삭제 완료, 메뉴 선택, 명령 후 blank composer를 각각 기록했다. 화면에 남은 ID는 실험 대조용이며, 이를 backend의 새 응답 증거로 채택하거나 저장하지 않았다.

## 입력 동작 결과

아래 14개 시나리오를 두 플랫폼에서 실행했다. 입력 정리·메뉴 복귀·Status 선택 및 명령 후 입력창 복귀는 28회 모두 확인했다. 이는 최종 checkpoint 저장 성공률을 뜻하지 않는다.

| 시나리오 | Windows native | WSL |
| --- | --- | --- |
| 3줄 초안, 커서 처음 | 삭제 470ms | 삭제 468ms |
| 3줄 초안, 커서 중간 | 삭제 299ms | 삭제 298ms |
| 3줄 초안, 커서 끝 | 삭제 469ms | 삭제 447ms |
| 중간·끝에 빈 줄이 있는 초안 | 삭제 293ms | 삭제 291ms |
| 한글·이모지·자동 줄바꿈 | 삭제 1,546ms | 삭제 2,176ms |
| 100줄 붙여넣기 | 축약된 paste 요소 삭제 155ms | 축약된 paste 요소 삭제 153ms |
| `/model` 메뉴 | Esc 한 번 후 composer 복귀 | 동일 |
| `/permissions` 메뉴 | Esc 한 번 후 composer 복귀 | 동일 |
| `/mod` 슬래시 선택 팝업 | Esc로 닫고 남은 입력 삭제 | 동일 |
| 빈 입력창의 연속 조회 4회 | 모두 선택·입력창 복귀 | 동일 |
| 추가 조회, 이후 8.5초 출력 수집 | 입력창 복귀 | 동일 |

처음 시도한 300줄 붙여넣기는 WSL에서 삭제됐지만 Windows에서는 붙여넣기 도착을 확인하지 못해 실험을 중단했다. 이를 삭제 실패나 성공으로 계산하지 않았다. 입력이 실제 도착한 것을 확인할 수 있는 100줄로 다시 측정했다. 100줄 사례는 큰 paste 요소의 삭제이며, 수동으로 입력한 100줄 각각의 삭제 성능을 증명하지 않는다.

## 반복 조회에서 확인한 별도 문제

첫 두 조회에서는 새 출력에 `/status`·헤더·Session 행이 모두 있었다. 그 뒤 같은 카드가 화면을 채운 상태에서는 두 플랫폼 모두 새 출력에 세 요소가 전부 없는 사례가 반복됐다. 추가 조회 후 8.5초를 수집해도 native 717바이트, WSL 729바이트에 새 헤더·명령 echo·Session 행이 없었다. 화면의 기존 UUID는 유지됐다.

따라서 이번 결과는 **Esc와 문자 삭제를 통한 입력 준비가 가능함**을 뒷받침한다. 동시에 **새 출력 바이트만으로 매번 전체 세션 ID를 얻는 현재 계약은 입력 키를 바꿔도 충족되지 않음**을 보여 준다. 과거 셀을 재사용할지, 표시 기록을 초기화할지, 별도 ID 신호를 받을지는 다른 설계 결정이다. 기다리는 시간을 늘리는 것만으로 해결됐다고 보고하지 않는다.

### 사용자 요청에 따른 화면 재현과 실제 파서 대조

같은 dev의 두 pane에서 다시 연속 조회했다. 1회차의 새 출력은 native 3,085바이트·WSL 2,608바이트, 2회차는 각각 4,716·4,131바이트였으며 ID가 포함됐다. 3회차는 각각 639·641바이트였고 명령 echo·헤더·Session 행이 모두 없었다.

수집한 바이트를 별도 실행 파일에서 **제품의 `status_probe/output.rs`와 ANSI 처리 모듈을 그대로 포함하여** 판독했다. 1·2회차는 양쪽 모두 해당 UUID를 반환했고, 3회차는 양쪽 모두 `None`이었다. 이후 추가 조회에서도 8.5초 수집 결과가 639·641바이트이며 판독 결과는 `None`이었다. 이는 입력 실험과 실제 제품 파서의 대조이며, 업데이트 설치 전체를 실행하거나 오류 모달을 발생시킨 검증은 아니다.

추가 조회의 96×45 측정 geometry를 유지한 상태에서 Automation API로 실제 화면을 캡처했다. 화면에는 양쪽 모두 `/status` 카드와 완전한 Session UUID가 보인다. **Codex의 `/status` 화면은 정상이고, 새 출력 바이트만 요구하는 Laymux 판독이 ID를 얻지 못한 상태**다. 따라서 이를 구분 없이 “`/status` 조회 실패”라고 부르는 것은 부정확하다.

- 실제 캡처: `.screenshots/screenshot_1790576289821.png`.
- 입력·출력·셀 기록: `.tmp/result-bs-del-repeat-show-{1,2,3,final}.json`.
- 새 출력 원본과 제품 파서 결과: `.tmp/repeat-evidence/`의 `.ansi` 파일 및 `parser-result.txt`.
- 검증 실행 파일 소스: `.tmp/verify-repeat-parser.rs`.
- 이번 재현에서는 제품 코드와 채택된 설계를 변경하지 않았다. ADR 불필요: 기존 계약의 실패 조건을 실측 기록으로 보강했다.

## 훅을 검토할 때의 요구 사항

검사한 Codex 소스의 SessionStart 훅에는 session ID가 있다. 다만 기본 공유 데몬의 thread 생명주기 훅과 특정 TUI가 현재 선택한 대화는 다른 정보다. 기존 [공유 데몬 조사](codex-shared-daemon-attribution-repro-2026-09-26.md)의 pane 귀속 문제를 그대로 고려해야 한다.

TUI 자체의 연동 신호를 추가한다면 현재 선택된 전체 UUID와 전환·해제를 해당 TUI의 PTY로 내보내는 계약이 필요하다. Laymux는 수신 PTY와 generation으로 pane을 연결할 수 있다. 일반 세션 시작·완료 훅을 설치하는 것만으로 이 계약이 충족된다고 가정하지 않는다. 이번 실측에서는 Codex 훅이나 사용자 설정을 설치·변경하지 않았다.

## 증거와 범위

- 하니스: 작업 워크트리 `.tmp/input-path-repro.mjs`.
- 결과: `.tmp/result-bs-del-{start,middle,end,blank,unicode,long,modal-model,modal-permissions,slash-popup,repeat-1,repeat-2,repeat-3,repeat-4,repeat-settled}.json`.
- 각 JSON은 dev 신원, 전송 키, 단계별 셀, 출력 경계와 원시 바이트를 포함한다. `ok`는 실험의 입력 단계 완료를 뜻하며 backend의 세션 확정 성공을 뜻하지 않는다.
- 이번 하니스는 격리된 테스트 pane에서 실행한 입력 실험이다. production fence·최종 저장·업데이트 설치 E2E를 실행한 것으로 보고하지 않는다. 실행 중 작업·승인 요청·Vim·사용자 키맵까지 자동으로 닫아도 된다는 결론도 내리지 않는다.
