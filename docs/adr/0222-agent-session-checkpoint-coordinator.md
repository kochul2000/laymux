# 0222. Agent 세션 복원점은 통합 귀속 스냅샷과 수명주기 체크포인트로 확정한다

- Status: Accepted
- Date: 2026-08-31
- Source: 사용자 보고("Remote에서 업데이트하면 최신이 아닌 이전 agent 세션으로 복원된다")와 후속 요구("완료·워크스페이스 진입·장주기 저장 및 activity 재검증"), [architecture/data-flow.md §9·§10.6·§13](../architecture/data-flow.md), [architecture/overview.md §3.2](../architecture/overview.md), [ADR-0118](0118-codex-session-pid-attribution.md), [ADR-0120](0120-wsl-agent-session-attribution.md), [ADR-0195](0195-agent-session-cleared-on-shell-return.md), [ADR-0174](0174-github-signed-desktop-self-update.md), [ADR-0201](0201-update-install-releases-child-file-locks.md)
- Amends: [ADR-0118](0118-codex-session-pid-attribution.md)·[ADR-0120](0120-wsl-agent-session-attribution.md)의 관측 불가 처리, [ADR-0195](0195-agent-session-cleared-on-shell-return.md)의 agent 부재 판정 SoT, [ADR-0201](0201-update-install-releases-child-file-locks.md)의 updater `on_before_exit` 전용 자식 정리 시점을 정정한다. PID 기반 정확 귀속, CWD 추정 금지, 충돌 시 복원 금지, 권위 있게 agent가 사라진 pane의 세션 삭제, 앱 소유 자식 정리와 Windows file-lock wait는 유지한다.
- Extends: [ADR-0174](0174-github-signed-desktop-self-update.md)의 설치 transaction에 복원 체크포인트 barrier를 추가한다.
- Related: [ADR-0048](0048-kill-terminals-on-exit.md), Proposed [ADR-0119](0119-settings-type-error-partial-recovery.md), [ADR-0135](0135-activity-reconcile-backend-diff-push.md), [ADR-0156](0156-grok-first-class-agent.md), Proposed [ADR-0202](0202-io-commands-off-the-main-thread.md)

## Context

Agent 세션 복원점은 현재 창의 정상 close에서 프론트엔드가 settings snapshot을 수집할 때 주로 갱신된다. Desktop·Automation·Remote의 자체 업데이트는 공통 Rust updater로 합류하지만, installer가 프로세스를 종료하는 경로는 프론트엔드의 `CloseRequested`를 거치지 않는다. 따라서 다운로드 중에 새 세션이 생겨도 설치 직전 최종 snapshot 없이 마지막으로 디스크에 남은 세션을 다음 기동에서 복원할 수 있다. 숨김 terminal 자동 eviction처럼 앱이 PTY를 먼저 폐기하는 경로도 같은 종류의 귀속 증거 손실 경계다.

정상 close에만 의존하는 방식은 crash·강제 종료에도 취약하다. CWD 변경 등 일부 동작은 저장을 유발하지만, agent 완료, workspace 전환, 장주기 안전망은 세션 귀속 저장과 연결돼 있지 않다. 특히 같은 프로세스에서 대화를 초기화하는 `/clear`는 전후의 PID·PTY generation·`activity.type/name`이 같을 수 있다. ADR-0135의 3초 activity 재판정과 60초 전체 재발행은 표시 drift를 고치지만 session identity를 조회하지 않으므로 이 전환을 발견할 수 없다.

단순히 기존 저장 호출을 더 자주 실행하는 것도 안전하지 않다.

- snapshot 수집은 여러 비동기 I/O를 포함한다. 이전 요청이 늦게 끝나 최신 snapshot 뒤에 저장되면 복원점이 과거로 되돌아갈 수 있다. 파일 쓰기 mutex와 atomic rename은 잘린 JSON을 막지만 snapshot의 최신성은 보장하지 않는다.
- runtime snapshot이 `settings.json` 전체를 덮으면 cloud·Remote·Automation 등 다른 writer가 갱신한 필드를 옛 프론트엔드 값으로 되돌릴 수 있다. write 구간만 잠그는 것으로는 load-modify-write lost update를 막지 못한다.
- 현재의 provider별 조회 실패는 빈 map과 구분되지 않을 수 있다. 프론트 activity가 일시적으로 shell로 틀린 순간과 겹치면 "관측할 수 없음"을 "agent가 없음"으로 해석해 마지막으로 증명된 세션 ID를 지울 수 있다. 저장 횟수가 늘수록 이 경합을 디스크에 확정할 기회도 늘어난다.
- 완료 알림은 provider마다 강도가 다르고 모든 agent에 존재하지 않는다. workspace의 `sessionReady`도 PTY 생성만 뜻하며 agent resume과 귀속 준비 완료를 뜻하지 않는다. 어느 이벤트 하나도 단독 정본이 될 수 없다.

작용하는 force는 다음과 같다.

- 잘못된 세션을 resume하지 않는 ADR-0118·0120의 정확성 원칙과, 실제로 shell로 돌아온 pane에서 stale 세션을 제거하는 ADR-0195의 사용자 의미를 함께 지켜야 한다.
- 앱이 통제하는 update·eviction에서는 귀속 증거를 없애기 전에 저장할 수 있지만, crash와 강제 종료에는 사전 callback을 보장할 수 없다. 전자는 barrier로, 후자는 마지막 성공 이후의 최대 손실 시간으로 다뤄야 한다.
- provider 저장소 전수 scan과 WSL probe는 비용이 있으므로 activity의 3초 cadence나 60초 전체 재발행에 그대로 결합할 수 없다.
- workspace/layout/dock과 현재 UI revision은 프론트엔드가, live PTY generation·process/guest liveness·정확한 provider session은 Rust가 각각 권위 있게 안다. 한쪽의 추정만으로 파괴적 삭제를 결정해서는 안 된다.
- `settings.json`은 기존 복원 상태의 영속 SoT다. 별도 checkpoint 파일을 추가해 두 개의 정본과 startup overlay 규칙을 만들지 않는다.

범위는 workspace/layout/dock 구조, pane CWD, Claude·Codex·Grok session ID로 이루어진 **복원 메타데이터**의 수집·판정·commit 시점과 update/terminal 수명주기 barrier다. xterm scrollback cache의 포맷과 일반 저장 cadence, provider 저장소 adapter의 구체적 탐색 알고리즘, 자동 무인 업데이트, OS 전원 상실까지의 fsync 보장은 비목표다.

## Decision

**복원 메타데이터는 중앙 체크포인트 조정기가 이벤트 힌트·5분 주기 안전망·파괴 전 barrier를 하나의 순서화된 경로로 합치고, Rust의 PTY generation 결부 통합 귀속 판정으로 `settings.json` 최신본에 프론트 소유 projection을 transaction으로 병합한다.**

### 소유권과 commit 경계

- 프론트엔드는 현재 workspace/layout/dock 구조와 `frontendMutationRevision`의 SoT다. Rust는 live PTY generation, native/WSL process liveness, 실행 중 provider, 정확히 귀속된 session ID와 판정 건강성의 SoT다. `activity`와 완료 알림은 체크포인트를 요청하는 힌트일 뿐, 세션 ID를 설정하거나 삭제하는 권위가 아니다.
- 모든 runtime 복원 체크포인트 요청은 앱 전역 조정기 하나를 통과한다. 동시에 한 수집·commit만 실행하며, 실행 중 들어온 일반 요청은 버리지 않고 `frontendMutationRevision`과 이유를 합쳐 완료 직후 최신 상태로 한 번 더 수집한다. critical 요청이 겹치면 all-live update 범위가 targeted eviction 범위보다 우선하며 좁아지지 않는다. 오래 걸린 옛 snapshot이 더 최신 commit 뒤에 기록되는 것은 금지한다.
- barrier flush는 Rust finalization fence 뒤 두 번의 통합 귀속 관측을 수행한다. 두 관측의 PTY generation과 결론적 귀속이 같고, 두 번째 authoritative CWD 조회가 성공했으며, 수집한 `frontendMutationRevision`이 commit까지 유효하고 영속 commit이 성공한 뒤에만 ACK한다. CWD 조회 실패를 과거 `lastCwd`의 성공으로 축약하지 않는다. 수집 중 UI 구조 revision이 바뀌면 trailing pass로 다시 수집한다.
- `settings.json`은 계속 단일 영속 SoT다. 프론트 checkpoint는 현재 설정과 workspace/layout/dock 복원 projection을 한 후보로 보내되, Rust transaction은 최신 파일을 다시 읽어 backend-owned cloud identity path를 보존한 뒤 atomic replace한다. cloud pairing/disconnect writer는 같은 transaction 안에서 최신 파일에 자기 path만 patch하므로 checkpoint-owned projection을 stale payload로 되쓰지 않는다.
- 세 신선도 표지는 서로 대체하지 않는다. `frontendMutationRevision`은 수집한 UI 구조의 최신성을, 기존 settings optimistic revision은 Automation 설정 변경의 동시성을, 별도 opaque `checkpointCommitId`는 checkpoint가 실제로 디스크에 commit됐다는 ACK를 증명한다. 설정 revision을 checkpoint ACK나 barrier 성공 판정에 재사용하지 않는다.
- settings loader가 부분 복구 또는 parse 오류로 원본 보호 write-block 상태면 일반 checkpoint도 이를 우회하지 않는다. update barrier는 실패하고 hidden eviction은 연기하며, 정상 close는 원본을 덮지 않은 채 마지막 기존 파일로 종료한다. 사용자가 확인한 복구 또는 명시적 reset만 차단을 해제한다.
- settings transaction lock은 leaf다. 보유한 채 `AppState`나 다른 설정 gate를 획득하지 않는다. 파일·process I/O가 있는 checkpoint command는 UI event loop를 막지 않는 실행 context에서 돈다. 이 두 불변식은 Proposed ADR-0202의 상태와 무관하게 이 결정이 직접 소유한다.

### 통합 귀속 판정과 실패 의미

프론트에서 provider map과 activity를 합성하지 않고, 한 backend command가 provider별 정확 귀속과 fresh process-tree liveness를 모아 terminal별 PTY generation과 다음 상태 중 하나를 반환한다.

| 판정 | 의미 | 해당 pane의 영속 mutation |
|---|---|---|
| `Identified(provider, sessionId)` | 현재 generation의 실행 provider와 정확한 top-level session을 함께 증명 | 그 ID를 설정하고 다른 provider ID를 삭제 |
| `NoAgent` | 건강한 process/guest 관측이 지원 agent의 부재를 권위 있게 증명 | 모든 provider ID 삭제 |
| `ActiveButUnidentified` | provider 실행은 증명했지만 session 누락·불일치·중복·충돌로 정확한 ID를 검증하지 못함 | 잘못된 resume를 막기 위해 모든 provider ID 삭제 |
| `Unknown` | IPC·락·process enumeration·WSL probe·파일 I/O 실패, 관측 기회가 없는 pane, 또는 startup 귀속 대기 | 마지막으로 commit된 provider ID를 변경하지 않고 재시도 대상에 남김 |

- `Unknown`과 `NoAgent`를 같은 빈 map으로 축약하지 않는다. timeout·poison·probe unavailable은 부재의 증거가 아니므로 파괴적 삭제로 바꾸지 않는다. 다만 provider 저장소 건강 실패는 현재 live candidate/PID의 귀속에 영향을 주는 terminal ID 집합에 결부한다. 한 Claude PID의 파일 손상으로 다른 Claude PID, 다른 provider, shell terminal을 전역 `Unknown`으로 만들지 않는다. 반대로 건강한 관측에서 provider/session 충돌이나 검증 실패가 확인된 `ActiveButUnidentified`는 ADR-0118·0120의 fail-closed 원칙대로 옛 ID를 사용하지 않는다.
- 새 PTY generation, 특히 저장된 session으로 resume를 시작한 generation은 `sessionReady`만으로 `NoAgent`가 되지 않는다. resume startup override를 선택한 즉시 PTY 생성 완료보다 먼저 bounded grace를 시작하며, 그 기간의 `NoAgent`와 `ActiveButUnidentified`를 모두 startup 귀속 대기인 `Unknown`으로 승격한다. 정확한 session 귀속, 명백한 provider 종료, 또는 그 유예 뒤의 안정된 권위 shell 판정 중 하나가 있기 전에는 기존 resume ID를 삭제하지 않는다.
- live terminal이 없거나 아직 마운트되지 않은 pane도 관측 기회를 받지 못한 `Unknown`이다. 다른 workspace에 있다는 이유로 기존 ID를 지우지 않는다.
- `Identified`와 `NoAgent`만 해당 generation을 결론적으로 덮은 판정이다. `ActiveButUnidentified`는 일반 checkpoint에서 fail-closed 삭제를 commit할 수 있지만 attribution 미해결로 남고, `Unknown`은 기존 ID를 보존한 채 미해결로 남는다. 둘 다 파괴 전 barrier를 충족하지 못하며 다음 힌트 또는 watchdog에서 다시 관측한다.
- 하나의 checkpoint가 일부 pane을 미해결로 남겨도 다른 pane과 구조의 안전한 mutation은 commit할 수 있다. 프론트 조정기의 commit 결과는 `checkpointCommitId`, 수집 시점의 `frontendMutationRevision`, 상태별 terminal coverage를 보유한다. Rust 수명주기 요청에는 durable commit을 식별하는 `checkpointCommitId` 또는 오류만 ACK하고, 일반 스케줄러는 다음 trigger에서 미해결 pane을 재시도한다.
- 이 판정은 ADR-0195의 "권위 있게 agent가 없는 live pane은 shell로 복원한다"는 결과를 유지하면서, 삭제 SoT를 프론트 live set/activity 추정에서 backend의 generation 결부 `NoAgent`로 옮긴다. ADR-0135 activity reconcile의 표시 책임과 cadence는 바꾸지 않는다.

### 체크포인트 스케줄

조정기는 요청을 다음 세 등급으로 다룬다.

1. **보조 힌트** — CWD·복원 구조 변경, 실제 provider 경계의 activity 의미 전환, provider 내부 완료 source, workspace visibility/lifecycle 전환은 조정기에서 coalesce한다. 완료는 일반 알림 문자열로 추정하지 않고 provider provenance가 있는 내부 source에서 요청한다. workspace 진입 직후 저장은 startup 귀속 대기 pane의 기존 ID를 보존하고, 15초 유예 뒤 catch-up을 한 번 더 요청한다. 동일 activity를 다시 보내는 60초 full resync는 새 저장 이유가 아니다.
2. **최대 경과시간 안전망** — native watchdog이 5분마다 프론트 조정기에 checkpoint를 요청한다. eligibility와 coverage는 프론트 activity가 아니라 backend의 live PTY catalog를 포함하므로 activity가 shell로 틀려도 모든 live generation을 주기적으로 조회해 같은 provider 안의 `/clear`를 발견한다. OS suspend 뒤에는 지연된 watchdog과 frontend visibility catch-up 중 먼저 실행되는 경로가 저장을 요청한다. 정확한 운영값은 선언 상수와 living doc이 소유한다.
3. **파괴 전 barrier** — 앱이 live 귀속 증거를 없애기 전에 일반 요청을 drain하고, 아래 finalization fence를 세운 뒤 최신 application-observable checkpoint ACK를 기다린다. critical barrier는 일반 debounce를 우회하지만 같은 순서화 경계를 우회하지 않는다.

장주기와 보조 checkpoint의 필수 범위는 복원 메타데이터다. xterm scrollback 직렬화는 비용과 정확성 경계가 다르므로 같은 cadence에 묶지 않는다. 정상 close나 update처럼 필요할 때 기존 출력 cache 흐름이 별도 단계로 실행될 수 있다.

### 수명주기와 실패 정책

- **finalization fence**는 Rust의 공통 operation gate가 소유한다. mutation은 admission permit을 전 수명 동안 보유하며, fence는 먼저 새 Local·Remote·Automation·MCP terminal input과 Automation frontend action을 거부하고 이미 승인된 permit, controller operation 및 timeout/fault 뒤 아직 종료되지 않은 live PTY worker와 registry에서 제거된 retired worker completion을 최대 16초 drain한다. fence 중 terminal create와 TerminalView unmount의 일반 close는 새 mutation으로 승인하지 않고 admission 밖에서 취소까지 대기시킨다. checkpoint가 실패해 fence가 풀리면 normal permit을 얻어 생성 또는 backend PTY 정리를 완료하고, update가 성공하면 process cleanup이 소유하므로 삭제된 pane의 close 실패를 고아 PTY로 남기지 않는다. close는 mutation permit을 놓기 전에 fault 여부와 무관한 control worker completion을 별도 격리 목록에 등록해, handle 제거 뒤 시작된 fault도 live registry와 retired 목록 사이에서 사라지지 않게 한다. Windows child wait와 PID 기반 tree kill은 handshake로 상호 배제하고, kill claim이 끝날 때까지 wait thread가 OS process handle을 보존해 PID 재사용으로 무관한 process tree를 종료하지 않는다. Windows process-tree helper도 별도 유계 deadline을 가지며, 외부 `taskkill` 정지가 hidden eviction의 전역 fence를 무기한 붙잡을 수 없다. REST/MCP뿐 아니라 lx group command·sync-CWD 주입·xterm protocol reply도 같은 admission을 통과하고, sync-CWD permit은 PTY write 뒤의 propagation marker·authoritative CWD 갱신·event 발행까지 전체 논리 mutation을 덮는다. 종료 전용 ETX만 명시적 예외다. Automation frontend action은 HTTP 5초 waiter가 먼저 timeout되어도 늦은 `automation_response`가 올 때까지 detached permit을 유지한다. 그 뒤에만 checkpoint를 시작한다. 프론트 구조가 관측 중 바뀌면 revision 검사가 trailing checkpoint를 강제한다. drain·checkpoint 실패, timeout 또는 install 전 중단 시 fence를 해제한다.
- 파괴 전 barrier는 drain 뒤 bounded settle을 두고 대상 generation의 통합 귀속을 두 번 관측한다. 두 관측의 generation과 결론적 상태(`Identified`면 provider/session ID까지)가 같아야 하며, 달라지거나 하나라도 미해결이면 실패한다. checkpoint는 두 번째 generation-valid 관측 결과를 저장한 시점에 선형화되고 `checkpointCommitId`는 그 durable commit을 식별한다.
- 실행 중 provider와 shell은 fence 뒤에도 스스로 출력하거나 CWD·session state를 바꿀 수 있고, PTY write 완료는 provider가 명령 처리를 끝냈다는 ACK가 아니다. 이 결정은 process를 suspend하거나 provider protocol을 주입하지 않는다. 따라서 barrier가 보장하는 최신성은 **fence 이전에 앱이 승인한 mutation을 drain한 뒤 관측 가능한 상태**까지다. snapshot 관측 뒤의 자율 변화는 보장 범위 밖이며, ACK 뒤 다른 작업을 끼우지 않고 즉시 자식 정리로 넘어가 그 창을 최소화한다.
- **자체 업데이트**의 공통 Desktop·Automation·Remote 순서는 `요청 수락 → download → 서명 검증 → 가역 finalization fence → critical checkpoint ACK → platform updater cleanup → install/restart`다. Windows cleanup은 자식/probe PTY 정리와 file-lock wait를 포함한다. 다운로드 중에는 앱과 일반 checkpoint를 계속 사용한다. 서명 검증 전 download callback이나 updater의 동기 `on_before_exit`에서 비동기 snapshot을 시작하지 않는다.
- checkpoint 실패·timeout·프론트 부재·미해결 live terminal이 있으면 자식 정리와 installer를 시작하지 않고 update를 재시도 가능한 오류로 끝낸다. fence를 해제해 일반 저장과 앱 사용을 재개한다. 이는 Remote lease가 설치 요청 수락 시 선형화되고 이후 만료와 무관하다는 ADR-0174의 권한 계약을 바꾸지 않는다. 설치의 로컬 전제조건을 충족하지 못한 것이다.
- Windows의 자식/probe PTY 정리와 bounded file-lock wait는 ADR-0201대로 updater `on_before_exit`에서 수행한다. Linux는 설치가 끝난 뒤 Tauri restart cleanup을 따른다. 어느 플랫폼에서도 checkpoint보다 먼저 자식을 죽여 귀속 증거를 없애지 않는다.
- **숨김 terminal eviction**은 frontend unmount가 아니라 backend transaction이 보수적인 전역 fence와 drain, 대상 conclusive checkpoint, 대상 PTY close를 연속 소유한다. 여러 대상의 registry retirement는 같은 gate 아래 수행하되 유계 platform teardown은 병렬로 실행해 fence-held 시간이 pane 수에 선형으로 늘어나지 않게 하며, scope guard가 오류·worker panic을 포함한 모든 반환에서 fence를 해제한다. 프론트는 checkpoint ACK 직전에 timer owner가 공개한 최신 연속 숨김 epoch와 현재 timeout으로 대상이 실제 만료 상태인지 재검증한다. timeout 증가나 hidden→visible→hidden ABA로 만료 자격이 사라졌으면 오류 ACK하고 PTY를 보존한다. backend가 실제로 닫았다고 반환한 pane만 unmount한다. 동시에 visibility·timeout이 바뀌어 이미 닫힌 pane은 eviction set에 반영하고 현재 hook이 그 전이를 즉시 재평가해 remount한다. 정리된 과거 effect의 늦은 응답도 다음 timer까지 죽은 PTY를 참조하게 하지 않는다. 실패 대상은 다음 timer에서 재시도한다. 리소스 최적화가 복원 정보를 파괴할 권한은 없다.
- **정상 window close**는 metadata checkpoint를 optional terminal interrupt보다 먼저 확정하고, interrupt 뒤 scrollback cache를 저장하는 기존 두 단계 순서를 유지한다. 이미 실행 중인 일반 checkpoint와 trailing 요청까지 drain한다. 사용자의 명시적 close를 영구히 막지 않도록 기존 유계 close wait 안에서 시도하고, 실패·timeout이면 마지막으로 성공한 checkpoint를 보존한 채 종료하는 best-effort 정책을 사용한다.
- callback을 실행할 수 없는 process kill·OS crash는 마지막 성공 checkpoint 이후의 변경을 잃을 수 있다. 최대 경과시간은 이 손실 상한을 줄이는 복구 목표이며, 전원 상실까지의 물리 저장 내구성은 별도 결정이다.

### 리뷰에서 확정한 실패 보존과 승인 경계

- Automation REST의 direct terminal write와 MCP `write_to_terminal`/`execute_command`도 공통 mutation admission을 통과한다. permit은 실제 PTY write와 분할 body/CR 지연이 끝날 때까지 유지하며, finalization fence 이후 도착한 입력은 side effect 전에 거절한다.
- provider 조회기는 attribution map과 별도로 조회 건강 상태를 반환한다. process enumeration, native/WSL session file·DB parse/I/O, 명시/default WSL distro 결정, WSL probe 중 하나라도 실패하면 통합 판정은 영향 범위를 파괴적 부재로 축약하지 않고 `Unknown`으로 만든다. 따라서 일반 checkpoint는 기존 ID를 보존하고 critical checkpoint는 실패한다.
- 통합 command의 Claude·Codex·Grok provider 조회는 동시에 시작해 각 adapter의 bounded WSL probe가 정상 close의 5초 예산 안에서 하나의 3초 wall-clock budget을 공유하게 한다. 세 adapter를 직렬로 실행해 예산을 3배로 늘리는 것은 금지한다. critical 이중 관측도 같은 이유로 backend의 20초 ACK 예산 안에 남는다.
- StrictMode effect 교체 중 정리된 checkpoint listener로 이미 전달된 request도 명시적 오류 ACK를 보낸다. 정리된 callback이 침묵해 backend timeout 전체를 소비하게 하지 않는다.
- `Recovered` settings는 frontend checkpoint와 cloud pairing/disconnect를 포함한 일반 backend transaction 모두가 덮어쓸 수 없다. loader는 사용자가 본 원문에 결부된 opaque recovery revision을 반환하고, `acknowledge_settings_recovery`는 현재 원문의 revision이 그 값과 같을 때만 해당 복구 결과를 atomic replace한다. 모달을 연 뒤 원문이 바뀌면 승인 요청을 거절하고 최신 dropped path 목록을 다시 표시해 새 revision의 명시적 승인을 요구한다. 성공하면 같은 snapshot으로 backend Remote access·cloud tunnel·update channel runtime을 재조정한 뒤 반환하며, 프론트는 반환 snapshot을 구조 상태까지 적용한 뒤에만 write-block을 해제한다. 명시적 reset은 별도 복구 경로로 유지한다.

## Alternatives Considered

- **기존 `persistSession()`을 update·완료·workspace·timer에서 더 자주 호출한다.** 변경량은 작지만 async snapshot 완료 역전, whole-settings lost update, 조회 실패와 부재의 혼동을 그대로 증폭한다. 잘못된 복원점을 더 자주 확정할 수 있어 기각한다.
- **정상 종료와 update 직전에만 저장한다.** 통제 가능한 종료는 고치지만 crash·강제 종료와 이벤트 없는 같은-provider `/clear`의 손실 상한이 없다. 장주기 안전망을 함께 둔다.
- **완료·activity·workspace 이벤트만 저장한다.** 완료는 provider별로 누락되거나 휴리스틱일 수 있고 workspace 진입은 attribution-ready 경계가 아니다. 같은 provider 안의 session 전환은 activity 변화도 없다. 이벤트는 latency를 줄이는 힌트로만 사용한다.
- **고정 간격 timer만 사용한다.** 통제 가능한 update·eviction 직전 최신성을 보장하지 못하고, 중요한 이벤트 뒤에도 다음 tick까지 기다린다. 5분 watchdog에 이벤트 힌트와 파괴 전 barrier를 결합한다.
- **ADR-0135 activity reconcile에 session ID 조회를 합친다.** 표시 liveness의 3초 cadence와 provider 저장소·WSL 귀속의 비용을 결합하고, 60초 full resync의 의미도 흐린다. activity와 session identity는 서로 다른 cadence와 실패 의미를 유지한다.
- **별도 `cache/session-checkpoint.json`을 만든다.** settings writer 경합은 피하지만 `settings.json`과 두 개의 영속 SoT, startup overlay 우선순위, 정리·복구 규칙이 새로 생긴다. 최신 settings에 좁은 transactional projection을 병합해 단일 정본을 유지한다.
- **agent hook이나 알림으로 session ID를 직접 받는다.** 정확할 수 있지만 사용자/provider 설정을 강제하고 모든 종료·crash·provider를 포괄하지 못한다. 향후 공식 session-change API가 생기면 보조 source로 추가할 수 있지만 정본으로 삼지 않는다.
- **updater `on_before_exit`에서 checkpoint한다.** Windows의 동기 종료 직전 callback은 async frontend 수집과 실패 복구에 너무 늦고 Linux에 같은 호출을 보장하지 않는다. 다운로드와 서명 검증 뒤, 파괴적 finalization 전에 공통 pipeline이 barrier를 소유한다.

## Consequences

- Remote·Desktop·Automation 어느 표면에서 update를 시작해도 installer가 최신으로 증명된 복원점 뒤에서만 실행된다. 숨김 eviction도 저장보다 먼저 PTY를 없애지 않는다.
- 정상 이벤트가 없더라도 live PTY catalog는 5분 watchdog에서 다시 조회된다. crash 시 손실 가능한 변경 범위도 마지막 성공 checkpoint 이후로 줄어든다. 이벤트 힌트가 있으면 보통 더 짧고, suspend 뒤에는 지연 watchdog 또는 첫 foreground에서 catch-up한다.
- `/clear`처럼 activity가 변하지 않는 전환도 주기 귀속 조회가 발견한다. activity 재판정은 계속 표시 drift만 책임지므로 두 cadence와 비용이 서로 묶이지 않는다.
- 일시적인 IPC·락·WSL probe 실패는 마지막으로 증명된 ID를 파괴하지 않는다. 반대로 건강한 관측에서 agent 부재나 정확한 session 검증 실패가 확인되면 stale·모호한 ID를 지워 잘못된 resume보다 새 session을 선택한다.
- 체크포인트 조정기, `frontendMutationRevision`·기존 settings optimistic revision·`checkpointCommitId` 분리, generation 결부 통합 귀속 snapshot, settings transactional merge라는 내부 계약이 추가된다. 구현은 저장 경로가 늘어나는 대신 판정과 commit 경계를 한 곳으로 모은다.
- 최대 경과시간마다 provider 저장소와 WSL을 읽는 비용이 생긴다. 통합 command, single-flight/coalescing과 5분 cadence로 중복 scan과 write를 제한한다. 이 값은 대형 저장소·다수 pane·WSL에서 latency와 UI 비차단을 측정한 뒤 조정한다.
- 상시 lifecycle/revision fence와 attribution coverage가 startup bundle에 포함되어 최신 main의 엔트리 예산을 518.5kB에서 521kB로 올린다. 기능 증가분만 수용하고 동일한 소폭 headroom 정책은 유지한다.
- update와 hidden eviction은 귀속을 증명하지 못하면 지연·실패할 수 있다. 사용자는 정보를 잃는 성공보다 이유가 드러나는 재시도를 받는다. 정상 close만은 unclosable app을 만들지 않기 위해 bounded best-effort로 남는다.
- finalization fence는 앱이 승인하는 mutation을 막고 두 번의 안정 관측을 요구하지만 provider process 자체를 suspend하지 않는다. 두 번째 관측 뒤 자식 정리 전의 자율 session 변화는 좁은 잔여 race다. 이를 0으로 만들려면 provider별 quiescence protocol이나 process suspension이라는 별도 크로스플랫폼 결정을 도입해야 한다.
- rollout은 먼저 통합 귀속 상태와 settings transaction 및 조정기 순서화를 구현·검증한 뒤, 파괴 전 barrier, 마지막으로 이벤트·주기 trigger를 활성화한다. 안전한 판정 없이 자동 저장 빈도부터 늘리지 않는다.
- 회귀 테스트는 최소한 다음을 고정한다: `Identified`/`NoAgent`/`ActiveButUnidentified`/`Unknown` mutation·barrier 표, 권위 shell 삭제와 terminal/PID별 조회 실패 보존, terminal 등록 전 전역 조회 실패도 critical 거부, 같은 PID의 새 top-level session 선택, critical 이중 안정 관측과 all-live 범위 우선, 늦은 옛 snapshot의 역전 금지와 trailing rerun, checkpoint/cloud path merge, recovery write-block, finalization의 신규 mutation 거부와 승인 작업 drain, Windows child-exit/kill handshake, ACK 전 timeout·hidden epoch 변화 시 PTY 유지, trigger burst coalescing.
- 구현 PR은 [architecture/data-flow.md](../architecture/data-flow.md)의 activity·update·session persistence·hidden eviction 흐름과 필요하면 [architecture/api-contracts.md](../architecture/api-contracts.md)의 내부 command/settings transaction 계약을 함께 갱신한다. PR 직전 최신 `main`에서 ADR 번호 충돌과 이 ADR의 Decision/Consequences가 코드·테스트·living doc에 일치하는지 다시 확인한다.
- provider가 공식적이고 저비용인 session-change API를 제공하거나, settings와 runtime cache의 영속 수명주기를 분리해야 할 근거가 생기거나, 측정상 주기 attribution 비용이 복구 목표를 만족할 수 없으면 이 결정을 재검토한다.
