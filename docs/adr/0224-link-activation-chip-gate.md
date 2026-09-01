# 0224. 링크 실행은 activation 설정으로 게이트하고, deliberate 모드는 액션 칩으로 명시 실행한다

- Status: Accepted
- Date: 2026-09-01
- Source: 사용자 요구("file, url 실행이 한번에 들어가는 게 아니라 쉬프트나 컨트롤 등을 하게 옵션을 주면 좋겠다", "리모트는 어떻게 클릭? 한번 더? 롱클릭?", "칩 대신 하단 시트는 별로다", "URL 은 칩 경유/즉시를 세팅으로 선택"), [architecture/data-flow.md §8.6](../architecture/data-flow.md)
- 관계:
  - **Extends** — [ADR-0188](0188-path-link-ambient-detection-triggers.md)(발견/실행 분리 위에 실행 게이트를 추가한다. 발견 트리거·비용 상한은 그대로)
  - **경계 유지** — [ADR-0100](0100-path-link-host-os-open-modifier-contract.md)(Ctrl 계열 수정자 소유권·확인 정책 재배치 없음), [ADR-0045](0045-remote-path-link-reuses-desktop-parser.md)(Remote 는 호스트 프로세스 실행 권한 없음)
  - **관련** — [ADR-0162](0162-android-remote-link-opens-os-browser.md)(Android URL native bridge — 칩 뒤로 이동할 뿐 검증 계약 불변), [ADR-0198](0198-remote-file-explorer-overlay.md)(Remote 디렉터리 라우팅), [ADR-0220](0220-path-link-stable-frame-lifetime.md)(안정 프레임 수명 — 칩 수명이 같은 판정을 따른다), [ADR-0004](0004-settings-vs-ui-state-separation.md)·[ADR-0032](0032-llm-settings-introspection-and-safe-mutation.md)(새 설정 키 계약)

## Context

터미널 링크의 **실행**은 현재 전부 단발 제스처다.

| 대상 | surface | 실행 제스처 | 결과 |
| --- | --- | --- | --- |
| URL(일반 셸) | desktop | 좌클릭 1회 | 즉시 OS 브라우저 |
| URL(마우스트래킹 TUI) | desktop | Shift/Alt+클릭(#352) | 즉시 OS 브라우저 |
| URL | Remote | 탭 1회 | 즉시 브라우저(ADR-0162) |
| path 밑줄 | desktop | 클릭 1회 | 파일=뷰어, 디렉터리=CWD 전파 |
| path 밑줄 | desktop | Ctrl / Ctrl+Shift | OS 열기 / reveal(ADR-0100, 확인 게이트) |
| path 밑줄 | Remote | 탭 1회 | 파일=뷰어, 디렉터리=탐색기 오버레이 |

ADR-0188 이 발견(파싱)과 실행을 분리해 "미검증 문구 클릭은 밑줄만 켠다"는 계약을 만들었지만, 그 분리가 오히려 실행을 **무장(arm)** 시킨다. desktop 은 hover dwell 300ms 가, Remote 는 유휴 화면 스캔이 사용자가 지목하지 않은 밑줄을 미리 깔아 두므로, 커서 이동·포커스·스크롤 의도의 클릭/탭이 뷰어를 열거나 CWD 를 옮긴다. URL 은 발견 단계조차 없이 1클릭 즉발이다. 사용자는 "실행이 한 번에 들어가지 않는" 모드를 원하며, URL 과 파일경로 각각에 대해 즉발/명시 실행을 따로 고를 수 있기를 원한다.

수정자 키로 게이트하는 손쉬운 답은 두 가지 벽에 막힌다.

1. **수정자 지도가 포화 상태다.** Shift 는 xterm 선택 확장과 #352 TUI 우회, Alt 는 #352 와 `altClickMovesCursor`, Ctrl 은 ADR-0100 OS 열기, Ctrl+Shift 는 reveal 이 소유한다. "내부 열기용 수정자"를 새로 넣으려면 ADR-0100 계약 전면 재배치가 필요하다.
2. **터치에는 수정자가 없다.** Remote 의 롱프레스와 더블탭은 이미 단어 선택이 소유하므로(§8.6), 남는 제스처가 없다. 수정자 기반 설계는 Remote 대응 자체가 성립하지 않는다.

범위는 desktop·Remote 터미널의 URL 링크와 검증된 path 밑줄의 **실행 게이트**와 그 UI(액션 칩), 대응 설정 키 2개다. 발견 트리거·비용 상한(ADR-0188), 후보 문법, ADR-0100 의 수정자 계약·확인 정책, Remote 권한 경계(ADR-0045), pairing 표면·File Explorer 오버레이·FileViewer 내부의 링크는 비목표다.

## Decision

**링크 실행 정책을 대상별 설정 두 개 — `terminal.urlLinkActivation`, `terminal.pathLinkActivation`, 값 `"immediate" | "chip"`, 기본값 둘 다 `"immediate"` — 로 게이트한다. `chip` 모드에서 실행 제스처(클릭/탭)는 링크를 열지 않고 링크 옆에 액션 칩을 띄우며, 칩의 액션을 누를 때만 실행한다. 발견(파싱)은 어떤 모드에서도 게이트하지 않는다.**

### 1. 발견은 항상, 자동, 설정 없음

파싱은 부수효과가 없고(stat + 밑줄) 비용 상한이 이미 상수다(ADR-0188). 밑줄은 "실행 전 미리보기"로서 안전장치 역할을 하므로, 파싱을 수정자나 설정 뒤로 숨기지 않는다. hover dwell·클릭 발견·Remote 유휴 스캔·탭 발견은 두 모드에서 동일하게 동작한다.

### 2. 설정 키 2개, 대상별 독립

- `terminal.urlLinkActivation` — OSC 8·평문 URL·`#123` 이슈 토큰 등 **URL 로 귀결되는 링크** 전부.
- `terminal.pathLinkActivation` — 검증된 path 밑줄(파일·디렉터리).
- 값은 `"immediate"`(현행 동작 그대로) | `"chip"`. 기본값 `"immediate"` — 기존 사용자 동작 무변, 옵트인.
- 하나의 enum 에 조합값(`paths-only` 등)을 넣지 않는다. 키 2개 × 2값이 조합을 자연스럽게 다 표현하고, 기존 키 네이밍(`pathLinkEnabled`, `pathLinkOsOpenConfirm`)과 결이 맞는다.
- ADR-0004/0032 계약에 따라 `settings.json` 스키마, `describe_settings` 메타데이터, `validate_settings`, Settings UI Terminal 섹션, i18n 을 함께 갱신한다. 트리거별·surface 별 키는 만들지 않는다.

### 3. 칩 계약 — "클릭 = 무장, 칩 = 실행"

`chip` 모드에서 실행 제스처가 도착하면 링크를 열지 않고 대상 옆에 액션 칩을 렌더한다.

| 대상 | surface | 칩 액션 |
| --- | --- | --- |
| 파일 | desktop | 뷰어 열기 · OS 로 열기 · 경로 복사 |
| 디렉터리 | desktop | CWD 이동 · 파일 관리자에서 열기 · 경로 복사 |
| URL | desktop | 브라우저 열기 · URL 복사 |
| 파일 | Remote | 뷰어 열기 · 경로 복사 |
| 디렉터리 | Remote | 탐색기 열기 · 경로 복사 |
| URL | Remote | 브라우저 열기 · URL 복사 |

- **권한 경계 불변.** Remote 칩에 OS 열기·CWD 전파는 없다 — 칩은 기존 액션의 표시 방식일 뿐, 새 실행 표면을 만들지 않는다(ADR-0045). desktop 칩의 "OS 로 열기"는 ADR-0100 과 같은 프론트엔드 라우팅(`onOsAction`)·같은 확인 정책을 통과한다. 하드 클래스 확인은 모드·경로와 무관하게 항상 수행된다.
- **한 번에 칩 하나.** 새 실행 제스처는 기존 칩을 교체한다.
- **수명은 밑줄 수명에 종속.** 칩이 가리키는 밑줄이 재검증에서 폐기되면(ADR-0220 안정 프레임 판정) 칩도 즉시 소멸한다. 그 외 Esc, 칩 밖 클릭/탭, 스크롤, 선택 시작, terminal/lease/워크스페이스 전환, resize 도 칩을 소멸시킨다. URL 은 밑줄 엔트리가 없으므로 칩 생성 시점의 (버퍼 라인, 컬럼 범위, 원문) 을 캡처해 같은 판정을 적용한다.
- **칩은 surface-local UI 상태다.** settings 에도 localStorage 에도 저장하지 않는다(ADR-0004).
- **발견성:** `chip` 모드에서는 칩 자체가 액션 목록을 보여 주므로 ADR-0100 의 hover 힌트 라벨을 대체한다. `immediate` 모드의 힌트 라벨은 그대로 둔다.

### 4. 제스처 소유권 — 재배치 없음

- **Ctrl / Ctrl+Shift + 밑줄 클릭(desktop)** 은 두 모드 모두에서 ADR-0100 대로 칩 없이 직행한다(확인 게이트 포함). 수정자 자체가 명시적 제스처이므로 `chip` 모드가 이를 다시 게이트하지 않는다 — 파워유저 바이패스.
- **#352 Shift/Alt TUI 우회(desktop)** 도 설정과 무관하게 즉발 유지. 같은 근거.
- **Remote 탭 시퀀스:** 미검증 문구 탭 = `point` 발견(현행). `chip` 모드에서 밑줄/URL 탭 = 칩. 롱프레스·더블탭 = 단어 선택(현행, 불변).
- **desktop 클릭 시퀀스:** 미검증 문구 클릭 = `point` 발견(현행). `chip` 모드에서 밑줄/URL 클릭 = 칩.
- `immediate` 모드는 현행 동작과 바이트 단위로 동일하다.

### 5. Remote URL 과 Android bridge

`chip` 모드의 Remote URL 탭은 칩을 먼저 띄우고, "브라우저 열기" 액션이 기존 `openRemoteUrl` 경로(브라우저 Remote 는 `window.open`, Android 는 `LaymuxNative.openExternalUrl` — ADR-0162 검증 계약 그대로)를 호출한다. 검증·bridge 표면은 바뀌지 않고 호출 시점만 사용자 확인 뒤로 이동한다.

## Alternatives Considered

- **수정자 필수 모드(Ctrl+클릭 = 내부 열기, VS Code 관례)**: 관례라 학습 비용이 낮다. 그러나 Ctrl 은 ADR-0100 OS 열기가 소유해 전면 재배치가 필요하고, 재배치하면 기존 근육기억을 깨며, 터치 Remote 에는 대응 제스처가 아예 없어 surface 간 모델이 갈라진다. 기각.
- **더블클릭/더블탭 실행**: 추가 UI 없이 명시성을 얻는다. 그러나 두 surface 모두에서 더블클릭은 단어 선택이 소유한다. 기각.
- **Remote 롱프레스 실행**: 단어 선택이 소유. 기각.
- **하단 시트(모바일 관례)**: 터치 오탭에 강하고 액션이 많아도 수용한다. 그러나 화면 하단으로 시선·손가락이 이탈해 링크와 액션의 공간 연결이 끊기고, desktop 에 이식하면 이질적이라 surface 통일이라는 이 설계의 핵심 이득을 잃는다. 사용자가 명시적으로 기각.
- **밑줄 위 우클릭 컨텍스트 메뉴**: ADR-0100 이 이미 기각한 방향(우클릭 = 복사/붙여넣기 소유). 재론하지 않는다.
- **설정 키 하나에 조합값(`"immediate" | "chip" | "chip-paths-only"` 등)**: 키 수는 준다. 그러나 URL/path 의 독립 선택이 조합값 폭발로 이어지고, 사용자가 원한 것은 정확히 "URL 과 파일을 따로 고르기"다. 키 2개가 더 정직하다. 기각.
- **첫 클릭 = 무장, 같은 대상 두 번째 클릭 = 실행(칩 없는 2단계)**: UI 를 그리지 않아 가볍다. 그러나 무장 상태가 비가시적이라 "다음 클릭이 실행"임을 알 수 없고, 파일/디렉터리/OS 열기/복사의 액션 분기를 표현할 수 없다. ambient 발견이 이미 밑줄을 미리 깔아 두는 모델에서는 첫 탭이 곧 두 번째 탭이 되는 경합도 남는다. 기각.
- **칩에 자동 확정 타이머(N초 뒤 기본 액션 실행)**: 조작 수가 준다. 그러나 지연 실행은 예측 불가능한 시점에 부수효과를 만들고, 이 결정의 목적(의도하지 않은 실행 제거)과 정면 충돌한다. 기각.

## Consequences

- 사용자는 대상별로 즉발/명시 실행을 고른다. `chip` 모드에서는 hover·유휴 스캔이 깔아 둔 밑줄을 실수로 클릭해도 아무것도 실행되지 않고, 칩이 가능한 액션을 전부 보여 준다 — OS 열기의 발견성 문제(ADR-0100 Consequences)가 `chip` 모드에서는 구조적으로 해소된다.
- desktop 과 Remote 가 같은 멘탈모델("클릭 = 무장, 칩 = 실행")을 공유한다. 수정자 지도는 재배치되지 않는다.
- `chip` 모드는 모든 실행에 조작 1회를 추가한다. 즉발을 원하는 사용자는 기본값(`immediate`)에 머물거나 desktop 에서 수정자 바이패스를 쓴다.
- 설정 키가 2개 늘어난다 — 스키마·`describe_settings`·`validate_settings`·Settings UI·i18n 동반 갱신(ADR-0004/0032).
- Remote page(`remote-app.js`)와 desktop `TerminalView` 에 칩 렌더·수명 관리가 추가된다. 칩 수명 판정은 ADR-0220 의 안정 프레임 계약을 공유하므로 별도 수명 규칙을 만들지 않는다.
- URL 칩은 밑줄 엔트리가 없어 원문 캡처 기반 수명 판정이 새로 필요하다 — path 와 달리 stat 검증이 없으므로 캡처한 (라인, 범위, 원문) 재검사만 수행한다.
- 원격 주체가 `update_settings` 로 두 키를 `immediate` 로 되돌릴 수 있다. 이는 현행 기본값으로의 회귀일 뿐 새 권한이 아니며, OS 열기의 안전장치(로컬 수정자 제스처 + 하드 클래스 확인)는 설정과 무관하게 남는다(ADR-0100 Decision 5).
- 테스트: ① 모드×대상×surface 제스처→결과 매핑 순수 함수, ② `chip` 모드에서 밑줄/URL 클릭이 아무것도 실행하지 않음, ③ 칩 액션별 라우팅(뷰어/CWD/OS/브라우저/복사)과 하드 클래스 확인 통과, ④ 칩 소멸 조건(재검증 폐기·Esc·밖 클릭·스크롤·선택·전환), ⑤ 수정자 바이패스가 모드와 무관함, ⑥ Remote e2e 탭→칩→실행 시퀀스, ⑦ `immediate` 가 현행과 동일함(회귀).
- 후속 문서: [data-flow.md §8.6](../architecture/data-flow.md) 클릭 분기 표와 [api-contracts.md](../architecture/api-contracts.md) 설정 스키마 절을 구현 PR 에서 함께 갱신한다.
