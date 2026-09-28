# 0278. Codex 종료 확인은 명령 실행 후 현재 화면을 읽는다

- Status: Proposed
- Date: 2026-09-28
- Source: 사용자 요청(반복 `/status`의 현재 화면 직접 판독), [실측 기록](../codex-status-input-repro-2026-09-28.md), [data-flow §13.5](../architecture/data-flow.md)
- Supersedes: [ADR-0270](0270-codex-status-checkpoint-probe.md)의 새 출력 바이트만으로 전체 카드를 확인한다는 조건. 나머지 종료 확인 정책은 유지한다.

## Context

Codex 0.157.1의 반복 `/status` 화면에는 전체 Session UUID가 정상 표시된다. 같은 셀을 재사용하는 차분 출력에는 명령 echo, 헤더, UUID가 모두 없을 수 있다. Enter 이후 바이트만 읽는 방식은 이 정상 동작을 실패로 처리한다. 입력 키를 바꾸거나 기다려도 이미 표시된 셀이 다시 출력된다는 보장은 없다.

사용자는 현재 화면을 직접 읽도록 요청했다. 기존 xterm 화면 재구성 경로는 PTY generation, 출력 sequence, geometry를 함께 제공한다. 이를 이용하되 입력 전의 과거 카드, 진행 중인 repaint, 이전 프로세스의 화면을 현재 대화로 채택해서는 안 된다. 초안 삭제는 이미 허용된 종료 옵션의 범위다.

## Decision

종료·업데이트 확인은 Status builtin의 선택과 실행을 확인한 뒤, 현재 xterm 화면의 마지막 완전한 `/status` 카드에서 전체 UUID를 읽는다.

- backend가 입력 fence, 조회 토큰, 대상 프로세스·PTY generation, 제출 직전 출력 경계와 원래 geometry를 소유한다. submit 응답은 화면 재구성의 기준 generation·sequence·geometry를 반환한다.
- frontend는 기존 rendererless xterm checkpoint provider를 재사용한다. 이 모델은 화면과 같은 PTY 바이트를 누적 적용한다. 현재 viewport만 직렬화하며 스크롤백을 후보로 보내지 않는다. 제출 경계를 지난 화면이 잠시 안정된 뒤 backend에 전달한다.
- backend는 화면의 generation·geometry와 현재 출력 sequence를 확인한다. 제출 전·수집이 뒤처진 화면은 확정하지 않으며 미래 sequence·세대 변경·크기 변경·범위 초과는 거절한다. 마지막 명령의 카드가 완성되고 선택 팝업이 사라져 composer로 돌아온 화면만 읽는다. 더 오래된 카드로 fallback하지 않는다.
- UUID·rollout의 최상위 역할·Fresh 확인, 프로세스 재검증, 중복 귀속 배제, 최종 저장과 fence 수명의 기존 계약을 유지한다. 화면 전체가 새 바이트로 다시 출력될 필요는 없다.
- 초안은 기본 키맵의 Backspace·Delete를 유계 전송해 지운다. 지원하는 선택 메뉴는 화면 확인 후 Esc로 닫는다. `/statu` 입력 후 실제 `/status` builtin 선택을 확인해야 Enter를 한 번만 전송한다. 실행 중 작업·첨부·Vim·알 수 없는 모달에서는 입력하지 않고 pane 위치와 수동 종료·재시도 안내를 표시한다.
- 화면·스크롤 기록을 지우는 Ctrl+L은 사용하지 않는다. native와 WSL에 같은 화면 판독 계약을 적용한다.

## Alternatives Considered

- 새 출력 바이트만 판독: 정상적인 차분 repaint에서 UUID가 다시 출력되지 않아 기각한다.
- Ctrl+L로 기록을 비우고 전체 카드 재출력: 화면 기록을 불필요하게 지우며 현재 화면을 읽으면 필요하지 않아 기각한다.
- 화면 어디에서든 가장 최근 UUID 검색: 이전 대화·부분 응답을 선택할 수 있어 기각한다. 실행 확인과 마지막 카드의 완결성을 요구한다.
- Codex 훅 또는 종료 메시지: 별도 통합이나 TUI 종료가 필요하다. 현재 화면으로 해결되는 문제에 추가하지 않는다.

## Consequences

반복 조회가 화면 차분 최적화의 영향을 받지 않으며 사용자의 화면 기록을 보존한다. 기존 xterm checkpoint 모델과 작은 VT 화면 판독을 재사용하는 비용이 든다. 화면 형식·기본 키맵 의존성은 남으므로 실제 native/WSL 재현, ID 전환, 과거 카드·불완전 응답 배제, 세대·sequence 검증, 최종 저장을 함께 검증한다. 설정 스키마와 영속 데이터 마이그레이션은 없다.
