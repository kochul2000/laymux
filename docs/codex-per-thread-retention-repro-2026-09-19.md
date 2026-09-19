# Codex 대화별 로그 정리 뒤 두 pane의 귀속 충돌

2026-09-19, 사용자 release 1.0.7(`87f813729`)에서 `terminal-pane-14c5ef06: activeButUnidentified`를 조사했다. 구현은 `1f1445d9` 기반이며 [ADR-0258](adr/0258-codex-retained-loop-session-attribution.md)을 적용한다.

## 실제 원인

사용자 앱·PTY·설정·DB를 변경하지 않고 프로세스 트리와 Codex 저장소를 읽었다. native Codex 두 프로세스 중 한쪽은 대화 A를 정상 resume했다. 다른 쪽은 이전 A의 resume·Shutdown·loop 종료 기록이 남았지만 현재 B의 시작 기록이 정리되어 없었다. B의 loop 기록은 정확히 1,000행 남았다. 별도 제목 대화와 subagent도 같은 프로세스에 존재했다.

기존 lifecycle 판정은 유효한 rollout이 있으면 종료된 A도 선택했다. 두 pane이 A를 주장하므로 중복 보호가 둘 다 거부했다. 이전 테스트는 thread 없는 로그의 정리만 교차했으며 대화별 시작 기록의 소실은 포함하지 않았다. [Codex의 정리 구현](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/state/src/runtime/logs.rs)은 두 영역을 독립적으로 정리한다.

`live_native_codex_panes_keep_their_distinct_current_sessions`는 지정한 PTY 루트 PID의 메타데이터와 provider 저장소만 읽는다. sink writer로 만든 테스트 handle에는 실제 PTY나 종료 핸들을 붙이지 않는다. 동일한 사용자 프로세스 쌍을 대상으로 수정 전 assertion 실패, 수정 후 정확한 A/B 귀속을 독립 조회 두 번 모두 확인했다.

## dev 재현

release 19280은 변경하지 않았다. 격리 APPDATA·WebView·native/WSL Codex 저장소를 사용하는 dev 19281만 조작했다. CDP에서 실제 로드된 Vite 모듈을 호출하고 xterm 셀·스크린샷·health의 PID/버전/작업 경로를 대조했다.

수정 전 dev PID 52456의 귀속 코드는 `87f813729`였다. native Codex 0.154.0에서 대화를 resume하고 `/clear` 후 실제 Astra 답변을 완료했다. 이전 대화는 즉시 종료되지 않고 약 1분 후 `Shutdown`과 `Agent loop exited`를 남겼다. 종료를 확인한 뒤 두 번째 pane에서 이전 대화를 resume했다. 두 대화가 정상 귀속됨을 확인한 후, **테스트 DB에서만** 현재 대화의 초기화 행과 해당 프로세스의 threadless 기록을 삭제했다. 남은 현재 대화 loop·rollout과 이전 대화의 종료 기록은 실제 CLI가 쓴 그대로다. 대화당 1,000행을 생산한 실험은 아니며, 정리 결과를 결정적으로 유발한 실기다. 실제 1,000행 cap은 SQLite 회귀 테스트에서 별도로 재현했다.

두 native pane이 `activeButUnidentified`가 되었고 실제 `flushSessionCheckpoint({reason:'update', requireConclusive:true})`가 사용자와 같은 오류로 실패했다. WSL Codex 0.155.0에서도 실제 답변 후 초기화 기록을 같은 방식으로 정리하면 `identified`에서 `activeButUnidentified`로 바뀌었다.

## 수정 후 검증

1.0.9 dev PID 48312에서 같은 절차를 다시 수행했다. native의 새 대화는 `01a0b9d0-28c4-7293-ba0b-bdbbf5a0f512`, 두 번째 pane의 이전 대화는 `01a0b9c7-a67d-7633-a58d-502d1275f935`, WSL 대화는 `01a0b9cc-5429-7e40-bb23-4db138d36e07`였다.

- native·WSL 초기화 기록 정리 후에도 세 대화 모두 정확한 `identified`였다. native·WSL 복구 선택 키는 각각 process UUID와 대화 ID를 포함했다.
- 실제 전체 critical checkpoint가 성공했다(commit ID 6). coverage의 세 session ID가 위 목록과 일치했다. 반복 조회에서도 유지했다.
- 체크포인트 저장 뒤 `scripts/kill-dev.sh`로 dev만 종료하고 재실행한 PID 7060에서 세 대화가 자동 resume되었다. 세 ID가 저장값과 모두 일치했고 재차 전체 critical checkpoint도 성공했다(commit ID 3).
- native·WSL 실제 질문의 `running → completed`를 관측했고, 완료 후 출력 없는 상태에서도 정확한 대화와 완료 상태를 유지했다. dev 스크린샷의 세 완료 표시도 확인했다.
- 재시작 후 WSL에서 `/clear`한 빈 대화의 모델을 Sol에서 Astra로 변경했다. 입력 없이 `fresh/idle`을 유지했고 Windows 일반 셸과 함께 전체 critical checkpoint가 성공했다.
- 1차 독립 리뷰가 찾은 `Shutdown` 행 소실 뒤 `Agent loop exited`만 남는 경로는 실패 테스트를 먼저 확인하고 수정했다. 실기에서 발견한 이전 대화의 지연 종료 역시 실패 테스트 후 수정했다. 이전 종료 시각보다 새 대화의 마지막 활동이 앞서도 복구한다.
- 최종 사용자 프로세스 재조회에서 부모 loop 안의 subagent 초기화 행이 부모 ID와 자식 DB ID의 불일치로 `Unknown`이 되는 회귀를 발견했다. 2차 리뷰도 P1으로 확인했다. 정확한 자식 rollout으로 보조 역할이 확인된 행만 제외하도록 수정한 뒤 동일 실제 프로세스 두 개의 귀속을 두 번 다시 통과했다. native/guest·명시 선택/초기화 정리·오래된 보조 파일 및 누락/최상위 파일을 교차한 실패 테스트를 먼저 추가했다.
- P1 수정 뒤 새 리뷰어의 3차 전체 리뷰에서는 P1이 없었으며, ID가 일치하는 오래된 보조 loop가 복구를 막는 P2를 발견했다. native/guest와 subagent/exec 각각에서 실패를 확인하고, 역할 확인과 최상위 복원 나이 제한을 분리해 수정했다. 보조 파일이 오래되어도 현재 대화를 복구하며, 최상위 대화 자체가 만료된 경우에는 계속 거부한다.

## 회귀 범위

native/guest 공통 판정으로 대화별 1,000행 정리·두 PID의 다른 소유권·종료된 제목 대화·살아 있는 subagent·동일 ID 재개·불완전 전환·인용/중첩/유사 종료·파일 누락/손상/만료/중복/ID 불일치·PID 재사용·로그 정리 전후 선택 키 안정성을 검증한다. 기존 1,400개 threadless/lifecycle/rollout 교차 관측도 유지한다.

현재 증거가 모호한 경우의 거부와 업데이트 barrier는 유지한다. 이 기록은 위 실제 조건의 수정 검증이며 모든 Codex 내부 진단 형식에 대한 보증은 아니다. 진단 원문과 인증 파일은 커밋하지 않는다.

검증 명령은 `cargo test --manifest-path src-tauri/Cargo.toml --lib codex_session`(51개), `--lib session_attribution`(19개 통과·실기 전용 3개 기본 제외), `cargo test -p laymux-wsl-codex-probe`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo build --manifest-path src-tauri/Cargo.toml --bin laymux`다. Windows UI에서는 persist-session·terminal-store·terminal-task·useSyncEvents·codex-turn-subscription·codex-activity-handler 6개 파일의 245개 테스트와 `npm run build`를 통과했다. Linux 정적 WSL 도우미를 다시 빌드하고 dev 실행 파일 옆의 SHA-256이 스테이징 산출물과 일치함을 확인했다.
