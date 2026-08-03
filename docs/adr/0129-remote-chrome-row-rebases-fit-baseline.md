# 0129. Remote chrome 행의 등장·소멸은 crop 대상이 아니라 fit 기준선 재설정

- Status: Accepted
- Date: 2026-08-03
- Source: 사용자 보고(리모트 접속 직후 터미널 폭이 좁게 시작해 나중에 교정됨) · [ADR-0038](0038-remote-height-shrink-surface-crop.md) · [ADR-0124](0124-remote-widget-strip-mirrors-desktop.md)
- Relation: [ADR-0038](0038-remote-height-shrink-surface-crop.md)의 "폭 불변 + 높이 축소 → crop" 조건을 **정정**해 chrome 행 변화를 제외한다.

## Context

ADR-0038 은 remote surface 에서 폭이 변하지 않고 높이만 줄면 PTY geometry 를 유지하고 xterm surface 를 바닥 고정으로 crop 한다. 이 결정이 겨냥한 원인은 모두 **일시적이고 사용자가 되돌리는 입력 표면**이다: 소프트 키보드, composer drag, 키바 토글, URL bar.

ADR-0124 의 위젯 스트립은 성질이 다르다. 접속 직후 `/remote/v1/widgets` 응답이 도착할 때 한 번 나타나고, 그 뒤 세션 내내 그 높이를 점유한다. 등장 시점은 attach 와 경쟁한다 — `openOutput` 의 fit 이 스트립 없는(더 높은) host 를 `fittedHostHeight` 로 기록한 다음 스트립이 뜨면, 이후 모든 fit 이 "높이만 줄었다" 조건에 걸려 crop 분기로 빠진다. 기준선은 세션 내내 stale 상태로 남는다.

관측된 증상(playwright 계측, viewport 420×860, 원격 폰트 500ms 지연):

|             | cols | 그려진 폭 / host |
| ----------- | ---- | ---------------- |
| 스트립 없음 | 53   | 379 / 408        |
| 스트립 있음 | 47   | 336 / 408        |

attach fit 은 원격 폰트가 로드되기 전 폴백 폰트의 넓은 cell 로 측정되어 cols 를 작게 잡는다. 폰트가 도착하면 `loadRemoteFont` 가 재측정+refit 을 요청하지만(ADR-0077), 그 refit 이 crop 분기에서 early return 되어 cols 가 폴백 값에 고정된다. 실제 cell 은 더 좁으므로 오른쪽에 약 43px 빈 폭이 남고, PTY 로도 잘못된 geometry 가 고정된다. 폭이 바뀌는 이벤트(회전 등)가 와야 crop 분기를 벗어나 교정된다.

비목표: ADR-0038 의 crop 정책 자체 철회, 입력 표면(키보드·composer·키바) 축소 처리 변경, 데스크톱 fit 정책 변경.

## Decision

**Remote chrome 행이 나타나거나 사라지면 fit 기준선을 버리고 다시 fit 한다.** crop 은 "일시적으로 가려진 뷰포트"를 위한 것이고, chrome 행 변화는 영구 레이아웃 변경이므로 surface 가 새 host 를 그대로 채택해야 한다.

- `rebaseTerminalFit()` 이 `fittedHostHeight` 를 0 으로, `cropActive` 를 false 로 되돌리고 refit 을 예약한다. 다음 fit 은 높이 축소 분기를 만나지 않고 host geometry 를 채택해 PTY 에도 전파한다.
- 위젯 스트립의 표시 상태가 **뒤집힐 때만** 호출한다. 값 갱신(같은 스트립의 숫자 변화)은 높이를 바꾸지 않으므로 재설정하지 않는다.
- 등장·소멸 양방향 모두 호출한다. 소멸(높이 증가)은 ADR-0038 에서도 이미 채택 경로지만, 기준선을 남겨 두면 이후 축소 판정이 사라진 스트립 시절 높이를 기준으로 삼는다.
- 판정은 여전히 geometry 기반이다. 특정 위젯·특정 TUI 를 식별하지 않고, "이 행의 표시 여부가 바뀌었다"는 소유자 자신의 사실만 쓴다.

ADR-0038 의 나머지는 불변이다: 입력 표면으로 인한 높이 축소는 계속 surface-local crop 이며, 폭 변경·높이 증가·alternate buffer 는 계속 fit 을 전파한다.

## Alternatives Considered

- **visualViewport 높이 변화로 키보드만 구분해 crop**: composer drag·키바 토글은 visual viewport 를 바꾸지 않으므로 ADR-0038 이 의도한 원인들이 crop 을 잃는다. ADR-0038 이 이미 기각한 키보드 감지 휴리스틱과 같은 실패다.
- **스트립을 터미널 위에 떠 있게(absolute) 두어 높이를 안 먹게 한다**: 휴대폰에서 지표가 터미널을 덮는다. ADR-0124 가 스트립을 행으로 둔 이유를 되돌린다.
- **스트립 자리를 항상 예약(빈 행 유지)**: 위젯이 하나도 없는 사용자에게 영구히 세로 픽셀을 버린다. ADR-0124 의 "빈 스트립은 높이 0" 결정과 충돌한다.
- **attach 를 첫 위젯 응답 뒤로 미룬다**: 스트립이라는 부가 표면이 터미널 접속을 지연시킨다. 폰트 로드처럼 나중에 도착하는 다른 refit 원인도 여전히 남는다.

## Consequences

- 스트립 등장 시 rows 가 한 번 줄어들며 PTY resize 가 1회 전파된다. scrollback reflow 형 TUI(codex)는 접속 직후 1회 재출력한다 — ADR-0038 이 "진짜 geometry 변경"으로 분류한 경우와 같고, 세션당 한 번이다.
- 폰트 로드·buffer 전환 등 attach 이후 도착하는 refit 이 더 이상 stale 기준선에 막히지 않는다.
- chrome 행을 새로 추가하는 쪽은 표시 상태가 뒤집힐 때 `rebaseTerminalFit()` 을 호출할 책임을 진다. 입력 표면(키바·composer)은 의도적으로 호출하지 않는다.
- 재검토 조건: remote 가 Full UI 로 전환되어 fit 스케줄러(ADR-0026)를 데스크톱과 공유하게 되는 시점.
