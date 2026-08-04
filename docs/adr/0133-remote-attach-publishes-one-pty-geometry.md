# 0133. Remote attach 는 PTY geometry 를 한 번만 게시한다

- Status: Proposed
- Date: 2026-08-04
- Source: 사용자 보고(리모트로 Claude 선택지 화면 pane 에 진입하면 화면이 위로 밀리고 숫자 입력이 반영되지 않은 것처럼 보인다) · [ADR-0069](0069-remote-render-checkpoint-attach.md) · [ADR-0077](0077-remote-terminal-font-serving.md) · [ADR-0124](0124-remote-widget-strip-mirrors-desktop.md) · [ADR-0129](0129-remote-chrome-row-rebases-fit-baseline.md) · [architecture/api-contracts.md §13](../architecture/api-contracts.md)
- Relation: [ADR-0129](0129-remote-chrome-row-rebases-fit-baseline.md) 가 "스트립 등장 시 PTY resize 1회 전파"를 수용값으로 남긴 것을 **정정**하고, 그 ADR 이 기각한 "attach 를 첫 위젯 응답 뒤로 미룬다"를 **bounded 대기**로 좁혀 채택한다. [ADR-0038](0038-remote-height-shrink-surface-crop.md) 의 crop 정책과 [ADR-0069](0069-remote-render-checkpoint-attach.md) 의 checkpoint 계약은 그대로 둔다.

## Context

Remote attach 는 브라우저 xterm 을 viewport 에 fit 한 뒤 그 `cols/rows` 를 PTY 로 보내고, 같은 geometry 에서 만든 화면 checkpoint 를 재생한다(ADR-0069). PTY geometry 는 surface 로컬 값이 아니라 SIGWINCH 로 프로세스에 전달되는 전역 상태이므로, attach 는 실질적으로 "터미널 창 크기 변경" 이벤트를 앱에 던진다.

프레임을 다시 그리는 TUI 는 이 이벤트를 감당하지 못한다. Claude Code(Ink)는 이전 프레임을 지울 때 **자기가 인쇄했다고 기억하는 줄 수**만큼 상대 커서 이동으로 지운다. 그 줄 수는 이전 폭에서 센 값이므로, 폭이 줄어 프레임이 더 많은 행으로 감싸진 뒤에는 지움이 모자라고 옛 프레임의 나머지가 화면에 남는다. 이후 키 입력은 살아 있는 프레임만 다시 그리므로, 옛 프레임의 `❯` 표시가 그대로 보이고 사용자는 "숫자를 눌렀는데 반영되지 않는다"고 읽는다. 좁은 휴대폰 폭에서 잔여 프레임이 화면을 밀어 올리면 증상은 더 뚜렷하다.

`*.screen.test.ts` 계측(ADR-0074)으로 두 사실을 분리했다. (1) checkpoint 직렬화·재생 경로는 충실하다 — 같은 geometry 로 in-place resize 한 터미널과 셀 단위로 동일하다. (2) 손상은 폭 변경 자체가 만든다. 즉 전송 계층 결함이 아니라 attach 가 만드는 geometry 변경 횟수가 문제다.

그런데 attach 는 geometry 를 한 번만 바꾸지 않았다. 세 가지가 순서를 다투었다.

- **원격 폰트**(ADR-0077) — attach fit 은 그 순간 측정 가능한 폰트로 재고, 폰트가 도착하면 셀 폭이 바뀌어 `cols` 가 움직인다. ADR-0129 는 릴레이에서 이 지연을 500ms 로 계측했고 53 → 47 cols 변화를 기록했다.
- **위젯 스트립**(ADR-0124) — 접속 직후 한 번 나타나 chrome 행을 점유하므로 `rows` 가 움직인다. ADR-0129 는 이때 PTY resize 1회를 수용값으로 명시했다.
- **xterm 자신의 셀 측정** — xterm 은 surface 를 열 때 한 번, 그 뒤에는 resize 할 때만 셀을 잰다. 폰트가 확정되기 전에 열린 surface 는 낡은 셀 크기를 들고 있고, 첫 fit 은 그 값으로 격자를 제안한다. 그 fit 의 `resize()` 가 재측정을 유발하므로 교정된 격자는 **다음** fit 에서야 나타난다. 계측에서 8.213×16 → 7.700×17 로 바뀌며 47×46 → 50×43 이 되었다.

셋이 모두 attach 뒤에 도착하면 1초 안에 SIGWINCH 두세 번이 나가고, 잔여 프레임 밴드도 그만큼 쌓인다. 릴레이 지연이 클수록 이 셋이 서로 갈라져 각각 별개의 resize 가 된다 — 로컬/direct 나 폰트가 캐시된 재접속에서 "보통은 괜찮다"고 보이는 이유다. 릴레이는 sequence 무손실이므로(ADR-0097) 바이트가 깨지는 문제는 아니다.

백엔드에도 증폭 경로가 있었다. `resize_terminal_inner` 는 요청 크기가 현재 PTY 크기와 같아도 물리 resize 를 그대로 실행했다. ConPTY 재적용은 앱에 창 크기 이벤트를 다시 전달하므로, 아무 상태도 바꾸지 않는 요청이 재출력을 유발할 수 있다.

범위는 Remote attach 의 geometry 게시 시점과 PTY resize 진입점이다. 비목표: ADR-0038 crop 정책 변경, ADR-0069 checkpoint 계약 변경, 데스크톱 fit 정책 변경, 특정 TUI 식별(어떤 앱이 붙어 있는지 보고 분기하지 않는다), Claude/Ink 의 지움 계산을 우회하려는 시도.

## Decision

**Remote attach 는 PTY geometry 를 한 번만 게시한다. 늦게 도착하는 chrome 원인이 정착할 때까지 bounded 하게 기다린 뒤 측정이 수렴한 격자 하나를 보내고, 그 대기 동안에는 어떤 fit 도 geometry 를 게시하지 않는다. PTY 크기를 바꾸지 않는 resize 요청은 물리 경로로 내려가지 않는다.**

- **정착 대기.** attach 는 (a) 원격 폰트 상태가 `loading` 이 아니고 (b) 위젯 스트립이 응답을 한 번 받은 뒤에 첫 fit 을 수행한다. "정착"은 "존재"가 아니다 — 포기한 폰트와 빈 스트립도 정착이며, 스스로 격자를 다시 움직이지 않는다는 뜻이다. 상한은 `REMOTE_ATTACH_CHROME_SETTLE_MS`(900ms)이고, 초과하면 그대로 진행한다. 도착하지 않는 폰트가 터미널을 인질로 잡는 것보다 reflow 1회가 낫다.
- **대기 중 게시 금지.** 대기 동안 surface 는 계속 fit 한다(레이아웃은 정확해야 한다). 그러나 `queueResize` 는 게시하지 않으며, 대기 시작 시점에 예약돼 있던 resize 도 취소한다. 이 hold 가 없으면 스트립의 refit 이 attach 보다 먼저 게시돼 정확히 이 결정이 없애려는 SIGWINCH 가 된다.
- **측정 수렴.** attach fit 은 제안된 격자가 더 움직이지 않을 때까지(최대 3 pass) 반복한 뒤 geometry 를 확정한다. xterm 의 재측정은 fit 자신의 `resize()` 가 유발하므로 통상 2 pass 에서 수렴하고, 세 번째까지 흔들리는 것은 측정과 레이아웃의 싸움이어서 한 pass 더로 이기지 못한다.
- **무변경 resize 는 무동작.** `resize_terminal_inner` 는 소유권 게이트를 통과한 뒤 요청 크기가 세션 크기와 같으면 거기서 끝난다. 게이트 뒤라는 순서가 계약이다 — 권한 판정은 크기 일치와 무관하게 이전과 같아야 한다. geometry revision 은 이미 크기 변경에서만 증가하므로(ADR-0085 경계) 이 결정은 revision 의미를 바꾸지 않는다.
- **판정은 geometry 기반이다.** 어떤 TUI 가 붙어 있는지, 화면에 선택지가 있는지 보지 않는다. 소유자 자신의 사실("이 표면이 아직 격자를 움직일 수 있다", "이 요청은 PTY 크기를 바꾸지 않는다")만 쓴다.
- **세션 중 변경은 그대로다.** attach 이후 스트립 토글·회전·키보드는 ADR-0038/0129 경로를 그대로 따른다. 이 결정은 attach 순간에만 적용된다.

## Alternatives Considered

- **attach 후 refit 을 일정 창 동안 합쳐 최종 geometry 하나만 보낸다**: checkpoint 는 PTY geometry 와 같은 격자에서만 재생할 수 있으므로(ADR-0069) resize 를 미루면 attach 자체가 미뤄진다. 화면이 비어 있는 시간은 같고, 그 사이 도착한 delta 를 어떤 격자로 해석할지 새 문제가 생긴다.
- **attach 를 첫 위젯 응답 뒤로 무조건 미룬다** (ADR-0129 가 기각): 부가 표면이 터미널 접속을 무한히 지연시킬 수 있다. 여기서는 상한을 둬 그 위험을 없애고, 폰트·셀 측정까지 같은 게이트로 묶어 "다른 refit 원인이 남는다"는 기각 사유도 해소했다.
- **폰트가 준비될 때까지 xterm 생성을 미룬다**: 셀 측정 문제는 사라지지만 폰트가 느린 세션에서 터미널 표면 자체가 늦게 뜨고, 폰트를 광고하지 않는 데스크톱과 경로가 갈린다.
- **`document.fonts.ready` 를 기다린다**: 폰트 로딩 완료는 알려주지만 xterm 의 캐시된 셀 크기를 다시 재게 하지 않는다. 재측정을 유발하는 것은 결국 resize 이므로 수렴 반복이 필요하다.
- **폰트 family 문자열을 흔들어 강제 재측정한다**: 동작하지만 렌더러 내부 동작에 의존하는 우회다. fit 반복은 공개 API 만 쓰고 원인(폰트·가시성·줌)을 열거하지 않는다.
- **무변경 resize 를 소유권 게이트보다 먼저 걸러낸다**: 더 싸지만 비소유자가 크기를 맞춰 요청하면 성공 응답을 받는다. 게이트가 먼저다.
- **Claude/Ink 쪽 지움 계산을 보정한다(전체 재출력 유도 등)**: 앱 내부 계약을 추측해 바이트를 주입하는 일이며, PTY 를 사용자 입력의 단일 소유자로 두는 원칙을 깬다.

## Consequences

- 폰트·스트립이 늦은 첫 attach 는 최대 900ms 늦게 격자를 게시한다. 그 시간 동안 이전 pane 의 화면은 유지되고(대기는 `stopSocket` 앞이다), 첫 접속에서는 빈 터미널이 그만큼 유지된다. 대가로 attach 당 SIGWINCH 는 1회다.
- 재접속·pane 전환은 폰트가 이미 `ready`, 스트립이 이미 응답한 상태이므로 대기가 0 이다. 비용은 세션 첫 attach 에 한 번 든다.
- ADR-0129 의 rebase 경로는 유지된다. attach 시점에는 이제 스트립이 먼저 정착하므로 그 경로를 타지 않고, 세션 중 스트립 토글에서만 쓰인다. 해당 e2e 는 위젯 응답을 attach resize 뒤로 미루는 기존 방식 그대로 rebase 를 계속 검증한다.
- 무변경 resize 가 무동작이 되면서 클라이언트의 중복 게시가 무해해진다. 반대로 "같은 크기로 다시 보내 ConPTY 를 강제로 재동기화한다"는 우회는 더 이상 통하지 않는다 — 그런 필요가 생기면 별도 명시적 경로로 만들어야 한다.
- 대기가 끝나기 전에 lease 를 잃거나 다른 pane 으로 옮기면 attach 는 게시 없이 중단한다. hold 는 `finally` 로 해제되므로 중단 경로가 geometry 게시를 영구히 막지 않는다.
- 테스트: (1) 폰트·스트립이 모두 늦게 도착하는 attach 가 resize 를 정확히 1회 보내고 그 값이 최종 격자와 같다, (2) 폰트가 영원히 오지 않아도 상한 안에 attach 하고 resize 는 1회다, (3) checkpoint 재생이 in-place resize 와 셀 단위로 같고 잔여 프레임 증상이 폭 변경에서 온다(screen tier), (4) 같은 크기 resize 는 소유권 게이트 뒤에서 멈추고 크기 변경은 물리 경로까지 내려간다.
- 재검토 조건: Remote 가 Full UI 로 전환돼 fit 스케줄러(ADR-0026)를 데스크톱과 공유하는 시점, 또는 xterm 이 셀 재측정 공개 API 를 제공해 수렴 반복이 불필요해지는 시점.
