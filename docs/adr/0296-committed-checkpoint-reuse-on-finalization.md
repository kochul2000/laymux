# 0296. 변경 없는 저장 완료 복원점을 종료·업데이트에서 재사용한다

- Status: Accepted
- Superseded by: [ADR-0299](0299-portable-settings-and-local-sqlite-state.md), settings.json 복원 상태 SoT 및 저장 완료 receipt의 영속 revision 경계에 한정한다.
- Date: 2026-10-07
- Source: 사용자 “이미 세션 저장이 되어 있으면 건너뛰면 되잖아” 요구, [ADR-0222](0222-agent-session-checkpoint-coordinator.md), [ADR-0295](0295-codex-continuous-conversation-checkpoint.md), architecture/data-flow.md §13.5
- 관계: ADR-0222의 critical 이중 관측에 저장 완료 receipt 재사용 예외를 추가한다. 입력 fence·drain·저장 후 인터럽트 순서는 유지한다.

## Context

일반 저장에서 현재 Codex 대화와 파일을 확인해 디스크 commit을 완료해도 종료는 같은 WSL·DB 조회와 이중 관측을 다시 수행한다. 실제 native·WSL 두 pane의 종료 준비는 6.271초였다. 이미 저장한 복원점과 현재 앱이 관찰한 상태가 동일하면 이 비용은 불필요하다. 과거 settings ID만으로 임의의 새 실행을 통과시키거나, 아직 저장하지 않은 변경을 저장 완료로 처리해서는 안 된다.

## Decision

**Rust가 발행한 저장 완료 receipt와 현재 관찰 상태가 일치하면 종료·업데이트는 해당 commit을 재사용한다.**

- receipt는 일반 checkpoint 수집 전에 캡처한 PTY catalog·generation·인간 입력 revision·live 제목 revision·원시 제목·실행 명령 상태·CWD·훅 힌트 revision에 결부한다. settings 저장 성공 뒤 같은 상태이고, 모든 live terminal이 파일로 확인된 유일한 Codex 대화 또는 실행 중인 명령이 없는 확인된 셸이며 디스크의 해당 pane 복원점이 일치할 때만 발행한다. 셸의 NoAgent도 해당 capture 이후 backend의 실제 귀속 조회가 확인한 결과를 요구한다.
- 실제 귀속 조회가 검증한 rollout 경로와 파일 fingerprint를 사용한다. 설정·rollout 파일 부재/변경/조회 실패는 재사용을 취소한다. receipt와 파일 경로는 메모리 전용이며 재기동 시 재사용하지 않는다. settings.json이 영속 SoT다.
- 종료·업데이트는 입력 fence와 기존 admission drain을 먼저 확보하고 receipt의 현재 상태·파일 fingerprint를 확인한다. 성공하면 WSL·DB 조회, 화면 입력, critical 이중 저장 관측과 같은 settings 재쓰기를 생략한다. 터미널 기록 저장과 기존 인터럽트·프로세스 정리는 계속 수행한다.
- 새 입력, 대화 전환, PTY 생성/교체/종료, CWD·훅·설정 변화, 저장 중 상태 변화, 부분 귀속, 중복 소유권, 실패한 저장, 재기동은 receipt를 사용할 수 없다. 빠른 확인에 실패하면 기존 검증을 수행하며 오류를 저장 성공으로 합성하지 않는다.
- 프론트는 성공 commit의 frontend revision과 receipt token만 보관한다. 현재 revision과 같을 때만 토큰을 제시하며, 재사용 여부는 Rust가 결정한다. 이 IPC는 앱 내부 수명주기 계약이며 Automation/Remote에 임의 receipt 등록 창구를 추가하지 않는다.
- 빠른 경로는 앱이 관찰한 생명주기와 파일 변화를 기준으로 last committed 대화를 보존한다. 새로운 OS 프로세스·DB snapshot을 마지막에 다시 요구하지 않는다. 변경 없는 저장 완료 상태를 빠르게 종료하라는 요구에 따른 정확성/지연의 선택이며, 기존 검증은 변경된 상태의 fallback이다.

## Alternatives Considered

- 디스크 ID가 있으면 무조건 종료: `/new`, 다른 resume와 PTY 교체 뒤 과거 대화를 재사용한다.
- frontend revision만 확인: backend 입력·OSC·훅 전환을 놓친다.
- timeout 증가 또는 마지막에 DB를 한 번 더 조회: 이미 저장한 상태의 반복 I/O 비용을 남긴다.
- 영구 캐시/별도 PTY daemon: 재기동 proof와 영속 스키마를 확대하며 변경 없는 종료의 직접 해결책이 아니다.

## Consequences

변경 없는 Codex·대기 셸 복원점은 메모리 비교와 파일 metadata 확인으로 종료한다. 변경된 상태는 기존 보수적 검증을 유지한다. 대신 receipt 소유권, 입력 revision, 저장 전후 상태, 파일 변경, update 요청 소유권과 실패 시 fence 해제를 테스트해야 한다. 미식별·실행 명령·다른 활성 provider가 섞인 catalog는 현재 범위에서 빠른 경로 대상이 아니다. 마이그레이션은 없다. 외부에서 앱에 관찰되지 않은 대화 변경이 가능한 실행 방식이 생기면 receipt 무효화 신호를 확장하거나 해당 실행을 재사용 대상에서 제외한다.
