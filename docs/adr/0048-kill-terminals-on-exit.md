# 0048. 앱 종료 시 터미널 인터럽트(kill-on-exit)는 프론트엔드가 스크롤백 캐시 앞에서 조율한다

- Status: Accepted
- Date: 2026-07-19
- Source: issue #451, architecture/api-contracts.md §10(Settings), ADR-0004(설정 vs UI 상태 분리)

## Context

사용자는 laymux 종료 시 각 터미널에서 돌아가던 작업(cron, claude/codex 에이전트)을
Ctrl+C 로 정리하고 싶어 한다(issue #451). 두 가지 효용이 있다.

- 효용 A: 장기 실행/백그라운드 작업을 우아하게 종료.
- 효용 B: Ctrl+C 를 여러 번 받은 claude/codex 가 `--resume <session-id>` 힌트를
  스크롤백에 출력 → 다음 실행에서 세션 재개 가능.

효용 B 가 성립하려면 "Ctrl+C 전송 → 세션 ID 출력 대기 → 스크롤백 직렬화·캐시" 순서가
보장돼야 한다. 현재 종료 흐름에서 스크롤백 직렬화(`saveBeforeClose`)와 CWD/세션 영속은
**프론트엔드**가 소유하며, 창 close 는 `onCloseRequested` 훅이 preventDefault 후
저장하고 destroy 한다. PTY 로의 바이트 쓰기는 `write_to_terminal` 커맨드가 담당한다.

파괴적 동작이므로 기본값과 트리거 경로를 신중히 정해야 한다. 범위는 "종료 시 실행 중
터미널 작업 인터럽트 + 설정 토글"이며, 프로세스 강제 kill(`kill -9`), claude/codex 외
앱별 특수 처리는 비목표다.

## Decision

kill-on-exit 는 **프론트엔드 종료 흐름이 조율**하고, PTY 인터럽트는 기존
`write_to_terminal` 경로로 ETX(0x03)를 쓰는 방식으로 구현한다. Rust 쪽에
별도 `RunEvent::ExitRequested`/`on_window_event` 인터럽트 경로를 두지 않는다.

- **SoT·순서:** `saveBeforeClose()` 최상단에서 `interruptTerminalsOnExit()` 를 먼저
  await 한 뒤 스크롤백을 직렬화한다. 인터럽트→대기가 직렬화보다 앞서야 세션 ID 가
  캐시에 담기기 때문이다(효용 B). 인터럽트는 `settings.exit.interruptTerminals` 가
  켜졌을 때만 동작하고, 꺼져 있으면 빠른 no-op 이다.
- **대상:** 특정 앱을 감지하지 않고 열린 모든 터미널(`terminalStore.instances`)에
  보낸다. 유휴 셸에 가는 Ctrl+C 는 무해하고, cron/agent 를 놓치지 않는다.
- **바이트 경로:** 인터럽트는 종료 전용 커맨드 `interrupt_terminal_on_exit` 로
  `PtyHandle::write` 를 호출해 0x03 을 PTY FIFO 에 바로 쓴다. ConPTY/line
  discipline 이 이를 포그라운드 앱에 대한 실제 Ctrl+C 로 전달한다. 일반 키 입력
  경로(`write_to_terminal`, `HumanControlOrigin::Local`)를 쓰지 않는 이유는, 원격
  제어 lease/claim 이 활성일 때 Local write 가 거부되어(`Promise.allSettled` 에
  묻혀) ETX 가 하나도 전달되지 않기 때문이다. 종료 시 로컬 프로세스는 원격 소유권과
  무관하게 자식 프로세스를 정리할 정당한 권한이 있으므로, 이 경로는 owner 게이트를
  의도적으로 우회하며 ETX 만 보낼 수 있다.
- **설정 계약:** 사용자 구성이므로 `settings.json` 최상위 `exit` 객체에 둔다
  (ADR-0004: 구성은 settings.json, UI 상태는 localStorage). 필드는
  `interruptTerminals`(bool, 기본 **false**), `interruptRounds`(u32, 1..=10, 기본 3),
  `settleMs`(u64, 0..=10000, 기본 700). Rust 가 스키마·기본값·검증(applyMode=`live`)을
  소유하고, describe/validate/update_settings MCP 계약을 그대로 따른다. Ctrl+C 간
  간격은 설정이 아니라 상수(120ms)다.
- **기본값:** 파괴적 동작이므로 opt-in(off). 켜졌을 때만 여러 번(기본 3회) 전송하고,
  claude/codex 가 세션 ID 를 출력할 여유(기본 700ms)를 준 뒤 창을 닫는다.
- **실패·타임아웃:** 인터럽트는 best-effort 다. 개별 write 실패가 나머지 터미널
  인터럽트를 막지 않고(`Promise.allSettled`), 예외는 삼켜 창 close 를 막지 않는다.
  종료 저장 타임아웃은 인터럽트 예산(`rounds*간격 + settleMs`)만큼 넓혀 설정된 settle
  지연이 잘리지 않게 한다.

## Alternatives Considered

- **Rust `RunEvent::ExitRequested`/`on_window_event` 에서 인터럽트:** 프론트가 이미
  preventDefault→저장→destroy 로 close 를 소유하므로 이중 조율이 된다. 결정적으로,
  세션 ID 를 캐시에 담으려면 스크롤백 직렬화(프론트 소유)보다 앞서야 하는데, Rust
  훅에서는 그 순서를 보장하기 어렵다. 기각.
- **claude/codex 만 감지해 전송:** 감지 실패·확장성 문제. 유휴 셸에 대한 Ctrl+C 는
  무해하고 cron 등 비-agent 작업도 정리 대상이므로 전 터미널 전송이 단순·안전. 기각.
- **강제 프로세스 종료(kill tree):** 놀라움이 크고 데이터 유실 위험. Ctrl+C 우선
  원칙에 어긋나 비목표.
- **단일 boolean 만 노출:** 효용 B 는 settle 지연에, 효용 A 는 전송 횟수에 민감하다.
  실제로 동작에 영향을 주는 이 둘만 clamp 된 숫자 설정으로 노출하고 간격은 상수로 둔다.

## Consequences

- 종료 시 최대 `rounds*120ms + settleMs`(기본 ~1.06s)만큼 창 닫힘이 지연될 수 있다.
  기본 off 이므로 미사용자는 영향 없고, 저장 타임아웃을 예산만큼 넓혀 잘림을 막는다.
- 효용 B 는 claude/codex 가 Ctrl+C 에 세션 ID 를 출력하는 동작에 의존한다. 그 동작이
  없으면 스크롤백에 ID 가 안 남을 뿐 종료·정리(효용 A)에는 영향이 없다.
- 새 설정 `exit` 는 Rust 스키마/검증 + 프론트 store/snapshot/SettingsView + i18n 을
  일관되게 확장한다(다른 섹션과 동일 패턴). settings.json 마이그레이션은 없다(내부
  개발 단계 정책, serde default 로 구버전 파일 호환).
- 재검토 조건: 특정 앱별 종료 프로토콜(예: 세션 ID 확정 신호 감지)이 필요해지거나,
  Rust 측에서 창 close 를 소유하도록 종료 아키텍처가 바뀌면 이 결정을 다시 본다.
