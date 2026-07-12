# 0027. Remote 연결 유예와 무표시 자동 복구

- Status: Accepted
- Date: 2026-07-12
- Source: 사용자 피드백(짧은 Remote 연결 단절이 제어권 상실과 수동 재접속으로 이어짐) · ADR-0013 · ADR-0015 · ADR-0024 · architecture/api-contracts.md §13

## Context

Remote controller lease의 기존 기본 heartbeat timeout은 15초이고 최소값은 5초였다. Cloud tunnel은 연결 실패 시 지수 backoff로 재접속하며, 브라우저 heartbeat 요청 하나도 lease timeout 전체 동안 pending 상태에 머물 수 있었다. 따라서 잠깐의 무선망 전환이나 relay 재접속만으로도 heartbeat를 다시 보낼 기회를 잃고 lease가 만료될 수 있었다.

출력 WebSocket은 lease와 별도로 재접속했지만, close/error를 즉시 표시하고 재접속 시도 시작과 동시에 remote xterm surface를 비웠다. 실제 복구가 수 초 안에 끝나도 사용자는 빈 터미널과 오류 문구를 보고 연결이 끊겼다고 인식했다.

Lease를 잃은 뒤 새 lease를 자동 claim하면, 단절 사이에 PC 사용자가 되찾은 제어권을 브라우저가 다시 가져갈 수 있다. 복구는 기존 lease가 유효한 범위 안에서만 이루어져야 한다.

## Decision

Remote 연결은 기존 controller lease 안에서 짧은 transport 단절을 흡수한다.

- `heartbeatTimeoutSeconds`의 새 기본값은 45초, 서버가 적용하는 최소값은 30초로 한다. PC의 명시적 reclaim은 이 유예와 관계없이 즉시 lease를 끝낸다.
- 브라우저 heartbeat 주기는 최대 5초로 제한하고, 실패 후에는 1초 뒤 빠르게 재시도하며, 개별 요청 deadline은 최대 4초로 제한한다. 한 요청이 전체 lease 유예를 독점하지 않고 유예 안에서 여러 차례 재시도할 수 있어야 한다.
- 인증·허용·lease 상실을 확정하는 `401`/`403`/`409`는 즉시 제어권 상실로 처리한다. 네트워크 오류와 output WebSocket close/error는 회복 가능한 transport 오류로 취급하며 기존 lease를 반납하지 않는다.
- 회복 가능한 오류 표시는 2초 지연한다. 그 안에 복구되면 연결 상태 문구와 terminal surface를 바꾸지 않는다.
- Output 재접속 동안 기존 xterm surface를 유지한다. 재접속한 stream의 첫 snapshot payload를 적용하기 직전에만 surface를 reset해 중복 tail을 막는다.
- 서버가 기존 lease의 상실을 확정한 뒤 브라우저가 새 lease를 자동 claim하지 않는다. 사용자가 다시 연결하거나 PC가 명시적으로 제어권을 넘겨야 한다.

## Consequences

짧은 Wi-Fi 전환, 모바일 radio 절전, relay/tunnel 재접속은 대부분 기존 화면과 제어권을 유지한 채 복구된다. 기존 설정에 5~29초가 저장되어 있어도 런타임에서는 30초 유예가 적용되고, 새 설정의 기본값은 45초다.

브라우저가 실제로 사라진 경우 PC의 자동 제어권 복귀는 이전보다 늦어질 수 있다. PC 사용자는 기존 reclaim UI로 즉시 회수할 수 있으므로 명시적 복구 경로는 지연되지 않는다.

전송 결과가 모호한 terminal write를 자동 재전송하지는 않는다. 중복 명령 입력 위험 없이 자동 재전송하려면 별도의 요청 식별자와 exactly-once 계약이 필요하며 이 결정의 범위가 아니다.
