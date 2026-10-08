# 0303. 데몬 세션 writer는 구조 revision과 source 관측을 결합한다

- Status: Proposed
- Date: 2026-10-08
- Source: 사용자 PR #1143 완주 지시, [ADR-0300](0300-detached-pty-daemon-update-handoff.md), [ADR-0302](0302-pty-daemon-gui-projection-and-control-barriers.md), [data-flow §13.5](../architecture/data-flow.md#135-체크포인트-조정과-파괴-전-barrier)
- 관계: ADR-0301의 private protocol 1을 개발 중 protocol 2로 확장하고 ADR-0300·0302의 단일 세션 writer와 구조 제출을 구체화한다. 기본 앱의 ADR-0299 구성/session 분리는 유지한다.

## Context

현재 dev adapter는 GUI에 실제 PTY가 없어도 SQLite session을 직접 저장한다. GUI가 떠나면 CWD·대화 변경이 저장되지 않으며, 늦은 GUI snapshot이 새 구조를 덮을 수 있다. source 귀속 조회가 연결됐어도 GUI가 보낸 coverage·제목·CWD는 저장 증거가 아니다. 느린 provider 조회나 SQLite busy가 사용자 입력 FIFO까지 점유해서도 안 된다.

범위는 private IPC의 구조 제출, daemon의 session commit과 detached 갱신이다. 설정 구성 writer는 GUI에 남으며 새로운 SQLite 스키마나 자동 마이그레이션은 만들지 않는다. 새 private 계약을 이해하지 못하는 기존 개발 데몬을 강제로 종료하지 않는다.

## Decision

**GUI는 attachment별 단조 구조 revision을 제출하고, daemon 하나가 현재 구조와 실제 source 귀속·CWD를 결합하여 session SQLite를 저장한다.**

- private protocol은 2로 올린다. 구조 제출은 입력 control 연결과 독립된 인증 연결의 별도 request다. incarnation·attachment epoch·connection과 원본 owner liveness를 확인한다. 구 protocol 발견은 typed 오류이며 살아 있는 작업을 재시작하거나 교체하지 않는다.
- GUI 구조 revision은 GUI gateway 수명에서 단조 증가한다. daemon은 attachment별 최신 제출 revision을 예약하며 같거나 오래된 제출을 거절한다. I/O 완료가 역전되면 최신 예약보다 오래된 결과는 DB를 쓰지 않는다. 실패한 revision의 ACK를 성공으로 합성하지 않으며 재시도는 새 revision을 사용한다.
- GUI의 coverage는 대상 generation을 확인하는 용도로만 사용한다. provider/state/session ID·CWD는 source에서 재관측한다. 제출 generation이 source와 다르면 저장을 거절한다. 모호한 provider와 관측 실패는 기존 Unknown 보존 계약을 따른다. source에 아직 없는 pane은 Unknown이며 이전 검증 복원점을 보존한다.
- provider I/O 중 owner gate·terminal lifecycle gate·writer mutex·AppState 락을 보유하지 않는다. 결과 반영 직전에 owner·최신 구조 revision·source generation을 재검사한다. source create/close와 최종 DB commit은 별도 terminal lifecycle gate로 직렬화하며, 입력·resize는 이 gate를 사용하지 않는다.
- GUI 제출의 최종 반영 중에는 새 attachment와 detach를 승인하지 않는다. 연결이 끊기면 늦은 관측은 저장하지 않는다. 이미 시작한 atomic commit은 새 owner 승인 전에 끝내므로 이전 GUI의 commit이 새 GUI의 구조 뒤에 도착하지 않는다.
- writer는 마지막 성공한 구조를 메모리와 DB에서 유지한다. GUI가 없어도 source identity 힌트와 주기적 확인으로 CWD·대화를 저장한다. 구조 제출과 background 결과는 같은 revision 검사·commit 직렬화를 사용하며 background 관측이 새 GUI 구조를 되돌리지 않는다.
- background 확인은 1초부터 최대 30초까지 실패 backoff를 적용하고 5초 watchdog으로 source 변화를 확인한다. 동일 관측이 유지되면 불필요한 DB revision을 만들지 않는다. GUI 구조 제출은 동일 내용이라도 실제 durable commit ACK를 반환한다.
- DB busy·손상·FULL과 확인 실패를 호출자·진단 상태에 전달한다. 실패한 저장은 이전 구조·DB revision을 갱신하지 않는다. Unknown partial commit은 저장 가능한 구조이며 정상 인계에서 허용하지만, 실제 파괴의 conclusive barrier를 대체하지 않는다.

## Alternatives Considered

- GUI session writer 유지: GUI 미접속 중의 갱신과 늦은 snapshot 차단을 보장하지 못한다.
- 구조와 입력을 같은 순차 RPC에 배치: provider 조회가 사용자 입력의 head-of-line 지연이 된다.
- GUI coverage를 그대로 commit: mirror의 PID·제목과 오래된 generation을 source 증거로 채택하게 된다.
- DB revision만 비교: background 대화 갱신과 GUI 구조 변경을 구별하지 못해 유효한 새 구조를 거절하거나 오래된 구조를 허용한다.
- I/O 전체에 owner/catalog 락 유지: 입력·출력·handoff가 provider/디스크 지연에 종속된다. 짧은 최종 lifecycle/commit 단계만 직렬화한다.

## Consequences

관측 시작의 source hint·입력 revision을 최종 commit 전에 재검증한다. 같은 PTY generation 안에서 대화나 입력이 바뀐 느린 관측도 복원점으로 채택하지 않고 재시도한다.

GUI crash·업데이트 중에도 복원점이 갱신되고 새 GUI의 구조가 늦은 이전 결과에 덮이지 않는다. 기존 구성 writer와 DB의 atomic Unknown 보존을 재사용한다.

대신 구조 예약·generation 재검사·background worker와 관측 오류 상태를 관리해야 한다. 실 IPC에서 stale revision/owner/generation, I/O 완료 역전, DB busy/손상/FULL, detached CWD·대화 갱신과 입력 독립성을 검증한다. 인계 ACK와 receipt는 이 writer의 실제 commit revision에 결합하는 후속 구현이다. multi-GUI 동시 편집이나 다른 daemon으로 live 구조를 이관하게 되면 새 ADR로 재검토한다.
