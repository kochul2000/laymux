# 0268. Remote Direct 입력도 공통 xterm 조합 확정 처리를 사용한다

- Status: Accepted
- Date: 2026-09-27
- Source: 사용자 보고(리모트의 소프트웨어·하드웨어 키보드에서 단어가 간헐적으로 반복됨), [data-flow.md §8.14](../architecture/data-flow.md#814-조합-commit-과-세대별-inputkeypress-경합-issues-527-660-xtermjs-6049)
- Extends: [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md), [ADR-0189](0189-ime-candidate-first-observation-fold.md), [ADR-0230](0230-xterm-compositionend-data-recovers-replaced-textarea.md)의 적용 범위를 Remote Direct 입력으로 확장한다.

## Context

데스크톱 xterm은 조합 확정의 input·keypress·deferred finalizer 관측을 한 세대에서 합치지만, Remote에 동봉된 별도 CJS 번들에는 229 textarea-diff 방어만 적용되어 있었다. 실제 Remote 페이지의 DOM 이벤트 경로에서 `compositionend("키보드를") → input(insertText, "키보드를")`를 finalizer 전에 전달하자 `/write` 본문이 `키보드를키보드를`가 됐다. HTTP 응답 지연 0ms와 150ms 모두 같은 결과였다. 이 재현의 중복은 전송 재시도 전에 이미 생성된다.

별도로 관리하는 패치 목록은 같은 xterm 버전에서도 입력 동작을 갈라놓는다. 단어 내용이나 시간 간격만 보고 중복을 지우면 의도적인 반복 입력까지 유실할 수 있다. 범위는 Remote Direct의 조합 확정과 설치 검증이다. Composer의 네이티브 편집, 네트워크 재시도 정책, PTY 입력 계약, 커서·IME 프리뷰 렌더링은 변경하지 않는다.

## Decision

**Remote Direct와 데스크톱 CJS 번들은 동일한 CompositionHelper 조합 패치 목록을 적용하며, 조합 세대 안의 중복 관측 처리는 xterm만 소유한다.**

- 세대별 FIFO, candidate와 관측의 순서 보존 병합, consumed keypress의 기본 삽입 취소, compositionend 데이터 복구, blur 전 pending flush, 229 epoch 방어를 함께 적용한다.
- Remote 입력 큐나 서버에 시간창·문자열 기반 중복 제거를 추가하지 않는다. 서로 다른 조합 세대의 동일한 단어는 각각 전송한다.
- 설치는 기존 부분 패치가 적용된 Remote 번들을 공통 처리로 올리고, 재실행해도 결과를 바꾸지 않는다. 고정 버전에서 예상한 경계를 찾지 못하면 실패한다.
- 실제 배포 Remote 번들도 같은 조합 이벤트 회귀 테스트를 실행한다. 브라우저 통합 검증은 Remote 페이지의 DOM 입력부터 `/write` 본문까지 확인한다.

## Alternatives Considered

- **네트워크 큐에서 같은 문자열을 제거한다.** 중복의 발생 계층을 벗어나며 정상적인 반복을 구분하지 못하므로 기각한다.
- **Remote 전용 조합 guard를 추가한다.** textarea candidate와 확정 세대를 모르는 두 번째 소유자를 만들고 데스크톱과 다시 갈라지므로 기각한다.
- **Remote 패치 목록에 수정 항목을 복사한다.** 당장의 동작은 맞지만 이후 수정 누락이 재발할 수 있어 공통 목록을 사용한다.

## Consequences

같은 조합을 여러 이벤트로 관측해도 Remote Direct에서는 한 번만 보내며, 연속된 별도 조합의 반복은 보존한다. 기존 Remote 번들의 세대 간 유실과 textarea 전체 교체 시 유실도 같은 수정 범위에 포함된다.

고정 xterm 6.0.0의 내부 번들에 의존하는 유지 비용과 선행 ADR의 모호한 다문자 overlap 한계는 남는다. xterm 상향 시 세대 분리와 관측 병합을 포함한 동등한 upstream 처리가 있는지 확인한다. 배포 시 Remote 자산 해시가 바뀌며 새 문서를 연 클라이언트에 적용된다. 설정 마이그레이션은 없다.

합성 DOM 이벤트 회귀 테스트는 실제 xterm과 전송 본문을 검증하지만, 사용자의 기기·키보드가 만드는 이벤트 순서와 재현 빈도를 입증하지는 않는다. 실기 IME 검증은 별도로 기록한다.
