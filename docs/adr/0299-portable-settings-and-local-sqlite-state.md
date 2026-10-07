# 0299. 이식 가능한 설정과 로컬 SQLite 복원 상태를 분리한다

- Status: Proposed
- Date: 2026-10-07
- Source: 사용자 SQLite 구현 요청, [이슈 #1141](https://github.com/kochul2000/laymux/issues/1141), [이슈 #1139](https://github.com/kochul2000/laymux/issues/1139), ADR-0202/0222/0295/0296, architecture/data-flow.md §13.5
- 관계: settings.json을 사용자 설정과 복원 상태의 공동 SoT로 사용한 기존 결정을 대체한다. 귀속 증거·입력 fence·저장 후 인터럽트는 유지한다.

## Context

현재 checkpoint는 창 배치·대화 ID·CWD와 사용자 설정을 한 Settings 스냅샷으로 다시 쓴다. 다른 PC에 설정을 복사하면 이전 PC의 실행 환경과 대화 복원점도 따라가며, 설정 파일 쓰기 성공과 대화 확인 완료가 혼동된다. 사용자 요구는 이식 가능한 설정, PC 환경, 로컬 복원 상태의 영속 책임을 분리하는 것이다. JSON 직접 편집과 기존 설정 API의 유효 설정 모델은 유지해야 한다.

## Decision

**settings.json은 이식 가능한 구성만 저장하고, Rust 소유 SQLite state.db는 PC 환경과 실행·복원 상태를 저장한다.**

- Settings는 API와 프론트에서 사용하는 합성된 유효 설정 모델이다. 디스크 JSON에는 실제 workspace/dock 인스턴스·대화 ID·CWD·로컬 실행 경로·배포판·호스트 연결 정보를 쓰지 않는다. 재사용 레이아웃은 실행 상태를 제거한 템플릿으로 저장한다.
- PC별 프로필 실행 설정, 에이전트 실행 명령·사용량 저장소·외부 viewer와 Remote 호스트 설정은 SQLite의 machine 설정 영역이 소유한다. 프로필 환경은 배열 위치 대신 프로필 이름에 연결한다. 붙여넣기 이미지 디렉터리와 이슈 등록용 셸도 로컬 환경이다. 환경 연결이 없는 논리 프로필은 현재 OS 기본 셸로 시작하며 외부 PC의 경로를 추정하지 않는다.
- 템플릿의 configDir 등 로컬 view 설정은 layout ID·pane/레이어 위치·portable pane 내용의 fingerprint에 결합한다. 다른 종류/구성의 슬롯에 과거 환경을 적용하지 않는다. 템플릿의 대화 ID·Fresh marker는 환경으로도 저장하지 않는다. lastCwd는 같은 PC의 템플릿 실행 위치로 로컬 환경에 보존한다.
- 복원 구조는 workspace/dock 그룹과 pane 행으로 저장하며 확장 가능한 view metadata는 pane 슬롯 범위 JSON으로 저장한다. ADR-0297의 ordered layers·activeLayerId와 숨은 레이어의 복원점도 보존하고, terminal 귀속은 슬롯 ID 대신 content ID에 결합한다. 전체 Settings JSON을 DB 한 행에 보관하지 않는다. pane별 귀속 confidence와 미확인 상태, 단조로운 DB commit revision을 함께 저장한다.
- 사용자 구성 저장과 checkpoint 저장은 별도 IPC다. checkpoint는 사용자 구성을 다시 쓰지 않는다. 구성 저장은 현재 로컬 복원 구조를 덮어쓰지 않는다. 실제 설정 변경/레이아웃 템플릿 변경만 구성 저장을 요청한다. 유효 설정 읽기는 두 계층을 합성하고 설정 export는 portable projection을 사용한다.
- SQLite 연결과 트랜잭션은 Rust 저장 계층만 소유한다. WAL과 synchronous=FULL, 250ms busy timeout을 적용한다. SQLite가 commit마다 WAL을 동기화하는 정책을 선택하지만 저장장치/파일시스템의 fsync 보장 밖 전원 차단 내구성까지 약속하지 않는다([SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)). 파일/프로세스/WSL 귀속 조회는 트랜잭션 전에 완료하며 DB 작업은 ordered AppState 락과 함께 수행하지 않는다. SQLite 오류를 빈 상태로 합성하거나 손상 DB를 자동 삭제하지 않는다.
- 정상 pane의 commit은 미확인 pane과 독립적으로 진행한다. Unknown은 DB의 이전 검증 복원점을 보존하며 commit 결과는 미확인 terminal 목록을 반환한다. frontend ACK는 파일/DB 쓰기 성공과 확인 완료를 구분하고 native hint worker는 미확인 결과에 제한된 지수 backoff 재시도를 수행한다. 정상 저장을 전부 실패시키지 않는다.
- 저장 완료 receipt는 DB revision·현재 runtime snapshot·사용자 구성 파일의 변화와 rollout 파일 검증에 묶는다. 변경 없는 최종 종료는 기존 빠른 재사용을 유지한다. 재시도/설정 변화/새 DB commit은 이전 receipt를 무효화한다.
- state.db는 Windows LOCALAPPDATA, Linux XDG_STATE_HOME(없으면 ~/.local/state)에 build별로 저장한다. settings import/export에는 포함하지 않는다. 설정 초기화는 로컬 복원 구조를 지우지 않는다. 기존 출력·메모 캐시는 독립 파일로 유지하며 Composer 초안/history의 비영속 및 비밀 저장소 계약을 확대하지 않는다.
- 기존 혼합 JSON의 로컬 필드는 새 환경으로 자동 이관하지 않는다. 내부 개발 정책에 따라 수동 보존/처리 절차를 제공한다. schema version 불일치는 명시적인 오류다.

## Alternatives Considered

- 모든 상태를 JSON에 유지: 이식성과 실행 상태가 계속 결합되고 checkpoint가 구성을 다시 쓴다.
- 별도 session.json: 설정과 상태의 책임은 나눌 수 있지만 pane별 confidence·동시 commit·복원점 revision을 직접 구현해야 한다.
- 전체 Settings를 SQLite BLOB 하나에 저장: 저장 위치만 바꾸며 책임 경계와 부분 갱신을 해결하지 못한다.
- 별도 PTY daemon: PC 재부팅 후 영속 복원과 설정 이식 문제를 해결하지 않는다.

## Consequences

사용자 설정만 복사할 수 있고 대화 조회 실패가 구성 저장 성공과 혼동되지 않는다. 대신 합성 읽기, machine 설정의 프로필 identity, DB 오류와 초기화, portable export, 두 저장 경계의 실패 복구와 receipt revision을 검증해야 한다. DB와 JSON을 아우르는 원자적 사용자 구성 변경은 약속하지 않는다. 저장 결과의 계층별 실패를 전파하며 재시도 가능한 최신 구성/환경을 유지한다. 재기동·부분 조회 회복·삭제·잠금·손상·캐시 유실과 서로 다른 PC fixture를 TDD와 격리 dev로 확인한다. 새로운 host 종속 설정이 생기면 portable projection 경계를 함께 갱신한다.
