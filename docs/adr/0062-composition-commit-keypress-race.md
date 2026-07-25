# 0062. 조합 commit 중복은 pending commit 텍스트와의 포함 판정으로만 억제한다

- Status: Proposed
- Date: 2026-07-25
- Source: issue #527, architecture/data-flow.md §8.14, [ADR-0053](0053-native-windows-synchronized-output-cursor-transaction.md)(IME 키 정책 경계), [ADR-0054](0054-xterm-human-and-protocol-data-origin.md)(입력 데이터 출처), [ADR-0060](0060-linux-ime-candidate-key-suppression.md)(후보 키 억제)

## Context

xterm 의 `CompositionHelper._finalizeComposition(true)` 는 확정 텍스트를 **즉시 보내지 않는다.** 조합 범위를 캡처하고 `_isSendingComposition = true` 로 표시한 뒤 실제 읽기를 `setTimeout(0)` 으로 미룬다(설치 번들 실측):

```js
this._isSendingComposition = true;
setTimeout(() => {
  if (this._isSendingComposition) {
    this._isSendingComposition = false;
    range.start += this._dataAlreadySent.length;
    const text = this._textarea.value.substring(range.start);
    if (text.length > 0) this._coreService.triggerDataEvent(text, true);
  }
}, 0);
```

`_keyPress` 는 그 창이 열려 있는지 모른다 — 자기가 실은 문자로 독립적으로 `triggerDataEvent` 를 호출한다. `keydown` 경로에는 방어가 있지만(`keydown()` 이 조합/전송 중 `keyCode` 20/229/16/17/18 을 통과시키고 그 밖에는 강제 finalize) **keypress 는 이 창을 보호하지 않는다.**

**재현했다.** 이슈는 Linux X11/Wayland + IBus 실기를 전제했지만, 경합은 플랫폼이 아니라 **xterm 자신의 지연 전송 타이밍**이므로 실제 `Terminal` 인스턴스에 이벤트열을 태우는 것으로 baseline 이 재현된다:

```
compositionstart → compositionupdate("가") → compositionend("가")
  → (finalizer 의 setTimeout 아직 미실행)
  → keypress("가")
  → flush
결과: onData = ["가", "가"]        ← 중복

같은 순서에서 keypress 를 빼면
결과: onData = ["가"]              ← 정상
```

반대 방향의 유실은 같은 원인이다 — 그 사이 textarea 값이 바뀌면 `substring(range.start)` 가 stale 범위를 읽는다.

비목표: Linux 후보 선택 Space/숫자 보호는 #528(ADR-0060) 소관이다. macOS native text forwarder 를 도입하지 않는다. Kitty keyboard 우회 정책을 도입하지 않는다. PR #525 의 DEC 2026 stabilizer 범위를 변경하지 않는다.

## Decision

**pending 조합 commit 이 열려 있는 동안 도착한 `keypress` 는, 그 commit 이 보낼 텍스트가 keypress 의 문자를 이미 담고 있을 때만 xterm 에 전달하지 않는다. 애매하면 전달한다.**

- **판정 기준은 pending commit 텍스트와의 동일 또는 끝 경계 일치.** finalizer 가 읽을 슬라이스를 같은 식으로 재현하고(아래 시점 규칙 참조), keypress 문자가 그 텍스트와 **동일** 하거나 그 텍스트가 그 문자로 **끝날** 때만 중복이다. 부분 문자열 포함은 채택하지 않는다 — commit 중간에 있는 문자는 사용자가 따로 누른 것이고, 그것을 막으면 이 결정이 피한다고 한 유실이 된다.
- **억제할 때 `preventDefault()` 를 함께 호출한다.** xterm 의 `_keyPress` 는 커스텀 핸들러가 `false` 면 즉시 return 해 `cancel(e)` 에 도달하지 않고, `cancel` 자체도 기본 옵션(`cancelEvents: false`)에서 no-op 이다. 취소하지 않으면 브라우저가 그 문자를 helper textarea 에 삽입하고, xterm 은 `compositionend` 후 textarea 를 비우지 않으므로(deferred finalizer 가 그 값을 읽어야 한다) 슬라이스가 오염돼 중복이 **더 긴 이벤트 하나로** 그대로 남는다. 억제 조건이 "이 문자는 pending commit 이 이미 담고 있다" 이므로 삽입을 막아 잃는 것은 없다.
- **시점 규칙: `compositionStart` 는 캡처, `dataAlreadySent` 는 라이브.** finalizer 는 `range.start` 를 `compositionend` 에서 클로저로 캡처하고 `_dataAlreadySent.length` 는 **타이머 안에서** 더한다. 그래서 `_compositionPosition.start` 는 laymux 의 `compositionend` 리스너에서 스냅샷하고, `_dataAlreadySent` 는 keypress 시점에 읽는다. 늦게 읽으면 안 되는 이유는 `compositionstart` 가 그 필드를 `textarea.value.length` 로 덮어쓰기 때문이다.
- **새 조합이 시작됐으면 판정을 포기한다.** 타이머 시점 `_isComposing` 이 true 면 finalizer 는 상한이 있는 슬라이스(`substring(start, _compositionPosition.start)`)를 보낸다. 그 상한은 keypress 시점에 알 수 없으므로 `_isComposing === true` 면 **전달**로 떨어뜨린다 — 이슈 완료조건이 지목한 "빠른 조합 전환" 이 정확히 이 경우다.
- **보수성의 방향은 "전달".** pending commit 이 비었거나, 상태를 읽을 수 없거나, keypress 가 텍스트를 안 싣거나, 문자가 commit 에 없으면 전달한다. 중복보다 유실이 나쁘고, 사용자가 pending 창 동안 새로 누른 문자를 삼켜서는 안 된다.
- **판정은 순수 모듈이 소유**(`ui/src/lib/composition-commit-race.ts`). xterm 상태 읽기는 별도 모듈 한 곳(`ui/src/lib/xterm-pending-composition.ts`)이 소유하고, 의존하는 private 필드 목록을 상수로 노출한다.
- **번들 계약 파손은 조용히 넘기지 않는다.** 의존 필드는 `_compositionHelper`·`_isSendingComposition`·`_isComposing`·`_compositionPosition`·`_dataAlreadySent`·`_textarea` 6개다. 형태가 달라지면 read 가 `null` 을 반환하고 판정은 **전달**로 떨어진다 — guard 가 스스로 꺼지고 입력을 삼키지 않는다. 동시에 실제 `Terminal` 에 대한 계약 테스트가 필드 존재를 단정하므로 xterm 상향 시 **읽을 수 있는 이름의 실패 테스트**로 드러난다(완료 조건 5항).
- **xterm 번들을 패치하지 않는다.** 아래 근거 참조.

## Alternatives Considered

- **설치된 xterm 번들에 로컬 패치(`_keyPress` 안에 guard 추가).** 이슈가 "xterm 내부 책임 경계에서 수행" 을 요구했으므로 가장 문자 그대로의 해석이다. 그러나 patch 인프라(patch-package + postinstall + CI 검증)를 새로 들이고 **버전 상향마다 유지 비용이 확정적으로 발생**한다. 이 결정이 채택한 방식은 xterm 자신의 `_isSendingComposition` 을 읽어 `_keyPress` 에 없는 guard 를 같은 판정 지점에서 적용하므로 동작이 같고, 파손 시 스스로 꺼지며 계약 테스트로 드러난다. 상류에 이 guard 가 들어가면 이 결정은 제거 대상이 된다. → **패치 대신 이 방식을 채택**하되, 상류 수정이 정론임을 남긴다.
- **`keydown` 을 억제해 keypress 가 생기지 않게 한다.** 이슈가 명시적으로 기각한 방식("외부 keydown 억제로 결과만 가리지 않는다")이고, 조합과 무관한 키까지 영향권에 들어온다. 기각.
- **pending 창 동안 모든 keypress 를 버린다.** 중복은 사라지지만 그 사이 사용자가 누른 문자가 유실된다. 보수성의 방향이 거꾸로다. 기각.
- **`===` 만으로 중복 판정.** 단일 음절은 맞지만 여러 음절이 한 번에 commit 되고 IME 가 마지막 음절에 대해서만 keypress 를 내는 경계 중첩을 놓친다. 기각(포함 판정에 그 케이스를 테스트로 고정).
- **시간 창(예: compositionend 후 N ms 안의 keypress 를 버린다).** 상태를 안 읽어도 되지만 임계값에 근거가 없고, 빠른 타이핑을 삼킨다. #528 에서 같은 이유로 기각한 방식이다. 기각.
- **`_isSendingComposition` 대신 자체 플래그를 조합 이벤트로 관리.** private 접근을 피할 수 있지만 finalizer 의 타이머와 우리 플래그가 어긋나는 순간(강제 finalize, `_isSendingComposition` 을 다른 경로가 내리는 경우) 판정이 틀린다. 권위 있는 값을 그대로 읽는 편이 정확하다. 기각.

## Consequences

- 조합 commit 이 정확히 한 번만 PTY 로 간다. pending 창 동안 새로 누른 문자는 그대로 전달된다.
- 키 핸들러가 `keypress` 마다 xterm private 상태를 한 번 읽는다. `_isSendingComposition` 이 false 면 즉시 전달로 끝나므로 일반 타이핑 비용은 필드 조회 몇 번이다.
- **xterm private 필드 5개에 대한 의존이 생겼다**(`_compositionHelper`, `_isSendingComposition`, `_compositionPosition`, `_dataAlreadySent`, `_textarea`). 목록은 상수로 고정하고 계약 테스트가 단정한다. 이 의존을 다른 곳으로 퍼뜨리지 않는다 — 읽기 모듈 하나만 유지한다.
- 검증은 순수 판정 unit test + **실제 `Terminal` 대비** 테스트로 고정한다: baseline 중복 재현, guard 적용 후 단일 전송, pending 창 중 다른 문자 전달, **keypress 가 textarea 를 변형하는 경로**(`preventDefault` 없으면 `["가", "가가"]` 로 중복이 돌아온다는 것까지 고정), 일반 타이핑 무영향, 연속 3회 조합, 계약 필드 존재, finalizer 실행 후 pending 해제. 총 32케이스. 사보타주 3건(`_isComposing` 우회 제거·`endsWith`→`includes`·`preventDefault` 제거)이 각각 테스트에 잡히는 것을 확인했다.
- **미검증 — 실 PTY / 실 IBus 는 돌리지 못했다.** 재현은 실제 xterm 코드 경로에 대한 것이고 `onData` 바이트까지 확인했지만, IBus 가 내는 실제 이벤트열이 이 순서와 같은지는 Linux 실기 확인이 필요하다. textarea 변형 경로는 합성 이벤트가 default 삽입을 수행하지 않으므로 **값을 직접 바꿔 모사**했다 — 실 브라우저의 삽입 타이밍이 그와 같은지도 실기 확인 몫이다.
- 재검토 조건: xterm 이 `_finalizeComposition` 을 동기 전송으로 바꾸거나 `_keyPress` 에 자체 guard 를 넣으면 이 결정은 불필요해지므로 제거한다. 계약 테스트가 실패하면 그것이 신호다. 유실 방향이 실기에서 확인되면 판정에 "pending 창 동안의 textarea 변경" 을 추가로 반영해야 한다.
