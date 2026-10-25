# 0357. 훅 설정에서 에이전트 설치 검사와 훅 설치 상태를 분리한다

- Status: Proposed
- Date: 2026-10-25
- Source: [issue #1113](https://github.com/kochul2000/laymux/issues/1113), architecture/api-contracts.md의 선택적 에이전트 훅 계약, ADR-0282, ADR-0324

## Context

선택한 WSL에 CLI가 없어도 훅 helper의 실행 오류만 표시되어 에이전트 미설치와 조회 실패를 구분할 수 없다. 특히 docker-desktop은 일반 개발 배포판과 달리 동봉 helper 실행 자체가 실패할 수 있다. helper의 종료 코드나 설정 폴더 부재는 CLI 미설치 증거가 아니다. 앱 시작·작업 표시의 검사 수명을 늘리지 않고 사용자가 선택한 환경을 확인해야 한다.

## Decision

**Settings의 명시적 조회는 해당 환경의 CLI 실행 파일을 먼저 확인하고, 설치·미설치·확인 불가를 훅 상태와 분리한다.**

- 기존 `manage_agent_hooks`와 Automation hook 관리 경로에 읽기 전용 `agent-status` 연산을 추가한다. 응답은 `{status: installed|missing|unknown, detail?}`이며 훅 설치 캐시나 파일을 변경하지 않는다. 설정 폴더 존재와 설치 여부는 독립이다.
- native Windows는 프로세스 PATH와 표준 사용자 설치 위치의 실행 파일을 확인한다. Linux·WSL은 해당 환경의 로그인 `sh`에서 PATH와 표준 사용자 설치 위치를 검사한다. CLI 자체나 설치 명령은 실행하지 않는다. WSL 실행은 기존 headless launcher와 제한 시간을 적용한다.
- 정상 완료된 검사에서 실행 파일이 없을 때만 missing이다. 경로·권한·프로세스 실행·시간 초과·응답 형식 문제는 unknown이다. WSL/helper 종료 코드 1만으로 missing을 합성하지 않는다.
- Settings는 installed일 때 훅 상태를 조회한다. missing에는 에이전트 이름과 설치 후 재확인을, unknown에는 확인 불가와 진단을 표시한다. 두 경우 훅 추가·수정 동작을 제공하지 않는다. 환경 변경·다시 확인마다 재검사하며 오래된 환경의 응답은 반영하지 않는다.
- 자동 훅 검사·갱신 및 이미 승인된 훅 관리 동작의 계약은 유지한다. CLI 검사 결과는 작업 표시·세션 귀속의 증거가 아니다.
- 자율 화면 검증에는 dev 전용 `POST /api/v1/ui/agent-hooks/environment`를 제공한다. 열린 Settings의 활성 선택지에 change 이벤트를 보내 같은 UI 경로로 전환한다. 미마운트·busy·없는 선택지는 거부하고 Rust debug·frontend DEV 양쪽에서 release 사용을 차단한다. 훅 설치·설정 저장은 실행하지 않는다.

## Alternatives Considered

- helper 종료 코드 1을 미설치로 해석: WSL 실행·mount·권한 오류를 잘못 안내한다.
- 설정 폴더 존재로 판정: 미실행 CLI 및 제거 후 남은 설정에서 오판한다.
- CLI `--version` 실행: 설정 화면 진입으로 임의 프로그램을 실행하고 느린 초기화·버전 오류를 설치 여부와 혼동한다.
- 모든 background 훅 조회에 검사 추가: 기존 캐시 수명과 polling 비용을 바꾼다. 명시적 설정 조회에만 적용한다.

## Consequences

사용자는 에이전트 설치와 훅 설치 중 필요한 조치를 구분한다. 설정 화면 조회에 제한된 추가 비용이 생긴다. 임의 경로에 설치했지만 PATH·표준 위치에 없는 CLI는 발견하지 못하므로 선택한 환경의 경로에 노출해야 한다. profile별 alias·함수·임의 startup 명령 해석은 범위 밖이다. Windows·WSL·docker-desktop의 정상·미설치·실패와 환경 전환·재확인을 테스트한다. 향후 profile 기반 CLI 검사 기능이 병합되면 공통 검사 책임 통합을 재검토한다.
