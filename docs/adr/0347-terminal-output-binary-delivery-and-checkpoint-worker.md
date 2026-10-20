# 0347. 보관된 출력 envelope를 바이너리로 읽고 checkpoint는 Worker에서 계산한다

- Status: Proposed
- Date: 2026-10-19
- Source: 사용자 요청(현재 상태와 세 가지 최적화의 누적 벤치 비교), issue #1233, architecture/data-flow.md §8.8·§8.23, ADR-0069·0095·0098
- Extends: ADR-0095의 desktop 전달 표현과 ADR-0069의 checkpoint 실행 위치. sequence·receipt·parsed ACK·geometry·복구·가중 admission 계약은 유지한다.

## Context

데몬 vt100은 재결합 화면을 유지하고 GUI는 원본 출력을 두 xterm에 적용한다. 가중 라운드 로빈은 처리 기회를 배분하지만 직렬화·복사와 UI 스레드의 추가 파싱을 제거하지 않는다. 고정 fixture에서 수신 할당 재사용, 숫자 배열 전달 제거, checkpoint 실행 위치 분리를 순서대로 비교한다. vt100을 live 정본으로 승격하거나 표시용 xterm을 교체하는 것은 범위 밖이다.

## Decision

데스크톱 v3 출력은 기존 단일 in-flight envelope를 작은 알림 뒤 바이너리 IPC로 읽고, checkpoint 계산은 pane별 Worker로 옮긴다.

- Rust delivery가 immutable envelope의 유일한 보관자다. 이벤트는 full identity·source 범위만 알린다. 내부 읽기는 같은 identity·범위가 아직 in-flight일 때만 envelope를 반환하며 receipt·parsed frontier·repair 횟수·deadline을 변경하지 않는다. stale 읽기는 빈 바이너리 응답이다.
- 바이너리 표현은 little-endian u32 metadata byte 길이, UTF-8 JSON metadata(data 제외), 원본 바이트 순이다. 기존 크기·delta·geometry 검증을 유지한다. Remote와 attach/repair의 JSON 계약은 바꾸지 않는다.
- frontend는 terminal당 읽기 하나와 최신 알림 힌트 하나만 보유한다. 알림 합치기는 원본 폐기가 아니다. 읽기 실패는 기존 watchdog의 exact repair로 복구하며, 잘못된 바이너리는 surface contract fault다. dispose 뒤 완료는 무시한다. Tauri Channel의 별도 payload 대기열·포트·네트워크 노출은 추가하지 않는다.
- Worker는 기존 checkpoint 모델(generation·source sequence·geometry·xterm 버퍼·serializer)을 소유한다. 화면용 xterm과 같은 6.0.0의 공식 headless 빌드에 동일한 retained-row reflow 패치와 Unicode provider를 적용한다. 공통 모델 core에 터미널 인스턴스를 주입해 브라우저 DOM 초기화를 반입하지 않는다. 메인 스레드는 FIFO와 기존 weighted admission을 소유한다. 승인된 quantum만 보내고 실제 parse 완료 응답 뒤 lease와 ACK를 진행한다. snapshot도 빈 prefix 설치 뒤 같은 admission으로 나누어 적용한다. capture는 이미 접수한 FIFO를 기다린 뒤 요청하지만, target에 도달하는 후속 write를 막지 않는다. 기존 3초 capture deadline은 admission 대기부터 응답까지 포함한다.
- ingress backing은 visible parser와 공유하므로 승인 slice만 복사·transfer한다. 원본 backing은 detach하지 않는다. snapshot 직렬화도 FIFO에서 수행해 바이트와 metadata가 같은 상태를 가리킨다. Worker 실패·timeout·dispose는 pending 작업을 거절하고 기존 surface 실패 경로로 수렴한다.
- Windows와 Linux에 같은 계약을 쓴다. Node 런타임이나 native VT 엔진 교체는 도입하지 않는다.

## Alternatives Considered

- JSON 숫자 배열 유지: 단순하지만 직렬화·배열 검증·재할당 비용이 남는다.
- raw Tauri Channel push: 별도 native payload 대기열과 exact repair를 함께 회계해야 하므로 기존 in-flight 읽기를 선택한다.
- vt100 redraw를 live 정본으로 승격: reflow·Unicode·SGR·버퍼 차이와 렌더러 교체를 요구한다.
- 원본 backing transfer 또는 admission 밖 무제한 Worker 파싱: visible 바이트 소유권과 공정성·상한을 깨뜨려 기각한다.

## Consequences

숫자 배열 전송을 없애고 checkpoint 파싱을 UI event loop에서 분리한다. IPC 왕복, Worker 생성·메시지와 slice 복사가 추가되므로 개선 여부는 동일 fixture의 단계별 벤치로 판정한다. commit·설정·geometry·관측 조건과 처리량·echo·오류·재연결을 함께 기록한다. 바이너리 무결성·stale identity·읽기 상한·Worker 수명·실제 xterm snapshot/resize를 검증한다. 응답성 또는 처리량이 악화하면 비용과 적용 범위를 재검토한다.

headless 6.0.0의 잘못된 `module` 경로는 Vite alias로 실제 ESM 파일에 고정한다([upstream #6052](https://github.com/xtermjs/xterm.js/issues/6052)). 공통 idle scheduler의 `window` 검사는 `globalThis`로 패치해 Worker에서 동작시킨다. 기존 postinstall의 정확한 원문 검사로 reflow와 이 패치를 함께 관리하며, Node의 `process`가 없는 실제 Worker 조건도 화면 테스트에 포함한다.
