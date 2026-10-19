# 0346. 출력 재연결은 데몬의 기존 작업을 보존한다

- Status: Proposed
- Date: 2026-10-19
- Source: 사용자 요구(출력이 멈춘 pane 복귀 시 자동 재연결, 실패 후 수동 재연결과 손실 경고가 있는 재시작) · [data-flow §8.8·§8.23](../architecture/data-flow.md) · ADR-0095·0126·0301·0307
- Amends: ADR-0095·0126의 close/recreate만 허용하는 desktop fail-stop 복구 범위. 기존 세대 안에서의 reset/replay 금지는 유지한다.

## Context

desktop 출력의 repair IPC가 timeout하면 해당 출력 세대는 fail-stop한다. PTY 데몬의 자식이 살아 있어도 기존 재시작 버튼은 작업을 종료한다. GUI 시작 시 재결합할 수 있는 같은 세션에 실행 중에도 다시 붙을 경로가 필요하다. 단순 무출력은 정상 idle일 수 있으므로 복구 조건으로 사용하지 않는다. 화면 모델의 정본화·중복 파싱 제거·상시 렌더링 최적화는 범위 밖이다.

## Decision

**실패한 desktop 출력은 기존 데몬 세션을 종료하지 않고 새 출력 세대로 재연결한다.**

- pane에 다시 포커스하거나 숨겨진 pane이 다시 보일 때 출력 fail-stop이면 자동 시도는 한 번만 한다. 정상 idle·일반 backpressure는 재연결하지 않는다. 활성 pane에서 실패가 뒤늦게 확정되어도 이번 복귀에 아직 시도하지 않았으면 한 번 시도한다.
- 동시에 하나의 재연결만 실행한다. 자동 시도가 실패하면 반복 타이머를 만들지 않고 상단 바에 수동 재연결을 제공한다. 진행 중에는 중복 조작을 막는다.
- 대상은 현재 GUI가 가진 정확한 daemon endpoint와 session id다. 기존 연결을 terminate 없이 분리한 뒤 fail-stop 출력 세대를 retire하고 새 세대를 만든다. 데몬의 원자적 `takeOver:false` attach로 붙으며 다른 client를 빼앗지 않는다. 재연결은 spawn·in-process fallback·agent resume를 하지 않는다.
- 실패한 attach의 정리도 세션을 종료하지 않는다. 수동 재시도에 필요한 기존 세션과 종료 소유권을 남긴다. 새 attach epoch는 이전 handle과 공유해 나중의 명시적 종료가 현재 세션을 정리할 수 있게 한다. 이전 세대의 completion·close는 새 출력 상태를 바꾸지 않는다.
- 현재 화면·터미널 모드는 기존 데몬 redraw 계약을 사용한다. 프로세스·대화는 유지하지만 기존 전체 scrollback의 완전 복원을 약속하지 않는다. GUI의 현재 표시·업무 문맥은 재연결 동안 보존한다.
- 상단 바의 재연결과 별도로 빨간색 터미널 재시작 버튼을 둔다. 재시작은 기존 작업과 터미널 내용이 보존되지 않음을 바로 보이는 문구로 알리고 기존 fresh-terminal 동작을 따른다. local PTY는 보존 재연결을 거절하고 같은 실패 UI를 사용한다.
- 이 IPC는 desktop 전용이다. 검증용 dev Automation API는 같은 출력 fail-stop과 재연결 경로를 조작할 수 있다. release 작업을 검증에 사용하지 않는다.

## Alternatives Considered

- timeout 확대: IPC 장애 뒤 작업을 살리는 경로가 생기지 않는다.
- 같은 출력 세대의 fail-stop 해제: reader가 멈춘 뒤 빠진 바이트와 이전 ACK를 안전하게 구분할 수 없다.
- 실패 시 새 셸 자동 생성: 살아 있는 작업을 잃거나 중복 실행하므로 기각한다.
- 데몬 화면을 실시간 정본으로 전환: xterm 호환성·scrollback·OSC·resize 계약의 범위가 훨씬 커 후속 이슈로 분리한다.

## Consequences

사용자는 기존 작업을 살려 출력만 복구할 수 있다. 재연결은 새 출력 세대와 기존 프로세스 수명을 구분하며, 실패·취소·명시적 종료 경합을 검증해야 한다. 데몬 redraw 모델의 화면 및 scrollback 한계는 그대로다. 실제 PTY 테스트에서 child PID·session id와 재연결 후 입력/출력을 확인하고, UI에서 자동 시도 횟수·수동 재시도·실패 바·파괴적 재시작을 검증한다. 설정 마이그레이션은 없으며 버전 영향은 호환되는 복구 기능 추가인 minor다.
