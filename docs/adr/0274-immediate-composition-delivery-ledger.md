# 0274. 즉시 확정한 조합의 송신 기록은 native 조합 종료까지 공유한다

- Status: Accepted
- Date: 2026-09-27
- Source: 사용자 보고(Android Remote Direct에서 물리·소프트웨어 키보드의 간헐적 단어 중복), [조사·재현 기록](../remote-direct-ime-keydown-duplicate-investigation-2026-09-27.md), [architecture/data-flow.md §8.14](../architecture/data-flow.md#814-조합-commit-과-세대별-inputkeypress-경합-issues-527-660-xtermjs-6049)
- Extends: [ADR-0093](0093-xterm-composition-keypress-reconciliation-owner.md)의 세대별 소유권, [ADR-0230](0230-xterm-compositionend-data-recovers-replaced-textarea.md)의 확정 데이터 복구, [ADR-0268](0268-remote-ime-shares-composition-reconciliation.md)의 공통 Remote 적용 범위

## Context

일반 keydown이 `compositionend`보다 먼저 도착하면 xterm은 진행 중 조합을 즉시 확정해 전송한다. 그러나 이때 native IME 조합은 아직 종료되지 않았을 수 있다. 기존 공통 패치는 즉시 송신한 이력을 후속 delayed generation에 전달하지 않으므로, 뒤늦은 `compositionend`가 textarea와 확정 이벤트를 병합하면서 같은 단어를 다시 보낸다. 수정 전 배포 Remote 자산을 실행한 Chromium·dev 19281 재현에서 조합 종료 뒤 Space는 `이미 `, Space 뒤 조합 종료는 `이미 이미 `가 실제 ConPTY stdin에 도착했다.

ADR-0093의 pending generation은 deferred flush의 단위이며 native 조합 수명 전체를 대표하지 않는다. 즉시 확정 뒤 일반 `input`이 먼저 오고 native 종료는 나중에 오면, 하나의 native 조합을 여러 deferred generation에서 관측할 수 있다. 길이만 기록해 textarea slice에서 빼는 수정도 ADR-0230의 전체 `compositionend.data` 복구가 그 문자를 되살리므로 충분하지 않다.

native 종료 전에 Enter·Ctrl-C가 textarea를 비우면 두 수명이 갈라진다. 이미 보낸 native 조합의 prefix와 suffix는 뒤늦은 종료를 위해 기억해야 하지만, clear 뒤 같은 글자를 새로 입력한 것은 이전 textarea 관측과 구분해야 한다. 기록을 전부 초기화하면 native 종료가 재송신하고, 전부 유지하면 다음 입력이 이미 보낸 관측으로 합쳐져 사라진다.

범위는 공통 CompositionHelper의 즉시 확정과 뒤따르는 input·keypress·native 종료 사이의 송신 소유권이다. Remote 큐, HTTP·E2E 재시도, PTY 계약, Composer 편집, 커서·IME 프리뷰 렌더링은 바꾸지 않는다. 재현한 이벤트 순서는 결함의 근거지만 사용자의 Android 실기가 같은 순서를 만드는 빈도까지 입증하지는 않는다.

## Decision

**CompositionHelper는 native 조합의 송신 기록을 종료까지 유지하되 textarea clear 뒤 일반 입력 기록은 분리하며, 각 deferred generation이 관측 병합을 끝낸 뒤 해당 기록에서 이미 보낸 부분을 제외한다.**

- 즉시 확정은 기존 pending FIFO를 먼저 비운 뒤 현재 조합을 보내며, 해당 native 조합의 송신 기록을 남긴다. 기록은 CompositionHelper 내부 상태이며 Remote·TerminalView·서버에 중복 방지 소유자를 추가하지 않는다.
- native `compositionend`는 기록을 해당 delayed generation에 넘기고 현재 조합과의 연결을 해제한다. 새 `compositionstart`는 이전 pending textarea 스냅샷을 확정한 뒤 별도 조합으로 시작한다. blur는 event-data 복구를 금지하고 기존 pending을 flush한 뒤 기록을 해제한다. 이미 생성된 generation은 자기 기록을 보유하므로 후속 조합의 같은 단어를 지우지 않는다.
- native 종료 전 `input`은 이벤트별로 기존 FIFO의 임시 generation을 만든다. 임시 generation은 해당 input의 `isComposing`과 당시 textarea 스냅샷을 즉시 고정하고 생성 시점의 송신 기록을 보유한다. 후속 input의 native 조합 여부나 DOM 변경을 같은 generation에 섞지 않는다. 새 delayed generation을 만들 때 이전 pending 스냅샷을 고정하는 기존 경계도 유지한다. 즉시 전송한 조합 prefix는 불변이며 ordinary input이 textarea 전체를 교체하더라도 덮어쓰지 않는다. prefix 이후에 보낸 관측은 별도 누적 기록으로 ordered merge하여 후속 generation이 다시 보내지 않게 한다.
- Enter·Ctrl-C의 실제 Core textarea clear 직전에 helper에 경계를 알린다. helper는 clear 이후 일반 입력의 관측 기록을 새로 만들고, 원래 native 조합의 prefix와 관측 기록은 참조로 유지한다. 이때 native 관측의 불변 스냅샷을 함께 보관하며 반복 clear도 원래 native 기록을 공유한다. 따라서 clear 전에 보낸 native suffix는 뒤늦은 종료에서 재송신하지 않고, clear 뒤 일반 입력의 같은 글자는 새 입력으로 보존한다. 이 경계는 keydown의 종류나 textarea 내용이 비었는지를 추정하지 않고 실제 clear 직전의 통지로 결정한다.
- Core input은 `isComposing`을 helper에 전달한다. clear 이후 일반 input은 새 관측 기록으로 처리하며 원래 조합 prefix를 제외하지 않는다. native 조합 관측과 `compositionend`는 원래 native 기록을 먼저 조정한 뒤, 그 누적 관측에서 clear 시점 스냅샷만 제외한 누적 후보를 clear 이후 기록과 조정한다. 직전 호출의 차이만 넘기지 않으므로 `글`에서 `글글`로 확장된 native 후보의 두 번째 글자도 보존한다. native 조합 기록과 clear 이후 일반 입력 기록의 역할을 분리하며 새 input을 원래 기록으로 덮어쓰지 않는다.
- native 종료 전 일반 keypress는 helper가 즉시 전송하고 consumed로 반환한다. 기존 CoreBrowserTerminal은 consumed keypress의 기본 삽입을 취소한다. Space를 보낸 뒤 브라우저가 같은 공백을 textarea에 다시 넣어 후속 확정 후보를 오염시키지 않게 한다.
- textarea candidate와 `compositionend.data`를 먼저 복구·병합하고 ADR-0189의 순서 있는 input·keypress 관측 fold를 완료한다. 그 후 native 조합 관측에서 이미 보낸 prefix와 후속 관측을 제외한다. 따라서 event-data 복구가 송신한 텍스트를 다시 살리지 않고, 즉시 확정 이후 새로 확정된 suffix는 보존한다. clear 이후 일반 input에 원래 조합의 prefix 제외를 적용하지 않는다.
- Remote와 데스크톱의 ESM·CJS는 같은 구현과 설치 계약을 사용한다. Remote 전송 계층에는 시간창이나 문자열 동일성만으로 입력을 버리는 필터를 추가하지 않는다. 다음 조합에서 의도적으로 같은 단어를 입력하면 각각 전송한다.

## Alternatives Considered

- **`_dataAlreadySent`의 길이만 늘린다.** textarea slice에는 효과가 있지만 전체 확정 이벤트를 복구하는 경로에서 이미 보낸 문자열이 살아난다. native 종료 전 여러 generation이 생기는 경우의 소유권도 해결하지 못한다.
- **즉시 확정 뒤의 `compositionend`를 모두 버린다.** IME가 뒤늦게 추가 확정한 suffix와 textarea 전체 교체 시 복구해야 하는 내용까지 잃으므로 기각한다.
- **관측 병합 전에 이미 보낸 부분을 지운다.** 이후 이벤트 데이터·input 관측이 같은 텍스트를 재도입할 수 있다. 모든 정보 복구가 끝난 뒤 송신 여부를 판정한다.
- **native 종료까지 일반 키를 전부 보류한다.** Space·Enter 등 즉시 입력에 불필요한 지연을 만들며, native 종료가 생략되는 환경에서 입력 전달이 종료 이벤트에 종속된다. 일반 keypress는 즉시 전달하되 기본 삽입을 취소한다.
- **일반 input의 최종 textarea로 송신 기록을 매번 교체한다.** textarea가 별도 입력으로 대체되면 이전 조합을 보냈다는 근거를 잃어 뒤늦은 native 종료가 원래 단어를 재송신한다. 조합 prefix 기록을 유지한다.
- **textarea clear 때 모든 기록을 초기화하거나 모두 유지한다.** 초기화하면 clear 전에 보낸 native suffix가 늦은 종료에서 다시 전송되고, 모두 유지하면 clear 뒤 동일한 일반 입력을 이전 관측과 합쳐 버린다. 원래 native 기록의 수명과 clear 이후 일반 관측 기록의 수명을 나눈다.
- **clear 이후 기록에는 native 관측의 직전 차이만 넘긴다.** `글` 다음 `글글`의 차이는 각각 `글`이므로 clear 이후 기록이 같은 관측으로 병합해 두 번째 글자를 잃는다. clear 시점의 고정 스냅샷을 제외한 누적 후보를 넘긴다.
- **Remote 큐에서 같은 단어를 일정 시간 동안 버린다.** 발생 계층의 native 조합 경계를 모르는 추정이며 정상 반복 입력을 잃으므로 기각한다.

## Consequences

keydown 선행과 native 종료 선행을 같은 조합 소유권으로 처리한다. 즉시 보낸 조합을 후속 확정이 복제하지 않고, keypress 기본 삽입으로 생성되던 separator 중복을 방지한다. 같은 native 조합의 추가 suffix, textarea clear 뒤 일반 입력의 반복, 다음 native 조합의 의도적 반복은 보존한다. 기존 FIFO·확정 이벤트 복구·229 epoch 방어·blur 취소의 경계는 유지한다.

고정 xterm 6.0.0 번들 패치와 native 조합 기록이 추가되어 설치 검증의 유지 비용이 늘어난다. ESM·데스크톱 CJS·배포 Remote CJS에서 진행 중 조합의 Space·Enter, native 종료 전 input, Enter·Ctrl-C clear 전후 native suffix와 일반 입력의 분리, textarea 전체 교체, 연속 generation, helper blur 및 반복 단어를 실제 Terminal로 검증한다. 배포 Remote 자산의 `onData`부터 mock 서버의 HTTP `/write` 본문까지 브라우저 검증을 수행하고, 별도 자체 dev 19281에서도 Space 선행·native 종료 선행 양쪽의 `/write`와 실제 ConPTY raw stdin이 `이미 `인 것을 확인했다([수정 후 검증 기록](../remote-direct-ime-keydown-duplicate-investigation-2026-09-27.md#수정-후-검증)). Android 실기는 별도 확인 범위다. xterm을 올릴 때는 immediate와 delayed 확정의 송신 소유권, 실제 Core clear 통지, input별 native 조합 여부와 textarea 스냅샷 보존이 동등한지 확인해야 한다. helper의 blur 처리는 데스크톱 TerminalView의 별도 fallback까지 포함한 전체 앱 blur 경로의 정확히 한 번 전달을 보장하지 않는다.

모호한 다문자 overlap의 의미를 추정하는 선행 merge 한계는 남는다. native 종료 이벤트 자체에 separator가 포함된 경우에는 keypress 기본 삽입으로 생긴 경우와 같은 출처라고 단정할 수 없다. 실기 이벤트에서 이미 보낸 prefix 자체를 수정하거나 같은 조합의 관측만으로 구별할 수 없는 반복이 확인되면 더 강한 provenance가 필요하다. 이 결정은 합성·CDP 재현이 사용자의 Android 키보드별 입력 순서와 발생 빈도를 입증한다고 주장하지 않는다.

설정 마이그레이션은 없다. Remote 자산 내용 해시가 변경되며 새 문서를 연 클라이언트에 적용된다. 기존 Android 문서를 유지한 클라이언트는 실제 로드한 자산 해시로 적용 여부를 확인한다.
