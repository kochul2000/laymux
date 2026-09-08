# 0229. Composer 별표 항목은 라벨·전송 여부를 가진다

- Status: Accepted
- Date: 2026-09-04
- Source: 사용자 요구(자동완성 선택에 Enter/Send를 포함, Settings에서 항목별 라벨·값·전송 편집, 자동완성 롱클릭으로 같은 편집기 열기) · [ADR-0226](0226-composer-stars-are-host-global-persistent-state.md) · [ADR-0034](0034-single-send-terminal-composer.md) · [ADR-0219](0219-android-back-defers-to-remote-ui-stack.md) · [data-flow §8.8](../architecture/data-flow.md)
- Amends: [ADR-0226](0226-composer-stars-are-host-global-persistent-state.md)의 원소 타입 `string[]`과 exact-query 제외 문장, 그리고 “별표 버튼만 영속 복사한다”는 진입점 문장만 대체한다. 호스트 전역 소유권·전용 mutation·patch read-only·checkpoint 보존·lease/revision 조회는 유지한다. [ADR-0219](0219-android-back-defers-to-remote-ui-stack.md)의 `dismissTopLayer()` 순서에 별표 편집기를 FileViewer와 drawer 하위 화면 사이에 삽입한다.

## Context

ADR-0226의 별표 목록은 삽입할 문자열의 ordered set이다. 자동완성은 그 문자열을 초안에 채우기만 하고, 전송은 사용자가 다시 Enter를 눌러야 한다. 자주 쓰는 명령은 짧은 별칭으로 고르고 고르는 순간 보내고 싶은데, 표시 이름과 삽입 값과 전송 여부를 항목마다 저장할 자리가 없다.

Settings는 문자열만 추가·삭제할 수 있고, 자동완성 목록에서 그 메타데이터를 고치는 경로도 없다. 별표의 호스트 전역 소유권, 전용 mutation, Remote revision 조건부 조회는 유지한 채 항목 모양만 확장해야 한다.

수락(클릭·Tab·Enter)만으로는 영속하지 않는다. 편집기 저장은 별표 버튼·Settings 추가와 같은 명시적 opt-in이다.

범위는 별표 항목의 `{value, label, send}` 모델, 전용 IPC/Remote 계약, 자동완성 표시·매칭·수락, Desktop Settings와 자동완성 롱클릭이 공유하는 편집기다. runtime history 문자열의 비영속 경계는 바꾸지 않는다. 롱클릭의 밀리초 문턱·이동 픽셀은 living doc이 적는다.

## Decision

**호스트 전역 별표 항목은 삽입 값·표시 라벨·수락 시 Send 여부를 가진 객체이며, 자동완성에서 고르면 값을 채우고 `send`가 켜진 항목은 이어서 Send 한다.**

- SoT는 `settings.json`의 `terminal.composerStarredEntries` 하나다. 원소는 `{ value: string, label: string, send: boolean }`이고, 앞에서 뒤로 오래된 순서의 호스트 전역 ordered set이다. 정체성은 `value`다. 빈 `value`와 `value` 중복은 거절한다. `label`은 비어 있으면 목록에 `value`를 보여 주고, 있으면 라벨을 보여 주며 값 prefix와 라벨 prefix 모두로 매칭한다. `send` 기본값은 false다.
- 기존 `string[]` 디스크 값은 `{ value, label: "", send: false }`로 읽는다. 쓰기는 항상 객체다. 한도(최대 200개, `value` UTF-8 16 KiB)는 ADR-0226과 같다. `label`은 UTF-8 256바이트를 넘지 않는다.
- exact-query 제외는 `value` 완전 일치에만 적용한다. `send: true`인 별표는 초안이 이미 그 `value`여도 목록에 남아 고르면 Send 한다. 표시용 `label`이 초안과 같아도 `value`가 다르면 제외하지 않는다.
- 별표 버튼은 여전히 `value`만 토글한다. 새로 별표를 누르면 `label=""`, `send=false`다. 이미 있는 `value`를 다시 별표하면 메타데이터를 지우지 않는다. 전송·recall·자동완성 수락만으로는 영속하지 않는다. 편집기 저장은 별표 버튼·Settings 추가와 같은 명시적 opt-in이다.
- IPC `set_composer_starred_entry` 반환과 `composer-starred-entries-changed` event payload는 객체 배열이다. Remote GET/POST 응답은 `{ revision, entries?: {value,label,send}[] }`이며 같은 revision이면 `entries`를 생략하고, 늦게 도착한 더 낮은 revision은 무시한다. POST 본문은 `value`(JSON `text`는 alias)·`starred`·선택적 `label`/`send`/`previousValue`다. `text`와 `value`가 둘 다 있고 다르면 거절한다. 생략된 `label`/`send`는 기존 항목이면 유지하고 신규면 `""`/`false`다. `previousValue`가 있으면 그 항목을 제자리에서 이름 변경하고, 없거나 비어 있으면 현재 `value`가 정체성이다. 새 `value`가 다른 항목과 겹치면 거절한다. bearer/IP/origin guard와 active controller lease는 ADR-0226과 같다.
- 자동완성 수락(클릭·Tab·강조 후 Enter)은 초안을 `value`로 바꾼 뒤 `send`가 true면 기존 Composer Send를 이어서 호출한다. 비활성·전송 중이면 채우기만 한다.
- Desktop Settings의 각 별표 행과 자동완성 행 롱클릭은 같은 편집기를 연다. 편집기는 라벨·값·Send를 고치고 전용 mutation으로 즉시 저장한다. 아직 별표가 아닌 자동완성 행을 저장하면 별표가 된다. 롱클릭 문턱을 넘긴 pointer는 그 제스처의 수락/Send를 소비한다. 별표 버튼과 Tab history 팝업은 이 제스처를 쓰지 않는다.
- `dismissTopLayer()` 순서는 OAuth relay modal → FileViewer overlay → Composer 별표 편집기 → drawer 하위 화면 → Dock disclosure → drawer → Composer recall/autocomplete 다.

## Alternatives Considered

- **값 문자열에 개행을 넣어 Enter를 흉내 낸다** — Composer Send는 텍스트 뒤 CR 제출 의도라 개행과 전송이 다르다. 기각한다.
- **라벨만 Settings에 두고 send는 전역 토글** — 항목마다 채우기만 할 것과 보내기 할 것을 고를 수 없어 기각한다.
- **별도 id 필드** — 정체성을 `value`에서 바꾸면 별표 버튼·중복 제거·history 합성 키가 세 갈래가 된다. 이름 변경은 `previousValue`로 제자리 치환하는 편이 작다.
- **일반 settings patch로 객체 배열을 저장** — ADR-0226이 막은 checkpoint 덮어쓰기가 다시 열린다. 전용 mutation을 유지한다.

## Consequences

- 별표 한 줄이 짧은 별칭과 전송 매크로가 될 수 있다.
- Remote와 Desktop이 같은 객체 배열을 보므로 기존 `string[]` 가정 테스트·mock·이벤트 타입을 함께 바꿔야 한다. Remote 응답 wrapper `{revision, entries?}`는 유지한다.
- Android native는 `dismissTopLayer()`만 호출하므로 문서 쪽 레이어 순서 변경은 mixed-version APK fallback을 깨지 않는다.
- `label`/`send`는 민감 문자열이 아닐 수 있어도 `value`와 한 객체에 있으므로 필드는 계속 sensitive read-only다.
- 수동 편집으로 생긴 빈 `value`·중복·한도 초과는 ADR-0226의 load 복구 불변식을 객체 원소에 적용한다.
