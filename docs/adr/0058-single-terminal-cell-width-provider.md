# 0058. 터미널 셀 폭은 단일 Unicode/grapheme provider 가 소유한다

- Status: Proposed
- Date: 2026-07-25
- Source: issue #531, PR #525(row-fragment IME preview), architecture/data-flow.md §8.5, [ADR-0008](0008-shell-cursor-shadow-cursor.md)

## Context

IME composition preview 는 조합 중인 문자열을 xterm buffer 위에 셀 단위 row fragment 로 겹쳐 그린다. 따라서 preview 가 계산한 열/행과 조합이 커밋된 뒤 xterm buffer 가 실제로 차지하는 셀이 같아야 한다.

지금까지 이 두 값은 **서로 다른 계산원**을 썼다.

- xterm buffer/renderer 는 등록된 `IUnicodeVersionProvider` 에게 코드포인트당 셀 폭을 묻는다. 기본값은 xterm 내장 Unicode 6 provider 이고, 이 provider 는 emoji(`U+1F300` 이상 대부분)를 폭 1 로 본다.
- preview 는 `ime-composition-controller.ts` 안의 자체 폭 테이블을 코드포인트 단위로 순회했다. 이 테이블은 emoji 를 폭 2 로 봤고, ZWJ sequence·variation selector·skin tone modifier·combining mark 를 각각 독립 세그먼트로 취급했다.

한글·ASCII 처럼 두 테이블이 우연히 일치하는 구간에서는 문제가 드러나지 않지만, 그 밖에서는 preview 의 wrap 위치와 caret 이 커밋 후 실제 커서와 어긋난다. 근본 원인은 개별 문자의 폭 값이 아니라 **폭 계약의 소유자가 둘**이라는 구조다. 수동 예외를 계속 덧붙이는 방식으로는 닫히지 않는다.

폭 계약을 하나로 만들려면 어느 쪽이 진실원이 될지 정해야 한다. xterm 6.0.0 의 public `IUnicodeHandling` 은 `register` / `versions` / `activeVersion` 만 노출하고 폭 질의 API(`getStringCellWidth`)는 노출하지 않는다. 즉 "xterm 에게 폭을 물어본다" 는 방향은 public API 로 불가능하다. 반대 방향 — 우리 모듈이 provider 를 소유하고 그것을 xterm 에 주입 — 만 가능하다.

grapheme 경계도 같은 문제다. xterm `InputHandler.print()` 은 UAX#29 segmenter 를 쓰지 않고, provider 가 반환하는 `charProperties(codePoint, preceding)` 의 `shouldJoin` 비트만으로 클러스터 소속을 판단한다. 따라서 preview 가 별도 segmenter(`Intl.Segmenter` 등)로 클러스터를 나누면 폭 값이 같아도 경계가 갈릴 수 있다.

범위는 데스크톱 터미널 pane(`TerminalView`)의 셀 폭 계약과 IME preview layout 이다. 비목표: font glyph fallback·emoji 이미지 렌더러, ambiguous-width 사용자 설정, native candidate popup 위치.

## Decision

**터미널 셀 폭과 grapheme 클러스터 경계는 `ui/src/lib/terminal-unicode-width.ts` 하나가 소유하고, xterm 은 그 provider 를 주입받아 쓴다.**

- **SoT** — 이 모듈이 `wcwidth`(코드포인트 폭)와 `charProperties`(폭 + `shouldJoin`)를 정의한다. `terminal.unicode.register()` 로 xterm 에 등록하고 `activeVersion` 을 이 provider 로 전환한다. preview 는 같은 모듈의 `stringCellWidth` / `splitCellClusters` 를 쓴다. 폭 테이블을 다른 파일에 복제하지 않는다.
- **활성화 순서** — provider 활성화는 `new Terminal()` 직후, `terminal.open()`·PTY write·세션 restore write 보다 **앞**이다. 한 행이라도 Unicode 6 폭으로 배치된 뒤 이 provider 로 측정되면 계약이 깨진다. 이 순서는 회귀 테스트로 고정한다.
- **적용 범위의 단일성** — 프로덕션 xterm 인스턴스는 `TerminalView` 한 곳에서만 생성되므로, 모든 데스크톱 pane 이 같은 provider 를 쓴다. pane 별·프로필별로 폭 정책을 분기하지 않는다.
- **grapheme 은 `shouldJoin` 으로만 표현한다** — 별도 segmenter 를 도입하지 않는다. ZWJ sequence, variation selector, combining mark, skin tone modifier, regional indicator pair 는 `charProperties` 가 `shouldJoin=true` 를 반환해 앞 셀에 합쳐진다. `splitCellClusters` 는 xterm 과 같은 `charProperties` 체인을 걸어 클러스터를 만들기 때문에, 두 쪽의 경계가 정의상 일치한다.
- **불변식** — preview row fragment 는 클러스터 중간에서 끊기지 않는다. 남은 셀보다 넓은 클러스터는 통째로 다음 행으로 내려간다. 기존 한글 wide-cell line-end 규칙(정확히 줄을 채운 폭 2 문자는 같은 행에 남고 caret 만 다음 행 0열로 정규화)은 유지한다.
- **폭 의미론** — `wcwidth` 는 Unicode 11 기준 East Asian Wide/Fullwidth 를 폭 2 로, nonspacing/enclosing mark 와 format 문자(`\p{Mn}`/`\p{Me}`/`\p{Cf}`) 및 conjoining Hangul jamo(`U+1160`–`U+11FF`)를 폭 0 으로 본다. ambiguous-width 는 폭 1 로 고정하고 설정으로 열지 않는다. `emoji + VS16` 은 클러스터 폭 2 로 승격하고, VS15(text presentation)는 승격하지 않는다.
- **실패 정책** — 활성화는 `allowProposedApi` 를 요구한다. 실패를 삼켜 기본 provider 로 조용히 되돌아가지 않는다. 되돌아가면 이 ADR 이 제거하려는 이중 진실원 상태가 그대로 복원되기 때문이다.

## Alternatives Considered

- **`@xterm/addon-unicode11` 설치 후 활성화** — xterm buffer 폭은 Unicode 11 로 개선되지만 addon 은 provider 인스턴스를 export 하지 않으므로 preview 는 여전히 자체 테이블을 들고 있어야 한다. 이중 진실원이 남아 이슈의 근본 원인을 해결하지 못한다. 또한 이 addon 은 grapheme 클러스터를 다루지 않는다.
- **`@xterm/addon-unicode-graphemes` 설치** — Unicode 15 폭 + UAX#29 클러스터를 제공하지만 위와 같은 이유로 preview 쪽 계산원을 통일해 주지 못하고, 새 런타임 의존성과 자체 Unicode 테이블을 추가로 들여온다.
- **`Intl.Segmenter` 로 preview 만 grapheme 분할** — 폭 테이블 이중화가 남는다. 더 나쁜 것은 segmenter 의 클러스터 경계가 xterm 의 `shouldJoin` 경계와 구조적으로 다를 수 있다는 점이다(xterm 은 UAX#29 를 구현하지 않는다). 경계가 어긋나는 새로운 부류의 버그를 만든다.
- **xterm private `unicodeService.getStringCellWidth()` 호출** — 진실원은 하나가 되지만 pinned 버전의 private 내부에 preview 를 결박한다. 이미 reflow 패치로 pinned 버전 내부에 의존하는 부채가 있어 더 늘리지 않는다.
- **preview 를 셀 좌표에서 떼어내 CSS 텍스트 흐름에 맡기기** — 폭 계산 자체가 없어지지만 조합 중 문자가 buffer 셀 격자에서 벗어나 흔들리고, PR #525 가 고친 row-fragment 정렬이 회귀한다.

## Consequences

- preview wrap/caret 과 커밋 후 xterm 커서가 같은 계산을 쓰므로, 경계 케이스마다 예외를 덧붙이던 흐름이 끝난다. 회귀 테스트는 실제 `Terminal` 에 같은 텍스트를 write 해 buffer 커서와 preview layout 을 직접 비교한다.
- **터미널 전체의 폭 의미론이 바뀐다.** emoji 는 폭 1 → 2 가 되고 grapheme 클러스터는 여러 셀 → 한 셀로 합쳐진다. buffer 배치, reflow, `SerializeAddon` 스냅샷, Automation API 의 buffer dump 가 모두 새 폭을 따른다. 세션 restore 는 write 전에 provider 가 활성화되므로 restore 결과도 같은 폭으로 재배치된다.
- PTY 쪽 프로그램(shell·TUI)이 자기 폭 계산으로 커서를 움직이므로, 폭 판단이 우리와 다른 프로그램에서는 여전히 표시가 어긋날 수 있다. 이 ADR 은 laymux 내부(preview↔buffer) 일치만 보장하고, 애플리케이션과의 폭 협상은 다루지 않는다.
- `\p{Mn}\p{Me}\p{Cf}` 판정은 엔진 Unicode 데이터를 쓰므로 폭 0 집합은 Chromium/Node 버전에 따라 미세하게 달라질 수 있다. 폭 2 집합은 명시 테이블이므로 새 Unicode emoji 블록은 수동으로 추가해야 한다. `charProperties` 는 출력 코드포인트마다 호출되므로 폭 조회는 lazy `Uint8Array` 캐시로 상시 O(1) 을 유지한다.
- Direct Remote Mode 의 브라우저 클라이언트(`src-tauri/src/remote_server/page.html`)는 커밋된 xterm 브라우저 번들을 그대로 쓰고 이 provider 를 받지 않으므로 기본 Unicode 6 폭을 유지한다. remote 표면은 IME preview overlay 를 쓰지 않으므로 이 ADR 의 불변식은 깨지지 않지만, 같은 PTY 출력이 데스크톱과 remote 에서 다른 폭으로 보일 수 있다. remote 표면 통일은 별도 작업으로 남긴다.
- 재검토 조건: xterm 이 public 폭 질의 API 를 노출하거나 `IUnicodeVersionProvider` 계약(property value 비트 배치 포함)을 바꾸면 이 결정을 다시 본다. 비트 배치는 xterm 내부 `UnicodeService` 와 맞춰야 하므로 xterm 버전 상향 시 확인 대상이다.
