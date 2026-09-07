# 빈 agent 세션과 Codex 다중 스레드 귀속 재현

2026-09-07, Windows dev PID 80920, port 19281, HEAD `3ed2a7cd98f6a6018dd939f98fe1a320a84fe122`.
APPDATA와 WebView storage는 `.tmp/empty-agent-repro`로 격리했다.
WSL Ubuntu-22.04의 실제 Claude 2.1.263, Codex 0.153.4, Grok Build 1.0.13과 Windows Codex 0.153.4를 사용했다.
조회 시점 최신 main `774a11d9`와 Codex 귀속의 네 파일(session_attribution, codex_session, codex_session/store, wsl_agent_session)은 diff가 없었다.

## 결과

아래는 14:58–15:03 KST에 dev PID 88928로 Windows 네이티브·WSL 3종을 모두 재검사한 결과다. APPDATA/WebView는 `.tmp/native-agent-repro`로 격리했다. 작업 디렉터리는 `.tmp/native-agent-repro-work`이며 WSL은 같은 디렉터리의 `/mnt/d` 경로를 사용했다. Windows는 PowerShell에서 Windows 바이너리를, WSL은 WSL 프로필에서 Linux 바이너리를 실행했다. 양쪽 모두 Claude 2.1.263, Codex 0.153.4, Grok 1.0.13이다.

| 대상 | 신규 실행, 첫 질문 전 | 첫 질문 제출 후 | clear/new 후 빈 대화 | 새 대화에 질문 제출 후 |
| --- | --- | --- | --- | --- |
| Windows 네이티브 Claude | identified, 통과 | NATIVE_OK 응답, 통과 | 새 ID로 identified, 통과 | NATIVE_SECOND 응답, 통과 |
| Windows 네이티브 Codex | activeButUnidentified, 거부 | NATIVE_OK 응답, 통과 | **이전 ID로 잘못 identified, 저장도 통과** | NATIVE_SECOND 응답, 현재 ID로 통과 |
| Windows 네이티브 Grok | identified, 통과 | NATIVE_OK 응답, 통과 | 새 ID로 identified, 통과 | NATIVE_SECOND 응답, 통과 |
| WSL Claude | identified, 통과 | WSL_OK 응답, 통과 | 새 ID로 identified, 통과 | WSL_SECOND 응답, 통과 |
| WSL Codex | activeButUnidentified, 거부 | WSL_OK 응답, 통과 | **이전 ID로 잘못 identified, 저장도 통과** | WSL_SECOND 응답 완료 후 activeButUnidentified, 거부 |
| WSL Grok | activeButUnidentified, 거부 | WSL_OK 응답, 통과 | 전환 중 미식별 후 새 ID로 identified, 통과 | WSL_SECOND 응답, 통과 |

critical checkpoint는 `flushSessionCheckpoint({reason:"update",requireConclusive:true,terminalIds:[id]})`로 실제 frontend → Rust provider 조회 → 디스크 저장 경로를 실행했다. 두 번째 검사는 표의 24개 조합 모두 attribution과 critical checkpoint를 검사하고 실제 터미널 buffer로 응답 완료/clear를 확인했다. installer와 저장 후 재실행은 검사하지 않았다. 통과는 저장 게이트 통과이지 resume 성공의 증명이 아니다. 첫 검사에서 WSL Claude는 사용량 제한으로 응답을 검증하지 못했지만, 두 번째 검사에서는 첫 응답과 후속 응답 모두 성공했다.

Windows generation은 Claude/Codex/Grok 각각 6/8/10, WSL은 12/14/16이며 각 4단계 안에서는 변하지 않았다. Windows Codex는 clear 직후 이전 `01a07a72-7188-7320-a4bb-3ae04ee3718f`를 반환했고 후속 응답 뒤에야 현재 `01a07a73-3fe4-7711-a3fc-575f51afdc08`를 반환했다.

## 직접 원인

WSL Codex의 PID 86066에는 다음 두 최상위 대화의 rollout이 동시에 열려 있었다.

- 이전: `01a07a46-7f7c-7083-97a4-dcaf286237c4`
- 현재: `01a07a47-994e-7722-bcdc-5c8c73b97423`

`wsl_agent_session.rs`는 해당 PID가 연 rollout FD를 모두 수집한다. `codex_session/store.rs`의 `find_session_from_rollout_paths_checked`는 유효한 최상위 세션이 정확히 하나일 때만 ID를 반환한다. 둘이면 None이다. `session_attribution.rs`는 실행 중인 provider와 None을 합쳐 activeButUnidentified로 분류한다.

두 번째 검사에서도 WSL PID 53170의 `/proc/<pid>/fd`에 이전 `01a07a74-9c50-7753-8c50-22ddb75871ed`와 현재 `01a07a75-30d4-73e1-b325-da868f6d64dc`의 rollout 두 개가 함께 열려 있었다. `/clear`만 한 뒤 후속 질문해도 재현되므로 `/new`를 추가로 실행해야만 생기는 현상이 아니다.

새 빈 스레드에는 rollout이 없으므로, 이전 대화의 FD만 남은 동안에는 반대로 이전 ID를 현재 ID로 잘못 선택한다. native 경로도 logs DB에서 검증 가능한 이전 thread로 fallback해 새 빈 대화에서 이전 ID를 반환했다.

따라서 단순히 생성 중 잠깐 조회가 실패하거나 답변 생성 중 차단되는 규칙이 아니다. **현재 선택된 스레드와 프로세스에 남아 있는 스레드를 구분하지 않는 것**이 확인된 결함이다. 신규 빈 대화 판정 부재와 결합해 잘못된 이전 세션 복원 또는 차단을 만든다.

사용자 native pane `terminal-pane-43d696a8`의 재시작 전 실패 순간은 포착하지 못했다. 당시 별도 read-only 조회에서는 PID→로그→현재 rollout이 정상 연결됐다. 이번 WSL 다중 FD 재현을 그 native 오류의 확정 원인으로 주장하지 않는다.

## provider별 저장 증거

- Claude clear: PID별 `~/.claude/sessions/<pid>.json`이 새 ID를 제공하고, 새 transcript에 local `/clear` 명령 및 시스템/첨부 항목이 존재한다. user 타입 행 수만으로 실제 질문이 있는지 판단하면 안 된다.
- Codex 빈 스레드: writer lock과 thread/start 초기화 로그는 있지만 rollout이 없을 수 있다. 이전 스레드 FD도 공존하므로 lock/파일의 존재나 개수만으로 현재 스레드를 정하면 안 된다.
- Grok 최초 대기: agent는 실행 중이지만 기존 adapter가 요구하는 세션 증거가 없어 차단됐다. `/clear` 후에는 active_sessions의 새 ID와 summary, chat_history가 생겼다. 실제 질문이 없어도 summary의 num_messages=1, num_chat_messages=2였다. chat_history는 system과 synthetic_reason이 있는 user 항목으로 구성됐다. 숫자가 0인지로 빈 대화를 판정하면 틀린다.

## 재현과 한계

두 번째 실행에서는 Claude `--strict-mcp-config`, Codex의 실제 설치된 MCP 서버별 `enabled=false` 실행 인자, Grok 작업 디렉터리의 `.grok/config.toml` 서버별 `enabled=false`로 기존 MCP를 비활성화했다. 사용자 계정/전역 설정은 수정하지 않았다. 네이티브 setup은 `LAYMUX_REPRO_NATIVE=1`을 추가한다. WSL Codex에는 Windows에만 있는 MCP 이름의 override를 넘기면 invalid transport로 시작에 실패해, WSL 실제 설정의 laymux/zvec_grep만 비활성화한 뒤 다시 실행했다.

Windows Grok의 첫 질문 전 대기는 identified였지만 WSL Grok의 welcome 대기는 activeButUnidentified였다. 같은 버전이라도 플랫폼/초기 UI 경로가 다르므로 모든 Grok 신규 실행이 차단된다고 일반화하지 않는다. WSL Grok clear 직후 단일 attribution은 일시적으로 미식별이었으나 뒤이은 critical checkpoint와 재조회는 새 ID로 통과했다.

`ui/scripts/repro-agent-session-checkpoint.mjs`는 dev health의 buildKind/worktreeRoot를 검사하고 CDP 9229에서 setup/write/sample을 수행한다. `LAYMUX_REPRO_ISOLATED=1`을 요구한다. Windows ui 디렉터리에서 실행한다. CLI 시작은 `write <provider> <command+CR>`, 질문은 본문과 CR을 별도 write로 전송해야 Codex의 paste 대기를 피할 수 있다.

중간에 스크립트를 편집하자 Vite reload로 PTY generation이 바뀌었다. 변경 후 generation 12/13/14에서 다시 실행한 결과만 clear/new 비교에 사용했다. 상태를 비교할 때 generation 변화 여부를 반드시 확인한다.

provider 계정 설정은 기존 것을 사용했다. Grok의 기존 MCP 설정이 release 19280을 가리켜 초기 연결이 발생했다. 테스트 질문은 도구 사용을 금지한 단답 요청이고 release에 도구 작업을 요청하지 않았다. 다음 재현은 provider MCP 설정까지 dev로 격리해야 한다.

테스트가 만든 네 PTY를 close IPC로 종료하고 공식 `scripts/kill-dev.sh`로 dev PID 80920을 종료했다. 사용자 release에 입력·종료·설정 변경·업데이트 설치를 수행하지 않았다. 테스트 대화 기록은 provider 저장소에 남아 있다.

두 번째 검사 역시 테스트 workspace를 제거하고 공식 종료 스크립트로 dev PID 88928을 종료했다. 격리된 dev 설정 및 테스트 대화 기록은 남겼다.

위 표는 수정 전 진단 결과다. 아래의 후속 변경과 구분한다.

## 후속 PR의 부분 수정과 남은 범위

`fix/agent-empty-session-checkpoint`, base `c023c352`에서 native Codex의 위험한 이전 ID fallback을 먼저 차단했다. 신규 후보의 파일 부재·만료·잘못된 header·중복 경로는 이전 대화를 복원할 근거가 아니다. 정확한 보조 스레드만 제외한다. 파일 없는 제목 생성 스레드는 동일 process UUID의 threadless `temporary-structured` startup span과 정확한 thread ID로 확인하며, 다른 프로세스나 일반 메시지 안의 인용은 근거로 인정하지 않는다.

TDD는 두 번 RED→GREEN을 확인했다.

1. 첫 대화 A → clear로 B 로그만 생성 → B 첫 대화 파일 생성: 수정 전 B가 빈 동안 A를 반환해 실패했다. 수정 후 빈 동안 None, 파일 생성 뒤 B다.
2. 실제 dev에서 제목 생성 스레드가 늦게 끝나면 단순한 부재 차단이 정상 대화도 막는 것을 발견했다. 같은 process의 임시 스레드 span fixture를 추가해 실패를 확인하고, 긍정적인 임시 스레드 증거만 제외하도록 수정했다.

최종 native 검증은 dev PID 33248, Codex generation 8로 수행했다. MCP는 비활성화했고 installer는 실행하지 않았다.

| 단계 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 신규 실행·질문 전 | 미식별·차단 | 미식별·차단 유지 |
| 첫 응답 완료 | 현재 ID·통과 | `FIX2_OK` 응답, `01a07a90-02d8-79a0-8f8d-1b0f881a69cc`·통과 |
| clear 직후 | 이전 ID로 잘못 저장 | 미식별·차단, 이전 ID 저장 방지 |
| 후속 응답 완료 | 현재 ID·통과 | `FIX2_SECOND` 응답, `01a07a90-6a00-79c1-bd2f-67480b92ef98`·통과 |

최종 code 기준 Codex 단위 테스트 21개가 통과했다. Rust lib 전체는 2,045개 통과, Remote 페이지 관련 8개 실패이며 그 8개는 수정 전 main `c023c352`의 별도 worktree에서도 동일하게 실패했다. 중간에 공유 Cargo target의 build-root metadata가 baseline 경로로 남아 identity 테스트가 실패한 실행이 있었으며, followup의 build script를 재실행한 최종 전체 검사에서는 해소됐다. Windows UI 재현 스크립트의 구문 검사와 ESLint, Rust strict Clippy도 통과했다. dev는 공식 종료 스크립트로 종료했다. native setup에는 `LAYMUX_REPRO_NATIVE=1` 및 격리 작업 디렉터리 `LAYMUX_REPRO_CWD`를 지정한다.

아직 구현하지 않은 항목:

- 세 provider의 검증된 빈 대화를 settings에 구분해 저장하고 resume 없이 실행하는 경로.
- WSL Codex의 이전·현재 rollout FD 공존 시 현재 스레드 선택.
- WSL Grok welcome 대기를 빈 상태로 확정하는 provider 증거.

실행 중 WSL SQLite를 Windows에서 직접 열면 잠금 오류가 발생했다. WSL 내부의 선택적 python3/sqlite3 probe를 사용할지 사용자에게 질의했으며 아직 도입하지 않았다. 파일 부재나 미식별을 일괄적으로 빈 상태로 간주해 업데이트를 허용하지 않는다. 위 6×4 수정 전 표의 모든 결함을 고쳤다고 주장하지 않는다.

ADR: [0222](adr/0222-agent-session-checkpoint-coordinator.md). 현재 부분 수정은 검증 실패를 오래된 정확 귀속으로 둔갑시키지 않는 기존 결정을 직접 적용하며 새 상태/설정/실행 계약을 추가하지 않는다. 새 ADR 불필요. 남은 fresh 복원 및 크로스플랫폼 조회 전략은 ADR-0222/0232 확장 ADR에서 별도로 고정해야 한다.
