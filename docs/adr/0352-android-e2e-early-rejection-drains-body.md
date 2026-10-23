# 0352. Android E2E RPC 조기 거부는 남은 body를 버리며 다 읽은 뒤에 응답을 끝낸다

- Status: Accepted
- Date: 2026-10-21
- Source: 사용자 결정("남은 body 버리고 응답") · PR #1245·laymux-server PR #95 리뷰 · [ADR-0351](0351-android-e2e-binary-rpc-streamed-through-relay.md)
- Amends: ADR-0351(조기 거부 시 "body 읽기를 중단" 조항)

## Context

ADR-0351은 desktop이 31 B prefix로 요청을 조기 거부하면 relay가 body 읽기를 중단하고 stream을 취소하도록 정했다. 구현 리뷰에서 이 조합이 클라이언트에 응답을 전달하지 못한다는 점이 드러났다.

- Android 클라이언트(`HttpURLConnection`, fixed-length streaming)는 body를 끝까지 쓴 뒤에야 status를 읽는다.
- 서버가 읽지 않은 body를 남긴 채 응답을 끝내고 연결을 닫으면, 쓰고 있던 클라이언트는 broken pipe·connection reset을 받고 status를 읽지 못한다. prod 앞단 Caddy(Go net/http)는 남은 body가 일정량을 넘으면 연결을 닫는다. desktop Direct 경로의 hyper도 같은 상황에서 연결을 닫을 수 있다.
- 앱은 쓰기 중 `IOException`을 재시도 가능한 네트워크 오류로 분류한다. 그래서 세션 무효(401·410) 같은 신호를 받지 못하고, 같은 대용량 envelope를 로컬 deadline 동안 반복 업로드한다. Direct에서는 잘못된 fallback 신호가 되어 Cloud로 내려간다.

작은 RPC는 body가 한 번에 다 써지므로 영향이 없다. 문제는 세션이 무효인 채로 큰 첨부를 올리는 경우다.

## Decision

**조기 거부의 판정은 그대로 일찍 내리되, 응답 완료는 남은 body를 저장하지 않고 끝까지 읽어 버린 뒤로 미룬다.**

- **relay (Cloud)**
  - desktop의 조기 `http.response`를 받으면 desktop으로의 body 전달을 멈춘다.
  - 클라이언트 body의 나머지는 ADR-0351의 누적 바이트 상한과 idle·총 시간 deadline 안에서 읽어 버린다.
  - body가 끝나면 desktop의 응답을 그대로 클라이언트에 보낸다.
  - 버리는 동안 상한 초과·deadline 초과가 나면 desktop의 응답을 보내고 연결을 닫는다. 클라이언트가 연결을 끊으면 그대로 정리한다.
  - 버리는 동안에도 이 route의 전용 동시 실행 lease는 유지한다. 그래야 버리기 단계도 동시 실행 상한에 묶인다.
  - desktop tunnel stream과 공유 proxy capacity는 desktop 응답을 받은 시점에 놓아도 된다.
- **desktop Direct 경로**: prefix 조기 거부 뒤 남은 body를 같은 상한과 idle deadline 안에서 읽어 버린 다음 응답을 끝낸다.
- **desktop Cloud tunnel 경로**: 버리기는 relay 책임이다. desktop은 ADR-0351대로 조기 `http.response`와 `stream.close`를 보내고, 늦게 도착하는 frame은 버린다.
- **버리는 바이트는 어디에도 누적하지 않는다.** 메모리 비용은 chunk 크기 수준으로 유지한다.
- **relay 첫 prefix deadline**: 31 B prefix가 짧은 시간 안에 도착하지 않으면 relay가 408로 끊는다. prefix가 오지 않으면 desktop 조기 거부가 동작하지 않으므로, 이 deadline 없이는 짧은 body로 전용 슬롯을 idle deadline 내내 점유할 수 있다.
- **Android 방어선**: 쓰기 단계 `IOException`에 대한 재시도 횟수에 상한을 둔다. 서버 쪽 버리기가 실패하는 예외 경로(중간 proxy, 망 단절)에서도 대용량 반복 업로드가 무한히 이어지지 않게 한다.

## Alternatives Considered

- **ADR-0351대로 즉시 중단**: 업로드 대역폭은 아끼지만, 클라이언트가 status를 받지 못해 오히려 같은 body를 반복 업로드한다. 대역폭 절감이라는 목적 자체를 달성하지 못한다.
- **앱만 수정**: 쓰기 실패를 따로 분류하고 재시도 전에 handshake로 세션 유효성을 확인한다. 서버를 그대로 둘 수 있지만 원인 정보(401·409·410·413)를 잃고 앱 상태 기계가 복잡해진다. Direct·Cloud 모두에서 fallback 판정이 추측에 의존한다.
- **`Expect: 100-continue`**: 정석적인 해법이지만 Android `HttpURLConnection`과 relay·Caddy·tunnel 전 구간의 지원이 일관되지 않는다.

## Consequences

- 세션이 무효인 채로 올린 큰 첨부는 한 번만 업로드된 뒤 정확한 status로 실패하고, 앱은 세션 무효 처리(재수립)로 넘어간다.
- relay와 desktop 메모리 이점은 유지된다. 버리는 body는 저장되지 않는다.
- 조기 거부된 요청의 업로드 대역폭은 절약되지 않는다. 그래도 반복 업로드가 없어지므로 실제 사용량은 줄어든다.
- 테스트:
  - relay: 조기 응답 뒤 남은 body를 모두 읽고 나서 desktop status가 클라이언트에 도착하는지, 버리는 동안 상한·deadline·disconnect 처리와 lease 회수, 첫 prefix deadline
  - desktop Direct: 조기 거부 뒤 버리기와 상한
  - Android: 쓰기 실패 재시도 상한
