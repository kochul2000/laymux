# 0163. Android foreground는 Remote 문서 런타임을 보존한다

- Status: Proposed
- Date: 2026-08-16
- Source: 사용자 요구, `docs/architecture/api-contracts.md` §13.2, ADR-0149, ADR-0155, ADR-0159
- Extends: [ADR-0155](0155-android-background-remote-lease-grace.md)

## Context

ADR-0155는 Android 앱이 잠시 background로 전환될 때 controller lease와 E2E session을 유예한다. 그러나 native `onStop`은 보안을 위해 진행 중 RPC와 output transport를 폐기하고, 기존 foreground 복구는 PC 소유 Remote 문서를 통째로 다시 적재했다. 따라서 lease가 살아 있어도 짧은 앱 전환마다 xterm viewport, terminal 선택 hint, composer 초안 같은 문서 메모리 상태가 사라지고 사용자는 연결이 끊겼다가 새로 붙는 동작을 보게 됐다.

Android native가 암호화 session과 transport를 소유하고 PC가 Remote HTML과 surface 상태를 소유한다는 ADR-0149의 경계는 유지해야 한다. 미전송 입력을 저장소에 영속해서는 안 되며, 최신 APK가 foreground callback을 모르는 이전 PC의 Remote 문서를 열 수도 있다.

## Decision

Android foreground 복구는 현재 main document가 정확한 synthetic Remote origin에 있고 foreground callback을 지원하면 문서를 reload하지 않고 그 callback으로 native transport만 다시 연결한다.

Native는 pending encrypted RPC의 sequence를 먼저 확정한 뒤 Remote 문서에 foreground 복구를 알린다. Remote 문서는 Android 시작 URL의 auto-connect 의사를 다시 활성화하고, pagehide 때 임시 저장한 resume capability를 즉시 메모리로 회수하며, background 진입 때 native가 폐기한 HTTP 요청의 Promise를 transient 실패로 종료한다. 이어서 stale output peer를 닫아 기존 snapshot reattach 경로를 시작하고 retained lease를 즉시 heartbeat로 검증한다. 따라서 첫 claim 도중 background로 전환된 경우도 자동으로 다시 시도하고, 문서 메모리의 terminal 선택, xterm viewport, composer 초안은 그대로 유지한다.

현재 문서의 origin 또는 surface가 다르거나 callback이 없거나 callback 실행에 실패하면 native는 기존처럼 인증된 Remote 시작 문서를 다시 적재한다. Lease가 background에서 반납·만료됐다면 즉시 heartbeat와 기존 visible-only auto reclaim 계약이 새 소유권을 판정한다. Native session suspension과 output 폐기 정책, Remote 외부 API 계약은 바꾸지 않는다.

## Alternatives Considered

항상 문서를 reload하는 기존 방식은 단순하고 이전 문서와 호환되지만, lease를 유지한 짧은 background에서도 surface-local 상태와 체감 연결을 잃는다.

terminal 선택과 viewport, composer 초안을 `sessionStorage`에 저장해 reload 뒤 복원하는 방식은 전송하지 않은 민감 입력의 비영속 경계를 깨고 각 상태의 직렬화·정합성 계약을 새로 만든다.

Native output과 RPC를 background에서도 그대로 유지하는 방식은 Android lifecycle 중 network 작업을 멈추고 key deadline을 고정한다는 ADR-0146·ADR-0155의 보안 및 자원 정책과 충돌한다.

## Consequences

짧은 background→foreground 왕복은 같은 Remote 문서와 xterm surface를 유지하고 transport만 새 snapshot에 부착한다. 기존 output 재접속의 지연 표시와 viewport 보존 규칙을 재사용하므로 별도 렌더 복원 프로토콜이 필요 없다.

Foreground callback은 native가 무효화한 HTTP Promise를 명시적으로 실패시켜야 하며, stale output을 모두 닫고 즉시 heartbeat를 실행해야 한다. 이 세 단계가 빠지면 문서 reload가 가려주던 pending 상태나 half-open socket이 남는다. APK와 PC 버전이 맞지 않으면 reload fallback이 계속 동작하므로 기능 저하는 기존 수준으로 제한된다.

실제 Android lifecycle과 WebView visibility 이벤트의 순서는 기기별 차이가 있으므로, 브라우저 계약 테스트와 native resume 정책 단위 테스트를 유지하고 향후 기기 자동화 계층이 준비되면 onStop→onStart 통합 테스트를 추가한다.
