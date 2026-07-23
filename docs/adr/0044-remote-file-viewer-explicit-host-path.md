# 0044. Remote FileViewer의 호스트 경로 반영은 명시적 action으로만 수행한다

- Status: Accepted
- Date: 2026-07-21
- Source: 사용자 요구(“버튼을 추가로 하나 둬서 호스트 뷰어 경로 당겨오게”), [api-contracts.md §13.3.1](../architecture/api-contracts.md), [ADR-0041](0041-remote-served-file-viewer.md), [ADR-0042](0042-remote-file-viewer-secret-capability.md)
- Supersedes: [ADR-0041](0041-remote-served-file-viewer.md)의 Decision 7

## Context

ADR-0041은 desktop/MCP가 FileViewer를 열었을 때 Remote heartbeat 성공 후 `/remote/v1/file-viewer/status`를 best-effort로 조회해 Remote drawer의 경로와 action을 자동 갱신하도록 정했다. 그러나 Remote drawer는 사용자가 직접 입력한 호스트 경로와 desktop FileViewer의 현재 경로를 같은 입력에 표시한다. 연결·heartbeat마다 비동기 status 응답이 도착하면 사용자의 입력과 호스트 상태 중 어느 쪽이 현재 값인지 구분하기 어렵고, 응답 시점에 따라 더 최신인 사용자 입력을 덮어쓸 수 있다.

입력이 pristine일 때만 자동 반영하는 규칙도 연결 세대, 요청 세대, 사용자 편집 시점을 함께 판정해야 한다. 이는 UI 상태를 복잡하게 만들면서도 사용자가 “언제 호스트 값을 가져왔는가”를 명확히 알 수 없게 한다.

이번 결정의 범위는 Remote drawer가 desktop FileViewer 경로를 가져오는 시점과, 입력 경로로 viewer를 여는 동작이다. 기존 lease-gated status/render API, 비밀 capability, bounded renderer, 새 탭 handshake는 유지한다. Remote에서 desktop FileViewer 상태를 변경하거나 외부 viewer 프로세스를 실행하는 것은 비목표다.

## Decision

**Remote FileViewer는 연결·heartbeat에서 desktop 경로를 자동 동기화하지 않으며, 사용자가 `From host`를 실행할 때만 현재 desktop FileViewer 경로를 입력으로 가져온다.**

1. ADR-0041의 Decision 1–6과 ADR-0042의 비밀 capability 계약은 그대로 유지한다. 이 ADR은 ADR-0041의 Decision 7만 대체한다.
2. Remote page는 연결 성공이나 heartbeat 성공 시 `/remote/v1/file-viewer/status`를 호출하지 않는다.
3. `From host` action만 status API를 호출한다. 요청을 시작할 때 입력 revision을 기록하고, 응답 전에 사용자가 입력을 바꿨다면 해당 응답으로 입력을 덮어쓰지 않는다.
4. 연결 세대가 바뀌거나 연결이 끊어지면 이전 status 요청의 완료는 새 연결의 pending 상태나 메시지를 변경하지 못한다. 요청 revision을 상태 소유권 판정에 사용한다.
5. `Open viewer`와 Enter는 action 시점에 trim한 입력 경로를 snapshot하고 `source="path"`로 child viewer에 전달한다. 이 동작은 desktop FileViewer store를 변경하거나 host viewer 프로세스를 실행하지 않는다.
6. render API의 `source="current"` 계약은 기존 client 호환성을 위해 유지한다. 기본 Remote page는 명시적 입력 경로를 사용한다.
7. desktop/MCP에서 FileViewer 경로가 바뀌어도 Remote page는 자동 popup이나 자동 경로 반영을 하지 않는다. 사용자가 `From host`로 경로를 가져온 뒤 `Open viewer`로 새 탭을 연다.

## Alternatives Considered

- **입력이 pristine일 때 heartbeat마다 자동 반영**: 직접 입력을 덮어쓰는 문제는 줄지만 pristine/dirty 복구 규칙과 비동기 응답 경쟁이 남고, 값의 출처도 명확하지 않아 기각한다.
- **`Open viewer`가 먼저 desktop FileViewer를 열고 그 상태를 다시 조회**: 단일 action처럼 보이지만 Remote의 읽기 전용 web viewer가 desktop store와 외부 프로세스 실행 권한까지 갖게 된다. ADR-0041의 process 경계를 깨므로 기각한다.
- **항상 `source="current"`만 사용**: 호스트 상태의 SoT는 단순해지지만 Remote 사용자가 임의 경로를 직접 열 수 없고, status 갱신 타이밍 문제도 남아 기각한다.
- **desktop 경로 변경을 push event로 전달**: polling보다 즉시성이 좋지만 입력 출처 충돌은 해결하지 못하며 새 외부 event 계약과 연결 복구 규칙이 필요하다. 명시적 pull로 충분하므로 기각한다.

## Consequences

- Remote drawer의 경로 출처가 사용자 action으로 명확해지고, heartbeat 타이밍이 입력을 바꾸지 않는다.
- desktop/MCP에서 FileViewer 경로가 바뀌어도 Remote에는 즉시 보이지 않는다. 사용자가 `From host`를 한 번 더 눌러야 한다.
- 느린 status 응답과 재연결이 있더라도 최신 사용자 입력 및 최신 연결 상태가 우선한다. 이를 revision 기반 회귀 테스트로 고정한다.
- `Open viewer`는 host 상태나 process를 변경하지 않으므로 Remote FileViewer의 읽기 전용 권한 경계를 유지한다.
- living doc과 Playwright 테스트는 명시적 pull, path snapshot, 입력 race, 모바일 overflow를 함께 설명·검증한다.
- 향후 자동 동기화를 다시 도입하려면 입력과 host candidate를 별도 UI 상태로 표시하거나 versioned push 계약을 설계한 뒤 새 ADR로 재검토한다.
