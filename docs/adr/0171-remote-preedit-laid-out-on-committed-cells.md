# 0171. Remote 조합 텍스트는 확정 후 셀 위에 배치한다

- Status: Accepted
- Date: 2026-08-17
- Source: 사용자 보고("리모트 direct 모드에서 한글이 좁게 조합되다가 입력되면 넓어진다"), [ADR-0058](0058-single-terminal-cell-width-provider.md), [ADR-0061](0061-native-ime-candidate-anchor.md)

## Context

Remote client 의 direct 모드는 xterm 의 helper textarea 와 xterm 이 만든
`.composition-view` 를 그대로 쓴다. 이 view 는 조합 중인 문자열(preedit)을 커서
셀 위치에 그린다.

문제는 **너비**다. xterm 의 DOM 렌더러는 확정 텍스트의 모든 span 에 글리프별
letter-spacing 을 넣어(`_setDefaultSpacing`) 글리프가 `wcwidth` 가 주장하는 셀 수를
정확히 채우게 만든다. 반면 `.composition-view` 는 preedit 문자열을 폰트의 자연
advance 로 그냥 흘린다. 한글 음절은 monospace 대체 글꼴에서 대략 1 셀 폭으로
advance 하지만 확정되면 2 셀을 먹으므로, 조합 중에는 좁게 보이다가 확정하는 순간
넓어지고 뒤따르는 글리프 위치도 함께 밀린다. 조합 중 커서/후보창 위치가 실제
확정 위치와 어긋나 사용자가 "예상 위치"를 잃는다.

같은 문제를 desktop 은 xterm 의 native composition view 를 숨기고 자체 overlay
(`.terminal-composition-preview`)로 대체해 이미 해결했다. Remote 는 그 overlay
기계(shadow cursor·anchor keeper·행 wrap 레이아웃)를 갖고 있지 않다.

범위는 **preedit 의 셀 정렬**이다. 조합 텍스트가 화면 오른쪽 끝에서 접히는 문제
(xterm 의 `white-space: nowrap`)와 desktop 수준의 자체 preview overlay 도입은
비목표다.

## Decision

Remote direct 모드의 preedit 은 **확정 후 점유할 셀 위에 놓인다.** 위치가 아니라
레이아웃만 laymux 가 소유한다.

- 위치는 계속 xterm 소유다. `updateCompositionElements` 가 view 를 커서 셀에
  앵커하고 helper textarea 를 그 rect 로 미러링하는 계약([ADR-0061](0061-native-ime-candidate-anchor.md))을 그대로 둔다.
- **view 의 내용은 laymux 가 소유한다.** remote client 가 textarea 의
  `compositionstart`/`update`/`end` 를 xterm 다음으로 구독해, view 내용을 클러스터당
  inline-block 박스 하나로 다시 깐다. 박스 폭은 `클러스터 셀 수 × cellWidth` 다.
  xterm 은 `textContent` 를 이 두 이벤트에서만 쓰므로 이후 덮어쓰지 않는다.
- 클러스터 분해와 셀 수의 진실원은 계속 공유 width provider 다([ADR-0058](0058-single-terminal-cell-width-provider.md)).
  이를 위해 `unicode-provider.js` 전역에 `splitCellClusters` 를 추가로 노출한다 —
  remote 에서 `wcwidth` 만으로 grapheme 규칙을 재구성하면 ADR-0058 이 없앤 두 번째
  진실원이 되살아난다.
- provider asset 이 없을 때(이미 경고하는 degraded 상태)는 코드포인트 단위로
  쪼갠다. 결합 문자가 제 박스를 갖게 되어 부정확하지만, 셀 정렬 자체는 유지된다.

## Alternatives Considered

- **`.composition-view` 에 균일 letter-spacing 부여.** 한 줄이면 끝나지만
  letter-spacing 은 문자마다 다른 보정값을 줄 수 없다. 한글만 있는 preedit 은
  맞아도 `a한b` 처럼 폭이 섞이면 어긋난다.
- **desktop 처럼 native view 를 숨기고 자체 overlay 를 만든다.** 행 wrap·앵커
  유지·caret 소유권까지 따라와야 하는데, remote 에는 그 상태 기계가 없다. 증상은
  너비 하나이므로 xterm 의 앵커를 재구현하지 않고 레이아웃만 고치는 쪽이 비용 대비
  이득이 크다. 조합 중 줄바꿈까지 요구되면 그때 재검토한다.
- **MutationObserver 로 xterm 이 쓴 내용을 감시해 다시 깐다.** 이벤트 순서로 충분한
  일에 관찰자와 재진입 방어를 더한다. xterm 의 쓰기 지점이 두 이벤트로 한정돼 있다는
  사실이 관찰로 확인됐으므로 채택하지 않았다.
- **remote client 에 자체 width 표를 넣는다.** ADR-0058 이 제거한 이중 진실원의
  부활이라 기각.

## Consequences

- 조합 중 문자열이 확정 텍스트와 같은 셀을 점유하므로 확정 순간의 폭 점프가
  사라지고, view rect 를 미러링하는 helper textarea 크기가 실제 조합 폭과 맞아
  OS 후보창 앵커도 함께 정확해진다.
- laymux 가 xterm 내부 요소(`.composition-view`)의 내용을 소유한다는 계약이
  생긴다. xterm 업그레이드로 view 의 쓰기 지점이 늘어나면 깨질 수 있으므로,
  bundle 을 올릴 때 확인 대상이다. 회귀는 real-browser e2e
  (`ui/e2e/remote-ime-preedit.spec.ts`)가 셀 단위 폭으로 잡는다 — jsdom 은 글리프를
  advance 시키지 못해 이 결함을 볼 수 없다.
- provider 전역의 표면이 xterm 계약(`wcwidth`/`charProperties`)보다 넓어진다.
  drift 는 `remote-unicode-provider.test.ts` 가 커밋된 asset 을 실행해 검증한다.
- 오른쪽 끝 wrap 은 여전히 xterm 동작 그대로다. 조합 문자열이 마지막 열을 넘으면
  화면 밖으로 흐른다 — 재검토 조건이다.
