# 0063. Remote 재접속은 문서가 보일 때만 자동으로 claim 한다

- Status: Proposed
- Date: 2026-07-26
- Source: issue #561(사용자 피드백: 홈으로 내렸다가 한참 뒤 돌아오면 매번 Connect 를 눌러야 함), [ADR-0027](0027-remote-connection-graceful-recovery.md)(연결 유예와 무표시 자동 복구), [ADR-0037](0037-remote-lease-takeover-and-pagehide-release.md)(pagehide release), [ADR-0013](0013-direct-remote-mode.md), architecture/api-contracts.md §13

## Context

Remote page 는 떠날 때 lease 를 반납한다(ADR-0037 pagehide release). 반납이 유실되더라도 45초 heartbeat 유예가 지나면 lease 는 만료된다. 즉 **모바일에서 홈으로 내리고 한참 뒤 돌아오면 반드시 연결이 끊겨 있다.** 돌아온 사용자는 매번 Connect 를 눌러야 했고, 오래 자리를 비웠으면 브라우저가 탭 자체를 폐기해 문서가 새로 로드되므로 메모리에 둔 상태로는 그 복귀를 알 수도 없다.

ADR-0027 은 짧은 transport 단절을 기존 lease 안에서 흡수했지만, 마지막 항목에서 **"서버가 기존 lease 의 상실을 확정한 뒤 브라우저가 새 lease 를 자동 claim 하지 않는다"** 고 못박았다. 그 근거는 하나였다 — 단절 사이에 PC 사용자가 되찾은 제어권을, 보이지도 않는 브라우저 탭이 조용히 다시 가져가면 안 된다.

서버는 claim 을 이미 좁게 막는다: remote 비활성(`403`), 다른 lease 보유·PC reclaim lockout(`409`), 진행 중인 로컬 입력(`409 input_busy` + reservation), 잘못된 토큰(`401`). 자동 claim 이 성공할 수 있는 창은 "원격 제어가 허용돼 있고, 아무도 lease 를 들고 있지 않으며, 로컬 입력이 진행 중이지 않은" 순간뿐이다.

## Decision

Remote page 는 **문서가 보이는 순간에만** 이전 세션의 제어권을 자동으로 되찾는다. ADR-0027 의 마지막 항목을 이 범위로 좁힌다(전체 번복 아님 — 유예·무표시 복구·토큰 취급은 그대로다).

- **의도는 사용자의 두 동작이 표현한다.** Connect 성공이 "이 탭이 제어권을 갖겠다" 는 의사이고, Release 가 그 철회다. 이 의도는 `localStorage` 의 `laymux.remote.autoConnect` 에 남긴다 — 긴 백그라운드는 문서를 폐기시키므로 메모리 플래그로는 정작 이 기능이 필요한 복귀를 못 본다.
- **자동 claim 은 `visibilityState === "visible"` 일 때만 시도한다.** 배경 탭에서는 어떤 경로로도 시도하지 않는다. 트리거는 같은 순간을 가리키는 세 신호다 — 탭 전환(`visibilitychange`), visibilitychange 를 내지 않는 bfcache 복귀(`pageshow`), 열려 있는 페이지에서 네트워크가 돌아온 경우(`online`).
- **확정적 거절은 답이지 결함이 아니다.** `401`/`403`/`409` 를 받으면 자동 재시도를 **해제**하고 사용자 조작을 기다린다. 재시도가 바꿀 수 있는 것이 없고, 반복 시도는 ADR-0027 이 거부한 그 탈취가 된다.
- **일시 오류는 지수 backoff 로 재시도한다.** 1초에서 시작해 최대 15초, 보이는 동안에만. 배경으로 가면 타이머를 취소한다.
- **소유권은 claim 이 판정한다. heartbeat 는 못 한다.** heartbeat 의 `409` 는 문자열 그대로 "네 lease 가 활성이 아니다" 이며 **지금 누가 제어권을 가졌는지 말하지 않는다** — 자리를 비운 사이의 만료와 호스트 탈취가 똑같이 이 응답을 낸다(실기에서 확인: 상태 코드로 구분하려던 첫 구현이 정상 복귀를 "Control returned to the host" 로 판정하고 자동을 해제했다). heartbeat 단계에서 확정으로 취급하는 것은 `401`(토큰)·`403`(원격 비활성)뿐이고, 나머지는 재claim 을 시도해 **그 응답**으로 판정한다.
- **claim 의 `409` 는 두 가지다.** 직전 소유권 handoff 가 아직 drain 중이면(`transitioning: true`) "아직" 이므로 backoff 후 재시도한다. 그 외(다른 controller 보유, PC reclaim lockout)는 "아니오" 이므로 의도를 해제한다. 그래서 conflict 본문의 `active`/`transitioning` 을 클라이언트 오류 객체로 올린다.
- **되찾는 중인 만료는 실패로 그리지 않는다.** 자리를 비운 사이의 만료는 곧 되돌릴 상태이므로 빨간 오류 대신 `Reconnecting...` 만 보여준다(실기에서 빨강이 1초쯤 번쩍였다). 이 경로에서는 만료된 lease 를 반납하지 **않는다** — 반납은 서버를 drain(`transitioning`) 상태로 만들고, 그 동안 우리 자신의 재claim 이 409 를 받아 의도가 해제된다. 같은 이유로 resume capability 도 이 경로에서만 유지한다(ADR-0037 의 자기 zombie lease 대체 용도이며, 호스트가 가져간 경우에는 기존대로 폐기한다).
- 서버 계약은 바뀌지 않는다. 클라이언트 변경만으로 성립한다.

## Alternatives Considered

- **자동 연결 토글 UI 추가**: 명시적이지만, Connect/Release 라는 기존 두 동작이 이미 같은 의사를 표현한다. 설정을 하나 더 만드는 대신 그 동작에 의미를 부여했다. 사용자가 자동을 원치 않으면 Release 를 한 번 누르면 된다.
- **배경에서도 heartbeat 를 유지해 lease 를 붙잡기**: 복귀 시 끊김이 아예 없지만, 자리를 비운 동안 PC 사용자가 제어권을 되찾지 못한다. 모바일 브라우저가 배경 타이머를 조이므로 신뢰할 수도 없다. 떠날 때 놓고 돌아올 때 되찾는 편이 소유권 모델과 일치한다.
- **`session/status` 를 먼저 조회해 비어 있을 때만 claim**: 조회와 claim 사이의 경쟁을 없애지 못하고, 서버가 이미 같은 조건을 원자적으로 판정한다. 왕복만 한 번 늘어난다.
- **로드 시에도 자동 연결하지 않고 복귀 전환만 처리**: 안전하지만 정작 흔한 경우(탭이 폐기된 뒤 재로드)를 놓친다. 그래서 의도 플래그를 저장소에 둬 재로드도 같은 복귀로 취급한다.

## Consequences

돌아오면 연결돼 있다 — 사용자가 요청한 동작이다. Release 를 누른 사용자는 자동 연결을 만나지 않는다.

대가: PC 사용자가 **명시적 reclaim 없이** 그냥 PC 를 쓰고 있는 동안 폰 탭을 다시 열면 제어권이 폰으로 넘어갈 수 있다. lockout 은 명시적 reclaim 에만 걸리기 때문이다. 이는 수동 Connect 로도 동일하게 일어나며, 반대편에는 데스크톱의 원격 허용 게이트와 즉시 reclaim 이 있다. 이 창이 문제가 되면 다음 단계는 "로컬 입력이 최근 N 초 안에 있었으면 자동 claim 거절" 을 서버 판정으로 추가하는 것이다 — 클라이언트가 아니라 서버가 판정해야 경쟁이 없다.

`laymux.remote.autoConnect` 는 의사 표시일 뿐 비밀이 아니다. 토큰(`laymux.remote.token`)은 기존과 동일하게 취급하며 이 결정으로 저장 범위가 넓어지지 않는다.

실기 검증은 "모바일 홈 → 장시간 → 복귀" 한 경로다. bfcache 복귀와 탭 폐기 후 재로드는 브라우저마다 다르게 갈리므로 세 신호를 모두 건다.
